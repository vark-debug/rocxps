import { ProviderError, sleep } from "../providers/http";
import { generateWithProvider } from "../providers";
import { getCatalogModel } from "../providers/catalog";
import { resolveSiliconMode } from "../providers/siliconedPlan";
import { siliconCancel, siliconStatus, findSiliconJobState } from "../core/silicontrol";
import { placeBack } from "../ps/placeBack";
import { placeBackExpand } from "../ps/placeBackExpand";
import type { CaptureResult } from "../ps/capture";
import type { ExpandCaptureResult } from "../ps/expandCapture";
import { computeExpandPads } from "../ps/expandPlan";
import { DEFAULT_SIZE_MODE } from "../ps/presetFit";
import { decodeImageBytes } from "../ps/imageDecode";
import { encodePng } from "../ps/pngEncoder";
import { resizeRgba } from "../ps/resize";
import { loadApiKey, loadSettings } from "../settings/store";
import { applyGenerationOverride, providerRequiresKey } from "../settings/templates";
import type { RedrawSettings } from "../settings/types";
import { requestSizeFor } from "./pipeline";
import {
  LOGICAL_CANCEL_GRACE_MS,
  QUEUE_HARD_LIMIT,
  laneForProvider,
  planCancel,
  planFailure,
  type QueueJob,
} from "./queue";
import { QueueStore } from "./queueStore";
import { QueueScheduler } from "./scheduler";
import { setDiagEnabled } from "../ps/placeBackDiag";

/**
 * 队列执行器：把队列项接到既有生成 / 贴回管线。
 *
 * 取消语义（与 silicontrol 实测契约一致）：
 * - Siliconed 已有远端 job id：`silicontrol cancel <job>` 真取消；
 *   removed = 已移出队列（槽位立即释放）；stopped = 正在渲染被停止；
 *   already_finished = 取消过晚，结果保留；
 * - 没有 job id / 其他平台无法中断：逻辑取消，标记 cancelRequestedAt，
 *   最多占用 LOGICAL_CANCEL_GRACE_MS（60s），随后释放槽位并忽略迟到结果；
 * - cancel 失败（网络 / 竞态 / 未知 job）重试 2 次后同样退化为逻辑取消，绝不卡死队列。
 *
 * wait 取消后的返回：{ok:false,error:"render"}，jobs[].outcome 为 stopped / removed；
 * provider 层已按 outcome 归类为 ProviderError("cancelled")，runner 不会把取消记成失败。
 */

const THUMB_MAX_SIDE = 160;

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const errKind = (err: unknown): string =>
  err instanceof ProviderError ? err.kind : "terminal";

const isCancelledError = (err: unknown): boolean =>
  err instanceof ProviderError && err.kind === "cancelled";

const thumbFromBase64 = (base64: string): Uint8Array | undefined => {
  try {
    const decoded = decodeImageBytes(base64);
    const scale = Math.min(
      1,
      THUMB_MAX_SIDE / Math.max(decoded.width, decoded.height),
    );
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const rgba = resizeRgba(decoded.rgba, decoded.width, decoded.height, width, height);
    return encodePng(width, height, rgba);
  } catch {
    // 缩略图失败不影响主结果；没有缩略图时 UI 显示占位
    return undefined;
  }
};

interface Grace {
  promise: Promise<void>;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** expand 任务的四边 pad：优先用入队快照，旧数据缺失时按 originalBounds + 画布兜底重算。 */
const expandPadsOf = (job: QueueJob) => {
  if (job.expandPads) return job.expandPads;
  return computeExpandPads(
    job.originalBounds,
    job.canvasWidth ?? job.originalBounds.right,
    job.canvasHeight ?? job.originalBounds.bottom,
  ).pads;
};

export interface CancelOutcome {
  kind: "cancelled" | "kept-result" | "already-finished" | "requested";
  message: string;
}

export class QueueRunner {
  private readonly store: QueueStore;
  private readonly notify: () => void;
  private readonly controllers = new Map<string, AbortController>();
  private readonly graces = new Map<string, Grace>();

  constructor(store: QueueStore, notify: () => void) {
    this.store = store;
    this.notify = notify;
  }

  /** 调度器入口：按当前状态决定是生成还是贴回。 */
  async run(job: QueueJob): Promise<void> {
    if (job.status === "pendingPlace") {
      await this.runPlace(job.id);
      return;
    }
    if (job.status === "queued") {
      await this.runGeneration(job.id);
    }
  }

  /* ---------------- 生成 ---------------- */

  private async runGeneration(id: string): Promise<void> {
    const initial = this.store.get(id);
    if (!initial || initial.status !== "queued") return;
    let settings: RedrawSettings;
    try {
      const base = await loadSettings();
      settings = applyGenerationOverride(base, initial.settingsOverride);
    } catch (err) {
      this.markFailed(id, `读取设置失败：${errText(err)}`, "queued");
      return;
    }
    // 模板覆盖的平台 / 模型以任务记录为准，避免设置变化导致投错平台
    settings = { ...settings, modelId: initial.modelId || settings.modelId };
    let model;
    try {
      model = getCatalogModel(settings.modelId);
    } catch (err) {
      this.markFailed(id, `模型不可用：${errText(err)}（可在设置中重新选择模型后重试）`, "queued");
      return;
    }
    if (model.provider !== initial.providerId) {
      this.markFailed(
        id,
        `任务记录的平台（${initial.providerId}）与模型目录（${model.provider}）不一致，请重新抓取生成`,
        "queued",
      );
      return;
    }
    const requiresKey =
      providerRequiresKey(model.provider) ||
      model.provider === "ark" ||
      model.provider === "runninghub";
    let apiKey = "";
    if (requiresKey) {
      try {
        apiKey = await loadApiKey(model.provider);
      } catch (err) {
        this.markFailed(id, `读取 API Key 失败：${errText(err)}`, "queued");
        return;
      }
      if (!apiKey) {
        this.markFailed(id, "尚未配置 API Key，请先打开「设置」进行配置", "queued");
        return;
      }
    }

    let capture: CaptureResult;
    try {
      if (initial.workflow === "expand") {
        // 扩图任务没有蒙版文件：只读回源图，拼一个最小 capture（generate 只用 pngBase64）
        const pngBase64 = await this.store.loadExpandCapture(initial);
        capture = {
          docId: initial.docId,
          docName: initial.docName,
          docPath: initial.docPath ?? "",
          canvasWidth: initial.canvasWidth ?? 0,
          canvasHeight: initial.canvasHeight ?? 0,
          originalBounds: initial.originalBounds,
          expanded: initial.expanded,
          sizeMode: initial.sizeMode,
          preset: null,
          sendWidth: initial.sendWidth,
          sendHeight: initial.sendHeight,
          pngBase64,
          mask: { width: 0, height: 0, data: new Uint8Array(0) },
          sendMask: { width: 0, height: 0, data: new Uint8Array(0) },
          maskPngBase64: "",
          captureRect: initial.captureRect,
          padAmounts: { left: 0, top: 0, right: 0, bottom: 0 },
          sizeWarnings: [],
          selectionExpand: 1,
        };
      } else {
        capture = await this.rebuildCapture(initial);
      }
    } catch (err) {
      this.markFailed(
        id,
        `读取队列输入文件失败：${errText(err)}（文件可能已被清理，请重新抓取）`,
        "queued",
      );
      return;
    }

    const startedAt = Date.now();
    this.store.update(id, {
      status: "running",
      stage: "submitting",
      startedAt,
      finishedAt: undefined,
      error: undefined,
      progress: undefined,
      remoteJobId: undefined,
      cancelRequestedAt: undefined,
    });
    this.notify();

    let attempt = 0;
    while (true) {
      attempt += 1;
      const controller = new AbortController();
      this.controllers.set(id, controller);
      this.store.update(id, { attempts: attempt, stage: "submitting" });
      try {
        const siliconed = initial.providerId === "siliconed";
        const expand = initial.workflow === "expand";
        // 扩图：提示词是工作流固定句子的补充，语义独立，不拼 promptSuffix
        //（默认后缀含「选区」措辞，对扩图是错误指令），也不做 remove/redraw 判定
        const resolved = expand
          ? null
          : resolveSiliconMode(
              initial.prompt,
              settings.promptSuffix,
              settings.siliconedMode,
            );
        const promptFull = expand
          ? initial.prompt.trim()
          : siliconed
            ? resolved!.prompt
            : [initial.prompt, settings.promptSuffix]
                .filter((part) => part && part.trim())
                .join("\n");
        const resultBase64 = await this.withGrace(
          id,
          generateWithProvider({
            settings,
            model,
            apiKey,
            prompt: promptFull,
            siliconMode: expand || !siliconed ? undefined : resolved!.mode,
            ...(expand
              ? {
                  expand: {
                    pads: expandPadsOf(initial),
                    ...(initial.expandMaxSample
                      ? { maxSample: initial.expandMaxSample }
                      : {}),
                  },
                }
              : {}),
            imageDataUri: `data:image/png;base64,${capture.pngBase64}`,
            maskDataUri: expand
              ? ""
              : `data:image/png;base64,${capture.maskPngBase64}`,
            capture,
            request: { reqW: initial.reqW, reqH: initial.reqH },
            signal: controller.signal,
            onJobId: (remoteJobId) => this.store.update(id, { remoteJobId }),
            onProgress: (progress) =>
              this.store.update(id, { stage: "generating", progress }),
            onComputeTarget: (compute) => this.store.update(id, { compute }),
          }),
        );
        await this.finishGeneration(id, resultBase64, settings);
        return;
      } catch (err) {
        const current = this.store.get(id);
        if (!current || current.status === "cancelled") return;
        if (isCancelledError(err) || (current.cancelRequestedAt && !current.remoteJobId)) {
          // 竞态兜底：取消发生在 add 之后、onJobId 之前时，远端可能已经接单；
          // 尽力再发一次 cancel，避免远端白跑（失败不影响本地取消）。
          if (current.remoteJobId && current.providerId === "siliconed") {
            void this.cancelRemoteSilently(current.remoteJobId);
          }
          this.markCancelled(id, errText(err) || "任务已取消", false);
          return;
        }
        const action = planFailure(
          {
            attempts: attempt,
            autoRetryUsed: current.autoRetryUsed,
            remoteJobId: current.remoteJobId,
          },
          errKind(err),
        );
        if (action === "auto-retry") {
          // 提交阶段可重试：只重投 1 次，且一定是还没拿到远端 job id 的情况
          this.store.update(id, {
            autoRetryUsed: true,
            remoteJobId: undefined,
            progress: undefined,
          });
          await sleep(800);
          continue;
        }
        this.markFailed(id, errText(err), current.stage === "placing" ? "placing" : "generating");
        return;
      } finally {
        this.controllers.delete(id);
        this.clearGrace(id);
      }
    }
  }

  private async finishGeneration(
    id: string,
    resultBase64: string,
    settings: RedrawSettings,
  ): Promise<void> {
    const job = this.store.get(id);
    if (!job) return;
    if (job.status === "cancelled") return;
    let written: { resultPath: string; thumbPath?: string; resultBytes: number; thumbBytes: number };
    try {
      written = await this.store.writeResult(id, resultBase64, thumbFromBase64(resultBase64));
    } catch (err) {
      this.markFailed(id, `生成结果落盘失败：${errText(err)}`, "generating");
      return;
    }
    const elapsedMs = job.startedAt ? Date.now() - job.startedAt : undefined;
    const autoPlace = job.cancelRequestedAt ? false : settings.autoPlaceBack;
    this.store.update(id, {
      status: "pendingPlace",
      stage: "queued",
      autoPlace,
      resultPath: written.resultPath,
      thumbPath: written.thumbPath,
      resultBytes: written.resultBytes,
      thumbBytes: written.thumbBytes,
      elapsedMs,
      finishedAt: Date.now(),
      progress: undefined,
      ...(job.cancelRequestedAt
        ? { placeNote: "取消过晚：生成已经完成，结果已保留，可手动贴回" }
        : {}),
    });
    this.store.enforceDiskLimit(this.diskLimitBytes);
    this.notify();
  }

  /* ---------------- 贴回 ---------------- */

  private async runPlace(id: string): Promise<void> {
    const job = this.store.get(id);
    if (!job || job.status !== "pendingPlace" || !job.autoPlace) return;
    let settings: RedrawSettings;
    try {
      settings = await loadSettings();
    } catch (err) {
      this.markFailed(id, `读取设置失败：${errText(err)}`, "placing");
      return;
    }
    this.store.update(id, { stage: "placing", autoPlace: false, error: undefined });
    this.notify();
    try {
      const resultBase64 = await this.store.loadResultBase64(job);
      const placed =
        job.workflow === "expand"
          ? await placeBackExpand({
              docId: job.reboundDocId ?? job.docId,
              docName: job.docName,
              docPath: job.docPath,
              canvasWidth: job.canvasWidth,
              canvasHeight: job.canvasHeight,
              source: job.originalBounds,
              pads: expandPadsOf(job),
              resultBase64,
              reqW: job.reqW,
              reqH: job.reqH,
            })
          : await placeBack({
              docId: job.reboundDocId ?? job.docId,
              docName: job.docName,
              docPath: job.docPath,
              canvasWidth: job.canvasWidth,
              canvasHeight: job.canvasHeight,
              expanded: job.expanded,
              mask: await this.store.loadMask(job),
              // 贴回时读当前设置（任务里只记录实际生效的模式）
              mode: settings.placeBackMode,
              resultBase64,
              reqW: job.reqW,
              reqH: job.reqH,
            });
      if (placed.documentMissing) {
        this.store.update(id, {
          status: "pendingPlace",
          stage: "queued",
          autoPlace: false,
          documentMissing: true,
          artifactPath: placed.artifactPath,
          placeNote: placed.note,
          placedLayer: undefined,
          actualOutputSize: placed.actualOutputSize,
          outputMismatch: placed.outputMismatch,
          appliedScale: placed.appliedScale,
          error: undefined,
        });
        this.notify();
        return;
      }
      const cancelled = Boolean(this.store.get(id)?.cancelRequestedAt);
      this.store.update(id, {
        status: cancelled ? "cancelled" : "completed",
        stage: "queued",
        autoPlace: false,
        placeBackMode: placed.mode,
        placedLayer: placed.layerName,
        placeNote: cancelled
          ? `${placed.note ? `${placed.note}；` : ""}贴回已完成，但任务已被取消`
          : placed.note,
        documentMissing: false,
        artifactPath: undefined,
        reboundDocId: placed.reboundDocId,
        placedInBackground: placed.placedInBackground,
        actualOutputSize: placed.actualOutputSize,
        outputMismatch: placed.outputMismatch,
        appliedScale: placed.appliedScale,
        finishedAt: Date.now(),
        // 完成项删大文件、留缩略图；占用计数同步归零，避免磁盘 LRU 反复尝试清理
        inputBytes: 0,
        resultBytes: 0,
      });
      // 完成项删大文件、留缩略图；取消项同样保留缩略图便于辨认
      const updated = this.store.get(id);
      if (updated) void this.store.removeFiles(updated, { keepThumb: true });
      this.store.enforceDiskLimit(this.diskLimitBytes);
      this.notify();
    } catch (err) {
      this.markFailed(id, errText(err), "placing");
    }
  }

  /* ---------------- 取消 ---------------- */

  /**
   * 设置队列暂停并唤醒调度器：恢复执行（false）时立即派发积压任务；
   * 暂停（true）时不打断正在运行的任务。UI 不直接调 store，避免漏掉唤醒。
   */
  setPaused(paused: boolean): void {
    this.store.setPaused(paused);
    this.notify();
  }

  async cancel(id: string): Promise<CancelOutcome> {
    const job = this.store.get(id);
    if (!job) return { kind: "cancelled", message: "任务不存在" };
    if (job.status === "completed") {
      return { kind: "already-finished", message: "任务已经完成，无需取消" };
    }
    if (job.status === "pendingPlace" && job.stage === "placing") {
      // Photoshop 的 modal 命令已提交，无法中断；标记取消，完成后保留结果
      this.store.update(id, { cancelRequestedAt: Date.now(), autoPlace: false });
      return {
        kind: "requested",
        message: "贴回命令已提交，无法中断；完成后会保留生成结果",
      };
    }
    const plan = planCancel(job);
    if (plan.action === "drop-now") {
      if (job.status === "pendingPlace") {
        this.store.update(id, {
          status: "cancelled",
          stage: "queued",
          autoPlace: false,
          finishedAt: Date.now(),
          cancelRequestedAt: Date.now(),
          placeNote: plan.reason,
          progress: undefined,
        });
        return { kind: "kept-result", message: plan.reason };
      }
      this.store.update(id, {
        status: "cancelled",
        stage: "queued",
        finishedAt: Date.now(),
        cancelRequestedAt: Date.now(),
        placeNote: plan.reason,
        progress: undefined,
        inputBytes: 0,
        resultBytes: 0,
        thumbBytes: 0,
      });
      void this.store.removeFiles(job, { keepThumb: false });
      this.store.enforceDiskLimit(this.diskLimitBytes);
      return { kind: "cancelled", message: plan.reason };
    }

    if (plan.action === "cancel-remote" && plan.remoteJobId) {
      const remoteId = plan.remoteJobId;
      let cancelled: Awaited<ReturnType<typeof siliconCancel>> | null = null;
      let lastError: unknown = null;
      for (let i = 0; i < 3; i++) {
        try {
          const settings = await loadSettings();
          cancelled = await siliconCancel(settings.siliconedCliPath, [remoteId]);
          break;
        } catch (err) {
          lastError = err;
          await sleep(1000);
        }
      }
      if (cancelled) {
        if (cancelled.removed.includes(remoteId)) {
          this.abort(id);
          this.store.update(id, {
            cancelRequestedAt: Date.now(),
            placeNote: "已从远端队列移除",
          });
          return { kind: "cancelled", message: "已从远端队列移除，槽位立即释放" };
        }
        if (cancelled.stopped.includes(remoteId)) {
          this.abort(id);
          this.store.update(id, {
            cancelRequestedAt: Date.now(),
            placeNote: "已停止远端渲染",
          });
          return { kind: "cancelled", message: "远端渲染已停止（已生成的中间图留在 Siliconed 历史）" };
        }
        if (cancelled.alreadyFinished.includes(remoteId)) {
          this.store.update(id, {
            cancelRequestedAt: Date.now(),
            placeNote: "取消过晚：远端已完成，结果会保留",
          });
          return {
            kind: "already-finished",
            message: "取消过晚：远端任务已完成，结果会保留",
          };
        }
        // 没有明确结果：复查一次远端状态，避免把「已完成」误判成仍需等待
        try {
          const status = await siliconStatus((await loadSettings()).siliconedCliPath);
          if (findSiliconJobState(status, remoteId).state === "gone") {
            this.store.update(id, {
              cancelRequestedAt: Date.now(),
              placeNote: "取消过晚：远端已经结束，结果会保留",
            });
            return { kind: "already-finished", message: "远端任务已经结束，结果会保留" };
          }
        } catch {
          /* 状态复查失败：退化为逻辑取消 */
        }
      }
      // cancel 失败 / 无法确认：逻辑取消，超时后释放槽位
      return this.logicalCancel(
        id,
        lastError
          ? `取消请求失败（${errText(lastError)}），已标记取消，最多占用 ${Math.round(
              LOGICAL_CANCEL_GRACE_MS / 1000,
            )}s`
          : `远端未能确认取消，已标记取消，最多占用 ${Math.round(
              LOGICAL_CANCEL_GRACE_MS / 1000,
            )}s`,
      );
    }

    return this.logicalCancel(id, plan.reason);
  }

  private logicalCancel(id: string, message: string): CancelOutcome {
    this.createGrace(id);
    this.store.update(id, {
      cancelRequestedAt: Date.now(),
      placeNote: message,
    });
    // Siliconed 在两次 status 轮询之间响应 abort；其他平台无法中断请求，等 grace 超时释放
    this.abort(id);
    return { kind: "requested", message };
  }

  /* ---------------- 重试 ---------------- */

  async retry(id: string): Promise<void> {
    const job = this.store.get(id);
    if (!job) return;
    if (job.filesPruned) {
      this.store.update(id, {
        status: "failed",
        error: "输入文件已被保留期 / 磁盘上限清理，请重新抓取后再生成",
      });
      return;
    }
    if (job.status === "failed" && job.stage === "placing" && job.resultPath) {
      this.store.update(id, {
        status: "pendingPlace",
        stage: "queued",
        autoPlace: false,
        error: undefined,
        finishedAt: undefined,
      });
      this.notify();
      return;
    }
    if (job.status === "cancelled" && job.resultPath) {
      // 取消待贴回：结果保留，可直接再贴
      this.store.update(id, {
        status: "pendingPlace",
        stage: "queued",
        autoPlace: false,
        error: undefined,
        finishedAt: undefined,
        cancelRequestedAt: undefined,
        placeNote: undefined,
      });
      this.notify();
      return;
    }
    this.store.update(id, {
      status: "queued",
      stage: "queued",
      autoPlace: false,
      error: undefined,
      progress: undefined,
      finishedAt: undefined,
      startedAt: undefined,
      cancelRequestedAt: undefined,
      remoteJobId: undefined,
      attempts: 0,
      autoRetryUsed: false,
      elapsedMs: undefined,
      placeNote: undefined,
    });
    this.notify();
  }

  /** 用户点击「贴回」/ 重新贴回：进入 place lane 排队。 */
  requestPlace(id: string): void {
    const job = this.store.get(id);
    if (!job?.resultPath) return;
    if (job.status === "completed") return;
    this.store.update(id, {
      status: "pendingPlace",
      stage: "queued",
      autoPlace: true,
      documentMissing: false,
      error: undefined,
    });
    this.notify();
  }

  /* ---------------- 辅助 ---------------- */

  private async cancelRemoteSilently(remoteId: string): Promise<void> {
    try {
      const settings = await loadSettings();
      await siliconCancel(settings.siliconedCliPath, [remoteId]);
    } catch {
      /* 尽力而为：失败时保留远端任务，由 Siliconed 自行跑完 */
    }
  }

  private abort(id: string): void {
    try {
      this.controllers.get(id)?.abort();
    } catch {
      /* ignore */
    }
  }

  private createGrace(id: string): void {
    if (this.graces.has(id)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => {
      const current = this.store.get(id);
      if (current && current.status === "running") {
        this.markCancelled(id, "取消超时：已释放队列槽位，迟到的结果将被忽略", false);
      }
      resolve();
    }, LOGICAL_CANCEL_GRACE_MS);
    this.graces.set(id, { promise, resolve, timer });
  }

  private clearGrace(id: string): void {
    const grace = this.graces.get(id);
    if (!grace) return;
    clearTimeout(grace.timer);
    grace.resolve();
    this.graces.delete(id);
  }

  private withGrace<T>(id: string, promise: Promise<T>): Promise<T> {
    const grace = this.graces.get(id);
    if (!grace) return promise;
    return Promise.race([
      promise,
      grace.promise.then(() => {
        throw new ProviderError(
          "cancelled",
          "已取消（取消请求未能确认远端状态，超时后释放槽位）",
        );
      }),
    ]);
  }

  private markCancelled(id: string, message: string, keepResult: boolean): void {
    const job = this.store.get(id);
    if (!job) return;
    this.store.update(id, {
      status: "cancelled",
      stage: "queued",
      autoPlace: false,
      finishedAt: Date.now(),
      cancelRequestedAt: job.cancelRequestedAt ?? Date.now(),
      placeNote: message,
      progress: undefined,
      error: undefined,
      ...(keepResult
        ? {}
        : { inputBytes: 0, resultBytes: 0, thumbBytes: job.thumbBytes ?? 0 }),
    });
    if (!keepResult) {
      void this.store.removeFiles(job, { keepThumb: Boolean(job.thumbPath) });
    }
    this.notify();
  }

  private markFailed(id: string, message: string, stage: "queued" | "generating" | "placing"): void {
    const job = this.store.get(id);
    if (!job) return;
    if (job.cancelRequestedAt) {
      this.markCancelled(id, message, Boolean(job.resultPath));
      return;
    }
    this.store.update(id, {
      status: "failed",
      stage,
      error: message,
      finishedAt: Date.now(),
      elapsedMs: job.startedAt ? Date.now() - job.startedAt : undefined,
      progress: undefined,
      autoPlace: false,
    });
    // 失败保留输入文件（默认 7 天）供重试；只在磁盘超限时清理
    this.store.enforceDiskLimit(this.diskLimitBytes);
    this.notify();
  }

  private get diskLimitBytes(): number {
    return this.limitBytes;
  }

  private limitBytes = 2 * 1024 * 1024 * 1024;

  setDiskLimitBytes(bytes: number): void {
    this.limitBytes = bytes;
  }

  private async rebuildCapture(job: QueueJob): Promise<CaptureResult> {
    const loaded = await this.store.loadCapture(job);
    return {
      docId: job.docId,
      docName: job.docName,
      docPath: job.docPath ?? "",
      canvasWidth: job.canvasWidth ?? 0,
      canvasHeight: job.canvasHeight ?? 0,
      originalBounds: job.originalBounds,
      expanded: job.expanded,
      sizeMode: job.sizeMode,
      // 预设对象本身只用于展示；贴回与生成都按已落盘的尺寸走
      preset: null,
      sendWidth: job.sendWidth,
      sendHeight: job.sendHeight,
      pngBase64: loaded.pngBase64,
      mask: loaded.mask,
      sendMask: loaded.sendMask,
      maskPngBase64: loaded.maskPngBase64,
      captureRect: job.captureRect,
      padAmounts: { left: 0, top: 0, right: 0, bottom: 0 },
      sizeWarnings: [],
      // 重建只用于生成/贴回；外扩已固化在落盘的 expanded 与尺寸里
      selectionExpand: 1,
    };
  }
}

/* ---------------- 运行时单例（主面板 / 设置共用） ---------------- */

export const queueStore = new QueueStore();
export const queueScheduler = new QueueScheduler({
  getJobs: () => queueStore.list(),
  concurrency: () => concurrencyCache,
  paused: () => queueStore.isPaused(),
  run: (job) => queueRunner.run(job),
  onError: () => undefined,
});
export const queueRunner = new QueueRunner(queueStore, () => queueScheduler.notify());

let concurrencyCache = 2;
let runtimeReady = false;

const readLimitBytes = (settings: RedrawSettings): number => {
  const mb = Number(settings.queueDiskLimitMB);
  const safe = Number.isFinite(mb) && mb > 0 ? mb : 2048;
  return safe * 1024 * 1024;
};

/** 初始化队列运行时（幂等）：加载磁盘队列、清理孤儿、应用诊断开关与磁盘上限。 */
export const initQueueRuntime = async (): Promise<void> => {
  const settings = await loadSettings();
  concurrencyCache = settings.concurrency || 2;
  setDiagEnabled(settings.debugDiag === true);
  const limit = readLimitBytes(settings);
  queueRunner.setDiskLimitBytes(limit);
  await queueStore.init(limit);
  queueStore.enforceDiskLimit(limit);
  queueScheduler.notify();
  runtimeReady = true;
};

/** 设置变化（并发数 / 诊断开关 / 磁盘上限）后刷新运行时缓存。 */
export const refreshQueueRuntime = async (): Promise<void> => {
  const settings = await loadSettings();
  concurrencyCache = settings.concurrency || 2;
  setDiagEnabled(settings.debugDiag === true);
  const limit = readLimitBytes(settings);
  queueRunner.setDiskLimitBytes(limit);
  if (!runtimeReady) {
    await queueStore.init(limit);
    runtimeReady = true;
  }
  queueStore.enforceDiskLimit(limit);
  queueScheduler.notify();
};

export interface EnqueueOptions {
  prompt: string;
  capture: CaptureResult;
  /** 入队时生效的设置（含模板的一次性覆盖）。 */
  settings: RedrawSettings;
  settingsOverride?: Partial<RedrawSettings>;
}

const newJobId = (): string =>
  `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 入队：先把抓取结果落盘，再写入只含路径的队列项。 */
export const enqueueCapture = async (options: EnqueueOptions): Promise<QueueJob> => {
  const { prompt, capture, settings, settingsOverride } = options;
  await queueStore.init();
  if (!queueStore.hasCapacity()) {
    throw new Error(
      `任务队列积压过多（超过 ${QUEUE_HARD_LIMIT} 条），请先执行或清理队列`,
    );
  }
  const model = getCatalogModel(settings.modelId);
  const request = requestSizeFor(model, capture);
  const id = newJobId();
  const files = await queueStore.persistCapture(id, capture);
  const job: QueueJob = {
    id,
    prompt: prompt.trim(),
    providerId: model.provider,
    modelId: model.id,
    ...(settingsOverride ? { settingsOverride } : {}),
    docId: capture.docId,
    docName: capture.docName,
    ...(capture.docPath ? { docPath: capture.docPath } : {}),
    canvasWidth: capture.canvasWidth,
    canvasHeight: capture.canvasHeight,
    originalBounds: capture.originalBounds,
    expanded: capture.expanded,
    captureRect: capture.captureRect,
    sizeMode: capture.sizeMode,
    presetId: capture.preset?.id ?? null,
    sendWidth: capture.sendWidth,
    sendHeight: capture.sendHeight,
    reqW: request?.reqW ?? capture.sendWidth,
    reqH: request?.reqH ?? capture.sendHeight,
    refPath: files.refPath,
    maskPath: files.maskPath,
    sendMaskPath: files.sendMaskPath,
    maskPngPath: files.maskPngPath,
    inputBytes: files.inputBytes,
    status: "queued",
    stage: "queued",
    lane: laneForProvider(model.provider),
    createdAt: Date.now(),
    attempts: 0,
  };
  try {
    queueStore.add(job);
  } catch (err) {
    // 入队被拒（并发下队列刚好满）：清掉落盘文件，避免留下孤儿目录
    await queueStore.removeFiles(job, { keepThumb: false });
    throw err;
  }
  queueScheduler.notify();
  return job;
};

export interface EnqueueExpandOptions {
  prompt: string;
  capture: ExpandCaptureResult;
  /** 入队时生效的设置（provider 必须是 Siliconed）。 */
  settings: RedrawSettings;
}

/**
 * 阔图入队：源图立刻落盘（无蒙版），队列项只保留路径。
 *
 * 字段映射（复用 QueueJob 既有几何字段）：
 * - originalBounds = 非透明包围盒（源图区域，画布坐标）；
 * - expanded = 整个扩展画布（贴回语义上是「扩到的目标区域」）；
 * - reqW/reqH = 逻辑输出画布（源图 × (1 + pad%)），outputMismatch 比较基准；
 * - mask 路径全部置空串（expand 无蒙版）。
 */
export const enqueueExpandCapture = async (
  options: EnqueueExpandOptions,
): Promise<QueueJob> => {
  const { prompt, capture, settings } = options;
  await queueStore.init();
  if (!queueStore.hasCapacity()) {
    throw new Error(
      `任务队列积压过多（超过 ${QUEUE_HARD_LIMIT} 条），请先执行或清理队列`,
    );
  }
  const model = getCatalogModel(settings.modelId);
  if (model.provider !== "siliconed") {
    throw new Error("扩图仅支持 Siliconed：请先在设置中切换模型");
  }
  const id = newJobId();
  const files = await queueStore.persistExpandCapture(id, capture);
  const canvasRect = {
    left: 0,
    top: 0,
    right: capture.canvasWidth,
    bottom: capture.canvasHeight,
  };
  const job: QueueJob = {
    id,
    prompt: prompt.trim(),
    providerId: model.provider,
    modelId: model.id,
    docId: capture.docId,
    docName: capture.docName,
    ...(capture.docPath ? { docPath: capture.docPath } : {}),
    canvasWidth: capture.canvasWidth,
    canvasHeight: capture.canvasHeight,
    originalBounds: capture.source,
    expanded: {
      bounds: canvasRect,
      width: capture.canvasWidth,
      height: capture.canvasHeight,
    },
    captureRect: canvasRect,
    // 扩图不走尺寸预设；sizeMode 仅作元数据保留
    sizeMode: DEFAULT_SIZE_MODE,
    presetId: null,
    sendWidth: capture.sendWidth,
    sendHeight: capture.sendHeight,
    reqW: capture.pads.logicalWidth,
    reqH: capture.pads.logicalHeight,
    workflow: "expand",
    expandPads: capture.pads.pads,
    expandMaxSample: settings.expandMaxSample,
    refPath: files.refPath,
    maskPath: "",
    sendMaskPath: "",
    maskPngPath: "",
    inputBytes: files.inputBytes,
    status: "queued",
    stage: "queued",
    lane: laneForProvider(model.provider),
    createdAt: Date.now(),
    attempts: 0,
  };
  try {
    queueStore.add(job);
  } catch (err) {
    await queueStore.removeFiles(job, { keepThumb: false });
    throw err;
  }
  queueScheduler.notify();
  return job;
};
