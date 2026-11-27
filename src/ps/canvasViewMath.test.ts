import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  docToScreen,
  docRectToScreen,
  intersectRects,
  placeToolbar,
  type CanvasView,
} from "./canvasViewMath";
import type { Rect } from "./types";

const rect = (l: number, t: number, r: number, b: number): Rect => ({
  left: l,
  top: t,
  right: r,
  bottom: b,
});

/** 100% 缩放、视口从文档 (0,0) 开始、视口屏幕位置 (100,100) 起 800×600 */
const view1: CanvasView = {
  scaleX: 1,
  scaleY: 1,
  docOffsetLeft: 0,
  docOffsetTop: 0,
  viewport: rect(100, 100, 900, 700),
};

/** 200% 放大（m=0.5）、视口左上角在文档 (100,50)、屏幕位置 (200,100) 起 1000×600 */
const view2: CanvasView = {
  scaleX: 0.5,
  scaleY: 0.5,
  docOffsetLeft: 100,
  docOffsetTop: 50,
  viewport: rect(200, 100, 1200, 700),
};

describe("docToScreen", () => {
  it("100% 无偏移：文档坐标即视口内偏移", () => {
    assert.deepEqual(docToScreen(view1, 0, 0), { x: 100, y: 100 });
    assert.deepEqual(docToScreen(view1, 50, 40), { x: 150, y: 140 });
  });
  it("200% 放大 + 文档偏移：screen = viewport + (doc - offset) / m", () => {
    // doc(200,150) → 屏幕偏移 (100/0.5, 100/0.5) = (200,200) → (400,300)
    assert.deepEqual(docToScreen(view2, 200, 150), { x: 400, y: 300 });
    // 视口左上角对应的文档点恰好映射回视口左上角
    assert.deepEqual(docToScreen(view2, 100, 50), { x: 200, y: 100 });
  });
  it("docRectToScreen 矩形换算", () => {
    assert.deepEqual(docRectToScreen(view1, rect(10, 20, 110, 220)), {
      left: 110,
      top: 120,
      right: 210,
      bottom: 320,
    });
  });
  it("x/y 缩放轻微不一致（PS 27 正常现象）→ 两轴按各自缩放换算", () => {
    // 真机日志 doc=110 的实测值：x/y 缩放差 0.015%，曾因等值校验被误拒
    const aniso: CanvasView = {
      ...view1,
      scaleX: 1.38996138996139,
      scaleY: 1.3901734104046244,
    };
    const r = docToScreen(aniso, 1080, 1443);
    assert.equal(r.x, 100 + 1080 / 1.38996138996139);
    assert.equal(r.y, 100 + 1443 / 1.3901734104046244);
  });
});

describe("intersectRects", () => {
  it("相交取交集，不相交返回 null", () => {
    assert.deepEqual(intersectRects(rect(0, 0, 100, 100), rect(50, 50, 150, 150)), rect(50, 50, 100, 100));
    assert.equal(intersectRects(rect(0, 0, 10, 10), rect(20, 20, 30, 30)), null);
  });
});

describe("placeToolbar", () => {
  const args = (sel: Rect, view: CanvasView, w = 380, h = 40) => ({
    view,
    selDoc: sel,
    docWidth: 2000,
    docHeight: 1500,
    toolbarWidth: w,
    toolbarHeight: h,
  });

  it("无视口 → null（调用方退回固定定位）", () => {
    assert.equal(placeToolbar(args(rect(10, 10, 50, 50), null as unknown as CanvasView)), null);
  });

  it("场景一：常规位置 → 选区正下方 16px，水平居中", () => {
    // 选区 doc(300,200)-(500,300) → 屏幕 (400,300)-(600,400)，画布远大于视口
    const r = placeToolbar(args(rect(300, 200, 500, 300), view1));
    assert.deepEqual(r, { x: 310, y: 416 }); // 中心 500 - 190；400 + 16
  });

  it("场景二：选区靠画布下缘 → 翻到选区上方", () => {
    // 选区 doc(300,560)-(500,660) → 屏幕 (400,660)-(600,760)：下方 776+40 出界
    // → 上方 660-16-40 = 604（≥ 盒顶 100 且 644 ≤ 盒底 700 ✓）
    const r = placeToolbar(args(rect(300, 560, 500, 660), view1));
    assert.deepEqual(r, { x: 310, y: 604 });
  });

  it("场景二变体：选区贴画布底、上方也放不下 → 贴可见画布底缘内侧", () => {
    // 选区屏幕 (400,660)-(600,700)：下方 716 出界，上方 604 放得下？
    // 604 >= 100 且 644 <= 700 → 实际走上方；再构造上下都放不下的画布：
    const tiny: CanvasView = { ...view1, viewport: rect(100, 100, 900, 160) };
    // 可见画布高 60 < 40+16+40，选区盖住画布 → 贴底缘 160-40=120
    const r = placeToolbar(args(rect(300, 80, 500, 140), tiny));
    assert.deepEqual(r, { x: 310, y: 120 });
  });

  it("场景三：选区靠画布右缘 → 水平钳制进画布（放弃居中）", () => {
    // 选区屏幕 (760,300)-(860,400)，居中 x=570-190=380？ 中心 810-190=620，620+380=1000 > 900 → 钳到 900-380=520
    const r = placeToolbar(args(rect(760, 200, 860, 300), view1));
    assert.deepEqual(r, { x: 520, y: 416 });
  });

  it("画布放大超出视口（zoomed in）：钳制盒 = 视口 ∩ 画布", () => {
    // view2 视口 1000×600，画布 2000×1500 doc → 屏幕 4000×3000 覆盖视口，盒=视口
    // 选区 doc(150,60)-(250,160) → 屏幕(300,120)-(500,320)：下方 336+40=376 ≤ 700 ✓
    const r = placeToolbar(args(rect(150, 60, 250, 160), view2));
    assert.deepEqual(r, { x: 210, y: 336 }); // 中心 400 - 190
  });

  it("浮窗比可见画布宽 → 贴左", () => {
    const tiny: CanvasView = { ...view1, viewport: rect(100, 100, 300, 700) };
    const r = placeToolbar(args(rect(120, 200, 180, 300), tiny, 380, 40));
    assert.deepEqual(r, { x: 100, y: 416 });
  });
});
