import { photoshop } from "../globals";
import {
  expandRectToAspect,
  expandRectToMultiple,
  padAmountsOf,
  readSelection,
} from "./selection";
import {
  depthBufferOption,
  parseComponentDepth,
  scaleSamplesToDepth,
} from "./bitDepth";
import {
  BUILD_STAMP,
  diagKey,
  ensureDiagSession,
  errText,
  isDiagEnabled,
} from "./placeBackDiag";
import { encodePng } from "./pngEncoder";
import { uint8ToBase64 } from "./base64";
import { resizeGray, resizeRgba } from "./resize";
import {
  MAX_TILE_PIXELS,
  blitTileInto,
  extendRgbaToRegion,
  planTiles,
  toRgba,
} from "./tileRead";
import { convertRgbaProPhotoToSrgb } from "./colorConvert";
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
import type { Layer } from "photoshop/dom/Layer";

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

/**
 * 为每一步包裹步骤名，失败时横幅可直接定位到具体环节（附 PS 版本便于排障）。
 * 每步耗时进关键事件环（「阶段耗时」），捕获周期慢时按毫秒数对号入座。
 */
const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
  const t0 = Date.now();
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagKey("阶段失败", { name, ms: Date.now() - t0, error: msg });
    throw new Error(`[捕获:${name}] ${msg}（PS ${appVersion()}）`);
  } finally {
    diagKey("阶段耗时", { name, ms: Date.now() - t0 });
  }
};

/**
 * 诊断：采集文档事实（模式 / 位深 / 色彩配置 / 图层类型清单）。
 * -32005「无法更新智能对象文件」高度怀疑与失效链接的智能对象有关，
 * 图层 kind 清单与粘贴产物 kind 是定位关键。任何字段读取失败都记下
 * 失败原因，绝不让日志采集本身影响捕获主流程。
 */
const diagDocFacts = (doc: Document): Record<string, unknown> => {
  const facts: Record<string, unknown> = { docId: doc.id };
  const readers: [string, () => unknown][] = [
    ["name", () => doc.name],
    ["mode", () => String(doc.mode)],
    ["bits", () => String(doc.bitsPerChannel)],
    ["profile", () => String(doc.colorProfileName ?? "")],
    ["canvas", () => ({ w: toPx(doc.width), h: toPx(doc.height) })],
    ["layersCount", () => doc.layers?.length ?? null],
  ];
  for (const [key, read] of readers) {
    try {
      facts[key] = read();
    } catch (e) {
      facts[key] = `读取失败: ${errText(e)}`;
    }
  }
  try {
    const smartObjectKind = photoshop.constants?.LayerKind?.SMARTOBJECT;
    facts.layers = (doc.layers ?? []).slice(0, 30).map((l) => {
      let kind: unknown = null;
      try {
        kind = l.kind;
      } catch {
        /* kind 读取失败时记 null */
      }
      return {
        id: l.id,
        kind: String(kind),
        isSmartObject: kind !== null && kind === smartObjectKind,
        name: l.name,
        visible: l.visible,
      };
    });
  } catch (e) {
    facts.layers = `图层列举失败: ${errText(e)}`;
  }
  return facts;
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

/**
 * 诊断：AM 视角智能对象探针。DOM kind 报告全部 "pixel" 但引擎仍报
 * 「无法更新智能对象文件」时，用 batchPlay get smartObject 属性定论：
 * 引擎视角是否存在智能对象状态（含 DOM 看不见的幻影状态）。
 * 仅观测，任何失败都记录后继续，绝不影响主流程。
 */
const probeSmartObjects = async (doc: Document): Promise<void> => {
  const flat: Array<{
    id: number;
    name: string;
    domKind: string;
    isGroup: boolean;
  }> = [];
  const walk = (items: readonly Layer[] | undefined) => {
    for (const l of items ?? []) {
      const isGroup = l.kind === photoshop.constants.LayerKind.GROUP;
      flat.push({ id: l.id, name: l.name, domKind: String(l.kind), isGroup });
      if (isGroup) walk((l as { items?: readonly Layer[] }).items);
    }
  };
  try {
    walk(doc.layers);
  } catch (e) {
    diagKey("智能对象探针", { error: `DOM 遍历失败: ${errText(e)}` });
    return;
  }
  const probes: Array<{
    id: number;
    name: string;
    hasSmartObject?: boolean;
    error?: string;
  }> = [];
  for (const l of flat) {
    try {
      const results = await photoshop.action.batchPlay(
        [
          {
            _obj: "get",
            _target: [
              { _property: "smartObject" },
              { _ref: "layer", _id: l.id },
            ],
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        syncBpOptions,
      );
      const r0 = results?.[0] as
        | { _obj?: string; message?: string; smartObject?: Record<string, unknown> }
        | undefined;
      probes.push(
        r0?._obj === "error"
          ? { id: l.id, name: l.name, error: r0.message ?? "未知错误" }
          : { id: l.id, name: l.name, hasSmartObject: Boolean(r0?.smartObject) },
      );
    } catch (e) {
      probes.push({ id: l.id, name: l.name, error: errText(e) });
    }
  }
  diagKey("智能对象探针", { layerCount: flat.length, layers: flat, probes });
};

/**
 * 诊断：单图层栅格读对照（合成直读失败后调用）。
 * - 单图层读成功 → 栅格缓存完好，只有合成渲染受损（逐层读+本地合成的
 *   路径 C 可救）；
 * - 单图层读也失败 → imaging 通道整体故障。
 * 先试转换读（与路径 A 同参数），失败再试原生读，凑齐对照矩阵。
 */
const probeLayerRasterRead = async (doc: Document): Promise<void> => {
  const imaging = photoshop.imaging;
  const layer = (doc.layers ?? []).find((l) => l.visible);
  if (!imaging?.getPixels || !layer) {
    diagKey("单图层读对照", { ok: false, error: "无可见图层或 imaging 不可用" });
    return;
  }
  const attempts: Array<Record<string, unknown>> = [];
  for (const label of ["转换读", "原生读"] as const) {
    try {
      const result = await imaging.getPixels({
        documentID: doc.id,
        layerID: layer.id,
        sourceBounds: { left: 0, top: 0, right: 256, bottom: 256 },
        ...(label === "转换读" ? { componentSize: 8 as const } : {}),
      });
      const img = result.imageData;
      try {
        attempts.push({
          mode: label,
          ok: true,
          componentSize: img.componentSize,
          components: img.components,
          sourceBounds: result.sourceBounds,
        });
      } finally {
        await img.dispose();
      }
    } catch (e) {
      attempts.push({ mode: label, ok: false, error: errText(e) });
    }
  }
  diagKey("单图层读对照", { layerId: layer.id, attempts });
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
 * 原生位深回退读的归一化（转换读失败时的兜底路径，仅观测日志驱动）。
 * 16 位：getData 已显式请求减范围 [0..32768]（fullRange:false，文档默认值），
 * 按 255/32768 线性映射；同时实测 max 判定宿主真实行为——若 max > 40000
 * 说明数据实为全范围（宿主忽略请求），改按 >>8 缩放，避免错误假设导致
 * 半亮 / 全白。32 位：[0..1] 浮点 ×255 截断。
 */
const normalizeToDepth8 = (
  src: Uint8Array | Uint16Array | Float32Array,
  componentSize: number,
): Uint8Array => {
  if (componentSize === 16) {
    const u16 = src as Uint16Array;
    let max = 0;
    for (let i = 0; i < u16.length; i++) if (u16[i] > max) max = u16[i];
    const fullRange = max > 40000;
    diagKey("原生16位范围观测", { max, fullRange });
    const out = new Uint8Array(u16.length);
    if (fullRange) {
      for (let i = 0; i < u16.length; i++) out[i] = u16[i] >> 8;
    } else {
      for (let i = 0; i < u16.length; i++) {
        const v = Math.round((u16[i] * 255) / 32768);
        out[i] = v > 255 ? 255 : v;
      }
    }
    return out;
  }
  return normalizeTo8(src, componentSize, src.length);
};

interface TileReadOptions {
  componentSize?: 8;
  colorSpace?: "RGB";
  colorProfile?: string;
  /** 源文档色彩配置标记：ProPhoto 文档的回退读需本地矩阵转 sRGB（见 colorConvert.ts）。 */
  sourceProfile?: "prophoto";
  /** 只读取指定图层（超分用）；缺省读文档合成像素。 */
  layerID?: number;
  /**
   * 16 位文档实测：componentSize:8 转换读必抛 -32005 毒化错误（见 bitDepth.ts
   * 与实测日志）。开局直接走原生位深回退，跳过注定失败的转换读宿主往返
   *（每瓦片约 200ms，实测瓦片1「读取像素」236ms 中大头）。
   */
  skipConversionRead?: boolean;
}

/**
 * 分块读取（imaging.getPixels）区域内像素并拼接为整块 RGBA。
 *
 * - 每块 ≤ MAX_TILE_PIXELS（默认 1MP，RGBA 约 4MB），逐块 getPixels → getData →
 *   dispose：既规避单次大缓冲的 "Invalid array length"，也满足 PS 只保留
 *   1-2 个 imageData 槽位的限制；
 * - PS 可能把 sourceBounds 收紧到含像素数据的区域，按实际偏移零填充拼接；
 * - 通道数不是 3/4 → null；requireOpaque 时遇透明像素立即返回 null（走路径 B）；
 * - 转换读失败走原生位深回退时，宿主色彩转换被跳过：ProPhoto 文档由
 *   colorConvert 本地矩阵转回 sRGB（其余宽色域暂不支持，宁缺毋错）。
 */
const readRegionRgbaTiled = async (
  docId: number,
  bounds: Rect,
  options: TileReadOptions,
  requireOpaque: boolean,
): Promise<Uint8Array | null> => {
  const imaging = photoshop.imaging;
  if (!imaging?.getPixels) return null;

  // sourceProfile 是本模块的内部标记，不透传给 imaging.getPixels
  const { sourceProfile, ...getPixelsOptions } = options;
  // 其他宽色域文档回退后暂无本地转换矩阵：只记一次，避免逐瓦片刷日志
  let warnedSkipConvert = false;

  const dstW = bounds.right - bounds.left;
  const dstH = bounds.bottom - bounds.top;
  const dst = new Uint8Array(dstW * dstH * 4);

  const tiles = planTiles(bounds, MAX_TILE_PIXELS);
  const readT0 = Date.now();
  let fallbackTiles = 0;
  // 回退记忆：转换读失败（如 16 位文档 -32005 毒化）通常在本会话持续，
  // 首块回退成功后其余瓦片直接走原生位深回退，省掉每块一次注定失败的
  // 转换读宿主往返（瓦片数越大节省越明显）。
  let fallbackOnly = options.skipConversionRead === true;
  if (fallbackOnly) {
    diagKey("16 位文档跳过转换读，直接原生位深回退", {
      docId,
      tiles: tiles.length,
    });
  }

  for (const tile of tiles) {
    // 本瓦片是否走了原生位深回退（决定是否需要本地色彩转换）
    let usedFallback = false;
    const pixels = await step("读取像素", async () => {
      let convertError: unknown = null;
      if (!fallbackOnly) {
        try {
          return await imaging.getPixels({
            documentID: docId,
            sourceBounds: {
              left: tile.left,
              top: tile.top,
              right: tile.right,
              bottom: tile.bottom,
            },
            ...getPixelsOptions,
          });
        } catch (e) {
          convertError = e;
          diagKey("读取像素失败", {
            docId,
            requireOpaque,
            tile,
            options,
            error: errText(e),
          });
          // 原生位深回退：转换读（componentSize / 色彩配置转换）可能在本会话
          // 失败（16 位文档实测 -32005 毒化错误），去掉转换参数按文档原生位深
          // 重读、本地归一化。保留 layerID（单图层读数路径），只丢位深/色彩转换。
        }
      }
      try {
        const fallback = await imaging.getPixels({
          documentID: docId,
          ...(getPixelsOptions.layerID
            ? { layerID: getPixelsOptions.layerID }
            : {}),
          sourceBounds: {
            left: tile.left,
            top: tile.top,
            right: tile.right,
            bottom: tile.bottom,
          },
        });
        usedFallback = true;
        fallbackTiles++;
        if (convertError && !fallbackOnly) {
          fallbackOnly = true;
          diagKey("转换读失败，本次读取改为原生位深回退", {
            docId,
            tiles: tiles.length,
          });
        }
        diagKey("原生位深回退成功", {
          docId,
          tile,
          componentSize: fallback.imageData.componentSize,
          components: fallback.imageData.components,
        });
        return fallback;
      } catch (e2) {
        diagKey("原生位深回退失败", { docId, tile, error: errText(e2) });
        // 两个通道都失败时优先抛转换读原始错误（保持既有排障语义）
        throw convertError ?? e2;
      }
    });
    const img = pixels.imageData;
    try {
      const sb = pixels.sourceBounds;
      // 收紧到空区域（整块透明/画布外）时直接跳过，保持目标缓冲的 0
      if (sb.right <= sb.left || sb.bottom <= sb.top) continue;
      // 原生位深（componentSize != 8）也照常消费：getData 显式请求减范围，
      // 本地归一化为 8 位后再进 RGBA 拼接（16 位文档转换读失败时的兜底）
      const raw = await step(
        img.componentSize === 8
          ? "读取分块像素数据"
          : "读取分块像素数据（原生位深）",
        () =>
          img.getData({
            chunky: true,
            ...(img.componentSize === 16 ? { fullRange: false } : {}),
          }),
      );
      // 瓦片后处理分段计时（实测路径A 696ms 中约 390ms 曾无日志入账）
      const postT0 = Date.now();
      const data8 = normalizeToDepth8(raw, img.componentSize);
      const normalizeMs = Date.now() - postT0;
      const rgbaT0 = Date.now();
      const rgba = toRgba(data8, img.width, img.height);
      const rgbaMs = Date.now() - rgbaT0;
      if (!rgba) return null;
      // 回退读拿到的是文档原生色彩编码：宿主转换读被跳过，本地矩阵补转换。
      // 仅 ProPhoto 有矩阵实现；其他宽色域保留原值并记录（避免用错矩阵偏色）。
      if (usedFallback && sourceProfile === "prophoto") {
        convertRgbaProPhotoToSrgb(rgba);
        diagKey("回退路径本地色彩转换", { docId, tile });
      } else if (usedFallback && options.colorProfile && !warnedSkipConvert) {
        warnedSkipConvert = true;
        diagKey("回退路径跳过本地色彩转换", {
          docId,
          colorProfile: options.colorProfile,
        });
      }
      const blitT0 = Date.now();
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
      diagKey("瓦片后处理", {
        docId,
        tile: { left: tile.left, top: tile.top },
        normalizeMs,
        rgbaMs,
        blitMs: Date.now() - blitT0,
      });
    } finally {
      const disposeT0 = Date.now();
      img.dispose();
      const disposeMs = Date.now() - disposeT0;
      // dispose 疑似宿主同步开销（首瓦片实测远高于后瓦片），超阈值才记录防刷屏
      if (disposeMs >= 20) diagKey("imageData dispose 耗时", { docId, disposeMs });
    }
  }
  diagKey("分块读取完成", {
    docId,
    tiles: tiles.length,
    fallbackTiles,
    ms: Date.now() - readT0,
  });
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
): Omit<TileReadOptions, "layerID"> | null => {
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
    ...(bitDepth.includes("16") ? { skipConversionRead: true as const } : {}),
    ...(isWideGamut
      ? { colorSpace: "RGB" as const, colorProfile: "sRGB IEC61966-2.1" }
      : {}),
    ...(profileName.includes("prophoto")
      ? { sourceProfile: "prophoto" as const }
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

  // 非 RGB（灰度/CMYK/索引等）交由路径 B：临时文档粘贴时统一转 RGB；
  // 16/32 位强制转 8 位读取；宽色域强制 sRGB（对齐参考项目）
  const options = pixelReadOptions(doc);
  if (!options) return null;
  diagKey("路径A直读开始", { docId: doc.id, bounds, options });
  return readRegionRgbaTiled(doc.id, bounds, options, true);
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
  diagKey("路径B开始", {
    docId: doc.id,
    bounds,
    copyTargetId: copyTarget?.id ?? null,
  });

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
    // 技术像素写回主文档（doc）：缓冲位深必须与文档一致（PSB 16/32 位文档）
    const depth = parseComponentDepth(doc.bitsPerChannel);
    const putPixel = async (x: number, y: number) => {
      const data = await imaging.createImageDataFromBuffer(
        scaleSamplesToDepth(new Uint8Array([0, 0, 0, 1]), depth),
        {
          width: 1,
          height: 1,
          components: 4,
          colorSpace: "RGB",
          ...depthBufferOption(depth),
        },
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
      // 显式锁 8 位深：不传时实测会继承主文档 bitDepth16，把路径 B 的
      // componentSize:8 读也拖进同一失败的转换读；8 位临时文档读即原生读
      depth: 8,
    }),
  );
  if (!tmp) throw new Error("创建临时文档失败");
  if (tmp.id === doc.id) {
    throw new Error("临时文档创建失败（误引用主文档，已中止以保护原文档）");
  }
  diagKey("临时文档已创建", {
    tmpId: tmp.id,
    bits: String(tmp.bitsPerChannel),
    mode: String(tmp.mode),
    width: toPx(tmp.width),
    height: toPx(tmp.height),
  });

  try {
    // 4) 粘贴并按图层实际位置对齐到 (0,0)
    //    （合并拷贝裁透明边时粘贴内容会偏移，用 bounds 校正）
    let layer: Layer | null = await step("粘贴", () => tmp.paste());
    if (!layer) {
      diagKey("DOM 粘贴无图层", { tmpId: tmp.id });
      // DOM paste 返回 null（剪贴板为空或 DOM 包装吞掉错误）：batchPlay paste
      // 兜底并采集 PS 真实错误文本——失败原因的定性证据
      try {
        const results = await step("batchPlay 粘贴", () =>
          photoshop.action.batchPlay(
            [
              {
                _obj: "paste",
                antiAlias: { _enum: "antiAliasType", _value: "document" },
                as: { _enum: "pixelDataType", _value: "pixel" },
              },
            ],
            syncBpOptions,
          ),
        );
        assertNoError(results, "batchPlay 粘贴");
        layer = tmp.activeLayers?.[0] ?? null;
        diagKey("batchPlay 粘贴恢复", {
          layerId: layer?.id ?? null,
          kind: layer ? String(layer.kind) : null,
        });
      } catch (e) {
        diagKey("batchPlay 粘贴失败", { error: errText(e) });
      }
    }
    diagKey("粘贴结果", {
      layerId: layer?.id ?? null,
      kind: layer ? String(layer.kind) : null,
      name: layer?.name ?? null,
      bounds: layer
        ? {
            left: toPx(layer.bounds.left),
            top: toPx(layer.bounds.top),
            right: toPx(layer.bounds.right),
            bottom: toPx(layer.bounds.bottom),
          }
        : null,
    });
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
      const captureT0 = Date.now();
      // 自愈：先清掉历史失败运行留下的孤儿临时文档，再读主文档
      await step("清理孤儿临时文档", () => closeOrphanTempDocs());
      const doc = photoshop.app.activeDocument;
      if (!doc) throw new Error("请先打开一个文档");
      ensureDiagSession();
      diagKey("捕获开始", {
        build: BUILD_STAMP,
        ps: appVersion(),
        doc: diagDocFacts(doc),
      });
      // 诊断探针：AM 视角逐层读取 smartObject 属性，与 DOM kind 清单交叉验证
      //（-32005 报「无法更新智能对象文件」而 DOM 全部 kind:"pixel"，需引擎定论）
      // N 层 = N 次 batchPlay 宿主往返，图层多时显著拖慢捕获周期：
      // 该 bug 已定论（位深回退修复），探针只在诊断开关开启时执行。
      if (isDiagEnabled()) {
        try {
          await step("智能对象探针", () => probeSmartObjects(doc));
        } catch {
          /* 探针失败不影响主流程 */
        }
      }

      // 1. 原选区 bounds（改选区前读取）
      const selection = await step("读取选区", () => readSelection());
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
      let capturePath: "A" | "B" = "A";
      try {
        pixels = await step("路径A直读", () => readMergedPixelsDirect(doc, clip));
      } catch (e) {
        directError = e instanceof Error ? e.message : String(e);
        diagKey("直读失败", { error: directError });
        // 诊断探针：单图层读对照——区分「栅格缓存完好但合成渲染受损」与
        //「imaging 通道整体故障」
        try {
          await probeLayerRasterRead(doc);
        } catch {
          /* 探针失败不影响主流程 */
        }
      }
      if (pixels === null) {
        capturePath = "B";
        try {
          pixels = await step("路径B临时文档", () =>
            captureRgbaViaTempDoc(doc, clip, executionContext.hostControl),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          diagKey("路径B失败", { error: msg, directError });
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
        const extendT0 = Date.now();
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
        diagKey("阶段耗时", { name: "补边延展", ms: Date.now() - extendT0 });
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
            data: await step("缩放蒙版", () =>
              resizeGray(
                mask.data,
                mask.width,
                mask.height,
                sendWidth,
                sendHeight,
              ),
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

      const pngBytes = await step("编码 PNG", () =>
        encodePng(sendWidth, sendHeight, sendPixels),
      );
      const pngBase64 = await step("base64 编码", () => uint8ToBase64(pngBytes));
      // 同步编码黑白通道图（供生成请求使用；贴回继续用原始灰度 mask）
      const maskPngBase64 = await step("编码蒙版 PNG", () =>
        encodeMaskPngBase64(sendMask),
      );

      diagKey("捕获完成", {
        totalMs: Date.now() - captureT0,
        path: capturePath,
        sendWidth,
        sendHeight,
        pngBase64Length: pngBase64.length,
      });

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
