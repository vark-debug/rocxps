import { captureSelection, type CaptureResult } from "../ps/capture";
import { SILICONED_SELECTION_EXPAND } from "../ps/geometry";
import { loadSettings } from "../settings/store";
import { applyGenerationOverride } from "../settings/templates";
import type { RedrawSettings } from "../settings/types";
import { getCatalogModel } from "../providers/catalog";
import type { ProviderId } from "../providers/types";
import { enqueueCapture, queueStore } from "./queueRunner";
import { validateGenerateFlow } from "./promptPolicy";

// 校验纯函数收敛在 promptPolicy.ts（可被 Node 单测直接打包），此处再导出
export { validateGenerateFlow };

/**
 * 从当前选区直接入队的共享流程（src/task/queue-pause-plan.md §2）：
 * 主面板 generate() 与选区浮窗（SelectionPanel 工具栏）调用同一实现，
 * 避免双入口行为漂移。
 *
 * 语义（与主面板 selection 工作流一致）：
 * - prompt 为空 + Siliconed → 移除任务（运行时注入默认移除文案）；
 * - prompt 为空 + 其他平台 → notice（要求填写）；
 * - forceRedraw → 有提示词时忽略当前 siliconedMode，本次强制重绘（浮窗
 *   「生成式填充」）；空提示词不套 override（auto 下空 = 移除，与「移去」
 *   同语义），同时把 override 写进任务（运行时按本次覆盖判定），与主面板
 *   模板机制同构。
 *
 * 不支持 expand 工作流：浮窗基于选区存在，阔图与选区无关（走主面板）。
 */

export interface GenerateFromSelectionOptions {
  /** 最终提示词；空字符串 = 移除语义（auto 判定）。 */
  prompt: string;
  /** 生成式填充：有提示词时忽略 siliconedMode 强制重绘；空提示词走 auto（移除）。 */
  forceRedraw?: boolean;
  /** 主面板已有的抓取结果（selectionExpand 匹配时复用，跳过重抓）；浮窗入口不传。 */
  reuseCapture?: CaptureResult;
  onCaptureBusy?: (busy: boolean) => void;
  onNotice?: (message: string) => void;
}

/**
 * 结果：成功带本次生效的 provider / 模式（主面板据此更新 UI 提示）；
 * 校验类失败（notice）也带 provider/siliconedMode——主面板原逻辑在校验前更新这两个 state。
 */
export type GenerateFlowOutcome =
  | {
      ok: true;
      provider: ProviderId;
      siliconedMode: "auto" | "remove" | "redraw";
    }
  | {
      ok: false;
      kind: "notice" | "error";
      message: string;
      provider?: ProviderId;
      siliconedMode?: "auto" | "remove" | "redraw";
    };

const fail = (
  kind: "notice" | "error",
  message: string,
): GenerateFlowOutcome => ({ ok: false, kind, message });

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const generateFromSelection = async (
  options: GenerateFromSelectionOptions,
): Promise<GenerateFlowOutcome> => {
  const text = options.prompt.trim();

  let settings: RedrawSettings;
  try {
    settings = await loadSettings();
  } catch (err) {
    return fail("error", `读取设置失败：${errText(err)}`);
  }

  // forceRedraw 只在有提示词时强制重绘；空提示词不套 override，走设置的
  // siliconedMode（auto 下空 = 移除），与浮窗「移去」按钮同语义，不被
  // 「重绘模式需要填写提示词」拦截。
  const override =
    options.forceRedraw && text
      ? ({ siliconedMode: "redraw" } as Partial<RedrawSettings>)
      : undefined;
  const effective = applyGenerationOverride(settings, override);
  const provider = getCatalogModel(effective.modelId).provider;
  const siliconed = provider === "siliconed";

  const validated = validateGenerateFlow(provider, text, effective.siliconedMode);
  if (!validated.ok) {
    return {
      ok: false,
      kind: "notice",
      message: validated.message,
      provider,
      siliconedMode: effective.siliconedMode,
    };
  }

  // 抓取与当前 provider 的外扩参数不一致时重新抓取，
  // 避免 1.4× 只对 Siliconed 生效的约束被绕过（与主面板同口径）
  const wantedExpand = siliconed ? SILICONED_SELECTION_EXPAND : 1;
  let current =
    options.reuseCapture && (options.reuseCapture.selectionExpand ?? 1) === wantedExpand
      ? options.reuseCapture
      : null;
  if (!current) {
    options.onCaptureBusy?.(true);
    try {
      current = await captureSelection({
        sizeMode: effective.sizeMode,
        fixedPresetId: effective.fixedPresetId,
        expandFactor: siliconed ? SILICONED_SELECTION_EXPAND : undefined,
        maskPatchFloor: siliconed,
      });
    } catch (err) {
      return fail("error", errText(err));
    } finally {
      options.onCaptureBusy?.(false);
    }
  }

  try {
    await enqueueCapture({
      prompt: text,
      capture: current,
      settings: effective,
      ...(override ? { settingsOverride: override } : {}),
    });
  } catch (err) {
    return fail("error", errText(err));
  }
  options.onNotice?.(
    queueStore.isPaused() ? "已加入队列（队列已暂停）" : "已加入队列",
  );
  return { ok: true, provider, siliconedMode: effective.siliconedMode };
};
