import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeRequestSize } from "./sizeStrategy";
import { MODELS } from "./models";
import type { ModelPreset } from "./models";

const seedream40 = MODELS[0]; // min 921600 / max 16777216
const seededit = MODELS[1]; // adaptive

const preset = (p: Partial<ModelPreset>): ModelPreset => ({
  ...seedream40,
  ...p,
});

describe("computeRequestSize", () => {
  it("小选区放大到模型最小总像素以上，保持 8 整除", () => {
    const { reqW, reqH } = computeRequestSize(seedream40, 320, 208);
    assert.equal(reqW, 1192);
    assert.equal(reqH, 776);
    assert.equal(reqW % 8, 0);
    assert.equal(reqH % 8, 0);
    assert.ok(reqW * reqH >= 921600, "放大后必须达到最小总像素");
    // 宽高比容差内保持（8px 取整误差）
    assert.ok(Math.abs(reqW / reqH - 320 / 208) < 0.05);
  });

  it("恰好等于最小总像素：原样输出", () => {
    const { reqW, reqH } = computeRequestSize(seedream40, 1280, 720);
    assert.equal(reqW, 1280);
    assert.equal(reqH, 720);
  });

  it("超上限缩小到模型最大总像素以内，保持 8 整除", () => {
    const { reqW, reqH } = computeRequestSize(seedream40, 5000, 5000);
    assert.equal(reqW, 4096);
    assert.equal(reqH, 4096);
    assert.ok(reqW * reqH <= 16777216, "缩小后不得超过最大总像素");
    assert.equal(reqW % 8, 0);
    assert.equal(reqH % 8, 0);
  });

  it("恰好等于最大总像素：原样输出", () => {
    const { reqW, reqH } = computeRequestSize(seedream40, 4096, 4096);
    assert.equal(reqW, 4096);
    assert.equal(reqH, 4096);
  });

  it("5.0 系列（上限 4624220）超大选区缩小", () => {
    const m = preset({ maxPixels: 4624220 });
    const { reqW, reqH } = computeRequestSize(m, 5000, 5000);
    assert.ok(reqW * reqH <= 4624220);
    assert.equal(reqW % 8, 0);
    assert.equal(reqH % 8, 0);
    assert.ok(Math.abs(reqW / reqH - 1) < 0.05);
  });

  it("sizeAlign=32 的模型：请求尺寸按 32 对齐（Qwen-Image-2.1）", () => {
    const m = preset({ sizeAlign: 32, minPixels: 0, maxPixels: 1048576 });
    // 捕获层已保证 32 对齐，这里不应再做缩放
    const { reqW, reqH } = computeRequestSize(m, 320, 224);
    assert.equal(reqW, 320);
    assert.equal(reqH, 224);
    assert.equal(reqW % 32, 0);
    assert.equal(reqH % 32, 0);
  });

  it("sizeAlign=32 且超过 1MP：缩小后仍保持 32 对齐", () => {
    const m = preset({ sizeAlign: 32, minPixels: 0, maxPixels: 1048576 });
    const { reqW, reqH } = computeRequestSize(m, 1600, 1216);
    assert.equal(reqW % 32, 0);
    assert.equal(reqH % 32, 0);
    assert.ok(reqW * reqH <= 1048576, "缩小后不得超过 1MP");
    assert.ok(Math.abs(reqW / reqH - 1600 / 1216) < 0.05);
  });

  it("极端长条选区：宽高比超 [1/16, 16] 拦截", () => {
    assert.throws(() => computeRequestSize(seedream40, 10000, 100));
    assert.throws(() => computeRequestSize(seedream40, 100, 10000));
  });

  it("adaptive 模型不走换算", () => {
    assert.throws(() => computeRequestSize(seededit, 320, 208));
  });

  it("非法尺寸抛错", () => {
    assert.throws(() => computeRequestSize(seedream40, 0, 100));
    assert.throws(() => computeRequestSize(seedream40, -10, 100));
  });
});
