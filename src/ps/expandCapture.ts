import { photoshop } from "../globals";
import { encodePng } from "./pngEncoder";
import { MAX_TILE_PIXELS, planTiles, toRgba } from "./tileRead";
import { uint8ToBase64 } from "./base64";
import { readDocPath, readDocumentRgba, toPx } from "./capture";
import {
  accumulateAlphaBounds,
  accumulateBackgroundColor,
  shrinkFromBackgroundFill,
  computeExpandPads,
  type AlphaBoundsAcc,
  type ExpandPadPlan,
  type RGBColor,
} from "./expandPlan";
import type { Rect } from "./types";
import type { Document } from "photoshop/dom/Document";

/**
 * 阔图 / 扩图抓取管线（独立于选区捕获工作流）。
 *
 * 流程：用户先在 PS 中用裁剪工具外扩画布（原始内容外为透明像素）→
 * 插件抓取整个扩展后的画布 → 分块扫描 alpha 得到非透明包围盒 =「原始画面」→
 * 按包围盒裁出源图 PNG，并计算四方向 pad 百分比。
 *
 * 与 captureSelection 的关键差异：
 * - 不需要选区、没有蒙版、没有尺寸预设（画布即目标尺寸）；
 * - 必须拿到真实 alpha：不走临时文档回退路径（合并拷贝 + 技术像素会破坏
 *   透明边界语义），非 RGB 文档直接报错；
 * - 两阶段内存安全：阶段一逐块扫描（O(tile) 内存，每块立即 dispose），
 *   阶段二只读取包围盒区域并编码一次 PNG。
 */

/** bbox 像素数超过该阈值时提示编码峰值（与现有大画布捕获同级，仅警告不拦截）。 */
const LARGE_BBOX_PIXELS = 24_000_000;

export interface ExpandCaptureResult {
  docId: number;
  docName: string;
  /** 捕获时的文档路径（未保存 / 云文档可能为空），关闭重开后用于次级匹配。 */
  docPath: string;
  /** 捕获时的画布尺寸（= 用户外扩后的目标尺寸）。 */
  canvasWidth: number;
  canvasHeight: number;
  /** 非透明包围盒（= 源图区域，画布坐标）。 */
  source: Rect;
  /** 源图 PNG base64（无 data: 前缀），尺寸 = source 宽高。 */
  pngBase64: string;
  /** 送图宽高（= source 宽高）。 */
  sendWidth: number;
  sendHeight: number;
  /** 四边 pad 计划（含 clamp 警告与逻辑输出画布尺寸）。 */
  pads: ExpandPadPlan;
  /** 抓取警告（大包围盒 / pad 截断等），不影响执行。 */
  warnings: string[];
}

const accToRect = (acc: AlphaBoundsAcc): Rect => ({
  // maxX/maxY 是含内容的最后一个像素，right/bottom 为开区间
  left: acc.minX,
  top: acc.minY,
  right: acc.maxX + 1,
  bottom: acc.maxY + 1,
});
const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[阔图捕获:${name}] ${msg}`);
  }
};

const sameRect = (a: Rect, b: Rect): boolean =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

/** 无透明边界时的统一报错（背景色自动修正失败或不可用时的回退路径）。 */
const NO_TRANSPARENT_EDGE_ERROR =
  "未检测到透明边界：画布可能被背景层锁定（裁剪外扩区域被背景色填充），" +
  "或尚未用裁剪工具外扩画布。请双击背景层解锁（或新建透明图层），" +
  "再用裁剪工具外扩画布后重试";

/** 读取 PS 背景色（背景层锁定场景按它识别填充带）；读取失败返回 null。 */
const readBackgroundColor = (): RGBColor | null => {
  try {
    const rgb = photoshop.app.backgroundColor?.rgb;
    const r = Number(rgb?.red);
    const g = Number(rgb?.green);
    const b = Number(rgb?.blue);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return {
        r: Math.min(255, Math.max(0, Math.round(r))),
        g: Math.min(255, Math.max(0, Math.round(g))),
        b: Math.min(255, Math.max(0, Math.round(b))),
      };
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * 抓取当前文档整个画布，检测非透明包围盒并裁出源图。
 *
 * - bbox 覆盖整画布 → 画布无透明边界：可能是背景层锁定（裁剪外扩区域被背景色
 *   填充）或未外扩，明确报错，不得静默把背景色当源图；
 * - 全画布透明 →「画布没有内容」；非 RGB → 明确报错（不走临时文档转换）。
 */
export const captureExpandCanvas = async (): Promise<ExpandCaptureResult> => {
  return photoshop.core.executeAsModal(
    async () => {
      const doc: Document | undefined = photoshop.app.activeDocument;
      if (!doc) throw new Error("请先打开一个文档");
      if (doc.mode !== photoshop.constants.DocumentMode.RGB) {
        throw new Error("扩图需要 RGB 文档：请先通过 图像 → 模式 转换为 RGB 颜色");
      }

      const canvasWidth = Math.round(toPx(doc.width));
      const canvasHeight = Math.round(toPx(doc.height));
      if (!(canvasWidth > 0) || !(canvasHeight > 0)) {
        throw new Error("无法读取画布尺寸");
      }
      const canvasRect: Rect = { left: 0, top: 0, right: canvasWidth, bottom: canvasHeight };

      const readOptions = (
        ((): { componentSize?: 8; colorSpace?: "RGB"; colorProfile?: string } => {
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
        })()
      );

      // 分块扫描：每块读后立即 dispose，visit 拿到该块的 RGBA 与画布内偏移；
      // 整块透明（sourceBounds 收紧为空）时跳过。alpha 扫描与背景色扫描共用。
      const imaging = photoshop.imaging;
      if (!imaging?.getPixels) {
        throw new Error("imaging.getPixels 不可用（需要 Photoshop 24.4+）");
      }
      const scanTiles = async (
        visit: (
          rgba: Uint8Array,
          tileW: number,
          tileH: number,
          offX: number,
          offY: number,
        ) => void,
      ): Promise<void> => {
        for (const tile of planTiles(canvasRect, MAX_TILE_PIXELS)) {
          const pixels = await step("扫描画布", () =>
            imaging.getPixels({
              documentID: doc.id,
              sourceBounds: {
                left: tile.left,
                top: tile.top,
                right: tile.right,
                bottom: tile.bottom,
              },
              ...readOptions,
            }),
          );
          const img = pixels.imageData;
          try {
            const sb = pixels.sourceBounds;
            if (sb.right <= sb.left || sb.bottom <= sb.top) continue;
            const data = new Uint8Array(
              await step("读取分块数据", () => img.getData({ chunky: true })),
            );
            const rgba = toRgba(data, img.width, img.height);
            if (!rgba) {
              throw new Error("画布像素通道数异常（预期 3/4 通道）");
            }
            visit(rgba, img.width, img.height, sb.left - canvasRect.left, sb.top - canvasRect.top);
          } finally {
            img.dispose();
          }
        }
      };

      // 阶段一：分块扫描 alpha，求非透明包围盒（O(tile) 内存）
      let acc: AlphaBoundsAcc | null = null;
      await scanTiles((rgba, tw, th, ox, oy) => {
        acc = accumulateAlphaBounds(acc, rgba, tw, th, ox, oy);
      });

      if (!acc) {
        throw new Error("画布没有内容，无法扩图");
      }
      let source = accToRect(acc);
      const warnings: string[] = [];
      if (sameRect(source, canvasRect)) {
        // 画布无透明边界：背景层锁定时裁剪外扩区域被背景色填充（不透明）。
        // 按背景色自动收缩（从四边向内数连续背景色带，遇内容即停）；失败回退报错。
        const bg = readBackgroundColor();
        if (!bg) throw new Error(NO_TRANSPARENT_EDGE_ERROR);
        const colHasContent = new Uint8Array(canvasWidth);
        const rowHasContent = new Uint8Array(canvasHeight);
        await scanTiles((rgba, tw, th, ox, oy) => {
          accumulateBackgroundColor(colHasContent, rowHasContent, rgba, tw, th, ox, oy, bg);
        });
        const shrink = shrinkFromBackgroundFill(colHasContent, rowHasContent);
        if (!shrink) throw new Error(NO_TRANSPARENT_EDGE_ERROR);
        source = {
          left: shrink.left,
          top: shrink.top,
          right: canvasWidth - shrink.right,
          bottom: canvasHeight - shrink.bottom,
        };
        warnings.push(
          `背景层锁定：已按背景色自动裁剪 左${shrink.left} 右${shrink.right} 上${shrink.top} 下${shrink.bottom} px 填充边界；若内容边缘恰与背景色同色可能裁多，可解锁背景层后重试`,
        );
      }

      const sw = source.right - source.left;
      const sh = source.bottom - source.top;
      if (sw * sh > LARGE_BBOX_PIXELS) {
        warnings.push(
          `源图 ${sw}×${sh}（约 ${Math.round((sw * sh) / 1_000_000)}MP）较大，抓取与生成耗时和内存占用都会明显增加`,
        );
      }

      // 阶段二：按包围盒裁出源图并编码（无预设缩放，送图 = 原生 bbox 尺寸）
      const rgba = await step("读取源图", () => readDocumentRgba(doc, source));
      if (!rgba) {
        throw new Error("源图像素读取失败（文档模式或位深不受支持）");
      }
      if (rgba.length !== sw * sh * 4) {
        throw new Error(`源图尺寸断言失败：${rgba.length} 字节与 ${sw}×${sh} 不符`);
      }

      const pads = computeExpandPads(source, canvasWidth, canvasHeight);
      warnings.push(...pads.warnings);

      const pngBase64 = await step("编码 PNG", () =>
        uint8ToBase64(encodePng(sw, sh, rgba)),
      );

      return {
        docId: doc.id,
        docName: doc.name,
        docPath: readDocPath(doc),
        canvasWidth,
        canvasHeight,
        source,
        pngBase64,
        sendWidth: sw,
        sendHeight: sh,
        pads,
        warnings,
      };
    },
    { commandName: "AI 扩图：抓取画布" },
  );
};
