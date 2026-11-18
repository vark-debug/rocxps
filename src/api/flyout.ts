import { uxp } from "../globals";

export type FlyoutMenuItem = {
  id: string;
  label: string;
  enabled?: boolean;
  checked?: boolean;
  submenu?: FlyoutMenuItem[];
};

/**
 * Flyout（弹出式菜单）项。
 *
 * 在 Photoshop 里，这个菜单显示在**面板标题栏右上角的 ☰ 按钮**中，
 * 点它才会展开。菜单项不能在 manifest.json 里静态声明，
 * 只能在运行时通过 uxp.entrypoints.setup() 注册。
 */
export const FLYOUT_MENU_ITEMS: FlyoutMenuItem[] = [
  { id: "flyout.reload", label: "重新加载插件" },
  { id: "flyout.increment", label: "计数器 +1" },
  { id: "flyout.alert", label: "在 Photoshop 里弹个窗" },
  { id: "flyout.separator", label: "-" },
  {
    id: "flyout.more",
    label: "更多",
    submenu: [{ id: "flyout.more.docs", label: "打开 UXP 文档" }],
  },
];

type FlyoutListener = (id: string) => void;

const listeners = new Set<FlyoutListener>();

/** 订阅 flyout 菜单项的点击事件，返回取消订阅函数 */
export const onFlyoutInvoke = (listener: FlyoutListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * 注册 flyout 菜单。
 *
 * 注意：entrypoints.setup() 每个插件生命周期内只能调用一次，
 * 重复调用会抛 EntryPointsError，所以这里用全局标记兜底（热重载会重新执行模块）。
 */
export const setupFlyoutMenu = () => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.__ROCXPS_FLYOUT_SETUP__) return;
  g.__ROCXPS_FLYOUT_SETUP__ = true;

  // 面板 id 以插件 id 为前缀（uxp.config.ts 里是 `${id}.main`）。
  // 打包成 ccx 时插件 id 会带宿主后缀（如 com.rocxps.uxp_ps），面板 id 同步变化，
  // 所以这里用运行时插件 id 拼，而不是写死字符串。
  const pluginId = uxp.entrypoints?._pluginInfo?.id;
  if (!pluginId) {
    console.warn("Flyout menu skipped: no plugin id available");
    return;
  }
  const mainPanelId = `${pluginId}.main`;

  try {
    uxp.entrypoints.setup({
      panels: {
        [mainPanelId]: {
          // 面板内容由 React 渲染，show 里不需要额外初始化
          show() {},
          menuItems: FLYOUT_MENU_ITEMS,
          invokeMenu(id: string) {
            listeners.forEach((listener) => listener(id));
          },
        },
      },
    });
  } catch (e) {
    console.error("Flyout menu setup failed", e);
  }
};
