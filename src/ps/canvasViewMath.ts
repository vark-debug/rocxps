import type { Rect } from "./types";

/**
 * 画布视口换算与浮窗摆放规则（纯函数，可被 Node 单测直接打包）。
 *
 * 坐标系约定：
 * - 文档坐标：画布像素，原点左上（selection.bounds 同空间）；
 * - 全局屏幕坐标：top-left 原点、macOS 为点（UXP「global display space」，
 *   即 viewInfo.activeView.globalBounds 所在空间）；
 * - 换算到 Cocoa（bottom-left 原点）在 native 侧完成。
 *
 * 数据来源（PS 2026 26.x 实测可用的私有 batchPlay 属性，社区脚本验证）：
 * - document.viewTransform：6 元素列表 [m, ?, ?, m, offsetLeft, offsetTop]，
 *   m = 文档像素/屏幕点（放大率 200% 时 0.5），offset = 视口左上角的文档坐标；
 * - document.viewInfo.activeView.globalBounds：视口的全局屏幕矩形。
 *   screen = viewport.left + (doc - offset) / m。
 */

/** 画布视口（一次 batchPlay 读取的结果） */
export interface CanvasView {
  /** 缩放因子：文档像素 / 屏幕点（viewTransform[0]，恒 > 0） */
  scale: number;
  /** 视口左上角的文档坐标（viewTransform[4]/[5]） */
  docOffsetLeft: number;
  docOffsetTop: number;
  /** 文档视口在全局屏幕坐标中的矩形 */
  viewport: Rect;
}

/** 浮窗与选区外缘的间距（确认方案：16px） */
export const TOOLBAR_GAP = 16;

/** 文档点 → 全局屏幕点（top-left 原点） */
export const docToScreen = (
  v: CanvasView,
  x: number,
  y: number,
): { x: number; y: number } => ({
  x: v.viewport.left + (x - v.docOffsetLeft) / v.scale,
  y: v.viewport.top + (y - v.docOffsetTop) / v.scale,
});

/** 文档矩形（画布/选区）→ 全局屏幕矩形 */
export const docRectToScreen = (v: CanvasView, r: Rect): Rect => {
  const tl = docToScreen(v, r.left, r.top);
  const br = docToScreen(v, r.right, r.bottom);
  return { left: tl.x, top: tl.y, right: br.x, bottom: br.y };
};

/** 两矩形交集；不相交返回 null */
export const intersectRects = (a: Rect, b: Rect): Rect | null => {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
};

export interface PlaceToolbarInput {
  /** 画布视口；null（读取失败）→ 返回 null，调用方退回固定定位 */
  view: CanvasView | null;
  /** 选区外接矩形（文档坐标） */
  selDoc: Rect;
  docWidth: number;
  docHeight: number;
  toolbarWidth: number;
  toolbarHeight: number;
  gap?: number;
}

/**
 * 浮窗摆放（已确认的三场景规则）：
 * 1. 垂直优先放选区正下方（选区外 gap），水平与选区中心对齐；
 * 2. 画布约束优先：浮窗任何时刻完整落在「可见画布」内
 *    （可见画布 = 画布屏幕矩形 ∩ 文档视口）；
 * 3. 下方放不下 → 翻到选区上方；水平居中出界 → 钳制进画布（放弃严格居中）；
 *    上下都放不下 → 兜底贴可见画布底缘内侧。
 */
export const placeToolbar = (input: PlaceToolbarInput): { x: number; y: number } | null => {
  const { view, selDoc, docWidth, docHeight, toolbarWidth: w, toolbarHeight: h } = input;
  const gap = input.gap ?? TOOLBAR_GAP;
  if (!view) return null;

  // 钳制盒：可见画布（画布屏幕矩形 ∩ 视口）
  const canvas = docRectToScreen(view, {
    left: 0,
    top: 0,
    right: docWidth,
    bottom: docHeight,
  });
  const box = intersectRects(canvas, view.viewport);
  if (!box) return null;

  // 选区屏幕矩形
  const sel = docRectToScreen(view, selDoc);

  // 垂直：下方 → 上方 → 贴底缘内侧（约定兜底）
  let y = sel.bottom + gap;
  if (y + h > box.bottom || y < box.top) {
    y = sel.top - gap - h;
  }
  if (y + h > box.bottom || y < box.top) {
    y = box.bottom - h;
  }
  if (y < box.top) y = box.top; // 浮窗比可见画布还高 → 贴顶

  // 水平：与选区中心对齐，出界钳制进画布（放弃严格居中）
  let x = (sel.left + sel.right) / 2 - w / 2;
  if (x < box.left) x = box.left;
  if (x + w > box.right) x = box.right - w;
  if (x < box.left) x = box.left; // 浮窗比可见画布还宽 → 贴左

  return { x: Math.round(x), y: Math.round(y) };
};
