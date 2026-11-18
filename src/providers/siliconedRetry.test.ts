import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ProviderError } from "./http";
import { isUnknownJobError, retryUnknownJob } from "./siliconedRetry";

const unknownJob = () =>
  new ProviderError(
    "retryable",
    '等待任务失败：本次会话中没有任务 t2（unknown_job）',
    undefined,
    "unknown_job",
  );

describe("retryUnknownJob", () => {
  it("unknown_job 后短重试，成功即返回", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryUnknownJob(
      async () => {
        calls += 1;
        if (calls < 3) throw unknownJob();
        return "done";
      },
      {
        retries: 6,
        delayMs: 1000,
        sleepFn: async (ms) => {
          waits.push(ms);
        },
      },
    );
    assert.equal(result, "done");
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 1000]);
  });

  it("非 unknown_job 错误立即抛出，不重试", async () => {
    const waits: number[] = [];
    let calls = 0;
    await assert.rejects(
      retryUnknownJob(
        async () => {
          calls += 1;
          throw new ProviderError("terminal", "模型未就绪", undefined, "model");
        },
        { sleepFn: async (ms) => {
          waits.push(ms);
        } },
      ),
      /模型未就绪/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  });

  it("超过重试次数后抛出最后一次 unknown_job", async () => {
    let calls = 0;
    await assert.rejects(
      retryUnknownJob(
        async () => {
          calls += 1;
          throw unknownJob();
        },
        { retries: 2, sleepFn: async () => undefined },
      ),
      /unknown_job/,
    );
    assert.equal(calls, 3);
  });

  it("无 code 但文案含 unknown_job 也识别为可重试", () => {
    assert.equal(
      isUnknownJobError(
        new ProviderError("retryable", "本次会话中没有任务 t2"),
      ),
      false,
    );
    assert.equal(
      isUnknownJobError(new ProviderError("retryable", "error unknown_job")),
      true,
    );
  });
});
