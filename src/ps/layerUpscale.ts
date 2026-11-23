import { photoshop, uxp } from "../globals";
import { siliconUpscale } from "../core/silicontrol";
import {
  planContentUpscale,
  type ContentUpscalePlan,
} from "../core/upscalePlan";
import { bytesToBase64 } from "../providers/http";
import { uint8ToBase64 } from "./base64";
import { padToSize, readLayerRgba } from "./capture";
import { decodeImageBytes } from "./imageDecode";
import { encodePng } from "./pngEncoder";
import { readSmartObjectContent } from "./smartObject";
import type { Rect } from "./types";
import type { Document } from "photoshop/dom/Document";
import type { Layer } from "photoshop/dom/Layer";

/**
 * 图层超分（SeedVR2 3B）—— 选中图层 → 超分 → 以智能对象贴回原位置：
 *
 * 1. 取图层**原始分辨率**：智能对象读内容文档（100% 像素），普通图层只能取
 *    画布上的显示像素（PS 里的放大已烘焙进像素）；
 * 2. 原始 PNG 编码后写入插件 data 目录的临时目录；
 * 3. `silicontrol upscale source.png upscaled.png --long-side N`
 *    （FILE 形式不启动 App、不经过渲染队列，helper 在本机跑完）；
 * 4. executeAsModal 内 placeEvent 置入结果（智能对象承载，像素 ×倍率）；
 * 5. 把置入图层缩放到原图层外接矩形并平移对齐 → 视觉位置 / 比例不变；
 * 6. 原图层保留并隐藏，结果图层命名「原名·超分」。
 *
 * 目标长边 N 是结果内容的真实像素长边；PS 里的放大倍率只用于提示覆盖度。
 *
 * 限制：文本 / 形状 / 智能对象等非像素图层只能取渲染像素，结果不可再按原类型编辑；
 * 带旋转的图层按外接矩形对齐（旋转角不保留）。UI 会在结果里提示。
 */

interface UXPEntryLike {
  nativePath: string;
  delete?(): Promise<void>;
}

interface UXPFileLike extends UXPEntryLike {
  write(
    data: string | ArrayBuffer,
    options?: { format?: symbol; append?: boolean },
  ): Promise<unknown>;
  read(options?: { format?: symbol }): Promise<string | ArrayBuffer>;
}

interface UXPFolderLike extends UXPEntryLike {
  createFile(
    name: string,
    options?: { overwrite?: boolean },
  ): Promise<UXPFileLike>;
  createFolder(name: string): Promise<UXPFolderLike>;
  getEntry(name: string): Promise<UXPFileLike | undefined>;
}

interface UXPStorageLike {
  localFileSystem: {
    getDataFolder(): Promise<UXPFolderLike>;
    createSessionToken(entry: UXPFolderLike | UXPFileLike): string;
  };
  formats: { binary: symbol };
}

const storage = (uxp as unknown as { storage?: UXPStorageLike }).storage;

const syncBpOptions = {
  synchronousExecution: true,
  dialogOptions: "dontDisplay",
} as const;

const assertNoError = (
  results: readonly unknown[] | undefined,
  name: string,
) => {
  for (const r of results ?? []) {
    if (r && typeof r === "object" && (r as { _obj?: string })._obj === "error") {
      const { message, result } = r as { message?: string; result?: number };
      throw new Error(
        `${name} 失败：${message ?? "未知错误"}${result !== undefined ? `（代码 ${result}）` : ""}`,
      );
    }
  }
};

/** DOM 的 bounds / 画布尺寸可能是 UnitValue 包装对象（{_value, _unit}）。 */
const toPx = (value: unknown): number => {
  const raw =
    value && typeof value === "object" && "_value" in (value as { _value?: unknown })
      ? (value as { _value: unknown })._value
      : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

const boundsOf = (layer: Layer): Rect => {
  const b = layer.bounds as unknown as {
    left: unknown;
    top: unknown;
    right: unknown;
    bottom: unknown;
  };
  return {
    left: toPx(b.left),
    top: toPx(b.top),
    right: toPx(b.right),
    bottom: toPx(b.bottom),
  };
};

/** 图层外接矩形的整数像素版本（floor/ceil，保证与读取的像素尺寸一致）。 */
const pixelBoundsOf = (layer: Layer): Rect => {
  const b = boundsOf(layer);
  return {
    left: Math.floor(b.left),
    top: Math.floor(b.top),
    right: Math.ceil(b.right),
    bottom: Math.ceil(b.bottom),
  };
};

const deleteBestEffort = async (entry?: UXPEntryLike | null) => {
  try {
    await entry?.delete?.();
  } catch {
    /* 临时文件清理失败不影响主流程 */
  }
};

const createWorkspace = async (): Promise<UXPFolderLike> => {
  if (!storage?.localFileSystem?.createSessionToken || !storage.formats?.binary) {
    throw new Error(
      "当前宿主不支持 UXP 本地文件系统，无法执行图层超分（需要 Photoshop 24.2+）",
    );
  }
  const root = await storage.localFileSystem.getDataFolder();
  const name = `upscale-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return root.createFolder(name);
};

const writeBinary = async (
  folder: UXPFolderLike,
  name: string,
  bytes: Uint8Array,
): Promise<UXPFileLike> => {
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(bytes.buffer as ArrayBuffer, {
    format: storage!.formats.binary,
  });
  return file;
};

const readBinary = async (file: UXPFileLike): Promise<Uint8Array> => {
  const data = await file.read({ format: storage!.formats.binary });
  if (typeof data === "string") {
    throw new Error("读取超分结果失败：返回的不是二进制数据");
  }
  return new Uint8Array(data);
};

export interface LayerUpscaleResult {
  docName: string;
  originalLayerName: string;
  resultLayerName: string;
  /** 送超分的像素尺寸（智能对象 = 原始分辨率；普通图层 = 显示尺寸）。 */
  sourceSize: { width: number; height: number };
  /** 实际超分输出尺寸（读回结果文件校验）。 */
  targetSize: { width: number; height: number };
  /** 贴回后的显示尺寸（原图层外接矩形）。 */
  displaySize: { width: number; height: number };
  plan: ContentUpscalePlan;
  /** 结果与原图层不完全一致时的提示（非像素图层 / 尺寸漂移等）。 */
  note?: string;
}

export interface LayerUpscaleOptions {
  /** silicontrol 路径。 */
  cliPath: string;
  /** 目标长边（px）。 */
  longSide: number;
  /** 阶段文案回调（UI 展示「正在做什么」）。 */
  onStage?: (text: string) => void;
  /** silicontrol 超时（默认 20 分钟）。 */
  timeoutMs?: number;
}

/** 无文档 / 无选中图层 / 图层组 / 空图层时抛错（中文，可直接展示）。 */
const resolveLayer = (): { doc: Document; layer: Layer; bounds: Rect } => {
  let doc: Document | null = null;
  try {
    doc = photoshop.app.activeDocument ?? null;
  } catch {
    doc = null;
  }
  if (!doc) throw new Error("请先打开一个文档");
  const layer = doc.activeLayers?.[0];
  if (!layer) throw new Error("请先在图层面板中选择一个图层");
  if (layer.kind === photoshop.constants.LayerKind.GROUP) {
    throw new Error("图层组不支持超分，请选择组内的具体图层");
  }
  const bounds = pixelBoundsOf(layer);
  const w = bounds.right - bounds.left;
  const h = bounds.bottom - bounds.top;
  if (!(w > 0) || !(h > 0)) {
    throw new Error("所选图层没有可读取的像素（可能是空图层或调整图层）");
  }
  return { doc, layer, bounds };
};

/** 重叠区域：getPixels 只接受画布内坐标，画布外部分补透明。 */
const clipToCanvas = (
  bounds: Rect,
  canvasW: number,
  canvasH: number,
): Rect => ({
  left: Math.max(0, bounds.left),
  top: Math.max(0, bounds.top),
  right: Math.min(canvasW, bounds.right),
  bottom: Math.min(canvasH, bounds.bottom),
});

/** 读取选中图层像素；画布外的部分补零（透明）。 */
const readPixels = async (
  doc: Document,
  layer: Layer,
  bounds: Rect,
): Promise<Uint8Array> => {
  const canvasW = Math.round(toPx(doc.width));
  const canvasH = Math.round(toPx(doc.height));
  const readBounds = clipToCanvas(bounds, canvasW, canvasH);
  const readW = readBounds.right - readBounds.left;
  const readH = readBounds.bottom - readBounds.top;
  if (!(readW > 0) || !(readH > 0)) {
    throw new Error("所选图层在画布内没有可见像素");
  }
  const rgba = await readLayerRgba(doc, layer.id, readBounds);
  if (!rgba) {
    throw new Error("无法读取图层像素（仅支持 RGB 文档，需要 Photoshop 24.4+）");
  }
  const w = bounds.right - bounds.left;
  const h = bounds.bottom - bounds.top;
  if (readW === w && readH === h) return rgba;
  return padToSize(
    rgba,
    readW,
    readH,
    w,
    h,
    readBounds.left - bounds.left,
    readBounds.top - bounds.top,
    4,
  );
};

/** 超分输入：原始分辨率像素 + 规划 + 需要告诉用户的提示。 */
interface UpscaleSource {
  /** 送超分的 RGBA 像素。 */
  rgba: Uint8Array;
  /** 送超分的像素尺寸（智能对象 = 原始分辨率）。 */
  width: number;
  height: number;
  /** 贴回目标：图层当前显示外接矩形。 */
  bounds: Rect;
  plan: ContentUpscalePlan;
  notes: string[];
}

/**
 * 取超分输入：
 * - 智能对象 → 内容文档的 100% 原始像素（PS 的缩放是非破坏性的，能拿回真实分辨率）；
 * - 其他图层 → 画布上的显示像素（PS 放大已烘焙，无法取回原始分辨率）。
 */
const prepareSource = async (
  doc: Document,
  layer: Layer,
  bounds: Rect,
  longSide: number,
  stage: (text: string) => void,
): Promise<UpscaleSource> => {
  const displayW = bounds.right - bounds.left;
  const displayH = bounds.bottom - bounds.top;
  const notes: string[] = [];
  const isSmartObject =
    layer.kind === photoshop.constants.LayerKind.SMARTOBJECT;

  if (isSmartObject) {
    stage("读取图层原始分辨率");
    try {
      const content = await readSmartObjectContent(doc, layer);
      const plan = planContentUpscale(
        content.width,
        content.height,
        displayW,
        displayH,
        longSide,
      );
      if (content.reusedDocument) {
        notes.push("智能对象的内容文档原本已打开，本次未关闭");
      }
      return {
        rgba: content.rgba,
        width: content.width,
        height: content.height,
        bounds,
        plan,
        notes,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(
        `未能读取智能对象原始分辨率（${msg}），已按当前显示像素超分`,
      );
    }
  }

  stage("读取图层像素");
  // imaging.getPixels 属于访问 Photoshop 状态的 API，官方要求必须在
  // executeAsModal 的 modal scope 内调用，否则抛
  // "The requested functionality is only allowed from inside a modal scope"。
  const rgba = await photoshop.core.executeAsModal(
    () => readPixels(doc, layer, bounds),
    { commandName: "图层超分：读取图层像素" },
  );
  const plan = planContentUpscale(displayW, displayH, displayW, displayH, longSide);
  if (!isSmartObject) {
    notes.push(
      "普通像素图层：PS 中的放大已烘焙进像素，无法取回原始分辨率；如需按原始分辨率超分，请把图像作为智能对象置入",
    );
  }
  return { rgba, width: displayW, height: displayH, bounds, plan, notes };
};

const placeDescriptor = (token: string) => ({
  _obj: "placeEvent",
  null: { _path: token, _kind: "local" },
  freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
  offset: {
    _obj: "offset",
    horizontal: { _unit: "pixelsUnit", _value: 0 },
    vertical: { _unit: "pixelsUnit", _value: 0 },
  },
  _options: { dialogOptions: "dontDisplay" },
});

/**
 * 超分当前选中的图层，并把结果以智能对象贴回原位置。
 * 原图层保留并隐藏（可随时手动恢复）。
 */
export const upscaleActiveLayer = async (
  options: LayerUpscaleOptions,
): Promise<LayerUpscaleResult> => {
  const stage = (text: string) => options.onStage?.(text);
  const { doc, layer, bounds } = resolveLayer();
  const source = await prepareSource(
    doc,
    layer,
    bounds,
    options.longSide,
    stage,
  );
  const plan = source.plan;
  const noteParts: string[] = [...source.notes];

  const pngBytes = encodePng(source.width, source.height, source.rgba);

  const folder = await createWorkspace();
  let resultFile: UXPFileLike | null = null;
  try {
    const srcFile = await writeBinary(folder, "source.png", pngBytes);
    const destPath = `${folder.nativePath}/upscaled.png`;

    stage("超分中（SeedVR2 3B）");
    await siliconUpscale(
      options.cliPath,
      srcFile.nativePath,
      destPath,
      plan.longSide,
      options.timeoutMs,
    );

    stage("读取超分结果");
    const entry = await folder
      .getEntry("upscaled.png")
      .catch(() => undefined);
    if (!entry) {
      throw new Error("超分命令已结束，但临时目录里找不到结果文件");
    }
    resultFile = entry;
    const bytes = await readBinary(entry);
    const decoded = decodeImageBytes(bytesToBase64(bytes));
    const actual = { width: decoded.width, height: decoded.height };
    if (
      actual.width !== plan.width ||
      actual.height !== plan.height
    ) {
      noteParts.push(
        `超分结果尺寸 ${actual.width}×${actual.height} 与预期 ${plan.width}×${plan.height} 不同，已按原边界拉伸`,
      );
    }

    stage("置入并贴回");
    const token = storage!.localFileSystem.createSessionToken(entry);
    const layerName = `${layer.name}·超分`;
    await photoshop.core.executeAsModal(
      async () => {
        if (photoshop.app.activeDocument?.id !== doc.id) {
          photoshop.app.activeDocument = doc;
        }
        assertNoError(
          await photoshop.action.batchPlay(
            [placeDescriptor(token)] as never,
            syncBpOptions as never,
          ),
          "置入超分结果",
        );
        const placed = doc.activeLayers?.[0];
        if (!placed || placed.id === layer.id) {
          throw new Error("置入后找不到超分结果图层");
        }

        const targetW = bounds.right - bounds.left;
        const targetH = bounds.bottom - bounds.top;
        const placedBounds = boundsOf(placed);
        const placedW = placedBounds.right - placedBounds.left;
        const placedH = placedBounds.bottom - placedBounds.top;
        if (placedW <= 0 || placedH <= 0) {
          throw new Error("置入的超分图层没有有效尺寸");
        }
        if (
          Math.abs(placedW - targetW) > 0.5 ||
          Math.abs(placedH - targetH) > 0.5
        ) {
          await placed.scale(
            (targetW / placedW) * 100,
            (targetH / placedH) * 100,
            photoshop.constants.AnchorPosition.MIDDLECENTER,
            { interpolation: photoshop.constants.InterpolationMethod.BICUBIC },
          );
          const scaled = boundsOf(placed);
          const dx = bounds.left - scaled.left;
          const dy = bounds.top - scaled.top;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            await placed.translate(dx, dy);
          }
        }
        placed.name = layerName;
        layer.visible = false;
      },
      { commandName: "图层超分：置入并贴回" },
    );

    if (
      layer.kind !== photoshop.constants.LayerKind.NORMAL &&
      layer.kind !== photoshop.constants.LayerKind.SMARTOBJECT
    ) {
      noteParts.push(
        "原图层不是普通像素图层，已按渲染像素超分；结果智能对象不能还原为原图层类型",
      );
    }
    if (plan.belowDisplay) {
      const displayLong = Math.max(
        plan.displaySize.width,
        plan.displaySize.height,
      );
      noteParts.push(
        `目标长边 ${plan.longSide} 小于当前显示长边 ${displayLong}，贴回后显示时仍会被放大 ${(displayLong / plan.longSide).toFixed(2)} 倍；建议填 ≥ ${displayLong}`,
      );
    }
    if (plan.nonUniform) {
      noteParts.push(
        "图层在 PS 中被非等比缩放（或带旋转/变形），贴回按外接矩形拉伸",
      );
    }
    if (plan.scale > 8) {
      noteParts.push(`超分倍率 ${plan.scale.toFixed(1)}× 偏大，细节可能不足`);
    }

    return {
      docName: doc.name,
      originalLayerName: layer.name,
      resultLayerName: layerName,
      sourceSize: { width: source.width, height: source.height },
      targetSize: actual,
      displaySize: plan.displaySize,
      plan,
      ...(noteParts.length > 0 ? { note: noteParts.join("；") } : {}),
    };
  } finally {
    await deleteBestEffort(resultFile);
    await deleteBestEffort(folder);
  }
};
