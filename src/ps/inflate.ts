/**
 * 零依赖 DEFLATE 解压器（RFC 1951，puff 风格）。
 * PNG 的 IDAT 是 zlib 流（RFC 1950 包裹 DEFLATE），解码生成结果图必须解压；
 * UXP 无 Node zlib，第三方库不可靠，按参考项目思路自行实现。
 * 支持 stored / fixed / dynamic 三种块；BTYPE=11 保留位按损坏数据报错。
 */

const MAX_BITS = 15;

const LENS_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENS_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DISTS_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTS_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];

/** DEFLATE 按 LSB-first 读位；用 32 位整数缓冲替代逐位循环（大图性能关键）。 */
class BitReader {
  private bytes: Uint8Array;
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** 读取 n（1..24）位。 */
  bits(n: number): number {
    while (this.bitCount < n) {
      if (this.pos >= this.bytes.length) {
        throw new Error("DEFLATE：数据意外结束");
      }
      this.bitBuf |= this.bytes[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return value;
  }

  /** 字节对齐（stored 块前必须）：bits() 读取时 pos 已指向下一字节，残位直接丢弃即可。 */
  align(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  /** 对齐后的绝对字节位置。 */
  bytePos(): number {
    return this.pos;
  }

  seek(pos: number): void {
    this.pos = pos;
    this.bitBuf = 0;
    this.bitCount = 0;
  }
}

/** 规范哈夫曼表：counts[码长] = 该码长符号数；symbols 按 (码长, 码值) 排序。 */
interface Huffman {
  counts: Int32Array; // MAX_BITS + 1
  symbols: Int32Array;
}

const buildHuffman = (lengths: Uint8Array): Huffman => {
  const counts = new Int32Array(MAX_BITS + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) counts[lengths[i]]++;

  const offsets = new Int32Array(MAX_BITS + 2);
  for (let i = 1; i <= MAX_BITS; i++) offsets[i + 1] = offsets[i] + counts[i];

  const total = offsets[MAX_BITS + 1];
  const symbols = new Int32Array(total);
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym]) symbols[offsets[lengths[sym]]++] = sym;
  }
  return { counts, symbols };
};

/** 逐位解码一个符号（puff 经典算法：按码长分段二分）。 */
const decodeSymbol = (r: BitReader, h: Huffman): number => {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code |= r.bits(1);
    const count = h.counts[len];
    if (code - first < count) return h.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("DEFLATE：无效哈夫曼编码");
};

const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

/**
 * DEFLATE 解压；输出为独立 Uint8Array（避免大缓冲驻留）。
 * PNG IDAT 数据量可达数十 MB，实现以吞吐优先。
 */
export const inflate = (data: Uint8Array): Uint8Array => {
  const r = new BitReader(data);
  let out = new Uint8Array(Math.max(4096, data.length * 4));
  let len = 0;

  const ensure = (extra: number) => {
    if (len + extra <= out.length) return;
    let cap = out.length;
    while (cap < len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, len));
    out = next;
  };

  for (;;) {
    const isLast = r.bits(1) === 1;
    const blockType = r.bits(2);

    if (blockType === 0) {
      // stored：对齐后 LEN/NLEN + 原始字节
      r.align();
      const pos = r.bytePos();
      if (pos + 4 > data.length) throw new Error("DEFLATE：stored 块头越界");
      const storedLen = data[pos] | (data[pos + 1] << 8);
      const nlen = data[pos + 2] | (data[pos + 3] << 8);
      if ((storedLen ^ 0xffff) !== nlen) {
        throw new Error("DEFLATE：stored 块长度校验失败");
      }
      if (pos + 4 + storedLen > data.length) {
        throw new Error("DEFLATE：stored 块数据越界");
      }
      ensure(storedLen);
      out.set(data.subarray(pos + 4, pos + 4 + storedLen), len);
      len += storedLen;
      r.seek(pos + 4 + storedLen);
    } else {
      let litlen: Huffman;
      let dist: Huffman;
      if (blockType === 1) {
        // fixed：硬编码码长表
        const ll = new Uint8Array(288);
        ll.fill(8, 0, 144);
        ll.fill(9, 144, 256);
        ll.fill(7, 256, 280);
        ll.fill(8, 280, 288);
        const dl = new Uint8Array(30);
        dl.fill(5);
        litlen = buildHuffman(ll);
        dist = buildHuffman(dl);
      } else if (blockType === 2) {
        // dynamic：先解码长码的码长，再解两张表
        const hlit = r.bits(5) + 257;
        const hdist = r.bits(5) + 1;
        const hclen = r.bits(4) + 4;
        const clLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          clLens[CODE_LENGTH_ORDER[i]] = r.bits(3);
        }
        const clHuff = buildHuffman(clLens);

        const lens = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < hlit + hdist) {
          const sym = decodeSymbol(r, clHuff);
          if (sym < 16) {
            lens[i++] = sym;
          } else {
            let rep: number;
            let value: number;
            if (sym === 16) {
              if (i === 0) throw new Error("DEFLATE：重复码缺少前值");
              value = lens[i - 1];
              rep = 3 + r.bits(2);
            } else if (sym === 17) {
              value = 0;
              rep = 3 + r.bits(3);
            } else if (sym === 18) {
              value = 0;
              rep = 11 + r.bits(7);
            } else {
              throw new Error("DEFLATE：无效码长符号");
            }
            const end = Math.min(i + rep, hlit + hdist);
            while (i < end) lens[i++] = value;
          }
        }
        if (lens[256] === 0) throw new Error("DEFLATE：缺少块结束码");
        litlen = buildHuffman(lens.subarray(0, hlit));
        dist = buildHuffman(lens.subarray(hlit));
      } else {
        throw new Error("DEFLATE：无效块类型（11 保留位）");
      }

      // LZ77 解码循环
      for (;;) {
        const sym = decodeSymbol(r, litlen);
        if (sym < 256) {
          ensure(1);
          out[len++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          if (sym > 285) throw new Error("DEFLATE：长度符号越界");
          const li = sym - 257;
          const length =
            LENS_BASE[li] + (LENS_EXTRA[li] ? r.bits(LENS_EXTRA[li]) : 0);
          const dsym = decodeSymbol(r, dist);
          if (dsym > 29) throw new Error("DEFLATE：距离符号越界");
          const distance =
            DISTS_BASE[dsym] + (DISTS_EXTRA[dsym] ? r.bits(DISTS_EXTRA[dsym]) : 0);
          if (distance > len) throw new Error("DEFLATE：回溯距离超出输出起点");
          ensure(length);
          let src = len - distance;
          for (let k = 0; k < length; k++) {
            out[len++] = out[src++];
          }
        }
      }
    }

    if (isLast) break;
  }

  return out.slice(0, len);
};
