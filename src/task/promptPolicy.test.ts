import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveSiliconMode,
  SILICONED_DEFAULT_PROMPT,
} from "../providers/siliconedPlan";
import { promptBlocksSubmit } from "./promptPolicy";

describe("promptBlocksSubmit", () => {
  it("Siliconed：空 / 纯空白提示词放行（运行时注入默认移除文案）", () => {
    assert.equal(promptBlocksSubmit("siliconed", ""), false);
    assert.equal(promptBlocksSubmit("siliconed", "   \n\t "), false);
  });

  it("其他 provider：空 / 纯空白提示词仍阻断", () => {
    for (const provider of ["ark", "runninghub", "comfyui", "iopaint", "custom"] as const) {
      assert.equal(promptBlocksSubmit(provider, ""), true, provider);
      assert.equal(promptBlocksSubmit(provider, "  "), true, provider);
    }
  });

  it("任意 provider 填写了提示词都放行", () => {
    assert.equal(promptBlocksSubmit("siliconed", "移除柱子"), false);
    assert.equal(promptBlocksSubmit("ark", "把草地换成雪地"), false);
  });

  it("模板正文为空且后缀为空：最终提示词按空处理", () => {
    const final = resolveSiliconMode("", "").prompt;
    assert.equal(final, SILICONED_DEFAULT_PROMPT);
    assert.equal(promptBlocksSubmit("siliconed", final), false, "Siliconed 放行");
  });

  it("模板正文为空但配置了后缀：后缀即最终提示词，不算空", () => {
    const final = resolveSiliconMode("", "保持光影").prompt;
    assert.ok(final.includes("保持光影"));
    assert.equal(promptBlocksSubmit("siliconed", final), false);
  });

  it("expand 工作流：提示词是固定句子的补充，留空恒不阻断", () => {
    assert.equal(promptBlocksSubmit("siliconed", "", "expand"), false);
    assert.equal(promptBlocksSubmit("siliconed", "   ", "expand"), false);
    assert.equal(promptBlocksSubmit("ark", "", "expand"), false);
    assert.equal(promptBlocksSubmit("custom", "", "expand"), false);
    assert.equal(promptBlocksSubmit("ark", "把天空换成晚霞", "expand"), false);
  });
});
