import type { ExpandedRegion, Rect } from "./types";
import type { PadPercent } from "./expandPlan";

/** 输出尺寸贴合计划（纯计算；贴回几何一律按实际输出尺寸缩放）。 */
export interface OutputFitPlan {
  /** 实际输出宽高（历史记录排查用）。 */
  actualW: number;
  actualH: number;
  /** 实际尺寸与请求尺寸不一致（需要提示用户）。 */
  outputMismatch: boolean;
  /** 两轴缩放比不同 → 结果图本身被工具拉伸。 */
  stretched: boolean;
  /** 实际应用的缩放比（目标区域尺寸 / 实际输出尺寸，逐轴）。 */
  appliedScale: { x: number; y: number };
}

/**
 * 输出尺寸校验：拿到结果图后精确读取实际宽高，与请求尺寸比较。
 * 无论是否一致，贴回都按**实际宽高**缩放到抓取区域，禁止按请求尺寸算几何
 * （请求像素数不等于工具返回像素数时，按请求尺寸写图层会整体错位）。
 */
export const planOutputFit = (
  actualW: number,
  actualH: number,
  requestedW: number,
  requestedH: number,
  targetW: number,
  targetH: number,
): OutputFitPlan => {
  if (
    !(actualW > 0) ||
    !(actualH > 0) ||
    !(requestedW > 0) ||
    !(requestedH > 0) ||
    !(targetW > 0) ||
    !(targetH > 0)
  ) {
    throw new Error("输出尺寸校验：尺寸非法");
  }
  const sx = targetW / actualW;
  const sy = targetH / actualH;
  return {
    actualW,
    actualH,
    outputMismatch: actualW !== requestedW || actualH !== requestedH,
    stretched: Math.abs(Math.log(sx / sy)) > 1e-3,
    appliedScale: { x: sx, y: sy },
  };
};

/** 输出尺寸不一致时给用户的提示；一致时返回 undefined。 */
export const outputSizeNote = (
  plan: OutputFitPlan,
  requestedW: number,
  requestedH: number,
): string | undefined => {
  if (!plan.outputMismatch) return undefined;
  const base = `工具返回 ${plan.actualW}×${plan.actualH}，与请求 ${requestedW}×${requestedH} 不一致，已按实际尺寸贴回`;
  if (!plan.stretched) return base;
  return `${base}；两轴缩放比不同（sx ${plan.appliedScale.x.toFixed(4)} / sy ${plan.appliedScale.y.toFixed(4)}），结果图本身可能被拉伸`;
};

/**
 * 贴回几何（纯函数，Node 可单测）。
 *
 * 生成结果始终缩放到「扩展区域」尺寸（预设模式为预设比例，custom 为 32 对齐；
 * 可能含画布外补边）；
 * 补边模式下贴回只能落在画布内：
 * - 目标坐标 = 扩展区域 bounds 加上左/上补边；
 * - 裁剪起点 = 扩展区域数据中的左/上补边，宽高 = 扩展区域减去四边补边。
 *
 * 图层蒙版与像素使用同一份几何，保证蒙版与内容严格对齐。
 */
export interface PlaceGeometry {
  /** 画布内目标尺寸（裁剪掉补边后）。 */
  outW: number;
  outH: number;
  /** 画布内目标位置（文档像素坐标，不受文档坐标系/图层偏移影响）。 */
  targetLeft: number;
  targetTop: number;
  /** 扩展区域数据中的裁剪起点（补边偏移）。 */
  srcLeft: number;
  srcTop: number;
}

export const computePlaceGeometry = (expanded: ExpandedRegion): PlaceGeometry => {
  const pad = expanded.padInfo;
  if (!pad) {
    return {
      outW: expanded.width,
      outH: expanded.height,
      targetLeft: expanded.bounds.left,
      targetTop: expanded.bounds.top,
      srcLeft: 0,
      srcTop: 0,
    };
  }
  const outW = expanded.width - pad.padLeft - pad.padRight;
  const outH = expanded.height - pad.padTop - pad.padBottom;
  if (outW <= 0 || outH <= 0) throw new Error("补边裁剪后区域为空");
  return {
    outW,
    outH,
    targetLeft: expanded.bounds.left + pad.padLeft,
    targetTop: expanded.bounds.top + pad.padTop,
    srcLeft: pad.padLeft,
    srcTop: pad.padTop,
  };
};

/**
 * 按通道平面裁剪（RGBA 传 components=4，灰度蒙版传 1）。
 * 非矩形选区在蒙版数据里天然保留，裁剪只改变范围、不改变形状。
 */
export const cropPlane = (
  src: Uint8Array,
  components: number,
  srcWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
): Uint8Array => {
  if (!Number.isInteger(components) || components <= 0) {
    throw new Error("裁剪：通道数非法");
  }
  if (srcWidth <= 0 || width <= 0 || height <= 0) {
    throw new Error("裁剪：尺寸非法");
  }
  const srcHeight = src.length / (srcWidth * components);
  if (!Number.isInteger(srcHeight)) {
    throw new Error("裁剪：源数据长度与尺寸不符");
  }
  if (
    left < 0 ||
    top < 0 ||
    left + width > srcWidth ||
    top + height > srcHeight
  ) {
    throw new Error("裁剪：区域超出源数据范围");
  }
  if (left === 0 && top === 0 && width === srcWidth && height === srcHeight) {
    return src;
  }
  const out = new Uint8Array(width * height * components);
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * srcWidth + left) * components;
    out.set(src.subarray(from, from + width * components), y * width * components);
  }
  return out;
};

/**
 * 合成整画布尺寸的灰度图层蒙版：黑底（隐藏）+ 在文档坐标 (left, top)
 * 写入区域内的选区蒙版（白 = 显示，羽化灰阶原样保留，形状不被矩形化）。
 *
 * 图层蒙版作用范围是整个画布，区域外必须是纯黑；这里只分配一次画布大小
 * 的缓冲区并按行复制重叠区域，避免中间拷贝（8000×6000 灰度约 48MB）。
 * 区域可越出画布（负坐标/超边界），只写入与画布的交集。
 */
export const composeCanvasMask = (
  canvasWidth: number,
  canvasHeight: number,
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  left: number,
  top: number,
): Uint8Array => {
  if (
    !Number.isInteger(canvasWidth) ||
    !Number.isInteger(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    throw new Error("画布尺寸非法");
  }
  if (maskWidth <= 0 || maskHeight <= 0) {
    throw new Error("蒙版尺寸非法");
  }
  if (mask.length !== maskWidth * maskHeight) {
    throw new Error("蒙版数据长度与尺寸不符");
  }

  // Uint8Array 默认 0 = 黑 = 区域外隐藏
  const out = new Uint8Array(canvasWidth * canvasHeight);
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(canvasWidth, left + maskWidth);
  const y1 = Math.min(canvasHeight, top + maskHeight);
  if (x1 <= x0 || y1 <= y0) return out;

  const copyW = x1 - x0;
  for (let y = y0; y < y1; y++) {
    const srcRow = (y - top) * maskWidth + (x0 - left);
    out.set(mask.subarray(srcRow, srcRow + copyW), y * canvasWidth + x0);
  }
  return out;
};

/** 阔图贴回几何：结果 = 逻辑输出画布（源图按 pad 外扩后的整体）。 */
export interface ExpandPlaceGeometry {
  /** 结果数据中裁掉的画布外部分（左/上越界时 > 0）。 */
  srcLeft: number;
  srcTop: number;
  /** 画布内实际写入位置（文档像素坐标）。 */
  targetLeft: number;
  targetTop: number;
  /** 画布内实际写入尺寸（越界裁剪后，≥1）。 */
  outW: number;
  outH: number;
  /** 逻辑输出画布尺寸（源图 × (1 + pad%)，缩放目标）。 */
  logicalWidth: number;
  logicalHeight: number;
}

/**
 * 阔图贴回几何（纯函数，Node 可单测）。
 *
 * expand 结果覆盖整张逻辑输出画布（源图 + 四边生成内容），没有蒙版与补边，
 * 只需处理画布越界：目标位置 = 源图包围盒按 pad 反向外推；越出画布的部分
 * 裁掉（srcLeft/srcTop 记录数据中的裁剪起点）。逻辑尺寸与 computeExpandPads
 * 的 logicalWidth/Height 同式，缩放比偏差 ≤ 数十像素，由等比缩放消化。
 */
export const computeExpandPlaceGeometry = (
  canvasWidth: number,
  canvasHeight: number,
  source: Rect,
  pads: PadPercent,
): ExpandPlaceGeometry => {
  const sw = Math.round(source.right - source.left);
  const sh = Math.round(source.bottom - source.top);
  if (!(sw > 0) || !(sh > 0)) {
    throw new Error("扩图贴回：源图包围盒为空");
  }
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) {
    throw new Error("扩图贴回：画布尺寸非法");
  }
  for (const value of [pads.left, pads.right, pads.top, pads.bottom]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("扩图贴回：pad 百分比非法");
    }
  }

  const logicalWidth = Math.round(sw * (1 + (pads.left + pads.right) / 100));
  const logicalHeight = Math.round(sh * (1 + (pads.top + pads.bottom) / 100));

  let targetLeft = source.left - Math.round((pads.left / 100) * sw);
  let targetTop = source.top - Math.round((pads.top / 100) * sh);
  let srcLeft = 0;
  let srcTop = 0;
  if (targetLeft < 0) {
    srcLeft = -targetLeft;
    targetLeft = 0;
  }
  if (targetTop < 0) {
    srcTop = -targetTop;
    targetTop = 0;
  }

  const outW = Math.min(logicalWidth - srcLeft, canvasWidth - targetLeft);
  const outH = Math.min(logicalHeight - srcTop, canvasHeight - targetTop);
  if (!(outW > 0) || !(outH > 0)) {
    throw new Error("扩图贴回：结果与画布无交集");
  }
  return {
    srcLeft,
    srcTop,
    targetLeft,
    targetTop,
    outW,
    outH,
    logicalWidth,
    logicalHeight,
  };
};
