import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { MaskData } from "../ps/capture";
import {
  assertMaskSize,
  buildInpaintBody,
  iopaintHttpError,
  iopaintStartCommand,
  isIopaintModel,
  maskCoverage,
} from "./iopaint";

const makeMask = (width: number, height: number, value: number): MaskData => ({
  width,
  height,
  data: new Uint8Array(width * height).fill(value),
});

/** 中间一块白色矩形、四周黑色的 8×8 蒙版（白 = 编辑）。 */
const makeRectMask = (): MaskData => {
  const mask = makeMask(8, 8, 0);
  for (let y = 2; y < 6; y += 1) {
    for (let x = 2; x < 6; x += 1) mask.data[y * 8 + x] = 255;
  }
  return mask;
};

describe("maskCoverage（蒙版覆盖率：白=编辑）", () => {
  it("全黑 → empty（没有可编辑区域）", () => {
    assert.equal(maskCoverage(makeMask(4, 4, 0)), "empty");
  });

  it("全白 → full（整块都会被重绘）", () => {
    assert.equal(maskCoverage(makeMask(4, 4, 255)), "full");
  });

  it("有白有黑 → ok", () => {
    assert.equal(maskCoverage(makeRectMask()), "ok");
  });

  it("阈值与 IOPaint 一致：127 算黑、128 算白", () => {
    assert.equal(maskCoverage(makeMask(2, 2, 127)), "empty");
    assert.equal(maskCoverage(makeMask(2, 2, 128)), "full");
  });
});

describe("assertMaskSize（原图与蒙版必须同尺寸）", () => {
  it("尺寸一致时通过", () => {
    assert.doesNotThrow(() => assertMaskSize(makeRectMask(), 8, 8));
  });

  it("宽高不一致时给出明确错误", () => {
    assert.throws(
      () => assertMaskSize(makeRectMask(), 9, 8),
      /蒙版尺寸（8×8）与发送原图（9×8）不一致/,
    );
  });

  it("像素数组长度与 width×height 不符时也拦截", () => {
    const broken: MaskData = { width: 8, height: 8, data: new Uint8Array(8 * 8 - 1) };
    assert.throws(() => assertMaskSize(broken, 8, 8), /不一致/);
  });
});

describe("buildInpaintBody（/api/v1/inpaint 请求体）", () => {
  it("保留同尺寸原图与蒙版，去掉 data URI 前缀", () => {
    const body = buildInpaintBody(
      "data:image/png;base64,AAAA",
      "data:image/png;base64,BBBB",
    );
    assert.equal(body.image, "AAAA");
    assert.equal(body.mask, "BBBB");
  });

  it("默认 Crop 且保留蒙版外像素；不发送不存在的 model 字段", () => {
    const body = buildInpaintBody("AAAA", "BBBB");
    assert.equal(body.hd_strategy, "Crop");
    assert.equal(body.sd_keep_unmasked_area, true);
    // 本机实测 InpaintRequest 没有 model 字段，模型只能通过 POST /api/v1/model 切换
    assert.equal("model" in body, false);
  });
});

describe("iopaintStartCommand（启动提示）", () => {
  it("从服务地址提取端口并带上模型", () => {
    assert.equal(
      iopaintStartCommand("http://127.0.0.1:18088", "mat"),
      "iopaint start --model=mat --device=cpu --port=18088",
    );
  });

  it("地址无端口时回退默认 18088", () => {
    assert.equal(
      iopaintStartCommand("http://localhost", "lama"),
      "iopaint start --model=lama --device=cpu --port=18088",
    );
  });

  it("模型为空时回退 lama", () => {
    assert.equal(
      iopaintStartCommand("http://127.0.0.1:9999", " "),
      "iopaint start --model=lama --device=cpu --port=9999",
    );
  });
});

describe("iopaintHttpError（错误映射）", () => {
  it("400 + mask 尺寸不符 → 明确提示重新抓取", () => {
    const err = iopaintHttpError(
      400,
      '{"detail":"Image size(512, 512) and mask size(500, 500) not match."}',
      "http://127.0.0.1:18088",
      "lama",
    );
    assert.equal(err.kind, "terminal");
    assert.match(err.message, /蒙版尺寸与原图不一致/);
    assert.match(err.message, /not match/);
  });

  it("HTTP 500 带上服务端 message（例如模型未下载）", () => {
    const err = iopaintHttpError(
      500,
      '{"detail":"Model mat not found, please download first"}',
      "http://127.0.0.1:18088",
      "mat",
    );
    assert.equal(err.kind, "terminal");
    assert.match(err.message, /HTTP 500/);
    assert.match(err.message, /Model mat not found/);
  });

  it("非 JSON 错误体也保留状态码", () => {
    const err = iopaintHttpError(
      502,
      "Bad Gateway",
      "http://127.0.0.1:18088",
      "lama",
    );
    assert.equal(err.kind, "retryable");
    assert.match(err.message, /HTTP 502/);
    assert.match(err.message, /Bad Gateway/);
  });

  it("404 提示检查服务地址", () => {
    const err = iopaintHttpError(404, "", "http://127.0.0.1:18088", "lama");
    assert.match(err.message, /接口不存在/);
  });
});

describe("isIopaintModel", () => {
  it("只接受 lama / mat", () => {
    assert.equal(isIopaintModel("lama"), true);
    assert.equal(isIopaintModel("mat"), true);
    assert.equal(isIopaintModel("cv2"), false);
  });
});
