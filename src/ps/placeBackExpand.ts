import { photoshop } from "../globals";
import { decodeImageBytes } from "./imageDecode";
import { parseComponentDepth } from "./bitDepth";
import { resizeRgba } from "./resize";
import {
  computeExpandPlaceGeometry,
  cropPlane,
  outputSizeNote,
  planOutputFit,
} from "./placeBackGeometry";
import { matchDocument, type CaptureIdentity, type DocCandidate } from "./docMatch";
import {
  saveArtifact,
  writePixels,
  type PlaceBackResult,
} from "./placeBack";
import type { PadPercent } from "./expandPlan";
import type { Rect } from "./types";
import type { Document } from "photoshop/dom/Document";
import type { Layer } from "photoshop/dom/Layer";

/**
 * 阔图 / 扩图贴回（独立于 placeBack 的蒙版管线）。
 *
 * expand 结果 = 源图 + 四边生成内容，覆盖整张逻辑输出画布（源图按 pad 外推），
 * 因此没有蒙版、没有补边裁剪（只有画布越界裁剪），也无须图层蒙版与通道恢复
 * ——不经过 putLayerMask，后台贴回天然可用（putPixels 按 documentID 定位）。
 *
 * 贴回几何（computeExpandPlaceGeometry）：
 * - 目标位置 = 源图包围盒按 pad 反向外推，保证源图区域与画布内原位置严格对齐；
 * - 结果越出画布的部分裁掉（超 200% 截断 / 画布比逻辑画布小时）；
 * - CLI 返回尺寸与请求尺寸有舍入差（16/32 对齐）：按实际宽高缩放到逻辑画布，
 *   outputMismatch 机制沿用选区流程的口径。
 *
 * 文档关闭：复用 placeBack 的 documentMissing 语义，结果落盘到插件 data 目录。
 */

/** DOM 属性可能返回 UnitValue 包装对象（{_value, _unit}），统一取数值。 */
const toPx = (value: unknown): number => {
  const raw =
    value && typeof value === "object" && "_value" in (value as { _value?: unknown })
      ? (value as { _value: unknown })._value
      : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/** 收集当前打开文档，转成可做匹配的纯数据（matchDocument 用）。 */
const collectCandidates = (): DocCandidate[] => {
  const candidates: DocCandidate[] = [];
  const documents = photoshop.app.documents;
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (!doc) continue;
    let path = "";
    try {
      path = typeof doc.path === "string" ? doc.path : "";
    } catch {
      /* 未保存文档路径读取抛错，退化为空串 */
    }
    candidates.push({
      id: doc.id,
      name: doc.name,
      path,
      width: toPx(doc.width),
      height: toPx(doc.height),
    });
  }
  return candidates;
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

export interface PlaceBackExpandInput {
  /** 捕获时的文档 id，贴回时首选按它定位（不要求目标文档是前台）。 */
  docId: number;
  docName?: string;
  docPath?: string;
  /** 捕获时的画布尺寸（= 用户外扩后的目标尺寸），id 失效时做次级匹配。 */
  canvasWidth?: number;
  canvasHeight?: number;
  /** 源图包围盒（画布坐标，= 队列的 originalBounds）。 */
  source: Rect;
  /** 四边 pad 百分比（clamp 后）。 */
  pads: PadPercent;
  /** 生成结果 PNG（base64，无 data: 前缀）。 */
  resultBase64: string;
  /** 请求尺寸（= 逻辑输出画布），仅用于 outputMismatch 提示。 */
  reqW: number;
  reqH: number;
}

export const placeBackExpand = async (
  input: PlaceBackExpandInput,
): Promise<PlaceBackResult> => {
  if (input.canvasWidth === undefined || input.canvasHeight === undefined) {
    throw new Error("阔图贴回缺少画布尺寸（队列元数据缺失），请重新抓取");
  }
  const canvasW = input.canvasWidth;
  const canvasH = input.canvasHeight;
  const geometry = computeExpandPlaceGeometry(canvasW, canvasH, input.source, input.pads);

  // 1) 解码生成图（按签名嗅探 PNG / JPEG）
  const decoded = decodeImageBytes(input.resultBase64);

  // 2) 输出尺寸校验：按实际宽高缩放到逻辑画布，禁止按请求尺寸推算几何
  const fit = planOutputFit(
    decoded.width,
    decoded.height,
    input.reqW,
    input.reqH,
    geometry.logicalWidth,
    geometry.logicalHeight,
  );
  const sizeNote = outputSizeNote(fit, input.reqW, input.reqH);

  // 3) 缩放到逻辑画布尺寸，再裁掉画布越界部分
  const scaled =
    decoded.width === geometry.logicalWidth && decoded.height === geometry.logicalHeight
      ? decoded.rgba
      : resizeRgba(
          decoded.rgba,
          decoded.width,
          decoded.height,
          geometry.logicalWidth,
          geometry.logicalHeight,
        );
  const cropped = cropPlane(
    scaled,
    4,
    geometry.logicalWidth,
    geometry.srcLeft,
    geometry.srcTop,
    geometry.outW,
    geometry.outH,
  );

  const result: PlaceBackResult = await photoshop.core.executeAsModal(
    async () => {
      const identity: CaptureIdentity = {
        docId: input.docId,
        docName: input.docName,
        docPath: input.docPath,
        canvasWidth: input.canvasWidth,
        canvasHeight: input.canvasHeight,
      };
      const candidates = collectCandidates();
      const match = matchDocument(candidates, identity);

      /** 原文档不可用时的统一出口：结果落盘，绝不把写入落到活动文档。 */
      const artifactResult = async (
        reason: "missing" | "ambiguous",
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
            : "原文档已关闭";
        const tail = artifactPath
          ? "结果已保存，可在 UI 中重新贴回"
          : saveError
            ? `结果保存失败（${saveError}）；可打开原文档后重试`
            : "结果保存失败，可打开原文档后重试";
        return {
          layerName: "",
          mode: "block",
          documentMissing: true,
          artifactPath,
          actualOutputSize: { width: fit.actualW, height: fit.actualH },
          outputMismatch: fit.outputMismatch,
          appliedScale: fit.appliedScale,
          note: [`${head}；${tail}`, sizeNote].filter(Boolean).join("；"),
        } satisfies PlaceBackResult;
      };

      if (!match.docId) {
        return artifactResult(match.candidates.length > 1 ? "ambiguous" : "missing");
      }
      const doc = (() => {
        for (let i = 0; i < photoshop.app.documents.length; i++) {
          const d = photoshop.app.documents[i];
          if (d?.id === match.docId) return d as Document;
        }
        return undefined;
      })();
      if (!doc) return artifactResult("missing");

      const isForeground = photoshop.app.activeDocument?.id === doc.id;
      const reboundDocId = match.kind === "id" ? undefined : doc.id;

      // 创建图层前再确认一次：文档可能在匹配后、异步操作期间被关闭
      let stillOpen = false;
      for (let i = 0; i < photoshop.app.documents.length; i++) {
        if (photoshop.app.documents[i]?.id === doc.id) {
          stillOpen = true;
          break;
        }
      }
      if (!stillOpen) {
        return artifactResult("missing");
      }

      const layer = await doc.createLayer(photoshop.constants.LayerKind.NORMAL, {
        name: "AI 扩图",
      });
      if (!layer) throw new Error("创建结果图层失败");
      try {
        await writePixels(
          doc.id,
          layer.id,
          cropped,
          geometry,
          parseComponentDepth(doc.bitsPerChannel),
        );
      } catch (e) {
        deleteLayer(layer);
        throw e;
      }

      return {
        layerName: layer.name,
        mode: "block",
        reboundDocId,
        placedInBackground: !isForeground,
        actualOutputSize: { width: fit.actualW, height: fit.actualH },
        outputMismatch: fit.outputMismatch,
        appliedScale: fit.appliedScale,
        note: sizeNote,
      } satisfies PlaceBackResult;
    },
    { commandName: "AI 扩图：贴回结果" },
  );
  return result;
};
