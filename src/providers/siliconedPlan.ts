/**
 * Siliconed 请求的纯计算部分（不触碰宿主 API，便于单测）：
 * 尺寸规划、提示词转义、add 参数拼装。
 *
 * Siliconed / silicontrol 的硬约束（help add）：
 * - 每边 ≥ 512、为 32 的倍数（qwen-image-2.1）、≤ 8192；
 * - 插件侧再按 1MP 上限收敛（与 catalog 的 maxPixels 一致），避免编辑区过大。
 */

export const SILICONED_ALIGN = 32;
export const SILICONED_MIN_SIDE = 512;
export const SILICONED_MAX_PIXELS = 1048576;

export interface PlannedSize {
  width: number;
  height: number;
}

const alignUp = (value: number): number =>
  Math.ceil(value / SILICONED_ALIGN) * SILICONED_ALIGN;
const alignDown = (value: number): number =>
  Math.floor(value / SILICONED_ALIGN) * SILICONED_ALIGN;

/**
 * 把捕获区域规划成 Siliconed 可接受的 WxH：
 * - 小选区放大到每边 ≥ 512（贴回时缩回，质量优于让模型直接处理 32px 小图）；
 * - 大选区按 1MP 缩小（贴回时放大）；
 * - 保持宽高比，结果按 32 对齐。
 * 宽高比过于极端（放大后总像素必然超 1MP）时直接报错，交由用户扩大选区。
 */
export const planSiliconedSize = (
  width: number,
  height: number,
  minSide = SILICONED_MIN_SIDE,
  maxPixels = SILICONED_MAX_PIXELS,
): PlannedSize => {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!(w > 0) || !(h > 0)) throw new Error("选区尺寸非法");

  const minSideScale = minSide / Math.min(w, h);
  const maxAreaScale = Math.sqrt(maxPixels / (w * h));

  let scale: number;
  if (minSideScale > 1) {
    if (minSideScale > maxAreaScale) {
      throw new Error(
        `选区宽高比过于极端（${w}×${h}），Siliconed 要求每边 ≥${minSide} 且总像素 ≤${maxPixels}，请扩大选区`,
      );
    }
    scale = minSideScale;
  } else {
    scale = Math.min(1, maxAreaScale);
  }

  const round = scale >= 1 ? alignUp : alignDown;
  let outW = Math.max(SILICONED_ALIGN, round(w * scale));
  let outH = Math.max(SILICONED_ALIGN, round(h * scale));

  // 对齐后可能跌破单边下限或超出面积上限，做一次收敛
  if (outW < minSide) outW = alignUp(minSide);
  if (outH < minSide) outH = alignUp(minSide);
  while (outW * outH > maxPixels) {
    if (outW >= outH && outW - SILICONED_ALIGN >= minSide) {
      outW -= SILICONED_ALIGN;
    } else if (outH - SILICONED_ALIGN >= minSide) {
      outH -= SILICONED_ALIGN;
    } else {
      break;
    }
  }
  if (outW * outH > maxPixels) {
    throw new Error("选区尺寸无法满足 Siliconed 的像素上限");
  }
  if (outW < minSide || outH < minSide) {
    throw new Error(`选区尺寸无法满足 Siliconed 的 ${minSide} 最小边`);
  }
  return { width: outW, height: outH };
};

/** 提示词里的 {a|b} 会被 Siliconed 解释成多个任务；转义成普通字符，保证单任务。 */
export const escapeSiliconPrompt = (prompt: string): string =>
  prompt.replace(/[{}|]/g, (ch) => `\\${ch}`);

/** Siliconed 留空时的默认移除文案（绿区由应用内部染色，插件只负责提示词）。 */
export const SILICONED_DEFAULT_PROMPT = "移除图像中的绿色区域";

/**
 * 识别 Siliconed patch 路径的「蒙版裁剪短边不足」拒单，翻译为可操作的提示。
 *
 * CLI 拒单原文形如：the crop 1344×334 renders at 1344×320, its short side
 * under the patch path's 448 px floor ... widen the mask or use a less
 * elongated crop。命中时返回中文指引，未命中返回 null（原错误原样上抛）。
 */
export const describeSiliconPatchRejection = (
  message: string,
): string | null => {
  if (!/448 px floor|less elongated/i.test(message)) return null;
  const m = message.match(/the crop (\d+)[x×](\d+) renders at (\d+)[x×](\d+)/i);
  if (!m) {
    return "蒙版区域短边不足 448px：请扩大选区，或避免细长选区";
  }
  const cropW = Number(m[1]);
  const cropH = Number(m[2]);
  const short = Math.min(cropW, cropH);
  return `蒙版区域短边 ${short}px（${cropW}×${cropH}）不足 448px：请扩大选区，或避免细长选区`;
};

/**
 * Siliconed 的两种蒙版分支：
 * - remove：蒙版区涂绿 + remove LoRA（提示词可留空，CLI 自动处理绿区）；
 * - redraw：不染色 + redraw LoRA（提示词必填）。
 */
export type SiliconMode = "remove" | "redraw";
/** 主面板的选择：auto 按提示词自动判定，其余为手动覆盖。 */
export type SiliconModeChoice = "auto" | "remove" | "redraw";

/** 产出新内容的标记：命中的句式即使带「移除」也必须走 redraw。 */
const REPLACE_MARKERS =
  /替换|换成|换为|换作|改为|改成|改作|变为|变成|化作|画成|生成|添加|加入|增加|加上|铺上|涂成|涂上|覆盖成|填充成|填充为|replace|change|turn|convert|add|draw|paint/i;
/** 纯擦除 / 补全背景的标记。 */
const REMOVE_MARKERS =
  /移除|去掉|去除|删除|删掉|擦除|抹掉|抹去|消除|抠掉|清理|清掉|拿掉|干掉|remove|erase|delete|eliminate|wipe/i;

/**
 * 按提示词判定分支（不做语义理解，只区分「是否要产出新内容」）：
 * - 空 → remove（留空 = 擦除选区）；
 * - 含替换 / 生成标记 → redraw（优先于移除词，覆盖「移除 xx 并替换成 yy」）；
 * - 只含擦除词 → remove（覆盖「移除 xx，并补全背景」）；
 * - 其余描述性提示词 → redraw。
 */
export const detectSiliconMode = (prompt: string): SiliconMode => {
  const text = prompt.trim();
  if (!text) return "remove";
  if (REPLACE_MARKERS.test(text)) return "redraw";
  if (REMOVE_MARKERS.test(text)) return "remove";
  return "redraw";
};

/**
 * Siliconed 的最终分支与提示词：choice 优先，auto 时按 detectSiliconMode 判定。
 * remove 分支必须带「移除」指令（CLI 只在完全不传提示词时自动补），因此
 * 用户留空 / 只配了后缀时补上默认移除文案。
 */
export const resolveSiliconMode = (
  prompt: string,
  suffix: string,
  choice: SiliconModeChoice = "auto",
): { mode: SiliconMode; prompt: string } => {
  const mode = choice === "auto" ? detectSiliconMode(prompt) : choice;
  const user = prompt.trim();
  const head = mode === "remove" ? user || SILICONED_DEFAULT_PROMPT : user;
  const parts = [head, suffix.trim()].filter(Boolean);
  return { mode, prompt: parts.join("\n") };
};

export interface BuildAddArgsInput {
  /** 待编辑图（与 mask 逐像素同尺寸）。 */
  imagePath: string;
  /** 白=要移除、黑=保留的蒙版 PNG（与 image 同尺寸）。 */
  maskPath: string;
  mode: SiliconMode;
  prompt: string;
  seed: number;
}

/**
 * silicontrol add 参数（mask 工作流）：
 * - 用 `--image + --mask`，不再使用 `--ref`（两者同时传会被 CLI 拒绝）；
 * - `--mode` 由调用方按提示词意图传入 remove / redraw；
 * - 不传 `--steps`：走 mask 工作流默认的 9 步；
 * - 不传显式尺寸 / `--strength` / `--grid`：带 mask 时 CLI 会拒绝，裁剪框由蒙版决定。
 */
export const buildSiliconAddArgs = (input: BuildAddArgsInput): string[] => [
  "add",
  "--model",
  "qwen-image-2.1",
  "--image",
  input.imagePath,
  "--mask",
  input.maskPath,
  "--mode",
  input.mode,
  escapeSiliconPrompt(input.prompt),
  String(input.seed),
];
