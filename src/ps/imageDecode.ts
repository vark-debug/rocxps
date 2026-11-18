/**
 * 图像解码入口：按文件签名嗅探 PNG / JPEG 并分发。
 * Ark Seedream 4.0/4.5 的 b64_json 固定返回 JPEG，5.0-lite 可请求 PNG，
 * 贴回端不能假设格式，统一走此入口。
 */

import { decodePng, base64ToBytes } from "./pngDecoder";
import { decodeJpeg } from "./jpegDecoder";

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA8 交错像素。 */
  rgba: Uint8Array;
  /** 嗅探出的格式（用于 UI 预览 data URL）。 */
  format: "png" | "jpeg";
}

/** 防御性剥离 data URL 前缀（如 data:image/jpeg;base64,）。 */
export const stripDataUrlPrefix = (b64: string): string => {
  const idx = b64.indexOf(";base64,");
  if (b64.startsWith("data:") && idx >= 0) {
    return b64.slice(idx + ";base64,".length);
  }
  return b64;
};

/** 按字节签名判断格式（供 UI 预览 data URL；未知返回 undefined）。 */
export const sniffImageMime = (b64: string): "image/png" | "image/jpeg" | undefined => {
  const s = stripDataUrlPrefix(b64);
  if (s.startsWith("iVBORw0KGgo")) return "image/png"; // 89 50 4E 47 的 base64 前 11 字节
  if (s.startsWith("/9j/")) return "image/jpeg"; // FF D8 FF 的 base64 前 4 字节
  return undefined;
};

/** 按签名分发解码为 RGBA8。 */
export const decodeImageBytes = (b64: string): DecodedImage => {
  const s = stripDataUrlPrefix(b64);
  const bytes = base64ToBytes(s);
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const d = decodePng(bytes);
    return { ...d, format: "png" };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    const d = decodeJpeg(bytes);
    return { ...d, format: "jpeg" };
  }
  const hex = Array.from(bytes.subarray(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  throw new Error(`图像解码：未知文件签名（${hex}）`);
};
