import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRESET_ID,
  SIZE_PRESETS,
  UNVERIFIED_PRESETS,
  VERIFIED_PRESETS,
  assertPresetAligned,
  assertPresetSendSize,
  assertPresetsAligned,
  getPresetById,
  type SizePreset,
} from "./presets";
import { CAPTURE_ALIGN } from "./align";

describe("尺寸预设表", () => {
  it("表完整：5 条已验证 + 2 条未验证", () => {
    assert.equal(SIZE_PRESETS.length, 7);
    assert.equal(VERIFIED_PRESETS.length, 5);
    assert.equal(UNVERIFIED_PRESETS.length, 2);
    const verifiedIds = VERIFIED_PRESETS.map((p) => p.id).sort();
    assert.deepEqual(verifiedIds, [
      "1024x1024",
      "1152x896",
      "1344x768",
      "768x1344",
      "896x1152",
    ]);
  });

  it("所有已验证预设宽高均为 32 的倍数", () => {
    for (const p of VERIFIED_PRESETS) {
      assert.equal(p.width % CAPTURE_ALIGN, 0, `${p.id} 宽未 32 对齐`);
      assert.equal(p.height % CAPTURE_ALIGN, 0, `${p.id} 高未 32 对齐`);
    }
    assert.doesNotThrow(() => assertPresetsAligned());
  });

  it("横 / 竖 / 方方向齐全", () => {
    const orientations = new Set(VERIFIED_PRESETS.map((p) => p.orientation));
    assert.deepEqual([...orientations].sort(), ["landscape", "portrait", "square"]);
    const landscape = VERIFIED_PRESETS.filter((p) => p.orientation === "landscape");
    assert.deepEqual(landscape.map((p) => p.id).sort(), ["1152x896", "1344x768"]);
  });

  it("未验证预设不在自动候选里，且带实测备注", () => {
    for (const p of UNVERIFIED_PRESETS) {
      assert.equal(p.verified, false);
      assert.ok(p.note && p.note.length > 0, `${p.id} 缺少 note`);
      assert.ok(
        !VERIFIED_PRESETS.some((v) => v.id === p.id),
        `${p.id} 不应出现在已验证列表`,
      );
    }
    assert.equal(getPresetById("832x1216")?.verified, false);
  });

  it("id 可解析，默认预设存在且已验证", () => {
    const def = getPresetById(DEFAULT_PRESET_ID);
    assert.ok(def, "默认预设应存在");
    assert.equal(def?.verified, true);
  });

  it("assertPresetAligned 对非 32 倍数抛错", () => {
    const bad: SizePreset = {
      id: "bad",
      width: 100,
      height: 100,
      orientation: "square",
      verified: true,
    };
    assert.throws(() => assertPresetAligned(bad), /32 的倍数/);
  });

  it("抓取尺寸断言：等于预设通过，不等抛错", () => {
    const preset = getPresetById("896x1152")!;
    assert.doesNotThrow(() => assertPresetSendSize(896, 1152, preset));
    assert.throws(
      () => assertPresetSendSize(864, 1184, preset),
      /抓取尺寸断言失败/,
    );
  });
});
