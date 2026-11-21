import type { Rect } from "./types";

/**
 * 阔图 / 扩图（Siliconed `--mode expand`）的纯计算部分（不触碰宿主 API）。
 *
 * 工作流：用户在 PS 中先用裁剪工具外扩画布（原始内容外为透明像素），插件抓取
 * 整个扩展后的画布，检测非透明包围盒 =「原始画面」，按下式计算四边 pad：
 *
 *   pad% = 该边到画布边缘的距离 / 源图对应边长 × 100
 *
 * 并提交 `silicontrol add --mode expand --image <源图> --pad L,R,T,B`，
 * 输出画布由 CLI 按 pad 决定（等价于源图 × (1 + pad%)）。
 */

/** CLI `--pad L,R,T,B` 的约束：各边外扩百分比 0–200，全 0 拒绝。 */
export const EXPAND_PAD_MAX = 200;

/** 主面板工作流：selection = 框选局部重绘（默认），expand = 阔图扩图（仅 Siliconed）。 */
export type PanelWorkflow = "selection" | "expand";

/** CLI `--max-sample` 的取值范围与步进（采样长边上限）。 */
export const EXPAND_MAX_SAMPLE_MIN = 1024;
export const EXPAND_MAX_SAMPLE_MAX = 3840;
export const EXPAND_MAX_SAMPLE_STEP = 128;
export const EXPAND_MAX_SAMPLE_DEFAULT = 2048;

/** 四方向 pad 百分比（0–200，浮点）。 */
export interface PadPercent {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** computeExpandPads 的输出。 */
export interface ExpandPadPlan {
  /** clamp 后送 CLI 的百分比（保留两位小数）。 */
  pads: PadPercent;
  /** clamp 前的原始百分比（排查用）。 */
  raw: PadPercent;
  /** 任一边发生 200% 截断。 */
  clamped: boolean;
  /** 逻辑输出画布 = 源图 × (1 + clamp 后 pad)，贴回与 outputMismatch 的基准。 */
  logicalWidth: number;
  logicalHeight: number;
  warnings: string[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const clampPercent = (value: number): { value: number; clamped: boolean } => {
  if (!Number.isFinite(value)) return { value: 0, clamped: true };
  if (value < 0) return { value: 0, clamped: true };
  if (value > EXPAND_PAD_MAX) return { value: EXPAND_PAD_MAX, clamped: true };
  return { value, clamped: false };
};

/**
 * 由「源图包围盒 + 扩展后画布」计算四边 pad 百分比。
 *
 * 包围盒不居中由四边独立公式天然覆盖。任一边超过 200% 时截断（CLI 上限），
 * 截断意味着扩展画布不会被生成结果完全覆盖，通过 warnings 提示用户。
 * 源图等于画布（用户没有外扩）时抛错，与 CLI「全 0 拒绝」对齐。
 */
export const computeExpandPads = (
  source: Rect,
  canvasWidth: number,
  canvasHeight: number,
): ExpandPadPlan => {
  const sw = Math.round(source.right - source.left);
  const sh = Math.round(source.bottom - source.top);
  if (!(sw > 0) || !(sh > 0)) {
    throw new Error("源图包围盒为空，无法计算扩图比例");
  }
  if (!(canvasWidth >= sw) || !(canvasHeight >= sh)) {
    throw new Error("源图包围盒超出画布，无法计算扩图比例");
  }

  const raw: PadPercent = {
    left: (source.left / sw) * 100,
    right: ((canvasWidth - source.right) / sw) * 100,
    top: (source.top / sh) * 100,
    bottom: ((canvasHeight - source.bottom) / sh) * 100,
  };

  const sides: Array<[keyof PadPercent, string]> = [
    ["left", "左侧"],
    ["right", "右侧"],
    ["top", "上侧"],
    ["bottom", "下侧"],
  ];
  const pads = {} as PadPercent;
  let clamped = false;
  const warnings: string[] = [];
  for (const [key, label] of sides) {
    const c = clampPercent(raw[key]);
    pads[key] = round2(c.value);
    if (c.clamped) {
      clamped = true;
      warnings.push(
        `${label}外扩 ${Math.round(raw[key])}% 超过 CLI 上限 ${EXPAND_PAD_MAX}%，超出部分不会被生成`,
      );
    }
  }

  if (pads.left === 0 && pads.right === 0 && pads.top === 0 && pads.bottom === 0) {
    throw new Error("画布未外扩：请先用裁剪工具外扩画布，再进行扩图");
  }

  const logicalWidth = Math.round(sw * (1 + (pads.left + pads.right) / 100));
  const logicalHeight = Math.round(sh * (1 + (pads.top + pads.bottom) / 100));
  return { pads, raw, clamped, logicalWidth, logicalHeight, warnings };
};

/** 面板工作流归一化：非法值回退 selection（旧设置无该字段）。 */
export const normalizePanelWorkflow = (value: unknown): PanelWorkflow =>
  value === "expand" ? "expand" : "selection";

const snapToStep = (value: number): number => {
  const snapped = Math.round(value / EXPAND_MAX_SAMPLE_STEP) * EXPAND_MAX_SAMPLE_STEP;
  return Math.min(
    EXPAND_MAX_SAMPLE_MAX,
    Math.max(EXPAND_MAX_SAMPLE_MIN, snapped),
  );
};

/**
 * --max-sample 归一化：clamp 到 1024–3840 后 snap 到最近的 128 倍数；
 * 非法输入回退默认 2048。
 */
export const normalizeExpandMaxSample = (
  raw: unknown,
  fallback: number = EXPAND_MAX_SAMPLE_DEFAULT,
): number => {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return snapToStep(value);
};

/** 四边 pad 格式化为 CLI 参数值：顺序 L,R,T,B，两位小数。 */
export const formatPadArg = (pads: PadPercent): string =>
  [
    pads.left,
    pads.right,
    pads.top,
    pads.bottom,
  ]
    .map((v) => v.toFixed(2))
    .join(",");

/** 累积包围盒的中间形态（min/max 语义，便于扫描合并）。 */
export interface AlphaBoundsAcc {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** RGB 三元组（0–255），背景色比对用。 */
export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

/** 四边收缩量（像素）：背景层锁定时按背景色带收缩出的「真实内容边界」。 */
export interface BackgroundShrink {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 在单块 RGBA 内扫描与背景色不一致的像素，更新列 / 行内容标记。
 * colHasContent / rowHasContent 长度分别为扫描区域宽 / 高（1 = 存在非背景色像素）；
 * offX/offY 是该块相对扫描区域原点的偏移；通道差均 ≤ tolerance 视为背景色。
 * 纯函数，Node 可单测；只写标记不分配大缓冲，O(tile) 内存。
 */
export const accumulateBackgroundColor = (
  colHasContent: Uint8Array,
  rowHasContent: Uint8Array,
  rgba: Uint8Array,
  tileW: number,
  tileH: number,
  offX: number,
  offY: number,
  bg: RGBColor,
  tolerance = 2,
): void => {
  if (rgba.length !== tileW * tileH * 4) {
    throw new Error("背景色扫描：像素长度与尺寸不符");
  }
  for (let y = 0; y < tileH; y++) {
    const row = offY + y;
    for (let x = 0; x < tileW; x++) {
      const i = (y * tileW + x) * 4;
      if (
        Math.abs(rgba[i] - bg.r) > tolerance ||
        Math.abs(rgba[i + 1] - bg.g) > tolerance ||
        Math.abs(rgba[i + 2] - bg.b) > tolerance
      ) {
        colHasContent[offX + x] = 1;
        rowHasContent[row] = 1;
      }
    }
  }
};

/**
 * 由列 / 行内容标记计算四边收缩量：从每边向内数连续的「无内容」带，
 * 遇到第一个内容像素即停（防止内容本身含大面积背景色导致过度收缩）。
 * 收缩后为空（或整行 / 整列无内容——修正失败）返回 null，调用方回退报错路径。
 */
export const shrinkFromBackgroundFill = (
  colHasContent: Uint8Array,
  rowHasContent: Uint8Array,
): BackgroundShrink | null => {
  const w = colHasContent.length;
  const h = rowHasContent.length;
  if (!(w > 0) || !(h > 0)) return null;
  let left = 0;
  while (left < w && colHasContent[left] === 0) left++;
  if (left >= w) return null; // 整幅画布都是背景色 → 修正失败
  let right = 0;
  while (right < w - left && colHasContent[w - 1 - right] === 0) right++;
  let top = 0;
  while (top < h && rowHasContent[top] === 0) top++;
  if (top >= h) return null;
  let bottom = 0;
  while (bottom < h - top && rowHasContent[h - 1 - bottom] === 0) bottom++;
  if (left + right >= w || top + bottom >= h) return null;
  return { left, top, right, bottom };
};

/**
 * 在单块 RGBA 内扫描非透明像素（alpha > threshold），更新累积包围盒。
 * offX/offY 是该块相对扫描区域原点的偏移；全透明返回原 bounds（可能为 null）。
 * 纯函数，Node 可单测；阔图抓取用它对整画布分块扫描求「原始画面」包围盒。
 */
export const accumulateAlphaBounds = (
  bounds: AlphaBoundsAcc | null,
  rgba: Uint8Array,
  tileW: number,
  tileH: number,
  offX: number,
  offY: number,
  threshold = 0,
): AlphaBoundsAcc | null => {
  if (rgba.length !== tileW * tileH * 4) {
    throw new Error("alpha 扫描：像素长度与尺寸不符");
  }
  let minX = bounds ? bounds.minX : Number.POSITIVE_INFINITY;
  let minY = bounds ? bounds.minY : Number.POSITIVE_INFINITY;
  let maxX = bounds ? bounds.maxX : Number.NEGATIVE_INFINITY;
  let maxY = bounds ? bounds.maxY : Number.NEGATIVE_INFINITY;
  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      if (rgba[(y * tileW + x) * 4 + 3] > threshold) {
        const gx = x + offX;
        const gy = y + offY;
        if (gx < minX) minX = gx;
        if (gy < minY) minY = gy;
        if (gx > maxX) maxX = gx;
        if (gy > maxY) maxY = gy;
      }
    }
  }
  if (minX > maxX) return bounds;
  return { minX, minY, maxX, maxY };
};
