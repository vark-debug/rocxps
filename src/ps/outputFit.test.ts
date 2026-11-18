import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { outputSizeNote, planOutputFit } from "./placeBackGeometry";

describe("planOutputFit（输出尺寸校验）", () => {
  it("实际尺寸 == 请求尺寸：不标记 mismatch，按实际尺寸缩放比一致", () => {
    const plan = planOutputFit(896, 1152, 896, 1152, 896, 1152);
    assert.equal(plan.outputMismatch, false);
    assert.equal(plan.stretched, false);
    assert.deepEqual(plan.appliedScale, { x: 1, y: 1 });
    assert.equal(outputSizeNote(plan, 896, 1152), undefined);
  });

  it("实际尺寸 != 请求尺寸：标记 mismatch，并记录 sx/sy", () => {
    // 实测案例：请求 896×1152，工具返回 864×1184
    const plan = planOutputFit(864, 1184, 896, 1152, 896, 1152);
    assert.equal(plan.outputMismatch, true);
    assert.equal(plan.actualW, 864);
    assert.equal(plan.actualH, 1184);
    assert.deepEqual(plan.appliedScale, {
      x: 896 / 864,
      y: 1152 / 1184,
    });
    assert.equal(plan.stretched, true, "两轴缩放比不等应标记拉伸");
    const note = outputSizeNote(plan, 896, 1152);
    assert.ok(note?.includes("工具返回 864×1184"));
    assert.ok(note?.includes("与请求 896×1152 不一致"));
    assert.ok(note?.includes("两轴缩放比不同"));
  });

  it("等比但尺寸不同：mismatch 但不标记拉伸", () => {
    const plan = planOutputFit(1792, 2304, 896, 1152, 896, 1152);
    assert.equal(plan.outputMismatch, true);
    assert.equal(plan.stretched, false);
    assert.deepEqual(plan.appliedScale, { x: 0.5, y: 0.5 });
    const note = outputSizeNote(plan, 896, 1152);
    assert.ok(note?.includes("已按实际尺寸贴回"));
    assert.ok(!note?.includes("拉伸"));
  });

  it("非法尺寸抛错", () => {
    assert.throws(() => planOutputFit(0, 100, 100, 100, 100, 100));
    assert.throws(() => planOutputFit(100, 100, 0, 100, 100, 100));
    assert.throws(() => planOutputFit(100, 100, 100, 100, 0, 100));
  });
});
