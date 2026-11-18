/**
 * 零依赖 PNG 解码器（8/16 位，Gray / RGB / Gray+Alpha / RGBA → RGBA8）。
 * 用于解码 Ark 生成结果（b64_json → PNG → 像素 → 贴回）。
 * UXP 无 ImageData/canvas 解码通道（encodeImageData 仅 JPEG），自行实现。
 * 不支持：调色板（colorType 3）、Adam7 隔行、tRNS——Seedream 输出不含这些格式。
 */

import { crc32 } from "./pngEncoder";
import { inflate } from "./inflate";

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA8 交错像素。 */
  rgba: Uint8Array;
}

const SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const COLOR_TYPE: Record<number, number> = {
  0: 1, // Gray
  2: 3, // RGB
  4: 2, // Gray + Alpha
  6: 4, // RGBA
};

/** Paeth 预测器（PNG filter type 4）。 */
const paethPredict = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

/** 解析原始 PNG 字节流为 RGBA8。 */
export const decodePng = (bytes: Uint8Array): DecodedPng => {
  if (
    bytes.length < 8 ||
    SIGNATURE.some((b, i) => bytes[i] !== b)
  ) {
    throw new Error("PNG 解码：签名不符，不是 PNG 文件");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let idat: Uint8Array | null = null;

  // ---- 遍历 chunk ----
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len =
      (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new Error("PNG 解码：chunk 越界");

    // CRC 校验（类型 + 数据）
    if (crc32(bytes, dataStart - 4, dataEnd) !== readU32be(bytes, dataEnd)) {
      throw new Error(`PNG 解码：${type} 块 CRC 校验失败`);
    }

    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (len < 13) throw new Error("PNG 解码：IHDR 过短");
      width = readU32be(data, 0);
      height = readU32be(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filterMethod = data[11];
      const interlace = data[12];
      if (width <= 0 || height <= 0) throw new Error("PNG 解码：尺寸非法");
      if (width * height > 1 << 28) throw new Error("PNG 解码：图像过大");
      if (compression !== 0) throw new Error("PNG 解码：不支持的压缩方法");
      if (filterMethod !== 0) throw new Error("PNG 解码：不支持的滤波方法");
      if (interlace !== 0) throw new Error("PNG 解码：不支持隔行（Adam7）图像");
    } else if (type === "IDAT") {
      if (idat) {
        const merged: Uint8Array = new Uint8Array(idat.length + len);
        merged.set(idat);
        merged.set(data, idat.length);
        idat = merged;
      } else {
        idat = data.slice();
      }
    } else if (type === "IEND") {
      break;
    }
    // 其他 chunk（PLTE/tRNS/gAMA 等）跳过
    pos = dataEnd + 4;
  }

  if (width === 0) throw new Error("PNG 解码：缺少 IHDR");
  if (!idat) throw new Error("PNG 解码：缺少 IDAT");
  const channels = COLOR_TYPE[colorType];
  if (!channels) {
    throw new Error(`PNG 解码：不支持的色彩类型 ${colorType}（调色板等）`);
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`PNG 解码：不支持的位深 ${bitDepth}`);
  }

  // ---- zlib 流（RFC 1950）→ DEFLATE ----
  const cmf = idat[0];
  const flg = idat[1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) {
    throw new Error("PNG 解码：zlib 头校验失败");
  }
  if (flg & 0x20) throw new Error("PNG 解码：不支持预置字典");
  const raw = inflate(idat.subarray(2));

  // ---- 反滤波 ----
  const byteDepth = bitDepth / 8;
  const bpp = channels * byteDepth; // 滤波字节跨度
  const stride = width * channels * byteDepth;
  if (raw.length < (stride + 1) * height) {
    throw new Error("PNG 解码：IDAT 解压后数据不完整");
  }

  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    line.set(raw.subarray(rowStart + 1, rowStart + 1 + stride));

    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? line[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      switch (filter) {
        case 0: // None
          break;
        case 1: // Sub
          line[i] = (line[i] + left) & 0xff;
          break;
        case 2: // Up
          line[i] = (line[i] + up) & 0xff;
          break;
        case 3: // Average
          line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
          break;
        case 4: // Paeth
          line[i] = (line[i] + paethPredict(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`PNG 解码：未知滤波类型 ${filter}`);
      }
    }

    // ---- 行数据 → RGBA ----
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const src = x * channels * byteDepth;
      if (bitDepth === 16) {
        // 大端 16 位 → 8 位（右移 8）
        const g = (line[src] << 8) | line[src + 1];
        if (colorType === 0) {
          rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = g >> 8;
          rgba[dst + 3] = 255;
        } else if (colorType === 4) {
          const a = (line[src + 2] << 8) | line[src + 3];
          rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = g >> 8;
          rgba[dst + 3] = a >> 8;
        } else {
          const r = (line[src] << 8) | line[src + 1];
          const g2 = (line[src + 2] << 8) | line[src + 3];
          const b = (line[src + 4] << 8) | line[src + 5];
          rgba[dst] = r >> 8;
          rgba[dst + 1] = g2 >> 8;
          rgba[dst + 2] = b >> 8;
          rgba[dst + 3] = 255;
          if (colorType === 6) {
            rgba[dst + 3] = ((line[src + 6] << 8) | line[src + 7]) >> 8;
          }
        }
      } else {
        // 8 位
        if (colorType === 0) {
          rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = line[src];
          rgba[dst + 3] = 255;
        } else if (colorType === 4) {
          rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = line[src];
          rgba[dst + 3] = line[src + 1];
        } else {
          rgba[dst] = line[src];
          rgba[dst + 1] = line[src + 1];
          rgba[dst + 2] = line[src + 2];
          rgba[dst + 3] = colorType === 6 ? line[src + 3] : 255;
        }
      }
    }

    prev.set(line);
  }

  return { width, height, rgba };
};

const readU32be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0;

/** base64 → 字节流（UXP 支持 atob）。 */
export const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};
