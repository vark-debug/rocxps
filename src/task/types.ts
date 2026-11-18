import type { Rect } from "../ps/types";

/**
 * 任务生命周期（docs/local-redraw-plan.md §5）。
 *
 * draft → capturing → queued → generating → placing → done
 *                                ↘ failed / cancelled / needsAttention
 */
export type TaskStatus =
  | "draft"
  | "capturing"
  | "queued"
  | "generating"
  | "placing"
  | "done"
  | "failed"
  | "cancelled"
  | "needsAttention";

/** 终态（任务不再自动流转，仅允许用户重试/重贴/删除）。 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "done",
  "failed",
  "cancelled",
  "needsAttention",
];

export interface RedrawTask {
  id: string;
  /** 捕获时的 PS 文档 id：贴回时按它定位（不要求文档是前台）。 */
  docId: number;
  /** 文档名快照，文档关闭后 UI 仍可展示。 */
  docName: string;
  /** 捕获时的文档路径与画布尺寸：id 失效（关闭重开）时做唯一匹配。 */
  docPath?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  prompt: string;
  status: TaskStatus;
  /** 对齐后的发送区域（画布坐标）。 */
  regionBounds?: Rect;
  /** 发送区域尺寸。 */
  regionWidth?: number;
  regionHeight?: number;
  /** 实际请求模型的尺寸（可能因像素上下限放大/缩小）。 */
  requestSize?: string;
  modelId?: string;
  error?: string;
  createdAt: number;
  capturedAt?: number;
  generatedAt?: number;
  placedAt?: number;
}
