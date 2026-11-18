/**
 * RGBA 高质量缩放（预乘 alpha + 分离两遍 Lanczos3）+ 蒙版合成（纯函数，Node 可单测）。
 * 生成结果（reqW×reqH）贴回前需缩回扩展区域尺寸（W'×H'）：
 * - 放大请求（小选区）→ 缩小贴回；
 * - 缩小请求（超上限大选区）→ 放大贴回。
 *
 * 与 Pillow Image.LANCZOS 逐位一致的完整管线（消除透明边缘 halo 与大缩比混叠）：
 * 1. 预乘：RGBA→RGBa，RGB 乘 alpha/255（Convert.c rgbA2rgba 的 MULDIV255 公式）；
 * 2. 分离两遍 Lanczos3 缩放：窗口/归一化公式与 Resample.c precompute_coeffs 同源，
 *    并复刻 8bpc 定点路径（权重 round(w×2^22)，累加从 2^21 起，clip8 = 算术右移后钳制），
 *    两遍之间按字节量化（与 Pillow 中间图像一致）；
 * 3. 反预乘：RGBa→RGBA，RGB 乘 255/alpha 整除（rgba2rgbA：alpha 0/255 直通）。
 * 预乘缩放保证半透明像素缩放时 RGB 不再与 alpha 独立混色，透明边缘不会发暗/发亮。
 * 本实现恒为「水平 → 垂直」两遍；Pillow 仅在纵向缩幅 > 2× 横向缩幅时为提速先跑
 * 垂直遍，该场景两者仅差中间量化的 ±1 舍入。
 * 两遍之间的行缓存用滑动窗口（只保留当前纵向核窗口内的已滤波行），
 * 超大选区（5000² 级）内存仍为常量级；蒙版合成在缩放后（RGB 已反预乘）。
 */

/** Lanczos-3 核：sinc(x)·sinc(x/3)，|x| ≥ 3 截断为 0。 */
const lanczos3 = (x: number): number => {
  if (x === 0) return 1;
  const ax = x < 0 ? -x : x;
  if (ax >= 3) return 0;
  const px = Math.PI * ax;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};

/** Resample.c 8bpc 定点精度：权重放大 2^22，累加偏置 2^21（round-to-nearest）。 */
const PRECISION_BITS = 22;
const PRECISION_HALF = 1 << (PRECISION_BITS - 1);

/** 单输出下标的卷积窗口：源下标起点 + 定点权重。 */
interface Kernel {
  start: number;
  weights: Int32Array;
}

/**
 * Pillow Resample.c precompute_coeffs 同源公式（in0 = 0、in1 = inSize）：
 * center = (i + 0.5)·scale；窗口 = [trunc(center - support + 0.5), trunc(center + support + 0.5))
 * 截断到源边界后按权重和归一化，再按 normalize_coeffs_8bpc 定点量化。
 */
const buildKernels = (inSize: number, outSize: number): Kernel[] => {
  const scale = inSize / outSize;
  const filterscale = scale < 1 ? 1 : scale;
  const support = 3 * filterscale;
  const inv = 1 / filterscale;
  const kernels: Kernel[] = new Array(outSize);
  for (let i = 0; i < outSize; i++) {
    const center = (i + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    const count = xmax - xmin;
    const float = new Float64Array(count);
    let sum = 0;
    for (let x = 0; x < count; x++) {
      const w = lanczos3((x + xmin - center + 0.5) * inv);
      float[x] = w;
      sum += w;
    }
    // normalize_coeffs_8bpc：先浮点归一化，再定点量化（负值向下取整半值，同 C (int) 截断）
    const weights = new Int32Array(count);
    for (let x = 0; x < count; x++) {
      const v = sum !== 0 ? (float[x] / sum) * (1 << PRECISION_BITS) : 0;
      weights[x] = v >= 0 ? Math.trunc(v + 0.5) : Math.trunc(v - 0.5);
    }
    kernels[i] = { start: xmin, weights };
  }
  return kernels;
};

/** Resample.c clip8：定点和算术右移后钳制（累加值恒在 int32 范围内）。 */
const clip8 = (ss: number): number => {
  const v = ss >> PRECISION_BITS;
  return v < 0 ? 0 : v > 255 ? 255 : v;
};

/** Convert.c MULDIV255：≈ round(a×b/255) 的快速整数近似（预乘用）。 */
const mulDiv255 = (a: number, b: number): number => {
  const t = a * b + 128;
  return ((t >> 8) + t) >> 8;
};

/** RGBA8 高质量缩放（预乘 + 分离两遍 Lanczos3，与 Pillow LANCZOS 一致）。 */
export const resizeRgba = (
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array => {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) {
    throw new Error("缩放：尺寸非法");
  }
  if (src.length !== sw * sh * 4) {
    throw new Error("缩放：源数据长度与尺寸不符");
  }
  const out = new Uint8Array(dw * dh * 4);
  if (sw === dw && sh === dh) {
    out.set(src);
    return out;
  }

  // 1. 预乘 alpha：RGBa = RGB × alpha / 255（alpha 255 时 MULDIV255 恒等，可跳过）
  const prem = new Uint8Array(src);
  for (let p = 0; p < prem.length; p += 4) {
    const a = prem[p + 3];
    if (a !== 255) {
      prem[p] = mulDiv255(prem[p], a);
      prem[p + 1] = mulDiv255(prem[p + 1], a);
      prem[p + 2] = mulDiv255(prem[p + 2], a);
    }
  }

  const sameW = sw === dw;
  const kx = sameW ? null : buildKernels(sw, dw);
  const ky = buildKernels(sh, dh);

  // 滑动窗口行缓存：只保留纵向核窗口内已滤波的源行（字节精度，同 Pillow 中间图像）
  const rowCache = new Map<number, Uint8Array>();
  let nextRow = 0;
  const filterRow = (sy: number): Uint8Array => {
    const r = new Uint8Array(dw * 4);
    if (sameW) {
      r.set(prem.subarray(sy * sw * 4, (sy + 1) * sw * 4));
      return r;
    }
    const base = sy * sw * 4;
    for (let x = 0; x < dw; x++) {
      const k = kx![x];
      const w = k.weights;
      let s0 = PRECISION_HALF;
      let s1 = PRECISION_HALF;
      let s2 = PRECISION_HALF;
      let s3 = PRECISION_HALF;
      let p = base + k.start * 4;
      for (let j = 0; j < w.length; j++) {
        const kj = w[j];
        s0 += prem[p] * kj;
        s1 += prem[p + 1] * kj;
        s2 += prem[p + 2] * kj;
        s3 += prem[p + 3] * kj;
        p += 4;
      }
      r[x * 4] = clip8(s0);
      r[x * 4 + 1] = clip8(s1);
      r[x * 4 + 2] = clip8(s2);
      r[x * 4 + 3] = clip8(s3);
    }
    return r;
  };

  // 2. 垂直遍（水平遍在 filterRow 内完成）
  for (let y = 0; y < dh; y++) {
    const k = ky[y];
    const end = k.start + k.weights.length;
    for (let r = nextRow; r < end; r++) {
      rowCache.set(r, filterRow(r));
      nextRow = r + 1;
    }
    for (const key of rowCache.keys()) {
      if (key < k.start) rowCache.delete(key);
    }
    // 窗口行引用提前收集（避免内层循环反复查 Map）
    const rows: Uint8Array[] = [];
    for (let j = 0; j < k.weights.length; j++) {
      rows.push(rowCache.get(k.start + j)!);
    }
    const w = k.weights;
    const outRow = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      const p = x * 4;
      let s0 = PRECISION_HALF;
      let s1 = PRECISION_HALF;
      let s2 = PRECISION_HALF;
      let s3 = PRECISION_HALF;
      for (let j = 0; j < w.length; j++) {
        const row = rows[j];
        const kj = w[j];
        s0 += row[p] * kj;
        s1 += row[p + 1] * kj;
        s2 += row[p + 2] * kj;
        s3 += row[p + 3] * kj;
      }
      out[outRow + p] = clip8(s0);
      out[outRow + p + 1] = clip8(s1);
      out[outRow + p + 2] = clip8(s2);
      out[outRow + p + 3] = clip8(s3);
    }
  }

  // 3. 反预乘：RGBa→RGBA（Convert.c rgba2rgbA：alpha 0/255 直通，其余整除 255/a 后钳制）
  for (let p = 0; p < out.length; p += 4) {
    const a = out[p + 3];
    if (a !== 0 && a !== 255) {
      out[p] = Math.min(255, Math.floor((255 * out[p]) / a));
      out[p + 1] = Math.min(255, Math.floor((255 * out[p + 1]) / a));
      out[p + 2] = Math.min(255, Math.floor((255 * out[p + 2]) / a));
    }
  }

  return out;
};

/**
 * 单通道灰度图（0-255）Lanczos3 缩放：与 resizeRgba 共用同一套核与定点路径，
 * 只是一个通道、无预乘/反预乘。用于把蒙版缩放到送图尺寸。
 */
export const resizeGray = (
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array => {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) {
    throw new Error("缩放：尺寸非法");
  }
  if (src.length !== sw * sh) {
    throw new Error("缩放：源数据长度与尺寸不符");
  }
  const out = new Uint8Array(dw * dh);
  if (sw === dw && sh === dh) {
    out.set(src);
    return out;
  }

  const sameW = sw === dw;
  const kx = sameW ? null : buildKernels(sw, dw);
  const ky = buildKernels(sh, dh);

  // 滑动窗口行缓存：只保留当前纵向核窗口内已滤波的源行
  const rowCache = new Map<number, Uint8Array>();
  let nextRow = 0;
  const filterRow = (sy: number): Uint8Array => {
    const r = new Uint8Array(dw);
    if (sameW) {
      r.set(src.subarray(sy * sw, (sy + 1) * sw));
      return r;
    }
    const base = sy * sw;
    for (let x = 0; x < dw; x++) {
      const k = kx![x];
      const w = k.weights;
      let s0 = PRECISION_HALF;
      let p = base + k.start;
      for (let j = 0; j < w.length; j++) {
        s0 += src[p] * w[j];
        p += 1;
      }
      r[x] = clip8(s0);
    }
    return r;
  };

  for (let y = 0; y < dh; y++) {
    const k = ky[y];
    const end = k.start + k.weights.length;
    for (let r = nextRow; r < end; r++) {
      rowCache.set(r, filterRow(r));
      nextRow = r + 1;
    }
    for (const key of rowCache.keys()) {
      if (key < k.start) rowCache.delete(key);
    }
    const rows: Uint8Array[] = [];
    for (let j = 0; j < k.weights.length; j++) {
      rows.push(rowCache.get(k.start + j)!);
    }
    const w = k.weights;
    const outRow = y * dw;
    for (let x = 0; x < dw; x++) {
      let s0 = PRECISION_HALF;
      for (let j = 0; j < w.length; j++) {
        s0 += rows[j][x] * w[j];
      }
      out[outRow + x] = clip8(s0);
    }
  }

  return out;
};

/**
 * 把灰度蒙版（0-255）乘进 RGBA 的 alpha 通道。
 * mask 255 = 完全保留生成像素；0 = 完全透明（露出下方原像素）。
 * mask 长度必须等于像素数（宽×高）。
 */
export const applyMaskAlpha = (
  rgba: Uint8Array,
  mask: Uint8Array,
): Uint8Array => {
  if (mask.length !== rgba.length / 4) {
    throw new Error("蒙版合成：蒙版尺寸与图像不符");
  }
  const out = new Uint8Array(rgba);
  for (let p = 0, m = 0; p < out.length; p += 4, m++) {
    out[p + 3] = Math.round((out[p + 3] * mask[m]) / 255);
  }
  return out;
};
