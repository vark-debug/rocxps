import { MODELS } from "../ark/models";
import {
  PROVIDERS,
  type CatalogModel,
  type ProviderId,
} from "./types";

/**
 * 全平台模型目录：设置面板按平台过滤展示，生成时以模型自带的 provider 为准。
 * Ark 模型复用原有预设；RunningHub / ComfyUI / 自定义接口使用各自平台默认参数。
 */

/** 设置面板默认值（首次运行 / 切换平台时使用）。 */
export const RH_DEFAULT_BASE_URL = "https://www.runninghub.cn";
export const COMFY_DEFAULT_BASE_URL = "http://127.0.0.1:8188";
/** Siliconed.app 内置的 CLI；路径可在设置面板修改。 */
export const SILICONED_DEFAULT_CLI_PATH =
  "/Applications/Siliconed.app/Contents/Helpers/silicontrol";
/** 本地 IOPaint 服务（`iopaint start --port=18088`）。 */
export const IOPAINT_DEFAULT_BASE_URL = "http://127.0.0.1:18088";
/** IOPaint 擦除模型：lama（快）/ mat（慢但质量更好）。 */
export const IOPAINT_DEFAULT_MODEL = "lama";
export const CUSTOM_DEFAULT_HEADERS = `{
  "Content-Type": "application/json"
}`;
export const CUSTOM_DEFAULT_BODY = `{
  "prompt": "{{prompt}}",
  "image": "{{image}}"
}`;
export const CUSTOM_DEFAULT_RESULT_PATH = "data.0.b64_json";

const RH_QWEN_ENDPOINT = "/openapi/v2/alibaba/qwen-image-2.0/image-edit";
/**
 * 千问图像编辑：imageUrls 支持 1–3 张（原图 + 黑白通道图，与方舟同一约定）；
 * 不传 size，但小图会被服务端放大到约 1MP，贴回时统一缩放。
 */
const RH_QWEN_BODY = `{
  "imageUrls": ["{{image}}", "{{mask}}"],
  "prompt": "{{prompt}}"
}`;

/** 旧版模板（只传原图）：载入设置时自动升级，用户自定义过的模板不受影响。 */
export const RH_QWEN_BODY_LEGACY = `{
  "imageUrls": ["{{image}}"],
  "prompt": "{{prompt}}"
}`;

export const RH_DEFAULT_ENDPOINT = RH_QWEN_ENDPOINT;
export const RH_DEFAULT_BODY_TEMPLATE = RH_QWEN_BODY;

const RH_WAN_ENDPOINT = "/openapi/v2/rhart-video/wan-2.2/image-to-image";
/** Wan 2.2：nodeId 前缀键；宽高范围 256–1536，输出固定为请求尺寸。 */
const RH_WAN_BODY = `{
  "272##image": "{{image}}",
  "79##text": "{{prompt}}",
  "267##select": "{{aspect}}",
  "270##value": "{{width}}",
  "271##value": "{{height}}",
  "242##file_type": "png"
}`;

export const CATALOG: CatalogModel[] = [
  ...MODELS.map((m) => ({ ...m, provider: "ark" as const })),
  {
    id: "rh-qwen-image-edit-2-0",
    provider: "runninghub",
    label: "千问 2.0 图像编辑（RunningHub）",
    kind: "edit",
    explicitSize: false,
    minPixels: 0,
    maxPixels: 0,
    rhEndpoint: RH_QWEN_ENDPOINT,
    rhBodyTemplate: RH_QWEN_BODY,
  },
  {
    id: "rh-wan-2-2-i2i",
    provider: "runninghub",
    label: "Wan 2.2 图生图（RunningHub）",
    kind: "i2i",
    explicitSize: true,
    minPixels: 65536,
    maxPixels: 2359296,
    maxSide: 1536,
    rhEndpoint: RH_WAN_ENDPOINT,
    rhBodyTemplate: RH_WAN_BODY,
  },
  {
    id: "comfyui-local",
    provider: "comfyui",
    label: "ComfyUI 本地工作流",
    kind: "i2i",
    explicitSize: false,
    minPixels: 0,
    maxPixels: 0,
  },
  {
    id: "siliconed-qwen-edit",
    provider: "siliconed",
    label: "Qwen-Image-2.1 Turbo 编辑（Siliconed 本地）",
    kind: "edit",
    // 尺寸由 provider 内部规划（每边 ≥512、32 对齐、≤1MP），贴回仍按 expanded 缩放
    explicitSize: false,
    minPixels: 0,
    maxPixels: 1048576,
    sizeAlign: 32,
    minSide: 512,
  },
  {
    id: "iopaint-lama",
    provider: "iopaint",
    label: "IOPaint 本地擦除（LaMa / MAT）",
    kind: "edit",
    // 服务端输出与输入同尺寸；尺寸对齐沿用捕获层的 32 对齐
    explicitSize: false,
    minPixels: 0,
    maxPixels: 0,
    sizeAlign: 32,
  },
  {
    id: "custom-http",
    provider: "custom",
    label: "自定义 HTTP 接口",
    kind: "i2i",
    explicitSize: false,
    minPixels: 0,
    maxPixels: 0,
  },
];

export const getCatalogModel = (id: string): CatalogModel =>
  CATALOG.find((m) => m.id === id) ?? CATALOG[0];

export const modelsForProvider = (provider: ProviderId): CatalogModel[] =>
  CATALOG.filter((m) => m.provider === provider);

export const providerIds = (): ProviderId[] => PROVIDERS.map((p) => p.id);
