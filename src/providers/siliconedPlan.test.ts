import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSiliconAddArgs,
  buildSiliconExpandAddArgs,
  describeSiliconExpandRejection,
  describeSiliconPatchRejection,
  detectSiliconMode,
  escapeSiliconPrompt,
  planSiliconedSize,
  resolveSiliconMode,
  SILICONED_ALIGN,
  SILICONED_DEFAULT_PROMPT,
  SILICONED_MAX_PIXELS,
  SILICONED_MIN_SIDE,
} from "./siliconedPlan";

const assertValid = (w: number, h: number): void => {
  assert.ok(w % SILICONED_ALIGN === 0, `${w} 不是 ${SILICONED_ALIGN} 的倍数`);
  assert.ok(h % SILICONED_ALIGN === 0, `${h} 不是 ${SILICONED_ALIGN} 的倍数`);
  assert.ok(w >= SILICONED_MIN_SIDE, `${w} 小于最小边`);
  assert.ok(h >= SILICONED_MIN_SIDE, `${h} 小于最小边`);
  assert.ok(w * h <= SILICONED_MAX_PIXELS, `${w}×${h} 超过 1MP`);
};

describe("planSiliconedSize", () => {
  it("1024×1024 原样返回", () => {
    const size = planSiliconedSize(1024, 1024);
    assert.deepEqual(size, { width: 1024, height: 1024 });
  });

  it("小选区放大到每边 512（32 对齐）", () => {
    assert.deepEqual(planSiliconedSize(32, 32), { width: 512, height: 512 });
    assert.deepEqual(planSiliconedSize(32, 64), { width: 512, height: 1024 });
  });

  it("512×2048 恰好 1MP，保持不变", () => {
    assert.deepEqual(planSiliconedSize(512, 2048), { width: 512, height: 2048 });
  });

  it("超过 1MP 的大选区缩小并保持合法", () => {
    const size = planSiliconedSize(1600, 1216);
    assertValid(size.width, size.height);
    const ratio = size.width / size.height;
    const original = 1600 / 1216;
    assert.ok(Math.abs(ratio - original) / original < 0.05);
  });

  it("略微超 1MP 时也能收敛", () => {
    const size = planSiliconedSize(544, 2048);
    assertValid(size.width, size.height);
  });

  it("宽高比极端（放大后必然超 1MP）时明确报错", () => {
    assert.throws(() => planSiliconedSize(32, 1600), /宽高比过于极端/);
  });
});

describe("escapeSiliconPrompt", () => {
  it("转义备选语法字符，保证单任务", () => {
    assert.equal(escapeSiliconPrompt("a{b|c}d"), "a\\{b\\|c\\}d");
    assert.equal(escapeSiliconPrompt("普通提示词"), "普通提示词");
  });
});

describe("buildSiliconAddArgs", () => {
  it("按 mask 工作流拼参数（image + mask + mode）", () => {
    const args = buildSiliconAddArgs({
      imagePath: "/tmp/image.png",
      maskPath: "/tmp/mask.png",
      mode: "remove",
      prompt: SILICONED_DEFAULT_PROMPT,
      seed: 42,
    });
    assert.deepEqual(args, [
      "add",
      "--model",
      "qwen-image-2.1",
      "--image",
      "/tmp/image.png",
      "--mask",
      "/tmp/mask.png",
      "--mode",
      "remove",
      SILICONED_DEFAULT_PROMPT,
      "42",
    ]);
  });

  it("redraw 分支写入 --mode redraw", () => {
    const args = buildSiliconAddArgs({
      imagePath: "/tmp/image.png",
      maskPath: "/tmp/mask.png",
      mode: "redraw",
      prompt: "把草地换成雪地",
      seed: 42,
    });
    assert.equal(args[7], "--mode");
    assert.equal(args[8], "redraw");
    assert.equal(args[9], "把草地换成雪地");
  });

  it("不再传 --ref / --steps / 显式尺寸（CLI 会拒绝或偏离工作流默认）", () => {
    const args = buildSiliconAddArgs({
      imagePath: "/tmp/image.png",
      maskPath: "/tmp/mask.png",
      mode: "redraw",
      prompt: "test",
      seed: 1,
    });
    assert.ok(!args.includes("--ref"));
    assert.ok(!args.includes("--steps"));
    assert.ok(!args.some((a) => /\d+x\d+/.test(a)));
  });

  it("提示词中的花括号 / 竖线被转义", () => {
    const args = buildSiliconAddArgs({
      imagePath: "/tmp/image.png",
      maskPath: "/tmp/mask.png",
      mode: "redraw",
      prompt: "a{b|c}",
      seed: 1,
    });
    assert.equal(args[9], "a\\{b\\|c\\}");
  });
});

describe("detectSiliconMode", () => {
  it("留空 / 纯空白按移除处理", () => {
    assert.equal(detectSiliconMode(""), "remove");
    assert.equal(detectSiliconMode("   \n"), "remove");
  });

  it("纯擦除句式按移除处理", () => {
    assert.equal(detectSiliconMode("移除画面中的电线"), "remove");
    assert.equal(detectSiliconMode("擦除选区里的路人"), "remove");
  });

  it("移除 + 补全背景仍按移除处理", () => {
    assert.equal(detectSiliconMode("移除画面中的电线，并补全背景"), "remove");
  });

  it("移除 + 替换成新内容按重绘处理（替换标记优先）", () => {
    assert.equal(detectSiliconMode("移除画面中的电线，并替换成栏杆"), "redraw");
  });

  it("描述性提示词按重绘处理", () => {
    assert.equal(detectSiliconMode("把天空换成蓝天"), "redraw");
    assert.equal(detectSiliconMode("在墙面添加一扇窗"), "redraw");
    assert.equal(detectSiliconMode("让光线更柔和"), "redraw");
  });
});

describe("resolveSiliconMode", () => {
  it("空提示词 + 空后缀：移除分支补默认移除文案", () => {
    assert.deepEqual(resolveSiliconMode("", ""), {
      mode: "remove",
      prompt: SILICONED_DEFAULT_PROMPT,
    });
    assert.deepEqual(resolveSiliconMode("   \n", "  "), {
      mode: "remove",
      prompt: SILICONED_DEFAULT_PROMPT,
    });
  });

  it("只有后缀时仍保留移除指令（默认文案 + 后缀）", () => {
    assert.deepEqual(resolveSiliconMode("", "保持光影"), {
      mode: "remove",
      prompt: `${SILICONED_DEFAULT_PROMPT}\n保持光影`,
    });
  });

  it("用户提示词 + 后缀按行拼接", () => {
    assert.deepEqual(resolveSiliconMode("移除柱子", "保持光影"), {
      mode: "remove",
      prompt: "移除柱子\n保持光影",
    });
  });

  it("替换句式判定为重绘且不注入默认文案", () => {
    assert.deepEqual(resolveSiliconMode("把草地换成雪地", "保持光影"), {
      mode: "redraw",
      prompt: "把草地换成雪地\n保持光影",
    });
  });

  it("手动覆盖优先于自动判定", () => {
    assert.deepEqual(resolveSiliconMode("移除柱子", "", "redraw"), {
      mode: "redraw",
      prompt: "移除柱子",
    });
    assert.deepEqual(resolveSiliconMode("", "", "remove"), {
      mode: "remove",
      prompt: SILICONED_DEFAULT_PROMPT,
    });
  });
});

describe("describeSiliconPatchRejection（patch 拒单翻译）", () => {
  // 队列落盘里的真实拒单原文（节选）
  const REAL =
    "Siliconed 提交任务失败：此局部修补被拒绝：the crop 1344×334 renders at 1344×320, " +
    "its short side under the patch path's 448 px floor (regular renders keep 512): " +
    "widen the mask or use a less elongated crop。 — 请在要替换的区域上…";

  it("识别真实拒单并给出简短提示（含裁剪尺寸）", () => {
    const text = describeSiliconPatchRejection(REAL);
    assert.ok(text);
    assert.ok(text.includes("短边 334px"));
    assert.ok(text.includes("1344×334"));
    assert.ok(text.includes("扩大选区"));
    // 精简：不再拼接服务端英文原文与长段遮罩说明
    assert.ok(!text.includes("widen the mask"));
    assert.ok(text.length < 50);
  });

  it("命中关键词但解析不到尺寸时给通用提示", () => {
    const text = describeSiliconPatchRejection("its short side under the patch path's 448 px floor");
    assert.ok(text);
    assert.ok(text.includes("448px"));
    assert.ok(!/\d+×\d+（短边/.test(text));
  });

  it("无关报错返回 null（调用方原样抛出）", () => {
    assert.equal(describeSiliconPatchRejection("Siliconed 未返回任务编号（job）"), null);
    assert.equal(describeSiliconPatchRejection(""), null);
  });
});

describe("buildSiliconExpandAddArgs（expand 工作流参数）", () => {
  it("按 CLI 规格拼装：--mode expand，无 --mask，pad 为 L,R,T,B", () => {
    const args = buildSiliconExpandAddArgs({
      imagePath: "/tmp/expand/ref.png",
      prompt: "把天空换成晚霞",
      pads: { left: 30, top: 12.5, right: 33.333, bottom: 0 },
    });
    assert.deepEqual(args, [
      "add",
      "--model",
      "qwen-image-2.1",
      "--mode",
      "expand",
      "--image",
      "/tmp/expand/ref.png",
      "--pad",
      "30.00,33.33,12.50,0.00",
      "把天空换成晚霞",
    ]);
  });

  it("空提示词：位置参数原样传递（调用方负责 trim），不传 --max-sample", () => {
    const args = buildSiliconExpandAddArgs({
      imagePath: "/tmp/ref.png",
      prompt: "  ",
      pads: { left: 25, top: 0, right: 25, bottom: 0 },
    });
    assert.equal(args[args.length - 1], "  ");
    assert.ok(!args.includes("--max-sample"));
    assert.ok(!args.includes("--mask"));
  });

  it("maxSample 存在时输出 --max-sample 参数", () => {
    const args = buildSiliconExpandAddArgs({
      imagePath: "/tmp/ref.png",
      prompt: "",
      pads: { left: 30, top: 30, right: 30, bottom: 30 },
      maxSample: 1536,
    });
    const i = args.indexOf("--max-sample");
    assert.equal(i, args.indexOf("--pad") + 2);
    assert.equal(args[i + 1], "1536");
    assert.equal(args[args.length - 1], "");
  });

  it("提示词做 {a|b} 转义保证单任务", () => {
    const args = buildSiliconExpandAddArgs({
      imagePath: "/tmp/ref.png",
      prompt: "延伸 {湖面|草地}",
      pads: { left: 0, top: 0, right: 50, bottom: 0 },
    });
    assert.equal(args[args.length - 1], "延伸 \\{湖面\\|草地\\}");
  });
});

describe("describeSiliconExpandRejection（旧版 CLI 拒单翻译）", () => {
  it("旧版未知选项报错翻译为升级提示", () => {
    const text = describeSiliconExpandRejection(
      "silicontrol add: unknown option --pad",
      "usage",
    );
    assert.ok(text);
    assert.ok(text.includes("版本过旧"));
    assert.ok(text.includes("--mode expand"));
    assert.ok(text.includes("unknown option --pad"));
  });

  it("usage: 前缀文本命中（不带 code）", () => {
    const text = describeSiliconExpandRejection("usage: silicontrol add [options]");
    assert.ok(text);
    assert.ok(text.includes("版本过旧"));
  });

  it("新 CLI 自身的 usage 错误（pad 非法等）保留原文，仅附升级提示", () => {
    // 即便是 usage 类，原始错误尾行也在文案中，不会吞信息
    const text = describeSiliconExpandRejection("error: --pad all zero", "usage");
    assert.ok(text?.includes("--pad all zero"));
  });

  it("其他错误返回 null（原样上抛）", () => {
    assert.equal(describeSiliconExpandRejection("queue_full"), null);
    assert.equal(describeSiliconExpandRejection("model not ready"), null);
    assert.equal(describeSiliconExpandRejection("", undefined), null);
  });
});
