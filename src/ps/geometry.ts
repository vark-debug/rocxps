import { CAPTURE_ALIGN, alignUp } from "./align";
import type { ExpandedRegion, PadInfo, Rect } from "./types";

/** Siliconed 取景外扩系数：以选区中心等比放大，只扩不缩（仅 Siliconed 使用）。 */
export const SILICONED_SELECTION_EXPAND = 1.4;

/** 以选区中心等比放大的基础尺寸；系数 1 时保持原尺寸。 */
const growSelection = (
  selW: number,
  selH: number,
  factor: number,
): { width: number; height: number } => {
  if (!(factor >= 1)) throw new Error("外扩系数必须大于等于 1");
  return {
    width: Math.max(selW, Math.ceil(selW * factor)),
    height: Math.max(selH, Math.ceil(selH * factor)),
  };
};

/**
 * 选区对齐边界扩展（docs/local-redraw-plan.md §4）。纯函数，可 Node 单测。
 *
 * 规则：扩展区域必须完整包含原选区，且宽、高两条边长均被 align 整除
 * （默认 CAPTURE_ALIGN = 32）；外扩量（每边最多 align-1 px）居中分配，
 * 越界时在画布内整体平移；画布放不下 align 倍数时进入补边模式：
 * 虚拟区域以画布居中（该轴画布必小于虚拟区域），padInfo 记录画布在虚拟图中的
 * 四边偏移，导出时补边、贴回时裁边。
 */
export const expandRectToMultiple = (
  sel: Rect,
  canvasW: number,
  canvasH: number,
  align: number = CAPTURE_ALIGN,
  expandFactor: number = 1,
): ExpandedRegion => {
  const selW = sel.right - sel.left;
  const selH = sel.bottom - sel.top;
  if (selW <= 0 || selH <= 0) {
    throw new Error("选区为空");
  }
  if (selW > canvasW || selH > canvasH) {
    throw new Error("选区超出画布范围");
  }

  // 1. 先按系数以中心等比外扩，再向上取整到 align 的倍数（只扩不缩）
  const base = growSelection(selW, selH, expandFactor);
  const w = alignUp(base.width, align);
  const h = alignUp(base.height, align);
  const dx = w - selW;
  const dy = h - selH;

  // 2. 居中分配外扩量
  let left = sel.left - Math.floor(dx / 2);
  let top = sel.top - Math.floor(dy / 2);
  let right = left + w;
  let bottom = top + h;

  // 3. 画布内平移（左右/上下互推，不改变 w/h）。
  //    平移后 left/top 再变负 ⇔ 画布该轴装不下 w/h → 进入补边模式。
  if (left < 0) {
    right -= left;
    left = 0;
  }
  if (right > canvasW) {
    left -= right - canvasW;
    right = canvasW;
  }
  if (top < 0) {
    bottom -= top;
    top = 0;
  }
  if (bottom > canvasH) {
    top -= bottom - canvasH;
    bottom = canvasH;
  }

  let padLeft = 0;
  let padTop = 0;
  let padRight = 0;
  let padBottom = 0;
  if (left < 0) {
    padLeft = Math.floor((w - canvasW) / 2);
    left = -padLeft;
    right = left + w;
    padRight = Math.max(0, right - canvasW);
  }
  if (top < 0) {
    padTop = Math.floor((h - canvasH) / 2);
    top = -padTop;
    bottom = top + h;
    padBottom = Math.max(0, bottom - canvasH);
  }

  const padInfo: PadInfo | undefined =
    padLeft > 0 || padTop > 0 || padRight > 0 || padBottom > 0
      ? { padLeft, padTop, padRight, padBottom, width: w, height: h }
      : undefined;

  const width = right - left;
  const height = bottom - top;
  if (width !== w || height !== h) {
    throw new Error(`${align} 整除扩展计算异常`);
  }

  return {
    bounds: { left, top, right, bottom },
    width,
    height,
    padInfo,
  };
};

/**
 * 选区扩展到目标宽高比（预设路径）。纯函数，可 Node 单测。
 *
 * 规则：
 * - 以选区中心为中心，只扩不缩（扩展后的矩形必须完整包含原选区）；
 * - 沿「不足的那一轴」外扩到目标比例：选区偏窄时扩宽、偏宽时扩高；
 * - 扩展后越出画布时整体平移回画布内（不裁掉用户选中内容），平移量导致
 *   左右/上下 pad 不对称；
 * - 画布该轴装不下扩展尺寸时与旧逻辑一致，进入补边模式（padInfo）。
 *
 * 注意：这里只保证目标比例，不要求原生宽高等于预设；送图前统一缩放到
 * 预设的精确尺寸（preset.width × preset.height）。
 */
export const expandRectToAspect = (
  sel: Rect,
  canvasW: number,
  canvasH: number,
  targetW: number,
  targetH: number,
  expandFactor: number = 1,
): ExpandedRegion => {
  const selW = sel.right - sel.left;
  const selH = sel.bottom - sel.top;
  if (selW <= 0 || selH <= 0) {
    throw new Error("选区为空");
  }
  if (selW > canvasW || selH > canvasH) {
    throw new Error("选区超出画布范围");
  }
  if (!(targetW > 0) || !(targetH > 0)) {
    throw new Error("目标尺寸非法");
  }

  // 1. 先按系数以中心等比外扩（比例不变），再沿不足轴补到预设比例
  const base = growSelection(selW, selH, expandFactor);
  const baseRatio = base.width / base.height;
  const targetRatio = targetW / targetH;

  let w = base.width;
  let h = base.height;
  const ratioDiff = Math.abs(Math.log(baseRatio / targetRatio));
  if (ratioDiff > 1e-6) {
    if (baseRatio < targetRatio) {
      w = Math.max(w, Math.ceil(h * targetRatio));
    } else {
      h = Math.max(h, Math.ceil(w / targetRatio));
    }
  }

  // 2. 以选区中心为中心摆放
  let left = sel.left - Math.floor((w - selW) / 2);
  let top = sel.top - Math.floor((h - selH) / 2);
  let right = left + w;
  let bottom = top + h;

  // 3. 越出画布 → 整体平移回画布内（不裁剪），平移后仍越界则进入补边模式
  if (left < 0) {
    right -= left;
    left = 0;
  }
  if (right > canvasW) {
    left -= right - canvasW;
    right = canvasW;
  }
  if (top < 0) {
    bottom -= top;
    top = 0;
  }
  if (bottom > canvasH) {
    top -= bottom - canvasH;
    bottom = canvasH;
  }

  let padLeft = 0;
  let padTop = 0;
  let padRight = 0;
  let padBottom = 0;
  if (left < 0) {
    padLeft = Math.floor((w - canvasW) / 2);
    left = -padLeft;
    right = left + w;
    padRight = Math.max(0, right - canvasW);
  }
  if (top < 0) {
    padTop = Math.floor((h - canvasH) / 2);
    top = -padTop;
    bottom = top + h;
    padBottom = Math.max(0, bottom - canvasH);
  }

  const padInfo: PadInfo | undefined =
    padLeft > 0 || padTop > 0 || padRight > 0 || padBottom > 0
      ? { padLeft, padTop, padRight, padBottom, width: w, height: h }
      : undefined;

  const width = right - left;
  const height = bottom - top;
  if (width !== w || height !== h) {
    throw new Error("目标比例扩展计算异常");
  }

  return {
    bounds: { left, top, right, bottom },
    width,
    height,
    padInfo,
  };
};

/** 选区四边的实际外扩量（扩展 + 画布内平移后的真实 pad）。 */
export interface PadAmounts {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const padAmountsOf = (sel: Rect, expanded: ExpandedRegion): PadAmounts => ({
  left: Math.max(0, sel.left - expanded.bounds.left),
  top: Math.max(0, sel.top - expanded.bounds.top),
  right: Math.max(0, expanded.bounds.right - sel.right),
  bottom: Math.max(0, expanded.bounds.bottom - sel.bottom),
});

/** 断言矩形两条边长均被 align 整除。 */
export const assertAligned = (rect: Rect, align: number = CAPTURE_ALIGN): void => {
  if (
    (rect.right - rect.left) % align !== 0 ||
    (rect.bottom - rect.top) % align !== 0
  ) {
    throw new Error(`区域尺寸未对齐 ${align} 像素`);
  }
};
