import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UPSCALE_LONG_SIDE,
  MAX_UPSCALE_LONG_SIDE,
  buildUpscaleArgs,
  normalizeUpscaleLongSide,
  planContentUpscale,
  planUpscaleSize,
} from "./upscalePlan";

describe("normalizeUpscaleLongSide", () => {
  it("合法值取整", () => {
    assert.equal(normalizeUpscaleLongSide("6000"), 6000);
    assert.equal(normalizeUpscaleLongSide(6000.6), 6001);
  });

  it("空值 / 非法值 / 低于下限回退默认", () => {
    assert.equal(normalizeUpscaleLongSide(""), DEFAULT_UPSCALE_LONG_SIDE);
    assert.equal(normalizeUpscaleLongSide("abc"), DEFAULT_UPSCALE_LONG_SIDE);
    assert.equal(normalizeUpscaleLongSide(undefined), DEFAULT_UPSCALE_LONG_SIDE);
    assert.equal(normalizeUpscaleLongSide(1), DEFAULT_UPSCALE_LONG_SIDE);
  });

  it("超过上限截断", () => {
    assert.equal(
      normalizeUpscaleLongSide(MAX_UPSCALE_LONG_SIDE + 1),
      MAX_UPSCALE_LONG_SIDE,
    );
  });
});

describe("planUpscaleSize", () => {
  it("按长边等比放大", () => {
    const plan = planUpscaleSize(1000, 500, 4096);
    assert.equal(plan.width, 4096);
    assert.equal(plan.height, 2048);
    assert.ok(Math.abs(plan.scale - 4.096) < 1e-9);
  });

  it("竖图以高为长边", () => {
    const plan = planUpscaleSize(500, 1000, 4096);
    assert.equal(plan.width, 2048);
    assert.equal(plan.height, 4096);
  });

  it("目标不大于原长边时按比例缩小（不拦截）", () => {
    const same = planUpscaleSize(1024, 768, 1024);
    assert.equal(same.width, 1024);
    assert.equal(same.height, 768);
    assert.equal(same.scale, 1);
    const half = planUpscaleSize(1024, 768, 512);
    assert.equal(half.width, 512);
    assert.equal(half.height, 384);
    assert.ok(Math.abs(half.scale - 0.5) < 1e-9);
  });

  it("非法尺寸 / 目标超上限时拒绝", () => {
    assert.throws(() => planUpscaleSize(0, 768, 4096), /尺寸无效/);
    assert.throws(
      () => planUpscaleSize(1024, 768, MAX_UPSCALE_LONG_SIDE + 1),
      /不能超过/,
    );
  });

  it("输出像素超插件上限时拒绝", () => {
    // 300000 长边、4:3 → 约 6.75 亿像素
    assert.throws(
      () => planUpscaleSize(4000, 3000, MAX_UPSCALE_LONG_SIDE),
      /超过插件上限/,
    );
  });
});

describe("planContentUpscale（智能对象原始分辨率）", () => {
  it("按原始分辨率计算倍率，与显示尺寸无关", () => {
    // 原始 750×500，PS 放大 8× 显示为 6000×4000，目标 4096
    const plan = planContentUpscale(750, 500, 6000, 4000, 4096);
    assert.equal(plan.width, 4096);
    assert.equal(plan.height, 2731);
    assert.ok(Math.abs(plan.scale - 5.4613) < 0.001);
    assert.equal(plan.displayScale, 8);
    assert.deepEqual(plan.displaySize, { width: 6000, height: 4000 });
    assert.equal(plan.belowDisplay, true);
    assert.equal(plan.nonUniform, false);
  });

  it("目标小于显示长边时不报错，只标记 belowDisplay", () => {
    const plan = planContentUpscale(750, 500, 6000, 4000, 4096);
    assert.equal(plan.belowDisplay, true);
    const enough = planContentUpscale(750, 500, 6000, 4000, 6000);
    assert.equal(enough.belowDisplay, false);
  });

  it("目标与原始/显示尺寸都不做拦截", () => {
    // 显示 6000 远大于目标 4096，但原始 750 小于目标 → 允许
    assert.doesNotThrow(() => planContentUpscale(750, 500, 6000, 4000, 4096));
    // 目标小于原始长边（12288）也允许，只是结果比原图小
    const small = planContentUpscale(12288, 8192, 3000, 2000, 4096);
    assert.equal(small.width, 4096);
    assert.equal(small.height, 2731);
    assert.ok(Math.abs(small.scale - 1 / 3) < 0.001);
  });

  it("非等比缩放标记 nonUniform", () => {
    assert.equal(planContentUpscale(1000, 1000, 2000, 3000, 4096).nonUniform, true);
    assert.equal(planContentUpscale(1000, 1000, 2000, 2000, 4096).nonUniform, false);
  });

  it("未放大（显示 = 原始）时 displayScale 为 1", () => {
    const plan = planContentUpscale(1000, 500, 1000, 500, 4096);
    assert.equal(plan.displayScale, 1);
    assert.equal(plan.belowDisplay, false);
  });
});

describe("buildUpscaleArgs", () => {
  it("拼装 FILE 形式参数（不带 CLI 不支持的 --yes）", () => {
    assert.deepEqual(buildUpscaleArgs("/tmp/a.png", "/tmp/b.png", 4096), [
      "upscale",
      "/tmp/a.png",
      "/tmp/b.png",
      "--long-side",
      "4096",
    ]);
  });

  it("路径为空时拒绝", () => {
    assert.throws(() => buildUpscaleArgs("", "/tmp/b.png", 4096), /路径不能为空/);
  });
});
