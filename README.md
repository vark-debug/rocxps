# AI 局部重绘（Photoshop UXP 插件）

在 Photoshop 里框选一块区域，写一句提示词，让 AI 平台重绘或擦除选区内容，再把结果按原尺寸自动贴回画布。

- 插件 ID：`com.rocxps.uxp`
- 宿主：Photoshop 24.2 及以上（UXP）
- 界面：React + TypeScript + Vite + Sass（UXP Spectrum 控件）
- 技术底座：[Bolt UXP](https://hyperbrew.co/resources/bolt-uxp)

## 功能

- **选区捕获**：按预设比例或 32px 对齐扩展选区、分块读取大画布（避免一次性读整张图）、生成发送图与黑白蒙版。
- **多平台生成**：火山方舟、RunningHub、本地 Siliconed、本地 IOPaint、自定义 HTTP 接口（ComfyUI 已实现但暂时隐藏）。
- **任务队列**：单飞/并发调度、落盘持久化（面板关闭不丢任务）、暂停/恢复、单条删除、取消、重试、手动贴回、清空已完成、折叠。
- **自动贴回**：结果按扩展区域缩放回画布，支持图层蒙版 / 像素蒙版 / 整块替换三种模式。
- **提示词模板**：主面板两行三列共 6 个槽位，可绑定不同服务商。
- **跨机计算**（Siliconed）：可指定已配对的 Mac 执行渲染，提交前校验实际计算目标。
- **图层超分**：SeedVR2 相关代码已保留，入口暂时关闭（`UPSCALE_ENABLED = false`）。

## 支持的生图平台

| 平台 | 模型 / 能力 | 说明 |
| --- | --- | --- |
| 火山方舟 | Seedream 4.0 / 4.5 / 5.0 Lite / 5.0 Flash / 5.0 Pro、Seededit 3.0 | 默认 Seedream 4.0，需 API Key |
| RunningHub | 千问 2.0 图像编辑、Wan 2.2 图生图 | 需 API Key 与平台地址 |
| Siliconed（本地） | Qwen-Image-2.1 Turbo 编辑 | macOS + [Siliconed.app](https://siliconed.app)，走 Hybrid 插件调用 `silicontrol` |
| IOPaint（本地） | LaMa / MAT 擦除 | 需本地启动 IOPaint 服务（默认 `http://127.0.0.1:18088`） |
| 自定义 HTTP | 任意接口 | 自定义 URL、请求头、请求体模板与结果路径 |

占位符：请求头/请求体模板支持 `{{image}}`、`{{mask}}`、`{{prompt}}`、`{{width}}`、`{{height}}`、`{{apiKey}}`。

## 环境要求

- Node.js 18+
- [Adobe UXP Developer Tool (UDT)](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/installation/)
- Photoshop 24.2+，并在首选项里开启「开发者模式」
- 仅 Siliconed 本地推理需要：macOS、Xcode Command Line Tools、CMake（编译 `native/SiliconedBridge`）

## 安装与运行

```bash
npm i

# 构建（会先编译 native/SiliconedBridge，再打包前端）
npm run build

# 开发模式（监听源码变更）
npm run dev

# 单元测试
npm test
```

打包与安装：

```bash
npm run ccx            # 生成 .ccx 安装包
npm run ccx-install    # 安装 ccx 目录下的插件
npm run ccx-uninstall  # 卸载同名的已安装插件
```

在 UDT 里加载：`Add Plugin` → 选择 `dist/manifest.json` → `Load` → `Debug`（开发时用 `npm run dev` 自带的热重载，不要用 UDT 的 Load and Watch）。

## 使用流程

1. 在 Photoshop 里用选区工具框出要改的区域。
2. 打开插件面板，点「抓取选区」（换选区后点「重新抓取」）。
3. 填写提示词：
   - Siliconed：留空并选择「强制移除」或提示词为空 → 移除选区内容；填写内容 → 重绘。
   - 其他平台：描述想把选区改成什么。
4. 选择处理方式（仅 Siliconed）、点击「加入队列」。
5. 生成完成后默认自动贴回；关闭「自动贴回」则先预览，再在队列里点「贴回」。
6. 队列里可以取消、重试、重试贴回、再贴、删除单条、清空已完成，也可以收起队列让提示词框变高。

### 队列暂停 / 恢复

队列标题旁的「暂停队列」按钮是全局执行开关（空队列时也可见，适合「先暂停、再批量做选区」）：

- **暂停**：新任务照常入队落盘，只是不启动执行；正在渲染的任务会自然跑完（不会中断已提交的任务）。贴回不受暂停影响——已出结果的条目照常贴回。
- **恢复**：点「开始队列（积压 N）」立即按顺序执行积压任务。
- 暂停状态随队列持久化：重启 Photoshop 后仍是暂停状态，积压任务不会自动开跑。
- 容量语义：队列条目上限 20 只对「已结束」任务生效（完成/取消超量时自动淘汰最旧，失败任务不会被挤掉）；未执行任务（排队/渲染/贴回中）不计入上限，暂停期间可放心批量入队（失控保护 200 条）。

### 贴回模式

| 模式 | 行为 |
| --- | --- |
| 整块替换（默认） | 不做选区约束，直接覆盖扩展区域 |
| 图层蒙版 | 结果整块贴回，并给结果图层创建可继续编辑的图层蒙版，白色区域为原选区 |
| 像素蒙版 | 把选区蒙版烘焙进结果 alpha，只显示选区内像素 |

### 尺寸与蒙版规则

- 抓取图按预设比例或 32px 对齐扩展；自动模式下会挑选最接近的预设，避免把选区拉伸变形。
- Siliconed 的 patch 裁剪短边必须 ≥ 448px（约等于蒙版白区短边的 1.3 倍）。蒙版白区短边不足 384px 时会**自动沿短边居中补全选区**并填白蒙版；如果画布空间确实不够，才会提示失败。
- 结果会按扩展区域缩放回原尺寸，尺寸不一致时在队列条目里标注。

## 设置项

设置面板（`rocxps Settings`）中可配置：

- 服务商与模型、生成并发上限（默认 2；Siliconed / IOPaint 内部强制单队列）
- 尺寸规划：自动匹配预设 / 固定预设 / 兼容旧版 32 对齐
- 贴回模式、自动贴回、水印、固定的提示词后缀
- 单条请求超时（默认 5 分钟）
- 提示词模板（名称 / 提示词 / 绑定服务商，共 6 个槽位）
- 队列落盘上限（默认 2048MB，失败/取消项按 LRU 清理）与调试诊断开关
- 各平台专属参数（服务地址、请求体模板、Siliconed CLI 路径与计算目标、IOPaint 模型等）

API Key 保存在 UXP `secureStorage`（系统加密），其余设置保存在插件数据目录的 JSON 中：

```
~/Library/Application Support/Adobe/UXP/PluginsStorage/PHSP/<版本>/Developer/com.rocxps.uxp/PluginData/
├── redraw-queue.json          # 队列状态
└── redraw-queue/<jobId>/      # 输入图、蒙版、结果、缩略图
```

## 项目结构

```
src/
├── components/     # 主面板与设置面板（React）
├── ps/             # 选区捕获、贴回、预设尺寸、PNG/JPEG 编解码、分块读取、诊断
├── providers/      # 方舟 / RunningHub / Siliconed / IOPaint / ComfyUI / 自定义 HTTP
├── task/           # 队列、调度、执行器、提示词策略
├── core/           # silicontrol 调用、超分规划
├── settings/       # 设置与模板的读写
└── api/            # UXP / Photoshop 全局 API 封装
native/SiliconedBridge/   # UXP Hybrid 插件：执行 silicontrol 命令
docs/                     # 设计与联调文档
```

## 已知限制

- UXP 不是浏览器：不支持 `gap`、CSS 动画、`transform`、`object-fit` 等，样式实现均按 UXP 支持范围编写。
- Siliconed 依赖 `SiliconedBridge.uxpaddon` 与 `Siliconed.app`；插件清单已开启 `enableAddon` 权限。
- Hybrid 二进制改动后需要重新编译并重载插件（C++ 部分不支持热重载）。
- 生成期间不要裁切画布或修改分辨率，否则贴回位置可能错位（面板会提示）。
