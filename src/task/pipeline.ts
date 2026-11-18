import { computeRequestSize, type RequestSizeResult } from "../ark/sizeStrategy";
import { getCatalogModel } from "../providers/catalog";
import { generateWithProvider } from "../providers";
import type { CatalogModel } from "../providers/types";
import type {
  ComputeTargetInfo,
  ProviderProgress,
} from "../providers/types";
import { resolveSiliconMode } from "../providers/siliconedPlan";
import { captureSelection, type CaptureResult } from "../ps/capture";
import { SILICONED_SELECTION_EXPAND } from "../ps/geometry";
import { placeBack, type PlaceBackResult } from "../ps/placeBack";
import { promptBlocksSubmit } from "./promptPolicy";
import { loadApiKey, loadSettings } from "../settings/store";
import { applyGenerationOverride } from "../settings/templates";
import type { RedrawSettings } from "../settings/types";

/**
 * 生成与贴回分离的两段编排（docs/local-redraw-plan.md §5）：
 * - runGeneration：捕获选区 → 换算请求尺寸 → 调 Ark 生成，返回生成结果（不写画布）。
 * - placeBackResult：把生成结果按捕获时的坐标与蒙版贴回原位（自动/手动共用）。
 *
 * 阶段事件上抛给 UI（历史记录条目）做进度展示；任何阶段失败直接抛错。
 * MVP 不做任务队列：一次跑一个任务，生成中禁用按钮。
 */

export type RunPhase = "capturing" | "generating" | "generated";

export interface RunProgress {
  phase: RunPhase;
  /** capturing 后提供。 */
  capture?: CaptureResult;
  /** capturing 后提供（adaptive 模型为 null）。 */
  request?: RequestSizeResult | null;
  /** generated 后提供，供预览。 */
  resultBase64?: string;
  /** generating 期间由长任务平台（Siliconed）提供；其余阶段 / 平台为空。 */
  progress?: ProviderProgress;
  /** Siliconed 跨机：实际计算目标（提交前校验后写入）。 */
  compute?: ComputeTargetInfo;
}

/** 一次生成的完整产物：贴回所需的全部信息（可整体存入历史条目）。 */
export interface GeneratedResult {
  capture: CaptureResult;
  /** adaptive 模型为 null。 */
  request: RequestSizeResult | null;
  /** 生成图 base64（无 data: 前缀）。 */
  resultBase64: string;
  /** Siliconed 跨机：实际计算目标。 */
  compute?: ComputeTargetInfo;
}

/** 阶段一：捕获 + 生成（不触碰画布）。
 *  settingsOverride 为一次性覆盖（提示词模板绑定的平台）：只合并进本次任务，
 *  不写回设置文件；任务内所有环节（模型 / Key / 尺寸 / 平台参数）都用合并后的快照。 */
export const runGeneration = async (
  prompt: string,
  onProgress: (p: RunProgress) => void,
  preCaptured?: CaptureResult,
  settingsOverride?: Partial<RedrawSettings>,
): Promise<GeneratedResult> => {
  const settings = applyGenerationOverride(await loadSettings(), settingsOverride);
  const model = getCatalogModel(settings.modelId);
  // 仅方舟 / RunningHub 强制要求 Key；ComfyUI / Siliconed / 自定义接口不需要
  const requiresKey = model.provider === "ark" || model.provider === "runninghub";
  const apiKey = requiresKey ? await loadApiKey(model.provider) : "";
  if (requiresKey && !apiKey) {
    throw new Error("尚未配置 API Key，请先打开「设置」进行配置");
  }
  const text = prompt.trim();
  const siliconed = model.provider === "siliconed";
  // Siliconed 允许留空：最终提示词为空时自动注入默认移除文案；其他平台仍要求填写
  if (promptBlocksSubmit(model.provider, text)) throw new Error("请输入提示词");

  // 1) 捕获（面板可传入已抓取的选区跳过此步；modal 内原子完成，含尺寸规划与蒙版）
  onProgress({ phase: "capturing" });
  const capture =
    preCaptured ??
    (await captureSelection({
      sizeMode: settings.sizeMode,
      fixedPresetId: settings.fixedPresetId,
      expandFactor: siliconed ? SILICONED_SELECTION_EXPAND : undefined,
      maskPatchFloor: siliconed,
    }));
  const request = requestSizeFor(model, capture);
  onProgress({ phase: "capturing", capture, request });

  // 2) 生成（网络层可等待；超时不自动重发，错误交给用户重试）
  onProgress({ phase: "generating", capture, request });
  // 提示词 = 用户指令 + 固定后缀；平台差异（Ark 的双图角色前缀）在分发层处理
  const resolved = resolveSiliconMode(
    prompt,
    settings.promptSuffix,
    settings.siliconedMode,
  );
  const promptFull = siliconed
    ? resolved.prompt
    : [text, settings.promptSuffix]
        .filter((part) => part && part.trim())
        .join("\n");
  // Siliconed 提交前会把实际计算目标回传；进度回调与最终产物都带上，写入历史
  let compute: ComputeTargetInfo | undefined;
  const resultBase64 = await generateWithProvider({
    settings,
    model,
    apiKey,
    prompt: promptFull,
    siliconMode: siliconed ? resolved.mode : undefined,
    imageDataUri: `data:image/png;base64,${capture.pngBase64}`,
    maskDataUri: `data:image/png;base64,${capture.maskPngBase64}`,
    capture,
    request,
    onComputeTarget: (info) => {
      compute = info;
      onProgress({ phase: "generating", capture, request, compute: info });
    },
    onProgress: (progress) =>
      onProgress({ phase: "generating", capture, request, progress }),
  });

  const generated: GeneratedResult = {
    capture,
    request,
    resultBase64,
    ...(compute ? { compute } : {}),
  };
  onProgress({ phase: "generated", ...generated });
  return generated;
};

/** 请求尺寸：预设模式直接取预设精确尺寸；custom 模式沿用旧的像素换算。 */
export const requestSizeFor = (
  model: CatalogModel,
  capture: CaptureResult,
): RequestSizeResult | null => {
  if (!model.explicitSize) return null;
  if (capture.preset) {
    return { reqW: capture.sendWidth, reqH: capture.sendHeight };
  }
  return computeRequestSize(model, capture.expanded.width, capture.expanded.height);
};

/** 阶段二：贴回（modal 内：解码 → 缩回 → 蒙版 → putPixels）；贴回模式取当前设置。 */
export const placeBackResult = async (
  gen: GeneratedResult,
): Promise<PlaceBackResult> => {
  const settings = await loadSettings();
  return placeBack({
    docId: gen.capture.docId,
    docName: gen.capture.docName,
    docPath: gen.capture.docPath,
    canvasWidth: gen.capture.canvasWidth,
    canvasHeight: gen.capture.canvasHeight,
    expanded: gen.capture.expanded,
    mask: gen.capture.mask,
    mode: settings.placeBackMode,
    resultBase64: gen.resultBase64,
    // 请求尺寸只用于「输出尺寸校验」提示；几何一律按实际输出尺寸缩放
    reqW: gen.request ? gen.request.reqW : gen.capture.sendWidth,
    reqH: gen.request ? gen.request.reqH : gen.capture.sendHeight,
  });
};
