import { ProviderError } from "../providers/http";
import { SILICONED_ADDON } from "../core/silicontrol";

/**
 * 原生浮窗任务栏的 JS 封装（native/SiliconedBridge/src/SiliconedBridgeToolbar.mm）。
 *
 * 绕开 UXP <dialog> 的三个硬伤——系统标题栏去不掉、UXP 无定位 API（依赖外部
 * AX 工具且首帧闪烁）、视觉受 Spectrum 限制。Native 侧直接创建无边框 NSPanel：
 * 无标题栏、出现即在目标位置、不抢 PS 焦点。
 *
 * 架构（见 .trae/documents/native-toolbar-plan.md）：JS 是唯一状态源，native
 * 只做「窗口壳 + 绘制 + 事件」——UI = f(state)。状态经 setToolbarState 单向
 * 推送（本模块做合并 + 去重），事件经 waitToolbarEvent 回传。
 *
 * 实验性：hybrid 官方只承诺「计算/逻辑」，画 UI 属未支持路径，PS 大版本
 * 更新需复测；若被破坏则回退 UXP dialog 方案。
 */

/** 浮窗 UI 事件（native 侧 JSON 字符串，这里解析） */
export interface ToolbarEvent {
  type: "click" | "input" | "error" | string;
  id?: string;
  /** input 事件：输入框实时草稿 */
  value?: string;
  /** error 事件：native 侧异常消息 */
  message?: string;
}

/** 推送给 native 的 UI 状态（字段缺省 = 不变化，native 侧保留旧值） */
export interface ToolbarUiState {
  mode?: "buttons" | "input" | "banner";
  status?: string;
  statusError?: boolean;
  busy?: boolean;
  /** 横幅淡出并自动收起（native 播完 2s 淡出动画后 orderOut，无需再调 hideToolbar） */
  fadeOut?: boolean;
  placeholder?: string;
  /** 输入框取值（进入输入态时清空 / 恢复草稿用） */
  value?: string;
}

interface ToolbarAddon {
  /** 显示浮窗：首次调用创建（PS 主线程），重复调用重新显示并重定位 */
  showToolbar(options?: { width?: number; height?: number }): Promise<void>;
  /** 收起浮窗（复用不销毁，可再次 show） */
  hideToolbar(): Promise<void>;
  /** 推送 UI 状态（native 侧 UI = f(state)） */
  setToolbarState(state: ToolbarUiState): Promise<void>;
  /** 等待下一个 UI 事件；返回 null 表示异常终止 */
  waitToolbarEvent(): Promise<{ raw: string } | null>;
}

/** require 返回 Promise；缓存成功实例，失败时清空以允许重载插件后重试 */
let addonPromise: Promise<ToolbarAddon> | null = null;

const loadAddon = (): Promise<ToolbarAddon> => {
  if (!addonPromise) {
    addonPromise = Promise.resolve()
      .then(() => Promise.resolve(require(SILICONED_ADDON) as ToolbarAddon | Promise<ToolbarAddon>))
      .then((addon) => {
        const fns = ["showToolbar", "hideToolbar", "setToolbarState", "waitToolbarEvent"] as const;
        for (const fn of fns) {
          if (!addon || typeof addon[fn] !== "function") {
            throw new Error(`addon 未导出 ${fn}（可能需要重新构建 native 组件）`);
          }
        }
        return addon;
      })
      .catch((err) => {
        addonPromise = null;
        throw new ProviderError(
          "terminal",
          `无法加载原生浮窗组件：${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
  return addonPromise;
};

/** 显示原生浮窗。默认尺寸 430×82；位置由 native 侧决定（右缘贴屏幕中线、底缘 1/4）。 */
export const showToolbar = async (options?: { width?: number; height?: number }): Promise<void> => {
  const addon = await loadAddon();
  await addon.showToolbar(options);
};

const hideAddonToolbar = async (): Promise<void> => {
  const addon = await loadAddon();
  await addon.hideToolbar();
};

/**
 * 推送 UI 状态：本地合并缓存（JS 是唯一状态源，缓存全量），与缓存一致的推送
 * 直接跳过（幂等）。收起浮窗时清缓存，下次显示必然推送全量状态。
 */
let pushedState: ToolbarUiState = {};

const shallowEqualState = (a: ToolbarUiState, b: ToolbarUiState): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
};

export const setToolbarState = async (patch: ToolbarUiState): Promise<void> => {
  const next = { ...pushedState, ...patch };
  if (shallowEqualState(next, pushedState)) {
    return;
  }
  pushedState = next;
  const addon = await loadAddon();
  await addon.setToolbarState(next);
};

/** 收起浮窗并清空状态缓存（下次显示必然全量重推）。 */
export const hideToolbar = async (): Promise<void> => {
  pushedState = {};
  await hideAddonToolbar();
};

/** 等待下一个浮窗 UI 事件（点击 / 输入 / native 错误）。 */
export const waitToolbarEvent = async (): Promise<ToolbarEvent | null> => {
  const addon = await loadAddon();
  const raw = await addon.waitToolbarEvent();
  if (!raw || !raw.raw) return null;
  try {
    return JSON.parse(raw.raw) as ToolbarEvent;
  } catch {
    return { type: "unknown" };
  }
};
