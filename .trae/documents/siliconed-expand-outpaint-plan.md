# Siliconed 阔图（expand）能力适配计划

分支：`feat/siliconed-outpaint`（已创建）

## Context

Siliconed 新版 CLI 新增扩图能力：`silicontrol add --mode expand "<补充提示词，可空>" --image <源图> --pad L,R,T,B [--max-sample N]`。与现有「框选→抓取→蒙版→贴回」流程形态完全不同：

- 无选区、无 `--mask`（传了会被拒绝）
- 用户先用 PS 裁剪工具外扩画布（原始内容外为透明像素），插件抓取整个扩展后画布
- 插件自动检测非透明像素包围盒 =「原始画面」，计算四方向 pad 百分比（相对源图边长，0–200 浮点）后提交
- 输出画布由 `--pad` 决定（模型约束每边 16 倍数、qwen 32 倍数），可能与 PS 扩展画布有舍入差，由现有 outputMismatch 机制消化
- 提示词是工作流固定句子的补充，可留空；拒绝 `--strength`/`--ref`/显式格式等
- `--max-sample`：采样长边上限 1024–3840 步进 128，默认 2048
- 旧版 CLI 无此能力，需给出明确「版本过旧」提示

设计原则：expand 为独立顶层工作流（不塞进 `SiliconModeChoice`，避免污染 auto/remove/redraw 语义）；复用 QueueJob 既有几何字段（`originalBounds`=源图包围盒、`expanded`=扩展画布）+ 新增可选 `workflow` 字段；贴回新增独立函数，不改现有蒙版/几何逻辑；纯函数集中在可 Node 单测的新文件。

## 文件改动

### M1 纯函数层（npm test 即可验证）

**新建 `src/ps/expandPlan.ts`**（全纯函数）：
- `computeExpandPads(source, canvasW, canvasH): ExpandPadPlan` — 四边 pad = 距离/源图边长×100，clamp [0,200]（截断记 warning），全 0 抛错；`logicalWidth/Height = 源图×(1+pad)`；bbox 不居中由四边独立公式天然覆盖
- `normalizePanelWorkflow(value)`：非法回退 `"selection"`
- `normalizeExpandMaxSample(raw)`：clamp 1024–3840、snap 128 倍数、非法回退 2048
- `formatPadArg(pads)`：`"L,R,T,B"` 两位小数

**新建 `src/ps/expandCapture.ts`**：
- `accumulateAlphaBounds(...)` 纯函数：单块 RGBA 扫描非透明像素（alpha>0）更新累积包围盒，O(tile) 内存
- `captureExpandCanvas(): Promise<ExpandCaptureResult>` — executeAsModal 内：`planTiles` + `imaging.getPixels` 分块扫 alpha 得 bbox（每块立即 dispose）；bbox=整画布 → 明确报错「未检测到透明边界：背景层锁定或未外扩画布，请解锁背景层后重试」（背景色自动修正为 M5 增强项，见下）；全透明 →「画布没有内容」；非 RGB → 报错。bbox 区域用现成 `readDocumentRgba`（capture.ts L524，requireOpaque=false）→ `encodePng` + `uint8ToBase64`（均已有）
- 返回：docId/docPath/canvasW/H/source(Rect)/pngBase64/sendW/H/pads/warnings

**`src/providers/siliconedPlan.ts` 追加**（不改现有导出）：
- `buildSiliconExpandAddArgs(input)`：`["add", "--model", "qwen-image-2.1", "--mode", "expand", <escapeSiliconPrompt(prompt)>, "--image", path, "--pad", formatPadArg(pads), ...(maxSample ? ["--max-sample", n] : [])]`；模型沿用 qwen-image-2.1（expand LoRA 预设仅此模型）
- `describeSiliconExpandRejection(message, code)`：usage/unknown option 类错误 → 「Siliconed 版本过旧：不支持扩图，请升级」+ 原始错误尾行；未命中返回 null

**`src/task/promptPolicy.ts` 扩展**：加第三参数 `workflow: "selection" | "expand" = "selection"`，expand 恒返回 false；默认参数保证现有 303 条测试与调用点零改动

**`src/ps/placeBackGeometry.ts` 追加**：`computeExpandPlaceGeometry(canvasW, canvasH, source, pads)` — 逻辑画布定位（`targetLeft = source.left - padL%×sw` 等），画布越界裁剪，返回 target/src 偏移与实际写入尺寸

**测试**（共置同目录）：`expandPlan.test.ts`（pad 居中/不居中/clamp/全0/归一化/格式化）、`accumulateAlphaBounds` 用例（空块/跨块合并/阈值/偏移）、`accumulateBackgroundBounds` 用例（M5：四边背景色带收缩/遇内容即停/全匹配回退）、`computeExpandPlaceGeometry`（全覆盖/子区域/越界裁剪）、`siliconedPlan.test.ts` 追加（expand 参数拼装/空提示词/旧版拒单翻译）、`promptPolicy.test.ts` 追加（expand 恒不阻断）

### M2 抓取 UI（PS 内手动验证）

**`src/settings/types.ts`**：`PanelWorkflow = "selection" | "expand"`，`RedrawSettings` 新增 `panelWorkflow`（默认 selection）、`expandMaxSample`（默认 2048）；`settings/store.ts` 读取归一化接线

**`src/components/RedrawPanel.tsx`**：
- 编辑区顶部工作流切换（局部重绘 / 阔图扩图），仿 `chooseMode` L318-328 持久化
- expand 分支：隐藏 SILICON_MODE_OPTIONS/modeHint/模板按钮行；「抓取选区」变「抓取画布」；提示词 placeholder「补充提示词，可留空」；摘要显示「画布 W×H · 源图 sw×sh · pad 四边%」
- `generate()`：expand 时校验 provider 必须为 siliconed，prompt 校验走 `promptBlocksSubmit(provider, text, "expand")`，入队走 `enqueueExpandCapture`

**`src/api/flyout.ts`**（可选）：`FLYOUT_MENU_ITEMS` 追加「切换到阔图」项，RedrawPanel 订阅 `onFlyoutInvoke` 执行切换（ID 全局唯一、setup 仅一次的约束不变）

### M3 provider 与队列生成侧

**`src/providers/siliconed.ts`**：
- `createTempWorkspace` 参数化 `maskDataUri: string | null`（null 跳过 mask 写入）
- 提取私有 `ensureComputeTarget(cfg)`（L293-320 计算目标校验，机械提取）与 `collectSiliconResult(...)`（L388-473 wait/结果读取，两入口共用）
- 新增 `siliconedExpandGenerate(cfg, imageDataUri, prompt, request): Promise<string>`：ensureComputeTarget → 临时目录（无 mask）→ `siliconAdd(buildSiliconExpandAddArgs)` → 失败先试 `describeSiliconExpandRejection` → wait → 结果 base64

**`src/providers/index.ts`**：`GenerateInput` 新增可选 `expand?: SiliconExpandRequest`；case "siliconed" 分发；非 siliconed 收到 expand → ProviderError 兜底

**`src/task/queueStore.ts`**：`persistExpandCapture`（只落源图 ref.png，无蒙版）、`loadExpandCapture`（读回 pngBase64）；删除/LRU/保留期逻辑无需改动

**`src/task/queueRunner.ts`**：
- QueueJob 新增可选 `workflow?/expandPads?/expandMaxSample?`（旧队列项缺省按 selection）
- 字段映射：`originalBounds`=bbox、`expanded`=整画布、`sendW/H`=源图尺寸、`reqW/H`=逻辑输出画布（outputMismatch 基准）、mask 路径置空串
- 新增 `enqueueExpandCapture`；`runGeneration` 按 `workflow==="expand"` 分支：跳过 resolveSiliconMode、**不拼 promptSuffix**（后缀含「选区」措辞对扩图是错误指令）、`generateWithProvider({..., expand})`
- 验证：真实 CLI 提交（空提示词位置参数、pad 浮点行为）、旧版 CLI「版本过旧」提示、取消/重试

### M4 贴回

**`src/ps/placeBack.ts` 仅补两个 `export`**：`writePixels`（L139）、`saveArtifact`（L465），逻辑零改动

**新建 `src/ps/placeBackExpand.ts`**：`placeBackExpand(input)` — `decodeImageBytes` → `planOutputFit`（outputMismatch 沿用，舍入差按实际宽高缩放到逻辑画布消化）→ `resizeRgba` → `computeExpandPlaceGeometry` → `cropPlane` 裁越界 → executeAsModal：`matchDocument` 重绑 → `doc.createLayer("AI 阔图")` → `writePixels` 写入 → 无蒙版（无 putLayerMask/通道恢复，后台路径天然可用）→ 文档不存在走 `saveArtifact` 落盘 → 返回 `PlaceBackResult`
- `runPlace` 按 `workflow==="expand"` 分支接入；不调 loadMask
- 测试：`placeBackGeometry.test.ts` 追加 computeExpandPlaceGeometry 用例

### M5 打磨

expand 队列条目展示（「阔图」徽标 + pad%）、`expandMaxSample` 设置项 UI、capture warnings/超 200% 截断提示展示

**背景锁定场景的自动修正（M5 增强项）**：
- 背景：背景层锁定时，PS 裁剪工具外扩区域会被填充为背景色（非透明），alpha 扫描检测不到边界。M2 先明确报错引导解锁；M5 在此基础上增加自动修正，用户无需解锁
- 方案：bbox=整画布（无透明边界）时，利用插件读取 PS 背景色（前景/背景色拾取）的能力，扫描画布四周与背景色一致的连续像素带，将其视为填充的外扩区域，bbox 收缩到「非背景色内容区」
- **定位要点**：裁掉背景色带后，源图在扩展画布中的偏移 = 被裁掉的四边带宽，pad 与贴回几何均基于收缩后的 bbox 计算，坐标系不变（仍在画布坐标），贴回定位不受影响；但需防护「内容本身含大面积纯背景色区域」的误判——只从四边向内收缩连续匹配带，遇到第一个非匹配像素即停，且 bbox 收缩后若为空或过小（如短边 < 源图最小约束）则放弃修正、回退到 M2 的报错路径
- 实现位置：`expandCapture.ts` 内新增 `accumulateBackgroundBounds` 纯函数（可单测）+ `captureExpandCanvas` 的降级分支；风险：背景色恰与内容边缘同色时收缩过度，warning 明示「按背景色自动裁剪了 X px 边界」

## 已确认的约束与决策

- 提示词统一走 `promptPolicy` 纯函数；expand 空提示词允许
- expand 不拼 promptSuffix；模板按钮在 expand 模式隐藏（模板服务商覆盖与 expand 仅限 Siliconed 的冲突本期不做）
- 不改现有贴回/尺寸预设/蒙版逻辑；expand 全为新增分支
- 303 条现有测试必须全部保持通过；新功能配套单测
- 队列单飞、任务仅持路径与元数据、快照落盘等硬约束沿用

## 风险点（需真实 CLI 验证）

1. 空提示词作为位置参数能否被正确传递——若不行，省略位置参数或注入占位补充句（唯一改动点 `buildSiliconExpandAddArgs`）
2. CLI 输出画布舍入分布假设为「等比缩放、源图按 pad 保持」，M4 先按此落地并在 outputMismatch note 如实提示
3. pad 浮点（如 33.33）是否被接受——`formatPadArg` 先按两位小数实现
4. 超 200% 截断时贴回只覆盖逻辑子画布，其余保持透明，需在 warning/note 明示
5. 大画布：阶段一 alpha 扫描 O(tile) 内存安全；阶段二 bbox 巨大时 PNG 编码峰值与现有 captureSelection 同级，必要时加警告

## 验证方式

1. `npm test` 全量通过（现有 303 条 + 新增单测）
2. `npm run build` 生成新指纹
3. PS 内手动冒烟（M2 起）：裁剪外扩 → 抓取画布 → 摘要 pad 正确；背景层锁定 → 明确报错
4. 真实 CLI 端到端（M3/M4）：空提示词/补充提示词提交、结果贴回位置对齐、取消/重试、旧版 CLI 报错文案
