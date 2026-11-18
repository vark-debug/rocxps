import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TILE_PIXELS,
  blitTileInto,
  extendRgbaToRegion,
  planTiles,
  toRgba,
} from "./tileRead";

const area = (r: { left: number; top: number; right: number; bottom: number }) =>
  (r.right - r.left) * (r.bottom - r.top);

/** 生成 RGBA 像素：每个像素的 R/G/B 由坐标决定，便于校验拼接是否为原图。 */
const makeRgba = (w: number, h: number, ox = 0, oy = 0): Uint8Array => {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      out[p] = (x + ox) & 0xff;
      out[p + 1] = (y + oy) & 0xff;
      out[p + 2] = ((x + ox) * 7 + (y + oy)) & 0xff;
      out[p + 3] = 255;
    }
  }
  return out;
};

describe("planTiles", () => {
  it("8000×2000 按 1MP 上限切成整宽条带，无缝覆盖且不超上限", () => {
    const bounds = { left: 0, top: 0, right: 8000, bottom: 2000 };
    const tiles = planTiles(bounds, MAX_TILE_PIXELS);
    // 8000 × 131 = 1,048,000 ≤ 1,048,576；2000 / 131 → 16 条
    assert.equal(tiles.length, 16);
    assert.equal(tiles[0].left, 0);
    assert.equal(tiles[0].right, 8000);
    assert.equal(tiles[0].top, 0);
    assert.equal(tiles[0].bottom, 131);
    assert.deepEqual(tiles.at(-1), { left: 0, top: 1965, right: 8000, bottom: 2000 });

    let covered = 0;
    let prevBottom = bounds.top;
    for (const t of tiles) {
      assert.ok(area(t) <= MAX_TILE_PIXELS, `块面积超限：${area(t)}`);
      assert.equal(t.left, bounds.left);
      assert.equal(t.right, bounds.right);
      assert.equal(t.top, prevBottom); // 无重叠、无缝隙
      prevBottom = t.bottom;
      covered += area(t);
    }
    assert.equal(covered, area(bounds));
    assert.equal(prevBottom, bounds.bottom);
  });

  it("非零原点（补边模式负坐标）保持绝对坐标", () => {
    const bounds = { left: -8, top: 8, right: 7992, bottom: 2008 };
    const tiles = planTiles(bounds, 1_000_000);
    assert.equal(tiles[0].left, -8);
    assert.equal(tiles[0].top, 8);
    assert.equal(tiles.at(-1)?.bottom, 2008);
    assert.deepEqual(tiles.at(-1)?.right, 7992);
  });

  it("区域小于单块上限时只切一块", () => {
    const tiles = planTiles({ left: 10, top: 20, right: 34, bottom: 30 }, MAX_TILE_PIXELS);
    assert.deepEqual(tiles, [{ left: 10, top: 20, right: 34, bottom: 30 }]);
  });

  it("宽度本身超过上限时同时拆列，每块不超上限", () => {
    const tiles = planTiles({ left: 0, top: 0, right: 200, bottom: 10 }, 50);
    assert.equal(tiles.length, 40); // 4 列 × 10 行
    for (const t of tiles) assert.ok(area(t) <= 50, `块面积超限：${area(t)}`);
  });

  it("空区域或非法上限抛错", () => {
    assert.throws(() => planTiles({ left: 0, top: 0, right: 0, bottom: 10 }));
    assert.throws(() => planTiles({ left: 0, top: 0, right: 10, bottom: 0 }));
    assert.throws(() => planTiles({ left: 0, top: 0, right: 10, bottom: 10 }, 0));
  });
});

describe("toRgba", () => {
  it("4 通道原样返回", () => {
    const rgba = makeRgba(2, 2);
    assert.equal(toRgba(rgba, 2, 2), rgba);
  });

  it("3 通道补 alpha=255", () => {
    const rgb = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const out = toRgba(rgb, 2, 1);
    assert.ok(out);
    assert.deepEqual(Array.from(out), [1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("通道数不符返回 null", () => {
    assert.equal(toRgba(new Uint8Array(2 * 1), 2, 1), null);
  });
});

describe("blitTileInto", () => {
  it("按偏移拼接，未覆盖区域保持 0", () => {
    const tile = makeRgba(2, 2);
    const dst = new Uint8Array(4 * 4 * 4);
    blitTileInto(dst, 4, 4, tile, 2, 2, 1, 2);
    // (1,2) 起 2×2 已被覆盖
    const p = (2 * 4 + 1) * 4;
    assert.deepEqual(Array.from(dst.subarray(p, p + 4)), [0, 0, 0, 255]);
    // 未覆盖的 (0,0) 仍为全 0（含 alpha）
    assert.deepEqual(Array.from(dst.subarray(0, 4)), [0, 0, 0, 0]);
  });

  it("sourceBounds 收紧后的偏移正确落位", () => {
    // 请求 4×4 的块，实际只返回 2×2（左上有 1px 空白）
    const tile = makeRgba(2, 2, 1, 1);
    const dst = new Uint8Array(4 * 4 * 4);
    blitTileInto(dst, 4, 4, tile, 2, 2, 1, 1);
    const p = (1 * 4 + 1) * 4;
    assert.equal(dst[p], 1);
    assert.equal(dst[p + 1], 1);
  });

  it("越界自动裁剪（负偏移 / 右侧溢出）", () => {
    const tile = makeRgba(4, 2);
    const dst = new Uint8Array(3 * 2 * 4);
    blitTileInto(dst, 3, 2, tile, 4, 2, -1, 0);
    // 源 x=1 落到 dst x=0
    assert.equal(dst[0], 1);
    assert.equal(dst[2 * 4], 3);

    const dst2 = new Uint8Array(3 * 2 * 4);
    blitTileInto(dst2, 3, 2, tile, 4, 2, 2, 0);
    // 只有源 x=0 落位到 dst x=2
    assert.equal(dst2[2 * 4], 0);
    assert.equal(dst2[2 * 4 + 1], 0);
  });

  it("行偏移越界时整块跳过", () => {
    const tile = makeRgba(2, 2);
    const dst = new Uint8Array(2 * 2 * 4);
    blitTileInto(dst, 2, 2, tile, 2, 2, 0, 5);
    assert.deepEqual(Array.from(dst), new Array(16).fill(0));
  });

  it("像素长度与块尺寸不符抛错", () => {
    assert.throws(() => blitTileInto(new Uint8Array(8), 2, 1, new Uint8Array(7), 2, 1, 0, 0));
  });
});

describe("分块拼接还原整图", () => {
  it("8000×2000 逐块取图拼接后与整图逐字节一致", () => {
    const w = 8000;
    const h = 2000;
    const full = makeRgba(w, h);
    const dst = new Uint8Array(w * h * 4);
    for (const t of planTiles({ left: 0, top: 0, right: w, bottom: h }, MAX_TILE_PIXELS)) {
      const tw = t.right - t.left;
      const th = t.bottom - t.top;
      const tile = new Uint8Array(tw * th * 4);
      for (let y = 0; y < th; y++) {
        const from = ((t.top + y) * w + t.left) * 4;
        tile.set(full.subarray(from, from + tw * 4), y * tw * 4);
      }
      blitTileInto(dst, w, h, tile, tw, th, t.left, t.top);
    }
    // 64MB 逐元素断言过慢：用字节校验和 + 首尾/分块边界行抽样精确比对
    const checksum = (a: Uint8Array) => {
      let x = 0x811c9dc5;
      for (let i = 0; i < a.length; i++) {
        x = (x ^ a[i]) >>> 0;
        x = Math.imul(x, 0x01000193) >>> 0;
      }
      return x;
    };
    assert.equal(dst.length, full.length);
    assert.equal(checksum(dst), checksum(full));
    for (const y of [0, 130, 131, 1999]) {
      assert.deepEqual(dst.subarray(y * w * 4, (y + 1) * w * 4), full.subarray(y * w * 4, (y + 1) * w * 4));
    }
  });
});

describe("extendRgbaToRegion", () => {
  it("补边按边缘像素延展", () => {
    const src = makeRgba(2, 2);
    const out = extendRgbaToRegion(src, 2, 2, 4, 4, 1, 1);
    // 左上角应复制源 (0,0)
    assert.deepEqual(Array.from(out.subarray(0, 4)), Array.from(src.subarray(0, 4)));
    // 右下角应复制源 (1,1)
    const last = (3 * 4 + 3) * 4;
    assert.deepEqual(
      Array.from(out.subarray(last, last + 4)),
      Array.from(src.subarray((1 * 2 + 1) * 4, (1 * 2 + 1) * 4 + 4)),
    );
  });

  it("负偏移（虚拟区域在画布左上之外）也正确延展", () => {
    const src = makeRgba(2, 2);
    const out = extendRgbaToRegion(src, 2, 2, 4, 4, -1, -1);
    // dst(0,0) 对应 src(1,1)（负偏移 = 目标整体右移/下移一格）
    const d0 = 0;
    const s11 = (1 * 2 + 1) * 4;
    assert.deepEqual(Array.from(out.subarray(d0, d0 + 4)), Array.from(src.subarray(s11, s11 + 4)));
    // dst(2,2) 也对应 src(1,1)（越界被夹到边缘）
    const p = (2 * 4 + 2) * 4;
    assert.deepEqual(Array.from(out.subarray(p, p + 4)), Array.from(src.subarray(s11, s11 + 4)));
    // dst(3,3) 仍夹在 src(1,1)
    const last = (3 * 4 + 3) * 4;
    assert.deepEqual(Array.from(out.subarray(last, last + 4)), Array.from(src.subarray(s11, s11 + 4)));
  });

  it("同尺寸同偏移返回逐字节一致的拷贝", () => {
    const src = makeRgba(3, 2);
    const out = extendRgbaToRegion(src, 3, 2, 3, 2, 0, 0);
    assert.deepEqual(out, src);
  });
});
