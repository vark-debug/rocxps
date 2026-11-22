import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseQueue,
  planDiskCleanup,
  planOrphanDirs,
  recoverInterruptedJobs,
  serializeQueue,
} from "./queueStore";
import type { QueueJob } from "./queue";

const job = (patch: Partial<QueueJob>): QueueJob => ({
  id: patch.id ?? "j",
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

describe("queueStore 序列化", () => {
  it("round-trip 保留全部字段", () => {
    const jobs = [job({ id: "a", status: "failed", error: "网络错误" })];
    const parsed = parseQueue(serializeQueue(jobs));
    assert.equal(parsed.jobs.length, 1);
    assert.equal(parsed.jobs[0].id, "a");
    assert.equal(parsed.jobs[0].error, "网络错误");
  });

  it("暂停状态随队列持久化（缺省 false 兼容旧文件）", () => {
    const jobs = [job({ id: "a" })];
    assert.equal(parseQueue(serializeQueue(jobs)).paused, false);
    assert.equal(parseQueue(serializeQueue(jobs, true)).paused, true);
    // 旧文件无 paused 字段
    const legacy = JSON.stringify({ version: 1, jobs: [] });
    assert.equal(parseQueue(legacy).paused, false);
  });

  it("损坏 JSON / 缺字段条目被跳过，不拖垮整个队列", () => {
    assert.deepEqual(parseQueue("{不是 json").jobs, []);
    const text = JSON.stringify({
      version: 1,
      jobs: [{ id: "ok", prompt: "p", providerId: "ark", docId: 1, docName: "d",
        refPath: "r", maskPath: "m", sendMaskPath: "s", maskPngPath: "mp",
        status: "queued", createdAt: 1, attempts: 0 },
        { id: "bad" }],
    });
    const parsed = parseQueue(text);
    assert.deepEqual(parsed.jobs.map((j) => j.id), ["ok"]);
  });
});

describe("queueStore 启动恢复", () => {
  it("上一次会话的 running 标为 failed（可重试，不自动续跑）", () => {
    const now = 1000;
    const [recovered] = recoverInterruptedJobs(
      [job({ status: "running", remoteJobId: "t3", cancelRequestedAt: 5 })],
      now,
    );
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.stage, "queued");
    assert.equal(recovered.remoteJobId, undefined);
    assert.equal(recovered.cancelRequestedAt, undefined);
    assert.match(recovered.error ?? "", /重启/);
  });

  it("pendingPlace 保持原状（结果还在，用户可继续贴回）", () => {
    const [kept] = recoverInterruptedJobs(
      [job({ status: "pendingPlace", resultPath: "/tmp/r.png" })],
      1000,
    );
    assert.equal(kept.status, "pendingPlace");
    assert.equal(kept.resultPath, "/tmp/r.png");
  });
});

describe("queueStore 磁盘清理计划", () => {
  const now = 10 * 24 * 3600 * 1000; // 第 10 天

  it("失败项超过 7 天 → 清理文件", () => {
    const plan = planDiskCleanup(
      [
        job({ id: "old", status: "failed", finishedAt: now - 8 * 24 * 3600 * 1000 }),
        job({ id: "new", status: "failed", finishedAt: now - 24 * 3600 * 1000 }),
      ],
      { maxBytes: 100, now },
    );
    assert.deepEqual(plan.purge, ["old"]);
  });

  it("等原文档 / 待贴回 / 排队 / 运行永不清理", () => {
    const plan = planDiskCleanup(
      [
        job({ id: "missing", status: "failed", documentMissing: true, finishedAt: 0 }),
        job({ id: "pending", status: "pendingPlace", createdAt: 0 }),
        job({ id: "queued", status: "queued", createdAt: 0 }),
        job({ id: "running", status: "running", createdAt: 0 }),
      ],
      { maxBytes: 0, now },
    );
    assert.deepEqual(plan.purge, []);
  });

  it("超磁盘上限时按结束时间从旧到新清理终态项", () => {
    const files = (bytes: number) => ({ inputBytes: bytes });
    const plan = planDiskCleanup(
      [
        job({ id: "a", status: "failed", finishedAt: now - 2 * 3600 * 1000, ...files(100) }),
        job({ id: "b", status: "cancelled", finishedAt: now - 3600 * 1000, ...files(100) }),
        job({ id: "c", status: "pendingPlace", createdAt: 50, ...files(100) }),
      ],
      { maxBytes: 220, now },
    );
    assert.deepEqual(plan.purge, ["a"], "清掉最旧终态 a 后 200 <= 220");
    assert.equal(plan.keptBytes, 200);
  });
});

describe("queueStore 孤儿目录", () => {
  it("只返回不在队列里的目录名", () => {
    assert.deepEqual(planOrphanDirs(["a", "b"], ["a", "b", "old"]), ["old"]);
  });
});
