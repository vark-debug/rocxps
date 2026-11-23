import { photoshop } from "../globals";
import {
  expandRectToAspect,
  expandRectToMultiple,
  padAmountsOf,
  readSelection,
} from "./selection";
import { encodePng } from "./pngEncoder";
import { CAPTURE_ALIGN } from "./align";
import { resizeGray, resizeRgba } from "./resize";
import {
  MAX_TILE_PIXELS,
  blitTileInto,
  extendRgbaToRegion,
  planTiles,
  toRgba,
} from "./tileRead";
import type { PadAmounts } from "./geometry";
import type { Rect, ExpandedRegion } from "./types";
import {
  DEFAULT_SIZE_MODE,
  fitPreset,
  fitPresetWithMaskFloor,
  maskSendShortSide,
  padSelectionForMaskFloor,
  SILICONED_MASK_BLOCK_SHORT,
  SILICONED_MASK_SAFE_SHORT,
  SILICONED_PATCH_CROP_FLOOR,
  type SizeMode,
} from "./presetFit";
import {
  assertPresetSendSize,
  type SizePreset,
} from "./presets";
import type { Document } from "photoshop/dom/Document";
import type { ActionDescriptor } from "photoshop/dom/CoreModules";

/**
 * 选区捕获管线（docs/local-redraw-plan.md §2.1 / M1）。
 *
 * 双路径架构（对齐参考项目 ps-local-edit）：
 * - 路径 A（首选）：imaging.getPixels 直接读取文档合成像素，零宿主命令——
 *   全不透明时整个捕获不执行任何 PS 命令，结构上不可能触发 -25920 一类
 *   「命令当前不可用」错误。
 * - 路径 B（回退）：内容含透明像素 / 非 RGB 模式 / 直读异常时，走参考项目
 *   captureSelectionAsBase64PNG 同款纯 DOM 临时文档管线（DOM selectRectangle、
 *   DOM copy(true) 合并拷贝、临时文档粘贴后本地 PNG 编码）。
 *   modal 内 batchPlay（synchronousExecution:false）会延迟执行导致命令状态错乱，
 *   参考项目因此全程改用 DOM API；本模块仅在 PS < 25（无 DOM selectRectangle）
 *   时以 sync:true 的 batchPlay 兜底设置选区。
 *
 * 分块读取：imaging.getPixels / imageData.getData() 单次大缓冲（数十 MB 量级）
 * 会抛 "Invalid array length"（8000×2000 RGBA 实测必现，蒙版 16MB 正常）。
 * 官方文档未给出单次像素/字节上限，故按 MAX_TILE_PIXELS 水平条带分块读取，
 * 逐块 dispose 后拼接为整块 RGBA，再只编码一次 PNG。
 *
 * 蒙版：imaging.getSelection 在改动选区之前读取，读取后立即复制数据并 dispose
 * （Photoshop 只保留 1-2 个 imageData 槽位，蒙版占位会让后续 getPixels 永久等待）；
 * getSelection 会把 sourceBounds 收紧到含数据的区域，需零填充补边回请求尺寸。
 *
 * 不走文件系统（getTempFolder 在当前宿主被权限剥离），PNG 编码本地完成。
 */

const TEMP_DOC_NAME = "rocxps-capture-tmp";

export interface MaskData {
  width: number;
  height: number;
  /** 蒙版像素（已归一化为 8 位灰度，M3 贴回时解释）。 */
  data: Uint8Array;
}

export interface CaptureResult {
  docId: number;
  docName: string;
  /** 捕获时的文档路径（未保存 / 云文档可能为空或标识符），关闭重开后用于次级匹配。 */
  docPath: string;
  /** 捕获时的画布尺寸，关闭重开后与路径一起用于唯一匹配。 */
  canvasWidth: number;
  canvasHeight: number;
  /** 原选区外接矩形。 */
  originalBounds: Rect;
  /** 抓取区域（原生画布坐标，可能含补边；贴回按它的尺寸缩放）。 */
  expanded: ExpandedRegion;
  /** 本次尺寸模式。 */
  sizeMode: SizeMode;
  /** 命中的预设；custom 模式为 null。 */
  preset: SizePreset | null;
  /** 送图宽高（预设模式严格等于 preset.width/height；custom 等于 expanded 尺寸）。 */
  sendWidth: number;
  sendHeight: number;
  /** 合并像素 PNG（base64，无 data: 前缀；预设模式下已缩放到 sendWidth×sendHeight）。 */
  pngBase64: string;
  /** 扩展区域（原生尺寸）内的原选区蒙版，贴回时使用。 */
  mask: MaskData;
  /** 送图尺寸的蒙版（与 pngBase64 同几何，供 IOPaint 等要求同尺寸的平台使用）。 */
  sendMask: MaskData;
  /**
   * 黑白通道图 PNG（base64，无 data: 前缀）：白色 = 选区内（待重绘），
   * 黑色 = 选区外（保留）。与 pngBase64 同尺寸，随生成请求一起发送。
   */
  maskPngBase64: string;
  /** 抓取矩形（= expanded.bounds），用于历史记录排查。 */
  captureRect: Rect;
  /** 相对原选区的实际外扩量（画布内平移后左右/上下可能不对称）。 */
  padAmounts: PadAmounts;
  /** 尺寸规划警告（上采样倍数过大 / 未验证预设等），不影响执行。 */
  sizeWarnings: string[];
  /** 本次选区外扩系数（1 = 未外扩；Siliconed 固定 1.4）。 */
  selectionExpand: number;
  /** 选区短边自动补全记录（仅 Siliconed patch 路径且实际补全时出现）。 */
  maskAutoPad?: {
    /** 补全前 / 后的选区短边（native px）。 */
    fromShort: number;
    toShort: number;
    /** 补全前 / 后的蒙版发送短边（px）。 */
    bandBefore: number;
    bandAfter: number;
  };
}

/** 捕获选项：尺寸规划模式与固定预设（缺省 auto + 自动匹配）。 */
export interface CaptureOptions {
  sizeMode?: SizeMode;
  fixedPresetId?: string;
  /** 选区外扩系数（仅 Siliconed 传 1.4；其他平台不传，取景行为不变）。 */
  expandFactor?: number;
  /**
   * Siliconed patch 路径约束：按「蒙版 bbox 发送短边」校验预设与选区。
   * 短边不足安全线时自动补全选区短边（补到画布能容纳的最大值）；
   * 补全后仍低于拦截线才抛错。
   */
  maskPatchFloor?: boolean;
}

/** DOM 属性可能返回 UnitValue 包装对象（{_value, _unit}），统一取数值。 */
export const toPx = (value: unknown): number => {
  const raw =
    value && typeof value === "object" && "_value" in (value as { _value?: unknown })
      ? (value as { _value: unknown })._value
      : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/** 文档路径：未保存文档 / 云文档可能为空或抛错，统一退化为空串。 */
export const readDocPath = (doc: Document): string => {
  try {
    const path = doc.path;
    return typeof path === "string" ? path : "";
  } catch {
    return "";
  }
};

const appVersion = (): string => {
  try {
    const v = (photoshop.app as { version?: unknown }).version;
    return typeof v === "string" && v ? v : "未知版本";
  } catch {
    return "未知版本";
  }
};

/** 为每一步包裹步骤名，失败时横幅可直接定位到具体环节（附 PS 版本便于排障）。 */
const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[捕获:${name}] ${msg}（PS ${appVersion()}）`);
  }
};

/** modal 内 batchPlay 必须同步执行（sync:false 会延迟执行，是 -25920 的根因之一）。 */
const syncBpOptions = {
  synchronousExecution: true,
  dialogOptions: "dontDisplay",
} as const;

/**
 * batchPlay 在部分失败场景不抛异常，而是把 {_obj:"error"} 放进返回数组
 * （实测：make 文档参数非法时返回 result:-1715）。逐条检查并转为异常。
 */
const assertNoError = (
  results: readonly unknown[] | undefined,
  name: string,
) => {
  for (const r of results ?? []) {
    if (r && typeof r === "object" && (r as { _obj?: string })._obj === "error") {
      const { message, result } = r as { message?: string; result?: number };
      throw new Error(
        `${name} 失败：${message ?? "未知错误"}${result !== undefined ? `（代码 ${result}）` : ""}`,
      );
    }
  }
};

/** batchPlay：把选区设为矩形（仅 PS < 25 无 DOM selectRectangle 时的回退路径）。 */
const selectRectDesc = (b: Rect): ActionDescriptor => ({
  _obj: "set",
  _target: [{ _ref: "channel", _enum: "channel", _value: "selection" }],
  to: {
    _obj: "rectangle",
    top: { _unit: "pixelsUnit", _value: b.top },
    left: { _unit: "pixelsUnit", _value: b.left },
    bottom: { _unit: "pixelsUnit", _value: b.bottom },
    right: { _unit: "pixelsUnit", _value: b.right },
  },
  // 命令启用性检查在 PS 主窗口失焦时可能拒绝 set（如浮窗获得焦点），
  // 强制执行避免「命令“设置”当前不可用」原生错误框。
  _options: { dialogOptions: "dontDisplay", commandEnablement: "always" },
});

/**
 * Uint8Array → base64（无 data: 前缀）。
 * 分块 btoa：单块 1MB（且为 3 的倍数，保证各块 base64 可直接拼接），
 * 避免对数十 MB 字符串一次性 btoa / 一次性构造数百 MB 的 binary 中间串。
 */
const BASE64_CHUNK = 1_048_575; // 3 的倍数：349525 × 3

export const uint8ToBase64 = (bytes: Uint8Array): string => {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    const slice = bytes.subarray(
      offset,
      Math.min(offset + BASE64_CHUNK, bytes.length),
    );
    // String.fromCharCode 参数过大会爆栈：每片 8192 字节再拼 binary
    const codes: string[] = [];
    for (let i = 0; i < slice.length; i += 0x2000) {
      codes.push(String.fromCharCode(...slice.subarray(i, i + 0x2000)));
    }
    parts.push(btoa(codes.join("")));
  }
  return parts.join("");
};

/**
 * 蒙版 → 黑白通道图 PNG base64：灰度值复制到 RGB 三通道（alpha=255），
 * 复用现有 RGBA 编码器，保证与内容图同一种 PNG 形态，避免 API 端解码差异。
 * 白 = 选区内（待重绘），黑 = 选区外（保留）；羽化选区边缘为过渡灰度。
 */
const encodeMaskPngBase64 = (mask: MaskData): string => {
  const { width, height, data } = mask;
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, s = 0; p < rgba.length; p += 4, s++) {
    const v = data[s];
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
  return uint8ToBase64(encodePng(width, height, rgba));
};

/** 虚拟区域与画布的交集（补边模式下 bounds 可能为负/超出画布）。 */
const clipToCanvas = (bounds: Rect, canvasW: number, canvasH: number): Rect => ({
  left: Math.max(0, bounds.left),
  top: Math.max(0, bounds.top),
  right: Math.min(canvasW, bounds.right),
  bottom: Math.min(canvasH, bounds.bottom),
});

/**
 * 把画布内的蒙版按「边缘像素延展」扩到虚拟区域尺寸。
 * 补边区在实际贴回时会被裁掉，延展只为让生成请求的蒙版与图像同尺寸。
 */
const extendMaskToRegion = (
  mask: MaskData,
  width: number,
  height: number,
  offX: number,
  offY: number,
): MaskData => {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(Math.max(y - offY, 0), mask.height - 1);
    for (let x = 0; x < width; x++) {
      const sx = Math.min(Math.max(x - offX, 0), mask.width - 1);
      out[y * width + x] = mask.data[sy * mask.width + sx];
    }
  }
  return { width, height, data: out };
};

/** 清理历史失败运行残留的孤儿临时文档（自愈，失败不阻塞主流程）。 */
const closeOrphanTempDocs = async (): Promise<void> => {
  const docs = photoshop.app.documents;
  for (let i = docs.length - 1; i >= 0; i--) {
    try {
      if (docs[i].name === TEMP_DOC_NAME) {
        docs[i].closeWithoutSaving();
      }
    } catch {
      /* 忽略单个清理失败 */
    }
  }
};

/**
 * imaging.getSelection / getPixels 会把 sourceBounds 收紧到含像素数据的区域，
 * 返回尺寸可能小于请求尺寸：零填充目标缓冲，按偏移行级拷贝补边
 * （对齐参考项目 L506-551）。
 */
export const padToSize = (
  data: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  offX: number,
  offY: number,
  components: number,
): Uint8Array => {
  const out = new Uint8Array(dstW * dstH * components);
  for (let y = 0; y < srcH; y++) {
    const dstY = y + offY;
    if (dstY < 0 || dstY >= dstH) continue;
    const copyLen = Math.min(srcW, dstW - offX);
    if (copyLen <= 0) continue;
    out.set(
      data.subarray(y * srcW * components, y * srcW * components + copyLen * components),
      (dstY * dstW + offX) * components,
    );
  }
  return out;
};

/** 任意位深的原始像素归一化为 8 位（16 位右移 8 位，32 位按 0-1 浮点映射）。 */
const normalizeTo8 = (
  src: Uint8Array | Uint16Array | Float32Array,
  componentSize: number,
  count: number,
): Uint8Array => {
  if (componentSize === 16) {
    const u16 = src as Uint16Array;
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = u16[i] >> 8;
    return out;
  }
  if (componentSize === 32) {
    const f32 = src as Float32Array;
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const v = Math.round(f32[i] * 255);
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return out;
  }
  return new Uint8Array(src);
};

/**
 * 把 getPixels 返回的原始像素统一为 RGBA：3 通道（RGB，源不含 alpha 通道）
 * 补 alpha=255；4 通道原样返回；其他格式返回 null（调用方走路径 B）。
 * 注意：GetPixelsOptions 没有 components 请求项，返回通道数取决于源。
 */
// 实现在 tileRead.ts（纯函数，可 Node 单测）

export interface TileReadOptions {
  componentSize?: 8;
  colorSpace?: "RGB";
  colorProfile?: string;
  /** 只读取指定图层（超分用）；缺省读文档合成像素。 */
  layerID?: number;
}

/**
 * 分块读取（imaging.getPixels）区域内像素并拼接为整块 RGBA。
 *
 * - 每块 ≤ MAX_TILE_PIXELS（默认 1MP，RGBA 约 4MB），逐块 getPixels → getData →
 *   dispose：既规避单次大缓冲的 "Invalid array length"，也满足 PS 只保留
 *   1-2 个 imageData 槽位的限制；
 * - PS 可能把 sourceBounds 收紧到含像素数据的区域，按实际偏移零填充拼接；
 * - 通道数不是 3/4 → null；requireOpaque 时遇透明像素立即返回 null（走路径 B）。
 */
export const readRegionRgbaTiled = async (
  docId: number,
  bounds: Rect,
  options: TileReadOptions,
  requireOpaque: boolean,
): Promise<Uint8Array | null> => {
  const imaging = photoshop.imaging;
  if (!imaging?.getPixels) return null;

  const dstW = bounds.right - bounds.left;
  const dstH = bounds.bottom - bounds.top;
  const dst = new Uint8Array(dstW * dstH * 4);

  for (const tile of planTiles(bounds, MAX_TILE_PIXELS)) {
    const pixels = await step("读取像素", () =>
      imaging.getPixels({
        documentID: docId,
        sourceBounds: {
          left: tile.left,
          top: tile.top,
          right: tile.right,
          bottom: tile.bottom,
        },
        ...options,
      }),
    );
    const img = pixels.imageData;
    try {
      if (img.componentSize !== 8) return null;
      const sb = pixels.sourceBounds;
      // 收紧到空区域（整块透明/画布外）时直接跳过，保持目标缓冲的 0
      if (sb.right <= sb.left || sb.bottom <= sb.top) continue;
      const data = new Uint8Array(
        await step("读取分块像素数据", () => img.getData({ chunky: true })),
      );
      const rgba = toRgba(data, img.width, img.height);
      if (!rgba) return null;
      if (requireOpaque) {
        for (let i = 3; i < rgba.length; i += 4) {
          if (rgba[i] < 255) return null;
        }
      }
      blitTileInto(
        dst,
        dstW,
        dstH,
        rgba,
        img.width,
        img.height,
        sb.left - bounds.left,
        sb.top - bounds.top,
      );
    } finally {
      img.dispose();
    }
  }
  return dst;
};

/** 蒙版捕获：必须在改动选区之前调用；内部复制数据后立即 dispose 释放 imageData 槽位。 */
const captureMask = async (doc: Document, bounds: Rect): Promise<MaskData> => {
  if (!photoshop.imaging?.getSelection) {
    throw new Error("imaging.getSelection 不可用（需要 Photoshop 24.4+）");
  }
  const maskResult = await photoshop.imaging.getSelection({
    documentID: doc.id,
    sourceBounds: {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
    },
  });
  const img = maskResult.imageData;
  try {
    const sb = maskResult.sourceBounds;
    const srcW = sb.right - sb.left;
    const srcH = sb.bottom - sb.top;
    const dstW = bounds.right - bounds.left;
    const dstH = bounds.bottom - bounds.top;
    const offX = sb.left - bounds.left;
    const offY = sb.top - bounds.top;
    const normalized = normalizeTo8(
      await img.getData({ chunky: true }),
      img.componentSize,
      srcW * srcH,
    );
    const data =
      srcW !== dstW || srcH !== dstH
        ? padToSize(normalized, srcW, srcH, dstW, dstH, offX, offY, 1)
        : normalized;
    return { width: dstW, height: dstH, data };
  } finally {
    img.dispose();
  }
};

/** 位深 / 宽色域归一化参数：图层读数、文档合成读数共用（非 RGB 返回 null）。 */
const pixelReadOptions = (
  doc: Document,
): { componentSize?: 8; colorSpace?: "RGB"; colorProfile?: string } | null => {
  if (doc.mode !== photoshop.constants.DocumentMode.RGB) return null;
  const bitDepth = String(doc.bitsPerChannel);
  let profileName = "";
  try {
    profileName = (doc.colorProfileName || "").toLowerCase();
  } catch {
    /* 无配置文件的文档按普通 sRGB 处理 */
  }
  const isWideGamut =
    profileName.includes("prophoto") ||
    profileName.includes("adobe rgb") ||
    profileName.includes("display p3") ||
    profileName.includes("dci-p3") ||
    profileName.includes("wide gamut");
  return {
    ...(bitDepth.includes("16") || bitDepth.includes("32")
      ? { componentSize: 8 as const }
      : {}),
    ...(isWideGamut
      ? { colorSpace: "RGB" as const, colorProfile: "sRGB IEC61966-2.1" }
      : {}),
  };
};

/**
 * 读取单个图层的像素（超分输入）：位深 / 宽色域归一化规则与合成读数一致；
 * 只接管画布内区域（画布外部分由调用方补透明）。
 */
export const readLayerRgba = async (
  doc: Document,
  layerId: number,
  bounds: Rect,
): Promise<Uint8Array | null> => {
  const imaging = photoshop.imaging;
  if (!imaging?.getPixels) return null;
  const options = pixelReadOptions(doc);
  if (!options) return null;
  return readRegionRgbaTiled(
    doc.id,
    bounds,
    { ...options, layerID: layerId },
    false,
  );
};

/**
 * 读取整个文档的合成像素（智能对象内容文档：100% 的原始像素，不受画布裁剪）。
 */
export const readDocumentRgba = async (
  doc: Document,
  bounds: Rect,
): Promise<Uint8Array | null> => {
  const imaging = photoshop.imaging;
  if (!imaging?.getPixels) return null;
  const options = pixelReadOptions(doc);
  if (!options) return null;
  return readRegionRgbaTiled(doc.id, bounds, options, false);
};

/**
 * 路径 A：直接 imaging.getPixels 读取文档合成像素（零宿主命令）。
 * 全不透明 → 返回整块 RGBA；含透明像素 / 非 RGB / 读取异常 → null（走路径 B）。
 */
const readMergedPixelsDirect = async (
  doc: Document,
  bounds: Rect,
): Promise<Uint8Array | null> => {
  const imaging = photoshop.imaging;
  if (!imaging?.getPixels) return null;

  // 非 RGB（灰度/CMYK/索引等）交由路径 B：临时文档粘贴时统一转 RGB
  if (doc.mode !== photoshop.constants.DocumentMode.RGB) return null;

  // 16/32 位文档强制转 8 位读取；宽色域强制 sRGB（对齐参考项目）
  const bitDepth = String(doc.bitsPerChannel);
  let profileName = "";
  try {
    profileName = (doc.colorProfileName || "").toLowerCase();
  } catch {
    /* 无配置文件的文档按普通 sRGB 处理 */
  }
  const isWideGamut =
    profileName.includes("prophoto") ||
    profileName.includes("adobe rgb") ||
    profileName.includes("display p3") ||
    profileName.includes("dci-p3") ||
    profileName.includes("wide gamut");

  return readRegionRgbaTiled(
    doc.id,
    bounds,
    {
      ...(bitDepth.includes("16") || bitDepth.includes("32")
        ? { componentSize: 8 as const }
        : {}),
      ...(isWideGamut
        ? { colorSpace: "RGB" as const, colorProfile: "sRGB IEC61966-2.1" }
        : {}),
    },
    true,
  );
};

/**
 * 路径 B（回退）：对齐参考项目 captureSelectionAsBase64PNG 的临时文档管线。
 * 主文档阶段 suspendHistory 包裹（技术层/选区改动结束后整体回滚），
 * 临时文档阶段全 DOM。返回整块 RGBA（PNG 编码由调用方统一执行）。
 */
const captureRgbaViaTempDoc = async (
  doc: Document,
  bounds: Rect,
  hostControl: {
    suspendHistory: (params: {
      documentID: number;
      name: string;
    }) => Promise<{ historySuspensionID: number }>;
    resumeHistory: (
      params: { historySuspensionID: number },
      commit?: boolean,
    ) => Promise<void>;
  },
): Promise<Uint8Array> => {
  // 拷贝目标必须在创建技术层之前捕获：技术层创建后位于最上层，
  // 会成为活动层，导致 copy(true) 的合并结果只含技术层像素（参考项目 L696）。
  // copy(true) 实际拷贝全部可见图层合成，载体图层是谁不影响内容。
  const copyTarget = doc.activeLayers?.[0] ?? null;

  const suspension = await hostControl.suspendHistory({
    documentID: doc.id,
    name: "AI 局部重绘：捕获选区",
  });
  try {
    // 1) 选区设为扩展区域：PS 25+ 用 DOM selectRectangle（参考项目同款）；
    //    更早版本回退 batchPlay（modal 内必须 sync:true，sync:false 会延迟执行）
    const canDomSelect = (() => {
      try {
        return typeof doc.selection?.selectRectangle === "function";
      } catch {
        return false;
      }
    })();
    if (canDomSelect) {
      await step("设置选区", () =>
        doc.selection.selectRectangle(
          {
            top: bounds.top,
            left: bounds.left,
            bottom: bounds.bottom,
            right: bounds.right,
          },
          photoshop.constants.SelectionType.REPLACE,
        ),
      );
    } else {
      const results = await step("设置选区", () =>
        photoshop.action.batchPlay([selectRectDesc(bounds)], syncBpOptions),
      );
      assertNoError(results, "设置选区");
    }

    // 2) 技术像素：扩展区域对角写 alpha=1/255 黑像素，
    //    防止合并拷贝把全透明边缘裁掉（ps-local-edit workaround）
    const imaging = photoshop.imaging;
    if (
      !imaging ||
      typeof imaging.putPixels !== "function" ||
      typeof imaging.createImageDataFromBuffer !== "function"
    ) {
      throw new Error("imaging.putPixels 不可用，需要 Photoshop 24.4+");
    }
    const techLayer = await step("创建技术像素层", () =>
      doc.createLayer(photoshop.constants.LayerKind.NORMAL, {
        name: "rocxps-tech-pixels",
      }),
    );
    if (!techLayer) throw new Error("创建技术像素层失败");
    const putPixel = async (x: number, y: number) => {
      const data = await imaging.createImageDataFromBuffer(
        new Uint8Array([0, 0, 0, 1]),
        { width: 1, height: 1, components: 4, colorSpace: "RGB" },
      );
      try {
        await imaging.putPixels({
          layerID: techLayer.id,
          imageData: data,
          replace: false,
          targetBounds: { top: y, left: x, width: 1, height: 1 },
        });
      } finally {
        data.dispose();
      }
    };
    await step("写入技术像素", async () => {
      await putPixel(bounds.left, bounds.top);
      await putPixel(bounds.right - 1, bounds.bottom - 1);
    });

    // 3) DOM 合并拷贝（23.0+；merge=true = 拷贝全部可见图层合成）。
    //    copyTarget 缺失时用技术层兜底。
    const target = copyTarget ?? techLayer;
    await step("合并拷贝", () => target.copy(true));
  } finally {
    // 回滚：选区恢复原状（含非矩形选区的精确形状）、技术层消失。
    // 剪贴板内容不受影响，供下一步粘贴。失败也必须回滚。
    await hostControl
      .resumeHistory({ historySuspensionID: suspension.historySuspensionID }, false)
      .catch(() => {});
  }

  // --- 临时文档阶段（全 DOM，不依赖 batchPlay make） ---
  const tmp = await step("创建临时文档", () =>
    photoshop.app.documents.add({
      name: TEMP_DOC_NAME,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
      resolution: doc.resolution,
      mode: photoshop.constants.NewDocumentMode.RGB,
      fill: photoshop.constants.DocumentFill.TRANSPARENT,
    }),
  );
  if (!tmp) throw new Error("创建临时文档失败");
  if (tmp.id === doc.id) {
    throw new Error("临时文档创建失败（误引用主文档，已中止以保护原文档）");
  }

  try {
    // 4) 粘贴并按图层实际位置对齐到 (0,0)
    //    （合并拷贝裁透明边时粘贴内容会偏移，用 bounds 校正）
    const layer = await step("粘贴", () => tmp.paste());
    if (layer) {
      const left = toPx(layer.bounds.left);
      const top = toPx(layer.bounds.top);
      if (left !== 0 || top !== 0) {
        await step("平移图层", () => layer.translate(-left, -top));
      }
    }
    // 5) 分块读取合成像素为整块 RGBA（本地 PNG 编码在调用方统一执行）
    //    （encodeImageData 仅 JPEG 丢 alpha；文件系统在当前宿主被权限剥离）
    const w = toPx(tmp.width);
    const h = toPx(tmp.height);
    const rgba = await readRegionRgbaTiled(
      tmp.id,
      { left: 0, top: 0, right: w, bottom: h },
      { componentSize: 8 },
      false,
    );
    if (!rgba) throw new Error("临时文档像素格式异常");
    return rgba;
  } finally {
    try {
      tmp.closeWithoutSaving();
    } catch {
      /* 临时文档残留可接受，不遮蔽原始错误 */
    }
    try {
      photoshop.app.activeDocument = doc;
    } catch {
      /* DOM 切换失败不阻塞 */
    }
  }
};

/**
 * 短边自动补全后，把补出来的两条短边带写成蒙版白区（白 = 待生成 / 贴回显示）。
 * 否则蒙版 bbox 仍是原选区，CLI 裁剪出的短边不会跟着变大。
 */
const fillMaskPadBands = (
  mask: MaskData,
  region: Rect,
  sel: Rect,
  padded: Rect,
): MaskData => {
  const bands: Rect[] = [];
  if (padded.left < sel.left) {
    bands.push({ left: padded.left, right: sel.left, top: padded.top, bottom: padded.bottom });
  }
  if (padded.right > sel.right) {
    bands.push({ left: sel.right, right: padded.right, top: padded.top, bottom: padded.bottom });
  }
  if (padded.top < sel.top) {
    bands.push({ left: padded.left, right: padded.right, top: padded.top, bottom: sel.top });
  }
  if (padded.bottom > sel.bottom) {
    bands.push({ left: padded.left, right: padded.right, top: sel.bottom, bottom: padded.bottom });
  }
  for (const band of bands) {
    const left = Math.max(0, band.left - region.left);
    const right = Math.min(mask.width, band.right - region.left);
    const top = Math.max(0, band.top - region.top);
    const bottom = Math.min(mask.height, band.bottom - region.top);
    for (let y = top; y < bottom; y++) {
      mask.data.fill(255, y * mask.width + left, y * mask.width + right);
    }
  }
  return mask;
};

/** 捕获当前选区（含蒙版），返回后续生成与贴回所需的全部数据。 */
export const captureSelection = async (
  options: CaptureOptions = {},
): Promise<CaptureResult> => {
  const sizeMode = options.sizeMode ?? DEFAULT_SIZE_MODE;
  const expandFactor = options.expandFactor ?? 1;
  return photoshop.core.executeAsModal(
    async (executionContext) => {
      // 自愈：先清掉历史失败运行留下的孤儿临时文档，再读主文档
      await closeOrphanTempDocs();
      const doc = photoshop.app.activeDocument;
      if (!doc) throw new Error("请先打开一个文档");

      // 1. 原选区 bounds（改选区前读取）
      const selection = await readSelection();
      if (!selection) throw new Error("请先创建一个选区");
      const sel = selection.bounds;
      const selW = sel.right - sel.left;
      const selH = sel.bottom - sel.top;

      // 2. 尺寸规划：预设模式按目标比例外扩；custom 保持旧的 32 独立对齐。
      //    Siliconed（maskPatchFloor）叠加蒙版短边约束：达标候选里换档 / 警告。
      const fit = options.maskPatchFloor
        ? fitPresetWithMaskFloor(
            selW,
            selH,
            selection.canvasWidth,
            selection.canvasHeight,
            expandFactor,
            sizeMode,
            options.fixedPresetId,
          )
        : fitPreset(selW, selH, sizeMode, options.fixedPresetId);
      const preset = fit.preset;
      const sizeWarnings: string[] = [...fit.warnings];

      // 2.1 选区短边自动补全（Siliconed patch 路径）：蒙版发送短边不足安全线时
      //     沿短边方向扩展选区，而不是直接报错拒单。补出来的区域会一并送模型，
      //     贴回时按扩大后的蒙版显示。
      let effectiveSel = sel;
      let maskAutoPad: CaptureResult["maskAutoPad"];
      if (options.maskPatchFloor) {
        const bandBefore = maskSendShortSide(
          selW,
          selH,
          selection.canvasWidth,
          selection.canvasHeight,
          expandFactor,
          preset,
        );
        if (bandBefore < SILICONED_MASK_SAFE_SHORT) {
          const pad = padSelectionForMaskFloor(
            sel,
            selection.canvasWidth,
            selection.canvasHeight,
            expandFactor,
            preset,
          );
          if (pad.padded) {
            effectiveSel = pad.rect;
            maskAutoPad = {
              fromShort: Math.min(selW, selH),
              toShort: pad.shortSide,
              bandBefore,
              bandAfter: pad.after,
            };
            // 补全后已不狭长，旧的「所有预设都偏窄」提示换成补全说明
            for (let i = sizeWarnings.length - 1; i >= 0; i--) {
              if (sizeWarnings[i].includes("狭长")) sizeWarnings.splice(i, 1);
            }
            sizeWarnings.push(
              `Siliconed：选区短边 ${Math.min(selW, selH)}px 偏窄，已自动补全到 ${pad.shortSide}px` +
                `（蒙版发送短边 ${Math.round(bandBefore)} → ${pad.after}px），生成与贴回范围会略大于原选区`,
            );
          }
        }
      }
      const effW = effectiveSel.right - effectiveSel.left;
      const effH = effectiveSel.bottom - effectiveSel.top;

      const expanded = preset
        ? expandRectToAspect(
            effectiveSel,
            selection.canvasWidth,
            selection.canvasHeight,
            preset.width,
            preset.height,
            expandFactor,
          )
        : expandRectToMultiple(
            effectiveSel,
            selection.canvasWidth,
            selection.canvasHeight,
            undefined,
            expandFactor,
          );

      // Siliconed patch 路径校验：自动补全后仍不足才拦截 / 警告
      //（此时还没读像素，用户能立即得到可操作的指引而不是等一次必然失败的任务）
      if (options.maskPatchFloor) {
        const band = maskSendShortSide(
          effW,
          effH,
          selection.canvasWidth,
          selection.canvasHeight,
          expandFactor,
          preset,
        );
        if (band < SILICONED_MASK_BLOCK_SHORT) {
          const padNote = maskAutoPad
            ? `已尝试自动补全选区短边（${maskAutoPad.fromShort} → ${maskAutoPad.toShort}px），但画布内空间不足；`
            : "";
          throw new Error(
            `Siliconed：选区较为狭长，蒙版在发送图中的短边约 ${Math.round(band)}px，` +
              `patch 路径裁剪块短边达不到 ${SILICONED_PATCH_CROP_FLOOR}px 下限，任务必然被拒单；` +
              `${padNote}请扩大选区（尤其短边方向）后重试`,
          );
        }
        if (band < SILICONED_MASK_SAFE_SHORT) {
          sizeWarnings.push(
            `Siliconed：蒙版发送短边约 ${Math.round(band)}px（< ${SILICONED_MASK_SAFE_SHORT}px），` +
              `裁剪短边可能不足 patch 下限，任务有被拒风险；必要时请扩大选区`,
          );
        }
      }

      // 补边模式下只捕获画布内部分，再按边缘像素延展到虚拟区域尺寸
      const clip = clipToCanvas(
        expanded.bounds,
        selection.canvasWidth,
        selection.canvasHeight,
      );
      const offX = clip.left - expanded.bounds.left;
      const offY = clip.top - expanded.bounds.top;

      // 3. 蒙版捕获（必须在改动选区之前；dispose 已在内部完成，释放槽位后再读像素）
      let mask = await step("读取蒙版", () => captureMask(doc, clip));

      // 4. 像素捕获：路径 A（零命令直读）优先；异常/透明/非 RGB → 路径 B（DOM 临时文档）
      let pixels: Uint8Array | null = null;
      let directError: string | null = null;
      try {
        pixels = await readMergedPixelsDirect(doc, clip);
      } catch (e) {
        directError = e instanceof Error ? e.message : String(e);
      }
      if (pixels === null) {
        try {
          pixels = await captureRgbaViaTempDoc(
            doc,
            clip,
            executionContext.hostControl,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw directError
            ? new Error(`${msg}（直读回退原因：${directError}）`)
            : e;
        }
      }
      if (pixels === null) throw new Error("像素捕获失败");

      // 5. 补边：把画布内像素/蒙版延展到虚拟区域（贴回时会裁掉补边区）。
      //    像素在内存里延展，整张图只在最后编码一次 PNG（旧实现会先编码、
      //    再解码、再编码，超宽画布下多出两份 64MB 级缓冲）。
      if (expanded.padInfo) {
        mask = extendMaskToRegion(
          mask,
          expanded.width,
          expanded.height,
          offX,
          offY,
        );
        pixels = extendRgbaToRegion(
          pixels,
          clip.right - clip.left,
          clip.bottom - clip.top,
          expanded.width,
          expanded.height,
          offX,
          offY,
        );
      }
      // 5.1 短边自动补全：把补出来的两条短边带写进蒙版白区，
      //     让 CLI 依据蒙版 bbox 裁出的块短边真正变宽。
      if (maskAutoPad) {
        mask = fillMaskPadBands(mask, expanded.bounds, sel, effectiveSel);
      }
      // 6. 送图尺寸：预设模式缩放到预设精确宽高；custom 沿用扩展区域尺寸。
      //    mask 保持原生尺寸（贴回按它裁剪/合成），sendMask 与送图同几何。
      const sendWidth = preset ? preset.width : expanded.width;
      const sendHeight = preset ? preset.height : expanded.height;
      let sendPixels = pixels;
      let sendMask: MaskData = mask;
      if (preset) {
        // 运行时兜底：只要走预设路径，送出尺寸必须严格等于预设尺寸
        assertPresetSendSize(sendWidth, sendHeight, preset);
        if (expanded.width !== sendWidth || expanded.height !== sendHeight) {
          sendPixels = await step("缩放到预设尺寸", () =>
            resizeRgba(pixels, expanded.width, expanded.height, sendWidth, sendHeight),
          );
          sendMask = {
            width: sendWidth,
            height: sendHeight,
            data: resizeGray(
              mask.data,
              mask.width,
              mask.height,
              sendWidth,
              sendHeight,
            ),
          };
        }
      }

      // 抓取产物尺寸断言：像素与蒙版的字节数必须与送图宽高一致
      if (sendPixels.length !== sendWidth * sendHeight * 4) {
        throw new Error(
          `抓取尺寸断言失败：像素 ${sendPixels.length} 字节与 ${sendWidth}×${sendHeight} 不符`,
        );
      }
      if (sendMask.data.length !== sendWidth * sendHeight) {
        throw new Error(
          `抓取尺寸断言失败：蒙版 ${sendMask.data.length} 字节与 ${sendWidth}×${sendHeight} 不符`,
        );
      }

      const pngBase64 = await step("编码 PNG", () =>
        uint8ToBase64(encodePng(sendWidth, sendHeight, sendPixels)),
      );
      // 同步编码黑白通道图（供生成请求使用；贴回继续用原始灰度 mask）
      const maskPngBase64 = await step("编码蒙版 PNG", () =>
        encodeMaskPngBase64(sendMask),
      );

      return {
        docId: doc.id,
        docName: doc.name,
        docPath: readDocPath(doc),
        canvasWidth: toPx(doc.width),
        canvasHeight: toPx(doc.height),
        originalBounds: sel,
        expanded,
        sizeMode,
        preset,
        sendWidth,
        sendHeight,
        pngBase64,
        mask,
        sendMask,
        maskPngBase64,
        captureRect: expanded.bounds,
        padAmounts: padAmountsOf(sel, expanded),
        sizeWarnings,
        selectionExpand: expandFactor,
        ...(maskAutoPad ? { maskAutoPad } : {}),
      };
    },
    { commandName: "AI 局部重绘：捕获选区" },
  );
};
