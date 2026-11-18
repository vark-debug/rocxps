import { CAPTURE_ALIGN } from "./align";

/**
 * 抓取尺寸预设表（单一真相源）。
 *
 * 实测结论：输入尺寸与输出尺寸完全一致时误差最小（SIFT 尺度 ≈1、dx ≈ -1、
 * ΔE ≈5.5）；尺寸不一致（等比放大后补画布 / 单轴拉伸 3.2%）会让 SIFT 尺度、
 * 相位响应与色差明显变差。因此抓取区域统一「向外扩到预设比例 + 缩放到预设精确
 * 尺寸」，不再按 32 独立对齐宽高来凑尺寸。
 *
 * verified = 已在本机 Siliconed 上实测「请求尺寸 == 返回尺寸」。
 * 832×1216 实测返回 832×1248（纵向拉伸 3.2%），因此标记 unverified，
 * 默认不参与自动匹配，仅允许在「固定预设」模式下手动选择。
 */
export type Orientation = "landscape" | "portrait" | "square";

export interface SizePreset {
  /** 稳定 id，形如 896x1152（用于设置持久化与历史记录）。 */
  id: string;
  width: number;
  height: number;
  orientation: Orientation;
  /** 是否已实测确认「请求尺寸 == 返回尺寸」。 */
  verified: boolean;
  /** 未验证预设的实测备注（UI 置灰时展示）。 */
  note?: string;
}

export const SIZE_PRESETS: readonly SizePreset[] = [
  { id: "896x1152", width: 896, height: 1152, orientation: "portrait", verified: true },
  { id: "768x1344", width: 768, height: 1344, orientation: "portrait", verified: true },
  { id: "1152x896", width: 1152, height: 896, orientation: "landscape", verified: true },
  { id: "1344x768", width: 1344, height: 768, orientation: "landscape", verified: true },
  { id: "1024x1024", width: 1024, height: 1024, orientation: "square", verified: true },
  {
    id: "832x1216",
    width: 832,
    height: 1216,
    orientation: "portrait",
    verified: false,
    note: "应用实测返回 832×1248（纵向拉伸 3.2%）",
  },
  {
    id: "1216x832",
    width: 1216,
    height: 832,
    orientation: "landscape",
    verified: false,
    note: "应用实测会返回其他尺寸",
  },
];

export const VERIFIED_PRESETS: readonly SizePreset[] = SIZE_PRESETS.filter(
  (p) => p.verified,
);

export const UNVERIFIED_PRESETS: readonly SizePreset[] = SIZE_PRESETS.filter(
  (p) => !p.verified,
);

export const DEFAULT_PRESET_ID = "896x1152";

export const getPresetById = (id: string): SizePreset | undefined =>
  SIZE_PRESETS.find((p) => p.id === id);

/** 预设展示文案：896×1152（竖图）。 */
export const presetLabel = (preset: SizePreset): string =>
  `${preset.width}×${preset.height}`;

/** 断言单个预设的宽高均为 CAPTURE_ALIGN（32）的倍数。 */
export const assertPresetAligned = (
  preset: SizePreset,
  align: number = CAPTURE_ALIGN,
): void => {
  if (preset.width % align !== 0 || preset.height % align !== 0) {
    throw new Error(
      `尺寸预设 ${preset.id} 的宽高必须是 ${align} 的倍数（${preset.width}×${preset.height}）`,
    );
  }
};

/** 断言所有已验证预设均为 CAPTURE_ALIGN 的倍数；模块加载时执行一次。 */
export const assertPresetsAligned = (
  presets: readonly SizePreset[] = VERIFIED_PRESETS,
  align: number = CAPTURE_ALIGN,
): void => {
  for (const preset of presets) assertPresetAligned(preset, align);
};

/**
 * 抓取产物尺寸断言：预设模式下送图宽高必须严格等于预设宽高。
 * 这是新路径的运行时兜底，避免哪天又回到「单边补像素」。
 */
export const assertPresetSendSize = (
  width: number,
  height: number,
  preset: SizePreset,
): void => {
  if (width !== preset.width || height !== preset.height) {
    throw new Error(
      `抓取尺寸断言失败：送出 ${width}×${height}，预设 ${preset.id} 要求 ${preset.width}×${preset.height}`,
    );
  }
};

// 模块加载即校验，表写错时在任何路径上都会第一时间暴露。
assertPresetsAligned();
