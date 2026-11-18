import { DEFAULT_MODEL_ID } from "../ark/models";
import {
  COMFY_DEFAULT_BASE_URL,
  CUSTOM_DEFAULT_BODY,
  CUSTOM_DEFAULT_HEADERS,
  CUSTOM_DEFAULT_RESULT_PATH,
  IOPAINT_DEFAULT_BASE_URL,
  IOPAINT_DEFAULT_MODEL,
  RH_DEFAULT_BASE_URL,
  RH_DEFAULT_BODY_TEMPLATE,
  RH_DEFAULT_ENDPOINT,
  SILICONED_DEFAULT_CLI_PATH,
} from "../providers/catalog";
import type { ProviderId } from "../providers/types";
import type {
  SiliconComputeTarget,
  SiliconTargetPolicy,
} from "../providers/siliconedTarget";
import type { SiliconModeChoice } from "../providers/siliconedPlan";
import { DEFAULT_SIZE_MODE, type SizeMode } from "../ps/presetFit";
import { DEFAULT_PRESET_ID } from "../ps/presets";
import { DEFAULT_UPSCALE_LONG_SIDE } from "../core/upscalePlan";

/**
 * 贴回模式：
 * - layerMask = 图层蒙版（默认）：整块贴回生成结果，并为结果图层创建真正的
 *   （可在 PS 里继续编辑的）图层蒙版，白色显示区 = 原选区；
 * - mask = 像素蒙版合成：把原选区蒙版烘焙进结果 alpha，只显示选区内像素；
 * - block = 整块替换：不做任何选区约束，直接覆盖扩展区域。
 */
export type PlaceBackMode = "layerMask" | "mask" | "block";

/**
 * 主面板的提示词模板按钮：name 显示在按钮上，prompt 是点击后用于生成的提示词。
 * providerId 可选：空 / 缺省 = 跟随当前服务商（老模板的兼容行为）；
 * 有值 = 点击模板时切到该服务商（目录里不存在时由 UI 标记失效，不静默降级）。
 */
export interface PromptTemplate {
  name: string;
  prompt: string;
  /** 绑定的服务商 id；缺省 / 空串表示跟随当前服务商。 */
  providerId?: string;
}

/** 模板槽位固定 6 个（主面板两行三列）；名称或提示词为空时不渲染按钮。 */
export const TEMPLATE_SLOTS = 6;

export const EMPTY_TEMPLATES: PromptTemplate[] = Array.from(
  { length: TEMPLATE_SLOTS },
  () => ({ name: "", prompt: "" }),
);

export interface RedrawSettings {
  /** 当前平台；决定设置面板展示哪些模型与哪些平台专属参数。 */
  providerId: ProviderId;
  modelId: string;
  /** 生成并发上限。 */
  concurrency: number;
  /** 尺寸规划模式：auto 自动匹配预设 / fixed 指定预设 / custom 旧 32 对齐。 */
  sizeMode: SizeMode;
  /** fixed 模式下使用的预设 id；auto / custom 模式忽略。 */
  fixedPresetId: string;
  placeBackMode: PlaceBackMode;
  watermark: boolean;
  /** 拼在用户指令后的固定后缀；空字符串表示不追加。 */
  promptSuffix: string;
  /** 单条请求超时（毫秒，含 RunningHub / ComfyUI / Siliconed 的排队与生成）。 */
  requestTimeoutMs: number;
  /** 生成完成后自动贴回；关闭则仅预览，由用户在队列中手动点「贴回」。 */
  autoPlaceBack: boolean;
  /** 调试诊断开关：默认关闭；开启后才抓全文档蒙版快照与逐步日志。 */
  debugDiag: boolean;
  /** 队列落盘磁盘上限（MB，默认 2048 = 2GB；失败/取消项按 LRU 清理）。 */
  queueDiskLimitMB: number;
  /** 主面板任务队列是否折叠（折叠后编辑区吃掉剩余高度）。 */
  queueCollapsed: boolean;
  /** 主面板两行三列的提示词模板按钮（固定 6 个槽位）。 */
  promptTemplates: PromptTemplate[];

  // ---- RunningHub ----
  rhBaseUrl: string;
  /** 提交接口路径（相对平台域名，也可填完整 URL）。 */
  rhEndpoint: string;
  /** 请求体模板（JSON 字符串，支持 {{image}} {{prompt}} {{width}} {{height}} {{aspect}}）。 */
  rhBodyTemplate: string;

  // ---- 本地 ComfyUI ----
  comfyBaseUrl: string;
  /** API 格式工作流 JSON，支持占位符。 */
  comfyWorkflow: string;

  // ---- 本地 Siliconed（macOS 26+）----
  /** Siliconed.app 内置 silicontrol 的路径。 */
  siliconedCliPath: string;
  /** 计算目标：local 本机 / mac 指定已配对 Mac（0.20 跨机）。 */
  siliconedComputeTarget: SiliconComputeTarget;
  /** 指定 Mac 的 id（silicontrol macs 返回的 id；也兼容名称）。 */
  siliconedTargetMac: string;
  /** 提交前 computing_on 与目标不一致时的策略：auto 自动切换 / warn 按实际执行并提示。 */
  siliconedTargetPolicy: SiliconTargetPolicy;
  /** 处理方式：auto 按提示词自动判定（默认），remove / redraw 为手动覆盖。 */
  siliconedMode: SiliconModeChoice;
  /** 图层超分（SeedVR2）目标长边；倍率 = 目标长边 / 原图层长边。 */
  upscaleLongSide: number;

  // ---- 本地 IOPaint ----
  /** IOPaint 服务地址（默认 http://127.0.0.1:18088）。 */
  iopaintBaseUrl: string;
  /** IOPaint 模型（lama / mat）；服务端全局模型，生成前自动切换。 */
  iopaintModel: string;

  // ---- 自定义 HTTP 接口 ----
  customUrl: string;
  customHeaders: string;
  customBodyTemplate: string;
  customResultPath: string;
}

export const DEFAULT_SETTINGS: RedrawSettings = {
  providerId: "ark",
  modelId: DEFAULT_MODEL_ID,
  concurrency: 2,
  sizeMode: DEFAULT_SIZE_MODE,
  fixedPresetId: DEFAULT_PRESET_ID,
  placeBackMode: "layerMask",
  watermark: false,
  promptSuffix: "保持选区外画面完全不变。",
  requestTimeoutMs: 300_000,
  autoPlaceBack: true,
  debugDiag: false,
  queueDiskLimitMB: 2048,
  queueCollapsed: false,
  promptTemplates: EMPTY_TEMPLATES.map((t) => ({ ...t })),
  rhBaseUrl: RH_DEFAULT_BASE_URL,
  rhEndpoint: RH_DEFAULT_ENDPOINT,
  rhBodyTemplate: RH_DEFAULT_BODY_TEMPLATE,
  comfyBaseUrl: COMFY_DEFAULT_BASE_URL,
  comfyWorkflow: "",
  siliconedCliPath: SILICONED_DEFAULT_CLI_PATH,
  siliconedComputeTarget: "local",
  siliconedTargetMac: "",
  siliconedTargetPolicy: "auto",
  siliconedMode: "auto",
  upscaleLongSide: DEFAULT_UPSCALE_LONG_SIDE,
  iopaintBaseUrl: IOPAINT_DEFAULT_BASE_URL,
  iopaintModel: IOPAINT_DEFAULT_MODEL,
  customUrl: "",
  customHeaders: CUSTOM_DEFAULT_HEADERS,
  customBodyTemplate: CUSTOM_DEFAULT_BODY,
  customResultPath: CUSTOM_DEFAULT_RESULT_PATH,
};
