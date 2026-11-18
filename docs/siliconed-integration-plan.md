# Siliconed 接入 + 32 像素对齐 实施计划

> 状态：待评审
> 日期：2026-11-03
> 前置调研：`docs/local-redraw-plan.md`（现有 Ark/ComfyUI 管线）
> 关键外部事实来源：Adobe UXP Hybrid 文档、本机实测 `silicontrol`、`RocX/native/RocXBridge` 源码

---

## 0. 总览

### 0.1 两条工作流与顺序

```
工作流 A（Siliconed 接入，UXP Hybrid Addon）
  A0 可行性验证 ──★ 定生死（PS 里 addon 能否加载 + silicontrol status 能否跑通）
      │
      ▼
  A1 addon 工程化（manifest / 构建顺序 / 产物目录 / .gitattributes）
      │
      ├──────────────┐
      ▼              ▼
  A2 silicontrol   A3 provider 接入
      │               │
      └───────┬───────┘
              ▼
  A4 异步 + 进度 UI
              │
              ▼
  A5 贴回 + 端到端验收   ←── 需要 B 的补边实现（B4）先完成

工作流 B（8 → 32 对齐）
  B1 存量排查（本文 §5 已完成）
      │
      ▼
  B2 常量与工具函数统一（ps/geometry.ts + ark/sizeStrategy.ts）
      │
      ├── B3 单测改写（可与 A1/A2/A3 并行）
      ▼
  B4 补边模式实现（现有 capture.ts 直接抛错，改 32 后触发概率上升）
      │
      ▼
  B5 三家 provider 回归
```

### 0.2 工作量

| 阶段 | 内容 | 人日 |
|---|---|---|
| A0 | 可行性验证（含裁剪 addon、编译、PS 内加载） | 0.5 |
| A1 | addon 工程化（manifest、构建顺序、产物、git 属性） | 0.5 |
| A2 | `src/core/silicontrol.ts` 封装 | 0.5 |
| A3 | provider 接入（siliconed.ts / catalog / index / settings / UI） | 0.5 |
| A4 | 异步与进度 UI、并发语义 | 0.5 |
| A5 | 贴回与端到端验收 | 1.0 |
| **A 小计** | | **3.0（区间 2.5–3.5）** |
| B1–B3 | 排查（已完成）+ 常量统一 + 单测改写 | 0.5 |
| B4 | 补边模式实现（画布放不下 32 对齐区域） | 0.5 |
| B5 | 三 provider 回归 + 边界用例 | 0.5 |
| **B 小计** | | **1.5（区间 1.0–1.5）** |
| **总计** | | **4.5（区间 3.5–5）** |

### 0.3 依赖与并行

- **A0 是硬门槛**：失败则整个 A 转为 §3.1 的降级路径，B 不受影响可继续。
- **B1–B3 可与 A1/A2/A3 并行**（文件不重叠：B 动 `src/ps/*`、`src/ark/*`；A 动 `native/*`、`src/providers/*`、`src/settings/*`）。
- **B4 必须在 A5 之前完成**：32 对齐加上 1MP 上限后，画布边缘选区会更容易落入补边分支。
- **A5 依赖 A2 + A3 + B4 同时就绪**。

### 0.4 用户需要准备/配合的事

- [ ] Photoshop **≥ 24.2.0**（Adobe 明确 Hybrid Addon 起点：PS 24.2.0+ / PR 26.2+；rocxps 当前 `minVersion` 恰为 24.2.0，无需改）
- [ ] macOS **26 或更高**（Siliconed 的系统要求；本机实测为 26.5.2，满足）
- [ ] 安装 Siliconed.app，且 `silicontrol models` 中 `qwen-image-2.1` 为 `ready: true`（本机已装 compact 变体 17.3GB）
- [ ] 在 Siliconed 应用内**接受 Qwen Research（非商用）许可**（本机 `license_accepted: true`）
- [ ] 构建环境：Xcode Command Line Tools 14+、CMake 3.15+
- [ ] 接受限制：**非商用**、**无 mask/无 inpaint**、编辑面积约 **1MP** 上限
- [ ] 跑一次验证（A0 结束时确认）：`/Applications/Siliconed.app/Contents/Helpers/silicontrol status` 返回 `{"ok":true,...}`

---

## 1. 工作流 A：Siliconed 接入

### A0 可行性验证（约 1 小时，0.5 人日）

**目标**：确认 Photoshop 能加载 `.uxpaddon` 并执行子进程。**这一步失败，后面全部不做。**

**Step 1 复制并最小化裁剪**

```bash
cd /Users/xucangshu/Desktop/PRAI/rocxps
cp -R ../RocX/native/RocXBridge native/SiliconedBridge
rm -rf native/SiliconedBridge/test native/SiliconedBridge/build \
       native/SiliconedBridge/src/RocXBridgeWin.cpp \
       native/SiliconedBridge/src/RocXBridgeCommandWin.cpp \
       native/SiliconedBridge/src/RocXBridgeMac.mm
```

裁剪原则：**只保留 `RocXBridge.cpp` + `RocXBridgeCommand.mm`**（`runCommand` 部分），删掉 `openFileInPhotoshop`（本阶段不需要，少一个平台依赖）。`third_party/uxp-hybrid-sdk` 必须保留（MIT 许可，RocX 已内置）。

**Step 2 改 CMakeLists（4 处）**

| 位置 | 改动 |
|---|---|
| `project(...)` | 改 `SiliconedBridge` |
| `add_library(...)` | 改 `SiliconedBridge` |
| `COMMON_SOURCES` + `APPLE` 分支 | 只留 `src/RocXBridge.cpp`、`src/RocXBridgeCommand.mm`、`UxpAddon.cpp` |
| `POST_BUILD` 复制 | 目标文件名改 `SiliconedBridge.uxpaddon`，输出目录保持 `../../public-hybrid/${UXP_PLATFORM_DIR}/`（vite-uxp-plugin 写死只认这里） |

**Step 3 编译**

```bash
cmake -B native/SiliconedBridge/build -S native/SiliconedBridge \
      -DCMAKE_OSX_DEPLOYMENT_TARGET=10.15
cmake --build native/SiliconedBridge/build --config Release
ls -l public-hybrid/mac/arm64/SiliconedBridge.uxpaddon
```

**Step 4 最小 manifest（临时验证用）**

```ts
// uxp.config.ts
addon: { name: "SiliconedBridge.uxpaddon" },
requiredPermissions: { enableAddon: true, /* 其余保持现状 */ },
```

**Step 5 最小代码骨架（放 `src/core/silicontrol.ts`，验证后可继续演进）**

```ts
const ADDON = "SiliconedBridge.uxpaddon";
const CLI = "/Applications/Siliconed.app/Contents/Helpers/silicontrol";

export async function probeAddon() {
  const addon = await (require as any)(ADDON);            // 返回 Promise，必须 await
  const r = await addon.runCommand({ exe: CLI, args: ["status"], timeoutMs: 15000 });
  return { ok: r.ok, exitCode: r.exitCode, out: r.out, err: r.err };  // 末行 JSON 含 "ok"
}
```

验证方式：`npm run build` → UXP Developer Tool 加载 `dist/manifest.json` → 面板 DevTools 控制台执行 `probeAddon()`。

**验收标准**

- [ ] `public-hybrid/mac/arm64/SiliconedBridge.uxpaddon` 产出，Mach-O arm64
- [ ] PS 内 `require("SiliconedBridge.uxpaddon")` 不抛 `Addon is not supported` / `MODULE_NOT_FOUND`
- [ ] `runCommand` 返回 `{ok:true, exitCode:0, out:'{"ok":true,...}'}`
- [ ] Siliconed 未启动时，`add` 能自动拉起应用（CLI 自带行为）

**失败回退**：直接切 §3.1「外部脚本转 HTTP + `custom` provider」，A1–A5 暂停。

---

### A1 addon 接入工程化（0.5 人日）

**目标**：把 A0 的临时验证变成可重复构建的常规流程。

**改动文件**

| 文件 | 改动 |
|---|---|
| `uxp.config.ts` | `requiredPermissions.enableAddon: true`；`addon: { name: "SiliconedBridge.uxpaddon" }` |
| `package.json` | 新增 `native:build:mac`（cmake 编译）；`dev`/`build`/`ccx`/`zip` 前置执行它 |
| `.gitattributes`（新增） | `*.uxpaddon binary`、`*.sh text eol=lf`、`.command text eol=lf` |
| `.gitignore` | 确认 `public-hybrid/` 未被忽略（当前确实未忽略；`src/hybrid/win/.vs` 是历史遗留规则，可删） |

**关键实现点**

- 构建顺序必须**先 addon 后 vite**，否则 `copyHybridBinaries()` 在 `public-hybrid/` 找不到产物会静默 return，包里没有 addon。
- `vite-uxp-plugin@1.3.26` 已支持 `addon` / `enableAddon`（`lib/types.d.ts:83-85`），**不需要升级插件**。
- addon 名称必须与 `require(...)` 字符串、`manifest.addon.name`、产物文件名三者一致。

**验收标准**

- [ ] `npm run build` 一条命令产出 `dist/SiliconedBridge.uxpaddon`（放在正确 arch 子目录）
- [ ] `dist/manifest.json` 含 `addon` 与 `requiredPermissions.enableAddon`
- [ ] 删除 `public-hybrid/` 后重新 build 能自动重建
- [ ] git 仓库内 `.uxpaddon` 未被 CRLF 破坏（`git diff` 显示 binary）

**失败回退**：若 vite-uxp-plugin 拷贝行为与 RocX 版本有差异，改用 `copyZipAssets` 或 `vite` 的 `closeBundle` 钩子手动拷贝（RocX 已验证前者不适用于 ccx）。

---

### A2 `src/core/silicontrol.ts`（0.5 人日）

**目标**：把 CLI 契约封装成类型安全的异步 API，供 provider 层调用。

**接口设计（对齐 `silicontrol help contract` 实测契约）**

```ts
export interface SiliconedAddon {
  runCommand(o: { exe: string; args: string[]; cwd?: string; timeoutMs?: number }):
    Promise<{ ok: boolean; exitCode: number; out: string; err: string;
              truncated: boolean; error?: string }>;
}

// 提交：立即返回 jobId（不加 --wait）
submit(opts: { refPaths?: string[]; prompt: string; size?: string; seed?: number;
               model?: string; steps?: number }): Promise<{ jobId: string }>;

// 进度：不阻塞；running.fraction / remaining_s / stage / queue
status(): Promise<SiliconedStatus>;

// 收取：阻塞到完成，PNG 写进 outDir，返回文件绝对路径
wait(jobId: string, outDir: string): Promise<{ paths: string[] }>;

// 探测：app/model/license 三态
probe(): Promise<{ appOk: boolean; modelReady: boolean; licenseAccepted: boolean }>;
```

**关键实现点**

1. **JSON Lines 解析**：按 `\n` 切分，逐行 `JSON.parse`；**只信最后一行**的 `ok`。前置行 `type` 取值 `added|image|sheet|start|stage|step|end`，其余行忽略。
2. **退出码语义**：`0` 成功 · `1` `ok:false`（读 `error`/`message`/`hint`）· `2` 用法错误 · `3` app 不可达。
3. **错误映射**（统一收敛到现有 `ProviderError` 三分类）

| CLI 现象 | 归类 | 提示 |
|---|---|---|
| 退出码 3 | terminal | 「Siliconed 无法访问，请确认已安装并可启动」 |
| `ok:false` + 模型相关 code | terminal | 引导 `silicontrol install qwen-image-2.1` |
| `status.waiting_for_license` 非空 | terminal | 展示许可名（`Qwen Research (non-commercial)`）+ 需在 app 内接受 |
| `format` / `insufficient_memory` | terminal | 选区过大或显存不足，提示缩小选区 |
| `runCommand` 返回 `error:"timeout"` | timeout | 不自动重发 |
| job 从 `status` 消失且无产物 | terminal | 「app 被退出或队列被清空」 |

> `error` 稳定 code 的完整列表以 `silicontrol help errors` 为准，落地时补全映射表。

4. **轮询节流**：`status` 间隔 **≥ 1000ms**（默认 1500ms）；每次轮询 = 一次 `runCommand` = 一个进程，禁止 200ms 级轮询。
5. **超时**：单次 `status` 15s、`submit` 30s、`wait` 用整任务超时（见 A4）。
6. **路径定位**：`CLI` 默认 `/Applications/Siliconed.app/Contents/Helpers/silicontrol`，允许设置项覆盖；先用 `fs.stat` 判存在（UXP fs 对 app 目录只读访问即可）。

**验收标准**

- [ ] 单测（Node，假 addon 注入）：三种退出码、`ok:false`、非 JSON、末行解析、空 stdout（错误走 stderr）
- [ ] app 未启动时 `submit` 能成功（CLI 自动拉起）
- [ ] 并发 3 个 `status` 不产生异常（addon 每个调用独立进程）

**失败回退**：若 `runCommand` 在 PS 上对 `timeoutMs` 行为不一致（提前 kill），改为「`submit` 后只轮询 `status`，不调用长 `wait`」。

---

### A3 provider 接入（0.5 人日）

**目标**：把 Siliconed 作为第 5 个 provider 接进现有抽象，**不改 pipeline 主流程**。

**改动文件清单**

| 文件 | 改动 |
|---|---|
| `src/providers/siliconed.ts`（新增） | `siliconedGenerate()`：写临时 PNG → `submit` → 轮询 `status` → `wait` 取图 → 读盘 → base64；`siliconedProbe()` |
| `src/providers/types.ts` | `ProviderId` 加 `"siliconed"`；`PROVIDERS` 加「Siliconed（本地）」 |
| `src/providers/catalog.ts` | 新增模型 `siliconed-qwen-edit` |
| `src/providers/index.ts` | `generateWithProvider` 加 `siliconed` 分支；`probeProvider` 加分支 |
| `src/settings/types.ts` | 新增 `siliconedCliPath`（默认见 A2）；`DEFAULT_SETTINGS` 补默认值 |
| `src/components/SettingsPanel.tsx` | 新增设置节：CLI 路径 + 「检测 Siliconed / 模型 / 许可」按钮（复用 `probeProvider`） |

**catalog 条目（关键字段）**

```ts
{
  id: "siliconed-qwen-edit",
  provider: "siliconed",
  label: "Qwen-Image-2.1 Turbo 编辑（Siliconed 本地）",
  kind: "edit",
  explicitSize: false,      // 输出随 image1，不需要显式 WxH 换算
  minPixels: 0,
  maxPixels: 1048576,       // `help edit`：编辑面积约 1MP，超过会被拒（format）
  // 新增字段见工作流 B：sizeAlign: 32, minSide: 512
}
```

**关键实现点**

- 现有 `pipeline.ts:47` 只对 `ark|runninghub` 要求 API Key → **Siliconed 自动免 Key，无需改 pipeline**。
- `explicitSize: false` → `request = null` → 贴回自动按 `expanded` 尺寸缩放（`pipeline.ts:100-101`），现有代码已覆盖。
- **选区图必须先落盘**：`--ref` 只接受文件路径。写入 `getDataFolder()` 下临时文件，**不触发 UXP 授权弹窗**（`localFileSystem: "request"` 保持不变，不需要像 RocX 那样改 `fullAccess`）。
- 蒙版处理：Siliconed **没有 mask/inpaint**。把黑白通道图作为第 2 个 `--ref`，提示词前加现有 `IMAGE_ROLE_PREFIX`（`providers/index.ts:45-46`）；这只是「希望模型参考」，**不保证遵守**。最终正确性靠 PS 侧图层蒙版（`placeBackMode:"mask"`）。
- `--steps`：Qwen-Image-2.1 **只支持 8**（`models` 实测 `default_steps:8`，`help add` 注明该模型仅有 8 的调度）；不要暴露步数设置给该模型。

**验收标准**

- [ ] 设置面板可保存/读取 CLI 路径；检测按钮正确区分「app 缺失 / 模型未装 / 许可未接受 / 就绪」
- [ ] 选 `siliconed-qwen-edit` 后 `generateWithProvider` 返回非空 base64
- [ ] 不填 Key 不会报「尚未配置 API Key」
- [ ] 临时 PNG 与输出 PNG 均在 `getDataFolder()` 下，可被清理

**失败回退**：若 `require` 的 addon 在 PS 中可用但 `--ref` 路径传参有空格/中文问题，改用 `cwd` + 相对文件名（addon 直传 argv，无 shell 引号问题，理论安全）。

---

### A4 异步与 UI（0.5 人日）

**目标**：进度可感知、超时语义正确、并发语义诚实。

**关键实现点**

1. **提交即返回**：`submit` 拿到 `t3` 后立刻把任务置 `queued`，不阻塞 UI。
2. **进度映射**（来自 `status` 实测字段）：
   - `running.job === jobId` → `stage`（`text/image/denoising/decoding`）+ `fraction`（0–1）+ `remaining_s`
   - job 在 `queue[]` → 显示「排队中（第 N 位）」
   - `waiting_for_license` 中出现该 job → 直接失败并给许可引导
3. **整任务超时**：新增 `taskTimeoutMs`（默认 15 分钟），取代「单请求 300/600s」语义。注意现有 `settings.requestTimeoutMs = 300_000` 是**单次请求**超时；Siliconed 路线下列为「任务级」。
4. **并发**：Siliconed 单队列、一次只算一个。`settings.concurrency` 对它无效 → 选中该 provider 时 UI **强制显示 1 并禁用输入**，附一句「Siliconed 单队列串行」。
5. **取消**：`status` 无取消语义，用 CLI `cancel t3`；映射到任务卡片的「取消」按钮（仅排队中/运行中可用）。

**验收标准**

- [ ] 进度条随 `fraction` 前进，`remaining_s` 以秒显示并递减
- [ ] 排队任务显示队列位置
- [ ] 切换 provider 时并发控件表现正确（ark 可调、siliconed 锁定为 1）
- [ ] 任务超时后 UI 明确提示，不静默卡死

**失败回退**：若 `status` 的 `fraction` 在 8 步模型上颗粒度太粗（8 档），改为「stage + 已用时间 + 预计剩余」三要素展示，不做百分比动画。

---

### A5 贴回与验收（1 人日）

**目标**：结果 PNG 正确回到画布原位，覆盖两种贴回模式与两种选区规模。

**关键实现点**

- 结果图读盘：`getDataFolder()` → `fs.read`（binary）→ `bytesToBase64`（复用 `providers/http.ts:173` 起）
- `placeBackResult` 不变：`reqW/reqH` 用 `expanded` 尺寸（`explicitSize:false` → `request=null`）
- 1MP 以上选区：`computeRequestSize` 走 `maxPixels` 分支缩小请求 → 贴回放大；**清晰度损失要在 UI 提示**
- 贴回前 guard（文档存活/画布未变）沿用现有逻辑

**端到端验收用例**

- [ ] **用例 1（小选区）**：320×208（低于 1MP）→ 结果约 1024² → 缩放回 320×208 → 位置精确、无偏移
- [ ] **用例 2（大选区）**：1600×1200（>1MP）→ 请求缩小到 ≤1MP → 贴回放大 → 位置正确、可接受清晰度损失
- [ ] **用例 3（蒙版合成）**：`placeBackMode:"mask"` → 选区外像素逐像素不变（叠层对比）
- [ ] **用例 4（整块替换）**：`placeBackMode:"block"` → 整块覆盖，边界无缝
- [ ] **用例 5（画布边缘）**：贴边选区 → 触发补边（依赖 B4）或明确报错
- [ ] **用例 6（异常）**：生成中退出 Siliconed → 任务置失败并提示，不贴错位置

**失败回退**：若 `placeBack` 在 1MP 缩放后出现 1px 偏移，检查 `expanded` 与 `reqW/reqH` 是否同源；禁止在 provider 层自行裁剪。

---

## 2. 工作流 B：8 像素对齐 → 32 像素对齐

### B1 存量排查（已完成）

| # | 位置 | 当前语义 | 改 32 的影响 | 处理 |
|---|---|---|---|---|
| 1 | `src/ps/geometry.ts:11-86` `expandRectToMultipleOf8` | 选区向外扩展，宽高向上取整到 **8**（`26-27`），每边最多 +7 | 每边最多 +31；**画布边缘更容易装不下** | **改参数化** `align`，不再硬编码 |
| 2 | `src/ps/geometry.ts:89-92` `assertAlignedTo8` | 断言 `% 8 === 0` | 断言口径变化 | 改名 `assertAligned(rect, align)` |
| 3 | `src/ps/selection.ts:5-8` | 再导出上述两个函数 | 名字变化影响调用方 | 同步改名 |
| 4 | `src/ps/capture.ts:2,536-541` | 调用扩展；`542-546` **补边直接抛错** | **触发概率显著上升**（32 对齐更容易越过画布） | 必须先实现补边（B4），否则改 32 会引入回归 |
| 5 | `src/ark/sizeStrategy.ts:19-20` `alignCeil8/alignFloor8` | 请求尺寸取整到 8 | floor 到 32 可能让总像素略低于 `minPixels` | 改为按 `model.sizeAlign`（Ark 仍 8） |
| 6 | `src/ark/sizeStrategy.ts:56-66` | `maxSide` 分支 `Math.max(8,...)`、`< 8` 校验 | 同理需按 align | 用 align 常量替换 |
| 7 | `src/providers/catalog.ts`（全部条目） | `explicitSize` + `minPixels/maxPixels`，**没有边长对齐声明** | Siliconed 要求每边 **32 倍数** 且 **≥512** | 新增 `sizeAlign`、`minSide` 字段 |
| 8 | `src/ark/models.ts`（6 个预设） | 只有像素上下限 | Ark 仍按 8 | 不填 `sizeAlign`，默认 8 |
| 9 | `src/ark/sizeStrategy.test.ts:17-54` | 4 处断言 `% 8 === 0`、宽高比容差 | 期望值全变 | 改为按模型 align 断言 |
| 10 | `src/ps/selection.test.ts:20-21,33-35` | 不变量 `% 8`、具体坐标期望 `99..411` | 具体期望值全变 | 重算 + 加 32 用例 |
| 11 | `src/components/RedrawPanel.tsx:401` | UI 文案「（8 整除）」 | 文案错误 | 改为动态 `（${ALIGN} 整除）` |
| 12 | `src/task/types.ts:36`、`src/ps/types.ts:9,14,19,21`、`src/task/pipeline.ts:55` | 注释写「8 整除」 | 文档漂移 | 同步注释 |
| 13 | `docs/local-redraw-plan.md:96-138`（§4） | 整节 8 对齐算法 | 与实现不一致 | 追加「32 修订」小节，不重写历史 |
| 14 | `src/ps/resize.ts` | Lanczos3 任意尺寸缩放 | **无对齐逻辑** | 不动 |
| 15 | `src/ps/jpegDecoder.ts:27,193-210,266-281` | JPEG **8×8 DCT 块** | **与像素对齐无关，绝不可动** | 明确标注禁止修改 |
| 16 | `src/ps/pngEncoder.ts:104` | PNG `bit depth = 8` | **与像素对齐无关** | 不动 |
| 17 | `src/settings/store.ts:66` | 位运算 `& 0x07` | 无关 | 不动 |
| 18 | `src/index.scss` 中 `8px` | CSS 间距 | 无关 | 不动 |

### B2 改法（明确建议）

**建议：捕获层统一 32，请求层按模型声明，不保留 8 作为捕获默认值。**

理由：

1. 捕获区域是**所有 provider 的共同输入**，取最严约束（32）可避免每个 provider 再补边/裁切；
2. 请求尺寸是**模型私有约束**，Ark 只需 8、Siliconed 要 32、Wan 要 16 → 一刀切到 32 会让 Ark 的请求与原行为不一致，产生无必要回归；
3. 若捕获层保留 8，Siliconed 就必须在请求层把 8 对齐图补边成 32 → 请求图尺寸 ≠ 捕获图尺寸，**贴回缩放链路多一层、易错**。

具体落地：

```ts
// 新增 src/ps/align.ts（单一真相源）
export const CAPTURE_ALIGN = 32;
export const alignUp = (v: number, a: number) => Math.ceil(v / a) * a;
export const alignDown = (v: number, a: number) => Math.floor(v / a) * a;
```

- `ps/geometry.ts`：`expandRectToMultiple(sel, canvasW, canvasH, align = CAPTURE_ALIGN)`
- `ark/sizeStrategy.ts`：`const a = model.sizeAlign ?? 8;`，所有取整用它；`maxSide` 分支同步
- `providers/catalog.ts`：`siliconed-qwen-edit` 设 `sizeAlign: 32, minSide: 512`；其余平台不填（默认 8）
- `ark/models.ts`：Ark 不填 → 保持 8，**零回归**
- **可回滚性**：`CAPTURE_ALIGN` 是单常量，改回 8 只动一行；这是「可回滚」而非「保留 8 兼容」

### B3 单测改写

- [ ] `ps/selection.test.ts`：不变量改为 `% CAPTURE_ALIGN`；重算 5 个用例坐标；新增「32 对齐完整包含原选区」断言
- [ ] `ark/sizeStrategy.test.ts`：按 `model.sizeAlign` 断言；保留 Ark 8 的原有用例（应全部通过，证明无回归）
- [ ] 新增边界用例：`1×1` 选区 → 扩到 32×32；`317×205`（非 32）→ `320×224`；`1600×1200`（>1MP）→ 请求 ≤1MP 且边长 32 倍数

### B4 补边模式实现（改 32 的必要配套）

`geometry.ts:56-72` 已经算出 `padInfo`，但 `capture.ts:542-546` 直接抛「补边导出将在后续版本支持」。改 32 后该分支命中率上升（尤其全宽选区 + 画布宽非 32 倍数），必须实现：

- [ ] 捕获：虚拟区域超出画布部分用边缘像素延展填充（`readMergedPixelsDirect` 前做 clamp + edge replicate）
- [ ] 蒙版：pad 区按「保留」处理（黑色）
- [ ] 贴回：先裁掉 `padLeft/padTop` 再对齐，尺寸校验 `width === w32`
- [ ] 若短期不实现：对 `expanded.padInfo` 场景**回退到 8 对齐**并标记「该任务不支持 Siliconed」，不要静默产出错误尺寸

### B5 验收

- [ ] `npm test` 全绿（`scripts/run-tests.mjs`）
- [ ] `npm run build` 通过
- [ ] 回归：Ark 显式尺寸（`doubao-seedream-4-0`）请求尺寸仍为 8 倍数，行为与改前一致
- [ ] 回归：ComfyUI / 自定义 provider（`explicitSize:false`）不经过 sizeStrategy，行为不变
- [ ] 回归：RunningHub Wan（`maxSide:1536`）按其声明对齐，请求不超界
- [ ] 新增：Siliconed 请求边长 32 倍数、≥512、≤1MP

---

## 3. 风险与回退

### 3.1 【最高】PS 里 addon 加载失败

**症状**：`require("SiliconedBridge.uxpaddon")` 抛 `Addon is not supported` / `MODULE_NOT_FOUND`。

**原因排查顺序**：PS 版本 < 24.2 → 架构不匹配（x64 机器跑 arm64 产物）→ manifest 缺 `enableAddon` → 产物未进 `dist/`。

**降级路径（30–40 行脚本，插件侧零新代码）**：

```
外部脚本 bridge（Node 或 shell）
  POST 127.0.0.1:8799/run  {prompt, image_b64, ...}
    → 写临时 PNG
    → execFile: silicontrol add --wait --out D --model qwen-image-2.1 --ref <png> "<prompt>"
    → 读 D 中 PNG → base64 → {"b64": "..."}
插件侧
  settings.providerId = "custom"
  settings.customUrl = "http://127.0.0.1:8799/run"
  settings.customBodyTemplate = {"prompt":"{{prompt}}","image":"{{image}}"}
  settings.customResultPath = "b64"
```

优点：不改 `custom.ts` 一行代码；缺点：要手动启脚本、无进度、长连接需临时调大超时。作为「验证可行但工程化受阻」的过渡方案。

### 3.2 无 mask / 无 inpaint（功能性限制）

`help edit` 原文：*"No mask, no inpainting: the prompt alone says what changes."* 选区内可能被误改。

**缓解**：蒙版作为 `--ref` 第 2 张 + 提示词角色前缀；**最终正确性依赖 `placeBackMode:"mask"`**（选区外绝对不变）。
**不可缓解**：选区内非目标区域被改动。需在 UI 明示「Siliconed 无蒙版重绘能力」。

### 3.3 1MP 编辑上限

`help edit` 说编辑面积约 1024²，超过的格式被拒（`format`）；而 `help add` 的格式表列到 2048²。**两处口径不一致，需实测确认**（一次真实渲染即可，约 1–3 分钟）。
影响：大选区必须降采样 → 贴回放大 → 清晰度损失。UI 需提示预计损失。

### 3.4 macOS 26+ 门槛

面向自己使用无碍（本机 26.5.2）；对外分发等于把用户锁在最新系统 + 另一款 app。

### 3.5 许可（Qwen Research 非商用）

本机 `models` 实测：`commercial_license: false`、`license: "Qwen Research (non-commercial)"`、`license_accepted: true`。
插件不分发权重，义务落在用户。商用需换模型，但目前「可编辑 + 可商用」没有现成选项（`z-image` Apache 2.0 无 edit；`krea2` 商业条款但 `edit:null`）。

### 3.6 单队列串行

Siliconed 一次只算一个渲染 → `concurrency: 2` 无效。A4 强制置 1 并在 UI 说明，避免「设置了并发却不生效」的困惑。

### 3.7 addon 一次性返回、无流式

`RocXBridge.cpp:186-230` 实证：进程退出后才 resolve，运行中 JS 拿不到任何输出。**所以进度只能靠轮询 `status`**。若未来要流式，需给 addon 加 `runCommandStreaming`（C++ 层已有增量 drain，增加回调约 50 行），非本轮范围。

### 3.8 分发/签名

`.uxpaddon` 是裸 Mach-O；按架构编译、`*.uxpaddon binary` 防 CRLF（RocX 已踩坑）。**对外分发是否需要签名/公证未在代码中体现**（推测需要，至少会遇到 Gatekeeper 提示），本轮自用可忽略。

---

## 4. 文件改动总清单

```
新增  native/SiliconedBridge/                # 从 RocX/native/RocXBridge 裁剪（MIT）
新增  public-hybrid/mac/arm64/*.uxpaddon     # CMake 产物（不提交或按约定提交待定）
新增  .gitattributes
新增  src/core/silicontrol.ts                # addon + CLI 封装
新增  src/providers/siliconed.ts             # submit/poll/wait/读盘
新增  src/ps/align.ts                        # CAPTURE_ALIGN + alignUp/alignDown
改    uxp.config.ts                          # addon / enableAddon
改    package.json                           # native:build:mac + 构建顺序
改    src/providers/types.ts                 # ProviderId + "siliconed"
改    src/providers/catalog.ts               # siliconed-qwen-edit + sizeAlign/minSide
改    src/providers/index.ts                 # 分发 + probe 分支
改    src/settings/types.ts                  # siliconedCliPath / taskTimeoutMs
改    src/components/SettingsPanel.tsx       # 设置节 + 检测按钮
改    src/components/RedrawPanel.tsx         # 对齐文案、并发说明
改    src/ps/geometry.ts                     # 参数化 align
改    src/ps/selection.ts                    # 导出改名
改    src/ps/capture.ts                      # 传 align + 补边实现
改    src/ark/sizeStrategy.ts                # 按 model.sizeAlign
改    src/ark/models.ts                      # （可选）显式 sizeAlign=8
改    src/ps/selection.test.ts               # 期望值与不变量
改    src/ark/sizeStrategy.test.ts           # 断言
改    src/task/types.ts / src/ps/types.ts / src/task/pipeline.ts   # 注释
改    docs/local-redraw-plan.md              # §4 追加 32 修订说明
```

---

## 5. 里程碑验收一览

| 里程碑 | 验收 | 依赖 |
|---|---|---|
| **M-A0** | PS 内 addon 加载 + `silicontrol status` 跑通 | 用户环境 |
| **M-A1** | `npm run build` 产出含 addon 的 `dist/` | A0 |
| **M-A2** | `silicontrol.ts` 单测全绿 | A1 |
| **M-A3** | 设置面板检测四态正确；能拿到 base64 | A2 |
| **M-A4** | 进度条 + 排队态 + 并发锁定 | A3 |
| **M-A5** | 6 个端到端用例通过 | A4 + B4 |
| **M-B** | `npm test` 全绿；Ark 8 行为不变；Siliconed 32 约束满足 | 独立 |
