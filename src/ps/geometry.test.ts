import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { expandRectToAspect, expandRectToMultiple, padAmountsOf } from "./geometry";
import type { Rect } from "./types";

const rect = (l: number, t: number, r: number, b: number): Rect => ({
  left: l,
  top: t,
  right: r,
  bottom: b,
});

const contains = (outer: Rect, inner: Rect): boolean =>
  outer.left <= inner.left &&
  outer.top <= inner.top &&
  outer.right >= inner.right &&
  outer.bottom >= inner.bottom;

const ratio = (r: Rect): number =>
  (r.right - r.left) / (r.bottom - r.top);

describe("expandRectToAspect（预设路径）", () => {
  it("选区偏宽 → 扩高到目标比例，且仍包含原选区", () => {
    const sel = rect(500, 200, 900, 500); // 400×300 比例 1.333
    const out = expandRectToAspect(sel, 1920, 1080, 896, 1152); // 0.778
    assert.equal(out.width, 400);
    assert.equal(out.height, Math.ceil(400 / (896 / 1152)));
    assert.ok(contains(out.bounds, sel), "扩展后必须完整包含原选区");
    // 以选区中心为中心：左右各扩 0，上下尽量对称
    assert.equal(out.bounds.left, 500);
    assert.equal(out.bounds.right, 900);
  });

  it("选区偏窄 → 扩宽到目标比例", () => {
    const sel = rect(100, 100, 900, 1100); // 800×1000 比例 0.8
    const out = expandRectToAspect(sel, 1920, 2160, 1152, 896); // 1.286
    assert.equal(out.height, 1000);
    assert.equal(out.width, Math.ceil(1000 * (1152 / 896)));
    assert.ok(contains(out.bounds, sel));
  });

  it("比例已一致时只扩不缩：尺寸保持不变", () => {
    const sel = rect(100, 200, 800, 1100);
    const out = expandRectToAspect(sel, 1920, 2160, 896, 1152);
    assert.ok(contains(out.bounds, sel));
    assert.ok(ratio(out.bounds) > 0.77 && ratio(out.bounds) < 0.79);
    assert.ok(out.width >= 700 && out.height >= 900);
  });

  it("扩展后越出画布 → 平移回画布内（不裁剪），pad 左右不对称", () => {
    const sel = rect(600, 100, 700, 500); // 靠右，100×400 比例 0.25
    const out = expandRectToAspect(sel, 800, 600, 1152, 896); // 需要扩宽
    assert.ok(contains(out.bounds, sel), "平移后仍必须包含原选区");
    assert.equal(out.bounds.right, 800, "应贴到画布右边界");
    assert.equal(out.bounds.left, 800 - out.width);
    assert.ok(out.bounds.left >= 0);
    const pads = padAmountsOf(sel, out);
    assert.deepEqual(pads, {
      left: sel.left - out.bounds.left,
      top: 0,
      right: out.bounds.right - sel.right,
      bottom: out.bounds.bottom - sel.bottom,
    });
    assert.ok(pads.left + pads.right === out.width - 100, "左右外扩之和 = 扩宽量");
    assert.ok(pads.left > 0 && pads.right > 0, "平移后左右外扩不对称");
  });

  it("扩展后越出画布顶部 → 下移回画布内", () => {
    const sel = rect(100, 10, 500, 310); // 400×300 比例 1.333
    const out = expandRectToAspect(sel, 800, 600, 896, 1152);
    assert.ok(contains(out.bounds, sel));
    assert.equal(out.bounds.top, 0);
    assert.ok(out.bounds.bottom <= 600);
  });

  it("画布装不下扩展尺寸 → 进入补边模式并记录 padInfo", () => {
    const sel = rect(0, 0, 100, 100);
    const out = expandRectToAspect(sel, 100, 100, 1152, 896); // 需要 129 宽
    assert.ok(out.padInfo, "应产生补边信息");
    assert.equal(out.padInfo?.padLeft, Math.floor((out.width - 100) / 2));
    assert.equal(
      out.padInfo?.padLeft + out.padInfo?.padRight,
      out.width - 100,
    );
    assert.ok(contains(out.bounds, sel) || out.padInfo?.padLeft! > 0);
  });

  it("非法参数抛错", () => {
    assert.throws(() => expandRectToAspect(rect(0, 0, 0, 10), 100, 100, 896, 1152));
    assert.throws(() => expandRectToAspect(rect(0, 0, 200, 10), 100, 100, 896, 1152));
    assert.throws(() => expandRectToAspect(rect(0, 0, 10, 10), 100, 100, 0, 1152));
  });
});

describe("Siliconed 1.4× 选区外扩", () => {
  it("预设路径：先等比外扩，再补足预设比例（比例不变时不额外扩）", () => {
    const sel = rect(500, 200, 900, 500); // 400×300 = 4:3
    const out = expandRectToAspect(sel, 1920, 1080, 1024, 768, 1.4);
    assert.equal(out.width, 560, "400 × 1.4");
    assert.equal(out.height, 420, "300 × 1.4");
    assert.ok(contains(out.bounds, sel));
    // 中心基准：左右各 80、上下各 60
    assert.equal(out.bounds.left, 420);
    assert.equal(out.bounds.top, 140);
  });

  it("外扩后越出画布 → 整体平移回画布内，不裁剪也不补边", () => {
    const sel = rect(600, 100, 700, 500); // 靠右 100×400
    const out = expandRectToAspect(sel, 800, 600, 1152, 896, 1.4);
    assert.ok(contains(out.bounds, sel));
    assert.equal(out.bounds.right, 800, "应贴到画布右边界");
    assert.equal(out.bounds.left, 800 - out.width);
    assert.equal(out.padInfo, undefined, "画布装得下时不应补边");
  });

  it("外扩后画布装不下 → 复用补边逻辑", () => {
    const sel = rect(0, 0, 100, 100);
    const out = expandRectToAspect(sel, 100, 100, 1024, 768, 1.4);
    assert.equal(out.height, 140, "100 × 1.4");
    assert.equal(out.width, 187, "补足 4:3 后取整");
    assert.ok(out.padInfo, "应产生补边信息");
    assert.equal(out.padInfo?.padLeft, 43);
  });

  it("32 对齐路径：外扩后再对齐，最终尺寸 ≥ 外扩尺寸", () => {
    const sel = rect(0, 0, 100, 100);
    const out = expandRectToMultiple(sel, 1000, 1000, 32, 1.4);
    assert.equal(out.width, 160, "140 向上对齐到 160");
    assert.equal(out.height, 160);
    assert.ok(contains(out.bounds, sel));
    assert.ok(out.bounds.left >= 0 && out.bounds.top >= 0);
  });

  it("系数小于 1 抛错", () => {
    assert.throws(() => expandRectToAspect(rect(0, 0, 10, 10), 100, 100, 896, 1152, 0.5));
  });
});
