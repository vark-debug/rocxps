# Siliconed 内置化与插件内模型下载 — 计划文档

分支：`feat/bundle-siliconed`（基于 main @ 22ec4df）

## 0. 目标

现状用户要走三步手动流程：安装 Siliconed.app → 在 app 内安装模型并接受许可 → 手动填写 silicontrol 路径。

目标：
1. **插件内置 Siliconed.app**（本体仅 24MB，可随包分发），插件内一键完成安装与启动；
2. **模型在插件内点击下载**：插件展示模型/许可/体积，用户确认后触发下载并显示进度；
3. 生成工作流（mask 移除 / 扩图 / Prompt Lab）零改动，只是 `siliconedCliPath` 的来源变为插件安装产物。

## 1. 调查结论（实测数据）

### 1.1 执行链路现状（本仓库代码）

- 插件无法起子进程，命令执行由 Hybrid Addon（`SiliconedBridge.uxpaddon`）完成；
  [RocXBridge.cpp](file:///Users/xucangshu/Desktop/PRAI/rocxps/native/SiliconedBridge/src/RocXBridge.cpp) 暴露 `runCommand({ exe, args, cwd, timeoutMs })`；
  [SiliconedBridgeCommand.mm](file:///Users/xucangshu/Desktop/PRAI/rocxps/native/SiliconedBridge/src/SiliconedBridgeCommand.mm) 用 `posix_spawn` 直接起任意绝对路径的二进制，**无白名单**。
- 结论：addon 不改一行，即可执行 `ditto`（解包拷贝 app）、`xattr`（清除隔离）、`open`（启动应用）等系统命令——安装器全部能力已在手。
- CLI 通信：silicontrol 与 Siliconed.app 之间走 UDS socket（`~/Library/Application Support/Siliconed/silicontrol.sock`）；除 `help` 外的任何命令都会自动拉起 app。

### 1.2 Siliconed.app 实测（本机 v0.21）

| 项 | 数据 |
| --- | --- |
| 体积 | 24MB（Helpers/siliconed 8.7MB + silicontrol 434KB + 本地化资源 + 主二进制） |
| 结构 | `Contents/{MacOS/Siliconed, Helpers/{siliconed, silicontrol}, Resources（12 语言）, _CodeSignature}`，**无符号链接** |
| 签名 | **ad-hoc（TeamIdentifier=not set，未公证）** |
| 模型库 | `~/Library/Application Support/Siliconed/`（本机 30GB）：`store/`（模型+LoRA）、`models/seedvr2-3b-int8`（4.4GB）、`accepted-licenses.json`、`cache` |
| 下载源 | hf-mirror.com（app 自行下载，**断点续传**：已下载文件保留） |

签名是分发链路的关键约束：ad-hoc + 未公证 → 任何"从网络获得"的副本都带 `com.apple.quarantine`，直接打开会被 Gatekeeper 拦截；拷贝到用户目录后用 `xattr -rd com.apple.quarantine` 清除即可正常运行（本地 ad-hoc 签名应用清除隔离后可正常启动）。

### 1.3 模型安装机制（CLI 0.21 help 实测）

- `install ID [--standard|--compact|--light]`：**命令本身不下载任何东西**——打开 app 的 Models sheet，展示许可与体积，用户在 **app 内**点 Accept and Install 才开始下载；
- `install seedvr2`：Siliconed 自带的超分权重（4.4GB），**无自有许可，命令返回即开始下载**；
- `install writer`：Prompt Lab 的 writer（1.25GB），同样无自有许可、立即下载；
- `install stop`：停止安装（下载文件保留）；
- 进度可见性：`status` → `installing{title, last}`（人读文本，**无结构化字节进度**）；
- `models` 输出（每 ID）：`license` / `license_accepted` / `license_urls` / `ready` / `variants`（standard/compact/light + disk_bytes）/ `missing` / `install` 建议命令；
- 本机 5 模型：z-image（Apache 2.0）、qwen-image-2.1（Qwen Research 非商用；compact 17.3GB，已就绪）、anima（非商用）、krea2（<$1M 商用）、moss-image（Apache 2.0）。

### 1.4 无 UI 运行实测（headless 行为）

- **CLI 自动拉起 = 带窗口**：silicontrol 拉起的 app 实例注册为 `type="Foreground"`（LaunchServices `lsappinfo` 实测）且带 1 个可见窗口——现状下生成、装模型都会把 UI 弹到屏幕上；
- **无独立守护进程**：`silicontrol.sock` 由主应用进程（`MacOS/Siliconed`）监听，引擎与 UI 同进程；`Helpers/siliconed` 是内核自检工具（`check` 命令族），不是可独立运行的服务；
- **闲置自动退出**：CLI 拉起的实例空闲后会自行退出（实测 PID 自灭），对「用完即收」友好；
- 结论：**要做到生成与下载全程不弹 UI，必须修改 Siliconed 源码**（见 2.4 第 1 条：后台拉起模式）。插件侧无法缓解——拉起方式由 CLI 内部决定，插件控制不了。

### 1.5 UXP 打包约束

- `copyZipAssets: ["public-zip/*"]` 的文件会进 `.ccx`/`.zip` 包（vite-uxp-plugin）；当前 dist 仅 3.2MB；
- **Adobe Developer Console（Marketplace）上传上限 50MB**；直装 `.ccx`（UPIA/Creative Cloud 拖装）无文档化体积限制；
- 插件包内文件运行时可经 UXP storage API 读取（`getPluginFolder()` 只读二进制读）；data folder 的 `nativePath` 在既有代码中已大量使用（队列落盘、临时工作区）；
- Siliconed 仅提供 macOS 版：安装流程仅对 macOS 生效，其他宿主平台显示不支持。

## 2. 方案设计

### 2.1 总体架构（不变量）

渲染引擎始终是 Siliconed.app；插件只新增「安装器 + 模型管理」。CLI 调用链完全复用（[silicontrol.ts](file:///Users/xucangshu/Desktop/PRAI/rocxps/src/core/silicontrol.ts) 的 `siliconModels`/`siliconStatus` 已具备解析能力），唯一变化是 `siliconedCliPath`（[settings/types.ts](file:///Users/xucangshu/Desktop/PRAI/rocxps/src/settings/types.ts#L102)）的写入来源。

### 2.2 A 层：内置 Siliconed.app 与安装器（M1）

**打包**：
- 构建脚本新增：`ditto -c -k --keepParent Siliconed.app` 生成 `public-zip/Siliconed.app.zip`（`--keepParent` 保留 .app 目录结构；ditto 保留权限位/元数据，规避 zip 往返丢可执行位的问题），同时生成 `public-zip/Siliconed.version.json`（版本号，用于升级比对；JS 端读不了 plist）；
- Siliconed.app 由用户侧提供（前提：作者确认可随插件再分发）。

**安装流程**（`installBundledSiliconed()`，纯编排，全部走现有 addon）：
1. 探测既有安装：`/Applications/Siliconed.app` → `~/Applications/Siliconed.app`；命中则直接写 `siliconedCliPath` 并跳过安装（**避免双实例争抢 UDS socket**）；
2. 未命中：从插件包读 `Siliconed.app.zip`（storage binary read，约 10MB）→ 写入 data folder 临时文件 →
   `runCommand(/usr/bin/ditto, ["-x","-k", zipPath, destDir])`（dest 先试 `/Applications`，admin 用户无需 sudo；失败回退 `~/Applications`）→
   `runCommand(/usr/bin/xattr, ["-rd","com.apple.quarantine", appPath])` → 保险 `chmod +x` 两个 Helper →
   启动 app（`silicontrol open`，自动拉起）→ 写 `siliconedCliPath`；
3. 升级：`Siliconed.version.json` 版本号 > 已装版本 → 覆盖拷贝（模型库在共享 Application Support 目录，不受影响）；
4. 卸载/清理：不做（保留用户安装）。

**安装时机**：设置面板显式按钮（不自动安装——拷贝 app + 启动进程是显著副作用，需用户知情）；首次选择 Siliconed 模型时在主面板给出引导文案跳转。

### 2.3 B 层：模型管理 UI（M2/M3）

设置面板 Siliconed 区新增「模型管理」块：

- 数据：`siliconModels()` → 仅展示插件用到的模型：`qwen-image-2.1`（必装，mask 移除/扩图）、`writer`（Prompt Lab）、`seedvr2`（图层超分，当前功能下线但实现保留）；
- 每卡展示：名称、用途、许可名称、状态徽章（就绪 / 未安装 / 下载中 x%）、体积（compact 默认变体，可切换）、许可状态；
- 「下载 / 安装」按钮逻辑：
  - 无许可 或 已接受 → `install ID [变体]` → 轮询 `status.installing` + `models.ready`；
  - 有许可未接受 → 展示许可名称 + `license_urls` 链接 + 「我已阅读并接受」勾选 → 带 `--accept-license` 调 install（**依赖 CLI 改造**）；CLI 未改造时**降级路径**：直接 `install`（app 弹 Models sheet，用户在 app 内点接受），UI 给出明确提示；
  - 下载中：进度条 + 「停止」（`install stop`）；
- 主面板错误文案升级：Siliconed 未就绪 → 引导跳设置「安装 Siliconed / 模型管理」。

### 2.4 C 层：Siliconed CLI / 应用需要的修改（需要作者侧确认）

| # | 修改 | 必要性 | 说明 |
| --- | --- | --- | --- |
| 1 | **后台拉起模式**：CLI 自动拉起 app 时不显示主窗口（如 spawn 时传 `--background` 参数，app 检测后 `setActivationPolicy(.accessory)` 且不建主窗口；用户手动打开 app 时 UI 照常） | **必需** | 实测现状：CLI 拉起的实例是 Foreground + 可见窗口（见 1.4）。生成与模型下载都会弹 UI。插件侧无法控制拉起方式，只能由 Siliconed（app + CLI 配合）改 |
| 2 | `install ID --accept-license`（不弹 Models sheet，headless 开始下载） | **必需** | 否则带许可的模型（qwen/z-image/anima/krea2/moss）无法在插件内一键装。许可展示与接受由插件完成（渲染名称 + license_urls + 勾选框）。合规确认点：非商用许可由"插件展示原文/链接+用户勾选"代替"app 内点击接受"是否满足许可方要求——需与模型发布方确认 |
| 3 | `status.installing` 增加结构化进度（`bytes_downloaded`/`bytes_total` 或 fraction） | 建议 | 现在只有人读文本，插件只能显示不定进度；有字段可显示真实进度条 |
| 4 | 待确认：许可已接受的模型再次 `install`（如换变体）是否仍弹 Models sheet | 待确认 | 若弹，建议并入 `--accept-license` 语义（已接受即不弹） |

**不需要修改的**：变体选择（`--standard/--compact/--light` 已有）、断点续传（已有）、`install stop`（已有）、writer/seedvr2 的无许可直装（已有）。

### 2.5 里程碑

- **M1** 打包与安装基座：`public-zip/Siliconed.app.zip` + 版本 json + 打包脚本接线；`installBundledSiliconed()`（探测/拷贝/去隔离/启动/写设置/升级覆盖）；纯函数（安装计划：目标目录决策、版本比对、zip 写入计划）+ 单测
- **M2** 设置面板安装 UI：「安装 Siliconed」按钮、状态卡（未安装/安装中/已装 vX.Y）、进度反馈、cliPath 自动写入
- **M3** 模型管理 UI：模型卡列表、许可展示与勾选、下载/停止、进度轮询、CLI 未改造降级路径
- **M4** 主面板引导文案 + 全量测试（npm test / build）+ 真机验证

### 2.6 真机验证清单

1. 移走 `/Applications/Siliconed.app` → 插件内安装 → quarantine 清除 → app 启动 → silicontrol 全链路正常；
2. 已装旧版 → 升级覆盖路径；
3. 非 admin 用户 → `~/Applications` 回退；
4. `getPluginFolder()` 二进制读取在 CCX 安装态（非 UDT）下的兼容性——**实测第一优先**；
5. 模型下载：已接受许可模型的 install 行为（是否弹 sheet）、`install stop`、断点续传；
6. CCX 包体积实测（预计 10–15MB，离 50MB 限制有余量）。

## 3. 风险与待确认项

| # | 风险 | 处置 |
| --- | --- | --- |
| 1 | ad-hoc 签名 + 未公证：依赖 `xattr` 清隔离；Apple 政策可能收紧 | 当前为标准做法；长期建议 Siliconed 做 Developer ID 签名 + 公证（作者侧决定） |
| 2 | Siliconed.app 随插件再分发的授权 | 需作者确认（前提条件） |
| 3 | `getPluginFolder` 读取包内二进制在 CCX 安装态的行为 | 设计上只依赖 storage API（不依赖 nativePath），风险低，仍列实测项 |
| 4 | headless 接受许可的合规等效性 | 需与模型发布方确认；不通过则走 app 内 sheet 的降级路径 |
| 5 | 双副本争抢 UDS socket | 探测优先复用既有安装；插件仅在完全无安装时落一份 |
| 6 | Marketplace 50MB 上限 | 内置后预计 ~13MB（zip），安全；若未来 app 增大，备选方案=首次运行从服务器下载 app |

## 4. 明确不做

- 不绕过许可（不写 `accepted-licenses.json`，接受动作始终可见）；
- 不捆绑模型文件（GB 级，由 Siliconed 自带下载机制完成）；
- 不改 addon 二进制（`runCommand` 能力已覆盖全部需求）。
