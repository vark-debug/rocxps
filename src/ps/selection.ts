import { photoshop } from "../globals";
import type { Rect } from "./types";

// 纯函数拆分到 geometry.ts（可被 Node 单测直接打包），此处统一再导出
export {
  expandRectToMultiple,
  expandRectToAspect,
  padAmountsOf,
  assertAligned,
} from "./geometry";

export interface SelectionInfo {
  /** 选区外接矩形（非矩形选区为其包围盒）。 */
  bounds: Rect;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * 单位字段可能是数字，也可能是 UnitValue 包装对象：
 * - DOM 属性（doc.width 等）：{_unit, _value}
 * - batchPlay 字段：{_unit, _value} 或数字
 * 统一取数值（此前只认 "value" 键，UnitValue 会返回 NaN）。
 */
const unwrapUnit = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    const o = v as { _value?: unknown; value?: unknown };
    const raw = "_value" in o ? o._value : "value" in o ? o.value : undefined;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
};

const toRect = (
  raw:
    | {
        left?: unknown;
        top?: unknown;
        right?: unknown;
        bottom?: unknown;
      }
    | null
    | undefined,
): Rect | null => {
  if (!raw) return null;
  const left = unwrapUnit(raw.left);
  const top = unwrapUnit(raw.top);
  const right = unwrapUnit(raw.right);
  const bottom = unwrapUnit(raw.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { left, top, right, bottom };
};

/**
 * 读取活动文档的选区外接矩形与画布尺寸。
 * 优先 PS DOM（selection.bounds，无选区为 null），
 * 异常时回退 batchPlay get selection + UnitValue 解包
 * （modal 内 batchPlay 必须 sync:true：sync:false 会延迟执行、永不返回）。
 * 无打开文档抛错；无选区返回 null。
 */
export const readSelection = async (): Promise<SelectionInfo | null> => {
  const doc = photoshop.app.activeDocument;
  if (!doc) {
    throw new Error("请先打开一个文档");
  }

  // 画布尺寸：doc.width/height 在部分版本返回 UnitValue 包装对象，
  // 直接用于数值运算会得到 NaN（参考项目 L241-243 踩坑）
  const canvasWidth = unwrapUnit(doc.width);
  const canvasHeight = unwrapUnit(doc.height);
  if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight)) {
    throw new Error("无法读取画布尺寸（doc.width/height 异常）");
  }

  const info = (bounds: Rect): SelectionInfo => ({
    bounds,
    canvasWidth,
    canvasHeight,
  });

  // 1. PS DOM 优先
  try {
    const rect = toRect(doc.selection.bounds);
    if (rect) return info(rect);
  } catch {
    // 部分版本无选区时抛错而非返回 null → 继续兜底
  }

  // 2. batchPlay 兜底（sync:true）
  const result = await photoshop.action.batchPlay(
    [
      {
        _obj: "get",
        _target: [
          { _property: "selection" },
          { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
        ],
      },
    ],
    { synchronousExecution: true, dialogOptions: "dontDisplay" },
  );
  const first = result?.[0];
  if (
    first &&
    typeof first === "object" &&
    (first as { _obj?: string })._obj === "error"
  ) {
    const message = (first as { message?: string }).message;
    throw new Error(`读取选区失败：${message ?? "未知错误"}`);
  }
  const rect = toRect(
    (first as { selection?: unknown } | undefined)?.selection as
      | { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown }
      | null
      | undefined,
  );
  if (!rect) return null;
  return info(rect);
};
