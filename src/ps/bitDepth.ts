/**
 * 文档位深工具（纯函数，可在 Node 单测）。
 *
 * UXP imaging 写路径（createImageDataFromBuffer → putPixels / putLayerMask）
 * 不做任何位深转换：imageData 的缓冲类型必须与目标文档位深完全一致
 * （Uint8Array=8 / Uint16Array=16 / Float32Array=32），否则报
 * 「The target depth does not match the source depth」。PSB（大文档格式）
 * 常见 16/32 位，写路径若硬编码 8 位缓冲必然失败。
 *
 * 数值语义（与 @types/photoshop dom/ImagingModule.d.ts 一致）：
 * - 16 位：默认减范围 [0..32768]（fullRange:false，Photoshop 原生内部范围）；
 * - 32 位：Float32 单分量 [0..1]。
 */

/** 组件位深：8 / 16 / 32。 */
export type ComponentDepth = 8 | 16 | 32;

/** 按位深缩放后的样本缓冲（类型即位深标识）。 */
export type DepthSamples = Uint8Array | Uint16Array | Float32Array;

/**
 * 从 doc.bitsPerChannel 解析目标位深。
 * DOM 属性可能返回 UnitValue 包装对象（{_value, _unit}），统一取值后按
 * 字符串判定（与项目既有 `String(doc.bitsPerChannel).includes("16")` 惯例一致）；
 * 无法识别时回退 8 位（历史行为，8 位文档始终可用）。
 */
export const parseComponentDepth = (bitsPerChannel: unknown): ComponentDepth => {
  const raw =
    bitsPerChannel &&
    typeof bitsPerChannel === "object" &&
    "_value" in (bitsPerChannel as { _value?: unknown })
      ? (bitsPerChannel as { _value: unknown })._value
      : bitsPerChannel;
  const s = String(raw ?? "");
  if (s.includes("32")) return 32;
  if (s.includes("16")) return 16;
  return 8;
};

/** 16 位减范围缩放系数：32768 / 255（255 → 32768 恰好顶格）。 */
const SCALE_8_TO_16 = 32768 / 255;

/**
 * 8 位样本逐分量缩放到目标位深（RGBA / 灰度通用：缩放与分量数无关）。
 * 8 位原样返回（零拷贝，历史行为不变）。
 */
export const scaleSamplesToDepth = (
  src: Uint8Array,
  depth: ComponentDepth,
): DepthSamples => {
  if (depth === 8) return src;
  if (depth === 16) {
    const out = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) {
      out[i] = Math.round(src[i] * SCALE_8_TO_16);
    }
    return out;
  }
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src[i] / 255;
  }
  return out;
};

/**
 * createImageDataFromBuffer 的 16 位 fullRange 选项：
 * 本项目一律构造减范围数据（[0..32768]），与 API 默认一致，显式声明防漂移；
 * 8 / 32 位无该参数，返回空对象直接展开。
 */
export const depthBufferOption = (
  depth: ComponentDepth,
): { fullRange?: boolean } => (depth === 16 ? { fullRange: false } : {});
