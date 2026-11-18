/**
 * 零依赖基线 JPEG 解码器（8-bit → RGBA8）。
 * 用于解码 Ark Seedream 生成结果（4.0/4.5 固定输出 JPEG；5.0-lite 可选 png）。
 * 范围：SOF0/1（8-bit 基线）、1/3 分量（灰度 / YCbCr）、8-bit DQT、DRI+RSTn 重启、
 * 任意采样因子 h,v∈1-4（通用 MCU 网格）。上采样与 libjpeg fancy upsampling 一致
 * （2x 轴用 (3,1) 三角滤波并复刻其舍入，其余倍率双线性近似）。
 * 不支持：渐进式（SOF2，明确报错）、算术编码、12/16-bit、CMYK。
 */

export interface DecodedJpeg {
  width: number;
  height: number;
  /** RGBA8 交错像素。 */
  rgba: Uint8Array;
}

// ---- ZigZag 顺序（频域下标 → 自然顺序下标） ----
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]);

// ---- 8x8 IDCT 余弦矩阵（预计算；COS[u*8+x] = a(u)/2·cos((2x+1)uπ/16)） ----
const COS = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  const au = u === 0 ? Math.SQRT1_2 : 1;
  for (let x = 0; x < 8; x++) {
    COS[u * 8 + x] = (au / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

interface HuffTable {
  /** [1..16] 各长度最小码字 / 最大码字（该长度无码为 -1）/ 首值下标。 */
  mincode: Int32Array;
  maxcode: Int32Array;
  valptr: Int32Array;
  values: Uint8Array;
}

const buildHuffTable = (counts: Uint8Array, values: Uint8Array): HuffTable => {
  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const cnt = counts[len - 1];
    mincode[len] = code;
    maxcode[len] = cnt > 0 ? code + cnt - 1 : -1;
    valptr[len] = k;
    k += cnt;
    code = (code + cnt) << 1;
  }
  return { mincode, maxcode, valptr, values };
};

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number; // 量化表
  td: number; // DC Huffman 表
  ta: number; // AC Huffman 表
  /** 实际（非块填充）分辨率：ceil(W·h/hmax) × ceil(H·v/vmax)。 */
  compWidth: number;
  compHeight: number;
  /** 平面块网格（解码写入范围）。 */
  planeBlocksW: number;
  planeBlocksH: number;
  /** 8-bit 分量平面（宽 = planeBlocksW·8，含块填充）。 */
  plane: Uint8Array;
  /** DC 预测器（RST 重置）。 */
  pred: number;
}

/** 解码全程上下文（位读 + 表 + 帧信息）。 */
interface Ctx {
  bytes: Uint8Array;
  pos: number;
  bitBuf: number;
  bitCnt: number;
  eob: boolean; // 扫描数据结束（遇标记/流尾）
  comps: Component[]; // 本扫描分量（SOS 顺序）
  dcTables: (HuffTable | null)[];
  acTables: (HuffTable | null)[];
  quantTables: Float64Array[]; // 自然顺序
}

const readDataByte = (ctx: Ctx): number => {
  if (ctx.pos >= ctx.bytes.length) {
    ctx.eob = true;
    return -1;
  }
  const b = ctx.bytes[ctx.pos++];
  if (b !== 0xff) return b;
  // 0xFF 后跟填充或标记
  let nb = ctx.pos < ctx.bytes.length ? ctx.bytes[ctx.pos++] : -1;
  while (nb === 0xff && ctx.pos < ctx.bytes.length) nb = ctx.bytes[ctx.pos++];
  if (nb === 0x00) return 0xff; // 去填充：数据字节 0xFF
  if (nb >= 0xd0 && nb <= 0xd7) {
    // RST 在未对齐处出现：按规范重置预测器后继续
    for (const c of ctx.comps) c.pred = 0;
    return readDataByte(ctx);
  }
  ctx.eob = true; // 其他标记（EOI 等）：扫描数据结束
  return -1;
};

const readBit = (ctx: Ctx): number => {
  if (ctx.bitCnt === 0) {
    const b = readDataByte(ctx);
    if (b < 0) return 1; // 结束后按规范填 1（Huffman 会自然收敛到 EOB）
    ctx.bitBuf = b;
    ctx.bitCnt = 8;
  }
  ctx.bitCnt--;
  return (ctx.bitBuf >> ctx.bitCnt) & 1;
};

const receive = (ctx: Ctx, n: number): number => {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | readBit(ctx);
  return v;
};

/** JPEG 负数扩展：s 位原码 → 有符号差值。 */
const extend = (v: number, s: number): number =>
  v < 1 << (s - 1) ? v - (1 << s) + 1 : v;

const decodeHuff = (ctx: Ctx, t: HuffTable): number => {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | readBit(ctx);
    if (code <= t.maxcode[len]) {
      return t.values[t.valptr[len] + code - t.mincode[len]];
    }
  }
  throw new Error("JPEG 解码：Huffman 码字非法");
};

// 块解码临时缓冲（模块级复用，解码为单线程串行）
const coefScratch = new Float64Array(64);
const tmpScratch = new Float64Array(64);

/** 解码一个 8x8 块 → 反量化 → IDCT → 写入分量平面 (bx,by)（块坐标）。 */
const decodeBlock = (
  ctx: Ctx,
  c: Component,
  bx: number,
  by: number,
): void => {
  const dcTable = ctx.dcTables[c.td];
  const acTable = ctx.acTables[c.ta];
  if (!dcTable || !acTable) {
    throw new Error(`JPEG 解码：分量 ${c.id} 缺 Huffman 表`);
  }
  const qt = ctx.quantTables[c.tq];
  if (!qt) throw new Error(`JPEG 解码：分量 ${c.id} 缺量化表 ${c.tq}`);

  const dc = decodeHuff(ctx, dcTable);
  if (dc > 11) throw new Error("JPEG 解码：DC 差值位数非法");
  const diff = dc === 0 ? 0 : extend(receive(ctx, dc), dc);
  c.pred += diff; // 预测器直接累加（编码器保证 8-bit 精度下不超 11 位）

  const coef = coefScratch;
  coef.fill(0);
  coef[0] = c.pred * qt[0];

  for (let k = 1; k < 64; ) {
    const rs = decodeHuff(ctx, acTable);
    const run = rs >> 4;
    const size = rs & 15;
    if (size === 0) {
      if (run === 15) {
        k += 16; // ZRL：跳过 16 个 0
        if (k > 63) throw new Error("JPEG 解码：AC 系数下标越界");
        continue;
      }
      break; // EOB
    }
    k += run;
    if (k > 63) throw new Error("JPEG 解码：AC 系数下标越界");
    const val = extend(receive(ctx, size), size);
    coef[ZIGZAG[k]] = val * qt[ZIGZAG[k]];
    k++;
  }

  // ---- 分离 IDCT（两遍：先列后行等价，此处按 行→列）----
  const tmp = tmpScratch;
  // tmp[v*8+x] = Σ_u coef[v*8+u]·COS[u*8+x]
  for (let v = 0; v < 8; v++) {
    const row = v * 8;
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += coef[row + u] * COS[u * 8 + x];
      tmp[row + x] = s;
    }
  }
  // 像素(x,y) = Σ_v tmp[v*8+x]·COS[v*8+y]，加 128（直流电平已在预计算中除以 2·2）
  const stride = c.planeBlocksW * 8;
  const base = by * 8 * stride + bx * 8; // 块坐标 → 像素偏移
  const plane = c.plane;
  for (let y = 0; y < 8; y++) {
    const rowStart = base + y * stride;
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += tmp[v * 8 + x] * COS[v * 8 + y];
      const val = Math.round(s + 128);
      plane[rowStart + x] = val < 0 ? 0 : val > 255 ? 255 : val;
    }
  }
};

const alignToByte = (ctx: Ctx): void => {
  ctx.bitCnt = 0;
};

/** 对齐后消费 RSTn 标记（返回 false 表示遇到终止标记/流尾）。 */
const expectRestart = (ctx: Ctx, seq: number): boolean => {
  alignToByte(ctx);
  if (ctx.pos + 2 > ctx.bytes.length) {
    ctx.eob = true;
    return false;
  }
  const m1 = ctx.bytes[ctx.pos++];
  const m2 = ctx.bytes[ctx.pos++];
  if (m1 === 0xff && m2 === 0xd0 + (seq & 7)) return true;
  if (m1 === 0xff && (m2 === 0xd9 || isSof(m2) || m2 === 0xda)) {
    ctx.eob = true; // 扫描被终止标记截断
    return false;
  }
  throw new Error("JPEG 解码：重启标记不符");
};

/** 解码一个扫描（SOS 段之后，ctx.pos 指向熵编码数据起点）。 */
const decodeScan = (
  ctx: Ctx,
  frameComps: Component[],
  restartInterval: number,
  width: number,
  height: number,
): void => {
  const ns = ctx.bytes[ctx.pos++];
  if (ns < 1 || ns > 4) throw new Error(`JPEG 解码：扫描分量数非法 ${ns}`);
  ctx.comps = [];
  for (let i = 0; i < ns; i++) {
    const cs = ctx.bytes[ctx.pos++];
    const tdta = ctx.bytes[ctx.pos++];
    const comp = frameComps.find((c) => c.id === cs);
    if (!comp) throw new Error(`JPEG 解码：SOS 引用未知分量 id ${cs}`);
    comp.td = tdta >> 4;
    comp.ta = tdta & 15;
    ctx.comps.push(comp);
  }
  ctx.pos += 3; // 基线固定 Ss=0, Se=63, AhAl=0

  const hmax = Math.max(...frameComps.map((c) => c.h));
  const vmax = Math.max(...frameComps.map((c) => c.v));
  const interleaved = ns > 1;

  let mcusX: number;
  let mcusY: number;
  if (interleaved) {
    mcusX = Math.ceil(width / (8 * hmax));
    mcusY = Math.ceil(height / (8 * vmax));
    for (const c of frameComps) {
      c.planeBlocksW = mcusX * c.h;
      c.planeBlocksH = mcusY * c.v;
    }
  } else {
    // 非交错（通常灰度单分量）：MCU = 1 个数据单元，网格按分量实际尺寸
    const c = ctx.comps[0];
    mcusX = Math.ceil(c.compWidth / 8);
    mcusY = Math.ceil(c.compHeight / 8);
    c.planeBlocksW = mcusX;
    c.planeBlocksH = mcusY;
  }
  for (const c of frameComps) {
    c.plane = new Uint8Array(c.planeBlocksW * 8 * c.planeBlocksH * 8);
  }

  const totalMcus = mcusX * mcusY;
  let rstSeq = 0;
  for (let mcu = 0; mcu < totalMcus; mcu++) {
    if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
      if (!expectRestart(ctx, rstSeq++)) break;
      for (const c of ctx.comps) c.pred = 0;
    }
    const mcuX = mcu % mcusX;
    const mcuY = Math.floor(mcu / mcusX);
    for (const c of ctx.comps) {
      const blocks = interleaved ? c.h * c.v : 1;
      for (let b = 0; b < blocks; b++) {
        let bx: number;
        let by: number;
        if (interleaved) {
          bx = mcuX * c.h + (b % c.h);
          by = mcuY * c.v + Math.floor(b / c.h);
        } else {
          bx = mcu % c.planeBlocksW;
          by = Math.floor(mcu / c.planeBlocksW);
        }
        decodeBlock(ctx, c, bx, by);
        if (ctx.eob) break;
      }
      if (ctx.eob) break;
    }
    if (ctx.eob) break;
  }
};

const isSof = (m: number): boolean =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

const readU16At = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] << 8) | bytes[offset + 1];

/** JPEG 标记段解析主循环 → RGBA8。 */
export const decodeJpeg = (bytes: Uint8Array): DecodedJpeg => {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  ) {
    throw new Error("JPEG 解码：不是 JPEG 文件（缺少 SOI）");
  }

  let width = 0;
  let height = 0;
  let restartInterval = 0;
  let components: Component[] = [];
  let sawSos = false;
  // 表在 SOS 前解析，扫描时共享（一个段可含多张表）
  const quantTables: Float64Array[] = new Array(4);
  const dcTables: (HuffTable | null)[] = new Array(4).fill(null);
  const acTables: (HuffTable | null)[] = new Array(4).fill(null);

  let pos = 2;

  while (pos + 2 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = bytes[pos + 1];
    if (marker === 0xff) {
      pos++;
      continue; // 连续填充
    }
    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // TEM/RSTn 独立标记
      continue;
    }

    const length = readU16At(bytes, pos + 2);
    if (length < 2) throw new Error(`JPEG 解码：段长度非法（0x${marker.toString(16)}）`);
    const dataStart = pos + 4;
    const dataEnd = pos + 2 + length;

    if (isSof(marker)) {
      if (marker === 0xc2) throw new Error("JPEG 解码：暂不支持渐进式 JPEG");
      if (marker !== 0xc0 && marker !== 0xc1) {
        throw new Error(`JPEG 解码：不支持的帧类型 0x${marker.toString(16)}`);
      }
      const precision = bytes[dataStart];
      if (precision !== 8) throw new Error(`JPEG 解码：不支持的位深 ${precision}`);
      height = (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
      width = (bytes[dataStart + 3] << 8) | bytes[dataStart + 4];
      const nf = bytes[dataStart + 5];
      if (nf !== 1 && nf !== 3) {
        throw new Error(`JPEG 解码：不支持的分量数 ${nf}`);
      }
      if (width <= 0 || height <= 0) throw new Error("JPEG 解码：尺寸非法");
      if (width * height > 1 << 28) throw new Error("JPEG 解码：图像过大");
      components = [];
      let p = dataStart + 6;
      for (let i = 0; i < nf; i++) {
        const id = bytes[p];
        const hv = bytes[p + 1];
        const h = hv >> 4;
        const v = hv & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4) {
          throw new Error(`JPEG 解码：采样因子非法 ${h}×${v}`);
        }
        components.push({
          id,
          h,
          v,
          tq: bytes[p + 2],
          td: 0,
          ta: 0,
          compWidth: 0,
          compHeight: 0,
          planeBlocksW: 0,
          planeBlocksH: 0,
          plane: new Uint8Array(0),
          pred: 0,
        });
        p += 3;
      }
      // 分量实际分辨率（非交错扫描也依赖此值）
      const hmax = Math.max(...components.map((c) => c.h));
      const vmax = Math.max(...components.map((c) => c.v));
      for (const c of components) {
        c.compWidth = Math.ceil((width * c.h) / hmax);
        c.compHeight = Math.ceil((height * c.v) / vmax);
      }
    } else if (marker === 0xdb) {
      // DQT
      let p = dataStart;
      while (p + 65 <= dataEnd) {
        const pqTq = bytes[p++];
        const pq = pqTq >> 4;
        const tq = pqTq & 15;
        if (pq !== 0) throw new Error("JPEG 解码：不支持 16-bit 量化表");
        if (tq > 3) throw new Error("JPEG 解码：量化表序号非法");
        const q = new Float64Array(64);
        for (let i = 0; i < 64; i++) q[ZIGZAG[i]] = bytes[p++];
        quantTables[tq] = q;
      }
    } else if (marker === 0xc4) {
      // DHT（一个段可含多张表）
      let p = dataStart;
      while (p < dataEnd) {
        const tcTh = bytes[p++];
        const tc = tcTh >> 4;
        const th = tcTh & 15;
        if (tc > 1 || th > 3) throw new Error("JPEG 解码：Huffman 表序号非法");
        const counts = bytes.subarray(p, p + 16);
        p += 16;
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        const values = bytes.subarray(p, p + total);
        p += total;
        const table = buildHuffTable(new Uint8Array(counts), new Uint8Array(values));
        if (tc === 0) dcTables[th] = table;
        else acTables[th] = table;
      }
    } else if (marker === 0xdd) {
      restartInterval = readU16At(bytes, dataStart);
    } else if (marker === 0xda) {
      // SOS：ctx.pos 指向 SOS 头起点，段长之后即熵编码数据
      const ctx: Ctx = {
        bytes,
        pos: dataStart,
        bitBuf: 0,
        bitCnt: 0,
        eob: false,
        comps: [],
        dcTables,
        acTables,
        quantTables,
      };
      decodeScan(ctx, components, restartInterval, width, height);
      sawSos = true;
      pos = ctx.pos;
      continue;
    } else if (
      (marker >= 0xe0 && marker <= 0xef) || // APPn
      marker === 0xfe || // COM
      marker === 0xdc || // DNL
      marker === 0xde || // DHP
      marker === 0xdf // EXP
    ) {
      // 跳过段
    } else {
      throw new Error(`JPEG 解码：未处理的标记 0x${marker.toString(16)}`);
    }

    pos = dataEnd;
  }

  if (!sawSos) throw new Error("JPEG 解码：缺少扫描数据");

  // ---- 输出 RGBA8：上采样 + 颜色转换 ----
  // 上采样与 libjpeg-turbo jdsample.c 的 fancy upsampling 精确一致（含舍入），
  // 保证与 Photoshop / 浏览器等主流解码器结果相同；其余倍率用双线性近似。
  const hmax = Math.max(...components.map((c) => c.h));
  const vmax = Math.max(...components.map((c) => c.v));
  const rgba = new Uint8Array(width * height * 4);

  const makeSampler = (c: Component): ((x: number, y: number) => number) => {
    const plane = c.plane;
    const stride = c.planeBlocksW * 8;
    const W = c.compWidth; // 源样本宽/高（非块填充尺寸）
    const H = c.compHeight;
    const sx = hmax / c.h;
    const sy = vmax / c.v;
    const at = (x: number, y: number): number =>
      plane[y * stride + (x < 0 ? 0 : x >= W ? W - 1 : x)];
    if (sx === 1 && sy === 1) return (x, y) => plane[y * stride + x];
    if (sx === 2 && sy === 2) {
      // h2v2 fancy：纵向 (3,1) 合成列和，再横向 (3,1)，/16 取整（bias 8/7）
      return (x, y) => {
        const r = y >> 1;
        const rr =
          (y & 1) === 0 ? (r > 0 ? r - 1 : 0) : r < H - 1 ? r + 1 : H - 1;
        const i = x >> 1;
        const cc =
          (x & 1) === 0 ? (i > 0 ? i - 1 : 0) : i < W - 1 ? i + 1 : W - 1;
        const bias = (x & 1) === 0 ? 8 : 7;
        return (
          (3 * (3 * at(i, r) + at(i, rr)) +
            (3 * at(cc, r) + at(cc, rr)) +
            bias) >>
          4
        );
      };
    }
    if (sx === 2) {
      // h2v1 fancy：横向 (3,1)，/4 取整（bias 1/2）
      return (x, y) => {
        const i = x >> 1;
        const cc =
          (x & 1) === 0 ? (i > 0 ? i - 1 : 0) : i < W - 1 ? i + 1 : W - 1;
        const bias = (x & 1) === 0 ? 1 : 2;
        return (3 * at(i, y) + at(cc, y) + bias) >> 2;
      };
    }
    if (sy === 2) {
      // h1v2 fancy：纵向 (3,1)，/4 取整（bias 1/2）
      return (x, y) => {
        const r = y >> 1;
        const bias = (y & 1) === 0 ? 1 : 2;
        const rr =
          (y & 1) === 0 ? (r > 0 ? r - 1 : 0) : r < H - 1 ? r + 1 : H - 1;
        return (3 * at(x, r) + at(x, rr) + bias) >> 2;
      };
    }
    // 其他倍率：双线性（centered；真实输出不出现，仅兜底）
    return (x, y) => {
      const fx = (x + 0.5) / sx - 0.5;
      const fy = (y + 0.5) / sy - 0.5;
      const xf = Math.floor(fx);
      const yf = Math.floor(fy);
      const x0 = xf < 0 ? 0 : xf > W - 1 ? W - 1 : xf;
      const y0 = yf < 0 ? 0 : yf > H - 1 ? H - 1 : yf;
      const x1 = x0 + 1 > W - 1 ? W - 1 : x0 + 1;
      const y1 = y0 + 1 > H - 1 ? H - 1 : y0 + 1;
      const tx = fx - xf;
      const ty = fy - yf;
      return (
        at(x0, y0) * (1 - tx) * (1 - ty) +
        at(x1, y0) * tx * (1 - ty) +
        at(x0, y1) * (1 - tx) * ty +
        at(x1, y1) * tx * ty
      );
    };
  };

  const samplers = components.map(makeSampler);

  if (components.length === 1) {
    const s = samplers[0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const g = Math.round(s(x, y));
        const d = (y * width + x) * 4;
        rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
        rgba[d + 3] = 255;
      }
    }
  } else {
    const [sY, sCb, sCr] = samplers;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const Y = sY(x, y);
        const Cb = sCb(x, y) - 128;
        const Cr = sCr(x, y) - 128;
        const R = Y + 1.402 * Cr;
        const G = Y - 0.344136 * Cb - 0.714136 * Cr;
        const B = Y + 1.772 * Cb;
        const d = (y * width + x) * 4;
        rgba[d] = R < 0 ? 0 : R > 255 ? 255 : R;
        rgba[d + 1] = G < 0 ? 0 : G > 255 ? 255 : G;
        rgba[d + 2] = B < 0 ? 0 : B > 255 ? 255 : B;
        rgba[d + 3] = 255;
      }
    }
  }

  return { width, height, rgba };
};
