import {
  getCatalogModel,
  modelsForProvider,
  RH_DEFAULT_BODY_TEMPLATE,
  RH_DEFAULT_ENDPOINT,
} from "../providers/catalog";
import { PROVIDERS, providerLabel, type ProviderId } from "../providers/types";
import type { PromptTemplate, RedrawSettings } from "./types";

/**
 * 提示词模板的服务商绑定（纯函数，可 Node 单测）。
 *
 * 数据兼容：老模板只有 name/prompt，`providerId` 缺省或空串 = 跟随当前服务商；
 * 目录里已不存在的 id 原样保留（不擅自清空），由 UI 标记「已失效」并在应用时拦截。
 */

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === "string" && PROVIDERS.some((p) => p.id === value);

/** 模板绑定的解析结果：跟随当前 / 可切换 / 已失效。 */
export type TemplateProviderResolution =
  | { kind: "follow" }
  | { kind: "provider"; providerId: ProviderId }
  | { kind: "invalid"; raw: string };

export const resolveTemplateProvider = (
  template: Pick<PromptTemplate, "providerId">,
): TemplateProviderResolution => {
  const raw =
    typeof template.providerId === "string" ? template.providerId.trim() : "";
  if (!raw) return { kind: "follow" };
  return isProviderId(raw)
    ? { kind: "provider", providerId: raw }
    : { kind: "invalid", raw };
};

/**
 * 读盘迁移：固定槽位补齐；只做类型收敛，不丢弃任何已存的绑定。
 * 未知 providerId 也保留，让 UI 能显示「已失效」而不是静默变成「跟随当前」。
 */
export const normalizePromptTemplates = (
  stored: unknown,
  slots: number,
): PromptTemplate[] =>
  Array.from({ length: slots }, (_, i) => {
    const raw = Array.isArray(stored)
      ? (stored[i] as Partial<Record<keyof PromptTemplate, unknown>> | undefined)
      : undefined;
    const providerId =
      typeof raw?.providerId === "string" && raw.providerId.trim()
        ? raw.providerId.trim()
        : undefined;
    return {
      name: typeof raw?.name === "string" ? raw.name : "",
      prompt: typeof raw?.prompt === "string" ? raw.prompt : "",
      ...(providerId ? { providerId } : {}),
    };
  });

/** 生成时强制要求 API Key 的平台（与 task/pipeline.ts 的校验口径一致）。 */
export const providerRequiresKey = (providerId: ProviderId): boolean =>
  providerId === "ark" || providerId === "runninghub";

/**
 * 模板绑定服务商的静态可用性（不做网络/CLI 探测，连接性仍由设置页「测试连接」判定）：
 * - ready：本地配置齐全（有 Key / 有地址 / 有 CLI 路径）；
 * - missingKey：方舟 / RunningHub 未保存 API Key；
 * - notInstalled：Siliconed 在非 macOS 宿主；
 * - unconfigured：缺地址或 CLI 路径。
 */
export type ProviderAvailabilityLevel =
  | "ready"
  | "missingKey"
  | "notInstalled"
  | "unconfigured";

export interface ProviderAvailability {
  level: ProviderAvailabilityLevel;
  text: string;
}

export const providerAvailability = (
  providerId: ProviderId,
  settings: Pick<
    RedrawSettings,
    "comfyBaseUrl" | "siliconedCliPath" | "iopaintBaseUrl" | "customUrl"
  >,
  options: { hasKey: boolean; isMac: boolean },
): ProviderAvailability => {
  switch (providerId) {
    case "ark":
    case "runninghub":
      return options.hasKey
        ? { level: "ready", text: "已配置 API Key" }
        : { level: "missingKey", text: "缺 API Key" };
    case "comfyui":
      return settings.comfyBaseUrl.trim()
        ? { level: "ready", text: "已配置地址（连接状态请在设置页测试）" }
        : { level: "unconfigured", text: "未配置服务地址" };
    case "siliconed":
      if (!options.isMac) {
        return { level: "notInstalled", text: "未安装（仅 macOS 26+）" };
      }
      return settings.siliconedCliPath.trim()
        ? { level: "ready", text: "已配置 CLI（连接状态请在设置页测试）" }
        : { level: "unconfigured", text: "未配置 CLI 路径" };
    case "iopaint":
      return settings.iopaintBaseUrl.trim()
        ? { level: "ready", text: "已配置服务地址（连接状态请在设置页测试）" }
        : { level: "unconfigured", text: "未配置服务地址" };
    case "custom":
      return settings.customUrl.trim()
        ? { level: "ready", text: "已配置接口 URL" }
        : { level: "unconfigured", text: "未配置接口 URL" };
  }
};

/** 切换 RunningHub 模型时，提交接口与请求体回到该模型的预设默认值。 */
export const rhPresetPatch = (modelId: string): Partial<RedrawSettings> => {
  const model = getCatalogModel(modelId);
  if (model.provider !== "runninghub") return {};
  return {
    rhEndpoint: model.rhEndpoint ?? RH_DEFAULT_ENDPOINT,
    rhBodyTemplate: model.rhBodyTemplate ?? RH_DEFAULT_BODY_TEMPLATE,
  };
};

/**
 * 切换服务商的公共补丁（设置面板下拉与模板应用共用）：
 * 取该平台首个模型，并带上 RunningHub 的预设接口 / 请求体。
 */
export const providerSwitchPatch = (
  providerId: ProviderId,
): Partial<RedrawSettings> => {
  const modelId = modelsForProvider(providerId)[0]?.id;
  return {
    providerId,
    ...(modelId ? { modelId, ...rhPresetPatch(modelId) } : {}),
  };
};

/**
 * 一次性覆盖：把模板绑定的平台补丁合并到本次任务使用的设置上。
 *
 * 只返回新对象、绝不写回设置文件；调用方把它当「本次任务的快照」传给生成链路，
 * 因此既不会改用户默认平台，也不存在需要清理的全局覆盖状态（任务结束即随闭包释放）。
 */
export const applyGenerationOverride = (
  settings: RedrawSettings,
  override?: Partial<RedrawSettings>,
): RedrawSettings => (override ? { ...settings, ...override } : settings);

/** 点击模板后的决策：提示（失效 / 不可用）或带一次性覆盖去生成。 */
export type TemplateApplyDecision =
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "generate"; prompt: string; override?: Partial<RedrawSettings> };

/**
 * 把「模板绑定的服务商是否可用、要不要覆盖」的判定收敛为纯函数（组件只负责取 Key 与提示）。
 *
 * - 绑定已失效 → 只提示；
 * - 绑定平台与当前一致 → 生成本身，不覆盖（保留用户在该平台内选的模型）；
 * - 绑定平台不可用（缺 Key / 未安装 / 未配置）→ 只提示，不生成、不改设置；
 * - 可用 → 生成并携带该平台同名补丁，仅对本次任务生效。
 */
export const decideTemplateApply = (
  template: PromptTemplate,
  settings: RedrawSettings,
  options: { hasKey: boolean; isMac: boolean },
): TemplateApplyDecision => {
  const target = resolveTemplateProvider(template);
  if (target.kind === "invalid") {
    return {
      kind: "invalid",
      message: `该模板绑定的服务商「${target.raw}」已失效，未生成；请在设置里重新选择`,
    };
  }
  if (target.kind === "follow" || target.providerId === settings.providerId) {
    return { kind: "generate", prompt: template.prompt };
  }
  const availability = providerAvailability(target.providerId, settings, options);
  if (availability.level !== "ready") {
    return {
      kind: "unavailable",
      message: `该模板需要「${providerLabel(target.providerId)}」，当前${availability.text}，已保留原服务商`,
    };
  }
  return {
    kind: "generate",
    prompt: template.prompt,
    override: providerSwitchPatch(target.providerId),
  };
};
