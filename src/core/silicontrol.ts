import { ProviderError, sleep } from "../providers/http";
import {
  emptySiliconMacs,
  normalizeSiliconMacs,
  type SiliconMacsSnapshot,
} from "../providers/siliconedTarget";
import { buildUpscaleArgs } from "./upscalePlan";

/**
 * Siliconed 控制通道（docs/siliconed-integration-plan.md 工作流 A / A2）。
 *
 * silicontrol 是 Siliconed.app 内的 CLI，通过 Unix domain socket（无网络端口）与 app 通信；
 * UXP 无子进程能力，因此由 SiliconedBridge.uxpaddon（UXP Hybrid Plugin）执行命令并回传输出。
 *
 * 协议要点（silicontrol help contract）：
 * - stdout 只含 JSON Lines，末行一定是 verdict（{"ok":true|false,...}）；
 * - 退出码：0 ok / 1 ok:false / 2 用法错误 / 3 app 不可达；
 * - 中间行带 type（added / image / stage / step / …），只有 wait 与 --wait 才有。
 *
 * 例外：`upscale FILE` 不启动 App、由 CLI 自己跑 helper，stdout 是 Plan / tile 等
 * 纯文本进度，答案只有退出码（见 runSilicontrolText）。
 */

/** 与 uxp.config.ts 中 manifest.addon.name 保持一致。 */
export const SILICONED_ADDON = "SiliconedBridge.uxpaddon";
export const SILICONED_MODEL_ID = "qwen-image-2.1";

/** add / status 的短超时；wait 由调用方给足量（300s+）。 */
export const SILICONTROL_SHORT_TIMEOUT_MS = 15_000;

export interface SilicontrolCommandResult {
  ok: boolean;
  exitCode: number;
  out: string;
  err: string;
  error?: string;
  truncated?: boolean;
}

interface SiliconedAddon {
  runCommand(options: {
    exe: string;
    args: string[];
    cwd?: string;
    timeoutMs?: number;
  }): Promise<SilicontrolCommandResult>;
}

/** require 返回 Promise；缓存成功实例，失败时清空以允许重新加载插件后重试。 */
let addonPromise: Promise<SiliconedAddon> | null = null;

const loadAddon = (): Promise<SiliconedAddon> => {
  if (!addonPromise) {
    addonPromise = Promise.resolve()
      .then(() =>
        Promise.resolve(
          require(SILICONED_ADDON) as
            | SiliconedAddon
            | Promise<SiliconedAddon>,
        ),
      )
      .then((addon) => {
        if (!addon || typeof addon.runCommand !== "function") {
          throw new Error("addon 未导出 runCommand");
        }
        return addon;
      })
      .catch((err) => {
        addonPromise = null;
        throw new ProviderError(
          "terminal",
          `无法加载 ${SILICONED_ADDON}：${err instanceof Error ? err.message : String(err)}。` +
            "请确认插件包含 Hybrid 组件且 Photoshop 为 24.2+",
        );
      });
  }
  return addonPromise;
};

export interface SiliconLogLine {
  type?: string;
  [key: string]: unknown;
}

export interface SiliconVerdict {
  ok: boolean;
  error?: string;
  message?: string;
  hint?: string;
  job?: string;
  jobs?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** 把稳定错误码翻译成给用户看的下一步动作。 */
const CODE_HINTS: Record<string, string> = {
  license_not_accepted:
    "请在 Siliconed 应用中接受该模型的许可（Qwen Research 为非商用研究许可）",
  model: "模型未就绪：请在 Siliconed 中安装 qwen-image-2.1",
  format: "尺寸不符合要求：每边需为 32 的倍数且 ≥512",
  ref: "参考图无法读取，请重试或缩小选区",
  queue_full: "Siliconed 队列已满（64 个等待），请等待现有任务结束后重试",
  busy: "Siliconed 正在安装模型，安装完成后才能渲染",
  insufficient_memory: "内存不足，请缩小选区或关闭其他占用内存的应用",
  non_finite_image: "模型输出了无效图像，请调整提示词后重试",
  disk_full: "磁盘空间不足，请清理后重试",
  unknown_job:
    "任务状态尚未同步（本次会话中还没有该任务），插件会自动短重试；若持续失败请查看 Siliconed 队列",
  link: "与目标 Mac 的会话已断开：请确认两台 Mac 在同一网络、两端 Siliconed 版本一致，再用 silicontrol macs / compute 重连",
  remote:
    "当前 Siliconed 正在另一台 Mac 上计算：install / import 类命令只能在本机计算时执行，请先在 Siliconed 中切回本机（Render ▸ Compute On ▸ This Mac）",
  accelerators:
    "该 Mac 尚未测量或没有可用加速器：先渲染一次让它自测，或执行 silicontrol diagnose",
  faster_rendering:
    "Faster Rendering 在 0.20 中属于 Beta 总开关：先执行 silicontrol set beta faster-rendering on，再执行 set faster-rendering on",
  unknown_mac: "没有同名的已配对 Mac（或有两个同名）：请在设置中选择列表里的 Mac，或使用 macs 返回的 id",
  weights_missing:
    "SeedVR2 权重未安装：执行 silicontrol install seedvr2（许可需在 Siliconed 应用内接受）后重试",
};

/** 可立即重试的错误码（unknown_job 由 wait 的短重试专门处理，link 由跨机会话重连处理）。 */
const RETRYABLE_CODES = new Set(["queue_full", "busy", "unknown_job", "link"]);

const detailOf = (res: SilicontrolCommandResult): string => {
  const text = (res.err || res.out || "").trim();
  if (!text) return "";
  return ` ${text.split(/\r?\n/).filter(Boolean).slice(-1)[0].slice(0, 200)}`;
};

/**
 * 解析 JSON Lines 输出。
 * 空输出、超 256KB 截断、非法 JSON、缺少 verdict 都映射为明确的 terminal 错误。
 */
export const parseSilicontrolOutput = (
  stdout: string,
  truncated = false,
): { lines: SiliconLogLine[]; verdict: SiliconVerdict } => {
  if (truncated) {
    throw new ProviderError(
      "terminal",
      "Siliconed 输出超过 256KB 被截断，无法解析结果",
    );
  }
  const raws = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (raws.length === 0) {
    throw new ProviderError("terminal", "Siliconed 没有返回任何输出");
  }
  const lines = raws.map((raw, index) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ProviderError(
        "terminal",
        `Siliconed 输出第 ${index + 1} 行不是合法 JSON Lines：${raw.slice(0, 120)}`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderError(
        "terminal",
        `Siliconed 输出第 ${index + 1} 行不是 JSON 对象`,
      );
    }
    return value as SiliconLogLine;
  });
  const verdict = lines[lines.length - 1] as SiliconVerdict;
  if (typeof verdict.ok !== "boolean") {
    throw new ProviderError(
      "terminal",
      "Siliconed 输出缺少 verdict 行（末行没有 ok 字段）",
    );
  }
  return { lines, verdict };
};

const verdictError = (
  verdict: SiliconVerdict,
  exitCode: number,
  label: string,
): ProviderError => {
  const code = typeof verdict.error === "string" ? verdict.error : "";
  const jobs = Array.isArray(verdict.jobs) ? verdict.jobs : [];
  const jobCodes = jobs
    .map((job) => (job && typeof job.code === "string" ? job.code : ""))
    .filter(Boolean);
  const jobText = jobs
    .filter((job) => job && job.outcome !== "done")
    .map((job) => {
      const outcome = typeof job.outcome === "string" ? job.outcome : "error";
      const jobCode = typeof job.code === "string" ? `（${job.code}）` : "";
      const message = typeof job.message === "string" ? ` ${job.message}` : "";
      return `${String(job.job ?? "任务")}: ${outcome}${jobCode}${message}`;
    })
    .join("；");
  const base =
    [verdict.message, verdict.hint].filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0,
    ).join(" — ") ||
    jobText ||
    `退出码 ${exitCode}`;
  // 顶层错误码（如 render）可能没有提示；任务级错误码（insufficient_memory 等）更具体
  const hintCode =
    code && CODE_HINTS[code] ? code : jobCodes.find((c) => CODE_HINTS[c]) ?? "";
  const hint = hintCode ? CODE_HINTS[hintCode] : "";
  const kind: "terminal" | "retryable" =
    RETRYABLE_CODES.has(code) || jobCodes.some((c) => RETRYABLE_CODES.has(c))
      ? "retryable"
      : "terminal";
  return new ProviderError(
    kind,
    `${label}失败：${base}${code ? `（${code}）` : ""}${hint ? `；${hint}` : ""}`,
    undefined,
    code || undefined,
  );
};

/**
 * 退出码 / verdict → ProviderError 的统一分类。
 * 0 成功；1 ok:false（terminal，队列满/安装中为 retryable）；2 用法错误；3 app 不可达（retryable）。
 *
 * exitNotes 用于子命令改写特定退出码的语义（upscale 的 3/4/5 与 add/wait 不同），
 * 命中时优先于默认的退出码解释。
 */
export interface SilicontrolExitNote {
  message: string;
  retryable?: boolean;
}

export const classifySilicontrolResult = (
  res: SilicontrolCommandResult,
  label: string,
  timeoutMs = SILICONTROL_SHORT_TIMEOUT_MS,
  allowVerdictError = false,
  exitNotes?: Record<number, SilicontrolExitNote>,
): { lines: SiliconLogLine[]; verdict: SiliconVerdict } => {
  if (!res || typeof res !== "object") {
    throw new ProviderError("terminal", `${label}失败：native 返回结果为空`);
  }
  if (res.error === "timeout") {
    throw new ProviderError(
      "timeout",
      `${label}超时（${Math.round(timeoutMs / 1000)}s）`,
    );
  }
  if (res.error === "spawn failed") {
    throw new ProviderError(
      "terminal",
      `${label}失败：无法启动 silicontrol${detailOf(res)}。` +
        "请确认 Siliconed 已安装，路径指向 Siliconed.app/Contents/Helpers/silicontrol",
    );
  }
  if (res.exitCode === -1) {
    throw new ProviderError("terminal", `${label}失败：命令异常退出${detailOf(res)}`);
  }
  const exitNote = exitNotes?.[res.exitCode];
  if (exitNote) {
    throw new ProviderError(
      exitNote.retryable ? "retryable" : "terminal",
      `${label}失败：${exitNote.message}${detailOf(res)}`,
    );
  }
  if (res.exitCode === 3) {
    throw new ProviderError(
      "retryable",
      `${label}失败：无法连接 Siliconed（退出码 3），请确认应用已安装并运行${detailOf(res)}`,
    );
  }

  let parsed: { lines: SiliconLogLine[]; verdict: SiliconVerdict } | null = null;
  try {
    parsed = parseSilicontrolOutput(res.out, res.truncated);
  } catch (err) {
    if (res.exitCode === 0) throw err;
    // 非 0 退出时，解析失败不掩盖退出码语义（stderr 往往更有信息量）
    parsed = null;
  }

  if (res.exitCode === 2) {
    if (parsed) throw verdictError(parsed.verdict, 2, label);
    throw new ProviderError(
      "terminal",
      `${label}参数错误（退出码 2）${detailOf(res)}`,
      undefined,
      "usage",
    );
  }
  if (!parsed) {
    throw new ProviderError(
      "terminal",
      `${label}失败：退出码 ${res.exitCode}${detailOf(res)}`,
    );
  }
  if (!parsed.verdict.ok) {
    if (allowVerdictError) return parsed;
    throw verdictError(parsed.verdict, res.exitCode, label);
  }
  if (res.exitCode !== 0) {
    if (allowVerdictError) return parsed;
    throw new ProviderError(
      "terminal",
      `${label}失败：退出码 ${res.exitCode} 与 verdict 不一致`,
    );
  }
  return parsed;
};

export interface RunSilicontrolOptions {
  cliPath: string;
  args: string[];
  timeoutMs?: number;
  cwd?: string;
  label: string;
  /**
   * wait 在任务被取消时返回 {ok:false,error:"render"}（退出码 1）；
   * 此时不能按普通失败抛错，需要拿到 verdict 里的 outcome 再判断。
   */
  allowVerdictError?: boolean;
  /** 子命令专属的退出码语义（upscale 的 3/4/5）。 */
  exitNotes?: Record<number, SilicontrolExitNote>;
}

/**
 * 执行一次 silicontrol 命令并完成解析 / 错误分类。
 */
export const runSilicontrol = async (
  options: RunSilicontrolOptions,
): Promise<{ lines: SiliconLogLine[]; verdict: SiliconVerdict }> => {
  const cliPath = options.cliPath.trim();
  if (!cliPath) {
    throw new ProviderError("terminal", "请先在设置中填写 silicontrol 路径");
  }
  const timeoutMs = options.timeoutMs ?? SILICONTROL_SHORT_TIMEOUT_MS;
  let res: SilicontrolCommandResult;
  try {
    const addon = await loadAddon();
    res = await addon.runCommand({
      exe: cliPath,
      args: options.args,
      timeoutMs,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      "terminal",
      `调用 Siliconed 失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return classifySilicontrolResult(
    res,
    options.label,
    timeoutMs,
    options.allowVerdictError === true,
    options.exitNotes,
  );
};

const tryParseVerdict = (stdout: string): SiliconVerdict | null => {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const verdict = value as SiliconVerdict;
    return typeof verdict.ok === "boolean" ? verdict : null;
  } catch {
    return null;
  }
};

export interface RunSilicontrolTextOptions {
  cliPath: string;
  args: string[];
  timeoutMs?: number;
  label: string;
  exitNotes?: Record<number, SilicontrolExitNote>;
}

/**
 * FILE 形式的 upscale 不遵守 JSON Lines 协议（`silicontrol help upscale`）：
 * stdout 是 `Plan: … / tile … / Saved: …` 这类进度文本，**退出码就是答案**，
 * 没有 verdict 行。因此不能走 runSilicontrol（会把首行判成非法 JSON）。
 */
export const runSilicontrolText = async (
  options: RunSilicontrolTextOptions,
): Promise<{ text: string }> => {
  const cliPath = options.cliPath.trim();
  if (!cliPath) {
    throw new ProviderError("terminal", "请先在设置中填写 silicontrol 路径");
  }
  const timeoutMs = options.timeoutMs ?? SILICONTROL_SHORT_TIMEOUT_MS;
  let res: SilicontrolCommandResult;
  try {
    const addon = await loadAddon();
    res = await addon.runCommand({
      exe: cliPath,
      args: options.args,
      timeoutMs,
    });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      "terminal",
      `调用 Siliconed 失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res || typeof res !== "object") {
    throw new ProviderError("terminal", `${options.label}失败：native 返回结果为空`);
  }
  if (res.error === "timeout") {
    throw new ProviderError(
      "timeout",
      `${options.label}超时（${Math.round(timeoutMs / 1000)}s）`,
    );
  }
  if (res.error === "spawn failed") {
    throw new ProviderError(
      "terminal",
      `${options.label}失败：无法启动 silicontrol${detailOf(res)}。` +
        "请确认 Siliconed 已安装，路径指向 Siliconed.app/Contents/Helpers/silicontrol",
    );
  }
  const exitNote = options.exitNotes?.[res.exitCode];
  if (exitNote) {
    throw new ProviderError(
      exitNote.retryable ? "retryable" : "terminal",
      `${options.label}失败：${exitNote.message}${detailOf(res)}`,
    );
  }
  if (res.exitCode !== 0) {
    // 参数 / 前置校验失败（如 dest 已存在）仍会输出一行 JSON，可复用错误码提示；
    // 真正的运行失败只有纯文本，交给退出码 + 最后一行输出。
    const verdict = tryParseVerdict(res.out);
    if (verdict) throw verdictError(verdict, res.exitCode, options.label);
    throw new ProviderError(
      "terminal",
      `${options.label}失败：退出码 ${res.exitCode}${detailOf(res)}`,
    );
  }
  return { text: res.out };
};

// ---------- status ----------

export interface SiliconRunning {
  job?: string;
  stage?: string;
  step?: number;
  stepsTotal?: number;
  fraction?: number | null;
  remainingS?: number | null;
  model?: string;
}

export interface SiliconQueueItem {
  job?: string;
  estimateS?: number | null;
  prompt?: string;
}

export interface SiliconStatus {
  running: SiliconRunning | null;
  queue: SiliconQueueItem[];
  waitingForLicense: SiliconQueueItem[];
  installing: { title?: string; last?: string } | null;
  queueRemainingS: number | null;
  remainingComplete: boolean;
  /** 当前实际计算目标：null = 本机；字符串 = 远端 Mac 名称（0.18/0.19 无此字段）。 */
  computingOn: string | null;
}

const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const toQueueItem = (value: unknown): SiliconQueueItem => {
  const item = (value ?? {}) as Record<string, unknown>;
  return {
    job: typeof item.job === "string" ? item.job : undefined,
    estimateS: numOrNull(item.estimate_s),
    prompt: typeof item.prompt === "string" ? item.prompt : undefined,
  };
};

/** status verdict → 结构化状态（字段 snake_case 转 camelCase）。 */
export const normalizeSiliconStatus = (verdict: SiliconVerdict): SiliconStatus => {
  const runningRaw = verdict.running as Record<string, unknown> | null | undefined;
  const running =
    runningRaw && typeof runningRaw === "object"
      ? {
          job: typeof runningRaw.job === "string" ? runningRaw.job : undefined,
          stage: typeof runningRaw.stage === "string" ? runningRaw.stage : undefined,
          step: numOrNull(runningRaw.step) ?? undefined,
          stepsTotal: numOrNull(runningRaw.steps_total) ?? undefined,
          fraction: numOrNull(runningRaw.fraction),
          remainingS: numOrNull(runningRaw.remaining_s),
          model: typeof runningRaw.model === "string" ? runningRaw.model : undefined,
        }
      : null;
  const queue = Array.isArray(verdict.queue) ? verdict.queue.map(toQueueItem) : [];
  const waitingForLicense = Array.isArray(verdict.waiting_for_license)
    ? verdict.waiting_for_license.map(toQueueItem)
    : [];
  const installingRaw = verdict.installing as Record<string, unknown> | null | undefined;
  const installing =
    installingRaw && typeof installingRaw === "object"
      ? {
          title: typeof installingRaw.title === "string" ? installingRaw.title : undefined,
          last: typeof installingRaw.last === "string" ? installingRaw.last : undefined,
        }
      : null;
  return {
    running,
    queue,
    waitingForLicense,
    installing,
    queueRemainingS: numOrNull(verdict.queue_remaining_s),
    remainingComplete: verdict.remaining_complete === true,
    computingOn:
      typeof verdict.computing_on === "string" && verdict.computing_on.trim()
        ? verdict.computing_on
        : null,
  };
};

export const siliconStatus = async (
  cliPath: string,
  timeoutMs = SILICONTROL_SHORT_TIMEOUT_MS,
): Promise<SiliconStatus> => {
  const { verdict } = await runSilicontrol({
    cliPath,
    args: ["status"],
    timeoutMs,
    label: "Siliconed 状态查询",
  });
  return normalizeSiliconStatus(verdict);
};

// ---------- add / wait ----------

export interface SiliconAddResult {
  job: string;
  position: number;
  seeds: number[];
  estimateS: number | null;
  /** add 响应里的实际计算目标（0.18/0.19 无此字段）；跨机自回切时以此为准。 */
  computingOn: string | null;
}

export const siliconAdd = async (
  cliPath: string,
  args: string[],
  timeoutMs = SILICONTROL_SHORT_TIMEOUT_MS,
): Promise<SiliconAddResult> => {
  const { verdict } = await runSilicontrol({
    cliPath,
    args,
    timeoutMs,
    label: "Siliconed 提交任务",
  });
  if (Array.isArray(verdict.jobs) && verdict.jobs.length > 1) {
    throw new ProviderError(
      "terminal",
      "提示词被 Siliconed 解析为多个任务（备选语法），插件只支持单任务",
    );
  }
  const job = typeof verdict.job === "string" ? verdict.job : "";
  if (!job) {
    throw new ProviderError("terminal", "Siliconed 未返回任务编号（job）");
  }
  return {
    job,
    position: numOrNull(verdict.position) ?? 0,
    seeds: Array.isArray(verdict.seeds)
      ? verdict.seeds.filter((s): s is number => typeof s === "number")
      : [],
    estimateS: numOrNull(verdict.estimate_s),
    computingOn:
      typeof verdict.computing_on === "string" && verdict.computing_on.trim()
        ? verdict.computing_on
        : null,
  };
};

export interface SiliconWaitImage {
  path?: string;
  job?: string;
  image?: string;
  writeError?: string;
}

export interface SiliconWaitResult {
  images: SiliconWaitImage[];
  verdict: SiliconVerdict;
}

/**
 * wait 对已完成（含很久以前完成）的任务立即返回；--out 才落盘。
 *
 * 取消后 wait 会返回 {ok:false,error:"render"}（退出码 1），
 * allowCancelled 时保留 verdict，让调用方按 jobs[].outcome 区分 stopped / removed / error。
 */
export const siliconWait = async (
  cliPath: string,
  jobs: string[],
  outDir: string,
  timeoutMs = 300_000,
  allowCancelled = false,
): Promise<SiliconWaitResult> => {
  const args = ["wait", ...jobs, ...(outDir ? ["--out", outDir] : [])];
  const { lines, verdict } = await runSilicontrol({
    cliPath,
    args,
    timeoutMs,
    label: "Siliconed 等待任务",
    allowVerdictError: allowCancelled,
  });
  const images = lines
    .filter((line) => line.type === "image")
    .map((line) => ({
      path: typeof line.path === "string" ? line.path : undefined,
      job: typeof line.job === "string" ? line.job : undefined,
      image: typeof line.image === "string" ? line.image : undefined,
      writeError:
        typeof line.write_error === "string" ? line.write_error : undefined,
    }));
  return { images, verdict };
};

// ---------- cancel ----------

export interface SiliconCancelResult {
  /** 正在渲染、已被停止的任务（中途停止，已生成的图片留在 history）。 */
  stopped: string[];
  /** 还在排队、已被移出队列的任务（远端槽位立即释放）。 */
  removed: string[];
  /** 取消到达时已经完成（取消过晚，结果仍然可用）。 */
  alreadyFinished: string[];
}

/**
 * `silicontrol cancel [job...]`：无参停正在渲染；带 job 停正在跑的、移除排队中的。
 * 0.5s 内生效；返回 {ok, stopped, removed, already_finished}。
 * 失败：usage（退出码 2）/ unknown_job（退出码 1，retryable）。
 */
export const siliconCancel = async (
  cliPath: string,
  jobs: string[],
  timeoutMs = SILICONTROL_SHORT_TIMEOUT_MS,
): Promise<SiliconCancelResult> => {
  const { verdict } = await runSilicontrol({
    cliPath,
    args: ["cancel", ...jobs],
    timeoutMs,
    label: "取消 Siliconed 任务",
  });
  return {
    stopped:
      typeof verdict.stopped === "string" && verdict.stopped
        ? [verdict.stopped]
        : [],
    removed: Array.isArray(verdict.removed)
      ? verdict.removed.filter((v): v is string => typeof v === "string")
      : [],
    alreadyFinished: Array.isArray(verdict.already_finished)
      ? verdict.already_finished.filter((v): v is string => typeof v === "string")
      : [],
  };
};

// ---------- upscale（SeedVR2 单图超分） ----------

/**
 * FILE 形式不启动 App、不经过渲染队列：helper 在本机直接跑完。
 * 3B int8 权重在 M 系列上单图可能需要数分钟，超时给足 20 分钟。
 */
export const SILICONED_UPSCALE_TIMEOUT_MS = 20 * 60_000;

/** upscale 的退出码语义与 add/wait 不同（3 = 权重或内存，4 = 超出画布，5 = 未确认长耗时）。 */
export const SILICONED_UPSCALE_EXIT_NOTES: Record<number, SilicontrolExitNote> = {
  3: {
    message:
      "SeedVR2 权重缺失或内存不足（退出码 3）；请先安装 SeedVR2 权重" +
      "（silicontrol install seedvr2，许可需在 Siliconed 应用内接受），或关闭占用内存的应用后重试",
  },
  4: {
    message: "目标尺寸超过本机可处理的最大画布（退出码 4），请减小目标长边",
  },
  5: {
    message:
      "预计耗时超过 10 分钟（退出码 5）；当前 silicontrol 的 upscale 不接受 --yes，" +
      "无法跳过确认，请减小目标长边后重试",
  },
};

/**
 * `silicontrol upscale FILE DEST --long-side N`。
 * DEST 必须不存在（CLI 不覆盖已有文件），由调用方准备临时目录。
 *
 * FILE 形式没有 verdict 行，成功与否只看退出码，因此走 runSilicontrolText。
 */
export const siliconUpscale = async (
  cliPath: string,
  srcPath: string,
  destPath: string,
  longSide: number,
  timeoutMs = SILICONED_UPSCALE_TIMEOUT_MS,
): Promise<void> => {
  await runSilicontrolText({
    cliPath,
    args: buildUpscaleArgs(srcPath, destPath, longSide),
    timeoutMs,
    label: "SeedVR2 超分",
    exitNotes: SILICONED_UPSCALE_EXIT_NOTES,
  });
};

// ---------- models ----------

export interface SiliconModelInfo {
  id: string;
  name: string;
  ready: boolean;
  edit: boolean;
  maxReferences: number | null;
  defaultSteps: number | null;
  licenseAccepted: boolean;
  commercialLicense: boolean;
  license?: string;
  missing?: string;
}

export const siliconModels = async (
  cliPath: string,
  timeoutMs = SILICONTROL_SHORT_TIMEOUT_MS,
): Promise<SiliconModelInfo[]> => {
  const { verdict } = await runSilicontrol({
    cliPath,
    args: ["models"],
    timeoutMs,
    label: "Siliconed 模型查询",
  });
  if (!Array.isArray(verdict.models)) {
    throw new ProviderError("terminal", "Siliconed 模型列表格式异常（缺少 models 数组）");
  }
  return verdict.models.map((raw) => {
    const model = (raw ?? {}) as Record<string, unknown>;
    return {
      id: typeof model.id === "string" ? model.id : "",
      name: typeof model.name === "string" ? model.name : "",
      ready: model.ready === true,
      edit: model.edit === true,
      maxReferences: numOrNull(model.max_references),
      defaultSteps: numOrNull(model.default_steps),
      licenseAccepted: model.license_accepted === true,
      commercialLicense: model.commercial_license === true,
      license: typeof model.license === "string" ? model.license : undefined,
      missing: typeof model.missing === "string" ? model.missing : undefined,
    };
  });
};

// ---------- macs / compute（0.20 跨机） ----------

export interface SiliconComputeResult {
  computingOn: string | null;
  changed: boolean;
  link?: string;
  message?: string;
}

/**
 * 已配对的 Mac 列表。0.18/0.19 没有该子命令：按「仅本机」降级（supported=false），
 * 其他错误（app 不可达等）照常上抛，避免把网络问题误判成版本不支持。
 */
export const siliconMacs = async (
  cliPath: string,
  // macs 可能需要等待配对列表同步，给比普通查询更宽的超时
  timeoutMs = 30_000,
): Promise<SiliconMacsSnapshot> => {
  try {
    const { verdict } = await runSilicontrol({
      cliPath,
      args: ["macs"],
      timeoutMs,
      label: "Siliconed 已配对 Mac 查询",
    });
    return normalizeSiliconMacs(verdict);
  } catch (err) {
    // 0.18/0.19 没有 macs 子命令（退出码 2 / usage）：降级为「仅本机」而不是崩溃
    if (
      err instanceof ProviderError &&
      (err.code === "usage" ||
        /参数错误|unknown (command|subcommand)|usage:|不支持/i.test(err.message))
    ) {
      return emptySiliconMacs(false);
    }
    throw err;
  }
};

/** 切换计算目标（NAME 或 this）；成功后返回实际的 computing_on。 */
export const siliconCompute = async (
  cliPath: string,
  name: string,
  // compute 会等到会话建立（或确认断开）才返回，不能按普通查询的 15s 截断
  timeoutMs = 45_000,
): Promise<SiliconComputeResult> => {
  const { verdict } = await runSilicontrol({
    cliPath,
    args: ["compute", name],
    timeoutMs,
    label: `切换计算目标（${name}）`,
  });
  return {
    computingOn:
      typeof verdict.computing_on === "string" && verdict.computing_on.trim()
        ? verdict.computing_on
        : null,
    changed: verdict.changed === true,
    link: typeof verdict.link === "string" ? verdict.link : undefined,
    message: typeof verdict.message === "string" ? verdict.message : undefined,
  };
};

// ---------- 轮询 ----------

export type SiliconJobState =
  | "running"
  | "queued"
  | "waiting-license"
  | "gone";

export interface SiliconJobSnapshot {
  state: SiliconJobState;
  running?: SiliconRunning;
  queueItem?: SiliconQueueItem;
  queueIndex?: number;
}

export const findSiliconJobState = (
  status: SiliconStatus,
  job: string,
): SiliconJobSnapshot => {
  if (status.running?.job === job) {
    return { state: "running", running: status.running };
  }
  if (status.waitingForLicense.some((item) => item.job === job)) {
    return { state: "waiting-license" };
  }
  const index = status.queue.findIndex((item) => item.job === job);
  if (index >= 0) {
    return { state: "queued", queueItem: status.queue[index], queueIndex: index };
  }
  return { state: "gone" };
};

export interface WaitForSiliconJobOptions {
  cliPath: string;
  job: string;
  /** 可变截止时间：拿到 estimate 后可向后延长。 */
  deadline: { at: number };
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onStatus?: (status: SiliconStatus, snapshot: SiliconJobSnapshot) => void;
}

/**
 * 轮询 status（≥1s），直到任务从 running / queue / waiting_for_license 消失，
 * 或到达截止时间。中途「app 不可达」可重试 3 次。
 */
export const waitForSiliconJob = async (
  options: WaitForSiliconJobOptions,
): Promise<void> => {
  const interval = Math.max(1000, options.pollIntervalMs ?? 1200);
  const startedAt = Date.now();
  let transientErrors = 0;
  let lastState: SiliconJobState = "queued";
  while (Date.now() < options.deadline.at) {
    if (options.signal?.aborted) {
      throw new ProviderError("cancelled", "已取消 Siliconed 任务");
    }
    let status: SiliconStatus;
    try {
      status = await siliconStatus(options.cliPath, SILICONTROL_SHORT_TIMEOUT_MS);
      transientErrors = 0;
    } catch (err) {
      const retryable =
        err instanceof ProviderError && err.kind === "retryable";
      if (retryable && ++transientErrors < 3) {
        await sleep(interval);
        continue;
      }
      throw err;
    }
    const snapshot = findSiliconJobState(status, options.job);
    lastState = snapshot.state;
    options.onStatus?.(status, snapshot);
    if (snapshot.state === "gone") return;
    await sleep(interval);
  }
  if (lastState === "waiting-license") {
    throw new ProviderError(
      "terminal",
      `Siliconed 任务 ${options.job} 仍等待模型许可：请在 Siliconed 应用中接受 Qwen Research（非商用）许可后重试`,
    );
  }
  throw new ProviderError(
    "timeout",
    `Siliconed 任务 ${options.job} 超时（已等待 ${Math.round(
      (Date.now() - startedAt) / 1000,
    )}s）`,
  );
};
