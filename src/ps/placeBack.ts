import { photoshop, uxp } from "../globals";
import { decodeImageBytes } from "./imageDecode";
import { base64ToBytes } from "./pngDecoder";
import { applyMaskAlpha, resizeRgba } from "./resize";
import {
  composeCanvasMask,
  computePlaceGeometry,
  cropPlane,
  outputSizeNote,
  planOutputFit,
} from "./placeBackGeometry";
import {
  makeLayerMaskDescriptor,
  planMaskCreation,
  selectCompositeChannelDescriptor,
  selectLayerDescriptor,
} from "./placeBackDescriptors";
import { matchDocument, isDocumentOpen, type CaptureIdentity, type DocCandidate } from "./docMatch";
import {
  bumpCounter,
  counterDelta,
  diagBatchPlay,
  diagKey,
  diagLog,
  diffSnapshots,
  ensureDiagSession,
  getCounters,
  isDiagEnabled,
  probeUserMask,
  setDiagCommand,
  snapshotDocuments,
} from "./placeBackDiag";
import type { CaptureResult } from "./capture";
import type { ExpandedRegion } from "./types";
import type { PlaceBackMode } from "../settings/types";
import type { Document } from "photoshop/dom/Document";
import type { Layer } from "photoshop/dom/Layer";

/**
 * 贴回管线（docs/local-redraw-plan.md §5 placing / M2 整块替换 + 蒙版合成）。
 *
 * 流程（纯本地处理 + 最少 PS 命令）：
 * 1. 解码生成图（零依赖解码器，按签名嗅探 PNG / JPEG）；
 * 2. 输出尺寸校验：读取实际宽高，与请求尺寸比较（不一致时 outputMismatch 提示）；
 *    一律按**实际宽高**缩放回抓取区域，禁止用请求尺寸推算几何；
 * 3. Lanczos3 缩回扩展区域尺寸（整块，不裁切）；
 * 4. 补边模式：裁掉扩展区域中画布外的补边，目标坐标平移回画布坐标系；
 * 5. executeAsModal 内按 docId 定位目标文档（不要求它是前台），新建图层 +
 *    imaging.putPixels 写到目标位置（跨文档写入靠 documentID）；
 *    图层蒙版模式再为图层创建真正的（可继续编辑的）蒙版：
 *    - 蒙版按**整个画布尺寸**构建：黑底（区域外隐藏），在扩展区域对应的
 *      文档坐标处写入原选区灰度（非矩形/羽化按原样保留）；
 *    - batchPlay 用经典配方（channel/mask + userMaskEnabled/revealAll）给结果
 *      图层创建**图层蒙版**，再用 imaging.putLayerMask 一次性写入整画布蒙版
 *      （targetBounds 与像素同一文档坐标系）；
 *    - **仅前台**走上面的 make 配方；后台目标**跳过 make**：实测即使 _target
 *      写成 layer → document，只要目标文档不是活动文档，document 父级仍被忽略，
 *      AM 会按 layer id 命中活动文档里的同 id 图层（2026-11-07 日志：B 的
 *      「图层 0」#3 被加了全白蒙版）。后台直接靠 imaging.putLayerMask 的隐式
 *      创建（它是跨文档、按 documentID/layerID 定位的），写完再用
 *      imaging.getLayerMask 回读断言蒙版确实存在，缺失就走降级；
 *      descriptor 层面由 `planMaskCreation` 决定走哪条路；
 *    - 通道收尾分前台/后台：前台保留「选中结果图层 + 切回复合通道 + 重绘」，
 *      后台只选中结果图层、跳过切通道（实测 putLayerMask 不会把后台文档的
 *      活动通道留在蒙版上，且后台 select 通道已知 -32005 不可用）；
 *    - 全程不读写文档选区，用户当前选区不会被改动或丢失。
 *
 * 文档关闭：按 id 找不到时先用「路径 + 画布尺寸」、再用「名称 + 画布尺寸」
 * 做唯一匹配；仍然找不到时把生成结果 PNG 保存到插件 data 目录，返回
 * documentMissing，由 UI 提示用户打开原文档后再贴回（结果不会丢）。
 *
 * 蒙版失败降级：删除半成品图层后按旧「像素蒙版合成」模式重新贴回，
 * 并在结果里带可读提示；全程不留下半成品图层。
 */

export interface PlaceBackInput {
  /** 捕获时的文档 id，贴回时首选按它定位（不要求目标文档是前台）。 */
  docId: number;
  /** 捕获时的文档名 / 路径 / 画布尺寸：id 失效（关闭重开）时做次级匹配。 */
  docName?: string;
  docPath?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  expanded: ExpandedRegion;
  mask: CaptureResult["mask"];
  mode: PlaceBackMode;
  /** 生成图 PNG（base64，无 data: 前缀）。 */
  resultBase64: string;
  /** 请求尺寸（预设模式 = 预设宽高；custom = 换算结果或扩展区域尺寸）。仅用于输出尺寸校验提示。 */
  reqW: number;
  reqH: number;
}

export interface PlaceBackResult {
  /** 未贴回（原文档关闭）时为空串。 */
  layerName: string;
  /** 实际生效的贴回模式（图层蒙版失败时会降级为 mask）。 */
  mode: PlaceBackMode;
  /** 需要提示用户的信息（降级原因）。 */
  note?: string;
  /** 原文档已关闭且无法唯一重绑：结果为 false，需用户打开原文档后再贴回。 */
  documentMissing?: boolean;
  /** documentMissing 时生成结果 PNG 的保存路径（插件 data 目录）。 */
  artifactPath?: string;
  /** 按路径 / 名称重绑成功时的新文档 id（用于写回任务条目）。 */
  reboundDocId?: number;
  /** 目标文档不是前台文档时完成写入。 */
  placedInBackground?: boolean;
  /** 工具实际返回的宽高（与请求尺寸对比，排查尺寸漂移用）。 */
  actualOutputSize?: { width: number; height: number };
  /** 实际输出尺寸与请求尺寸不一致。 */
  outputMismatch?: boolean;
  /** 实际应用的缩放比（抓取区域尺寸 / 实际输出尺寸）。 */
  appliedScale?: { x: number; y: number };
}

/** modal 内 batchPlay 必须同步执行（sync:false 会延迟执行，是 -25920 的根因之一）。 */
const syncBpOptions = {
  synchronousExecution: true,
  dialogOptions: "dontDisplay",
} as const;

/** batchPlay 失败可能不抛异常，而是把 {_obj:"error"} 放进返回数组。 */
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

/** 写入像素到结果图层（imageData 用完立即释放，避免占用有限槽位）。 */
export const writePixels = async (
  docId: number,
  layerId: number,
  pixels: Uint8Array,
  geometry: ReturnType<typeof computePlaceGeometry>,
): Promise<void> => {
  const imaging = photoshop.imaging;
  if (typeof imaging?.createImageDataFromBuffer !== "function") {
    throw new Error("imaging.createImageDataFromBuffer 不可用（需要 PS 24.4+）");
  }
  const imageData = await imaging.createImageDataFromBuffer(pixels, {
    width: geometry.outW,
    height: geometry.outH,
    components: 4,
    colorSpace: "RGB",
    colorProfile: "sRGB IEC61966-2.1",
  });
  try {
    bumpCounter("putPixels", "placeBack.writePixels", {
      documentID: docId,
      layerID: layerId,
      targetBounds: {
        left: geometry.targetLeft,
        top: geometry.targetTop,
        width: geometry.outW,
        height: geometry.outH,
      },
    });
    await imaging.putPixels({
      // 目标文档不是前台时靠它定位；缺失时 imaging 会写到当前激活文档
      documentID: docId,
      layerID: layerId,
      imageData,
      replace: false,
      targetBounds: {
        left: geometry.targetLeft,
        top: geometry.targetTop,
        width: geometry.outW,
        height: geometry.outH,
      },
    });
    diagLog("putPixels 返回", { documentID: docId, layerID: layerId });
  } finally {
    imageData.dispose();
  }
};

/**
 * 蒙版写入后的视图收尾。
 *
 * 实测（docs/probes/probe-composite-baseline.js / probe-put-layer-mask.js）：
 * - 前台文档建蒙版后，活动通道会停在蒙版态，必须切回复合通道；
 * - 后台文档写蒙版后，激活时读到的活动通道本来就是复合通道，不需要切；
 * - 且后台 `select` 通道带 document target 已知 -32005，不能走后台。
 *
 * 因此分两条路径：
 * - 前台：选中结果图层 → 切回复合通道 → 重绘（现有生产行为，已实测有效）；
 * - 后台：只选中结果图层（纯图层操作），跳过切通道与重绘。
 *
 * 全部是尽力而为：任何一步失败都不应该让已经创建好的蒙版回滚。
 * 快速蒙版状态不再保存/恢复——贴回流程从不修改 `quickMaskMode`。
 */
const restoreCompositeView = async (
  doc: Document,
  layerId: number,
  isForeground: boolean,
): Promise<void> => {
  try {
    await diagBatchPlay(
      "收尾 select 结果图层",
      "placeBack.restoreCompositeView.selectLayer",
      // 显式 document 父级：前台虽然恰好是活动文档，也不依赖隐式解析
      [selectLayerDescriptor(layerId, doc.id)],
      syncBpOptions,
    );
    await snapshotDocuments("收尾 select 之后");
  } catch {
    // 忽略：后台选中图层失败不影响像素/蒙版本身
  }

  if (!isForeground) return;

  try {
    assertNoError(
      await diagBatchPlay(
        "恢复复合通道",
        "placeBack.restoreCompositeView.selectChannel",
        [selectCompositeChannelDescriptor(doc.mode)],
        syncBpOptions,
      ),
      "恢复复合通道",
    );
  } catch {
    // 忽略：特殊色彩模式/旧版本不支持时只影响视图，不影响蒙版本身
  }

  try {
    await photoshop.core.redrawDocument({ documentID: doc.id });
  } catch {
    // 忽略：redrawDocument 需要 apiVersion 2
  }
};

/**
 * 给结果图层创建真正的图层蒙版（可在 PS 里继续用画笔编辑）：
 * 1) 仅前台：batchPlay 加一个全白（Reveal All）的**图层**蒙版；
 *    后台跳过（document 父级会被忽略），直接依赖 putLayerMask 的隐式创建；
 * 2) 合成整画布尺寸的灰度蒙版：黑底 + 在扩展区域的位置写入原选区蒙版；
 * 3) imaging.putLayerMask 从文档原点一次写入整张蒙版；
 * 4) 回读 getLayerMask 断言蒙版确实落在目标图层，缺失抛错走降级；
 * 5) 收尾：前台把活动通道切回复合通道并重绘；后台只选中图层。
 * 区域外为纯黑（隐藏），区域内保留选区形状与羽化灰阶。
 */
const applyLayerMask = async (
  doc: Document,
  layerId: number,
  mask: Uint8Array,
  geometry: ReturnType<typeof computePlaceGeometry>,
  canvasWidth: number,
  canvasHeight: number,
): Promise<void> => {
  const imaging = photoshop.imaging;
  if (
    typeof imaging?.putLayerMask !== "function" ||
    typeof imaging?.createImageDataFromBuffer !== "function"
  ) {
    throw new Error("imaging.putLayerMask 不可用（需要 PS 24.4+）");
  }

  // 目标文档是否前台：决定通道收尾走哪条路，也决定是否需要 make
  const isForeground = photoshop.app.activeDocument?.id === doc.id;
  const plan = planMaskCreation(isForeground);
  diagLog("applyLayerMask 开始", {
    docId: doc.id,
    docName: safeDocName(doc),
    layerId,
    isForeground,
    plan,
    activeDocumentId: photoshop.app.activeDocument?.id ?? null,
    counters: getCounters(),
  });

  try {
    // 建蒙版 / 选图层都是 batchPlay：执行前重新确认目标文档还在，
    // 否则 AM 会按 layer id 落到当前活动文档（不同文档 id 会重复）
    assertTargetDocumentOpen(doc.id);
    await snapshotDocuments("make 之前");
    if (plan === "make-then-put") {
      try {
        await diagBatchPlay(
          "select 结果图层（make 前）",
          "placeBack.applyLayerMask.selectLayer",
          [selectLayerDescriptor(layerId, doc.id)],
          syncBpOptions,
        );
      } catch {
        // 选中失败是尽力而为：前台文档就是活动文档，make 不会偏离目标
      }
      const makeDescriptor = makeLayerMaskDescriptor(doc.id, layerId);
      bumpCounter("makeLayerMask", "placeBack.applyLayerMask.make", {
        docId: doc.id,
        layerId,
        descriptor: makeDescriptor,
        // 调用栈标记只在调试开关开启时构建，默认关闭不付出这项开销
        stack: isDiagEnabled() ? new Error().stack : undefined,
      });
      assertNoError(
        await diagBatchPlay(
          "添加图层蒙版 make",
          "placeBack.applyLayerMask.make",
          [makeDescriptor],
          syncBpOptions,
        ),
        "添加图层蒙版",
      );
      await snapshotDocuments("make 之后");
      diagLog("MAKE 前后差异", diffSnapshots("make 之前", "make 之后"));
    } else {
      // 后台绝对不能调 make：document 父级会被忽略，蒙版会落到活动文档里的
      // 同 id 图层（2026-11-07 日志：B 的「图层 0」#3 被加了全白蒙版）。
      diagKey("降级：跳过 make（目标文档非前台）", {
        docId: doc.id,
        layerId,
        activeDocumentId: photoshop.app.activeDocument?.id ?? null,
        reason: "make 忽略 document 父级，会按 layer id 命中活动文档的同 id 图层",
      });
    }

    // putLayerMask 之前的快照必须在分配 maskData 之前：
    // createImageDataFromBuffer 会占用一个 imageData 槽位，getLayerMask 还需要另一个
    await snapshotDocuments("putLayerMask 之前");

    // 整画布黑底 + 区域写入；只分配一次画布缓冲，避免中间拷贝
    const canvasMask = composeCanvasMask(
      canvasWidth,
      canvasHeight,
      mask,
      geometry.outW,
      geometry.outH,
      geometry.targetLeft,
      geometry.targetTop,
    );
    const maskData = await imaging.createImageDataFromBuffer(canvasMask, {
      width: canvasWidth,
      height: canvasHeight,
      components: 1,
      colorSpace: "Grayscale",
      colorProfile: "Gray Gamma 2.2",
    });
    try {
      // putLayerMask 虽带 documentID，仍在写入前确认目标文档存在，避免写空文档对象
      assertTargetDocumentOpen(doc.id);
      bumpCounter("putLayerMask", "placeBack.applyLayerMask.putLayerMask", {
        documentID: doc.id,
        hasDocumentID: doc.id !== undefined && doc.id !== null,
        layerID: layerId,
        kind: "user",
        replace: true,
        targetBounds: { left: 0, top: 0, width: canvasWidth, height: canvasHeight },
      });
      diagLog("putLayerMask 发出", {
        documentID: doc.id,
        layerID: layerId,
        kind: "user",
        replace: true,
        targetBounds: { left: 0, top: 0, width: canvasWidth, height: canvasHeight },
      });
      await imaging.putLayerMask({
        documentID: doc.id,
        layerID: layerId,
        kind: "user",
        replace: true,
        imageData: maskData,
        // 数据已是整画布尺寸，从文档原点写入；与 putPixels 使用同一文档坐标系
        targetBounds: {
          left: 0,
          top: 0,
          width: canvasWidth,
          height: canvasHeight,
        },
      });
      diagLog("putLayerMask 返回", { documentID: doc.id, layerID: layerId });
    } finally {
      // 先释放 imageData 槽位，再读图层蒙版快照（PS 的 imageData 槽位有限）
      await maskData.dispose();
    }
    await snapshotDocuments("putLayerMask 之后");
    diagLog(
      "putLayerMask 前后差异",
      diffSnapshots("putLayerMask 之前", "putLayerMask 之后"),
    );

    // 回读断言：后台跳过 make 后，蒙版只能由 putLayerMask 隐式创建。
    // 确认缺失 → 抛错，由调用方删掉半成品图层并降级为像素蒙版；
    // 读取失败/超时（unknown）无法判断时只记日志，避免误降级。
    const probe = await probeUserMask(doc.id, layerId);
    diagLog("蒙版回读", { documentID: doc.id, layerID: layerId, ...probe });
    if (probe.state === "absent") {
      throw new Error(
        `图层蒙版未落到目标图层（文档 #${doc.id} / 图层 #${layerId}）：putLayerMask 没有创建蒙版`,
      );
    }
  } finally {
    // 成功/失败都要收尾：失败时画布同样可能停在蒙版通道（之后会降级重建图层）
    await restoreCompositeView(doc, layerId, isForeground);
  }
};

/** DOM 属性可能返回 UnitValue 包装对象（{_value, _unit}），统一取数值。 */
const toPx = (value: unknown): number => {
  const raw =
    value && typeof value === "object" && "_value" in (value as { _value?: unknown })
      ? (value as { _value: unknown })._value
      : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/** 删除图层；返回是否成功（失败时调用方需中止，避免留下半成品图层）。 */
const deleteLayer = (layer: Layer): boolean => {
  try {
    layer.delete();
    return true;
  } catch {
    return false;
  }
};

interface UXPFileLike {
  write(data: ArrayBuffer, options?: { format?: unknown }): Promise<void>;
  nativePath?: string;
}

interface UXPFolderLike {
  createFile(name: string, options?: { overwrite?: boolean }): Promise<UXPFileLike>;
  createFolder(name: string): Promise<UXPFolderLike>;
  getEntry(name: string): Promise<unknown>;
}

interface UXPStorageLike {
  localFileSystem: { getDataFolder(): Promise<UXPFolderLike> };
  formats: { binary: symbol };
}

const uxpStorage = (uxp as unknown as { storage?: UXPStorageLike }).storage;

/** 原文档关闭时结果图的落盘目录（位于插件 data 目录下）。 */
const ARTIFACT_FOLDER = "placeback-artifacts";

const ensureArtifactFolder = async (): Promise<UXPFolderLike> => {
  if (!uxpStorage?.localFileSystem || !uxpStorage.formats?.binary) {
    throw new Error("当前宿主不支持 UXP 本地文件系统，无法保存贴回结果");
  }
  const root = await uxpStorage.localFileSystem.getDataFolder();
  try {
    return await root.createFolder(ARTIFACT_FOLDER);
  } catch {
    const existing = await root.getEntry(ARTIFACT_FOLDER);
    return existing as unknown as UXPFolderLike;
  }
};

/**
 * 把生成结果 PNG 存到插件 data 目录，供用户稍后打开原文档再贴回。
 * 返回可供 UI 展示的路径（优先 nativePath）。
 */
export const saveArtifact = async (docId: number, base64: string): Promise<string> => {
  const folder = await ensureArtifactFolder();
  const name = `rocxps-placeback-${docId}-${Date.now()}.png`;
  const file = await folder.createFile(name, { overwrite: true });
  const bytes = base64ToBytes(base64);
  await file.write(bytes.buffer as ArrayBuffer, {
    format: uxpStorage?.formats.binary,
  });
  return file.nativePath ?? name;
};

/** 读取文档名（DOM getter 可能抛错，统一退化为空串）。 */
const safeDocName = (doc: Document | null): string => {
  if (!doc) return "";
  try {
    return typeof doc.name === "string" ? doc.name : "";
  } catch {
    return "";
  }
};

/** 读取文档路径：未保存 / 云文档可能抛错，统一退化为空串。 */
const readDocPath = (doc: Document): string => {
  try {
    const path = doc.path;
    return typeof path === "string" ? path : "";
  } catch {
    return "";
  }
};

/** 收集当前所有打开文档，转成可做匹配的纯数据（同时保留 Document 引用）。 */
const collectDocuments = (): {
  candidates: DocCandidate[];
  byId: Map<number, Document>;
} => {
  const candidates: DocCandidate[] = [];
  const byId = new Map<number, Document>();
  const documents = photoshop.app.documents;
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (!doc) continue;
    byId.set(doc.id, doc);
    candidates.push({
      id: doc.id,
      name: doc.name,
      path: readDocPath(doc),
      width: toPx(doc.width),
      height: toPx(doc.height),
    });
  }
  return { candidates, byId };
};

/** 目标文档在 batchPlay 执行前被关闭：调用方应转「落盘 + 等原文档」，不能落到活动文档。 */
class DocumentClosedError extends Error {
  constructor(docId: number) {
    super(`目标文档 #${docId} 已关闭，已中止贴回`);
    this.name = "DocumentClosedError";
  }
}

/** 每次 batchPlay 前重新读取打开的文档 id（不能缓存在开头的那份快照）。 */
const assertTargetDocumentOpen = (docId: number): void => {
  const { byId } = collectDocuments();
  if (!isDocumentOpen(docId, [...byId.keys()])) {
    throw new DocumentClosedError(docId);
  }
};

export const placeBack = async (input: PlaceBackInput): Promise<PlaceBackResult> => {
  const { expanded, mode } = input;
  const reqW = input.reqW;
  const reqH = input.reqH;
  const geometry = computePlaceGeometry(expanded);

  if (
    input.mask.width !== expanded.width ||
    input.mask.height !== expanded.height
  ) {
    throw new Error("蒙版尺寸与扩展区域不符，无法贴回");
  }

  // 1) 解码生成图（按签名嗅探 PNG / JPEG；Seedream 4.x 固定返回 JPEG）
  const decoded = decodeImageBytes(input.resultBase64);

  // 2) 输出尺寸校验：记录实际宽高与 appliedScale；尺寸不一致只提示，不改几何口径
  const fit = planOutputFit(
    decoded.width,
    decoded.height,
    reqW,
    reqH,
    expanded.width,
    expanded.height,
  );
  const sizeNote = outputSizeNote(fit, reqW, reqH);

  // 3) 整块缩放到扩展区域尺寸（按实际宽高，不按请求尺寸）
  const src = decoded.rgba;
  const srcW = decoded.width;
  const srcH = decoded.height;
  const scaled =
    srcW === expanded.width && srcH === expanded.height
      ? src
      : resizeRgba(src, srcW, srcH, expanded.width, expanded.height);

  // 4) 补边裁剪：像素与蒙版使用同一裁剪几何，保证蒙版与图层对齐
  const croppedPixels = cropPlane(
    scaled,
    4,
    expanded.width,
    geometry.srcLeft,
    geometry.srcTop,
    geometry.outW,
    geometry.outH,
  );
  const croppedMask = cropPlane(
    input.mask.data,
    1,
    expanded.width,
    geometry.srcLeft,
    geometry.srcTop,
    geometry.outW,
    geometry.outH,
  );

  // 像素蒙版合成的降级素材（整块替换不需要，避免无谓的整图遍历）
  const maskedPixels =
    mode === "block" ? croppedPixels : applyMaskAlpha(croppedPixels, croppedMask);

  // 5) 贴回：新建图层 + putPixels（modal 内串行）
  ensureDiagSession();
  setDiagCommand("AI 局部重绘：贴回结果");
  const baselineCounters = getCounters();
  diagLog("贴回开始", {
    commandName: "AI 局部重绘：贴回结果",
    inputDocId: input.docId,
    inputDocName: input.docName,
    inputDocPath: input.docPath,
    mode,
    reqW,
    reqH,
    activeDocumentId: photoshop.app.activeDocument?.id ?? null,
    activeDocumentName: safeDocName(photoshop.app.activeDocument ?? null),
    documents: collectDocuments().candidates,
  });
  const result: PlaceBackResult = await photoshop.core.executeAsModal(
    async () => {
      // 贴回开始时的全文档蒙版快照（make 前后对比的基线）
      await snapshotDocuments("贴回开始");
      // 目标文档按 id 定位，不要求它是前台；关闭重开后按路径/名称 + 尺寸唯一匹配
      const { candidates, byId } = collectDocuments();
      const identity: CaptureIdentity = {
        docId: input.docId,
        docName: input.docName,
        docPath: input.docPath,
        canvasWidth: input.canvasWidth,
        canvasHeight: input.canvasHeight,
      };
      const match = matchDocument(candidates, identity);

      /** 原文档不可用时的统一出口：结果落盘，绝不把写入落到活动文档。 */
      const artifactResult = async (
        reason: "missing" | "ambiguous" | "closed",
      ): Promise<PlaceBackResult> => {
        let artifactPath: string | undefined;
        let saveError: string | undefined;
        try {
          artifactPath = await saveArtifact(input.docId, input.resultBase64);
        } catch (e) {
          saveError = e instanceof Error ? e.message : String(e);
        }
        const head =
          reason === "ambiguous"
            ? `找到 ${match.candidates.length} 个同路径/同尺寸的文档，无法确定贴回目标`
            : reason === "closed"
              ? "原文档在贴回过程中被关闭"
              : "原文档已关闭";
        const tail = artifactPath
          ? "结果已保存，可在 UI 中重新贴回"
          : saveError
            ? `结果保存失败（${saveError}）；可打开原文档后重试`
            : "结果保存失败，可打开原文档后重试";
        diagKey("等原文档：结果已落盘", { reason, artifactPath, saveError });
        return {
          layerName: "",
          mode,
          documentMissing: true,
          artifactPath,
          actualOutputSize: { width: fit.actualW, height: fit.actualH },
          outputMismatch: fit.outputMismatch,
          appliedScale: fit.appliedScale,
          note: [`${head}；${tail}`, sizeNote].filter(Boolean).join("；"),
        } satisfies PlaceBackResult;
      };

      if (!match.docId) {
        return artifactResult(
          match.candidates.length > 1 ? "ambiguous" : "missing",
        );
      }

      const doc = byId.get(match.docId);
      if (!doc) {
        return artifactResult("closed");
      }
      const isForeground = photoshop.app.activeDocument?.id === doc.id;
      const reboundDocId = match.kind === "id" ? undefined : doc.id;

      const canvasWidth = toPx(doc.width);
      const canvasHeight = toPx(doc.height);
      if (canvasWidth <= 0 || canvasHeight <= 0) {
        throw new Error("无法读取画布尺寸（doc.width/height 异常）");
      }

      // 创建图层前再确认一次：文档可能在匹配后、弹窗/异步操作期间被关闭
      if (!isDocumentOpen(doc.id, [...collectDocuments().byId.keys()])) {
        return artifactResult("closed");
      }

      const createLayer = async (): Promise<Layer> => {
        const layer = await doc.createLayer(
          photoshop.constants.LayerKind.NORMAL,
          { name: "AI 局部重绘" },
        );
        if (!layer) throw new Error("创建结果图层失败");
        diagLog("结果图层已创建", {
          docId: doc.id,
          layerId: layer.id,
          layerName: layer.name,
          isForeground,
        });
        return layer;
      };

      // 整块贴：图层蒙版模式保留选区外像素（由蒙版隐藏），其余模式按需合成
      const primary = mode === "mask" ? maskedPixels : croppedPixels;

      let layer = await createLayer();
      try {
        await writePixels(doc.id, layer.id, primary, geometry);
      } catch (e) {
        deleteLayer(layer);
        throw e;
      }

      const resultBase = {
        layerName: layer.name,
        mode,
        reboundDocId,
        placedInBackground: !isForeground,
        actualOutputSize: { width: fit.actualW, height: fit.actualH },
        outputMismatch: fit.outputMismatch,
        appliedScale: fit.appliedScale,
        note: sizeNote,
      };

      if (mode !== "layerMask") {
        return resultBase satisfies PlaceBackResult;
      }

      try {
        await applyLayerMask(
          doc,
          layer.id,
          croppedMask,
          geometry,
          canvasWidth,
          canvasHeight,
        );
        return resultBase satisfies PlaceBackResult;
      } catch (maskError) {
        // 目标文档在执行 batchPlay 前/期间被关闭：没有可清理的图层，直接落盘等原文档
        if (maskError instanceof DocumentClosedError) {
          return artifactResult("closed");
        }
        const reason =
          maskError instanceof Error ? maskError.message : String(maskError);
        // 先清理半成品图层；清不掉就中止，避免用户看到“有蒙版但可编辑性未知”的图层
        if (!deleteLayer(layer)) {
          throw new Error(
            `图层蒙版创建失败（${reason}），且无法清理半成品图层，请手动删除「AI 局部重绘」图层后重试`,
          );
        }
        try {
          layer = await createLayer();
          await writePixels(doc.id, layer.id, maskedPixels, geometry);
        } catch (fallbackError) {
          const fallbackMsg =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          throw new Error(
            `图层蒙版创建失败（${reason}），降级为像素蒙版合成也失败：${fallbackMsg}`,
          );
        }
        return {
          layerName: layer.name,
          mode: "mask",
          reboundDocId,
          placedInBackground: !isForeground,
          actualOutputSize: { width: fit.actualW, height: fit.actualH },
          outputMismatch: fit.outputMismatch,
          appliedScale: fit.appliedScale,
          note: [
            `图层蒙版创建失败，已降级为像素蒙版合成：${reason}`,
            sizeNote,
          ]
            .filter(Boolean)
            .join("；"),
        } satisfies PlaceBackResult;
      }
    },
    { commandName: "AI 局部重绘：贴回结果" },
  );
  const delta = counterDelta(baselineCounters);
  // 关键小结始终保留（默认关闭诊断时也能看到贴回模式与是否等原文档）
  diagKey("本次贴回小结", {
    makeCallsThisRun: delta.makeLayerMask,
    countersDelta: delta,
    result: {
      layerName: result.layerName,
      mode: result.mode,
      documentMissing: result.documentMissing,
      placedInBackground: result.placedInBackground,
      note: result.note,
    },
  });
  diagLog("本次贴回小结", {
    makeCallsThisRun: delta.makeLayerMask,
    countersDelta: delta,
    totalCounters: getCounters(),
    masksDiff: diffSnapshots("贴回开始", "putLayerMask 之后")
      ?? diffSnapshots("贴回开始", "收尾 select 之后"),
    result: {
      layerName: result.layerName,
      mode: result.mode,
      documentMissing: result.documentMissing,
      placedInBackground: result.placedInBackground,
      note: result.note,
    },
  });
  return result;
};
