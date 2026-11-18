/**
 * 零依赖 PNG 编码器（8bit RGBA）。
 * UXP 的 encodeImageData 只支持 JPEG（丢 alpha），saveAs.png 依赖的
 * localFileSystem 在部分宿主上被权限剥离，故自行编码：
 * IDAT 使用 zlib stored 块（无压缩但完全合法），体积换取可靠性。
 */

// ---- CRC32（PNG chunk 校验）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export const crc32 = (
  data: Uint8Array,
  start = 0,
  end: number = data.length,
): number => {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

// ---- Adler32（zlib 校验）----
export const adler32 = (data: Uint8Array): number => {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

const writeU32 = (out: Uint8Array, p: number, v: number): void => {
  out[p] = (v >>> 24) & 0xff;
  out[p + 1] = (v >>> 16) & 0xff;
  out[p + 2] = (v >>> 8) & 0xff;
  out[p + 3] = v & 0xff;
};

/** 写 chunk 头（长度 + 类型），返回数据区起点。CRC 由调用方在数据填完后写。 */
const writeChunkHead = (
  out: Uint8Array,
  p: number,
  type: string,
  dataLen: number,
): number => {
  writeU32(out, p, dataLen);
  for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
  return p + 8;
};

/** 算出 stored 模式 zlib 流的字节数。 */
const storedZlibLength = (rawLen: number): number => {
  const numBlocks = Math.max(1, Math.ceil(rawLen / 65535));
  return 2 + rawLen + numBlocks * 5 + 4;
};

/** 把 stored zlib 流直接写进 out 的 offset 处（避免为 IDAT 再分配一份缓冲），返回结束位置。 */
const writeStoredZlib = (
  out: Uint8Array,
  offset: number,
  raw: Uint8Array,
): number => {
  let p = offset;
  out[p++] = 0x78; // CMF: deflate, 32K window
  out[p++] = 0x01; // FLG: check bits for 0x7801
  const maxBlock = 65535;
  const numBlocks = Math.max(1, Math.ceil(raw.length / maxBlock));
  let off = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = Math.min(maxBlock, raw.length - off);
    const last = i === numBlocks - 1 ? 1 : 0;
    out[p++] = last; // BFINAL + BTYPE=00（stored）
    out[p++] = len & 0xff;
    out[p++] = (len >>> 8) & 0xff;
    out[p++] = ~len & 0xff;
    out[p++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(off, off + len), p);
    p += len;
    off += len;
  }
  writeU32(out, p, adler32(raw));
  return p + 4;
};

/** zlib 流（stored/无压缩 deflate 块）。 */
export const zlibStored = (raw: Uint8Array): Uint8Array => {
  const out = new Uint8Array(storedZlibLength(raw.length));
  return out.subarray(0, writeStoredZlib(out, 0, raw));
};

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** 将 RGBA 像素编码为 PNG（Uint8Array）。 */
export const encodePng = (
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array => {
  if (width <= 0 || height <= 0) throw new Error("PNG 编码：尺寸非法");
  if (rgba.length !== width * height * 4) {
    throw new Error("PNG 编码：像素数据长度与尺寸不符");
  }
  // 每行前置 filter byte 0（None）
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  // 单缓冲直写：签名 + IHDR + IDAT + IEND，避免 raw/zlib/IDAT/成品四份大拷贝
  const IHDR_LEN = 13;
  const zlibLen = storedZlibLength(raw.length);
  const out = new Uint8Array(8 + (12 + IHDR_LEN) + (12 + zlibLen) + 12);
  out.set(PNG_SIGNATURE, 0);

  // IHDR
  let p = 8;
  let data = writeChunkHead(out, p, "IHDR", IHDR_LEN);
  out.set(ihdr, data);
  writeU32(out, data + IHDR_LEN, crc32(out, p + 4, data + IHDR_LEN));

  // IDAT（zlib 流就地写入）
  p = data + IHDR_LEN + 4;
  data = writeChunkHead(out, p, "IDAT", zlibLen);
  const zEnd = writeStoredZlib(out, data, raw);
  writeU32(out, zEnd, crc32(out, p + 4, zEnd));

  // IEND
  p = zEnd + 4;
  data = writeChunkHead(out, p, "IEND", 0);
  writeU32(out, data, crc32(out, p + 4, data));
  return out;
};
