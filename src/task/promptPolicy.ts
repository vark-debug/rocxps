import type { ProviderId } from "../providers/types";

/**
 * 空提示词是否应阻止提交（提交前的唯一判定口径）。
 *
 * Siliconed 的 mask 移除工作流允许留空：运行时由 resolveSiliconMode 注入
 * 默认移除文案（auto 下留空即 remove），因此空 / 纯空白不阻断；其他平台仍要求用户填写。
 *
 * 只看 provider 与「最终提示词」（模板 / 后缀套用后的结果），不看输入框的
 * 临时状态——两者可能因设置切换而不一致。
 */
export const promptBlocksSubmit = (
  providerId: ProviderId,
  prompt: string,
): boolean => providerId !== "siliconed" && !prompt.trim();
