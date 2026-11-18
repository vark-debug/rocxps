import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  emptySiliconMacs,
  isMacUnusable,
  macStateReason,
  macStateText,
  normalizeSiliconMacs,
  normalizeSiliconTarget,
  normalizeSiliconTargetPolicy,
  planComputeTarget,
  targetLabel,
  type SiliconMacsSnapshot,
} from "./siliconedTarget";

const snapshot = (
  over: Partial<SiliconMacsSnapshot> = {},
): SiliconMacsSnapshot => ({
  supported: true,
  macs: [
    { id: "studio", name: "A 的 Mac Studio", state: "connected", computing: false },
  ],
  computingOn: null,
  pairingsRead: true,
  lending: false,
  ...over,
});

describe("normalizeSiliconMacs", () => {
  it("解析 macs 列表与 computing_on（snake_case → camelCase）", () => {
    const result = normalizeSiliconMacs({
      ok: true,
      computing_on: "A 的 Mac Studio",
      pairings_read: true,
      lending: true,
      macs: [
        {
          id: "studio",
          name: "A 的 Mac Studio",
          state: "on_the_network",
          computing: true,
          machine: "Mac Studio (M4 Max)",
        },
      ],
    });
    assert.equal(result.supported, true);
    assert.equal(result.computingOn, "A 的 Mac Studio");
    assert.equal(result.pairingsRead, true);
    assert.equal(result.lending, true);
    assert.equal(result.macs[0].id, "studio");
    assert.equal(result.macs[0].state, "on_the_network");
    assert.equal(result.macs[0].computing, true);
    assert.equal(result.macs[0].machine, "Mac Studio (M4 Max)");
  });

  it("缺失字段不崩：computing_on=null、macs=[]", () => {
    const result = normalizeSiliconMacs({ ok: true });
    assert.equal(result.computingOn, null);
    assert.deepEqual(result.macs, []);
    assert.equal(result.pairingsRead, false);
  });
});

describe("state 文案", () => {
  it("已知 state 给中文说明，未知 state 原样展示", () => {
    assert.equal(macStateText("connected"), "已连接");
    assert.equal(macStateText("refused_version"), "两端版本不一致");
    assert.equal(macStateText("something_new"), "something_new");
    assert.equal(macStateText(""), "状态未知");
  });

  it("不可用 state 带下一步动作；可用 state 不拦", () => {
    assert.equal(isMacUnusable("not_on_the_network"), true);
    assert.equal(isMacUnusable("refused_forgotten"), true);
    assert.equal(isMacUnusable("refused_version"), true);
    assert.equal(isMacUnusable("on_the_network"), false);
    assert.equal(isMacUnusable("lost"), false);
    assert.match(macStateReason("refused_version"), /同一版本/);
    assert.match(macStateReason("refused_forgotten"), /重新配对/);
  });

  it("targetLabel：null → 本机", () => {
    assert.equal(targetLabel(null), "本机");
    assert.equal(targetLabel("A 的 Mac Studio"), "A 的 Mac Studio");
  });
});

describe("planComputeTarget：本机目标", () => {
  it("computing_on=null → ok", () => {
    const check = planComputeTarget(
      { target: "local", policy: "auto" },
      snapshot(),
    );
    assert.equal(check.kind, "ok");
    assert.equal(check.actual, null);
  });

  it("auto 策略下实际在远端 → 切回本机（compute this）", () => {
    const check = planComputeTarget(
      { target: "local", policy: "auto" },
      snapshot({ computingOn: "A 的 Mac Studio" }),
    );
    assert.equal(check.kind, "switch");
    assert.equal(check.computeArg, "this");
    assert.equal(check.targetLabel, "本机");
  });

  it("warn 策略下实际在远端 → mismatch，按实际执行", () => {
    const check = planComputeTarget(
      { target: "local", policy: "warn" },
      snapshot({ computingOn: "A 的 Mac Studio" }),
    );
    assert.equal(check.kind, "mismatch");
    assert.equal(check.actual, "A 的 Mac Studio");
    assert.match(check.message ?? "", /实际在「A 的 Mac Studio」/);
  });
});

describe("planComputeTarget：指定 Mac", () => {
  it("已连接且实际就是目标 → ok", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "studio", policy: "auto" },
      snapshot({ computingOn: "A 的 Mac Studio" }),
    );
    assert.equal(check.kind, "ok");
  });

  it("on_the_network 视为可切换（可通过 compute 建立会话）", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "studio", policy: "auto" },
      snapshot({
        computingOn: null,
        macs: [
          { id: "studio", name: "A 的 Mac Studio", state: "on_the_network", computing: false },
        ],
      }),
    );
    assert.equal(check.kind, "switch");
    assert.equal(check.computeArg, "A 的 Mac Studio");
  });

  it("按名称也能匹配已保存的目标", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "A 的 Mac Studio", policy: "auto" },
      snapshot({ computingOn: null }),
    );
    assert.equal(check.kind, "switch");
    assert.equal(check.computeArg, "A 的 Mac Studio");
  });

  it("离线 → blocked 且明确原因", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "studio", policy: "auto" },
      snapshot({
        macs: [
          { id: "studio", name: "A 的 Mac Studio", state: "not_on_the_network", computing: false },
        ],
      }),
    );
    assert.equal(check.kind, "blocked");
    assert.match(check.message ?? "", /不在局域网内/);
  });

  it("refused_version → blocked 且提示两端同版本", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "studio", policy: "warn" },
      snapshot({
        macs: [
          { id: "studio", name: "A 的 Mac Studio", state: "refused_version", computing: false },
        ],
      }),
    );
    assert.equal(check.kind, "blocked");
    assert.match(check.message ?? "", /同一版本/);
  });

  it("refused_forgotten → blocked 且提示重新配对", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "studio", policy: "auto" },
      snapshot({
        macs: [
          { id: "studio", name: "A 的 Mac Studio", state: "refused_forgotten", computing: false },
        ],
      }),
    );
    assert.equal(check.kind, "blocked");
    assert.match(check.message ?? "", /重新配对/);
  });

  it("目标不在列表 → blocked", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "gone", policy: "auto" },
      snapshot(),
    );
    assert.equal(check.kind, "blocked");
    assert.match(check.message ?? "", /没有找到已配对的 Mac/);
  });

  it("warn 策略下实际是别的 Mac → mismatch", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "studio", policy: "warn" },
      snapshot({ computingOn: "B 的 MacBook" }),
    );
    assert.equal(check.kind, "mismatch");
    assert.match(check.message ?? "", /按实际目标执行/);
  });

  it("0.18/0.19 没有 macs → blocked 并提示升级，不崩", () => {
    const check = planComputeTarget(
      { target: "mac", macId: "studio", policy: "auto" },
      emptySiliconMacs(false),
    );
    assert.equal(check.kind, "blocked");
    assert.match(check.message ?? "", /0\.20/);
  });

  it("0.18/0.19 但目标是本机 → 正常本地执行", () => {
    const check = planComputeTarget(
      { target: "local", policy: "auto" },
      emptySiliconMacs(false),
    );
    assert.equal(check.kind, "ok");
  });
});

describe("设置值归一化", () => {
  it("非法值回退本机 / auto", () => {
    assert.equal(normalizeSiliconTarget("mac"), "mac");
    assert.equal(normalizeSiliconTarget("remote"), "local");
    assert.equal(normalizeSiliconTargetPolicy("warn"), "warn");
    assert.equal(normalizeSiliconTargetPolicy("other"), "auto");
  });
});
