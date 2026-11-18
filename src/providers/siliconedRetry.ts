import { ProviderError, sleep } from "./http";

/**
 * `add` 刚返回就 `wait` 时，silicontrol 可能报 unknown_job（本次会话中任务状态尚未同步），
 * exit 1；隔约 1 秒重试即成功。这是竞态而非失败，必须按「稍后重试」处理。
 */

export const isUnknownJobError = (err: unknown): boolean =>
  err instanceof ProviderError &&
  (err.code === "unknown_job" || /unknown_job/.test(err.message));

export interface RetryUnknownJobOptions {
  /** 额外重试次数（默认 6 次，约 6 秒）。 */
  retries?: number;
  delayMs?: number;
  /** 便于单测注入；默认真实等待。 */
  sleepFn?: (ms: number) => Promise<void>;
}

/** 仅对 unknown_job 做短重试；其他错误原样抛出。 */
export const retryUnknownJob = async <T>(
  run: () => Promise<T>,
  options: RetryUnknownJobOptions = {},
): Promise<T> => {
  const retries = options.retries ?? 6;
  const delayMs = options.delayMs ?? 1000;
  const wait = options.sleepFn ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (!isUnknownJobError(err) || attempt >= retries) throw err;
      attempt += 1;
      await wait(delayMs);
    }
  }
};
