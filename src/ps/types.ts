/** PS 文档内的矩形区域，坐标为画布像素，right/bottom 为开区间（不含该像素）。 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 补边导出模式信息：对齐区域超出画布时，发送前用边缘像素延展填充画布外部分。 */
export interface PadInfo {
  /** 虚拟区域相对画布的偏移（选区贴近画布左/上边缘且放不下时为负）。 */
  padLeft: number;
  padTop: number;
  /** 虚拟区域超出画布右/下边缘的像素数（贴回裁剪用）。 */
  padRight: number;
  padBottom: number;
  /** 虚拟区域尺寸（已对齐），贴回时先裁掉补边再对齐。 */
  width: number;
  height: number;
}

/** 选区对齐扩展的输出（docs/local-redraw-plan.md §4）。 */
export interface ExpandedRegion {
  /** 实际发送给模型的区域（已对齐，完整包含原选区；补边模式下可能超出画布）。 */
  bounds: Rect;
  width: number;
  height: number;
  /** 画布放不下对齐倍数时的补边信息。 */
  padInfo?: PadInfo;
}
