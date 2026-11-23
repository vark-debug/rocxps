import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { uint8ToBase64 } from "./base64";

/** Node Buffer 作为参照实现（性能优化后必须逐字节等价）。 */
const expectBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const randomBytes = (len: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(len);
  let s = seed;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = s >>> 16;
  }
  return out;
};

describe("uint8ToBase64", () => {
  it("已知向量（RFC 4648）", () => {
    const enc = (s: string) => uint8ToBase64(new TextEncoder().encode(s));
    assert.equal(enc(""), "");
    assert.equal(enc("f"), "Zg==");
    assert.equal(enc("fo"), "Zm8=");
    assert.equal(enc("foo"), "Zm9v");
    assert.equal(enc("foobar"), "Zm9vYmFy");
  });

  it("三种尾部长度（%3 = 0/1/2）与 Buffer 一致", () => {
    for (const len of [1, 2, 3, 4, 5, 6, 7, 1023, 1024, 1025]) {
      const bytes = randomBytes(len, len);
      assert.equal(uint8ToBase64(bytes), expectBase64(bytes), `len=${len}`);
    }
  });

  it("跨 8192 分片边界的大缓冲与 Buffer 一致（尾部长度 0/1/2 各验一次）", () => {
    for (const extra of [0, 1, 2]) {
      const len = 0x2000 * 2 + extra;
      const bytes = randomBytes(len, len + 7);
      assert.equal(uint8ToBase64(bytes), expectBase64(bytes), `len=${len}`);
    }
  });

  it("MB 级缓冲与 Buffer 一致（分块拼接正确性）", () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 5, 42);
    assert.equal(uint8ToBase64(bytes), expectBase64(bytes));
  });
});
