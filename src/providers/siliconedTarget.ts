/**
 * Siliconed 跨机渲染（「穿透」）的纯计算部分（不触碰宿主 API，便于单测）：
 * macs 列表解析、目标可用性判定、提交前 computing_on 校验策略。
 *
 * 0.20 契约（silicontrol help macs）：
 * - macs verdict：{ ok, computing_on: null | "Mac mini", pairings_read,
 *   macs: [{ name, id, state, computing, machine }], lending, lent_to }
 * - state: connected / connecting / lost / on_the_network / not_on_the_network /
 *   refused_forgotten / refused_version
 * - compute NAME|this：把窗口的计算目标切到该 Mac 或本机。
 *
 * 注意：not_on_the_network / refused_* 不可用；on_the_network 与 lost 仍可通过 compute 建立会话。
 */

export type SiliconComputeTarget = "local" | "mac";

/** 目标与实际不一致时的处理策略：auto 自动切到目标，warn 按实际执行并提示。 */
export type SiliconTargetPolicy = "auto" | "warn";

export const SILICONED_LOCAL_LABEL = "本机";

export interface SiliconMac {
  id: string;
  name: string;
  state: string;
  computing: boolean;
  machine?: string;
}

export interface SiliconMacsSnapshot {
  /** false = 当前 silicontrol 没有 macs（0.18/0.19）或命令不可用。 */
  supported: boolean;
  macs: SiliconMac[];
  /** null = 本机；字符串 = 远端 Mac 名称。 */
  computingOn: string | null;
  pairingsRead: boolean;
  lending: boolean;
}

export const emptySiliconMacs = (
  supported = false,
): SiliconMacsSnapshot => ({
  supported,
  macs: [],
  computingOn: null,
  pairingsRead: false,
  lending: false,
});

const asText = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asOptionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** macs verdict → 结构化快照（字段 snake_case 转 camelCase）。 */
export const normalizeSiliconMacs = (
  verdict: Record<string, unknown>,
): SiliconMacsSnapshot => ({
  supported: true,
  macs: Array.isArray(verdict.macs)
    ? verdict.macs.map((raw) => {
        const mac = (raw ?? {}) as Record<string, unknown>;
        return {
          id: asText(mac.id),
          name: asText(mac.name),
          state: asText(mac.state) || "unknown",
          computing: mac.computing === true,
          machine: asOptionalText(mac.machine),
        };
      })
    : [],
  computingOn: asOptionalText(verdict.computing_on) ?? null,
  pairingsRead: verdict.pairings_read === true,
  lending: verdict.lending === true,
});

/** state 的中文说明；未识别值原样展示，避免静默。 */
export const MAC_STATE_LABELS: Record<string, string> = {
  connected: "已连接",
  connecting: "连接中",
  lost: "会话断开（正在重试）",
  on_the_network: "在局域网内（尚未建立会话）",
  not_on_the_network: "不在局域网内（离线）",
  refused_forgotten: "对方已忘记本机",
  refused_version: "两端版本不一致",
};

export const macStateText = (state: string): string =>
  MAC_STATE_LABELS[state] ?? (state || "状态未知");

/** 需要用户先处理的不可用 state；其余（connected/connecting/lost/on_the_network）可通过 compute 重连。 */
export const isMacUnusable = (state: string): boolean =>
  state === "not_on_the_network" ||
  state === "refused_forgotten" ||
  state === "refused_version";

/** 不可用 state 的下一步动作说明（设置列表与提交校验共用）。 */
export const macStateReason = (state: string): string => {
  switch (state) {
    case "not_on_the_network":
      return "该 Mac 当前不在局域网内：请唤醒它并确认同一网络后重试";
    case "refused_forgotten":
      return "该 Mac 已忘记本机配对：请在 Siliconed 的「其他 Mac」中重新配对";
    case "refused_version":
      return "两端 Siliconed 版本不一致：请在两台 Mac 上更新到同一版本";
    default:
      return "";
  }
};

/** computing_on → 展示文案。 */
export const targetLabel = (computingOn: string | null): string =>
  computingOn && computingOn.trim() ? computingOn : SILICONED_LOCAL_LABEL;

export const normalizeSiliconTarget = (value: unknown): SiliconComputeTarget =>
  value === "mac" ? "mac" : "local";

export const normalizeSiliconTargetPolicy = (value: unknown): SiliconTargetPolicy =>
  value === "warn" ? "warn" : "auto";

export interface ComputeTargetIntent {
  target: SiliconComputeTarget;
  /** target=mac 时的已选 Mac id（也兼容名称）。 */
  macId?: string;
  policy: SiliconTargetPolicy;
}

export interface ComputeTargetCheck {
  /**
   * ok = 目标与实际一致；
   * switch = 需要先执行 compute；
   * mismatch = warn 策略下沿用实际目标；
   * blocked = 目标不可用（离线 / 版本不符 / 未配对 / 旧版本不支持）。
   */
  kind: "ok" | "switch" | "mismatch" | "blocked";
  /** 提交前的 status.computing_on（null = 本机）。 */
  actual: string | null;
  /** 用户选择的目标展示名。 */
  targetLabel: string;
  /** kind=switch 时传给 compute 的参数（"this" 或 Mac 名称）。 */
  computeArg?: string;
  /** blocked / mismatch 时给用户看的说明。 */
  message?: string;
}

/**
 * 提交前校验：把「设置里的目标」与 status.computing_on 对比。
 * - auto：不一致 → 返回 switch，由调用方执行 compute 并重新读取；
 * - warn：不一致 → 返回 mismatch，调用方按实际目标执行并记录；
 * - 目标不可用 → blocked（明确原因，不静默改跑本机）。
 */
export const planComputeTarget = (
  intent: ComputeTargetIntent,
  snapshot: SiliconMacsSnapshot,
): ComputeTargetCheck => {
  const actual = snapshot.computingOn;

  if (intent.target === "local") {
    if (actual === null) {
      return { kind: "ok", actual, targetLabel: SILICONED_LOCAL_LABEL };
    }
    if (intent.policy === "warn") {
      return {
        kind: "mismatch",
        actual,
        targetLabel: SILICONED_LOCAL_LABEL,
        message: `选择的计算目标是「本机」，但 Siliconed 实际在「${actual}」上计算；本次按实际目标执行`,
      };
    }
    return {
      kind: "switch",
      actual,
      targetLabel: SILICONED_LOCAL_LABEL,
      computeArg: "this",
    };
  }

  if (!snapshot.supported) {
    return {
      kind: "blocked",
      actual,
      targetLabel: "指定的 Mac",
      message:
        "当前 Siliconed 版本不支持跨机渲染（没有 macs / compute 命令，需 0.20 及以上）：请把计算目标改回「本机」或升级 Siliconed",
    };
  }

  const name = intent.macId && intent.macId.trim();
  const mac =
    snapshot.macs.find((item) => item.id === name) ??
    snapshot.macs.find((item) => item.name === name) ??
    null;
  if (!mac) {
    return {
      kind: "blocked",
      actual,
      targetLabel: name ? `指定的 Mac（${name}）` : "指定的 Mac",
      message: `没有找到已配对的 Mac「${name || "未选择"}」：请打开设置刷新列表，或在 Siliconed 中重新配对`,
    };
  }

  if (isMacUnusable(mac.state)) {
    return {
      kind: "blocked",
      actual,
      targetLabel: mac.name,
      message: `目标 Mac「${mac.name}」当前不可用（${macStateText(mac.state)}）：${macStateReason(mac.state)}`,
    };
  }

  if (actual === mac.name || actual === mac.id) {
    return { kind: "ok", actual, targetLabel: mac.name };
  }
  if (intent.policy === "warn") {
    return {
      kind: "mismatch",
      actual,
      targetLabel: mac.name,
      message: `选择的计算目标是「${mac.name}」，但 Siliconed 实际在「${targetLabel(
        actual,
      )}」上计算；本次按实际目标执行`,
    };
  }
  return {
    kind: "switch",
    actual,
    targetLabel: mac.name,
    computeArg: mac.name,
  };
};
