/**
 * Uint8Array → base64（无 data: 前缀）。
 * 数值循环直接产出 base64 字节缓冲，再分片 fromCharCode 拼串：
 * 相比 btoa(binaryString) 少了「构造 1MB 级二进制串 + btoa 内部逐字符反解析」
 * 两次全量往返；分片 32768 在 JSC fromCharCode 65536 参数上限内留一倍余量，
 * 5MB 级 PNG 的拼串分片数从 ~670 降到 ~170。
 */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const FROM_CHAR_CHUNK = 0x8000;

export const uint8ToBase64 = (bytes: Uint8Array): string => {
  const tail = bytes.length % 3;
  const quads = (bytes.length - tail) / 3;
  const b64 = new Uint8Array(quads * 4 + (tail ? 4 : 0));
  let o = 0;
  let i = 0;
  for (let q = 0; q < quads; q++, i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    b64[o++] = B64_ALPHABET.charCodeAt(n >>> 18);
    b64[o++] = B64_ALPHABET.charCodeAt((n >>> 12) & 63);
    b64[o++] = B64_ALPHABET.charCodeAt((n >>> 6) & 63);
    b64[o++] = B64_ALPHABET.charCodeAt(n & 63);
  }
  if (tail === 1) {
    const n = bytes[i] << 16;
    b64[o++] = B64_ALPHABET.charCodeAt(n >>> 18);
    b64[o++] = B64_ALPHABET.charCodeAt((n >>> 12) & 63);
    b64[o++] = 61; // '='
    b64[o] = 61;
  } else if (tail === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    b64[o++] = B64_ALPHABET.charCodeAt(n >>> 18);
    b64[o++] = B64_ALPHABET.charCodeAt((n >>> 12) & 63);
    b64[o++] = B64_ALPHABET.charCodeAt((n >>> 6) & 63);
    b64[o] = 61;
  }
  const parts: string[] = [];
  for (let s = 0; s < b64.length; s += FROM_CHAR_CHUNK) {
    parts.push(
      String.fromCharCode(
        ...b64.subarray(s, Math.min(s + FROM_CHAR_CHUNK, b64.length)),
      ),
    );
  }
  return parts.join("");
};
