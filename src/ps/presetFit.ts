import {
  DEFAULT_PRESET_ID,
  getPresetById,
  VERIFIED_PRESETS,
  type Orientation,
  type SizePreset,
} from "./presets";
import { expandRectToAspect } from "./geometry";
import type { Rect } from "./types";

/**
 * 选区 → 预设匹配（纯函数，Node 可单测）。
 *
 * 三种尺寸模式：
 * - auto：按选区方向过滤候选，取宽高比最接近的已验证预设；比例并列时取面积
 *   最接近选区的；
 * - fixed：用户指定预设 id（未验证预设仅此模式允许，并给出 warning）；
 * - custom：不使用预设，沿用旧的「宽高独立对齐 32」路径（preset 为 null）。
 */
export type SizeMode = "auto" | "fixed" | "custom";

export const DEFAULT_SIZE_MODE: SizeMode = "auto";

/** 接近方形的判定：宽高比落在 [1/1.12, 1.12] 内。 */
export const NEAR_SQUARE_RATIO = 1.12;

/** 上采样倍数过大（面积比 ≥ 4）时提示，但仍按预设执行。 */
export const UPSAMPLE_WARN_AREA_RATIO = 4;

/** 比例并列的判定阈值（log 比值，远小于任何实际差异）。 */
const TIE_EPSILON = 1e-6;

export interface PresetFitResult {
  /** custom 模式为 null（走 32 对齐兜底路径）。 */
  preset: SizePreset | null;
  warnings: string[];
}

export const normalizeSizeMode = (value: unknown): SizeMode =>
  value === "auto" || value === "fixed" || value === "custom"
    ? value
    : DEFAULT_SIZE_MODE;

/** 选择失败时返回默认预设（仅用于固定模式的旧配置兜底，UI 层仍会提示）。 */
export const normalizePresetId = (value: unknown): string => {
  const id = typeof value === "string" ? value : "";
  return getPresetById(id) ? id : DEFAULT_PRESET_ID;
};

/** 按选区方向返回允许的预设方向。 */
export const allowedOrientations = (selW: number, selH: number): Orientation[] => {
  const aspect = selW / selH;
  if (aspect > NEAR_SQUARE_RATIO) return ["landscape"];
  if (aspect < 1 / NEAR_SQUARE_RATIO) return ["portrait"];
  // 接近方形：方形与竖向都允许（方形比例最接近时会自然胜出）
  return ["square", "portrait"];
};

const aspectDiff = (selW: number, selH: number, preset: SizePreset): number =>
  Math.abs(Math.log((selW / selH) / (preset.width / preset.height)));

const areaDiff = (selW: number, selH: number, preset: SizePreset): number =>
  Math.abs(Math.log((preset.width * preset.height) / (selW * selH)));

/** 在候选里选宽高比最接近的；并列时选面积最接近选区的。 */
export const pickClosestPreset = (
  selW: number,
  selH: number,
  candidates: readonly SizePreset[],
): SizePreset | null => {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestAspect = aspectDiff(selW, selH, best);
  let bestArea = areaDiff(selW, selH, best);
  for (let i = 1; i < candidates.length; i++) {
    const preset = candidates[i];
    const d = aspectDiff(selW, selH, preset);
    const a = areaDiff(selW, selH, preset);
    if (d < bestAspect - TIE_EPSILON) {
      best = preset;
      bestAspect = d;
      bestArea = a;
    } else if (Math.abs(d - bestAspect) <= TIE_EPSILON && a < bestArea) {
      best = preset;
      bestAspect = d;
      bestArea = a;
    }
  }
  return best;
};

/**
 * 选区 → 预设。custom 模式返回 null；fixed 模式按 id 取预设（未知 id 抛错）；
 * auto 模式只在已验证预设里挑（未验证预设实测返回其他尺寸，默认排除）。
 */
export const fitPreset = (
  selW: number,
  selH: number,
  mode: SizeMode = DEFAULT_SIZE_MODE,
  fixedPresetId?: string,
): PresetFitResult => {
  if (selW <= 0 || selH <= 0) throw new Error("选区尺寸非法");
  if (mode === "custom") return { preset: null, warnings: [] };

  const warnings: string[] = [];
  let preset: SizePreset | null;

  if (mode === "fixed") {
    const id = fixedPresetId?.trim() || DEFAULT_PRESET_ID;
    const found = getPresetById(id);
    if (!found) {
      throw new Error(`未知的尺寸预设：${id}，请在设置中重新选择`);
    }
    if (!found.verified) {
      warnings.push(
        `预设 ${found.id} 未经实测验证（${found.note ?? "应用可能返回其他尺寸"}），结果可能按实际尺寸贴回`,
      );
    }
    preset = found;
  } else {
    const orientations = allowedOrientations(selW, selH);
    const candidates = VERIFIED_PRESETS.filter((p) =>
      orientations.includes(p.orientation),
    );
    preset = pickClosestPreset(
      selW,
      selH,
      candidates.length > 0 ? candidates : VERIFIED_PRESETS,
    );
  }

  if (preset) {
    const areaRatio = (preset.width * preset.height) / (selW * selH);
    if (areaRatio >= UPSAMPLE_WARN_AREA_RATIO) {
      warnings.push(
        `选区 ${selW}×${selH} 远小于预设 ${preset.id}，将被放大约 ${Math.sqrt(areaRatio).toFixed(1)} 倍，细节可能偏软（仍按预设执行）`,
      );
    }
  }

  return { preset, warnings };
};

/* ---------------- Siliconed patch 路径的蒙版短边约束 ----------------
 *
 * Siliconed 移除工作流按「蒙版 bbox + 内部外扩」裁剪送图后局部生成，并要求
 * 裁剪块 32 对齐后的短边 ≥ 448px（拒单原文：its short side under the patch
 * path's 448 px floor）。极扁/极窄的选区（如全宽细条的天空）经过「1.4× 外扩
 * + 预设比例补足 + 缩放到预设尺寸」后，蒙版在发送图里被压成薄带，提交即被拒。
 *
 * 注意：蒙版白区 = 原选区（1.4× 只是外扩黑边），折算按原选区尺寸。
 *
 * 实测（插件队列落盘的失败任务，1344×768 发送图）：
 *   蒙版白区 955×138 → CLI 裁剪 1065×179；
 *   蒙版白区 960×320 → CLI 裁剪 1214×416 → 拒单（416 < 448）。
 * 即 CLI 只在短边方向外扩约 1.3×（0.3 的一侧边距；白区贴到发送图边缘时
 * 另一侧没有余量可扩，此前按 1.7× 估算因此把安全线定低了）。据此：
 * - 蒙版发送短边 ≥ 448 / 1.3 ≈ 345 才可能过 448 门槛；取 384 留出 32 对齐
 *   余量（裁剪 ≈ 499 → 对齐后 480 ≥ 448）；
 * - 352 ~ 384：临界区，给警告；
 * - < 352：裁剪必然 < 448，提交前直接拦截。
 */

/** Siliconed patch 路径的裁剪块短边下限（CLI 拒单原文数值）。 */
export const SILICONED_PATCH_CROP_FLOOR = 448;
/** 蒙版发送短边安全线：≥ 此值裁剪块稳过 patch 下限。 */
export const SILICONED_MASK_SAFE_SHORT = 384;
/** 蒙版发送短边拦截线：低于此值在捕获阶段直接报错。 */
export const SILICONED_MASK_BLOCK_SHORT = 352;

/**
 * 估算「蒙版 bbox 在发送图中的短边」（纯函数，可 Node 单测）。
 *
 * 蒙版白区 = 原选区。预设路径按「扩展区域 → 预设精确尺寸」的等比缩放折算；
 * custom 路径发送尺寸 = 扩展区域尺寸（蒙版 1:1），短边即选区短边。
 * CLI 只会在该 bbox 基础上再外扩，因此该值是裁剪块短边的保守下界。
 */
export const maskSendShortSide = (
  selW: number,
  selH: number,
  canvasW: number,
  canvasH: number,
  expandFactor: number,
  preset: SizePreset | null,
): number => {
  if (selW <= 0 || selH <= 0) throw new Error("选区尺寸非法");
  if (!preset) return Math.min(selW, selH);
  // 只用扩展后的宽高做折算；选区摆在原点不影响扩展尺寸（平移/补边不改宽高）
  const expanded = expandRectToAspect(
    { left: 0, top: 0, right: selW, bottom: selH },
    canvasW,
    canvasH,
    preset.width,
    preset.height,
    expandFactor,
  );
  return Math.min(
    (selW * preset.width) / expanded.width,
    (selH * preset.height) / expanded.height,
  );
};

/**
 * Siliconed 蒙版工作流的预设匹配：常规匹配之上叠加「蒙版发送短边 ≥
 * SILICONED_MASK_SAFE_SHORT」约束——常规胜出预设不达标时在达标候选里重选
 * 比例最接近的；全部不达标时保留常规选择并追加 warning（极端狭长选区无法
 * 靠换档解决，由捕获层给出拦截/警告）。fixed / custom 不换档，原样返回。
 */
export const fitPresetWithMaskFloor = (
  selW: number,
  selH: number,
  canvasW: number,
  canvasH: number,
  expandFactor: number,
  mode: SizeMode = DEFAULT_SIZE_MODE,
  fixedPresetId?: string,
): PresetFitResult => {
  const fit = fitPreset(selW, selH, mode, fixedPresetId);
  if (mode !== "auto" || !fit.preset) return fit;

  const bandOf = (p: SizePreset) =>
    maskSendShortSide(selW, selH, canvasW, canvasH, expandFactor, p);
  const best = fit.preset;
  if (bandOf(best) >= SILICONED_MASK_SAFE_SHORT) return fit;

  // 与 fitPreset auto 分支同源的候选池
  const orientations = allowedOrientations(selW, selH);
  const pool = VERIFIED_PRESETS.filter((p) => orientations.includes(p.orientation));
  const candidates = pool.length > 0 ? pool : VERIFIED_PRESETS;
  const passing = candidates.filter(
    (p) => bandOf(p) >= SILICONED_MASK_SAFE_SHORT,
  );
  if (passing.length === 0) {
    fit.warnings.push(
      `选区较为狭长：所有候选预设下蒙版发送短边最大约 ${Math.round(
        Math.max(...candidates.map(bandOf)),
      )}px（< ${SILICONED_MASK_SAFE_SHORT}px），Siliconed patch 路径有拒单风险；必要时请扩大选区短边`,
    );
    return fit;
  }
  const alt = pickClosestPreset(selW, selH, passing);
  if (alt && alt.id !== best.id) {
    fit.warnings.push(
      `预设 ${best.id} 下蒙版发送短边约 ${Math.round(bandOf(best))}px，不满足 Siliconed patch 安全线；已改用 ${alt.id}（约 ${Math.round(bandOf(alt))}px）`,
    );
    fit.preset = alt;
  }
  return fit;
};

export interface MaskShortSidePadResult {
  /** 补全后的选区（长边不变，短边居中扩展；越界时在画布内平移）。 */
  rect: Rect;
  /** 是否真的发生了补全（短边变长）。 */
  padded: boolean;
  /** 补全前 / 后的蒙版发送短边（px，四舍五入）。 */
  before: number;
  after: number;
  /** 补全后的选区短边（native px）。 */
  shortSide: number;
}

const clampCenterStart = (
  start: number,
  end: number,
  targetSize: number,
  limit: number,
): number =>
  Math.max(0, Math.min(Math.round((start + end - targetSize) / 2), limit - targetSize));

/**
 * 选区短边自动补全（纯函数，可 Node 单测）。
 *
 * 蒙版发送短边不足 SILICONED_MASK_SAFE_SHORT 时，沿选区短边方向居中扩展
 * （长边保持原样），使补全后的蒙版短边达标——用于替代「直接报错拒单」。
 * - 预设路径：最多补到与预设同比例（再补会反向压低短边），并受画布短边限制；
 * - custom 路径：蒙版 1:1，直接要求两条边都补到安全线。
 * 画布空间不足时补到能补的最大值并如实返回（after 仍可能低于安全线）。
 */
export const padSelectionForMaskFloor = (
  sel: Rect,
  canvasW: number,
  canvasH: number,
  expandFactor: number,
  preset: SizePreset | null,
): MaskShortSidePadResult => {
  const selW = sel.right - sel.left;
  const selH = sel.bottom - sel.top;
  if (selW <= 0 || selH <= 0) throw new Error("选区尺寸非法");
  const bandAt = (w: number, h: number) =>
    maskSendShortSide(w, h, canvasW, canvasH, expandFactor, preset);
  const before = Math.round(bandAt(selW, selH));
  if (before >= SILICONED_MASK_SAFE_SHORT) {
    return {
      rect: { ...sel },
      padded: false,
      before,
      after: before,
      shortSide: Math.min(selW, selH),
    };
  }

  if (!preset) {
    // custom：发送尺寸 = 扩展区域尺寸，两条边都要 ≥ 安全线
    const targetW = Math.min(canvasW, Math.max(selW, SILICONED_MASK_SAFE_SHORT));
    const targetH = Math.min(canvasH, Math.max(selH, SILICONED_MASK_SAFE_SHORT));
    const left = clampCenterStart(sel.left, sel.right, targetW, canvasW);
    const top = clampCenterStart(sel.top, sel.bottom, targetH, canvasH);
    return {
      rect: { left, top, right: left + targetW, bottom: top + targetH },
      padded: targetW > selW || targetH > selH,
      before,
      after: Math.min(targetW, targetH),
      shortSide: Math.min(targetW, targetH),
    };
  }

  const horizontalShort = selW <= selH;
  const short0 = horizontalShort ? selW : selH;
  const long = horizontalShort ? selH : selW;
  const canvasShort = horizontalShort ? canvasW : canvasH;
  const ratio = preset.width / preset.height;
  // 补到与预设同比例时蒙版短边最大（= min(预设宽高) / 外扩倍数）
  const aspectCap = Math.floor(horizontalShort ? long * ratio : long / ratio);
  const maxShort = Math.min(canvasShort, Math.max(short0, Math.min(long, aspectCap)));
  if (maxShort <= short0) {
    return {
      rect: { ...sel },
      padded: false,
      before,
      after: before,
      shortSide: short0,
    };
  }

  const bandWithShort = (shortSide: number) =>
    horizontalShort
      ? bandAt(shortSide, selH)
      : bandAt(selW, shortSide);
  let chosen = maxShort;
  if (bandWithShort(maxShort) >= SILICONED_MASK_SAFE_SHORT) {
    // 达标前 band 随短边单调不降，二分找最小达标值，尽量少改用户选区
    let lo = short0 + 1;
    let hi = maxShort;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (bandWithShort(mid) >= SILICONED_MASK_SAFE_SHORT) hi = mid;
      else lo = mid + 1;
    }
    chosen = lo;
  }

  const start = horizontalShort
    ? clampCenterStart(sel.left, sel.right, chosen, canvasW)
    : clampCenterStart(sel.top, sel.bottom, chosen, canvasH);
  const rect: Rect = horizontalShort
    ? { left: start, top: sel.top, right: start + chosen, bottom: sel.bottom }
    : { left: sel.left, top: start, right: sel.right, bottom: start + chosen };
  return {
    rect,
    padded: chosen > short0,
    before,
    after: Math.round(bandWithShort(chosen)),
    shortSide: chosen,
  };
};
