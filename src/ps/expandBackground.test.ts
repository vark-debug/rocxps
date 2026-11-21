import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  accumulateBackgroundColor,
  shrinkFromBackgroundFill,
  type RGBColor,
} from "./expandPlan";

const BG: RGBColor = { r: 255, g: 255, b: 255 };

/** 构造 tileW×tileH RGBA：全背景色，指定坐标覆盖为指定颜色。 */
const rgbaWith = (
  tileW: number,
  tileH: number,
  colored: Array<[number, number]>,
  color: RGBColor = { r: 10, g: 20, b: 30 },
): Uint8Array => {
  const rgba = new Uint8Array(tileW * tileH * 4);
  for (let i = 0; i < tileW * tileH; i++) {
    rgba[i * 4] = BG.r;
    rgba[i * 4 + 1] = BG.g;
    rgba[i * 4 + 2] = BG.b;
    rgba[i * 4 + 3] = 255;
  }
  for (const [x, y] of colored) {
    const i = (y * tileW + x) * 4;
    rgba[i] = color.r;
    rgba[i + 1] = color.g;
    rgba[i + 2] = color.b;
  }
  return rgba;
};

describe("accumulateBackgroundColor", () => {
  it("背景色像素不标记，内容像素标记所在列与行", () => {
    const col = new Uint8Array(4);
    const row = new Uint8Array(4);
    accumulateBackgroundColor(col, row, rgbaWith(4, 4, [[1, 2]]), 4, 4, 0, 0, BG);
    assert.deepEqual(Array.from(col), [0, 1, 0, 0]);
    assert.deepEqual(Array.from(row), [0, 0, 1, 0]);
  });

  it("容差内的近似背景色不标记", () => {
    const col = new Uint8Array(2);
    const row = new Uint8Array(2);
    accumulateBackgroundColor(
      col,
      row,
      rgbaWith(2, 2, [[0, 0]], { r: 253, g: 254, b: 255 }),
      2,
      2,
      0,
      0,
      BG,
      2,
    );
    assert.deepEqual(Array.from(col), [0, 0]);
  });

  it("offX/offY 偏移写入正确位置", () => {
    const col = new Uint8Array(8);
    const row = new Uint8Array(4);
    accumulateBackgroundColor(col, row, rgbaWith(4, 4, [[0, 1]]), 4, 4, 4, 0, BG);
    assert.deepEqual(Array.from(col), [0, 0, 0, 0, 1, 0, 0, 0]);
    assert.deepEqual(Array.from(row), [0, 1, 0, 0]);
  });

  it("像素长度不符抛错", () => {
    assert.throws(
      () => accumulateBackgroundColor(new Uint8Array(2), new Uint8Array(2), new Uint8Array(3), 2, 2, 0, 0, BG),
      /不符/,
    );
  });
});

describe("shrinkFromBackgroundFill", () => {
  it("四边背景色带收缩：内容居中", () => {
    // 6×5 画布，内容占 (2,1)-(3,3)：左2 右2 上1 下1
    const col = new Uint8Array([0, 0, 1, 1, 0, 0]);
    const row = new Uint8Array([0, 1, 1, 1, 0]);
    const shrink = shrinkFromBackgroundFill(col, row);
    assert.deepEqual(shrink, { left: 2, top: 1, right: 2, bottom: 1 });
  });

  it("内容贴边：该边收缩为 0", () => {
    const col = new Uint8Array([1, 1, 0]);
    const row = new Uint8Array([1]);
    const shrink = shrinkFromBackgroundFill(col, row);
    assert.deepEqual(shrink, { left: 0, top: 0, right: 1, bottom: 0 });
  });

  it("内容含内部背景色带不影响收缩（只看四边连续带）", () => {
    // 列内容 [1,0,1,0,1]：左右各收缩 0（第一列即内容）
    const col = new Uint8Array([1, 0, 1, 0, 1]);
    const row = new Uint8Array([1, 0, 1]);
    const shrink = shrinkFromBackgroundFill(col, row);
    assert.deepEqual(shrink, { left: 0, top: 0, right: 0, bottom: 0 });
  });

  it("整幅都是背景色 → null（修正失败回退报错）", () => {
    assert.equal(shrinkFromBackgroundFill(new Uint8Array(4), new Uint8Array(4)), null);
  });

  it("空标记数组 → null", () => {
    assert.equal(shrinkFromBackgroundFill(new Uint8Array(0), new Uint8Array(5)), null);
    assert.equal(shrinkFromBackgroundFill(new Uint8Array(5), new Uint8Array(0)), null);
  });

  it("收缩带覆盖全部行列（左右带相接）→ null", () => {
    // 列标记全 0 意味着修正失败，上面已覆盖；这里验证左右带相接的防御分支
    const col = new Uint8Array([0, 0, 0]);
    const row = new Uint8Array([1, 1, 1]);
    assert.equal(shrinkFromBackgroundFill(col, row), null);
  });
});
