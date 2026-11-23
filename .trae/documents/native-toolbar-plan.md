# 原生浮窗任务栏计划（native-toolbar）

> 目标：用 hybrid C++ NSPanel 完全替代 UXP `<dialog>` 浮窗，根治三个硬伤：
> 系统标题栏去不掉、UXP 无定位 API（外部 AX 工具难迁移 + 首帧闪烁）、视觉受 Spectrum 限制。
>
> POC 已验证（v4）：无边框 NSPanel、创建即定位、不抢 PS 焦点、事件经
> `schedule_on_javascript_queue` 回传 JS，全程无崩溃。
> 实验性风险：hybrid 官方只承诺「计算/逻辑」，画 UI 属未支持路径，PS 大版本更新需复测。

## 已验证结论（POC 阶段）

1. 窗口操作必须全部投递到 **PS 主线程 main queue**（后台线程开窗打崩宿主，v1 教训）；
2. addon 回调**不得自行 delete task**（schedule 路径由 deleter 释放，双重释放打崩 UXP JS 线程，v2/v3 教训）；
3. `uxp_addon_schedule_on_javascript_queue` 从普通后台线程调用安全（复刻 runCommand 模式）；
4. 无边框 + NonactivatingPanel + 创建时 setFrame = 无标题栏 / 无闪烁 / 不抢焦点。

## 架构

```
UXP 面板 (SelectionPanel)                native (SiliconedBridgeToolbar.mm)
  选区监听（select/set/history/轮询）  →  showToolbar({w,h}) / hideToolbar()
  状态推送（两态/提示词/操作反馈）      →  setToolbarState({...})
  动作执行（generateFromSelection 入队）←  waitToolbarEvent() 事件循环
                                            （click / input / key / error）
```

- 选区检测、业务动作（入队）、平台调用全部留在 JS；native 只做「窗口壳 + 绘制 + 事件」。
- 状态单向推送：JS 是唯一状态源，native 无状态逻辑，UI = f(state)。

## Native API（在 POC 基础上扩展）

| 导出 | 签名 | 说明 |
|---|---|---|
| `showToolbar` | `({width?, height?}) → void` | 显示浮窗（创建即在目标位置）；重复调用重定位 |
| `hideToolbar` | `() → void` | 收起（复用窗口，不销毁） |
| `setToolbarState` | `(state) → void` | 推送 UI 状态：`{ mode: "buttons"\|"input", status?, statusError?, busy?, placeholder?, hint? }` |
| `waitToolbarEvent` | `() → Promise<event>` | 事件：`{type:"click",id}` / `{type:"input",value}`（逐键）/ `{type:"key",key,value}`（Enter 等）/ `{type:"error",message}` |

## 里程碑

### M1：native 两态 UI + 状态推送
- `PocToolbarView` 升级为 `ToolbarContentView`：按钮态（生成式填充/移去/关闭）+ 输入态
  （提示词输入框 + 生成/取消），状态文本行（含错误样式），busy 时按钮禁用；
- `setToolbarState` 导出：主线程重建/更新视图内容（保留输入框已有草稿：mode 切回
  buttons 时清空，切回 input 时恢复 value）；
- 输入框逐键回传 `input` 事件，Enter 回传 `key` 事件（键盘用局部 `NSEvent`
  monitor 或 NSTextFieldDelegate —— 首选 delegate，避免全局 hook 风险）。

### M2：JS 侧切换到 native 浮窗
- [SelectionPanel.tsx]：`checkSelection` 的显隐逻辑不变，但「浮现/收起」从
  `setShowDialog + <dialog>` 改为 `showToolbar/hideToolbar + setToolbarState`；
- `toolbar.ts` 封装升级：状态缓存（幂等推送，state 未变不重复推）+ 事件循环管理
  （启停、防重入）；
- 动作路径复用现有 `runGenerate/runRemove/runAction/friendlyPsBusyError`，操作
  结果通过 `setToolbarState({status})` 反馈到浮窗；
- 「关闭」= hideToolbar + 停轮询（同现有 runClose 语义：同选区不自动重开）。

### M3：清理 + 验证 + 提交
- 删除 UXP dialog 相关：dialog JSX、`showDialog` state、跨窗口原生绑定逻辑
  （bind/unbind/draftRef）、浮窗相关 SCSS、`scripts/position-toolbar.swift`
  （native 自定位后外部工具不再需要）；
- 验证清单：
  - [ ] 无选区隐藏 / 有选区出现，位置一出现即正确（右缘贴中线、底缘 1/4），无闪烁
  - [ ] 两态切换（生成式填充 → 输入态 → 取消回按钮态）
  - [ ] 输入提示词 + Enter / 点生成 → 入队，浮窗显示「已加入队列」
  - [ ] 移去（空提示词）→ 入队
  - [ ] PS 正忙时操作 → 友好错误文案显示在浮窗
  - [ ] 关闭 → 收起且同选区不重开；选区变化后重新浮现并重定位
  - [ ] 点击浮窗不抢 PS 焦点；PS 失焦浮窗不消失
  - [ ] 重载插件无窗口泄漏、无崩溃（terminate 路径）
  - [ ] `npm test`（397+）全过、tsc 无新错、vite build 成功
- 提交 feat/modal-dialog（含 POC 过程代码与计划文档）。

## 不做（本期）
- 浮窗拖拽移动（自动定位已满足需求；要拖拽需实现自定义 drag loop，后议）；
- WKWebView 壳（POC 用纯 AppKit 已够；视觉复杂化后再评估）；
- Windows 平台（现有 bridge 本就 macOS-only）。
