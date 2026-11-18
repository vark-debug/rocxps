import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  makeLayerMaskDescriptor,
  planMaskCreation,
  selectCompositeChannelDescriptor,
  selectLayerDescriptor,
} from "./placeBackDescriptors";

type Desc = Record<string, unknown> & {
  new?: Record<string, unknown>;
  at?: Record<string, unknown>;
  using?: Record<string, unknown>;
  _target?: Array<Record<string, unknown>>;
};

const asDesc = (d: unknown): Desc => d as Desc;

describe("placeBack descriptors", () => {
  it("select 描述符按图层 id 定位，且必须带 document 父级", () => {
    const d = asDesc(selectLayerDescriptor(42, 7));
    assert.equal(d._obj, "select");
    assert.deepEqual(d._target, [
      { _ref: "layer", _id: 42 },
      { _ref: "document", _id: 7 },
    ]);
  });

  it("创建蒙版：at 是 channel/mask，using 是图层蒙版 Reveal All", () => {
    const d = asDesc(makeLayerMaskDescriptor(7, 42));
    assert.equal(d._obj, "make");
    assert.deepEqual(d.new, { _obj: "channel" });
    assert.deepEqual(d.at, {
      _ref: "channel",
      _enum: "channel",
      _value: "mask",
    });
    assert.deepEqual(d.using, {
      _enum: "userMaskEnabled",
      _value: "revealAll",
    });
  });

  it("创建蒙版不会生成文档 alpha 通道 / 快速蒙版 / 依赖选区", () => {
    const json = JSON.stringify(makeLayerMaskDescriptor(7, 42));
    // 旧的错误写法用了 maskChannel（不是 Chnl 枚举），且没有 using
    assert.equal(json.includes("maskChannel"), false);
    // 不应出现快速蒙版相关枚举
    assert.equal(json.includes("quickMask"), false);
    // 不引用文档选区（贴回全程不读写选区）
    assert.equal(json.includes("selection"), false);
  });

  it("后台定位：select 描述符带 layer → document 目标", () => {
    const d = asDesc(selectLayerDescriptor(42, 7));
    assert.deepEqual(d._target, [
      { _ref: "layer", _id: 42 },
      { _ref: "document", _id: 7 },
    ]);
  });

  it("创建蒙版必须是 layer → document（AM 引用从对象到祖先）", () => {
    const d = asDesc(makeLayerMaskDescriptor(7, 42));
    assert.deepEqual(d._target, [
      { _ref: "layer", _id: 42 },
      { _ref: "document", _id: 7 },
    ]);
    // 仍然是图层蒙版，不是文档通道
    assert.deepEqual(d.at, { _ref: "channel", _enum: "channel", _value: "mask" });
  });

  it("docId 缺失时直接拒绝：绝不生成会命中活动文档的 descriptor", () => {
    assert.throws(
      () => makeLayerMaskDescriptor(undefined as unknown as number, 42),
      /必须显式指定文档与图层/,
    );
    assert.throws(
      () => selectLayerDescriptor(42, undefined as unknown as number),
      /必须显式指定文档与图层/,
    );
  });

  it("后台目标跳过 make，前台保留 make（make 会忽略 document 父级）", () => {
    assert.equal(planMaskCreation(false), "put-only");
    assert.equal(planMaskCreation(true), "make-then-put");
  });

  it("复合通道按文档色彩模式映射", () => {
    const rgb = asDesc(selectCompositeChannelDescriptor("RGBColorMode"));
    assert.equal(rgb._obj, "select");
    assert.deepEqual(rgb._target, [
      { _ref: "channel", _enum: "channel", _value: "RGB" },
    ]);

    assert.equal(
      asDesc(selectCompositeChannelDescriptor("CMYKColorMode"))._target?.[0]
        ._value,
      "CMYK",
    );
    assert.equal(
      asDesc(selectCompositeChannelDescriptor("grayscaleMode"))._target?.[0]
        ._value,
      "gray",
    );
    // 未知/特殊模式回退 RGB（RGB 文档占绝大多数）
    assert.equal(
      asDesc(selectCompositeChannelDescriptor("unknownMode"))._target?.[0]
        ._value,
      "RGB",
    );
  });
});
