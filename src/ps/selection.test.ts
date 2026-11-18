import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { expandRectToMultiple } from "./geometry";
import { CAPTURE_ALIGN } from "./align";
import type { Rect } from "./types";

const rect = (l: number, t: number, r: number, b: number): Rect => ({
  left: l,
  top: t,
  right: r,
  bottom: b,
});

/** 通用不变量：按 CAPTURE_ALIGN 整除、完整包含原选区、补边信息自洽。 */
const assertInvariants = (
  result: ReturnType<typeof expandRectToMultiple>,
  sel: Rect,
) => {
  const { bounds, width, height, padInfo } = result;
  assert.equal(
    (bounds.right - bounds.left) % CAPTURE_ALIGN,
    0,
    `宽度必须 ${CAPTURE_ALIGN} 整除`,
  );
  assert.equal(
    (bounds.bottom - bounds.top) % CAPTURE_ALIGN,
    0,
    `高度必须 ${CAPTURE_ALIGN} 整除`,
  );
  assert.equal(width, bounds.right - bounds.left);
  assert.equal(height, bounds.bottom - bounds.top);
  assert.ok(bounds.left <= sel.left, "必须包含原选区左边界");
  assert.ok(bounds.top <= sel.top, "必须包含原选区上边界");
  assert.ok(bounds.right >= sel.right, "必须包含原选区右边界");
  assert.ok(bounds.bottom >= sel.bottom, "必须包含原选区下边界");

  if (padInfo) {
    assert.equal(padInfo.width, width);
    assert.equal(padInfo.height, height);
    // 有补边的轴才对齐画布原点；无补边的轴区域仍可整体偏移
    if (padInfo.padLeft > 0) {
      assert.equal(bounds.left + padInfo.padLeft, 0);
    }
    if (padInfo.padTop > 0) {
      assert.equal(bounds.top + padInfo.padTop, 0);
    }
  }
};

describe("expandRectToMultiple", () => {
  it("宽度居中外扩到 32，高度同步取整", () => {
    // w=309→320（dx=11 居中 5/6），h=208→224（dy=16 居中 8/8）
    const sel = rect(100, 100, 409, 308);
    const r = expandRectToMultiple(sel, 1920, 1080);
    assert.deepEqual(r.bounds, rect(95, 92, 415, 316));
    assert.equal(r.padInfo, undefined);
    assertInvariants(r, sel);
  });

  it("非 32 倍数尺寸：双向居中外扩", () => {
    // w=217→224 dx=7（3/4），h=105→128 dy=23（11/12）
    const r = expandRectToMultiple(rect(100, 100, 317, 205), 1000, 800);
    assert.deepEqual(r.bounds, rect(97, 89, 321, 217));
    assert.equal(r.padInfo, undefined);
    assertInvariants(r, rect(100, 100, 317, 205));
  });

  it("贴左上角：外扩量推回画布内", () => {
    const sel = rect(0, 0, 317, 205);
    const r = expandRectToMultiple(sel, 1000, 800);
    assert.deepEqual(r.bounds, rect(0, 0, 320, 224));
    assert.equal(r.padInfo, undefined);
    assertInvariants(r, sel);
  });

  it("贴右下角：外扩量推回画布内", () => {
    const sel = rect(683, 595, 1000, 800);
    const r = expandRectToMultiple(sel, 1000, 800);
    assert.deepEqual(r.bounds, rect(680, 576, 1000, 800));
    assert.equal(r.padInfo, undefined);
    assertInvariants(r, sel);
  });

  it("1px 极小选区：扩到 32x32", () => {
    const r = expandRectToMultiple(rect(500, 500, 501, 501), 1000, 800);
    assert.deepEqual(r.bounds, rect(485, 485, 517, 517));
    assertInvariants(r, rect(500, 500, 501, 501));
  });

  it("超过 1MP 的选区：只对齐、不主动缩小", () => {
    const sel = rect(0, 0, 1600, 1200);
    const r = expandRectToMultiple(sel, 1920, 1400);
    assert.deepEqual(r.bounds, rect(0, 0, 1600, 1216));
    assert.equal(r.width * r.height > 1048576, true);
    assertInvariants(r, sel);
  });

  it("画布横向放不下 32 倍数：进入补边模式（左右补边）", () => {
    // 画布宽 100，w32=128 > 100，虚拟区域以画布居中：padLeft=padRight=14
    const sel = rect(0, 50, 97, 66);
    const r = expandRectToMultiple(sel, 100, 200);
    assert.deepEqual(r.bounds, rect(-14, 42, 114, 74));
    assert.deepEqual(r.padInfo, {
      padLeft: 14,
      padTop: 0,
      padRight: 14,
      padBottom: 0,
      width: 128,
      height: 32,
    });
    assertInvariants(r, sel);
  });

  it("画布纵向放不下 32 倍数：进入补边模式（上下补边）", () => {
    // 画布高 100，h32=128 > 100，padTop=padBottom=14；宽度 288 已整除不补边
    const sel = rect(10, 0, 290, 97);
    const r = expandRectToMultiple(sel, 400, 100);
    assert.deepEqual(r.bounds, rect(6, -14, 294, 114));
    assert.deepEqual(r.padInfo, {
      padLeft: 0,
      padTop: 14,
      padRight: 0,
      padBottom: 14,
      width: 288,
      height: 128,
    });
    assertInvariants(r, sel);
  });

  it("可显式指定更小的对齐值（兼容旧 8 对齐的回归路径）", () => {
    const r = expandRectToMultiple(rect(100, 100, 409, 308), 1920, 1080, 8);
    assert.deepEqual(r.bounds, rect(99, 100, 411, 308));
  });

  it("空选区抛错", () => {
    assert.throws(() => expandRectToMultiple(rect(10, 10, 10, 10), 100, 100));
  });

  it("选区超出画布抛错", () => {
    assert.throws(() => expandRectToMultiple(rect(0, 0, 101, 50), 100, 100));
  });
});
