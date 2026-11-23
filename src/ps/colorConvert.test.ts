import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LINEAR_PRO_PHOTO_TO_SRGB,
  convertRgbaProPhotoToSrgb,
  decodeProPhoto,
  encodeSrgb,
  proPhotoToSrgb,
} from "./colorConvert";

describe("decodeProPhoto / encodeSrgb", () => {
  it("decodeProPhoto：线性段 v<1/32 → v/16，幂段 v^1.8", () => {
    assert.equal(decodeProPhoto(0), 0);
    assert.equal(decodeProPhoto(0.01), 0.01 / 16);
    // 边界点连续：(1/32)^1.8 = 1/512 = (1/32)/16
    assert.ok(Math.abs(decodeProPhoto(1 / 32) - 1 / 512) < 1e-12);
    assert.ok(Math.abs(decodeProPhoto(0.5) - Math.pow(0.5, 1.8)) < 1e-12);
    assert.ok(Math.abs(decodeProPhoto(1) - 1) < 1e-12);
  });

  it("encodeSrgb：低段 12.92L，高段 1.055·L^(1/2.4)−0.055", () => {
    assert.equal(encodeSrgb(0), 0);
    assert.equal(encodeSrgb(0.0031308), 12.92 * 0.0031308);
    assert.ok(Math.abs(encodeSrgb(1) - 1) < 1e-12);
    assert.ok(Math.abs(encodeSrgb(0.5) - 0.735357) < 1e-5);
  });
});

describe("LINEAR_PRO_PHOTO_TO_SRGB", () => {
  it("每行和 ≈ 1（白点守恒）", () => {
    for (let r = 0; r < 3; r++) {
      const sum =
        LINEAR_PRO_PHOTO_TO_SRGB[r * 3] +
        LINEAR_PRO_PHOTO_TO_SRGB[r * 3 + 1] +
        LINEAR_PRO_PHOTO_TO_SRGB[r * 3 + 2];
      assert.ok(
        Math.abs(sum - 1) < 1e-3,
        `第 ${r + 1} 行和 ${sum} 偏离 1 过多`,
      );
    }
  });
});

describe("proPhotoToSrgb", () => {
  it("黑点 / 白点定点", () => {
    assert.deepEqual(proPhotoToSrgb(0, 0, 0), [0, 0, 0]);
    const [r, g, b] = proPhotoToSrgb(1, 1, 1);
    assert.ok(Math.abs(r - 1) < 1e-3);
    assert.ok(Math.abs(g - 1) < 1e-3);
    assert.ok(Math.abs(b - 1) < 1e-3);
  });

  it("中性灰保持中性（三通道相等）", () => {
    const [r, g, b] = proPhotoToSrgb(0.5, 0.5, 0.5);
    assert.ok(Math.abs(r - g) < 1e-3, `r=${r} g=${g}`);
    assert.ok(Math.abs(g - b) < 1e-3, `g=${g} b=${b}`);
    // ProPhoto 0.5 → 线性 0.5^1.8 → sRGB 编码 ≈ 0.5722
    assert.ok(Math.abs(r - 0.5722) < 5e-3, `r=${r}`);
  });

  it("ProPhoto 纯红/绿/蓝超出 sRGB 色域：裁剪后仍为纯色", () => {
    const red = proPhotoToSrgb(1, 0, 0);
    assert.ok(Math.abs(red[0] - 1) < 1e-9, `r=${red[0]}`);
    assert.equal(red[1], 0);
    assert.equal(red[2], 0);
    const green = proPhotoToSrgb(0, 1, 0);
    assert.equal(green[0], 0);
    assert.ok(Math.abs(green[1] - 1) < 1e-9, `g=${green[1]}`);
    assert.equal(green[2], 0);
    const blue = proPhotoToSrgb(0, 0, 1);
    assert.equal(blue[0], 0);
    assert.equal(blue[1], 0);
    assert.ok(Math.abs(blue[2] - 1) < 1e-9, `b=${blue[2]}`);
  });

  it("中间色调（0.8, 0.2, 0.2）：红通道裁剪、绿通道收敛到 0、蓝通道低值", () => {
    const [r, g, b] = proPhotoToSrgb(0.8, 0.2, 0.2);
    assert.ok(r >= 0.999, `r=${r}`);
    assert.equal(g, 0);
    assert.ok(Math.abs(b - 0.2476) < 3e-3, `b=${b}`);
  });
});

describe("convertRgbaProPhotoToSrgb", () => {
  it("黑白与中性灰 8 位缓冲，alpha 不动", () => {
    const buf = new Uint8Array([
      0, 0, 0, 255,
      255, 255, 255, 128,
      128, 128, 128, 7,
    ]);
    convertRgbaProPhotoToSrgb(buf);
    assert.deepEqual(Array.from(buf.slice(0, 4)), [0, 0, 0, 255]);
    assert.deepEqual(Array.from(buf.slice(4, 8)), [255, 255, 255, 128]);
    const gray = Array.from(buf.slice(8, 11));
    assert.ok(
      Math.abs(gray[0] - 146) <= 1 &&
        Math.abs(gray[1] - gray[0]) <= 1 &&
        Math.abs(gray[2] - gray[0]) <= 1,
      `中性灰转换异常: ${gray}`,
    );
    assert.equal(buf[11], 7);
  });

  it("中间色调 8 位：(204,51,51) → (255,0,~63)", () => {
    const buf = new Uint8Array([204, 51, 51, 255]);
    convertRgbaProPhotoToSrgb(buf);
    assert.equal(buf[0], 255);
    assert.equal(buf[1], 0);
    assert.ok(Math.abs(buf[2] - 63) <= 2, `b=${buf[2]}`);
    assert.equal(buf[3], 255);
  });

  it("长度不足 4 字节的尾部安全", () => {
    const buf = new Uint8Array([10, 20, 30, 255, 40, 50]);
    convertRgbaProPhotoToSrgb(buf);
    assert.equal(buf[3], 255);
    assert.deepEqual(Array.from(buf.slice(4)), [40, 50]);
  });
});
