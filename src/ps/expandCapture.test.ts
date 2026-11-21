import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { accumulateAlphaBounds, type AlphaBoundsAcc } from "./expandPlan";

/** 构造 tileW×tileH 的 RGBA：仅指定坐标不透明（alpha=255，颜色 0）。 */
const rgbaWith = (
  tileW: number,
  tileH: number,
  opaque: Array<[number, number]>,
  alpha = 255,
): Uint8Array => {
  const rgba = new Uint8Array(tileW * tileH * 4);
  for (const [x, y] of opaque) {
    rgba[(y * tileW + x) * 4 + 3] = alpha;
  }
  return rgba;
};

describe("accumulateAlphaBounds", () => {
  it("空块 / 全透明返回原 bounds", () => {
    assert.equal(accumulateAlphaBounds(null, new Uint8Array(4 * 4), 2, 2, 0, 0), null);
    const acc: AlphaBoundsAcc = { minX: 0, minY: 0, maxX: 5, maxY: 5 };
    assert.deepEqual(
      accumulateAlphaBounds(acc, new Uint8Array(4 * 4), 2, 2, 10, 10),
      acc,
    );
  });

  it("单像素：包围盒为其坐标 + offX/offY 偏移", () => {
    const acc = accumulateAlphaBounds(
      null,
      rgbaWith(4, 4, [[2, 3]]),
      4,
      4,
      100,
      200,
    );
    // maxX/maxY 含内容的最后一个像素
    assert.deepEqual(acc, { minX: 102, minY: 203, maxX: 102, maxY: 203 });
  });

  it("多像素合并，跨块累积正确", () => {
    const first = accumulateAlphaBounds(null, rgbaWith(4, 4, [[0, 0], [3, 1]]), 4, 4, 0, 0);
    assert.deepEqual(first, { minX: 0, minY: 0, maxX: 3, maxY: 1 });
    const second = accumulateAlphaBounds(
      first,
      rgbaWith(4, 4, [[1, 2]]),
      4,
      4,
      4, // 第二块 x 偏移 4（水平条带布局）
      0,
    );
    assert.deepEqual(second, { minX: 0, minY: 0, maxX: 5, maxY: 2 });
  });

  it("alpha 阈值边界：默认 > 0 视为内容（alpha=1 命中，0 忽略）", () => {
    const acc1 = accumulateAlphaBounds(null, rgbaWith(2, 2, [[1, 1]], 1), 2, 2, 0, 0);
    assert.deepEqual(acc1, { minX: 1, minY: 1, maxX: 1, maxY: 1 });
    const acc0 = accumulateAlphaBounds(null, rgbaWith(2, 2, [[1, 1]], 0), 2, 2, 0, 0);
    assert.equal(acc0, null);
  });

  it("自定义阈值：alpha 128 以下忽略", () => {
    const acc = accumulateAlphaBounds(null, rgbaWith(2, 2, [[0, 0]], 127), 2, 2, 0, 0, 127);
    assert.equal(acc, null);
    const acc2 = accumulateAlphaBounds(null, rgbaWith(2, 2, [[0, 0]], 128), 2, 2, 0, 0, 127);
    assert.deepEqual(acc2, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it("像素长度与尺寸不符抛错", () => {
    assert.throws(() => accumulateAlphaBounds(null, new Uint8Array(3), 2, 2, 0, 0), /不符/);
  });
});
