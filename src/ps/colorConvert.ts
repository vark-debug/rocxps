/**
 * ProPhoto（ROMM RGB，D50 白点）→ sRGB（D65 白点）本地矩阵转换
 * （纯函数、零依赖，可在 Node 单测）。
 *
 * 背景：imaging.getPixels 的转换读（colorProfile:"sRGB IEC61966-2.1"）在
 * 16 位 PSB 文档上会触发 -32005 毒化错误（详见 capture.ts「原生位深回退」）。
 * 回退读拿到的是文档原生编码像素（ProPhoto 解码 TRC + ProPhoto 原色 +
 * D50 白点），宿主不再代做色彩转换，送图给生成模型前必须本地转回 sRGB，
 * 否则送出图明显偏色。
 *
 * 管线：
 * 1. ProPhoto 解码 TRC：v < 1/32 线性段 v/16，否则 v^1.8；
 * 2. 线性 RGB（ProPhoto 原色，D50）→ XYZ(D50)（ICC 官方矩阵）；
 * 3. Bradford 色适应 XYZ(D50) → XYZ(D65)；
 * 4. XYZ(D65) → sRGB 线性 RGB；
 * 5. sRGB 编码 TRC：L ≤ 0.0031308 → 12.92L，否则 1.055·L^(1/2.4) − 0.055。
 *
 * 复合矩阵在模块加载时一次性算好；ProPhoto 色域超出 sRGB 时裁剪到 [0,1]，
 * 与 Photoshop「转换为配置文件」默认（相对比色）近似一致。
 */

/** 3×3 行主序矩阵。 */
type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** 矩阵乘法（列向量约定：先应用 b 再应用 a）。 */
const mul3 = (a: Mat3, b: Mat3): Mat3 => {
  const v: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      v[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]];
};

/** ProPhoto 原色 → XYZ（D50 白点），ICC 官方矩阵。 */
const PRO_PHOTO_TO_XYZ_D50: Mat3 = [
  0.7976749, 0.1351917, 0.0313534, 0.2880402, 0.7118741, 0.0000857, 0.0, 0.0,
  0.82521,
];

/** Bradford 色适应：XYZ(D50) → XYZ(D65)。 */
const BRADFORD_D50_TO_D65: Mat3 = [
  0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077,
  0.0122982, -0.020483, 1.3299098,
];

/** XYZ（D65 白点）→ sRGB 线性 RGB。 */
const XYZ_D65_TO_SRGB: Mat3 = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556,
  0.0556434, -0.2040259, 1.0572252,
];

/**
 * 复合矩阵：ProPhoto 解码后的线性 RGB（D50）→ sRGB 线性 RGB（D65）。
 * 导出仅供单测做白点守恒 sanity 校验。
 */
export const LINEAR_PRO_PHOTO_TO_SRGB: Mat3 = mul3(
  mul3(XYZ_D65_TO_SRGB, BRADFORD_D50_TO_D65),
  PRO_PHOTO_TO_XYZ_D50,
);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** ProPhoto 解码 TRC：v < 1/32 走线性段 v/16，否则 v^1.8（[0,1] → [0,1]）。 */
export const decodeProPhoto = (v: number): number =>
  v < 1 / 32 ? v / 16 : Math.pow(v, 1.8);

/** sRGB 编码 TRC：L ≤ 0.0031308 → 12.92L，否则 1.055·L^(1/2.4) − 0.055。 */
export const encodeSrgb = (v: number): number =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

/**
 * 单像素转换：ProPhoto 编码 [0,1] → sRGB 编码 [0,1]（越界裁剪）。
 * 中性色保持中性，黑点 / 白点严格映射到 0 / 1。
 */
export const proPhotoToSrgb = (
  r: number,
  g: number,
  b: number,
): [number, number, number] => {
  const lr = decodeProPhoto(r);
  const lg = decodeProPhoto(g);
  const lb = decodeProPhoto(b);
  const m = LINEAR_PRO_PHOTO_TO_SRGB;
  return [
    encodeSrgb(clamp01(m[0] * lr + m[1] * lg + m[2] * lb)),
    encodeSrgb(clamp01(m[3] * lr + m[4] * lg + m[5] * lb)),
    encodeSrgb(clamp01(m[6] * lr + m[7] * lg + m[8] * lb)),
  ];
};

/**
 * 查表加速：解码侧 8 位输入恰为 256 个离散值，模块加载时预计算全部精确解码
 * 结果（Float64，零精度损失）；编码侧把线性值按 2^16 桶预量化（桶间距
 * 1/65536，sRGB 编码斜率最大 12.92，字节级量化误差 < 0.05，加末尾取整
 * 合计与精确管线差 ≤ 1 字节）。热路径无 Math.pow、无元组分配。
 */
const DECODE8 = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  DECODE8[i] = decodeProPhoto(i / 255);
}

const ENCODE_LUT = new Uint8Array((1 << 16) + 1);
for (let k = 0; k <= 1 << 16; k++) {
  const v = 255 * encodeSrgb(k / 65536);
  ENCODE_LUT[k] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * RGBA8 缓冲就地转换：按 ProPhoto 解释 RGB 通道并转为 sRGB 编码，
 * alpha 通道不动。capture 原生位深回退路径专用（见 capture.ts）。
 * 紧凑内联循环：3 次解码查表 + 9 乘 6 加 + 3 次编码查表，无逐像素分配。
 */
export const convertRgbaProPhotoToSrgb = (rgba: Uint8Array): void => {
  const m = LINEAR_PRO_PHOTO_TO_SRGB;
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    const lr = DECODE8[rgba[i]];
    const lg = DECODE8[rgba[i + 1]];
    const lb = DECODE8[rgba[i + 2]];
    let lin = m[0] * lr + m[1] * lg + m[2] * lb;
    lin = lin < 0 ? 0 : lin > 1 ? 1 : lin;
    rgba[i] = ENCODE_LUT[(lin * 65536 + 0.5) | 0];
    lin = m[3] * lr + m[4] * lg + m[5] * lb;
    lin = lin < 0 ? 0 : lin > 1 ? 1 : lin;
    rgba[i + 1] = ENCODE_LUT[(lin * 65536 + 0.5) | 0];
    lin = m[6] * lr + m[7] * lg + m[8] * lb;
    lin = lin < 0 ? 0 : lin > 1 ? 1 : lin;
    rgba[i + 2] = ENCODE_LUT[(lin * 65536 + 0.5) | 0];
  }
};
