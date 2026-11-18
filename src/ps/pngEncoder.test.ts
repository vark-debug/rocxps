import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

import { adler32, crc32, encodePng, zlibStored } from "./pngEncoder";

const utf8 = (s: string) => new Uint8Array([...Buffer.from(s, "utf8")]);

describe("crc32", () => {
  it("标准校验向量", () => {
    assert.equal(crc32(utf8("123456789")), 0xcbf43926);
  });
});

describe("adler32", () => {
  it("标准校验向量", () => {
    assert.equal(adler32(utf8("Wikipedia")), 0x11e60398);
  });
});

describe("zlibStored", () => {
  it("可被标准 zlib 解压还原", () => {
    const raw = utf8("hello rocxps ".repeat(100));
    const z = zlibStored(raw);
    const back = inflateSync(new Uint8Array(z));
    assert.deepEqual(new Uint8Array(back), raw);
  });

  it("超过 65535 字节时正确分块", () => {
    const raw = new Uint8Array(200_000);
    for (let i = 0; i < raw.length; i++) raw[i] = i & 0xff;
    const back = inflateSync(new Uint8Array(zlibStored(raw)));
    assert.equal(back.length, raw.length);
    assert.deepEqual(new Uint8Array(back), raw);
  });

  it("空数据也产出合法 zlib 流", () => {
    const back = inflateSync(new Uint8Array(zlibStored(new Uint8Array(0))));
    assert.equal(back.length, 0);
  });
});

const readChunk = (
  png: Uint8Array,
  offset: number,
): { type: string; data: Uint8Array; next: number } => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const len = view.getUint32(offset);
  const type = String.fromCharCode(
    png[offset + 4],
    png[offset + 5],
    png[offset + 6],
    png[offset + 7],
  );
  return {
    type,
    data: png.subarray(offset + 8, offset + 8 + len),
    next: offset + 12 + len,
  };
};

describe("encodePng", () => {
  it("产出结构合法的 RGBA PNG，IDAT 解压后逐像素一致", () => {
    const w = 8;
    const h = 6;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7) & 0xff;

    const png = encodePng(w, h, rgba);
    // 签名
    assert.deepEqual(
      png.subarray(0, 8),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // IHDR
    const first = readChunk(png, 8);
    assert.equal(first.type, "IHDR");
    const view = new DataView(
      first.data.buffer,
      first.data.byteOffset,
      first.data.length,
    );
    assert.equal(view.getUint32(0), w);
    assert.equal(view.getUint32(4), h);
    assert.equal(first.data[8], 8); // bit depth
    assert.equal(first.data[9], 6); // RGBA
    // IDAT
    const second = readChunk(png, first.next);
    assert.equal(second.type, "IDAT");
    const inflated = new Uint8Array(inflateSync(new Uint8Array(second.data)));
    assert.equal(inflated.length, h * (1 + w * 4));
    for (let y = 0; y < h; y++) {
      assert.equal(inflated[y * (1 + w * 4)], 0); // filter none
      assert.deepEqual(
        inflated.subarray(y * (1 + w * 4) + 1, (y + 1) * (1 + w * 4)),
        rgba.subarray(y * w * 4, (y + 1) * w * 4),
      );
    }
    // IEND
    const third = readChunk(png, second.next);
    assert.equal(third.type, "IEND");
    assert.equal(third.data.length, 0);
    assert.equal(third.next, png.length);
  });

  it("尺寸与数据长度不符时抛错", () => {
    assert.throws(() => encodePng(4, 4, new Uint8Array(4 * 4 * 3)));
    assert.throws(() => encodePng(0, 0, new Uint8Array(0)));
  });
});
