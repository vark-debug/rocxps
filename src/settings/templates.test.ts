import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyGenerationOverride,
  decideTemplateApply,
  isProviderId,
  normalizePromptTemplates,
  providerAvailability,
  providerRequiresKey,
  providerSwitchPatch,
  resolveTemplateProvider,
  rhPresetPatch,
} from "./templates";
import { DEFAULT_SETTINGS } from "./types";

describe("normalizePromptTemplates（向后兼容迁移）", () => {
  it("老模板（只有 name/prompt）保持跟随当前服务商", () => {
    const legacy = [
      { name: "去汽车", prompt: "去掉画面中的汽车" },
      { name: "换天空", prompt: "把天空换成黄昏" },
    ];
    const out = normalizePromptTemplates(legacy, 6);
    assert.equal(out.length, 6);
    assert.equal(out[0].name, "去汽车");
    assert.equal(out[0].providerId, undefined);
    assert.equal(out[1].providerId, undefined);
    assert.equal(out[2].name, "");
    assert.equal(out[2].prompt, "");
  });

  it("保留已绑定的 providerId，未知 id 原样保留（不静默清空）", () => {
    const stored = [
      { name: "a", prompt: "p", providerId: "siliconed" },
      { name: "b", prompt: "q", providerId: "drawthings" },
      { name: "c", prompt: "r", providerId: "" },
    ];
    const out = normalizePromptTemplates(stored, 6);
    assert.equal(out[0].providerId, "siliconed");
    assert.equal(out[1].providerId, "drawthings");
    assert.equal(out[2].providerId, undefined);
  });

  it("字段类型异常时不崩（非数组 / 非字符串）", () => {
    assert.equal(normalizePromptTemplates(undefined, 6).length, 6);
    assert.equal(normalizePromptTemplates({}, 6)[0].name, "");
    const out = normalizePromptTemplates([{ name: 1, prompt: null, providerId: 2 }], 2);
    assert.equal(out[0].name, "");
    assert.equal(out[0].prompt, "");
    assert.equal(out[0].providerId, undefined);
  });

  it("超出槽位的模板被截断（保持固定 6 槽）", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, prompt: `p${i}` }));
    assert.equal(normalizePromptTemplates(many, 6).length, 6);
  });
});

describe("resolveTemplateProvider", () => {
  it("空 / 缺省 → 跟随当前服务商", () => {
    assert.deepEqual(resolveTemplateProvider({}), { kind: "follow" });
    assert.deepEqual(resolveTemplateProvider({ providerId: "" }), { kind: "follow" });
    assert.deepEqual(resolveTemplateProvider({ providerId: "   " }), { kind: "follow" });
  });

  it("目录内 id → 可切换", () => {
    assert.deepEqual(resolveTemplateProvider({ providerId: "siliconed" }), {
      kind: "provider",
      providerId: "siliconed",
    });
  });

  it("目录里已不存在的 id → 失效（不崩）", () => {
    assert.deepEqual(resolveTemplateProvider({ providerId: "drawthings" }), {
      kind: "invalid",
      raw: "drawthings",
    });
  });

  it("isProviderId 只认目录内的值", () => {
    assert.equal(isProviderId("ark"), true);
    assert.equal(isProviderId("iopaint"), true);
    assert.equal(isProviderId("drawthings"), false);
    assert.equal(isProviderId(undefined), false);
  });
});

describe("providerAvailability", () => {
  const settings = DEFAULT_SETTINGS;

  it("方舟 / RunningHub 缺 Key", () => {
    assert.deepEqual(
      providerAvailability("ark", settings, { hasKey: false, isMac: true }),
      { level: "missingKey", text: "缺 API Key" },
    );
    assert.equal(
      providerAvailability("runninghub", settings, { hasKey: true, isMac: true }).level,
      "ready",
    );
  });

  it("Siliconed 在非 macOS 为未安装；缺 CLI 路径为未配置", () => {
    assert.equal(
      providerAvailability("siliconed", settings, { hasKey: true, isMac: false }).level,
      "notInstalled",
    );
    assert.equal(
      providerAvailability("siliconed", { ...settings, siliconedCliPath: "" }, {
        hasKey: true,
        isMac: true,
      }).level,
      "unconfigured",
    );
    assert.equal(
      providerAvailability("siliconed", settings, { hasKey: true, isMac: true }).level,
      "ready",
    );
  });

  it("ComfyUI / 自定义接口按地址判断", () => {
    assert.equal(
      providerAvailability("comfyui", { ...settings, comfyBaseUrl: "" }, {
        hasKey: true,
        isMac: true,
      }).level,
      "unconfigured",
    );
    assert.equal(
      providerAvailability("custom", { ...settings, customUrl: "" }, {
        hasKey: true,
        isMac: true,
      }).level,
      "unconfigured",
    );
    assert.equal(
      providerAvailability("custom", { ...settings, customUrl: "https://example.com/edit" }, {
        hasKey: false,
        isMac: true,
      }).level,
      "ready",
    );
  });

  it("IOPaint 按服务地址判断（本机无鉴权，不看 isMac / Key）", () => {
    assert.equal(
      providerAvailability("iopaint", { ...settings, iopaintBaseUrl: "" }, {
        hasKey: false,
        isMac: false,
      }).level,
      "unconfigured",
    );
    assert.equal(
      providerAvailability("iopaint", settings, { hasKey: false, isMac: false }).level,
      "ready",
    );
    assert.equal(providerRequiresKey("iopaint"), false);
  });

  it("只有方舟 / RunningHub 生成时强制要求 Key", () => {
    assert.equal(providerRequiresKey("ark"), true);
    assert.equal(providerRequiresKey("runninghub"), true);
    assert.equal(providerRequiresKey("siliconed"), false);
    assert.equal(providerRequiresKey("comfyui"), false);
  });
});

describe("providerSwitchPatch（模板切换复用设置面板逻辑）", () => {
  it("切到方舟 → 该平台首个模型", () => {
    const patch = providerSwitchPatch("ark");
    assert.equal(patch.providerId, "ark");
    assert.ok(patch.modelId);
  });

  it("切到 RunningHub → 同步预设接口与请求体", () => {
    const patch = providerSwitchPatch("runninghub");
    const modelId = patch.modelId as string;
    assert.equal(patch.rhEndpoint, rhPresetPatch(modelId).rhEndpoint);
    assert.equal(patch.rhBodyTemplate, rhPresetPatch(modelId).rhBodyTemplate);
    assert.ok(patch.rhEndpoint);
    assert.ok(patch.rhBodyTemplate);
  });

  it("切到 Siliconed / IOPaint / ComfyUI / 自定义 → 带首个模型", () => {
    for (const id of ["siliconed", "iopaint", "comfyui", "custom"] as const) {
      const patch = providerSwitchPatch(id);
      assert.equal(patch.providerId, id);
      assert.ok(patch.modelId);
    }
  });
});

describe("applyGenerationOverride（一次性覆盖，不写回设置）", () => {
  it("覆盖生效，且传入的 settings 对象保持不变", () => {
    const settings = { ...DEFAULT_SETTINGS };
    const effective = applyGenerationOverride(settings, providerSwitchPatch("siliconed"));

    assert.equal(effective.providerId, "siliconed");
    assert.equal(effective.modelId, providerSwitchPatch("siliconed").modelId);
    // 默认设置（store 里的那份）完全没被改动
    assert.equal(settings.providerId, DEFAULT_SETTINGS.providerId);
    assert.equal(settings.modelId, DEFAULT_SETTINGS.modelId);
  });

  it("无覆盖时原样返回（同一引用，不产生任何状态）", () => {
    assert.equal(applyGenerationOverride(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    assert.equal(
      applyGenerationOverride(DEFAULT_SETTINGS, undefined),
      DEFAULT_SETTINGS,
    );
  });

  it("逐个任务独立，覆盖不会残留到下一次", () => {
    const base = { ...DEFAULT_SETTINGS };
    const withOverride = applyGenerationOverride(base, providerSwitchPatch("runninghub"));
    const nextTask = applyGenerationOverride(base);

    assert.equal(withOverride.providerId, "runninghub");
    assert.equal(nextTask.providerId, base.providerId);
    assert.equal(nextTask.modelId, base.modelId);
    // 再次用同一份 base 覆盖，结果与第一次相同（无隐藏累积状态）
    assert.deepEqual(
      applyGenerationOverride(base, providerSwitchPatch("runninghub")),
      withOverride,
    );
  });
});

describe("decideTemplateApply（点击模板的判定）", () => {
  const settings = { ...DEFAULT_SETTINGS };
  const ok = { hasKey: true, isMac: true };

  it("跟随当前服务商 → 直接生成，无覆盖", () => {
    const d = decideTemplateApply({ name: "n", prompt: "p" }, settings, ok);
    assert.equal(d.kind, "generate");
    if (d.kind !== "generate") return;
    assert.equal(d.prompt, "p");
    assert.equal(d.override, undefined);
  });

  it("绑定平台可用 → 生成并带该平台覆盖补丁", () => {
    const d = decideTemplateApply(
      { name: "n", prompt: "p", providerId: "siliconed" },
      settings,
      ok,
    );
    assert.equal(d.kind, "generate");
    if (d.kind !== "generate") return;
    assert.equal(d.override?.providerId, "siliconed");
    assert.equal(d.override?.modelId, providerSwitchPatch("siliconed").modelId);
    // 判定本身不产生副作用：原设置仍是默认平台
    assert.equal(settings.providerId, DEFAULT_SETTINGS.providerId);
  });

  it("RunningHub 覆盖带预设接口与请求体", () => {
    const d = decideTemplateApply(
      { name: "n", prompt: "p", providerId: "runninghub" },
      settings,
      ok,
    );
    assert.equal(d.kind, "generate");
    if (d.kind !== "generate") return;
    assert.equal(d.override?.rhEndpoint, rhPresetPatch(d.override?.modelId as string).rhEndpoint);
    assert.equal(
      d.override?.rhBodyTemplate,
      rhPresetPatch(d.override?.modelId as string).rhBodyTemplate,
    );
  });

  it("绑定平台与当前相同 → 生成但不覆盖（保留用户选的模型）", () => {
    const d = decideTemplateApply(
      { name: "n", prompt: "p", providerId: "ark" },
      settings,
      { hasKey: false, isMac: true },
    );
    assert.equal(d.kind, "generate");
    if (d.kind !== "generate") return;
    assert.equal(d.override, undefined);
  });

  it("缺 Key / 未安装 / 未配置 → 只提示，不生成、不带覆盖", () => {
    const missingKey = decideTemplateApply(
      { name: "n", prompt: "p", providerId: "runninghub" },
      settings,
      { hasKey: false, isMac: true },
    );
    assert.equal(missingKey.kind, "unavailable");

    const notInstalled = decideTemplateApply(
      { name: "n", prompt: "p", providerId: "siliconed" },
      settings,
      { hasKey: true, isMac: false },
    );
    assert.equal(notInstalled.kind, "unavailable");

    const unconfigured = decideTemplateApply(
      { name: "n", prompt: "p", providerId: "custom" },
      { ...settings, customUrl: "" },
      { hasKey: true, isMac: true },
    );
    assert.equal(unconfigured.kind, "unavailable");
    if (unconfigured.kind !== "unavailable") return;
    assert.match(unconfigured.message, /已保留原服务商/);
  });

  it("绑定已失效 → 只提示，不崩", () => {
    const d = decideTemplateApply(
      { name: "n", prompt: "p", providerId: "drawthings" },
      settings,
      ok,
    );
    assert.equal(d.kind, "invalid");
    if (d.kind !== "invalid") return;
    assert.match(d.message, /drawthings/);
  });
});
