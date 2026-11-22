import {
  laneForJob,
  selectRunnableJobs,
  type QueueJob,
} from "./queue";

/**
 * 单飞调度器：队列变化时按 lane 容量启动可运行的任务。
 *
 * - 只负责「选出 + 启动」，不修改队列状态（状态由 runner / store 维护）；
 * - 同一 job 不会重复启动（inFlight 去重）；
 * - 某 lane 满载只跳过该项，不阻塞其他 lane（避免队头阻塞）；
 * - 任务结束后自动重新派发，保证下一个任务能接着跑。
 */

export interface QueueSchedulerHost {
  /** 当前队列快照（任意顺序，调度器内部按创建时间 FIFO）。 */
  getJobs: () => readonly QueueJob[];
  /** 执行一个任务；resolve 即表示该任务已结算（无论成功/失败/取消）。 */
  run: (job: QueueJob) => Promise<void>;
  /** network lane 的并发上限（实时读取设置）。 */
  concurrency: () => number;
  /** 队列是否暂停（不执行新任务，仍照常入队）；缺省 false。 */
  paused?: () => boolean;
  /** run 抛出未捕获错误时回调（正常应被 runner 内部吞掉并写状态）。 */
  onError?: (job: QueueJob, error: unknown) => void;
}

export class QueueScheduler {
  private readonly host: QueueSchedulerHost;
  private readonly active = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private dispatchScheduled = false;
  private idleWaiters: Array<() => void> = [];

  constructor(host: QueueSchedulerHost) {
    this.host = host;
  }

  /** 队列 / 设置变化后调用；同一轮内的多次调用合并成一次派发。 */
  notify(): void {
    if (this.dispatchScheduled) return;
    this.dispatchScheduled = true;
    Promise.resolve().then(() => {
      this.dispatchScheduled = false;
      this.dispatch();
    });
  }

  /** 立即派发（测试用；生产走 notify）。 */
  dispatch(): void {
    const jobs = this.host.getJobs();
    const picks = selectRunnableJobs(jobs, {
      active: Object.fromEntries(this.active),
      concurrency: this.host.concurrency(),
      paused: this.host.paused?.() ?? false,
    });
    for (const job of picks) {
      if (this.inFlight.has(job.id)) continue;
      this.start(job);
    }
  }

  private start(job: QueueJob): void {
    const lane = laneForJob(job);
    this.active.set(lane, (this.active.get(lane) ?? 0) + 1);
    const promise = Promise.resolve()
      .then(() => this.host.run(job))
      .catch((error) => this.host.onError?.(job, error))
      .finally(() => {
        this.inFlight.delete(job.id);
        const current = this.active.get(lane) ?? 0;
        if (current <= 1) this.active.delete(lane);
        else this.active.set(lane, current - 1);
        this.notify();
        this.checkIdle();
      });
    this.inFlight.set(job.id, promise);
  }

  /** 当前各 lane 的占用数（诊断 / UI 用）。 */
  laneUsage(): Record<string, number> {
    return Object.fromEntries(this.active);
  }

  /** 等待所有在途任务结算（测试与卸载时用）。 */
  whenIdle(): Promise<void> {
    if (this.inFlight.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private checkIdle(): void {
    if (this.inFlight.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
