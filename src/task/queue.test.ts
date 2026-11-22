import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_HARD_LIMIT,
  QUEUE_LIMIT,
  capacityForLane,
  classifyWaitOutcome,
  enforceHardLimitOnLoad,
  findEvictableFinishedJob,
  isRetentionExpired,
  laneForJob,
  laneForProvider,
  normalizeCancelVerdict,
  planCancel,
  planFailure,
  selectRunnableJobs,
  transitionJob,
  type QueueJob,
} from "./queue";

const job = (patch: Partial<QueueJob> = {}): QueueJob => ({
  id: patch.id ?? `j-${Math.random().toString(36).slice(2, 8)}`,
  prompt: "测试",
  providerId: "ark",
  docId: 1,
  docName: "未命名-1",
  originalBounds: { left: 0, top: 0, right: 10, bottom: 10 },
  expanded: { bounds: { left: 0, top: 0, right: 32, bottom: 32 }, width: 32, height: 32 },
  captureRect: { left: 0, top: 0, right: 32, bottom: 32 },
  sizeMode: "auto",
  sendWidth: 32,
  sendHeight: 32,
  reqW: 32,
  reqH: 32,
  refPath: "/tmp/ref.png",
  maskPath: "/tmp/mask.bin",
  sendMaskPath: "/tmp/mask-send.bin",
  maskPngPath: "/tmp/mask.png",
  status: "queued",
  stage: "queued",
  lane: "network",
  createdAt: 1,
  attempts: 0,
  ...patch,
});

describe("queue lane 与容量", () => {
  it("Siliconed / IOPaint 单飞，其余按并发数", () => {
    assert.equal(laneForProvider("siliconed"), "siliconed");
    assert.equal(laneForProvider("iopaint"), "iopaint");
    assert.equal(laneForProvider("ark"), "network");
    assert.equal(capacityForLane("siliconed", 4), 1);
    assert.equal(capacityForLane("iopaint", 4), 1);
    assert.equal(capacityForLane("place", 4), 1);
    assert.equal(capacityForLane("network", 4), 4);
    assert.equal(capacityForLane("network", 0), 1, "非法并发数回退 1");
  });

  it("pendingPlace + placing 走 place lane", () => {
    const placing = job({ status: "pendingPlace", stage: "placing" });
    assert.equal(laneForJob(placing), "place");
    const waiting = job({ status: "pendingPlace", stage: "generating" });
    assert.equal(laneForJob(waiting), "network");
  });
});

describe("queue 状态机", () => {
  it("合法流转：queued → running → pendingPlace → completed", () => {
    let cur = job();
    cur = transitionJob(cur, "running", { startedAt: 2 });
    cur = transitionJob(cur, "pendingPlace", { autoPlace: true });
    cur = transitionJob(cur, "completed", { finishedAt: 3 });
    assert.equal(cur.status, "completed");
    assert.equal(cur.autoPlace, true);
  });

  it("非法流转直接抛错（completed 不可回退）", () => {
    const done = job({ status: "completed" });
    assert.throws(() => transitionJob(done, "running"), /非法状态流转/);
  });

  it("取消待贴回可回到 pendingPlace 重新贴回", () => {
    const cancelled = job({ status: "cancelled", resultPath: "/tmp/r.png" });
    assert.equal(transitionJob(cancelled, "pendingPlace").status, "pendingPlace");
  });
});

describe("queue 单飞调度选择", () => {
  it("同一 Siliconed lane 只选 1 个（FIFO）", () => {
    const a = job({ id: "a", providerId: "siliconed", createdAt: 1 });
    const b = job({ id: "b", providerId: "siliconed", createdAt: 2 });
    const picked = selectRunnableJobs([b, a], { active: {}, concurrency: 4 });
    assert.deepEqual(
      picked.map((p) => p.id),
      ["a"],
    );
  });

  it("单飞 lane 满载时不阻塞其他 lane", () => {
    const a = job({ id: "a", providerId: "siliconed", createdAt: 1 });
    const b = job({ id: "b", providerId: "ark", createdAt: 2 });
    const picked = selectRunnableJobs([a, b], { active: {}, concurrency: 2 });
    assert.deepEqual(
      picked.map((p) => p.id).sort(),
      ["a", "b"],
    );
  });

  it("network lane 按并发上限截断", () => {
    const jobs = [1, 2, 3].map((n) => job({ id: `n${n}`, createdAt: n }));
    const picked = selectRunnableJobs(jobs, { active: { network: 1 }, concurrency: 2 });
    assert.equal(picked.length, 1, "已有 1 个在跑，容量 2 只能再起 1 个");
    assert.equal(picked[0].id, "n1");
  });

  it("pendingPlace 只在 autoPlace 时自动进入 place lane，且一次只贴 1 个", () => {
    const manual = job({ id: "m", status: "pendingPlace", autoPlace: false });
    const auto1 = job({ id: "a1", status: "pendingPlace", autoPlace: true, createdAt: 2 });
    const auto2 = job({ id: "a2", status: "pendingPlace", autoPlace: true, createdAt: 3 });
    const picked = selectRunnableJobs([manual, auto1, auto2], {
      active: {},
      concurrency: 4,
    });
    assert.deepEqual(
      picked.map((p) => p.id),
      ["a1"],
    );
  });

  it("paused：生成任务（queued）全部跳过，自动贴回照常", () => {
    const a = job({ id: "a", providerId: "ark", createdAt: 1 });
    const place = job({ id: "p", status: "pendingPlace", autoPlace: true, createdAt: 2 });
    const picked = selectRunnableJobs([a, place], {
      active: {},
      concurrency: 4,
      paused: true,
    });
    assert.deepEqual(
      picked.map((p) => p.id),
      ["p"],
      "暂停拦截出队（生成）但放行贴回",
    );
  });

  it("paused 缺省（旧调用方）行为不变", () => {
    const a = job({ id: "a", providerId: "ark", createdAt: 1 });
    const picked = selectRunnableJobs([a], { active: {}, concurrency: 4 });
    assert.deepEqual(picked.map((p) => p.id), ["a"]);
  });
});

describe("queue 重试策略", () => {
  it("提交前 retryable 自动重试 1 次", () => {
    assert.equal(planFailure({ attempts: 0, autoRetryUsed: false }, "retryable"), "auto-retry");
  });

  it("拿到远端 job id 后不自动重投（避免远端白跑）", () => {
    assert.equal(
      planFailure({ attempts: 0, autoRetryUsed: false, remoteJobId: "t3" }, "retryable"),
      "fail",
    );
  });

  it("轮询超时不自动重投", () => {
    assert.equal(planFailure({ attempts: 0, autoRetryUsed: false }, "timeout"), "fail");
  });

  it("已经自动重试过 / 超过次数 → 失败", () => {
    assert.equal(planFailure({ attempts: 1, autoRetryUsed: true }, "retryable"), "fail");
    assert.equal(planFailure({ attempts: 2, autoRetryUsed: false }, "retryable"), "fail");
  });
});

describe("queue 取消语义", () => {
  it("排队中的取消直接移出队列", () => {
    assert.equal(planCancel(job({ status: "queued" })).action, "drop-now");
  });

  it("待贴回取消保留生成结果", () => {
    const plan = planCancel(job({ status: "pendingPlace", resultPath: "/tmp/r.png" }));
    assert.equal(plan.action, "drop-now");
    assert.equal(plan.keepResult, true);
  });

  it("Siliconed running 且拿到 job id → 真取消", () => {
    const plan = planCancel(
      job({ status: "running", providerId: "siliconed", remoteJobId: "t3" }),
    );
    assert.equal(plan.action, "cancel-remote");
    assert.equal(plan.remoteJobId, "t3");
  });

  it("Siliconed 尚未拿到 job id / 其他平台 → 逻辑取消", () => {
    assert.equal(
      planCancel(job({ status: "running", providerId: "siliconed" })).action,
      "logical",
    );
    assert.equal(
      planCancel(job({ status: "running", providerId: "ark" })).action,
      "logical",
    );
  });
});

describe("queue cancel / wait verdict 解析", () => {
  it("cancel 返回 stopped / removed / already_finished", () => {
    const parsed = normalizeCancelVerdict({
      ok: true,
      stopped: "t3",
      removed: ["t4"],
      already_finished: ["t5"],
    });
    assert.deepEqual(parsed.stopped, ["t3"]);
    assert.deepEqual(parsed.removed, ["t4"]);
    assert.deepEqual(parsed.alreadyFinished, ["t5"]);
  });

  it("wait 的 stopped / removed 不能记成失败", () => {
    const picked = classifyWaitOutcome({
      ok: false,
      jobs: [{ job: "t3", outcome: "stopped" }],
    });
    assert.equal(picked.cancelled, true);
    assert.equal(picked.failed, false);
    assert.deepEqual(picked.outcomes, ["stopped"]);
  });

  it("wait 的 error 才是失败，done 表示正常完成", () => {
    assert.equal(
      classifyWaitOutcome({ ok: false, jobs: [{ job: "t3", outcome: "error" }] }).failed,
      true,
    );
    const ok = classifyWaitOutcome({ ok: true, jobs: [{ job: "t3", outcome: "done" }] });
    assert.equal(ok.done, true);
    assert.equal(ok.failed, false);
  });
});

describe("queue 裁剪与保留期", () => {
  it("淘汰位只取 completed / cancelled（failed 可重试，不参与淘汰）", () => {
    const jobs = [
      job({ id: "q0", createdAt: 0 }),
      job({ id: "q1", createdAt: 1, status: "completed" }),
      job({ id: "q2", createdAt: 2, status: "failed" }),
      job({ id: "q3", createdAt: 3, status: "cancelled" }),
    ];
    assert.equal(
      findEvictableFinishedJob(jobs)?.id,
      "q1",
      "completed/cancelled 里取最旧，跳过 failed 与排队项",
    );
    assert.equal(QUEUE_LIMIT, 20, "终态保留上限");
    assert.equal(QUEUE_HARD_LIMIT, 200, "失控保护总上限");
  });

  it("全是非终态时没有可淘汰项（不挤掉排队/运行中/失败的任务）", () => {
    const jobs = Array.from({ length: QUEUE_LIMIT }, (_, i) =>
      job({ id: `q${i}`, createdAt: i }),
    );
    assert.equal(findEvictableFinishedJob(jobs), undefined);
  });

  it("enforceHardLimitOnLoad：未执行项全保留，超限时先裁最旧终态", () => {
    const many = Array.from({ length: 198 }, (_, i) =>
      job({ id: `q${i}`, createdAt: 10 + i, status: "queued" }),
    );
    const withFinished = [
      job({ id: "old-1", createdAt: 0, status: "completed" }),
      job({ id: "old-2", createdAt: 1, status: "cancelled" }),
      job({ id: "old-3", createdAt: 2, status: "completed" }),
      job({ id: "old-4", createdAt: 3, status: "cancelled" }),
      ...many,
    ];
    const trimmed = enforceHardLimitOnLoad(withFinished, 200);
    assert.equal(trimmed.length, 200);
    assert.ok(!trimmed.some((j) => j.id === "old-1"), "最旧终态先被裁（溢出 2 条）");
    assert.ok(!trimmed.some((j) => j.id === "old-2"));
    assert.ok(trimmed.some((j) => j.id === "old-3"), "未执行项全保留，终态裁到刚好为止");
    assert.ok(trimmed.some((j) => j.id === "old-4"));
    assert.ok(trimmed.some((j) => j.id === "q0"), "排队项一个不少");
  });

  it("enforceHardLimitOnLoad：裁完终态仍超出才从最旧截断（保底）", () => {
    const many = Array.from({ length: 201 }, (_, i) =>
      job({ id: `q${i}`, createdAt: 10 + i, status: "queued" }),
    );
    const trimmed = enforceHardLimitOnLoad(many, 200);
    assert.equal(trimmed.length, 200);
    assert.equal(trimmed[0].id, "q1", "无终态可裁时从最旧的排队项开始截断");
  });

  it("失败项 7 天后到期", () => {
    const now = Date.now();
    assert.equal(isRetentionExpired({ createdAt: now - 8 * 24 * 3600 * 1000 }, now), true);
    assert.equal(isRetentionExpired({ createdAt: now - 6 * 24 * 3600 * 1000 }, now), false);
  });
});
