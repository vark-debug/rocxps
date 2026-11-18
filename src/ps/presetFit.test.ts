import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NEAR_SQUARE_RATIO,
  allowedOrientations,
  fitPreset,
  fitPresetWithMaskFloor,
  maskSendShortSide,
  normalizePresetId,
  normalizeSizeMode,
  padSelectionForMaskFloor,
  pickClosestPreset,
  SILICONED_MASK_BLOCK_SHORT,
  SILICONED_MASK_SAFE_SHORT,
} from "./presetFit";
import { getPresetById, type SizePreset } from "./presets";

describe("allowedOrientations", () => {
  it("w > h 走横向，h > w 走向上，近方形允许方形 + 竖向", () => {
    assert.deepEqual(allowedOrientations(1600, 1000), ["landscape"]);
    assert.deepEqual(allowedOrientations(800, 1200), ["portrait"]);
    assert.deepEqual(allowedOrientations(1000, 1000), ["square", "portrait"]);
    assert.deepEqual(
      allowedOrientations(10 * NEAR_SQUARE_RATIO, 10),
      ["square", "portrait"],
    );
  });
});

describe("fitPreset（auto 自动匹配）", () => {
  it("竖图选区 → 竖向预设（比例最接近）", () => {
    // 800×1152 比例 0.694 → 896×1152（0.778）比 768×1344（0.571）更近
    const fit = fitPreset(800, 1152, "auto");
    assert.equal(fit.preset?.id, "896x1152");
    assert.deepEqual(fit.warnings, []);
  });

  it("横图选区 → 横向预设（比例最接近）", () => {
    // 1200×1000 比例 1.2 → 1152×896（1.286）比 1344×768（1.75）更近
    const fit = fitPreset(1200, 1000, "auto");
    assert.equal(fit.preset?.id, "1152x896");
  });

  it("方形选区 → 1024×1024", () => {
    const fit = fitPreset(1000, 1000, "auto");
    assert.equal(fit.preset?.id, "1024x1024");
  });

  it("接近方形时方形比例最近时会胜出", () => {
    const fit = fitPreset(1050, 1000, "auto");
    assert.equal(fit.preset?.id, "1024x1024");
  });

  it("auto 模式不会选到未验证预设", () => {
    // 832×1216 自身比例最接近，但 unverified 默认排除
    const fit = fitPreset(832, 1216, "auto");
    assert.ok(fit.preset);
    assert.equal(fit.preset?.verified, true);
    assert.notEqual(fit.preset?.id, "832x1216");
  });

  it("选区远小于预设时给出上采样 warning，但仍按预设执行", () => {
    const fit = fitPreset(200, 300, "auto");
    assert.ok(fit.preset);
    assert.ok(fit.warnings.some((w) => w.includes("放大")));
  });
});

describe("fitPreset（fixed / custom）", () => {
  it("固定预设按 id 命中（含未验证，并给 warning）", () => {
    const ok = fitPreset(800, 1200, "fixed", "896x1152");
    assert.equal(ok.preset?.id, "896x1152");

    const unverified = fitPreset(800, 1200, "fixed", "832x1216");
    assert.equal(unverified.preset?.id, "832x1216");
    assert.ok(unverified.warnings.some((w) => w.includes("未经实测验证")));
  });

  it("未知固定预设 id 抛错", () => {
    assert.throws(() => fitPreset(800, 1200, "fixed", "999x999"), /未知的尺寸预设/);
  });

  it("custom 模式不使用预设", () => {
    const fit = fitPreset(800, 1200, "custom");
    assert.equal(fit.preset, null);
    assert.deepEqual(fit.warnings, []);
  });
});

describe("pickClosestPreset 并列规则", () => {
  it("比例并列时按面积最接近选区的优先", () => {
    const make = (id: string, width: number, height: number): SizePreset => ({
      id,
      width,
      height,
      orientation: "landscape",
      verified: true,
    });
    // 两个候选比例完全相同（2:1），面积 20k vs 5k；选区 300×150（45k）
    const big = make("200x100", 200, 100);
    const small = make("100x50", 100, 50);
    assert.equal(pickClosestPreset(300, 150, [small, big])?.id, "200x100");
    assert.equal(pickClosestPreset(300, 150, [big, small])?.id, "200x100");
  });
});

describe("设置归一化", () => {
  it("未知 mode / preset id 回退默认", () => {
    assert.equal(normalizeSizeMode("auto"), "auto");
    assert.equal(normalizeSizeMode("fixed"), "fixed");
    assert.equal(normalizeSizeMode("custom"), "custom");
    assert.equal(normalizeSizeMode("bogus"), "auto");
    assert.equal(normalizeSizeMode(undefined), "auto");
    assert.equal(normalizePresetId("1152x896"), "1152x896");
    assert.equal(normalizePresetId("999x999"), "896x1152");
    assert.equal(getPresetById(normalizePresetId("999x999"))?.id, "896x1152");
  });
});

describe("maskSendShortSide（Siliconed patch 短边估算）", () => {
  // 实测失败样本：12288×8192 画布，全宽天空条 12288×2241（蒙版白区=原选区），
  // 预设 1344×768 → 发送图内蒙版短边 175px，CLI 裁剪 1344×334 → 拒单
  const SKY = { selW: 12288, selH: 2241, canvasW: 12288, canvasH: 8192 };

  it("天空细条样本：1344×768 预设下约 175px（与 CLI 实测对应）", () => {
    const band = maskSendShortSide(
      SKY.selW, SKY.selH, SKY.canvasW, SKY.canvasH, 1.4,
      getPresetById("1344x768")!,
    );
    assert.equal(Math.round(band), 175);
    assert.ok(band < SILICONED_MASK_BLOCK_SHORT, "该样本应落入拦截区间");
  });

  it("同一样本换 1152×896 预设短边更小（比例补足更多）", () => {
    const band = maskSendShortSide(
      SKY.selW, SKY.selH, SKY.canvasW, SKY.canvasH, 1.4,
      getPresetById("1152x896")!,
    );
    assert.ok(band < 175);
  });

  it("常规选区（比例接近预设）短边远大于安全线", () => {
    const band = maskSendShortSide(1200, 1000, 2000, 2000, 1.4, getPresetById("1152x896")!);
    assert.ok(band >= SILICONED_MASK_SAFE_SHORT);
  });

  it("custom 模式（preset=null）短边 = 选区短边（1:1 发送）", () => {
    assert.equal(maskSendShortSide(300, 500, 1000, 1000, 1.4, null), 300);
  });

  it("非法选区抛错", () => {
    assert.throws(() => maskSendShortSide(0, 100, 1000, 1000, 1.4, null));
  });
});

describe("fitPresetWithMaskFloor（Siliconed 预设匹配叠加短边约束）", () => {
  it("常规选区：与 fitPreset 结果一致，无新增警告", () => {
    const plain = fitPreset(1200, 1000, "auto");
    const masked = fitPresetWithMaskFloor(1200, 1000, 2000, 2000, 1.4, "auto");
    assert.equal(masked.preset?.id, plain.preset?.id);
    assert.deepEqual(masked.warnings, plain.warnings);
  });

  it("极端细条：所有预设都不达标 → 保留常规选择并追加狭长警告", () => {
    const fit = fitPresetWithMaskFloor(12288, 2241, 12288, 8192, 1.4, "auto");
    assert.equal(fit.preset?.id, "1344x768", "常规匹配仍选 1344x768");
    assert.ok(fit.warnings.some((w) => w.includes("狭长")));
  });

  it("fixed 模式不换档（尊重用户显式选择）", () => {
    const fit = fitPresetWithMaskFloor(12288, 2241, 12288, 8192, 1.4, "fixed", "1344x768");
    assert.equal(fit.preset?.id, "1344x768");
    assert.ok(!fit.warnings.some((w) => w.includes("已改用")));
  });

  it("custom 模式原样返回 null 预设", () => {
    const fit = fitPresetWithMaskFloor(800, 1200, 2000, 2000, 1.4, "custom");
    assert.equal(fit.preset, null);
    assert.deepEqual(fit.warnings, []);
  });
});

describe("padSelectionForMaskFloor（选区短边自动补全）", () => {
  it("常规选区不补全，返回原矩形", () => {
    const rect = { left: 100, top: 100, right: 1300, bottom: 1100 };
    const pad = padSelectionForMaskFloor(
      rect, 4000, 4000, 1.4, getPresetById("1152x896")!,
    );
    assert.equal(pad.padded, false);
    assert.deepEqual(pad.rect, rect);
    assert.ok(pad.after >= SILICONED_MASK_SAFE_SHORT);
  });

  it("天空细条：沿短边补到安全线，长边与横向位置保持不变", () => {
    const rect = { left: 0, top: 2000, right: 12288, bottom: 4241 };
    const preset = getPresetById("1344x768")!;
    const pad = padSelectionForMaskFloor(rect, 12288, 8192, 1.4, preset);
    assert.equal(pad.padded, true);
    assert.equal(Math.round(pad.before), 175, "补全前与 CLI 实测一致");
    assert.ok(pad.after >= SILICONED_MASK_SAFE_SHORT);
    assert.equal(pad.rect.left, 0);
    assert.equal(pad.rect.right, 12288);
    assert.ok(pad.rect.bottom - pad.rect.top > 2241);
    assert.ok(pad.rect.top >= 0 && pad.rect.bottom <= 8192, "不得超出画布");
    // 补全后的尺寸经发送折算确实达标
    const band = maskSendShortSide(
      pad.rect.right - pad.rect.left,
      pad.rect.bottom - pad.rect.top,
      12288, 8192, 1.4, preset,
    );
    assert.ok(band >= SILICONED_MASK_SAFE_SHORT);
  });

  it("画布空间不足时补到上限并如实返回仍不达标", () => {
    const rect = { left: 0, top: 0, right: 12288, bottom: 2241 };
    const pad = padSelectionForMaskFloor(
      rect, 12288, 3000, 1.4, getPresetById("1344x768")!,
    );
    assert.equal(pad.padded, true);
    assert.equal(pad.rect.bottom, 3000);
    assert.ok(pad.after < SILICONED_MASK_SAFE_SHORT);
  });

  it("短边为宽度（竖长选区）时沿宽度方向补全", () => {
    const rect = { left: 500, top: 0, right: 1000, bottom: 2000 };
    const pad = padSelectionForMaskFloor(
      rect, 2000, 2000, 1.4, getPresetById("896x1152")!,
    );
    assert.equal(pad.padded, true);
    assert.ok(pad.after >= SILICONED_MASK_SAFE_SHORT);
    assert.equal(pad.rect.top, 0);
    assert.equal(pad.rect.bottom, 2000);
    assert.ok(pad.rect.right - pad.rect.left > 500);
    assert.ok(pad.rect.left >= 0 && pad.rect.right <= 2000);
  });

  it("custom 模式（1:1 发送）把两条边都补到安全线", () => {
    const pad = padSelectionForMaskFloor(
      { left: 100, top: 100, right: 200, bottom: 600 },
      1000, 1000, 1.4, null,
    );
    assert.equal(pad.padded, true);
    assert.equal(pad.rect.right - pad.rect.left, SILICONED_MASK_SAFE_SHORT);
    assert.equal(pad.rect.bottom - pad.rect.top, 500);
    assert.equal(pad.after, SILICONED_MASK_SAFE_SHORT);
  });
});
