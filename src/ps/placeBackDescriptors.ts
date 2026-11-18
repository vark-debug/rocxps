import type { ActionDescriptor } from "photoshop/dom/CoreModules";

/**
 * 贴回流程用到的 Action Descriptor（纯组装，不依赖 Photoshop，可在 Node 单测）。
 *
 * 关键结论（与 Adobe Action Manager 的经典录制脚本一致）：
 * - 图层蒙版通道的枚举值是 `channel/mask`（AM 里的 `Msk `），不是 `maskChannel`；
 * - 创建图层蒙版必须带 `using: userMaskEnabled/revealAll`，Photoshop 才会把它
 *   当成「当前图层的像素蒙版」，否则可能创建成文档 alpha 通道；
 * - 创建/写入蒙版会把该蒙版通道设为当前活动通道，画布因此显示蒙版灰度（通体发黑）。
 *   写入完成后必须显式把活动通道切回复合通道（RGB/CMYK），视图才回到正常合成。
 */

/**
 * 选中指定图层。
 * 必须显式带 document 父级引用：Action Reference 是「从对象到祖先」的顺序
 * （layer → document）。只写 layer 时，Photoshop 会在**当前活动文档**里按该 id
 * 解析——不同文档的图层 id 会重复，后台贴回就会命中错误文档的图层。
 */
export const selectLayerDescriptor = (
  layerId: number,
  docId: number,
): ActionDescriptor => {
  requireDocumentAndLayer(docId, layerId, "选中图层");
  return {
    _obj: "select",
    _target: [
      { _ref: "layer", _id: layerId },
      { _ref: "document", _id: docId },
    ],
  } as unknown as ActionDescriptor;
};

/**
 * 创建一个全白（Reveal All）的**图层蒙版**。
 * `at: channel/mask` 表示蒙版通道，`using: userMaskEnabled/revealAll` 明确
 * 这是图层蒙版而不是文档通道；不带 `using` 时 Photoshop 的行为不稳定。
 *
 * `_target` 必须是 layer → document（从对象到祖先）。历史上曾写成
 * document → layer，探针只检查了 batchPlay 没报错、没有校验蒙版实际落在哪个
 * 文档，导致后台贴回时该引用被忽略、蒙版落到了当前活动文档的活动图层。
 *
 * 2026-11-07 诊断日志进一步证实：即使写成正确的 layer → document，只要目标
 * 文档**不是活动文档**，document 父级依然被忽略，AM 会按 layer id 在活动文档
 * 里解析（不同文档的图层 id 会重复）。因此该 descriptor 只允许在前台文档
 * 使用，后台路径见 `planMaskCreation`。
 */
export const makeLayerMaskDescriptor = (
  docId: number,
  layerId: number,
): ActionDescriptor => {
  requireDocumentAndLayer(docId, layerId, "添加图层蒙版");
  return {
    _obj: "make",
    _target: [
      { _ref: "layer", _id: layerId },
      { _ref: "document", _id: docId },
    ],
    new: { _obj: "channel" },
    at: { _ref: "channel", _enum: "channel", _value: "mask" },
    using: { _enum: "userMaskEnabled", _value: "revealAll" },
  } as unknown as ActionDescriptor;
};

/**
 * 图层蒙版的创建策略（纯函数，可单测）。
 *
 * - `make-then-put`（前台）：目标就是活动文档，`make` 语义可靠，保留原有
 *   「先建全白蒙版、再 putLayerMask 写入」的两步；
 * - `put-only`（后台）：跳过 `make`。`make` 的 document 父级在非活动文档下
 *   被忽略，会按 layer id 命中活动文档里的同 id 图层（实测把 B 的图层加了
 *   全白蒙版）；而 `imaging.putLayerMask` 带显式 documentID/layerID，在目标
 *   图层没有 user 蒙版时会**隐式创建**蒙版，因此后台不再需要 `make`。
 *   写入后由 `probeUserMask` 回读确认蒙版确实存在。
 */
export const planMaskCreation = (
  isForeground: boolean,
): "make-then-put" | "put-only" =>
  isForeground ? "make-then-put" : "put-only";

/** descriptor 绝不能退化成「只按 layer 解析」——那会落到当前活动文档。 */
const requireDocumentAndLayer = (
  docId: number,
  layerId: number,
  action: string,
): void => {
  if (!Number.isInteger(docId) || !Number.isInteger(layerId)) {
    throw new Error(
      `${action}必须显式指定文档与图层（docId=${docId}, layerId=${layerId}）：`
        + "缺少 document 引用会在当前活动文档上执行",
    );
  }
};

/** 文档色彩模式 → 复合通道的 AM 枚举值（`Chnl/Chnl`）。 */
const compositeChannelValues: Record<string, string> = {
  RGBColorMode: "RGB",
  CMYKColorMode: "CMYK",
  grayscaleMode: "gray",
  labColorMode: "LAB",
};

/** 选择文档的复合通道（RGB/CMYK/…），让画布从「显示蒙版通道」回到正常合成视图。 */
export const selectCompositeChannelDescriptor = (
  documentMode: string,
): ActionDescriptor =>
  ({
    _obj: "select",
    _target: [
      {
        _ref: "channel",
        _enum: "channel",
        _value: compositeChannelValues[documentMode] ?? "RGB",
      },
    ],
  }) as unknown as ActionDescriptor;
