import { photoshop } from "../globals";
import { readDocumentRgba } from "./capture";
import type { Document } from "photoshop/dom/Document";
import type { Layer } from "photoshop/dom/Layer";

/**
 * 智能对象内容读取（图层超分的输入来源）。
 *
 * PS 里对智能对象的缩放 / 旋转是非破坏性的：`layer.bounds` 是**显示**后的
 * 外接矩形，按它 getPixels 只能拿到插值过的像素，倍率也会按显示尺寸算错。
 * 真实分辨率保存在内容文档里，所以这里用 placedLayerEditContents 打开内容
 * 文档 → 读 100% 合成像素 → 不保存关闭，得到原始尺寸 W0×H0 与干净像素。
 *
 * 内容文档若在打开前就已经存在（链接智能对象的源文件正被用户编辑），不关闭
 * 它，避免丢弃用户未保存的修改。
 */
export interface SmartObjectContent {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** 内容文档原本已打开，本次未关闭。 */
  reusedDocument?: boolean;
}

const bpOptions = {
  synchronousExecution: true,
  dialogOptions: "dontDisplay",
} as const;

/** DOM 尺寸可能是 UnitValue 包装对象（{_value, _unit}），统一取数值。 */
const toPx = (value: unknown): number => {
  const raw =
    value && typeof value === "object" && "_value" in (value as { _value?: unknown })
      ? (value as { _value: unknown })._value
      : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

const openDocumentIds = (): Set<number> => {
  const ids = new Set<number>();
  const docs = photoshop.app.documents;
  for (let i = 0; i < docs.length; i += 1) ids.add(docs[i].id);
  return ids;
};

interface PlacedLayerEditResult {
  _obj?: string;
  message?: string;
  documentID?: number;
}

export const readSmartObjectContent = async (
  doc: Document,
  layer: Layer,
): Promise<SmartObjectContent> => {
  const previousIds = openDocumentIds();
  const holder: { value?: SmartObjectContent } = {};

  await photoshop.core.executeAsModal(
    async () => {
      const results = (await photoshop.action.batchPlay(
        [
          {
            _obj: "placedLayerEditContents",
            _target: [{ _ref: "layer", _id: layer.id }],
            _options: { dialogOptions: "dontDisplay" },
          },
        ] as never,
        bpOptions as never,
      )) as unknown as PlacedLayerEditResult[];
      const first = results?.[0] ?? {};
      if (first._obj === "error") {
        throw new Error(first.message ?? "无法打开智能对象内容");
      }
      const contentDoc = first.documentID
        ? photoshop.app.documents.find((d) => d.id === first.documentID)
        : photoshop.app.activeDocument;
      if (!contentDoc) throw new Error("无法打开智能对象内容文档");

      const reused = previousIds.has(contentDoc.id);
      try {
        const width = Math.round(toPx(contentDoc.width));
        const height = Math.round(toPx(contentDoc.height));
        if (!(width > 0) || !(height > 0)) {
          throw new Error("智能对象内容文档尺寸无效");
        }
        const rgba = await readDocumentRgba(contentDoc, {
          left: 0,
          top: 0,
          right: width,
          bottom: height,
        });
        if (!rgba) {
          throw new Error("智能对象内容不是可读取的 RGB 文档");
        }
        holder.value = {
          width,
          height,
          rgba,
          ...(reused ? { reusedDocument: true } : {}),
        };
      } finally {
        if (!reused) {
          await contentDoc
            .close(photoshop.constants.SaveOptions.DONOTSAVECHANGES)
            .catch(() => undefined);
        }
        const original = photoshop.app.documents.find((d) => d.id === doc.id);
        if (original) photoshop.app.activeDocument = original;
      }
    },
    { commandName: "读取智能对象原始像素" },
  );

  const content = holder.value;
  if (!content) throw new Error("未能读取智能对象原始像素");
  return content;
};
