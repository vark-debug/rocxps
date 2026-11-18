import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { QueueScheduler } from "./scheduler";
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** 模拟 runner：启动即置 running，gate 结算前置 completed（避免被再次选中）。 */
const fakeRun = (
  started: string[],
  gates: Map<string, ReturnType<typeof deferred>>,
) => (current: QueueJob) => {
  started.push(current.id);
  current.status = "running";
  const gate = deferred();
  gates.set(current.id, gate);
  return gate.promise.then(() => {
    current.status = "completed";
  });
};

describe("QueueScheduler 单飞", () => {
  it("同一 Siliconed lane 一次只跑 1 个，完成后自动接下一个", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const jobs = [
      job({ id: "a", providerId: "siliconed", createdAt: 1 }),
      job({ id: "b", providerId: "siliconed", createdAt: 2 }),
    ];
    const scheduler = new QueueScheduler({
      getJobs: () => jobs,
      concurrency: () => 4,
      run: fakeRun(started, gates),
    });

    scheduler.dispatch();
    await flush();
    assert.deepEqual(started, ["a"], "第二个必须等第一个结算");

    gates.get("a")!.resolve();
    await flush();
    assert.deepEqual(started, ["a", "b"]);

    gates.get("b")!.resolve();
    await scheduler.whenIdle();
  });

  it("单飞 lane 忙碌时其他 lane 照常启动", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const jobs = [
      job({ id: "sil", providerId: "siliconed", createdAt: 1 }),
      job({ id: "ark", providerId: "ark", createdAt: 2 }),
    ];
    const scheduler = new QueueScheduler({
      getJobs: () => jobs,
      concurrency: () => 2,
      run: fakeRun(started, gates),
    });

    scheduler.dispatch();
    await flush();
    assert.deepEqual(started.sort(), ["ark", "sil"]);

    gates.forEach((g) => g.resolve());
    await scheduler.whenIdle();
  });

  it("重复 dispatch 不会重复启动同一 job", async () => {
    let starts = 0;
    const gate = deferred();
    const single = job({ id: "a" });
    const scheduler = new QueueScheduler({
      getJobs: () => [single],
      concurrency: () => 2,
      run: () => {
        starts += 1;
        single.status = "running";
        return gate.promise.then(() => {
          single.status = "completed";
        });
      },
    });

    scheduler.dispatch();
    scheduler.dispatch();
    await flush();
    assert.equal(starts, 1);

    gate.resolve();
    await scheduler.whenIdle();
  });

  it("network lane 同时最多跑 concurrency 个", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const jobs = [1, 2, 3].map((n) => job({ id: `n${n}`, createdAt: n }));
    const scheduler = new QueueScheduler({
      getJobs: () => jobs,
      concurrency: () => 2,
      run: fakeRun(started, gates),
    });

    scheduler.dispatch();
    await flush();
    assert.deepEqual(started, ["n1", "n2"]);

    gates.get("n1")!.resolve();
    await flush();
    assert.deepEqual(started, ["n1", "n2", "n3"]);

    gates.get("n2")!.resolve();
    gates.get("n3")!.resolve();
    await scheduler.whenIdle();
  });

  it("whenIdle 在无任务时立即 resolve", async () => {
    const scheduler = new QueueScheduler({
      getJobs: () => [],
      concurrency: () => 2,
      run: async () => undefined,
    });
    await scheduler.whenIdle();
    assert.deepEqual(scheduler.laneUsage(), {});
  });
});
