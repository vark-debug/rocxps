import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  depthBufferOption,
  parseComponentDepth,
  scaleSamplesToDepth,
} from "./bitDepth";

describe("parseComponentDepth", () => {
  it("数值与字符串形式：8/16/32", () => {
    assert.equal(parseComponentDepth(8), 8);
    assert.equal(parseComponentDepth(16), 16);
    assert.equal(parseComponentDepth(32), 32);
    assert.equal(parseComponentDepth("8"), 8);
    assert.equal(parseComponentDepth("16"), 16);
    assert.equal(parseComponentDepth("32"), 32);
  });

  it("UnitValue 包装对象（DOM 属性可能返回 {_value,_unit}）", () => {
    assert.equal(parseComponentDepth({ _value: 16, _unit: "integer" }), 16);
    assert.equal(parseComponentDepth({ _value: 32, _unit: "integer" }), 32);
  });

  it("无法识别时回退 8 位（历史行为）", () => {
    assert.equal(parseComponentDepth(undefined), 8);
    assert.equal(parseComponentDepth(null), 8);
    assert.equal(parseComponentDepth(""), 8);
    assert.equal(parseComponentDepth("bogus"), 8);
    assert.equal(parseComponentDepth({}), 8);
  });

  it("子串判定与既有 includes 惯例一致", () => {
    assert.equal(parseComponentDepth("Depth 16"), 16);
    assert.equal(parseComponentDepth("Depth 32"), 32);
  });
});

describe("scaleSamplesToDepth", () => {
  it("8 位：原样返回（零拷贝，历史行为不变）", () => {
    const src = new Uint8Array([0, 1, 128, 255]);
    assert.equal(scaleSamplesToDepth(src, 8), src);
  });

  it("16 位减范围：0..255 → 0..32768（fullRange:false 的 PS 原生范围）", () => {
    const out = scaleSamplesToDepth(new Uint8Array([0, 1, 128, 254, 255]), 16);
    assert.ok(out instanceof Uint16Array);
    assert.deepEqual(
      Array.from(out),
      [0, 129, 16448, 32639, 32768],
    );
  });

  it("16 位：技术像素 alpha=1/255 → 129（近零但非零）", () => {
    const out = scaleSamplesToDepth(new Uint8Array([0, 0, 0, 1]), 16);
    assert.ok(out instanceof Uint16Array);
    assert.deepEqual(Array.from(out), [0, 0, 0, 129]);
  });

  it("32 位：Float32 [0..1]，255 → 1.0", () => {
    const out = scaleSamplesToDepth(new Uint8Array([0, 1, 128, 255]), 32);
    assert.ok(out instanceof Float32Array);
    assert.equal(out[0], 0);
    assert.ok(Math.abs(out[1] - 1 / 255) < 1e-6);
    assert.ok(Math.abs(out[2] - 128 / 255) < 1e-6);
    assert.equal(out[3], 1);
  });

  it("长度保持不变（RGBA 4 分量 / 灰度 1 分量通用）", () => {
    const rgba = new Uint8Array(4 * 7);
    assert.equal(scaleSamplesToDepth(rgba, 16).length, 28);
    assert.equal(scaleSamplesToDepth(rgba, 32).length, 28);
    const gray = new Uint8Array(100);
    assert.equal(scaleSamplesToDepth(gray, 16).length, 100);
    assert.equal(scaleSamplesToDepth(gray, 32).length, 100);
  });
});

describe("depthBufferOption", () => {
  it("16 位显式声明减范围 fullRange:false", () => {
    assert.deepEqual(depthBufferOption(16), { fullRange: false });
  });

  it("8/32 位无 fullRange 参数", () => {
    assert.deepEqual(depthBufferOption(8), {});
    assert.deepEqual(depthBufferOption(32), {});
    assert.equal(Object.keys(depthBufferOption(8)).length, 0);
    assert.equal(Object.keys(depthBufferOption(32)).length, 0);
  });
});
