import { generateImage, testConnection } from "../ark/client";
import type { RequestSizeResult } from "../ark/sizeStrategy";
import type { CaptureResult } from "../ps/capture";
import type { RedrawSettings } from "../settings/types";
import { comfyGenerate, comfyProbe } from "./comfyui";
import { customGenerate } from "./custom";
import { iopaintGenerate, iopaintProbe } from "./iopaint";
import { runningHubGenerate, runningHubProbe } from "./runninghub";
import { siliconedGenerate, siliconedProbe } from "./siliconed";
import type { SiliconMode } from "./siliconedPlan";
import type {
  CatalogModel,
  ComputeTargetInfo,
  ProviderId,
  ProviderProgress,
  TemplateVars,
} from "./types";

/**
 * 平台分发层：把「选区 + 提示词 + 尺寸」翻译成各平台自己的请求。
 * - Ark：官方双图约定（原图 + 黑白通道图）+ 提示词角色前缀；
 * - RunningHub：请求体模板里写了 {{mask}} 时同样按双图约定发；
 * - ComfyUI / 自定义：只发 {{image}}，模板里也可自行使用 {{mask}}，提示词不带角色前缀。
 */

/** Wan 2.2 的 aspectRatio 枚举；按最终请求尺寸的宽高比取最近项。 */
const ASPECTS: Array<{ value: string; ratio: number }> = [
  { value: "1:1", ratio: 1 },
  { value: "3:4", ratio: 3 / 4 },
  { value: "4:3", ratio: 4 / 3 },
  { value: "9:16", ratio: 9 / 16 },
  { value: "16:9", ratio: 16 / 9 },
];

export const nearestAspect = (width: number, height: number): string => {
  if (width <= 0 || height <= 0) return "1:1";
  const ratio = width / height;
  let best = ASPECTS[0];
  let bestDiff = Infinity;
  for (const item of ASPECTS) {
    const diff = Math.abs(Math.log(item.ratio) - Math.log(ratio));
    if (diff < bestDiff) {
      best = item;
      bestDiff = diff;
    }
  }
  return best.value;
};

/**
 * 双图输入说明前缀：这些平台接口没有内建的蒙版/inpaint 约定，
 * 在提示词开头注明两张图的角色与通道图黑白语义（白 = 待重绘，黑 = 保留）。
 */
const IMAGE_ROLE_PREFIX =
  "图1为待修改图片，图2为修改区域蒙版：白色为需要修改的区域，黑色为保持不变的区域。";

export interface GenerateInput {
  settings: RedrawSettings;
  model: CatalogModel;
  apiKey: string;
  /** 已拼好后缀的提示词（不含平台角色前缀）。 */
  prompt: string;
  /** Siliconed 蒙版分支（其他平台忽略）；缺省按 remove。 */
  siliconMode?: SiliconMode;
  /** 选区内容图 data URI。 */
  imageDataUri: string;
  /** 黑白通道图 data URI（仅 Ark 默认使用，其他平台可取 {{mask}}）。 */
  maskDataUri: string;
  capture: CaptureResult;
  /** 显式尺寸模型为换算结果，adaptive / 无尺寸模型为 null。 */
  request: RequestSizeResult | null;
  /** 长任务平台（Siliconed）的进度回调；其他平台不调用。 */
  onProgress?: (progress: ProviderProgress) => void;
  /** Siliconed 跨机：提交前的目标校验结果 / 实际计算目标。 */
  onComputeTarget?: (info: ComputeTargetInfo) => void;
  /** 队列取消标记（当前仅 Siliconed 的轮询阶段响应）。 */
  signal?: AbortSignal;
  /** Siliconed 远端 job id 回传（队列取消用）。 */
  onJobId?: (job: string) => void;
}

/** 按模型所属平台生成，统一返回 PNG/JPEG 的 base64（无 data: 前缀）。 */
export const generateWithProvider = async (
  input: GenerateInput,
): Promise<string> => {
  const { settings, model, apiKey, prompt, imageDataUri, maskDataUri, capture, request } =
    input;
  const width = request?.reqW ?? capture.sendWidth;
  const height = request?.reqH ?? capture.sendHeight;
  const vars: TemplateVars = {
    image: imageDataUri,
    mask: maskDataUri,
    prompt,
    width,
    height,
    aspect: nearestAspect(width, height),
  };

  switch (model.provider) {
    case "ark": {
      const result = await generateImage(apiKey, {
        model: model.id,
        prompt: [IMAGE_ROLE_PREFIX, prompt]
          .filter((part) => part && part.trim())
          .join("\n"),
        image: [imageDataUri, maskDataUri],
        size: model.explicitSize ? `${width}x${height}` : "adaptive",
        watermark: settings.watermark,
        timeoutMs: settings.requestTimeoutMs,
      });
      const image = result.images[0];
      if (!image?.b64Json) throw new Error("模型未返回图像数据");
      return image.b64Json;
    }
    case "runninghub": {
      const bodyTemplate =
        settings.rhBodyTemplate || model.rhBodyTemplate || "";
      // 模板含 {{mask}} 才追加双图角色前缀（单图模板加前缀会提到不存在的「图2」）
      const usesMask = bodyTemplate.includes("{{mask}}");
      return runningHubGenerate(
        {
          baseUrl: settings.rhBaseUrl,
          endpoint: settings.rhEndpoint || model.rhEndpoint || "",
          bodyTemplate,
          timeoutMs: settings.requestTimeoutMs,
        },
        apiKey,
        usesMask
          ? { ...vars, prompt: [IMAGE_ROLE_PREFIX, prompt].join("\n") }
          : vars,
      );
    }
    case "comfyui":
      return comfyGenerate(
        {
          baseUrl: settings.comfyBaseUrl,
          workflow: settings.comfyWorkflow,
          timeoutMs: settings.requestTimeoutMs,
        },
        imageDataUri,
        vars,
      );
    case "siliconed":
      return siliconedGenerate(
        {
          cliPath: settings.siliconedCliPath,
          timeoutMs: settings.requestTimeoutMs,
          computeTarget: settings.siliconedComputeTarget,
          targetMacId: settings.siliconedTargetMac,
          targetPolicy: settings.siliconedTargetPolicy,
          onComputeTarget: input.onComputeTarget,
          onProgress: input.onProgress,
          signal: input.signal,
          onJobId: input.onJobId,
        },
        imageDataUri,
        maskDataUri,
        prompt,
        input.siliconMode,
      );
    case "iopaint":
      // 发送捕获区域（预设模式已缩放到预设尺寸）；mask 与该图同几何
      return iopaintGenerate(
        {
          baseUrl: settings.iopaintBaseUrl,
          model: settings.iopaintModel,
          // 一次性请求，按实测把上限压到 120s（含首次模型加载）
          timeoutMs: Math.min(settings.requestTimeoutMs, 120_000),
        },
        {
          imageBase64: capture.pngBase64,
          maskBase64: capture.maskPngBase64,
          mask: capture.sendMask,
          width: capture.sendWidth,
          height: capture.sendHeight,
        },
      );
    case "custom":
      return customGenerate(
        {
          url: settings.customUrl,
          headers: settings.customHeaders,
          bodyTemplate: settings.customBodyTemplate,
          resultPath: settings.customResultPath,
          timeoutMs: settings.requestTimeoutMs,
        },
        apiKey,
        vars,
      );
  }
};

export type ProbeResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 各平台的零成本连通性探测（自定义接口仅做配置静态校验，不实际发请求）。 */
export const probeProvider = async (
  provider: ProviderId,
  settings: RedrawSettings,
  apiKey: string,
): Promise<ProbeResult> => {
  switch (provider) {
    case "ark":
      return testConnection(apiKey);
    case "runninghub":
      return runningHubProbe(settings.rhBaseUrl, apiKey);
    case "comfyui":
      return comfyProbe(settings.comfyBaseUrl);
    case "siliconed":
      return siliconedProbe(settings.siliconedCliPath);
    case "iopaint":
      return iopaintProbe(settings.iopaintBaseUrl, settings.iopaintModel);
    case "custom": {
      if (!settings.customUrl.trim()) {
        return { ok: false, message: "请先填写自定义接口 URL" };
      }
      try {
        JSON.parse(settings.customHeaders || "{}");
        JSON.parse(settings.customBodyTemplate || "{}");
      } catch {
        return { ok: false, message: "请求头或请求体模板不是合法 JSON" };
      }
      return { ok: true, message: "配置格式正确（自定义接口不做实际调用测试）" };
    }
  }
};
