import { photoshop } from "../globals";
import type { Rect } from "./types";
import {
  docRectToScreen,
  docToScreen,
  intersectRects,
  placeToolbar,
  type CanvasView,
} from "./canvasViewMath";

// 纯函数统一再导出（调用方只 import 本模块）
export { docToScreen, docRectToScreen, intersectRects, placeToolbar };
export type { CanvasView };

/**
 * 读取活动文档的画布视口（用于选区 → 屏幕坐标换算）。
 *
 * 数据来自两个私有 batchPlay 属性（PS 2026 26.x 可用，社区脚本验证）：
 * - viewTransform：6 元素列表 [m, ?, ?, m, offsetLeft, offsetTop]，
 *   m = 文档像素/屏幕点；offset = 视口左上角的文档坐标；
 * - viewInfo.activeView.globalBounds：视口的全局屏幕矩形（top-left 原点）。
 *
 * 任何读取/解析失败返回 null（调用方退回固定定位），首次失败打一条
 * console.warn 便于真机排查（原始描述符结构随版本可能变化）。
 * 注意：batchPlay 必须 sync:true（modal 内 sync:false 永不返回，参考
 * selection.ts 踩坑）。
 */
/** 首次成功/失败各打一条日志（真机校准用），之后静默 */
let logged = false;

export const readCanvasView = async (): Promise<CanvasView | null> => {
  try {
    const result = await photoshop.action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _property: "viewTransform" },
            { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
          ],
        },
        {
          _obj: "get",
          _target: [
            { _property: "viewInfo" },
            { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
          ],
        },
      ],
      { synchronousExecution: true, dialogOptions: "dontDisplay" },
    );
    const [vtRes, viRes] = (result ?? []) as [
      { _obj?: string; viewTransform?: unknown } | undefined,
      { _obj?: string; viewInfo?: unknown } | undefined,
    ];
    if (
      !vtRes ||
      !viRes ||
      vtRes._obj === "error" ||
      viRes._obj === "error"
    ) {
      if (!logged) {
        logged = true;
        console.warn(
          "[canvasView] 读取视口失败（回退固定定位）",
          JSON.stringify(result),
        );
      }
      return null;
    }

    // viewTransform：batchPlay 列表 → 数组，元素可能被 UnitValue 包装
    const list = Array.isArray(vtRes.viewTransform)
      ? (vtRes.viewTransform as unknown[]).map((v) => Number(v))
      : [];
    const scale = list[0];
    const docOffsetLeft = list[4];
    const docOffsetTop = list[5];
    // 轴向缩放一致（list[3] ≈ list[0]）且无旋转分量（list[1]/[2] ≈ 0）才可用；
    // 旋转画布不在本实验支持范围 → 返回 null 退回固定定位
    const ok =
      Number.isFinite(scale) &&
      scale > 0 &&
      Number.isFinite(docOffsetLeft) &&
      Number.isFinite(docOffsetTop) &&
      list.length >= 6 &&
      Math.abs(list[3] - scale) <= 1e-4 * Math.max(1, Math.abs(scale)) &&
      Math.abs(list[1]) <= 1e-4 &&
      Math.abs(list[2]) <= 1e-4;
    if (!ok) {
      if (!logged) {
        logged = true;
        console.warn(
          "[canvasView] viewTransform 结构异常（回退固定定位）",
          JSON.stringify(vtRes),
        );
      }
      return null;
    }

    // viewInfo.activeView.globalBounds：视口的全局屏幕矩形
    const activeView = (viRes.viewInfo as { activeView?: unknown } | undefined)
      ?.activeView as { globalBounds?: unknown } | undefined;
    const gb = activeView?.globalBounds as
      | { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown }
      | undefined;
    const viewport: Rect | null =
      gb &&
      [gb.left, gb.top, gb.right, gb.bottom].every((v) =>
        Number.isFinite(Number(v)),
      ) &&
      Number(gb.right) > Number(gb.left) &&
      Number(gb.bottom) > Number(gb.top)
        ? {
            left: Number(gb.left),
            top: Number(gb.top),
            right: Number(gb.right),
            bottom: Number(gb.bottom),
          }
        : null;
    if (!viewport) {
      if (!logged) {
        logged = true;
        console.warn(
          "[canvasView] viewInfo.globalBounds 结构异常（回退固定定位）",
          JSON.stringify(viRes),
        );
      }
      return null;
    }

    const view: CanvasView = { scale, docOffsetLeft, docOffsetTop, viewport };
    if (!logged) {
      logged = true;
      // 真机校准日志：核对 globalBounds 空间与 UXP 全局空间是否一致
      console.log("[canvasView] 视口", JSON.stringify(view));
    }
    return view;
  } catch (err) {
    console.warn("[canvasView] 读取视口异常（回退固定定位）", err);
    return null;
  }
};
