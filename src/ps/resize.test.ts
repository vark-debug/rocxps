import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resizeRgba, resizeGray, applyMaskAlpha } from "./resize";
import { base64ToBytes } from "./pngDecoder";
import { RESIZE_FIXTURES } from "./resizeFixtures";

// 一致性：定点量化路径与转换公式均已复刻，与 Pillow LANCZOS 期望逐位相等
const MAX_DIFF = 0;
const MEAN_DIFF = 0;

const compare = (got: Uint8Array, ref: Uint8Array) => {
  assert.equal(got.length, ref.length, "输出长度与参考不符");
  let max = 0;
  let sum = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(got[i] - ref[i]);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / ref.length };
};

describe("resizeRgba（Lanczos3，对齐 Pillow LANCZOS）", () => {
  it("等尺寸直通：逐字节相等", () => {
    const src = new Uint8Array(40 * 24 * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 37 + 11) & 0xff;
    const out = resizeRgba(src, 40, 24, 40, 24);
    assert.deepEqual(Array.from(out), Array.from(src));
  });

  for (const f of RESIZE_FIXTURES) {
    it(`${f.name}: ${f.sw}×${f.sh} → ${f.dw}×${f.dh} 对齐 Pillow`, () => {
      const out = resizeRgba(
        base64ToBytes(f.srcB64),
        f.sw,
        f.sh,
        f.dw,
        f.dh,
      );
      const ref = base64ToBytes(f.refB64);
      const { max, mean } = compare(out, ref);
      assert.ok(max <= MAX_DIFF, `${f.name} max diff ${max} > ${MAX_DIFF}`);
      assert.ok(
        mean <= MEAN_DIFF,
        `${f.name} mean diff ${mean.toFixed(3)} > ${MEAN_DIFF}`,
      );
    });
  }

  it("非法尺寸抛错", () => {
    const px = new Uint8Array(4);
    assert.throws(() => resizeRgba(px, 0, 1, 2, 2));
    assert.throws(() => resizeRgba(px, 1, 0, 2, 2));
    assert.throws(() => resizeRgba(px, 1, 1, 0, 2));
    assert.throws(() => resizeRgba(px, 1, 1, 2, 0));
  });

  it("源数据长度与尺寸不符抛错", () => {
    assert.throws(() => resizeRgba(new Uint8Array(3), 1, 1, 2, 2));
  });
});

describe("resizeGray（单通道蒙版缩放）", () => {
  it("等尺寸直通：逐字节相等", () => {
    const src = new Uint8Array(40 * 24);
    for (let i = 0; i < src.length; i++) src[i] = (i * 13 + 7) & 0xff;
    const out = resizeGray(src, 40, 24, 40, 24);
    assert.deepEqual(Array.from(out), Array.from(src));
  });

  it("缩小 / 放大后长度正确且值域合规", () => {
    const src = new Uint8Array(64 * 48);
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 64; x++) src[y * 64 + x] = x < 32 ? 255 : 0;
    }
    const down = resizeGray(src, 64, 48, 32, 24);
    assert.equal(down.length, 32 * 24);
    const up = resizeGray(src, 64, 48, 128, 96);
    assert.equal(up.length, 128 * 96);
    for (const v of up) assert.ok(v >= 0 && v <= 255);
  });

  it("非法尺寸 / 源长度不符抛错", () => {
    const px = new Uint8Array(4);
    assert.throws(() => resizeGray(px, 2, 2, 0, 1));
    assert.throws(() => resizeGray(new Uint8Array(3), 2, 2, 4, 4));
  });
});

describe("applyMaskAlpha", () => {
  it("蒙版乘进 alpha（255 保留 / 0 透明 / 中间值缩放）", () => {
    // 2 像素：RGBA(10, 20, 30, 200) × 蒙版 [255, 128]
    const rgba = new Uint8Array([10, 20, 30, 200, 10, 20, 30, 200]);
    const out = applyMaskAlpha(rgba, new Uint8Array([255, 128]));
    assert.deepEqual(Array.from(out), [10, 20, 30, 200, 10, 20, 30, 100]);
  });

  it("蒙版尺寸不符抛错", () => {
    // 8 字节 = 2 像素，蒙版 3 ≠ 2 应抛错
    assert.throws(() => applyMaskAlpha(new Uint8Array(8), new Uint8Array(3)));
  });
});
