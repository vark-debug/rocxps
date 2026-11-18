/**
 * 像素对齐的单一真相源。
 *
 * 捕获区域是所有 provider 的共同输入，取最严约束（32）：
 * - Qwen-Image-2.1 / Siliconed：宽高必须是 32 的倍数（且单边 ≥ 512）
 * - 其余平台通常只需 8/16 的倍数，32 同时满足
 *
 * 模型各自的请求尺寸对齐由 CatalogModel.sizeAlign 声明（默认 8），
 * 不要在这里按平台分支。
 */
export const CAPTURE_ALIGN = 32;

/** 向上取整到 align 的倍数。 */
export const alignUp = (value: number, align: number = CAPTURE_ALIGN): number =>
  Math.ceil(value / align) * align;

/** 向下取整到 align 的倍数。 */
export const alignDown = (value: number, align: number = CAPTURE_ALIGN): number =>
  Math.floor(value / align) * align;
