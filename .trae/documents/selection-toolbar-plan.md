# 选区上下文任务栏（浮窗工具栏）计划

> 分支：feat/modal-dialog（实验性质）。目标：把选区浮窗从「纯展示」升级为
> 仿 Photoshop 上下文任务栏（Contextual Task Bar）的操作工具栏，
> 有选区浮现、无选区消失，操作直接下发到队列/PS。

## 1. 参考与目标

参考截图：PS 原生上下文任务栏，横条布局：
`✦ 生成式填充 | ✨ 移去 | 取消选择`

浮窗两态：

- **按钮态**（默认）：三个横排按钮 —— 生成式填充 / 移去 / 取消选择。
- **输入态**（点「生成式填充」）：一行提示词输入框 + 行尾「生成」「取消」两按钮；
  「取消」回到按钮态。

显隐沿用已验证机制：select/set/historyStateChanged 事件 + 浮窗存在期间 2s 保底轮询。

## 2. 操作语义

| 浮窗按钮 | 行为 | 实现通路 |
|---|---|---|
| 生成式填充 | 输入提示词后入队一次**重绘**任务（忽略当前 siliconedMode，强制 redraw 语义） | 共享流程 `generateFromSelection({ prompt })` |
| 移去 | 直接入队一次**移除**任务（空提示词 = 主面板 auto 语义的移除） | 共享流程 `generateFromSelection({ prompt: "" })` |
| 取消选择 | Cmd+D 等价：清空当前文档选区 | `executeAsModal` + batchPlay `set selection → none` |

「数据传递到主界面」的实现方式：**不经过主面板组件转发**，浮窗直接调用与主面板
相同的模块级入队函数（`enqueueCapture` 来自 src/task/queueRunner.ts，模块级单例）。
效果等同：任务出现在主面板的队列列表里，并走同一渲染/贴回链路。

## 3. 共享流程提炼（M1）

主面板 `generate()`（RedrawPanel.tsx L490）是组件内闭包，核心逻辑与组件 state 解耦的部分：
loadSettings → applyGenerationOverride → provider 判定 → 提示词校验 →
captureSelection（复用已有 capture 时跳过重抓）→ enqueueCapture → 清理。

提炼到 `src/task/generateFlow.ts`：

```ts
/** 从当前选区直接入队（浮窗 / 主面板共用核心）。 */
export interface GenerateFlowOptions {
  prompt: string;                       // 空字符串 = 移除语义（auto 判定）
  forceRedraw?: boolean;                // 生成式填充：忽略 siliconedMode，强制 redraw
  onNotice?: (message: string) => void; // 「已加入队列（队列已暂停）」等提示
}

export const generateFromSelection = async (options: GenerateFlowOptions): Promise<void>
```

- 内部复刻 generate 的选区路径（**不走 expand 工作流**——浮窗基于选区存在）；
- captureSelection 参数与主面板一致（Siliconed 用 SILICONED_SELECTION_EXPAND、maskPatchFloor）；
- RedrawPanel.generate 改为调用此函数（面板侧保留 state 清理：capture/request/notice），
  保证两条入口行为一致（防双实现漂移）；
- 主面板兼容性：generate 的其余分支（expand、模板）不动。

单测：generateFlow 的可测部分（参数构造、提示词校验分支）纯函数化抽取测试；
executeAsModal 部分不测。

## 4. 浮窗 UI（M2）

[SelectionPanel.tsx](../src/components/SelectionPanel.tsx) 的 dialog 内容改为两态工具栏：

- 布局：横条（dialog min-width ~300px），Spectrum 深色按钮；
- 输入态的文本框：**非受控**（ref 读值）——受控 value 在原生窗口内同步不可靠；
- 「生成」点击 → 读 ref.value → `generateFromSelection({ prompt, forceRedraw: true })`
  → 回按钮态 + 关闭输入框；「取消」→ 仅回按钮态；
- 移去 → `generateFromSelection({ prompt: "" })`（无需确认，与主面板空提示词语义一致）；
- 取消选择 → executeAsModal 清选区；事件回调会自然触发 checkSelection → 浮窗消失。

### 4.1 跨窗口事件（已实测风险点）

dialog 原生窗口内 React 合成事件（onclick prop）此前实测**不可靠**（ModalDemo 的
按钮点了无反应）。两个方案按序尝试：

1. **React 事件**：sp-button 的 onclick —— 若真机生效则用（面板内一直正常，dialog
   窗口内待验证）；
2. **原生事件**：ref + `addEventListener("click")` / `onInput`，在 dialog 挂载后绑定
   （跨窗口最可靠；输入框也用 ref.value 读值）。

计划按方案 2（原生绑定）直接实现——避免一轮真机往返；React 事件方案仅在原生绑定
也失效时回退讨论。

### 4.2 状态同步

浮窗内的 UI 状态（按钮态/输入态）用 React state 驱动 + 条件渲染（与显隐同模式）；
输入态切换后浮窗尺寸随内容变化（dialog 窗口自适应内容尺寸，实测可行）。

## 5. 里程碑

- **M1 通路**：generateFlow.ts 提炼 + 取消选择 batchPlay + 主面板接入 + 单测。
- **M2 浮窗**：两态工具栏 + 原生事件绑定 + 数据下发。
- **M3 验证**：npm test + build + 真机清单（见 §6）。

## 6. 真机验证清单

1. 有选区浮窗浮现（按钮态）→ 点「生成式填充」→ 输入行出现、可输入、获得焦点；
2. 输入文字点「生成」→ 任务入队（主面板队列可见）→ 浮窗回按钮态；
3. 点「移去」→ 空提示词任务入队（auto 移除语义）；
4. 点「取消选择」→ 选区清空 → 浮窗消失；
5. 浮窗存在期间：队列暂停/恢复不受影响；连续操作（画选区→移去→再画→生成）不串任务；
6. 撤销/重做盲区兜底：撤销产生选区浮窗浮现（historyStateChanged 或轮询）。

## 7. 风险

- **跨窗口输入**：原生窗口内文本框的焦点/输入事件是最大不确定点；若输入态不可用，
  退化为「生成式填充」直接用主面板提示词（浮窗按钮仅作为快捷键），并在浮窗中提示。
- **浮窗窗口定位**：继续固定位置（已确认接受）。
- **executeAsModal 模态**：取消选择会短暂进入 PS 模态（毫秒级），无 UI 影响。
