import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computePlaceGeometry, composeCanvasMask, cropPlane } from "./placeBackGeometry";
import { expandRectToMultiple } from "./geometry";
import { CAPTURE_ALIGN } from "./align";
import type { ExpandedRegion, Rect } from "./types";

const rect = (l: number, t: number, r: number, b: number): Rect => ({
  left: l,
  top: t,
  right: r,
  bottom: b,
});

/** 构造 32x32 的非矩形（套索感）蒙版：左上三角形为白，其余为黑。 */
const lassoMask = (size = 32): Uint8Array => {
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data[y * size + x] = x <= y ? 255 : 0;
    }
  }
  return data;
};

describe("computePlaceGeometry", () => {
  it("无补边：整块缩放落点 = 扩展区域（32 对齐）", () => {
    const sel = rect(100, 100, 409, 308);
    const expanded = expandRectToMultiple(sel, 1920, 1080);
    const g = computePlaceGeometry(expanded);

    assert.equal(expanded.width % CAPTURE_ALIGN, 0, "宽度必须 32 对齐");
    assert.equal(expanded.height % CAPTURE_ALIGN, 0, "高度必须 32 对齐");
    assert.deepEqual(g, {
      outW: expanded.width,
      outH: expanded.height,
      targetLeft: 95,
      targetTop: 92,
      srcLeft: 0,
      srcTop: 0,
    });
  });

  it("左右补边：目标回到画布原点，蒙版裁掉两侧补边", () => {
    // 画布宽 100、对齐后 128 → 左右各补 14
    const expanded = expandRectToMultiple(rect(0, 50, 97, 66), 100, 200);
    assert.ok(expanded.padInfo);
    const g = computePlaceGeometry(expanded);

    assert.equal(g.outW, 100);
    assert.equal(g.outH, 32);
    assert.equal(g.targetLeft, 0);
    assert.equal(g.targetTop, 42);
    assert.equal(g.srcLeft, 14);
    assert.equal(g.srcTop, 0);
    assert.equal(g.outW, expanded.width - expanded.padInfo.padLeft - expanded.padInfo.padRight);
  });

  it("上下补边：目标回画布顶部，蒙版裁掉上下补边", () => {
    // 画布高 100、对齐后 128 → 上下各补 14
    const expanded = expandRectToMultiple(rect(10, 0, 290, 97), 400, 100);
    assert.ok(expanded.padInfo);
    const g = computePlaceGeometry(expanded);

    assert.equal(g.outW, 288);
    assert.equal(g.outH, 100);
    assert.equal(g.targetLeft, 6);
    assert.equal(g.targetTop, 0);
    assert.equal(g.srcLeft, 0);
    assert.equal(g.srcTop, 14);
  });

  it("四边补边：四个 pad 同时从尺寸与坐标中扣除", () => {
    const expanded: ExpandedRegion = {
      bounds: rect(-14, -14, 114, 114),
      width: 128,
      height: 128,
      padInfo: {
        padLeft: 14,
        padTop: 14,
        padRight: 14,
        padBottom: 14,
        width: 128,
        height: 128,
      },
    };
    const g = computePlaceGeometry(expanded);

    assert.deepEqual(g, {
      outW: 100,
      outH: 100,
      targetLeft: 0,
      targetTop: 0,
      srcLeft: 14,
      srcTop: 14,
    });
  });

  it("补边裁剪后为空抛错", () => {
    const expanded: ExpandedRegion = {
      bounds: rect(0, 0, 32, 32),
      width: 32,
      height: 32,
      padInfo: {
        padLeft: 20,
        padTop: 0,
        padRight: 20,
        padBottom: 0,
        width: 32,
        height: 32,
      },
    };
    assert.throws(() => computePlaceGeometry(expanded));
  });
});

describe("cropPlane", () => {
  it("无需裁剪时直接复用源数据", () => {
    const src = new Uint8Array(4 * 3);
    assert.equal(cropPlane(src, 1, 4, 0, 0, 4, 3), src);
  });

  it("RGBA 按行裁剪，像素不错位", () => {
    // 4x3，每像素 RGBA 依次标记
    const src = new Uint8Array(4 * 3 * 4);
    for (let p = 0; p < 4 * 3; p++) {
      src[p * 4] = p;
      src[p * 4 + 1] = p + 1;
      src[p * 4 + 2] = p + 2;
      src[p * 4 + 3] = 255;
    }
    const out = cropPlane(src, 4, 4, 1, 1, 2, 2);
    assert.deepEqual([...out], [
      5, 6, 7, 255, 6, 7, 8, 255,
      9, 10, 11, 255, 10, 11, 12, 255,
    ]);
  });

  it("非矩形（套索）蒙版裁剪后形状不被矩形化", () => {
    const mask = lassoMask(32);
    const out = cropPlane(mask, 1, 32, 8, 8, 16, 16);

    // 裁剪后的子区域仍保留三角形边界：既不是全黑也不是全白
    const values = new Set(out);
    assert.deepEqual([...values].sort((a, b) => a - b), [0, 255]);
    // 对角线上的像素在源图中为白（x <= y），裁剪后仍应保持
    for (let y = 0; y < 16; y++) {
      const x = y; // 源坐标 (8+x, 8+y) 满足 8+x <= 8+y → 白
      assert.equal(out[y * 16 + x], 255);
      // 对角线右侧相邻像素（x = y + 1）在源图中为黑，形状不被矩形化
      if (y < 15) assert.equal(out[y * 16 + (y + 1)], 0);
    }
  });

  it("32 对齐的扩展区域：补边裁剪后蒙版与像素使用同一几何", () => {
    const sel = rect(0, 50, 97, 66);
    const expanded = expandRectToMultiple(sel, 100, 200);
    const g = computePlaceGeometry(expanded);

    // 模拟捕获阶段边缘延展后的蒙版（128x32）与像素（128x32）
    const mask = new Uint8Array(expanded.width * expanded.height);
    mask.fill(255);
    const pixels = new Uint8Array(expanded.width * expanded.height * 4);
    pixels.fill(255);

    const croppedMask = cropPlane(
      mask,
      1,
      expanded.width,
      g.srcLeft,
      g.srcTop,
      g.outW,
      g.outH,
    );
    const croppedPixels = cropPlane(
      pixels,
      4,
      expanded.width,
      g.srcLeft,
      g.srcTop,
      g.outW,
      g.outH,
    );

    assert.equal(croppedMask.length, g.outW * g.outH);
    assert.equal(croppedPixels.length, g.outW * g.outH * 4);
    assert.equal(croppedMask.length, 100 * 32);
  });

  it("越界裁剪抛错", () => {
    const src = new Uint8Array(4 * 4);
    assert.throws(() => cropPlane(src, 1, 4, 1, 0, 4, 4));
    assert.throws(() => cropPlane(src, 1, 4, 0, 0, 0, 4));
    assert.throws(() => cropPlane(src, 1, 5, 0, 0, 2, 2));
  });
});

describe("composeCanvasMask", () => {
  const sample = (data: Uint8Array, w: number, x: number, y: number): number =>
    data[y * w + x];

  it("整画布黑底：区域外为 0，区域内为原选区灰度", () => {
    const canvasW = 10;
    const canvasH = 6;
    const mask = new Uint8Array(4 * 3).fill(200);
    const out = composeCanvasMask(canvasW, canvasH, mask, 4, 3, 3, 2);

    assert.equal(out.length, canvasW * canvasH);
    for (let y = 0; y < canvasH; y++) {
      for (let x = 0; x < canvasW; x++) {
        const inside = x >= 3 && x < 7 && y >= 2 && y < 5;
        assert.equal(sample(out, canvasW, x, y), inside ? 200 : 0);
      }
    }
  });

  it("羽化灰阶与选区形状（非矩形）原样保留", () => {
    // 三角形 + 一条羽化过渡边
    const mask = new Uint8Array(4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) mask[y * 4 + x] = x <= y ? 255 : 0;
    }
    mask[0 * 4 + 1] = 64;
    mask[1 * 4 + 2] = 128;

    const out = composeCanvasMask(8, 8, mask, 4, 4, 2, 2);
    assert.equal(sample(out, 8, 2, 2), 255);
    assert.equal(sample(out, 8, 3, 2), 64);
    assert.equal(sample(out, 8, 4, 3), 128);
    assert.equal(sample(out, 8, 5, 3), 0);
    // 区域外纯黑
    assert.equal(sample(out, 8, 0, 0), 0);
    assert.equal(sample(out, 8, 7, 7), 0);
  });

  it("区域越出画布左侧/顶部时只写入交集且坐标正确", () => {
    const mask = new Uint8Array(4 * 3);
    for (let i = 0; i < mask.length; i++) mask[i] = i + 1;
    const out = composeCanvasMask(6, 5, mask, 4, 3, -2, -1);

    // 可见交集：画布 (0,0)-(1,1)，对应蒙版 (2,1)-(3,2)
    assert.equal(sample(out, 6, 0, 0), mask[1 * 4 + 2]);
    assert.equal(sample(out, 6, 1, 0), mask[1 * 4 + 3]);
    assert.equal(sample(out, 6, 0, 1), mask[2 * 4 + 2]);
    assert.equal(sample(out, 6, 1, 1), mask[2 * 4 + 3]);
    // 交集外仍为黑
    assert.equal(sample(out, 6, 2, 0), 0);
    assert.equal(sample(out, 6, 0, 2), 0);
  });

  it("32 对齐扩区 + 补边：区域内容落在 targetLeft/Top，画布其余为黑", () => {
    // 靠近画布左边缘的选区：扩展区含左右补边，裁剪后 targetLeft = 0
    const sel = rect(0, 50, 97, 66);
    const expanded = expandRectToMultiple(sel, 100, 200);
    const g = computePlaceGeometry(expanded);

    // 模拟捕获蒙版：扩展区域内左半为白、右半为黑（保留非矩形边界）
    const expandedMask = new Uint8Array(expanded.width * expanded.height);
    for (let y = 0; y < expanded.height; y++) {
      for (let x = 0; x < expanded.width; x++) {
        expandedMask[y * expanded.width + x] = x < expanded.width / 2 ? 255 : 0;
      }
    }
    const croppedMask = cropPlane(
      expandedMask,
      1,
      expanded.width,
      g.srcLeft,
      g.srcTop,
      g.outW,
      g.outH,
    );
    const out = composeCanvasMask(
      100,
      200,
      croppedMask,
      g.outW,
      g.outH,
      g.targetLeft,
      g.targetTop,
    );

    assert.equal(out.length, 100 * 200);
    // 画布顶部（区域上方）全黑
    for (let x = 0; x < 100; x++) assert.equal(sample(out, 100, x, 0), 0);
    // 区域第一行：左半白、右半黑
    assert.equal(sample(out, 100, 0, g.targetTop), 255);
    assert.equal(sample(out, 100, g.outW - 1, g.targetTop), 0);
    // 区域下方全黑
    for (let x = 0; x < 100; x++) {
      assert.equal(sample(out, 100, x, g.targetTop + g.outH), 0);
    }
  });

  it("尺寸或数据长度非法抛错", () => {
    assert.throws(() => composeCanvasMask(0, 5, new Uint8Array(4), 2, 2, 0, 0));
    assert.throws(() => composeCanvasMask(5, 5, new Uint8Array(3), 2, 2, 0, 0));
    assert.throws(() => composeCanvasMask(5, 5, new Uint8Array(4), 3, 2, 0, 0));
  });
});
