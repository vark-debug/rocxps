import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decodePng, base64ToBytes } from "./pngDecoder";
import { encodePng } from "./pngEncoder";
import { decodeJpeg } from "./jpegDecoder";
import {
  decodeImageBytes,
  sniffImageMime,
  stripDataUrlPrefix,
} from "./imageDecode";
import { JPEG_FIXTURES } from "./jpegFixtures";

// 容差：JPEG 有损 + 双线性上采样与 libjpeg 的差异
const TOLERANCE: Record<string, { max: number; mean: number }> = {
  "rgb444-33x17": { max: 4, mean: 1 },
  "rgb444-restart-33x17": { max: 4, mean: 1 },
  "gray-8x8": { max: 4, mean: 1 },
  "rgb420-33x17": { max: 20, mean: 3 },
};

const compare = (got: Uint8Array, ref: Uint8Array) => {
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < got.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(got[i + c] - ref[i + c]);
      if (d > max) max = d;
      sum += d;
      n++;
    }
  }
  return { max, mean: sum / n };
};

describe("decodeJpeg", () => {
  for (const f of JPEG_FIXTURES) {
    if (f.name.startsWith("progressive")) continue;
    const tol = TOLERANCE[f.name];
    it(`${f.name} 与 Pillow 参考一致`, () => {
      const got = decodeJpeg(base64ToBytes(f.jpegB64));
      assert.equal(got.width, f.width);
      assert.equal(got.height, f.height);
      const ref = decodePng(base64ToBytes(f.refPngB64));
      const { max, mean } = compare(got.rgba, ref.rgba);
      assert.ok(
        max <= tol.max,
        `${f.name} max diff ${max} > ${tol.max}`,
      );
      assert.ok(
        mean <= tol.mean,
        `${f.name} mean diff ${mean.toFixed(2)} > ${tol.mean}`,
      );
    });
  }

  it("渐进式 JPEG 明确报错", () => {
    const f = JPEG_FIXTURES.find((x) => x.name === "progressive-16x16")!;
    assert.throws(
      () => decodeJpeg(base64ToBytes(f.jpegB64)),
      /渐进式/,
    );
  });

  it("非 JPEG 输入报错", () => {
    assert.throws(() => decodeJpeg(new Uint8Array(10)), /缺少 SOI/);
  });
});

describe("imageDecode", () => {
  it("JPEG 夹具按签名分发为 jpeg", () => {
    const f = JPEG_FIXTURES[0];
    const d = decodeImageBytes(f.jpegB64);
    assert.equal(d.format, "jpeg");
    assert.equal(d.width, f.width);
  });

  it("PNG 按签名分发为 png（round-trip）", () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    const png = encodePng(2, 1, rgba);
    const d = decodeImageBytes(Buffer.from(png).toString("base64"));
    assert.equal(d.format, "png");
    assert.deepEqual(d.rgba, rgba);
  });

  it("剥离 data URL 前缀后仍可解码", () => {
    const f = JPEG_FIXTURES[0];
    const d = decodeImageBytes(`data:image/jpeg;base64,${f.jpegB64}`);
    assert.equal(d.format, "jpeg");
  });

  it("未知签名报错并包含 hex", () => {
    assert.throws(
      () => decodeImageBytes("AAECAw=="),
      /未知文件签名/,
    );
  });

  it("sniffImageMime 识别 PNG / JPEG / 未知", () => {
    assert.equal(sniffImageMime(JPEG_FIXTURES[0].jpegB64), "image/jpeg");
    const png = encodePng(1, 1, new Uint8Array(4));
    assert.equal(
      sniffImageMime(Buffer.from(png).toString("base64")),
      "image/png",
    );
    assert.equal(sniffImageMime("AAAA"), undefined);
  });

  it("stripDataUrlPrefix 不破坏无前缀输入", () => {
    assert.equal(stripDataUrlPrefix("abc"), "abc");
    assert.equal(
      stripDataUrlPrefix("data:image/png;base64,abc"),
      "abc",
    );
  });
});
