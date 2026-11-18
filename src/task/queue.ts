import type { Rect, ExpandedRegion } from "../ps/types";
import type {
  ComputeTargetInfo,
  ProviderId,
  ProviderProgress,
} from "../providers/types";
import type { SizeMode } from "../ps/presetFit";
import type { PlaceBackMode, RedrawSettings } from "../settings/types";

/**
 * 插件侧任务队列（纯数据 + 状态机 + 单飞调度选择）。
 *
 * 设计要点：
 * - 队列做在插件侧，但 Siliconed / IOPaint 服务端一次只跑一个任务，因此按 lane 单飞；
 * - 队列项只持有**路径与元数据**，像素/蒙版落盘（8000×2000 快照约 188MB，不能驻留内存）；
 * - 等待原文档复用 placeBack 的 documentMissing 语义，不另写一套；
 * - 失败不静默丢弃：写入 failed 并保留原因，输入文件按保留策略落盘可重试。
 */

export type QueueStatus =
  | "queued"
  | "running"
  | "pendingPlace"
  | "completed"
  | "failed"
  | "cancelled";

export type QueueStage = "queued" | "submitting" | "generating" | "placing";

/** 单飞 lane：Siliconed / IOPaint 服务端串行；其他平台按设置并发；贴回单独一路。 */
export type QueueLane = "siliconed" | "iopaint" | "network" | "place";

export const QUEUE_LIMIT = 20;
/** 失败 / 等待原文档的输入文件保留 7 天。 */
export const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 自动重试最多 1 次，且只限「提交前还没拿到远端 job id 的 retryable」。 */
export const AUTO_RETRY_LIMIT = 1;
/** 取消在途任务失败后，最长把槽位保留到这一刻（毫秒）；超过则释放并忽略迟到结果。 */
export const LOGICAL_CANCEL_GRACE_MS = 60_000;

export interface QueueJob {
  id: string;
  prompt: string;
  providerId: ProviderId;
  /** 入队时选中的模型（重试 / 稍后执行都按它走，避免设置变化导致平台漂移）；旧队列项可为空。 */
  modelId?: string;
  /** 提示词模板的一次性设置覆盖（仅本次任务生效，不落盘）。 */
  settingsOverride?: Partial<RedrawSettings>;
  /** 捕获时的文档 id：贴回按它定位（不要求前台）。 */
  docId: number;
  docName: string;
  docPath?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  originalBounds: Rect;
  expanded: ExpandedRegion;
  captureRect: Rect;
  sizeMode: SizeMode;
  /** 命中的尺寸预设 id；custom 模式为空。 */
  presetId?: string | null;
  sendWidth: number;
  sendHeight: number;
  /** 实际请求尺寸（预设模式 = send；custom = 换算结果）。 */
  reqW: number;
  reqH: number;

  // ---- 落盘路径（队列项只持路径） ----
  refPath: string;
  maskPath: string;
  sendMaskPath: string;
  maskPngPath: string;
  resultPath?: string;
  thumbPath?: string;
  /** 原文档关闭时 placeBack 落盘的结果路径。 */
  artifactPath?: string;
  /** 落盘文件占用（磁盘 LRU 清理用）。 */
  inputBytes?: number;
  resultBytes?: number;
  thumbBytes?: number;
  /** 输入/结果文件已被保留期或磁盘上限清理（元数据仍在）。 */
  filesPruned?: boolean;

  // ---- 状态 ----
  status: QueueStatus;
  stage: QueueStage;
  lane: QueueLane;
  /** pendingPlace 时是否自动贴回（用户手动取消后为 false，可再贴）。 */
  autoPlace?: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 平台估算与实际耗时（毫秒）。 */
  estimateMs?: number | null;
  elapsedMs?: number;
  /** Siliconed 远端 job id；取消时用它精确停止。 */
  remoteJobId?: string;
  /** 已尝试次数（含自动重试）。首次为 0。 */
  attempts: number;
  autoRetryUsed?: boolean;
  cancelRequestedAt?: number;
  progress?: ProviderProgress;
  compute?: ComputeTargetInfo;
  error?: string;

  // ---- 贴回结果 ----
  placeBackMode?: PlaceBackMode;
  placedLayer?: string;
  placedInBackground?: boolean;
  documentMissing?: boolean;
  placeNote?: string;
  reboundDocId?: number;
  actualOutputSize?: { width: number; height: number };
  outputMismatch?: boolean;
  appliedScale?: { x: number; y: number };
}

export const TERMINAL_QUEUE_STATUSES: readonly QueueStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export const isTerminalQueueStatus = (status: QueueStatus): boolean =>
  TERMINAL_QUEUE_STATUSES.includes(status);

/** 平台 → lane；Siliconed / IOPaint 单飞，其余归 network。 */
export const laneForProvider = (providerId: ProviderId): QueueLane =>
  providerId === "siliconed"
    ? "siliconed"
    : providerId === "iopaint"
      ? "iopaint"
      : "network";

/**
 * 正在贴回的项走 place lane（生成阶段已结束，不应继续占用平台槽位）。
 * 生成 lane 以 providerId 为准（持久化里的 lane 只作展示，避免旧数据写错导致失去单飞保护）。
 */
export const laneForJob = (job: QueueJob): QueueLane =>
  job.status === "pendingPlace" && job.stage === "placing"
    ? "place"
    : laneForProvider(job.providerId);

/** lane 容量：单飞平台 1，其他平台按设置并发，贴回 1。 */
export const capacityForLane = (lane: QueueLane, concurrency: number): number => {
  if (lane === "siliconed" || lane === "iopaint" || lane === "place") return 1;
  return Math.max(1, Math.round(concurrency) || 1);
};

/* ---------------- 状态机 ---------------- */

const TRANSITIONS: Record<QueueStatus, readonly QueueStatus[]> = {
  // 失败重试 / 用户主动重排回到队列头
  queued: ["running", "failed", "cancelled"],
  running: ["pendingPlace", "completed", "failed", "cancelled"],
  // 待贴回可自动/手动贴回；取消只停自动贴回，结果保留，之后仍可再贴
  pendingPlace: ["running", "completed", "failed", "cancelled"],
  cancelled: ["pendingPlace", "queued"],
  failed: ["queued", "pendingPlace"],
  completed: [],
};

export const canTransition = (from: QueueStatus, to: QueueStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** 受控更新：非法流转直接抛错（防止 runner / UI 写出不可能的状态）。 */
export const transitionJob = (
  job: QueueJob,
  to: QueueStatus,
  patch: Partial<QueueJob> = {},
): QueueJob => {
  if (job.status !== to && !canTransition(job.status, to)) {
    throw new Error(`非法状态流转：${job.status} → ${to}（任务 ${job.id}）`);
  }
  return { ...job, ...patch, status: to };
};

/* ---------------- 单飞调度选择 ---------------- */

export interface RunnableOptions {
  /** 各 lane 当前正在执行的数量。 */
  active: Readonly<Record<string, number>>;
  /** 生成并发数（network lane 容量）。 */
  concurrency: number;
}

/**
 * 选出当前可以启动的任务（按创建时间从旧到新，FIFO）。
 * - queued → 平台 lane；
 * - pendingPlace 且 autoPlace === true → place lane；
 * - 某 lane 已满则跳过该项，继续尝试后面其他 lane 的项（不队头阻塞）。
 */
export const selectRunnableJobs = (
  jobs: readonly QueueJob[],
  options: RunnableOptions,
): QueueJob[] => {
  const sorted = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
  const active: Record<string, number> = { ...options.active };
  const picked: QueueJob[] = [];
  for (const job of sorted) {
    const placePhase = job.status === "pendingPlace";
    if (job.status !== "queued" && !(placePhase && job.autoPlace)) continue;
    const lane = placePhase ? "place" : laneForProvider(job.providerId);
    const capacity = capacityForLane(lane, options.concurrency);
    if ((active[lane] ?? 0) >= capacity) continue;
    active[lane] = (active[lane] ?? 0) + 1;
    picked.push(job);
  }
  return picked;
};

/* ---------------- 重试策略 ---------------- */

export type FailureAction = "auto-retry" | "fail";

/**
 * 自动重试只允许 1 次，且必须同时满足：
 * - 错误可重试（retryable）；
 * - 还没有拿到远端 job id（拿到意味着远端可能已经在跑，重投会白跑一次渲染）；
 * - 轮询超时不自动重投（timeout 不是 retryable，这里显式排除）。
 */
export const planFailure = (
  job: Pick<QueueJob, "attempts" | "autoRetryUsed" | "remoteJobId">,
  errorKind: string,
): FailureAction => {
  if (errorKind !== "retryable") return "fail";
  if (job.remoteJobId) return "fail";
  if (job.autoRetryUsed) return "fail";
  if (job.attempts >= AUTO_RETRY_LIMIT + 1) return "fail";
  return "auto-retry";
};

/* ---------------- 取消语义 ---------------- */

export interface CancelPlan {
  action: "drop-now" | "cancel-remote" | "logical";
  /** 取消后为 true 时保留生成结果（pendingPlace）。 */
  keepResult: boolean;
  /** Siliconed 远端 job id（仅 cancel-remote）。 */
  remoteJobId?: string;
  reason: string;
}

/**
 * 取消策略：
 * - queued：直接移出队列；
 * - pendingPlace：只取消自动贴回，生成结果保留，之后可再贴；
 * - running + Siliconed 且已有远端 job id：走 silicontrol cancel 真取消；
 * - running 但无远端 job id（提交前 / 其他平台无法中断）：逻辑取消，
 *   标记 cancelRequested，等 provider promise 结算后释放槽位。
 */
export const planCancel = (job: QueueJob): CancelPlan => {
  if (job.status === "queued") {
    return { action: "drop-now", keepResult: false, reason: "排队中，直接移出队列" };
  }
  if (job.status === "pendingPlace") {
    return {
      action: "drop-now",
      keepResult: true,
      reason: "仅取消自动贴回，生成结果保留，可稍后再贴",
    };
  }
  if (job.status === "running") {
    if (job.providerId === "siliconed" && job.remoteJobId) {
      return {
        action: "cancel-remote",
        keepResult: false,
        remoteJobId: job.remoteJobId,
        reason: "Siliconed 正在渲染，调用 silicontrol cancel 真取消",
      };
    }
    return {
      action: "logical",
      keepResult: false,
      reason:
        job.providerId === "siliconed"
          ? "尚未拿到远端 job id（可能仍在提交中），无法精确取消；标记取消后在结算时释放"
          : "该平台请求无法中断，标记取消后在结算时释放槽位",
    };
  }
  return { action: "drop-now", keepResult: false, reason: "已是终态" };
};

export interface ParsedCancelResult {
  /** 正在渲染的任务已停止。 */
  stopped: string[];
  /** 排队阶段的任务已移除（远端队列立即释放）。 */
  removed: string[];
  /** 取消请求到达时已经完成（取消过晚，结果仍保留）。 */
  alreadyFinished: string[];
}

/** silicontrol cancel 的 verdict → 可判定的结果。 */
export const normalizeCancelVerdict = (verdict: {
  ok?: boolean;
  stopped?: unknown;
  removed?: unknown;
  already_finished?: unknown;
}): ParsedCancelResult => ({
  stopped: typeof verdict.stopped === "string" ? [verdict.stopped] : [],
  removed: Array.isArray(verdict.removed)
    ? verdict.removed.filter((v): v is string => typeof v === "string")
    : [],
  alreadyFinished: Array.isArray(verdict.already_finished)
    ? verdict.already_finished.filter((v): v is string => typeof v === "string")
    : [],
});

/**
 * wait 的 job outcome：
 * - done：正常完成；
 * - stopped：正在渲染时被取消（中途停止）；
 * - removed：排队阶段被取消（已移出队列）；
 * - error：真正失败。
 * 取消必须先看 outcome，绝不能把 stopped / removed 记成失败。
 */
export const classifyWaitOutcome = (
  verdict: {
    ok?: boolean;
    jobs?: Array<Record<string, unknown>>;
  },
): { outcomes: string[]; cancelled: boolean; failed: boolean; done: boolean } => {
  const jobs = Array.isArray(verdict.jobs) ? verdict.jobs : [];
  const outcomes = jobs.map((job) =>
    typeof job?.outcome === "string" ? job.outcome : "unknown",
  );
  const cancelled = outcomes.some((o) => o === "stopped" || o === "removed");
  const failed = !cancelled && outcomes.some((o) => o === "error");
  return {
    outcomes,
    cancelled,
    failed,
    done: outcomes.length > 0 && outcomes.every((o) => o === "done"),
  };
};

/* ---------------- 队列裁剪 ---------------- */

/**
 * 队列满时的淘汰位：只会返回最旧的终态项。
 * 没有终态项时不淘汰任何任务（拒绝新入队），避免把排队 / 运行中的任务挤掉。
 */
export const findEvictableJob = (
  jobs: readonly QueueJob[],
): QueueJob | undefined =>
  jobs
    .filter((job) => isTerminalQueueStatus(job.status))
    .sort((a, b) => a.createdAt - b.createdAt)[0];

/** 失败/取消项的输入文件是否已到保留期。 */
export const isRetentionExpired = (
  job: Pick<QueueJob, "finishedAt" | "createdAt">,
  now: number,
  retentionMs = FAILED_RETENTION_MS,
): boolean => now - (job.finishedAt ?? job.createdAt) >= retentionMs;
