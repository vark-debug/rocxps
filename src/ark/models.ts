/**
 * 火山方舟 Seedream 系列模型预设（docs/local-redraw-plan.md §2.2）。
 * 像素上下限用于 sizeStrategy 换算请求尺寸；seededit 走 adaptive，不受约束。
 */
export type ModelKind = "i2i" | "edit";

export interface ModelPreset {
  id: string;
  label: string;
  kind: ModelKind;
  /** 是否支持显式 WxH；false = seededit 走 size: "adaptive"，输出跟随输入。 */
  explicitSize: boolean;
  /** 输出总像素下限；0 表示无此约束。 */
  minPixels: number;
  /** 输出总像素上限；0 表示无此约束。 */
  maxPixels: number;
  /** 输出单边上限（如 RunningHub Wan 2.2 的 1536）；不填表示不限制。 */
  maxSide?: number;
  /** 请求尺寸边长对齐（默认 8）；如 Qwen-Image-2.1 要求 32。 */
  sizeAlign?: number;
  /** 请求尺寸单边下限（如 Siliconed 的 512）；不填表示不限制。 */
  minSide?: number;
}

export const MODELS: ModelPreset[] = [
  {
    id: "doubao-seedream-4-0-250828",
    label: "Seedream 4.0（默认）",
    kind: "i2i",
    explicitSize: true,
    minPixels: 921600,
    maxPixels: 16777216,
  },
  {
    id: "doubao-seededit-3-0-i2i",
    label: "Seededit 3.0（指令编辑 / adaptive）",
    kind: "edit",
    explicitSize: false,
    minPixels: 0,
    maxPixels: 0,
  },
  {
    id: "doubao-seedream-4-5-251128",
    label: "Seedream 4.5",
    kind: "i2i",
    explicitSize: true,
    minPixels: 921600,
    maxPixels: 16777216,
  },
  {
    id: "doubao-seedream-5-0-lite-260128",
    label: "Seedream 5.0 Lite",
    kind: "i2i",
    explicitSize: true,
    minPixels: 921600,
    maxPixels: 4624220,
  },
  {
    id: "doubao-seedream-5-0-flash-260915",
    label: "Seedream 5.0 Flash",
    kind: "i2i",
    explicitSize: true,
    minPixels: 921600,
    maxPixels: 4624220,
  },
  {
    id: "doubao-seedream-5-0-pro-260628",
    label: "Seedream 5.0 Pro",
    kind: "i2i",
    explicitSize: true,
    minPixels: 921600,
    maxPixels: 4624220,
  },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

export const getModel = (id: string): ModelPreset =>
  MODELS.find((m) => m.id === id) ?? MODELS[0];
