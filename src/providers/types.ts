import type { ModelPreset } from "../ark/models";

/** 生图平台标识：方舟 / RunningHub / 本地 ComfyUI / 本地 Siliconed / 本地 IOPaint / 通用自定义 HTTP。 */
export type ProviderId =
  | "ark"
  | "runninghub"
  | "comfyui"
  | "siliconed"
  | "iopaint"
  | "custom";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
}

export const PROVIDERS: ProviderPreset[] = [
  { id: "ark", label: "火山方舟" },
  { id: "runninghub", label: "RunningHub" },
  { id: "comfyui", label: "ComfyUI（本地）" },
  { id: "siliconed", label: "Siliconed（本地 Qwen 编辑）" },
  { id: "iopaint", label: "IOPaint（本地擦除）" },
  { id: "custom", label: "自定义 HTTP 接口" },
];

/** 暂时屏蔽的供应商：实现与已保存配置都保留，仅从界面选择项中隐藏。 */
export const HIDDEN_PROVIDER_IDS: readonly ProviderId[] = ["comfyui"];

/**
 * 界面可选供应商；`keep` 传入当前已保存的值，避免该值被屏蔽后下拉框显示空白。
 */
export const providerChoices = (keep?: string): ProviderPreset[] =>
  PROVIDERS.filter(
    (p) => !HIDDEN_PROVIDER_IDS.includes(p.id) || p.id === keep,
  );

/**
 * 单队列平台：服务端一次只跑一个任务。
 * - Siliconed：CLI 内部串行；
 * - IOPaint：CPU 推理 + 服务端「当前模型」是进程级全局状态，切换模型不能与在跑的任务并发。
 */
export const providerUsesSingleQueue = (id: ProviderId): boolean =>
  id === "siliconed" || id === "iopaint";

/** 长任务平台的可选进度（Siliconed 轮询 status 上报）；其他平台不填。 */
export interface ProviderProgress {
  /** 0–1；null 表示平台暂时给不出百分比。 */
  fraction: number | null;
  /** 展示用阶段文案（已翻译为中文）。 */
  stage: string;
  /** 预计剩余秒数。 */
  remainingS: number | null;
}

/**
 * 实际计算目标（跨机渲染）：提交前按 settings 目标校验 status.computing_on 后记录。
 * requested / actual 均为展示名（本机 或 Mac 名称）。
 */
export interface ComputeTargetInfo {
  requested: string;
  actual: string;
  /** 实际目标与设置目标不一致（已按实际目标执行）。 */
  mismatch: boolean;
  /** 远端首次渲染会先自测（约 2 分钟），期间 estimate_s 尚不可用。 */
  firstMeasure?: boolean;
  /** 需要提示用户的说明（不一致 / 首次测量）。 */
  note?: string;
}

/** 目录模型：在 Ark 模型预设基础上补充平台归属与平台专属默认参数。 */
export interface CatalogModel extends ModelPreset {
  provider: ProviderId;
  /** RunningHub 预设：提交接口路径（相对平台域名）。 */
  rhEndpoint?: string;
  /** RunningHub 预设：默认请求体模板（JSON 字符串，支持 {{占位符}}）。 */
  rhBodyTemplate?: string;
}

/** 模板占位符渲染上下文。 */
export type TemplateVars = Record<string, string | number>;

export interface ProviderErrorLike {
  kind: "terminal" | "retryable" | "timeout" | "cancelled";
  status?: number;
  message: string;
}

export const providerLabel = (id: ProviderId): string =>
  PROVIDERS.find((p) => p.id === id)?.label ?? id;
