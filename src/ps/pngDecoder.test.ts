import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { crc32 } from "./pngEncoder";
import { encodePng } from "./pngEncoder";
import { decodePng, base64ToBytes } from "./pngDecoder";
import { applyMaskAlpha, resizeRgba } from "./resize";

// ---------- 辅助：手工构造压缩 IDAT 的 PNG（检验 inflate 真实压缩路径） ----------

const u32be = (v: number) =>
  new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

const SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  out.set(u32be(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  out.set(u32be(crc32(out, 4, 8 + data.length)), 8 + data.length);
  return out;
};

/** 构造 IHDR + 压缩 IDAT + IEND 的 PNG（colorType 6 RGBA8）。 */
const buildCompressedPng = (
  w: number,
  h: number,
  rgba: Uint8Array,
): Uint8Array => {
  // 每行前置 filter byte（1 = Sub，模拟真实编码器的滤波选择）
  const stride = 1 + w * 4;
  const raw = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 1;
    const dst = y * stride + 1;
    const src = y * w * 4;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        // Sub 滤波：filtered = orig - orig_left（参考原始像素，而非已写入的滤波值）
        const left = x > 0 ? rgba[src + (x - 1) * 4 + c] : 0;
        raw[dst + x * 4 + c] = (rgba[src + x * 4 + c] - left) & 0xff;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(w), 0);
  ihdr.set(u32be(h), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Uint8Array.from([
    ...SIGNATURE,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(raw)))),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
};

describe("decodePng", () => {
  it("encodePng（stored IDAT）round-trip 像素一致", () => {
    const w = 9;
    const h = 7;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 13 + 5) & 0xff;
    const png = encodePng(w, h, rgba);
    const decoded = decodePng(png);
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.deepEqual(decoded.rgba, rgba);
  });

  it("真实压缩（Sub 滤波 + deflate）解码正确", () => {
    const w = 16;
    const h = 12;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 29) & 0xff;
    const png = buildCompressedPng(w, h, rgba);
    const decoded = decodePng(png);
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.deepEqual(decoded.rgba, rgba);
  });

  it("大图（> 64KB 数据）分块 round-trip", () => {
    const w = 128;
    const h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7) & 0xff;
    const decoded = decodePng(encodePng(w, h, rgba));
    assert.deepEqual(decoded.rgba, rgba);
  });

  it("base64 输入解码一致", () => {
    const rgba = new Uint8Array(2 * 2 * 4);
    rgba.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const png = encodePng(2, 2, rgba);
    let binary = "";
    for (const b of png) binary += String.fromCharCode(b);
    const decoded = decodePng(base64ToBytes(btoa(binary)));
    assert.deepEqual(decoded.rgba, rgba);
  });

  it("非 PNG / CRC 损坏报错", () => {
    assert.throws(() => decodePng(new Uint8Array(16)), /签名/);
    const png = encodePng(2, 2, new Uint8Array(2 * 2 * 4));
    const corrupted = new Uint8Array(png);
    corrupted[corrupted.length - 6] ^= 0xff; // 破坏 IEND CRC
    assert.throws(() => decodePng(corrupted), /CRC/);
  });
});

describe("resizeRgba", () => {
  it("同尺寸恒等", () => {
    const src = new Uint8Array(3 * 2 * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 11) & 0xff;
    assert.deepEqual(resizeRgba(src, 3, 2, 3, 2), src);
  });

  it("等比缩小边界值保持（左上角像素）", () => {
    // 2x2 全红 → 缩到 1x1 仍是红色均值（全同色不受插值影响）
    const src = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 200;
      src[i + 1] = 40;
      src[i + 2] = 60;
      src[i + 3] = 255;
    }
    const out = resizeRgba(src, 2, 2, 1, 1);
    assert.equal(out[0], 200);
    assert.equal(out[1], 40);
    assert.equal(out[2], 60);
    assert.equal(out[3], 255);
  });

  it("放大输出尺寸与数据长度正确", () => {
    const src = new Uint8Array(2 * 2 * 4);
    const out = resizeRgba(src, 2, 2, 8, 8);
    assert.equal(out.length, 8 * 8 * 4);
  });

  it("预乘缩放：alpha 渐变且 RGB 不随透明度变暗（无 halo）", () => {
    const src = new Uint8Array(2 * 1 * 4);
    // 左侧全透明黑、右侧不透明白
    src.set([0, 0, 0, 0, 255, 255, 255, 255]);
    const out = resizeRgba(src, 2, 1, 4, 1);
    // alpha 两端保持、中间渐变（Lanczos）
    assert.equal(out[3], 0); // x=0：全透明
    assert.equal(out[15], 255); // x=3：不透明
    assert.ok(out[7] > 0 && out[7] < out[11] && out[11] < 255);
    // 中间像素 RGB 仍为纯白：预乘缩放下「白 + 半透明」≠ 深灰
    assert.equal(out[4], 255);
    assert.equal(out[5], 255);
    assert.equal(out[6], 255);
    assert.equal(out[8], 255);
    assert.equal(out[9], 255);
    assert.equal(out[10], 255);
  });
});

describe("applyMaskAlpha", () => {
  it("蒙版 255 保留、0 全透明、128 半透明", () => {
    const rgba = new Uint8Array([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255,
    ]);
    const mask = new Uint8Array([255, 0, 128]);
    const out = applyMaskAlpha(rgba, mask);
    assert.equal(out[3], 255);
    assert.equal(out[7], 0);
    assert.equal(out[11], Math.round((255 * 128) / 255));
    // RGB 分量不被修改
    assert.equal(out[0], 10);
    assert.equal(out[4], 40);
    assert.equal(out[8], 70);
  });

  it("蒙版长度与像素数不符抛错", () => {
    assert.throws(() => applyMaskAlpha(new Uint8Array(4), new Uint8Array(2)));
  });
});
