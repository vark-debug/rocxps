import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeExpandPads,
  EXPAND_MAX_SAMPLE_DEFAULT,
  EXPAND_PAD_MAX,
  formatPadArg,
  normalizeExpandMaxSample,
  normalizePanelWorkflow,
  type PadPercent,
} from "./expandPlan";

describe("computeExpandPads", () => {
  it("居中包围盒：四边 pad 相等，逻辑画布等于扩展画布", () => {
    // 源图 800×700 居中放在 1200×900 画布：四边各 200/100 → 25%/14.29%
    const plan = computeExpandPads(
      { left: 200, top: 100, right: 1000, bottom: 800 },
      1200,
      900,
    );
    assert.equal(plan.pads.left, 25);
    assert.equal(plan.pads.right, 25);
    assert.equal(plan.pads.top, 14.29);
    assert.equal(plan.pads.bottom, 14.29);
    assert.equal(plan.clamped, false);
    assert.deepEqual(plan.warnings, []);
    assert.equal(plan.logicalWidth, 1200);
    assert.equal(plan.logicalHeight, 900);
  });

  it("不居中包围盒：四边独立计算", () => {
    // 源图 1000×1000 贴近左上角，画布 1600×1600
    const plan = computeExpandPads(
      { left: 0, top: 0, right: 1000, bottom: 1000 },
      1600,
      1600,
    );
    assert.equal(plan.pads.left, 0);
    assert.equal(plan.pads.top, 0);
    assert.equal(plan.pads.right, 60);
    assert.equal(plan.pads.bottom, 60);
    assert.equal(plan.logicalWidth, 1600);
    assert.equal(plan.logicalHeight, 1600);
  });

  it("单边外扩：其余三边为 0", () => {
    const plan = computeExpandPads(
      { left: 0, top: 0, right: 800, bottom: 600 },
      1600,
      600,
    );
    assert.equal(plan.pads.right, 100);
    assert.equal(plan.pads.left, 0);
    assert.equal(plan.pads.top, 0);
    assert.equal(plan.pads.bottom, 0);
    assert.equal(plan.logicalWidth, 1600);
    assert.equal(plan.logicalHeight, 600);
  });

  it("超过 200% 截断并记 warning", () => {
    // 源图 100×100 贴左上，画布右侧留 400 → 400%，截断到 200%
    const plan = computeExpandPads(
      { left: 0, top: 0, right: 100, bottom: 100 },
      500,
      100,
    );
    assert.equal(plan.pads.right, EXPAND_PAD_MAX);
    assert.equal(plan.clamped, true);
    assert.ok(plan.warnings.some((w) => w.includes("右侧")));
    // 逻辑画布只反映 clamp 后的比例：100 × (1+2) = 300，小于画布 500
    assert.equal(plan.logicalWidth, 300);
  });

  it("源图等于画布（未外扩）抛错", () => {
    assert.throws(
      () => computeExpandPads({ left: 0, top: 0, right: 800, bottom: 600 }, 800, 600),
      /画布未外扩/,
    );
  });

  it("空包围盒 / 超画布包围盒抛错", () => {
    assert.throws(
      () => computeExpandPads({ left: 10, top: 0, right: 10, bottom: 100 }, 800, 600),
      /为空/,
    );
    assert.throws(
      () => computeExpandPads({ left: 0, top: 0, right: 900, bottom: 600 }, 800, 600),
      /超出画布/,
    );
  });
});

describe("normalizePanelWorkflow", () => {
  it("expand 保留，其余回退 selection", () => {
    assert.equal(normalizePanelWorkflow("expand"), "expand");
    assert.equal(normalizePanelWorkflow("selection"), "selection");
    assert.equal(normalizePanelWorkflow("unknown"), "selection");
    assert.equal(normalizePanelWorkflow(undefined), "selection");
    assert.equal(normalizePanelWorkflow(null), "selection");
    assert.equal(normalizePanelWorkflow(42), "selection");
  });
});

describe("normalizeExpandMaxSample", () => {
  it("默认值合法", () => {
    assert.equal(normalizeExpandMaxSample(EXPAND_MAX_SAMPLE_DEFAULT), 2048);
  });

  it("clamp 到范围并 snap 到 128 倍数", () => {
    assert.equal(normalizeExpandMaxSample(512), 1024);
    assert.equal(normalizeExpandMaxSample(5000), 3840);
    assert.equal(normalizeExpandMaxSample(1500), 1536);
    assert.equal(normalizeExpandMaxSample(2048), 2048);
  });

  it("非法输入回退默认", () => {
    assert.equal(normalizeExpandMaxSample(undefined), EXPAND_MAX_SAMPLE_DEFAULT);
    assert.equal(normalizeExpandMaxSample(null), EXPAND_MAX_SAMPLE_DEFAULT);
    assert.equal(normalizeExpandMaxSample("abc"), EXPAND_MAX_SAMPLE_DEFAULT);
    assert.equal(normalizeExpandMaxSample(-10), EXPAND_MAX_SAMPLE_DEFAULT);
    assert.equal(normalizeExpandMaxSample(0), EXPAND_MAX_SAMPLE_DEFAULT);
    assert.equal(normalizeExpandMaxSample(Number.NaN), EXPAND_MAX_SAMPLE_DEFAULT);
  });
});

describe("formatPadArg", () => {
  it("顺序为 L,R,T,B，两位小数", () => {
    const pads: PadPercent = { left: 30, top: 12.5, right: 33.333, bottom: 0 };
    assert.equal(formatPadArg(pads), "30.00,33.33,12.50,0.00");
  });

  it("整数也保留两位小数", () => {
    assert.equal(formatPadArg({ left: 200, top: 0, right: 0, bottom: 100 }), "200.00,0.00,0.00,100.00");
  });
});
