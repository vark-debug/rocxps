import { describe, it } from "node:test";
import assert from "node:assert/strict";

// 校验纯函数收敛在 promptPolicy（避免打包 UXP globals），此处从那里导入
import { validateGenerateFlow } from "./promptPolicy";

describe("validateGenerateFlow", () => {
  it("Siliconed + 空提示词 + auto → 放行（移除语义，运行时注入文案）", () => {
    assert.deepEqual(
      validateGenerateFlow("siliconed", "", "auto"),
      { ok: true },
    );
    assert.deepEqual(
      validateGenerateFlow("siliconed", "   \n", "auto"),
      { ok: true },
    );
  });

  it("Siliconed + 空提示词 + redraw → 拦截", () => {
    const res = validateGenerateFlow("siliconed", "", "redraw");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /重绘模式需要填写提示词/);
  });

  it("Siliconed + 有提示词 → 放行（任意模式）", () => {
    assert.deepEqual(
      validateGenerateFlow("siliconed", "一只猫", "remove"),
      { ok: true },
    );
    assert.deepEqual(
      validateGenerateFlow("siliconed", "一只猫", "redraw"),
      { ok: true },
    );
  });

  it("非 Siliconed + 空提示词 → 拦截（要求填写）", () => {
    const res = validateGenerateFlow("gemini" as never, "", "auto");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /请先填写提示词/);
  });

  it("非 Siliconed + 有提示词 → 放行", () => {
    assert.deepEqual(
      validateGenerateFlow("gemini" as never, "一只猫", "auto"),
      { ok: true },
    );
  });
});
