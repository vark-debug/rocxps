import { UXP_Manifest, UXP_Config, UXP_Config_Extra } from "vite-uxp-plugin";
import { version } from "./package.json";

const extraPrefs: UXP_Config_Extra = {
  hotReloadPort: 8080,
    copyZipAssets: ["public-zip/*"],
  uniqueIds: true,
  debugger: "udt",
};

export const id = "com.rocxps.uxp"; 
const name = "rocxps"; 

const manifest: UXP_Manifest = {
  id,
  name,
  version,
  main: "index.html",
  manifestVersion: 6,
  host: [
    {
      app: "PS",
      minVersion: "24.2.0",
    },
                      ],
  /**
   * Adobe UXP Hybrid Plugin addon 声明。
   *
   * 约定（与 RocX 一致，由 vite-uxp-plugin 的 copyHybridBinaries 保证）：
   * - 源目录：<root>/public-hybrid/{mac,win}/<arch>/SiliconedBridge.uxpaddon
   * - 构建后：dist/mac/arm64/SiliconedBridge.uxpaddon（不是 dist 根目录）
   * - 插件内加载：require("SiliconedBridge.uxpaddon")，此处 name 只写文件名，不带路径
   */
  addon: {
    name: "SiliconedBridge.uxpaddon",
  },
  entrypoints: [
    {
      type: "panel",
      id: `${id}.main`,
      label: {
        default: name,
      },
      minimumSize: { width: 290, height: 300 },
      maximumSize: { width: 2000, height: 2000 },
      // 紧凑布局：编辑区固定 + 队列弹性，默认高度从 740 收到 460
      preferredDockedSize: { width: 330, height: 460 },
      preferredFloatingSize: { width: 330, height: 460 },
      icons: [
        {
          width: 23,
          height: 23,
          path: "icons/dark.png",
          scale: [1, 2],
          theme: ["darkest", "dark", "medium"],
        },
        {
          width: 23,
          height: 23,
          path: "icons/light.png",
          scale: [1, 2],
          theme: ["lightest", "light"],
        },
      ],
    },


    // * Example of a UXP Secondary panel
    // * Must also enable the <uxp-panel panelid="bolt.uxp.plugin.settings">
    //* tag in your entrypoint (.tsx, .vue, or .svelte) file
    {
      type: "panel",
      id: `${id}.settings`,
      label: {
        default: `${name} Settings`,
      },
      minimumSize: { width: 330, height: 400 },
      maximumSize: { width: 2000, height: 2000 },
      preferredDockedSize: { width: 370, height: 600 },
      preferredFloatingSize: { width: 370, height: 600 },
      icons: [
        {
          width: 23,
          height: 23,
          path: "icons/dark-panel.png",
          scale: [1, 2],
          theme: ["darkest", "dark", "medium"],
          species: ["chrome"],
        },
        {
          width: 23,
          height: 23,
          path: "icons/light-panel.png",
          scale: [1, 2],
          theme: ["lightest", "light"],
          species: ["chrome"],
        },
      ],
    },

    // 选区浮层（实验）：独立面板，事件驱动 + 可见时保底轮询
    {
      type: "panel",
      id: `${id}.selection`,
      label: {
        default: `${name} Selection`,
      },
      minimumSize: { width: 290, height: 160 },
      maximumSize: { width: 2000, height: 2000 },
      preferredDockedSize: { width: 330, height: 200 },
      preferredFloatingSize: { width: 330, height: 200 },
      icons: [
        {
          width: 23,
          height: 23,
          path: "icons/dark-panel.png",
          scale: [1, 2],
          theme: ["darkest", "dark", "medium"],
          species: ["chrome"],
        },
        {
          width: 23,
          height: 23,
          path: "icons/light-panel.png",
          scale: [1, 2],
          theme: ["lightest", "light"],
          species: ["chrome"],
        },
      ],
    },

    // * Example of a UXP Command
    // {
    //   type: "command",
    //   id: "showAbout",
    //   label: {
    //     default: "Bolt UXP Command",
    //   },
    // },

  ],
  featureFlags: {
    enableAlerts: true,
  },
  requiredPermissions: {
    /** Adobe UXP Hybrid Plugin 加载 .uxpaddon 必须开启 */
    enableAddon: true,
    localFileSystem: "request",
    launchProcess: {
      schemes: ["https", "slack", "file", "ws"],
      extensions: [".xd", ".psd", ".bat", ".cmd", ""],
    },
    // 多平台生图需要访问任意用户自定义地址（RunningHub / 本地 ComfyUI / 自定义接口），
    // Adobe 文档允许 domains: "all"；vite-uxp-plugin 的类型只声明了 string[]，故强制转换
    network: {
      domains: "all" as unknown as string[],
    },
    clipboard: "readAndWrite",
    webview: {
      allow: "yes",
      allowLocalRendering: "yes",
      domains: "all",
      enableMessageBridge: "localAndRemote",
    },
    ipc: {
      enablePluginCommunication: true,
    },
    allowCodeGenerationFromStrings: true,

  },
    icons: [
    {
      width: 48,
      height: 48,
      path: "icons/plugin-icon.png",
      scale: [1, 2],
      theme: ["darkest", "dark", "medium", "lightest", "light", "all"],
      species: ["pluginList"],
    },
  ],
};

export const config: UXP_Config = {
  manifest,
  ...extraPrefs,
};
