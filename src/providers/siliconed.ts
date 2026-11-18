import { uxp } from "../globals";
import { isMacHost } from "./host";
import {
  siliconAdd,
  siliconCompute,
  siliconMacs,
  siliconModels,
  siliconStatus,
  siliconWait,
  SILICONED_MODEL_ID,
  waitForSiliconJob,
  type SiliconJobSnapshot,
  type SiliconStatus,
} from "../core/silicontrol";
import {
  bytesToBase64,
  dataUriToBytes,
  ProviderError,
  sleep,
} from "./http";
import {
  buildSiliconAddArgs,
  describeSiliconPatchRejection,
  SILICONED_DEFAULT_PROMPT,
  type SiliconMode,
} from "./siliconedPlan";
import { retryUnknownJob } from "./siliconedRetry";
import {
  emptySiliconMacs,
  planComputeTarget,
  targetLabel,
  type SiliconComputeTarget,
  type SiliconMacsSnapshot,
  type SiliconTargetPolicy,
} from "./siliconedTarget";
import type { ComputeTargetInfo, ProviderProgress } from "./types";

/**
 * Siliconed 平台接入（docs/siliconed-integration-plan.md 工作流 A / A3）。
 *
 * 一次请求（mask 移除工作流，0.20）：
 * 1) 把送图 PNG 与同尺寸黑白蒙版写到插件 data folder 的临时目录；
 * 2) `add --model qwen-image-2.1 --image <png> --mask <png> --mode <remove|redraw> <prompt> <seed>`
 *    立即返回 job（不传 --steps，走工作流默认 9 步；不传 --ref / 显式尺寸）；
 * 3) 轮询 `status`（≥1s）回传 fraction / stage / remaining_s；
 * 4) 任务消失后 `wait <job> --out <dir>`（已完成任务立即返回）取结果 PNG 路径；
 * 5) 二进制读回 → base64，交给现有贴回管线。
 *
 * 默认 `--paste`：CLI 把裁剪块合回原图，返回尺寸严格等于 `--image`（实测 1248×1807
 * 进、1248×1807 出），因此贴回可直接复用 capture.expanded，不需要裁剪偏移补偿。
 */

const POLL_INTERVAL_MS = 1200;

interface UXPEntryLike {
  nativePath: string;
  delete?(): Promise<void>;
}

interface UXPFileLike extends UXPEntryLike {
  write(
    data: string | ArrayBuffer,
    options?: { format?: symbol; append?: boolean },
  ): Promise<unknown>;
  read(options?: { format?: symbol }): Promise<string | ArrayBuffer>;
}

interface UXPFolderLike extends UXPEntryLike {
  createFile(
    name: string,
    options?: { overwrite?: boolean },
  ): Promise<UXPFileLike>;
  createFolder(name: string): Promise<UXPFolderLike>;
  getEntry(name: string): Promise<UXPFileLike | undefined>;
}

interface UXPStorageLike {
  localFileSystem: { getDataFolder(): Promise<UXPFolderLike> };
  formats: { binary: symbol };
}

const storage = (uxp as unknown as { storage?: UXPStorageLike }).storage;

const STAGE_LABELS: Record<string, string> = {
  text: "解析提示词",
  image: "编码参考图",
  denoising: "生成中",
  decoding: "解码图像",
};

const stageText = (stage?: string): string =>
  (stage && STAGE_LABELS[stage]) || stage || "";

interface SiliconTempWorkspace {
  folder: UXPFolderLike;
  imagePath: string;
  maskPath: string;
  outDir: string;
  imageFile: UXPFileLike;
  maskFile: UXPFileLike;
  outputs: UXPFileLike[];
  cleanup: () => Promise<void>;
}

const deleteBestEffort = async (entry: UXPEntryLike | undefined): Promise<void> => {
  try {
    await Promise.resolve(entry?.delete?.());
  } catch {
    /* 清理失败不影响主流程 */
  }
};

const writeBinary = async (
  folder: UXPFolderLike,
  name: string,
  dataUri: string,
): Promise<UXPFileLike> => {
  if (!storage?.formats?.binary) {
    throw new ProviderError("terminal", "当前宿主不支持 UXP 本地文件系统，无法向 Siliconed 传递图片");
  }
  const file = await folder.createFile(name, { overwrite: true });
  const bytes = dataUriToBytes(dataUri);
  await file.write(bytes.buffer as ArrayBuffer, {
    format: storage.formats.binary,
  });
  return file;
};

const createTempWorkspace = async (
  imageDataUri: string,
  maskDataUri: string,
): Promise<SiliconTempWorkspace> => {
  if (!storage?.localFileSystem || !storage.formats?.binary) {
    throw new ProviderError("terminal", "当前宿主不支持 UXP 本地文件系统，无法向 Siliconed 传递图片");
  }
  const root = await storage.localFileSystem.getDataFolder();
  const name = `siliconed-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const folder = await root.createFolder(name);
  const imageFile = await writeBinary(folder, "image.png", imageDataUri);
  const maskFile = await writeBinary(folder, "mask.png", maskDataUri);
  const outputs: UXPFileLike[] = [];
  return {
    folder,
    imagePath: imageFile.nativePath,
    maskPath: maskFile.nativePath,
    outDir: folder.nativePath,
    imageFile,
    maskFile,
    outputs,
    cleanup: async () => {
      await deleteBestEffort(imageFile);
      await deleteBestEffort(maskFile);
      for (const file of outputs) await deleteBestEffort(file);
      await deleteBestEffort(folder);
    },
  };
};

interface UXPImageFileLike {
  read(options: { format: symbol }): Promise<string | ArrayBuffer>;
}

const isFileLike = (entry: unknown): entry is UXPImageFileLike =>
  Boolean(
    entry &&
      typeof entry === "object" &&
      typeof (entry as { read?: unknown }).read === "function",
  );

/** wait --out 的路径是绝对路径；用 basename 回到我们创建的临时目录取文件。 */
const findOutputFile = async (
  folder: UXPFolderLike,
  path: string,
): Promise<UXPFileLike> => {
  const base = path.split(/[\\/]/).filter(Boolean).pop();
  if (!base) throw new ProviderError("terminal", "Siliconed 返回的结果路径为空");
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await folder.getEntry(base);
    if (isFileLike(entry)) return entry as unknown as UXPFileLike;
    await sleep(300);
  }
  throw new ProviderError(
    "terminal",
    `找不到 Siliconed 输出的图片：${base}（可能写入失败）`,
  );
};

export interface SiliconedConfig {
  /** silicontrol 可执行文件路径。 */
  cliPath: string;
  /** 整任务超时（毫秒）；排队 / 估算时间会在此基础上延长。 */
  timeoutMs: number;
  pollIntervalMs?: number;
  /** 计算目标：local 本机 / mac 指定已配对 Mac（0.20 跨机）。 */
  computeTarget?: SiliconComputeTarget;
  /** target=mac 时的 Mac id（兼容名称）。 */
  targetMacId?: string;
  /** computing_on 与目标不一致时的策略（默认 auto）。 */
  targetPolicy?: SiliconTargetPolicy;
  /** 提交前校验结果 / 实际目标回传（写入历史与 UI）。 */
  onComputeTarget?: (info: ComputeTargetInfo) => void;
  /** 取消标记：只在两次 status 轮询之间生效（在途命令无法中断）。 */
  signal?: AbortSignal;
  /** add 成功拿到远端 job id 后回调（队列取消需要精确停止该任务）。 */
  onJobId?: (job: string) => void;
  onProgress?: (progress: ProviderProgress) => void;
}

const progressFromStatus = (
  status: SiliconStatus,
  snapshot: SiliconJobSnapshot,
  extra?: { firstMeasure?: boolean },
): ProviderProgress => {
  // 远端首次渲染会先自测（约 2 分钟），estimate_s 尚无值；显式标注避免看起来像卡死
  const measuring = extra?.firstMeasure
    ? "目标机首次测量中（约 2 分钟）· "
    : "";
  if (snapshot.state === "running" && snapshot.running) {
    const running = snapshot.running;
    return {
      fraction: running.fraction ?? null,
      stage: `${measuring}${stageText(running.stage)}`,
      remainingS: running.remainingS ?? null,
    };
  }
  if (snapshot.state === "waiting-license") {
    return {
      fraction: 0,
      stage: "等待在 Siliconed 中接受模型许可",
      remainingS: null,
    };
  }
  if (snapshot.state === "queued") {
    // position 1 = the next one；前面 = 正在跑的任务 + 队列中排在它之前的任务
    const ahead = (snapshot.queueIndex ?? 0) + (status.running ? 1 : 0);
    const installing = status.installing
      ? `（Siliconed 正在安装模型：${status.installing.title ?? ""}）`
      : "";
    return {
      fraction: 0,
      stage:
        `${measuring}` +
        (ahead > 0
          ? `排队中，前面还有 ${ahead} 个任务${installing}`
          : `排队中${installing}`),
      remainingS: snapshot.queueItem?.estimateS ?? status.queueRemainingS ?? null,
    };
  }
  return { fraction: null, stage: "准备结果", remainingS: null };
};

/** 读取当前计算目标快照：macs 仅在选择指定 Mac 时查询；其余用 status.computing_on。 */
const readTargetSnapshot = async (
  cfg: SiliconedConfig,
  status: SiliconStatus,
): Promise<SiliconMacsSnapshot> => {
  if (cfg.computeTarget !== "mac") {
    return {
      ...emptySiliconMacs(true),
      computingOn: status.computingOn,
    };
  }
  const snapshot = await siliconMacs(cfg.cliPath);
  return { ...snapshot, computingOn: status.computingOn };
};

/**
 * 生成入口：返回 PNG base64（无 data: 前缀）。
 * 送图与蒙版由 capture 按预设尺寸产出，CLI 默认 paste 会原尺寸返回，贴回仍按 capture.expanded。
 */
export async function siliconedGenerate(
  cfg: SiliconedConfig,
  imageDataUri: string,
  maskDataUri: string,
  prompt: string,
  mode: SiliconMode = "remove",
): Promise<string> {
  if (!isMacHost()) {
    throw new ProviderError("terminal", "Siliconed 仅支持 macOS 26+");
  }
  // remove 分支允许留空（上游通常已注入默认移除文案，此处只兜底）；
  // redraw 分支提示词必填，空着交给 CLI 会拒单，这里给明确报错
  const text = prompt.trim();
  if (!text && mode === "redraw") {
    throw new ProviderError("terminal", "重绘模式需要填写提示词");
  }
  const finalPrompt = text || SILICONED_DEFAULT_PROMPT;
  const temp = await createTempWorkspace(imageDataUri, maskDataUri);

  try {
    // 0) 提交前校验实际计算目标：Siliconed 会自行回切，绝不能假设目标固定
    const preStatus = await siliconStatus(cfg.cliPath);
    let targetSnapshot = await readTargetSnapshot(cfg, preStatus);
    const policy = cfg.targetPolicy ?? "auto";
    const check = planComputeTarget(
      {
        target: cfg.computeTarget ?? "local",
        macId: cfg.targetMacId,
        policy,
      },
      targetSnapshot,
    );
    if (check.kind === "blocked") {
      throw new ProviderError(
        "terminal",
        check.message ?? "计算目标不可用",
        undefined,
        "compute_target",
      );
    }
    let switched = false;
    if (check.kind === "switch" && check.computeArg) {
      await siliconCompute(cfg.cliPath, check.computeArg);
      switched = true;
      // compute 返回后再读一次 status：确认切换是否真的生效（0.20 会自行回切）
      const refreshed = await siliconStatus(cfg.cliPath);
      targetSnapshot = { ...targetSnapshot, computingOn: refreshed.computingOn };
    }

    const seed = Math.floor(Math.random() * 2 ** 31);
    let add: Awaited<ReturnType<typeof siliconAdd>>;
    try {
      add = await siliconAdd(
        cfg.cliPath,
        buildSiliconAddArgs({
          imagePath: temp.imagePath,
          maskPath: temp.maskPath,
          mode,
          prompt: finalPrompt,
          seed,
        }),
      );
    } catch (e) {
      // patch 路径的「蒙版裁剪短边不足」拒单翻译为可操作提示，其余原样抛出
      const msg = e instanceof Error ? e.message : String(e);
      const hint = describeSiliconPatchRejection(msg);
      if (hint) throw new ProviderError("terminal", hint);
      throw e;
    }
    // 远端已经接单：把 job id 交给队列，取消时用 silicontrol cancel <job> 真取消
    cfg.onJobId?.(add.job);

    // add 响应里的 computing_on 可能已经回切：以它为准记录实际目标并写入历史
    const actual = add.computingOn ?? targetSnapshot.computingOn;
    const requested = check.targetLabel;
    const actualName = targetLabel(actual);
    const selectedMacId = (cfg.targetMacId ?? "").trim();
    const matches =
      cfg.computeTarget === "mac"
        ? actual !== null &&
          (actual === requested || actual === selectedMacId)
        : actual === null;
    const mismatch = !matches;
    // 远端首次渲染会先自测（约 110s），此时 add 的 estimate_s 为空
    const firstMeasure = actual !== null && add.estimateS == null;
    const notes: string[] = [];
    if (mismatch) {
      notes.push(
        `Siliconed 实际在「${actualName}」上计算，与目标「${requested}」不一致${
          switched ? "（已尝试切换但未生效）" : ""
        }`,
      );
    }
    if (firstMeasure) {
      notes.push(
        "目标机首次测量中：会先自测约 2 分钟，之后才会给出预计时间",
      );
    }
    const computeInfo: ComputeTargetInfo = {
      requested,
      actual: actualName,
      mismatch,
      firstMeasure,
      ...(notes.length ? { note: notes.join("；") } : {}),
    };
    cfg.onComputeTarget?.(computeInfo);

    // 整任务超时：基础值 + 队列 / 渲染估算（首次拿到 status 后延长一次）
    const startedAt = Date.now();
    const deadline = {
      at: startedAt + Math.max(cfg.timeoutMs, 120_000),
    };
    let extended = false;
    let snapshot: SiliconJobSnapshot = { state: "queued" };

    await waitForSiliconJob({
      cliPath: cfg.cliPath,
      job: add.job,
      deadline,
      pollIntervalMs: cfg.pollIntervalMs ?? POLL_INTERVAL_MS,
      signal: cfg.signal,
      onStatus: (status, current) => {
        snapshot = current;
        if (!extended) {
          const expectedMs =
            ((status.queueRemainingS ?? 0) + (add.estimateS ?? 0)) * 1000;
          if (expectedMs > 0) {
            deadline.at = Math.max(
              deadline.at,
              startedAt + expectedMs * 2 + 60_000,
            );
            extended = true;
          }
        }
        cfg.onProgress?.(
          progressFromStatus(status, current, {
            firstMeasure: computeInfo.firstMeasure,
          }),
        );
      },
    });

    // status 已看不到 job 后，wait 对已完成任务立即返回；
    // add 返回后立刻 wait 存在 unknown_job 竞态（状态尚未同步），按短重试处理
    const waited = await retryUnknownJob(() =>
      siliconWait(
        cfg.cliPath,
        [add.job],
        temp.outDir,
        Math.max(120_000, deadline.at - Date.now()),
        true,
      ),
    );
    // 取消后 wait 返回 {ok:false,error:"render"}，jobs[].outcome 为 stopped / removed；
    // 必须先看 outcome，绝不能把取消记成失败。
    const outcomes = Array.isArray(waited.verdict.jobs)
      ? waited.verdict.jobs.map((job) =>
          typeof job?.outcome === "string" ? job.outcome : "unknown",
        )
      : [];
    if (outcomes.some((o) => o === "stopped" || o === "removed")) {
      throw new ProviderError(
        "cancelled",
        `Siliconed 任务 ${add.job} 已取消（${outcomes.join(" / ")}）`,
      );
    }
    if (!waited.verdict.ok) {
      const detail =
        typeof waited.verdict.message === "string" && waited.verdict.message
          ? waited.verdict.message
          : outcomes.some((o) => o === "error")
            ? outcomes.join(" / ")
            : String(waited.verdict.error ?? "未知错误");
      throw new ProviderError("terminal", `Siliconed 任务失败：${detail}`);
    }
    const image = waited.images[0];
    if (image?.writeError) {
      throw new ProviderError(
        "terminal",
        `Siliconed 结果 PNG 写入失败：${image.writeError}`,
      );
    }
    if (!image?.path) {
      throw new ProviderError(
        "terminal",
        "Siliconed 任务已结束，但没有返回结果图片（可能被取消或写入失败）",
      );
    }
    const file = await findOutputFile(temp.folder, image.path);
    const data = (await file.read({ format: storage!.formats.binary })) as unknown;
    let bytes: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (!bytes) {
      throw new ProviderError("terminal", "读取 Siliconed 结果失败：返回内容不是二进制");
    }
    temp.outputs.push(file);
    return bytesToBase64(bytes);
  } finally {
    await temp.cleanup();
  }
}

export interface SiliconedProbeResult {
  ok: boolean;
  message: string;
}

/** 设置面板「检测 Siliconed / 模型 / 许可」：status + models 两次只读调用。 */
export const siliconedProbe = async (
  cliPath: string,
): Promise<SiliconedProbeResult> => {
  if (!isMacHost()) {
    return { ok: false, message: "Siliconed 仅支持 macOS 26+" };
  }
  if (!cliPath.trim()) {
    return { ok: false, message: "请先填写 silicontrol 路径" };
  }
  try {
    const status = await siliconStatus(cliPath);
    const models = await siliconModels(cliPath);
    const model = models.find((item) => item.id === SILICONED_MODEL_ID);
    if (!model) {
      return { ok: false, message: `Siliconed 未提供模型 ${SILICONED_MODEL_ID}` };
    }
    if (!model.ready) {
      return {
        ok: false,
        message: `模型 ${model.name || SILICONED_MODEL_ID} 未安装：${
          model.missing ?? "请在 Siliconed 应用中安装"
        }`,
      };
    }
    if (!model.licenseAccepted) {
      return {
        ok: false,
        message: `模型许可未接受（${model.license ?? "Qwen Research"}）：请在 Siliconed 应用中确认`,
      };
    }
    const queueNote =
      status.queue.length > 0 ? `；当前队列 ${status.queue.length} 个任务` : "";
    const licenseNote = model.commercialLicense
      ? ""
      : "（Qwen Research 为非商用研究许可）";
    return {
      ok: true,
      message: `已连接 Siliconed；${model.name} 就绪，9 步蒙版移除${licenseNote}${queueNote}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof ProviderError ? err.message : String(err),
    };
  }
};
