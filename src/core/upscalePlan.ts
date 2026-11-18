/**
 * 图层超分（SeedVR2）的尺寸规划与命令拼装（纯函数，Node 可单测）。
 *
 * 用户输入的是「目标长边」而不是固定 2×/4×：超分倍率由目标长边与图层
 * **原始像素长边**决定（智能对象取内容文档尺寸，普通图层取外接矩形）。
 * 贴回时仍按原图层在画布上的外接矩形摆放，因此视觉位置与比例不变；
 * PS 里的放大倍率只用于提示「目标长边是否覆盖当前显示尺寸」。
 */

export const DEFAULT_UPSCALE_LONG_SIDE = 4096;
export const MIN_UPSCALE_LONG_SIDE = 64;
/** SeedVR2 helper 的目标画布上限（超过会被 CLI 以退出码 4 拒绝）。 */
export const MAX_UPSCALE_LONG_SIDE = 300_000;
/**
 * 插件侧的输出像素上限：结果要整体读回内存再解码，超过 1 亿像素极易触发
 * UXP 的数组长度 / 内存上限，提前拦截并提示减小目标长边。
 */
export const MAX_UPSCALE_PIXELS = 100_000_000;

export interface UpscaleSizePlan {
  /** 归一化后的目标长边。 */
  longSide: number;
  width: number;
  height: number;
  /** 输出相对输入的像素倍率（按长边计算）。 */
  scale: number;
}

/** 输入框 / 旧配置归一化：非法值或低于下限回退默认值，超过上限截断。 */
export const normalizeUpscaleLongSide = (
  value: unknown,
  fallback = DEFAULT_UPSCALE_LONG_SIDE,
): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < MIN_UPSCALE_LONG_SIDE) return fallback;
  return Math.min(n, MAX_UPSCALE_LONG_SIDE);
};

/** 按目标长边计算输出尺寸（目标小于原长边时按比例缩小，不做拦截）。 */
export const planUpscaleSize = (
  width: number,
  height: number,
  longSide: number,
): UpscaleSizePlan => {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0) || !(h > 0)) {
    throw new Error("原图层尺寸无效（宽或高为 0），无法超分");
  }
  const target = Math.round(Number(longSide));
  if (!Number.isFinite(target) || target < MIN_UPSCALE_LONG_SIDE) {
    throw new Error(`目标长边至少为 ${MIN_UPSCALE_LONG_SIDE}px`);
  }
  if (target > MAX_UPSCALE_LONG_SIDE) {
    throw new Error(`目标长边不能超过 ${MAX_UPSCALE_LONG_SIDE}px`);
  }
  const current = Math.max(w, h);
  const scale = target / current;
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  if (outW * outH > MAX_UPSCALE_PIXELS) {
    throw new Error(
      `目标输出 ${outW}×${outH}（约 ${Math.round(
        (outW * outH) / 1_000_000,
      )} 百万像素）超过插件上限 ${MAX_UPSCALE_PIXELS / 1_000_000} 百万像素，请减小目标长边`,
    );
  }
  return {
    longSide: target,
    width: outW,
    height: outH,
    scale,
  };
};

/**
 * 智能对象图层：原始分辨率（内容像素）+ PS 中的显示尺寸 → 超分规划。
 *
 * 目标长边 N 是结果智能对象（内容）的真实像素长边，不与原始 / 显示尺寸做拦截；
 * PS 里的放大倍率（displayScale）只用于提示「目标是否覆盖当前显示」。
 */
export interface ContentUpscalePlan extends UpscaleSizePlan {
  /** 图层在文档中的显示尺寸（贴回后保持这个外接矩形）。 */
  displaySize: { width: number; height: number };
  /** PS 中的放大倍率（显示长边 / 原始长边）。 */
  displayScale: number;
  /** 两轴倍率不一致（非等比缩放 / 旋转 / 变形），贴回会按外接矩形拉伸。 */
  nonUniform: boolean;
  /** 目标长边小于当前显示长边：贴回后显示时仍会被放大。 */
  belowDisplay: boolean;
}

export const planContentUpscale = (
  originalWidth: number,
  originalHeight: number,
  displayWidth: number,
  displayHeight: number,
  longSide: number,
): ContentUpscalePlan => {
  const base = planUpscaleSize(originalWidth, originalHeight, longSide);
  const ow = Math.round(Number(originalWidth));
  const oh = Math.round(Number(originalHeight));
  const dw = Math.round(Number(displayWidth));
  const dh = Math.round(Number(displayHeight));
  const sx = dw > 0 ? dw / ow : 1;
  const sy = dh > 0 ? dh / oh : 1;
  const displayScale = Math.max(sx, sy);
  return {
    ...base,
    displaySize: { width: dw, height: dh },
    displayScale,
    nonUniform: Math.abs(sx - sy) > displayScale * 0.01,
    belowDisplay: Math.round(Number(longSide)) < Math.max(dw, dh),
  };
};

/**
 * `silicontrol upscale FILE DEST --long-side N`。
 *
 * 不加 `--yes`：本机 CLI（Siliconed 0.20）的 upscale 参数解析器不接受该选项，
 * 传了会直接以 `unknown option "--yes"` 退出；插件侧也无法应答交互确认。
 */
export const buildUpscaleArgs = (
  srcPath: string,
  destPath: string,
  longSide: number,
): string[] => {
  const src = srcPath.trim();
  const dest = destPath.trim();
  if (!src || !dest) {
    throw new Error("超分输入 / 输出路径不能为空");
  }
  return ["upscale", src, dest, "--long-side", String(Math.round(longSide))];
};
