import type { Rect } from "./types";

/**
 * 超大区域分块读取（纯几何 + 像素拼接，可 Node 单测）。
 *
 * UXP 的 imaging.getPixels / imageData.getData() 在单次大缓冲（数十 MB 量级）
 * 上会抛 "Invalid array length"（8000×2000 RGBA = 64MB 实测必现），而官方
 * imaging 文档只提示「插件内存 600MB」警告，并未给出单次读取的像素/字节上限。
 * 因此按经验取保守的单块上限，逐块读取后拼接，而不是限制用户选区。
 */

/**
 * 单块像素上限（1MP，RGBA 约 4MB）。远低于实测触发的 16MP 量级，
 * 给不同位深/通道数与宿主内部拷贝留出余量。
 */
export const MAX_TILE_PIXELS = 1 << 20;

/**
 * 分块规划：优先整宽水平条带（拼接简单、行对齐）；只有宽度本身超过单块上限时
 * 才同时拆列（300000px 级的极端文档）。
 */
export const planTiles = (
  bounds: Rect,
  maxPixels: number = MAX_TILE_PIXELS,
): Rect[] => {
  if (!Number.isFinite(maxPixels) || maxPixels < 1) {
    throw new Error("分块上限非法");
  }
  const width = Math.floor(bounds.right - bounds.left);
  const height = Math.floor(bounds.bottom - bounds.top);
  if (width <= 0 || height <= 0) {
    throw new Error("分块区域为空");
  }

  const tileW = Math.min(width, Math.floor(maxPixels));
  const tileH = Math.max(1, Math.floor(maxPixels / tileW));

  const tiles: Rect[] = [];
  for (let top = bounds.top; top < bounds.top + height; top += tileH) {
    const bottom = Math.min(top + tileH, bounds.top + height);
    for (let left = bounds.left; left < bounds.left + width; left += tileW) {
      const right = Math.min(left + tileW, bounds.left + width);
      tiles.push({ left, top, right, bottom });
    }
  }
  return tiles;
};

/** 3/4 通道原图统一为 RGBA（3 通道补 alpha=255）；其他通道数返回 null。 */
export const toRgba = (
  data: Uint8Array,
  width: number,
  height: number,
): Uint8Array | null => {
  const rgbaLen = width * height * 4;
  const rgbLen = width * height * 3;
  if (data.length === rgbaLen) return data;
  if (data.length !== rgbLen) return null;
  const out = new Uint8Array(rgbaLen);
  for (let p = 0, s = 0; p < rgbaLen; p += 4, s += 3) {
    out[p] = data[s];
    out[p + 1] = data[s + 1];
    out[p + 2] = data[s + 2];
    out[p + 3] = 255;
  }
  return out;
};

/**
 * 把一块 RGBA 拼接进目标区域，越界自动裁剪。
 *
 * offX/offY 是「实际数据相对区域原点」的偏移：imaging 会把 sourceBounds 收紧到
 * 含像素数据的区域，收紧后按收紧偏移落位，未覆盖的区域保持目标缓冲的初值（0）。
 */
export const blitTileInto = (
  dst: Uint8Array,
  dstW: number,
  dstH: number,
  tile: Uint8Array,
  tileW: number,
  tileH: number,
  offX: number,
  offY: number,
): void => {
  if (tile.length !== tileW * tileH * 4) {
    throw new Error("分块像素长度与尺寸不符");
  }
  const dx0 = Math.max(0, offX);
  const sx0 = dx0 - offX;
  const copyW = Math.min(tileW - sx0, dstW - dx0);
  if (copyW <= 0) return;
  for (let y = 0; y < tileH; y++) {
    const dy = y + offY;
    if (dy < 0 || dy >= dstH) continue;
    const from = (y * tileW + sx0) * 4;
    dst.set(tile.subarray(from, from + copyW * 4), (dy * dstW + dx0) * 4);
  }
};

/**
 * 把画布内的 RGBA 按「边缘像素延展」扩到虚拟区域尺寸（补边模式）。
 * 与旧的解码 PNG→延展→再编码等价，但不再解码/二次编码整张巨图。
 */
export const extendRgbaToRegion = (
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  offX: number,
  offY: number,
): Uint8Array => {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(Math.max(y - offY, 0), srcH - 1);
    const srcRow = sy * srcW * 4;
    const dstRow = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(Math.max(x - offX, 0), srcW - 1);
      const s = srcRow + sx * 4;
      const d = dstRow + x * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return out;
};
