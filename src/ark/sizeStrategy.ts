import type { ModelPreset } from "./models";

/**
 * Seedream 显式 WxH 路线的请求尺寸换算（docs/local-redraw-plan.md §4）。
 *
 * 小选区低于模型最小总像素 → 放大请求（贴回时缩回）；
 * 超大选区高于上限 → 缩小请求（贴回时放大）；
 * 请求尺寸按 model.sizeAlign 对齐（默认 8，Qwen-Image-2.1 为 32）并保持原宽高比（容差内），
 * 宽高比超 [1/16, 16] 直接拦截。
 * seededit 等 adaptive 模型不走本换算（explicitSize = false）。
 */
export const MIN_ASPECT = 1 / 16;
export const MAX_ASPECT = 16;

export interface RequestSizeResult {
  reqW: number;
  reqH: number;
}

export const computeRequestSize = (
  model: ModelPreset,
  width: number,
  height: number,
): RequestSizeResult => {
  if (!model.explicitSize) {
    throw new Error("该模型为 adaptive 模式，无需换算请求尺寸");
  }
  if (width <= 0 || height <= 0) {
    throw new Error("区域尺寸非法");
  }

  const align = model.sizeAlign ?? 8;
  const alignCeil = (v: number) => Math.ceil(v / align) * align;
  const alignFloor = (v: number) => Math.floor(v / align) * align;

  const aspect = width / height;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    throw new Error(
      `选区宽高比 ${aspect.toFixed(2)} 超出模型支持的 [1/16, 16] 范围`,
    );
  }

  const pixels = width * height;
  const { minPixels, maxPixels } = model;
  let reqW = width;
  let reqH = height;

  if (minPixels > 0 && pixels < minPixels) {
    const s = Math.sqrt(minPixels / pixels);
    reqW = alignCeil(width * s);
    reqH = alignCeil(height * s);
  } else if (maxPixels > 0 && pixels > maxPixels) {
    const s = Math.sqrt(maxPixels / pixels);
    reqW = alignFloor(width * s);
    reqH = alignFloor(height * s);
  }

  // 单边上限（如 Wan 2.2 的 1536）：极窄/极宽选区按总像素换算后仍可能超出
  const maxSide = model.maxSide ?? 0;
  if (maxSide > 0 && Math.max(reqW, reqH) > maxSide) {
    const s = maxSide / Math.max(reqW, reqH);
    reqW = Math.max(align, alignFloor(reqW * s));
    reqH = Math.max(align, alignFloor(reqH * s));
  }

  if (reqW < align || reqH < align) {
    throw new Error("请求尺寸换算异常");
  }

  return { reqW, reqH };
};
