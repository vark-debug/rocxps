import { useEffect, useRef, useState, type CSSProperties } from "react";
import { type RequestSizeResult } from "../ark/sizeStrategy";
import { getCatalogModel } from "../providers/catalog";
import { captureSelection, type CaptureResult } from "../ps/capture";
import { captureExpandCanvas, type ExpandCaptureResult } from "../ps/expandCapture";
import type { PanelWorkflow } from "../ps/expandPlan";
import { upscaleActiveLayer } from "../ps/layerUpscale";
import {
  DEFAULT_UPSCALE_LONG_SIDE,
  normalizeUpscaleLongSide,
} from "../core/upscalePlan";
import { SILICONED_SELECTION_EXPAND } from "../ps/geometry";
import {
  detectSiliconMode,
  type SiliconMode,
  type SiliconModeChoice,
} from "../providers/siliconedPlan";
import { CAPTURE_ALIGN } from "../ps/align";
import { presetLabel } from "../ps/presets";
import { loadSettings, loadApiKey, saveSettings } from "../settings/store";
import {
  applyGenerationOverride,
  decideTemplateApply,
  providerRequiresKey,
  resolveTemplateProvider,
} from "../settings/templates";
import { isMacHost } from "../providers/host";
import { providerLabel } from "../providers/types";
import type {
  PlaceBackMode,
  PromptTemplate,
  RedrawSettings,
} from "../settings/types";
import { requestSizeFor } from "../task/pipeline";
import type { QueueJob } from "../task/queue";
import {
  enqueueCapture,
  enqueueExpandCapture,
  initQueueRuntime,
  queueRunner,
  queueStore,
  refreshQueueRuntime,
} from "../task/queueRunner";
import { uxp } from "../globals";
import { openUXPPanel } from "../api/uxp";
import { promptBlocksSubmit } from "../task/promptPolicy";

const pluginId = uxp.entrypoints._pluginInfo.id;

/** 本次实际贴回模式（图层蒙版失败降级时显示降级后的模式）。 */
const PLACE_MODE_LABELS: Record<PlaceBackMode, string> = {
  layerMask: "图层蒙版",
  mask: "像素蒙版",
  block: "整块替换",
};

/** Siliconed 处理方式：auto 按提示词自动判定，其余为手动覆盖。 */
const SILICON_MODE_OPTIONS: Array<{ value: SiliconModeChoice; label: string }> = [
  { value: "auto", label: "自动判定" },
  { value: "remove", label: "强制移除" },
  { value: "redraw", label: "强制重绘" },
];

const SILICON_MODE_VALUES = SILICON_MODE_OPTIONS.map((o) => o.value);

/** 阔图抓取摘要：画布 / 源图 / 四边 pad。 */
const expandCapturePlanText = (c: ExpandCaptureResult): string => {
  const p = c.pads.pads;
  const pct = (v: number) => `${Math.round(v * 100) / 100}%`;
  return (
    `画布 ${c.canvasWidth}×${c.canvasHeight} · 源图 ${c.sendWidth}×${c.sendHeight}` +
    ` · pad 左${pct(p.left)} 右${pct(p.right)} 上${pct(p.top)} 下${pct(p.bottom)}`
  );
};

/**
 * 图层超分入口开关：功能暂时下线，实现保留，恢复时改回 true 即可。
 * 关闭后不渲染目标长边输入框、「放大图层」按钮与超分状态提示。
 */
const UPSCALE_ENABLED = false;

/** sp-picker 的 change 事件取选中项下标：个别版本透传为菜单项（无 selectedIndex），回退用 value 匹配。 */
const pickerIndex = (e: unknown, values: readonly string[]): number => {
  const target = (e as { target?: { selectedIndex?: number; value?: string } })
    ?.target;
  const idx = target?.selectedIndex;
  if (typeof idx === "number" && idx >= 0 && idx < values.length) return idx;
  const value = target?.value;
  if (typeof value === "string") return values.indexOf(value);
  return -1;
};

const siliconModeLabel = (mode: SiliconMode): string =>
  mode === "redraw" ? "重绘" : "移除";

/** 时间展示 HH:MM（手写补零，避开 UXP 的 locale 兼容问题）。 */
const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

const formatDuration = (ms?: number): string => {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
};

/** 预览显示尺寸：最长边固定 maxSide px 按比例缩放（UXP 百分比尺寸不可靠，直接算 px）。 */
const previewSize = (w: number, h: number, maxSide = 140) => {
  const scale = maxSide / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
};

/** 生成进度一行：百分比 + 阶段 + 剩余秒数（Siliconed 单队列语义）。 */
const progressLabel = (progress: NonNullable<QueueJob["progress"]>): string => {
  const parts: string[] = [];
  if (progress.fraction != null) {
    parts.push(`${Math.round(progress.fraction * 100)}%`);
  }
  if (progress.stage) parts.push(progress.stage);
  if (progress.remainingS != null) {
    parts.push(`剩余约 ${Math.max(1, Math.round(progress.remainingS))}s`);
  }
  return parts.join(" · ");
};

/** 抓取尺寸规划的一行预览：选区 → 抓取（预设/32 对齐）→ 发送 → 请求。 */
const capturePlanText = (
  capture: CaptureResult,
  request: RequestSizeResult | null,
): string => {
  const selW = capture.originalBounds.right - capture.originalBounds.left;
  const selH = capture.originalBounds.bottom - capture.originalBounds.top;
  const plan = capture.preset
    ? `预设 ${presetLabel(capture.preset)}`
    : `${CAPTURE_ALIGN} 对齐`;
  const send = `发送 ${capture.sendWidth}×${capture.sendHeight}`;
  const req =
    request &&
    (request.reqW !== capture.sendWidth || request.reqH !== capture.sendHeight)
      ? ` → 请求 ${request.reqW}×${request.reqH}`
      : "";
  return `选区 ${selW}×${selH} → 抓取 ${capture.expanded.width}×${capture.expanded.height}（${plan}）→ ${send}${req}`;
};

/** 外扩量（画布内平移后可能左右/上下不对称），全 0 时不展示。 */
const padText = (capture: CaptureResult): string => {
  const p = capture.padAmounts;
  if (!p.left && !p.top && !p.right && !p.bottom) return "";
  return ` · 外扩 左${p.left} 上${p.top} 右${p.right} 下${p.bottom}`;
};

/** busy 期间每 250ms 自增的相位计数，驱动点号进度与 spinner 转动（UXP 无 CSS 动画）。 */
const useTick = (active: boolean): number => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(timer);
  }, [active]);
  return tick;
};

const isActive = (job: QueueJob): boolean =>
  job.status === "running" ||
  (job.status === "pendingPlace" && job.stage === "placing");

/** 状态徽章文案（running 区分提交 / 生成 / 取消中）。 */
const badgeLabel = (job: QueueJob): string => {
  switch (job.status) {
    case "queued":
      return "排队中";
    case "running":
      if (job.cancelRequestedAt) return "取消中…";
      return job.stage === "submitting" ? "提交中…" : "生成中…";
    case "pendingPlace":
      if (job.stage === "placing") return "贴回中…";
      if (job.documentMissing) return "等原文档";
      return job.autoPlace ? "待贴回…" : "待贴回";
    case "completed":
      return "已贴回";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
};

/** 复用既有 CSS 的状态色：pendingPlace→pending，completed→placed。 */
const badgeClass = (job: QueueJob): string => {
  if (job.status === "pendingPlace") return job.documentMissing ? "needsAttention" : "pending";
  if (job.status === "completed") return "placed";
  return job.status;
};

/** 条目左侧 36px 缩略位：进行中显示 spinner，有缩略图显示结果，否则占位。 */
const ItemSlot = ({
  job,
  thumb,
  tick,
}: {
  job: QueueJob;
  thumb?: string;
  tick: number;
}) => {
  if (isActive(job) && !thumb) {
    const side = tick % 4;
    const style: CSSProperties = {
      borderTopColor: side === 0 ? "var(--uxp-host-link-text-color)" : undefined,
      borderRightColor: side === 1 ? "var(--uxp-host-link-text-color)" : undefined,
      borderBottomColor: side === 2 ? "var(--uxp-host-link-text-color)" : undefined,
      borderLeftColor: side === 3 ? "var(--uxp-host-link-text-color)" : undefined,
    };
    return <span className="redraw-panel__item-spinner" style={style} />;
  }
  if (thumb) {
    return <img className="redraw-panel__item-thumb" src={thumb} alt="生成结果" />;
  }
  return <span className="redraw-panel__item-placeholder">—</span>;
};

/**
 * 主面板：框选 → 输入指令 → 入队 → 单飞生成 → 自动/手动贴回。
 *
 * 队列项只持有落盘路径；面板不再把结果 base64 留在内存里，
 * 列表通过缩略图与状态徽章展示，取消 / 重试 / 贴回都走队列执行器。
 */
export const RedrawPanel = () => {
  const [prompt, setPrompt] = useState("");
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const [request, setRequest] = useState<RequestSizeResult | null>(null);
  /** 主面板工作流：selection 框选局部重绘 / expand 阔图扩图，持久化到设置。 */
  const [workflow, setWorkflow] = useState<PanelWorkflow>("selection");
  /** 阔图工作流的画布抓取结果（与选区抓取互不相干，切工作流时清空）。 */
  const [expandCapture, setExpandCapture] = useState<ExpandCaptureResult | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [grabError, setGrabError] = useState("");
  const [queue, setQueue] = useState<QueueJob[]>(() => queueStore.list());
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [limitNotice, setLimitNotice] = useState("");
  /** 当前设置里的模型是否属于 Siliconed（决定空提示词与 1.4× 外扩是否启用）。 */
  const [siliconedSel, setSiliconedSel] = useState(false);
  /** Siliconed 处理方式（auto / remove / redraw），持久化到设置。 */
  const [siliconMode, setSiliconMode] = useState<SiliconModeChoice>("auto");
  /** 图层超分目标长边（px），持久化到设置。 */
  const [upscaleLongSide, setUpscaleLongSide] = useState(
    String(DEFAULT_UPSCALE_LONG_SIDE),
  );
  const [upscaleBusy, setUpscaleBusy] = useState(false);
  const [upscaleStage, setUpscaleStage] = useState("");
  const [upscaleStartedAt, setUpscaleStartedAt] = useState<number | null>(null);
  const [upscaleNotice, setUpscaleNotice] = useState("");
  const [upscaleError, setUpscaleError] = useState("");
  /** 任务队列折叠状态（持久化到设置；折叠后编辑区吃掉剩余高度）。 */
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  /** 抓取详情弹层开关（缩略图行的「详情 ›」）。 */
  const [showCaptureDetail, setShowCaptureDetail] = useState(false);
  const thumbCache = useRef<Record<string, string>>({});
  const [, setThumbVersion] = useState(0);
  const busy = queue.some(isActive);
  const tick = useTick(busy || upscaleBusy);

  // 队列运行时初始化 + 订阅；面板关闭不影响已入队任务
  useEffect(() => {
    void refreshQueueRuntime().catch(() => undefined);
    return queueStore.subscribe(() => setQueue(queueStore.list()));
  }, []);

  // 缩略图懒加载（结果大图不读回界面，只读小缩略图）
  useEffect(() => {
    let alive = true;
    void (async () => {
      const updates: Record<string, string> = {};
      for (const job of queueStore.list()) {
        if (!job.thumbPath) continue;
        if (thumbCache.current[job.thumbPath]) continue;
        const uri = await queueStore.readThumbDataUri(job);
        if (uri) {
          thumbCache.current[job.thumbPath] = uri;
          updates[job.id] = uri;
        }
      }
      if (alive && Object.keys(updates).length > 0) setThumbVersion((v) => v + 1);
    })();
    return () => {
      alive = false;
    };
  }, [queue]);

  // 从设置面板切回主面板时刷新模板 / 并发 / 诊断开关 / 磁盘上限
  useEffect(() => {
    const refresh = () => {
      loadSettings()
        .then((s) => {
          setTemplates(s.promptTemplates);
          setSiliconedSel(getCatalogModel(s.modelId).provider === "siliconed");
          setSiliconMode(s.siliconedMode);
          setUpscaleLongSide(String(s.upscaleLongSide));
          setQueueCollapsed(s.queueCollapsed);
          setWorkflow(s.panelWorkflow);
          return refreshQueueRuntime();
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const filledTemplates = templates.filter(
    (t) => t.name.trim() && t.prompt.trim(),
  );
  const templateRows: PromptTemplate[][] = [];
  for (let i = 0; i < filledTemplates.length; i += 3) {
    templateRows.push(filledTemplates.slice(i, i + 3));
  }

  /** 自动模式下的实时判定（与队列执行时同一函数，避免 UI 与实际分支不一致）。 */
  const autoMode = detectSiliconMode(prompt);
  const modeHint =
    siliconMode === "auto"
      ? `处理方式：自动（当前判定为${siliconModeLabel(autoMode)}）`
      : `处理方式：固定${siliconModeLabel(siliconMode)}`;
  const upscaleElapsed = upscaleStartedAt
    ? formatDuration(Date.now() - upscaleStartedAt)
    : "";

  /** 切换处理方式并立即持久化（队列执行时读取最新值）。 */
  const chooseMode = async (choice: SiliconModeChoice) => {
    setSiliconMode(choice);
    try {
      const settings = await loadSettings();
      await saveSettings({ ...settings, siliconedMode: choice });
    } catch (err) {
      setGrabError(
        `保存处理方式失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** 切换主面板工作流并持久化；两套抓取产物互不相干，切换时清空。 */
  const chooseWorkflow = async (next: PanelWorkflow) => {
    if (next === workflow) return;
    setWorkflow(next);
    setCapture(null);
    setRequest(null);
    setExpandCapture(null);
    setGrabError("");
    setLimitNotice("");
    try {
      const settings = await loadSettings();
      await saveSettings({ ...settings, panelWorkflow: next });
    } catch (err) {
      setGrabError(
        `保存工作流失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** 折叠 / 展开任务队列并持久化（折叠时编辑区吃掉剩余高度）。 */
  const toggleQueue = async () => {
    const next = !queueCollapsed;
    setQueueCollapsed(next);
    try {
      const settings = await loadSettings();
      if (settings.queueCollapsed !== next) {
        await saveSettings({ ...settings, queueCollapsed: next });
      }
    } catch {
      // 设置保存失败不影响本次折叠
    }
  };

  /** 目标长边归一化并持久化（清空/非法值回退默认）。 */
  const commitUpscaleLongSide = async (raw: string) => {
    const value = normalizeUpscaleLongSide(raw, DEFAULT_UPSCALE_LONG_SIDE);
    setUpscaleLongSide(String(value));
    try {
      const settings = await loadSettings();
      if (settings.upscaleLongSide !== value) {
        await saveSettings({ ...settings, upscaleLongSide: value });
      }
    } catch (err) {
      setUpscaleError(
        `保存目标长边失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * 图层超分：读取选中图层像素 → SeedVR2 → 智能对象贴回原位置（原图层隐藏）。
   * CLI 无流式输出、不可取消，只展示阶段文案与已用时。
   */
  const upscaleLayer = async () => {
    if (upscaleBusy) return;
    const longSide = normalizeUpscaleLongSide(
      upscaleLongSide,
      DEFAULT_UPSCALE_LONG_SIDE,
    );
    setUpscaleLongSide(String(longSide));
    setUpscaleError("");
    setUpscaleNotice("");
    let settings: RedrawSettings;
    try {
      settings = await loadSettings();
    } catch (err) {
      setUpscaleError(
        `读取设置失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    setUpscaleBusy(true);
    setUpscaleStartedAt(Date.now());
    setUpscaleStage("准备中");
    try {
      const result = await upscaleActiveLayer({
        cliPath: settings.siliconedCliPath,
        longSide,
        onStage: setUpscaleStage,
      });
      const scaleText =
        result.plan.displayScale > 1.01
          ? `，PS 已放大 ${result.plan.displayScale.toFixed(1)}×（显示 ${result.displaySize.width}×${result.displaySize.height}）`
          : "";
      setUpscaleNotice(
        `${result.resultLayerName}：原始 ${result.sourceSize.width}×${result.sourceSize.height}` +
          ` → ${result.targetSize.width}×${result.targetSize.height}` +
          `（${result.plan.scale.toFixed(2)}×）${scaleText}，原图层已隐藏` +
          (result.note ? ` · ${result.note}` : ""),
      );
    } catch (err) {
      setUpscaleError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpscaleBusy(false);
      setUpscaleStartedAt(null);
      setUpscaleStage("");
    }
  };

  /** 独立抓取：按当前工作流捕获（选区 / 整画布）并刷新预览，不触发生成。 */
  const grab = async () => {
    setCaptureBusy(true);
    setGrabError("");
    try {
      const settings = await loadSettings();
      const siliconed = getCatalogModel(settings.modelId).provider === "siliconed";
      setSiliconedSel(siliconed);
      setSiliconMode(settings.siliconedMode);
      if (workflow === "expand") {
        setExpandCapture(await captureExpandCanvas());
        return;
      }
      const c = await captureSelection({
        sizeMode: settings.sizeMode,
        fixedPresetId: settings.fixedPresetId,
        expandFactor: siliconed ? SILICONED_SELECTION_EXPAND : undefined,
        maskPatchFloor: siliconed,
      });
      setCapture(c);
      setRequest(requestSizeFor(getCatalogModel(settings.modelId), c));
    } catch (err) {
      setGrabError(err instanceof Error ? err.message : String(err));
    } finally {
      setCaptureBusy(false);
    }
  };

  /** 入队：抓取结果立刻落盘，队列项只保留路径；并发与单飞由调度器负责。 */
  const generate = async (
    promptOverride?: string,
    settingsOverride?: Partial<RedrawSettings>,
  ) => {
    setGrabError("");
    setLimitNotice("");
    const text = (promptOverride ?? prompt).trim();
    let settings: RedrawSettings;
    try {
      settings = await loadSettings();
    } catch (err) {
      setGrabError(`读取设置失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // ---- 阔图工作流：仅 Siliconed，无选区 / 蒙版 / 模板 ----
    if (workflow === "expand") {
      const provider = getCatalogModel(settings.modelId).provider;
      setSiliconedSel(provider === "siliconed");
      if (provider !== "siliconed") {
        setLimitNotice("扩图仅支持 Siliconed：请先在设置中切换模型");
        return;
      }
      // 提示词是固定句子的补充，可留空（promptPolicy 对 expand 恒放行）
      if (promptBlocksSubmit(provider, text, "expand")) {
        setLimitNotice("请先填写提示词");
        return;
      }
      let ec = expandCapture;
      if (!ec) {
        setCaptureBusy(true);
        try {
          ec = await captureExpandCanvas();
        } catch (err) {
          setCaptureBusy(false);
          setGrabError(err instanceof Error ? err.message : String(err));
          return;
        }
        setCaptureBusy(false);
      }
      try {
        await enqueueExpandCapture({
          prompt: text,
          capture: ec,
          settings,
        });
        // 释放面板内存中的大图；队列已持有落盘路径
        setExpandCapture(null);
        setLimitNotice("已加入队列");
      } catch (err) {
        setGrabError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    const effective = applyGenerationOverride(settings, settingsOverride);
    const provider = getCatalogModel(effective.modelId).provider;
    const siliconed = provider === "siliconed";
    // 以本次任务实际生效的 provider 判定（设置面板保存不会通知主面板，缓存值可能过期）
    setSiliconedSel(siliconed);
    setSiliconMode(effective.siliconedMode);
    // Siliconed 允许留空（运行时会注入默认移除文案）；其他平台仍要求填写
    if (promptBlocksSubmit(provider, text)) {
      setLimitNotice("请先填写提示词");
      return;
    }
    // 手动指定重绘时提示词必填（auto 下留空会判定为移除，不受影响）
    if (siliconed && effective.siliconedMode === "redraw" && !text) {
      setLimitNotice("重绘模式需要填写提示词");
      return;
    }
    // 抓取与当前 provider 的外扩参数不一致时重新抓取，避免 1.4× 只对 Siliconed 生效的约束被绕过
    const wantedExpand = siliconed ? SILICONED_SELECTION_EXPAND : 1;
    let current = capture && (capture.selectionExpand ?? 1) === wantedExpand ? capture : null;
    if (!current) {
      setCaptureBusy(true);
      try {
        current = await captureSelection({
          sizeMode: effective.sizeMode,
          fixedPresetId: effective.fixedPresetId,
          expandFactor: siliconed ? SILICONED_SELECTION_EXPAND : undefined,
          maskPatchFloor: siliconed,
        });
      } catch (err) {
        setCaptureBusy(false);
        setGrabError(err instanceof Error ? err.message : String(err));
        return;
      }
      setCaptureBusy(false);
    }
    try {
      await enqueueCapture({
        prompt: text,
        capture: current,
        settings: effective,
        ...(settingsOverride ? { settingsOverride } : {}),
      });
      // 释放面板内存中的大图；队列已持有落盘路径
      setCapture(null);
      setRequest(null);
      setShowCaptureDetail(false);
      setLimitNotice("已加入队列");
    } catch (err) {
      setGrabError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 应用提示词模板：模板内容与绑定平台作为一次性覆盖，不改输入框与设置。 */
  const applyTemplate = async (tpl: PromptTemplate) => {
    const settings = await loadSettings();
    const target = resolveTemplateProvider(tpl);
    const hasKey =
      target.kind === "provider" && providerRequiresKey(target.providerId)
        ? Boolean(await loadApiKey(target.providerId))
        : true;
    const decision = decideTemplateApply(tpl, settings, {
      hasKey,
      isMac: isMacHost(),
    });
    if (decision.kind !== "generate") {
      setLimitNotice(decision.message);
      return;
    }
    await generate(decision.prompt, decision.override);
  };

  const cancelJob = async (id: string) => {
    const outcome = await queueRunner.cancel(id);
    setLimitNotice(outcome.message);
  };

  const rePlace = async (id: string) => {
    await queueRunner.retry(id);
    queueRunner.requestPlace(id);
  };

  return (
    <section className="redraw-panel">
      <header className="redraw-panel__header">
        <span className="redraw-panel__title">AI 局部重绘</span>
        <sp-button
          className="redraw-panel__settings-btn"
          variant="secondary"
          quiet
          onclick={() => openUXPPanel(`${pluginId}.settings`)}
        >
          设置
        </sp-button>
      </header>

      {busy && (
        <div className="redraw-panel__warning">
          有任务进行中：请勿修改画布（如裁切、修改分辨率），否则结果可能贴错位置
        </div>
      )}

      {limitNotice && <div className="redraw-panel__warning">{limitNotice}</div>}

      {/* 编辑区：默认固定 212px；队列折叠时 flex:1 吃掉剩余高度 */}
      <div
        className={`redraw-panel__editor${queueCollapsed ? " redraw-panel__editor--grow" : ""}`}
      >
      <div className="redraw-panel__field">
        <span className="redraw-panel__field-control">
          <sp-textarea
            className="redraw-panel__prompt"
            value={prompt}
            placeholder={
              workflow === "expand"
                ? "补充提示词，可留空（先在 PS 用裁剪工具外扩画布）"
                : siliconedSel
                  ? "留空则移除选区；填写要生成的内容则重绘"
                  : "描述想把选区改成什么，例如：把草地换成雪地"
            }
            oninput={(e) => setPrompt(e.target.value)}
            onchange={(e) => setPrompt(e.target.value)}
          >
            <sp-label slot="label">提示词</sp-label>
          </sp-textarea>
        </span>
      </div>

      {workflow !== "expand" && templateRows.length > 0 && (
        <div className="redraw-panel__templates">
          {templateRows.map((row, ri) => (
            <div className="redraw-panel__template-row" key={ri}>
              {row.map((tpl, ti) => (
                <sp-button
                  key={`${ri}-${ti}`}
                  className="redraw-panel__template-btn"
                  quiet
                  disabled={captureBusy}
                  onclick={() => void applyTemplate(tpl)}
                >
                  {tpl.name.trim()}
                </sp-button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="redraw-panel__actions">
        <sp-button
          className="redraw-panel__secondary"
          variant={workflow === "expand" ? "cta" : "secondary"}
          quiet={workflow === "expand"}
          selected={workflow === "expand"}
          onclick={() =>
            void chooseWorkflow(workflow === "expand" ? "selection" : "expand")
          }
          disabled={captureBusy}
        >
          {workflow === "expand" ? "扩图中（点击退出）" : "扩图"}
        </sp-button>
        <sp-button
          className="redraw-panel__secondary"
          variant="secondary"
          onclick={grab}
          disabled={captureBusy}
        >
          {captureBusy
            ? "抓取中…"
            : workflow === "expand"
              ? expandCapture
                ? "重新抓取画布"
                : "抓取画布"
              : capture
                ? "重新抓取"
                : "抓取选区"}
        </sp-button>
        {workflow === "selection" && siliconedSel && (
          <sp-picker
            className="redraw-panel__mode-select"
            style={{ width: "116px", minWidth: "116px" }}
            onchange={(e) => {
              const idx = pickerIndex(e, SILICON_MODE_VALUES);
              if (idx >= 0) void chooseMode(SILICON_MODE_VALUES[idx]);
            }}
          >
            <sp-menu slot="options" style={{ minWidth: "116px" }}>
              {SILICON_MODE_OPTIONS.map((opt) => (
                <sp-menu-item
                  key={opt.value}
                  selected={siliconMode === opt.value}
                  style={{ minWidth: "116px", whiteSpace: "nowrap" }}
                >
                  {opt.label}
                </sp-menu-item>
              ))}
            </sp-menu>
          </sp-picker>
        )}
        <sp-button
          className="redraw-panel__primary"
          onclick={() => void generate()}
          disabled={captureBusy}
        >
          加入队列
        </sp-button>
      </div>

      {workflow === "selection" && siliconedSel && (
        <span className="redraw-panel__hint">{modeHint}</span>
      )}

      {UPSCALE_ENABLED && (
        <>
          <div className="redraw-panel__upscale">
            <span className="redraw-panel__upscale-label">图层超分</span>
            <sp-textfield
              className="redraw-panel__upscale-input"
              value={upscaleLongSide}
              placeholder={String(DEFAULT_UPSCALE_LONG_SIDE)}
              disabled={upscaleBusy}
              oninput={(e) => setUpscaleLongSide(e.target.value)}
              onchange={(e) => void commitUpscaleLongSide(e.target.value)}
            />
            <span className="redraw-panel__upscale-unit">px 长边</span>
            <sp-button
              className="redraw-panel__upscale-btn"
              variant="secondary"
              onclick={() => void upscaleLayer()}
              disabled={upscaleBusy || captureBusy}
            >
              {upscaleBusy ? "超分中…" : "放大图层"}
            </sp-button>
          </div>
          {upscaleBusy && (
            <span className="redraw-panel__hint">
              {upscaleStage ? `${upscaleStage} · ` : ""}已用时 {upscaleElapsed}
            </span>
          )}
          {upscaleNotice && (
            <span className="redraw-panel__hint">{upscaleNotice}</span>
          )}
          {upscaleError && <p className="redraw-panel__error">⚠ {upscaleError}</p>}
        </>
      )}

      {workflow === "expand" && expandCapture && (
        <div className="redraw-panel__sel">
          <img
            className="redraw-panel__sel-thumb"
            src={`data:image/png;base64,${expandCapture.pngBase64}`}
            alt="源图缩略图"
          />
          <span className="redraw-panel__sel-main">
            <p className="redraw-panel__sel-text">
              {expandCapture.docName} · 源图 {expandCapture.sendWidth}×{expandCapture.sendHeight}
            </p>
            <p className="redraw-panel__sel-sub">
              {expandCapturePlanText(expandCapture)}
            </p>
            {expandCapture.warnings.length > 0 && (
              <p className="redraw-panel__sel-sub">
                {expandCapture.warnings.join("；")}
              </p>
            )}
          </span>
          <span
            className="redraw-panel__sel-more"
            onClick={() => setShowCaptureDetail(true)}
          >
            详情 ›
          </span>
        </div>
      )}

      {workflow === "selection" && capture && (
        <div className="redraw-panel__sel">
          <img
            className="redraw-panel__sel-thumb"
            src={`data:image/png;base64,${capture.pngBase64}`}
            alt="选区缩略图"
          />
          <span className="redraw-panel__sel-main">
            <p className="redraw-panel__sel-text">
              {capture.docName} · 发送 {capture.sendWidth}×{capture.sendHeight}
            </p>
            <p className="redraw-panel__sel-sub">
              {capturePlanText(capture, request)}
            </p>
          </span>
          <span
            className="redraw-panel__sel-more"
            onClick={() => setShowCaptureDetail(true)}
          >
            详情 ›
          </span>
        </div>
      )}
      </div>

      {queue.length > 0 && (
        <div
          className={`redraw-panel__queue${queueCollapsed ? " redraw-panel__queue--collapsed" : ""}`}
        >
          <div className="redraw-panel__queue-head">
            <span className="redraw-panel__queue-title">
              任务队列（{queue.length}）{busy ? " · 进行中" : ""}
            </span>
            <span className="redraw-panel__queue-tools">
              <sp-button
                className="redraw-panel__queue-clear"
                quiet
                onclick={() => {
                  queueStore.clearFinished();
                  setLimitNotice("已清空已完成 / 已取消项");
                }}
                disabled={busy}
              >
                清空已完成
              </sp-button>
              <span
                className="redraw-panel__queue-toggle"
                onClick={() => void toggleQueue()}
              >
                {queueCollapsed ? "展开 ⌄" : "收起 ⌃"}
              </span>
            </span>
          </div>
          {!queueCollapsed && (
            <div className="redraw-panel__queue-list">
            {queue.map((e) => (
              <div key={e.id} className="redraw-panel__item">
                <span className="redraw-panel__item-slot">
                  <ItemSlot
                    job={e}
                    thumb={e.thumbPath ? thumbCache.current[e.thumbPath] : undefined}
                    tick={tick}
                  />
                </span>
                <span className="redraw-panel__item-main">
                  <p className="redraw-panel__item-prompt">
                    {e.prompt || "（未填写提示词）"}
                  </p>
                  <p className="redraw-panel__item-meta">
                    <span>{formatTime(e.createdAt)}</span>
                    <span className={`redraw-panel__badge redraw-panel__badge--${badgeClass(e)}`}>
                      {badgeLabel(e)}
                    </span>
                    <span className="redraw-panel__item-mode">{e.docName}</span>
                    <span className="redraw-panel__item-mode">
                      平台 {providerLabel(e.providerId)}
                    </span>
                    {e.workflow === "expand" && (
                      <span className="redraw-panel__item-mode">扩图</span>
                    )}
                    {e.workflow === "expand" && e.expandPads && (
                      <span className="redraw-panel__item-mode">
                        pad {e.expandPads.left}/{e.expandPads.right}/
                        {e.expandPads.top}/{e.expandPads.bottom}%
                      </span>
                    )}
                    {e.compute && (
                      <span className="redraw-panel__item-mode">
                        计算 {e.compute.actual}
                        {e.compute.mismatch && `（目标 ${e.compute.requested}）`}
                      </span>
                    )}
                    {e.presetId && (
                      <span className="redraw-panel__item-mode">
                        预设 {e.presetId}
                      </span>
                    )}
                    <span className="redraw-panel__item-mode">
                      发送 {e.sendWidth}×{e.sendHeight}
                    </span>
                    {e.elapsedMs != null && (
                      <span className="redraw-panel__item-mode">
                        耗时 {formatDuration(e.elapsedMs)}
                      </span>
                    )}
                    {e.remoteJobId && (
                      <span className="redraw-panel__item-mode">
                        远端 {e.remoteJobId}
                      </span>
                    )}
                    {e.outputMismatch && (
                      <span className="redraw-panel__item-mode">
                        尺寸不一致
                        {e.actualOutputSize &&
                          `（实际 ${e.actualOutputSize.width}×${e.actualOutputSize.height}）`}
                      </span>
                    )}
                    {e.status === "completed" && e.placedLayer && (
                      <span className="redraw-panel__item-layer">
                        {e.placedLayer}
                      </span>
                    )}
                    {e.status === "completed" && e.placeBackMode && (
                      <span className="redraw-panel__item-mode">
                        {PLACE_MODE_LABELS[e.placeBackMode]}
                      </span>
                    )}
                    {e.status === "completed" && e.placedInBackground && (
                      <span className="redraw-panel__item-mode">后台贴回</span>
                    )}
                  </p>
                  {e.progress && (e.status === "running" || e.status === "pendingPlace") && (
                    <p className="redraw-panel__item-progress">
                      {progressLabel(e.progress)}
                    </p>
                  )}
                  {e.compute?.note && e.status === "running" && (
                    <p className="redraw-panel__item-note">{e.compute.note}</p>
                  )}
                  {e.placeNote && (
                    <p className="redraw-panel__item-note">{e.placeNote}</p>
                  )}
                  {e.documentMissing && e.artifactPath && (
                    <p className="redraw-panel__item-note">
                      结果已保存：{e.artifactPath}
                    </p>
                  )}
                  {e.filesPruned && (
                    <p className="redraw-panel__item-note">
                      输入 / 结果文件已按保留期或磁盘上限清理
                    </p>
                  )}
                  {e.error && (
                    <p className="redraw-panel__item-error">{e.error}</p>
                  )}
                </span>
                {e.status === "queued" && (
                  <sp-button
                    className="redraw-panel__item-action"
                    quiet
                    onclick={() => void cancelJob(e.id)}
                  >
                    取消
                  </sp-button>
                )}
                {e.status === "running" && (
                  <sp-button
                    className="redraw-panel__item-action"
                    quiet
                    onclick={() => void cancelJob(e.id)}
                  >
                    取消
                  </sp-button>
                )}
                {e.status === "pendingPlace" && (
                  <sp-button
                    className="redraw-panel__item-action"
                    quiet
                    onclick={() => void cancelJob(e.id)}
                  >
                    取消
                  </sp-button>
                )}
                {e.status === "pendingPlace" &&
                  e.resultPath &&
                  e.stage !== "placing" && (
                    <sp-button
                      className="redraw-panel__item-action"
                      quiet
                      onclick={() => queueRunner.requestPlace(e.id)}
                    >
                      {e.documentMissing ? "重新贴回" : "贴回"}
                    </sp-button>
                  )}
                {e.status === "failed" && (
                  <sp-button
                    className="redraw-panel__item-action"
                    quiet
                    onclick={() =>
                      e.stage === "placing" && e.resultPath
                        ? queueRunner.requestPlace(e.id)
                        : void queueRunner.retry(e.id)
                    }
                  >
                    {e.stage === "placing" && e.resultPath ? "重试贴回" : "重试"}
                  </sp-button>
                )}
                {e.status === "cancelled" && e.resultPath && (
                  <sp-button
                    className="redraw-panel__item-action"
                    quiet
                    onclick={() => void rePlace(e.id)}
                  >
                    再贴
                  </sp-button>
                )}
              </div>
            ))}
            </div>
          )}
        </div>
      )}

      {grabError && <p className="redraw-panel__error">⚠ {grabError}</p>}

      {workflow === "expand" && expandCapture && showCaptureDetail && (
        <div className="redraw-panel__overlay">
          <div className="redraw-panel__overlay-head">
            <span className="redraw-panel__title">抓取详情</span>
            <sp-button
              className="redraw-panel__settings-btn"
              quiet
              onclick={() => setShowCaptureDetail(false)}
            >
              关闭
            </sp-button>
          </div>
          <div className="redraw-panel__overlay-body">
            <p className="redraw-panel__sel-sub">
              {expandCapturePlanText(expandCapture)}
            </p>
            <p className="redraw-panel__sel-sub">
              {expandCapture.docName} · 逻辑输出画布{" "}
              {expandCapture.pads.logicalWidth}×{expandCapture.pads.logicalHeight}
            </p>
            {expandCapture.warnings.map((w, i) => (
              <p key={`expand-warn-${i}`} className="redraw-panel__item-note">
                {w}
              </p>
            ))}
            <img
              className="redraw-panel__preview"
              style={previewSize(expandCapture.sendWidth, expandCapture.sendHeight, 260)}
              src={`data:image/png;base64,${expandCapture.pngBase64}`}
              alt="源图预览"
            />
            <p className="redraw-panel__preview-label">源图（非透明包围盒）</p>
          </div>
        </div>
      )}

      {workflow === "selection" && capture && showCaptureDetail && (
        <div className="redraw-panel__overlay">
          <div className="redraw-panel__overlay-head">
            <span className="redraw-panel__title">抓取详情</span>
            <sp-button
              className="redraw-panel__settings-btn"
              quiet
              onclick={() => setShowCaptureDetail(false)}
            >
              关闭
            </sp-button>
          </div>
          <div className="redraw-panel__overlay-body">
            <p className="redraw-panel__sel-sub">{capturePlanText(capture, request)}</p>
            <p className="redraw-panel__sel-sub">
              {capture.docName} @ ({capture.expanded.bounds.left},
              {capture.expanded.bounds.top}){padText(capture)}
            </p>
            {capture.sizeWarnings.map((w, i) => (
              <p key={`size-warn-${i}`} className="redraw-panel__item-note">
                {w}
              </p>
            ))}
            <img
              className="redraw-panel__preview"
              style={previewSize(capture.sendWidth, capture.sendHeight, 260)}
              src={`data:image/png;base64,${capture.pngBase64}`}
              alt="捕获预览"
            />
            <p className="redraw-panel__preview-label">原图</p>
          </div>
        </div>
      )}
    </section>
  );
};
