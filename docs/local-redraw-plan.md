# PS 内 AI 局部重绘（火山 Seedream）实现方案

> 状态：已评审定稿，待实施
> 日期：2026-10-31
> 参考项目：github.com/383158353-sys/ps-local-edit（仅借鉴交互与 PS 管线，不使用其 API）
> 目标 API：火山方舟 Ark `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`

---

## 1. 目标与范围

在 rocxps（Bolt UXP Photoshop 插件，manifest v6 / PS 24.2+ / React 19 + TS）内实现：

1. **选区局部重绘**：PS 原生选区（框选/套索）→ 捕获扩展区域 → 调火山 Seedream 图生图 → 结果自动贴回原位置。
2. **异步多任务**：可连续框选多处并发生成，插件自动把每个结果贴回对应位置；任务面板全程可查、可重试、可重贴。
3. **8 像素对齐预处理**：选区向外扩展，使发送给模型的区域宽、高两个边长都被 8 整除。

已确认的关键决策：

| 分叉点 | 决策 |
|---|---|
| API 通道 | 火山方舟 Ark（Bearer API Key，同步返回） |
| 贴回策略 | 默认**蒙版合成**（结果图层套原选区蒙版，只显示选区内像素），设置里可切「整块替换」 |
| 尺寸策略 | **精确 WxH**（8 整除），小选区低于模型最小总像素时自动放大请求、贴回时缩回 |

---

## 2. 调研结论

### 2.1 参考项目可借鉴点（源码核心：`plugin/modules/ps.js`）

- **选区捕获管线**：batchPlay 读取 `selection` bounds → `executeAsModal` + `suspendHistory`（历史零污染，结束回滚）→ `selection.selectRectangle(扩展区域)` → `activeLayer.copy(true)`（copyMerged）→ 新建同尺寸临时文档 → `paste()` → `saveAs.png` 读二进制 → 关临时文档恢复现场。
  - **关键坑**：PS 的 copyMerged 会裁掉透明边缘，参考项目靠在四角/中心铺 1px「技术像素」绕过，直接照搬。
- **蒙版捕获**：`imaging.getSelection()` 在进入 modal 前拿到原选区灰度 ImageData；贴回时用它做图层蒙版。
- **贴回**：batchPlay `placeEvent` 放置 → `transform`（百分比缩放）+ `move`（delta 平移）精确对齐原 bounds；全程 `suspendHistory` 合并为一次 undo。
- **任务队列**：jobs 数组 + 状态机 + persist。其轮询模型不适用（Ark 是同步接口），但状态机与「画布变化阻止导入」规则保留。

### 2.2 Ark Seedream API 关键约束

| 约束 | 值 | 影响 |
|---|---|---|
| 输出尺寸 | 支持显式 `宽x高` | 可精确请求 8 整除尺寸 |
| 输出总像素下限 | **921600**（1280×720） | 小选区必须放大请求尺寸，贴回时缩回 |
| 输出总像素上限 | 16777216（4.0/4.5）、4624220（5.0 pro/flash） | 超大选区缩小请求，贴回时放大 |
| 宽高比范围 | [1/16, 16] | 极端长条选区拦截提示 |
| 输入图限制 | 宽高 >14px、≤30MB、总像素 ≤6000×6000 | 正常捕获均满足 |
| 返回格式 | `url`（24h 有效）/ `b64_json` | **选 b64_json**，避免把 TOS 下载域名加进白名单 |
| 水印 | `watermark: false` | 需实测账号是否允许 |
| 错误 | HTTP 状态码 + error 信息；内容审核拦截为 terminal | 错误分类见 §6 |

**模型策略**：

- 默认 `doubao-seedream-4-0-250828`：显式 WxH 路线，支持多参考图（≤14 张）。
- `doubao-seededit-3-0-i2i`（指令编辑）：`size: "adaptive"` 输出跟随输入图尺寸 → 天然像素对齐、**不受 921600 下限约束**，小选区首选。
- 预留 `doubao-seedream-4-5-251128`、`doubao-seedream-5-0-lite-260128` 等模型选项。

---

## 3. 总体架构

```
src/
├── api/photoshop.ts          # 已有，扩充 PS 桥
├── ps/
│   ├── selection.ts          # 选区 bounds 读取 + 8整除扩展计算（纯函数，可单测）
│   ├── capture.ts            # 选区捕获：copyMerged→临时文档→PNG base64 + 蒙版捕获
│   ├── placeBack.ts          # 贴回：放置/对齐/图层蒙版，全部 executeAsModal
│   └── guard.ts              # 文档存活/画布变化/重复贴回校验
├── task/
│   ├── taskManager.ts        # 任务状态机 + 并发调度 + onChange 订阅
│   ├── taskStore.ts          # 任务记录（M3 内存态，M4 落盘恢复）
│   └── types.ts
├── ark/
│   ├── client.ts             # Ark HTTP 客户端（b64_json、错误分类、AbortController 超时）
│   ├── sizeStrategy.ts       # 8整除尺寸 → 请求尺寸换算（纯函数，可单测）
│   └── models.ts             # 模型预设与参数差异表
├── settings/
│   └── store.ts              # API Key 存 UXP secureStorage，其余存 plugin data
└── components/
    ├── TaskList.tsx          # 任务卡片：缩略图/状态/重试/重贴
    ├── CaptureCard.tsx       # 选区状态：原 bounds → 扩展后尺寸预览
    └── SettingsPanel.tsx     # 挂到已有 .settings 二级面板
```

### 并发模型：网络并发 + PS 串行

- **网络层可并发**（默认 2，可配置）：Ark 的 HTTP 请求不碰 PS 状态。
- **PS 操作层必须串行**：捕获与贴回全部走 `executeAsModal`。原因：
  1. modal state 是宿主级互斥锁，同一时刻只允许一个 modal context，并发调用会报错；
  2. PS 操作全依赖全局状态（`activeDocument`、`doc.selection`、系统剪贴板），没有事务隔离，交错执行会互相污染（贴错图/贴错位置/还原错选区）；
  3. 捕获与贴回均为几百毫秒级快操作，串行几乎无吞吐损失（耗时大头在生成）。
- 实现：taskManager 内部维护 `captureQueue` / `placeQueue` 两条串行队列；两队列都受同一 modal 锁约束，彼此亦互斥。

---

## 4. 核心算法：8 整除边界扩展

需求：扩展区域必须仍完整包含原选区，且扩展区域**宽、高两个边长**均被 8 整除（每边最多外扩 7px）。

```text
输入：选区 (l, t, r, b)，画布 (W, H)

1. 目标边长（只向上取整）：
   W' = ceil((r - l) / 8) * 8
   H' = ceil((b - t) / 8) * 8
   dx = W' - (r - l)          # 0..7
   dy = H' - (b - t)

2. 居中分配外扩量：
   L = l - floor(dx/2)      R = L + W'
   T = t - floor(dy/2)      B = T + H'

3. 画布内平移（左右/上下互推，不改变 W'/H'）：
   if L < 0:  R -= L; L = 0
   if R > W:  L -= (R - W); R = W     # L 再变负 → 画布横向放不下 W'
   T/B 同理

4. 兜底（画布放不下 8 倍数，极少见）：
   → 补边导出模式：虚拟区域 = 选区 ± pad 至 8 倍数（可超出画布），
     临时文档建为虚拟区域尺寸，画布外部分粘贴前用边缘像素延展填充，
     记录 padL/padT，贴回时先裁掉补边再对齐。

输出：{ bounds: {L,T,R,B}, padInfo?: {...} }
```

### 请求尺寸换算（`sizeStrategy.ts`，Seedream 显式 WxH 路线）

```text
P = W' × H'
minP = 921600；maxP = 16777216（4.0/4.5）或 4624220（5.0 pro/flash）
if P < minP:  s = sqrt(minP / P)；reqW = ceil(W'·s/8)·8，reqH = ceil(H'·s/8)·8
if P > maxP:  s = sqrt(maxP / P)；reqW = floor(W'·s/8)·8，reqH = floor(H'·s/8)·8
requestScale = reqW / W'
→ 请求 size = "reqWxreqH"；贴回前把结果图缩放回 W'×H'
→ 宽高比超出 [1/16, 16] 时直接报错拦截
```

UI 的 CaptureCard 实时展示整条链路：`选区 317×205 → 发送 320×208（已对齐 8px）→ 请求 1792×1168（模型下限放大）`。

seededit 分支不走该换算：`size: "adaptive"`，输入即输出尺寸，零缩放。

---

## 5. 任务生命周期

Ark 是同步接口，无平台侧任务 ID，「异步记录」由插件侧任务系统承载：

```text
draft → capturing → queued → generating → placing → done
                                   │
                                   ↘ failed / cancelled / needsAttention
```

- **capturing（同步、立即）**：点击「生成」瞬间，在 modal 内原子完成「读 bounds → 8整除计算 → 捕获 PNG → 捕获蒙版」。必须同步做——用户随即会去框下一个选区。
- **queued / generating（异步、可并发）**：捕获完立即入队并返回 UI；每个任务一条 Ark 长请求（AbortController 超时 300s），并发上限默认 2。
- **placing（自动贴回）**：结果到达 → 解码 b64 → 进 placeQueue → `executeAsModal` + `suspendHistory`：放置 → 缩放回 W'×H' → 对齐 bounds → 套原选区图层蒙版（可选 1px feather）→ 单次 undo 生效 → done。
- **guard 校验**（placing 前，`ps/guard.ts`）：文档仍打开（docId 存活，曾保存则比对 path）、画布尺寸未变、该任务未贴回过。任一不满足 → 置 `needsAttention`，任务卡片提供「手动贴回」，绝不静默贴错位置。
- **任务面板**：缩略图 + 提示词摘要 + 状态 + 耗时 + 操作（重试=只重发网络请求；重贴=只重放 placing；删除）。
- **持久化（M4，可选）**：任务 JSON + 结果 PNG 写 plugin data folder，面板重开恢复历史并重新贴回；保留「画布变化阻止导入」规则。
- 蒙版合成与整块替换都实现；设置里默认蒙版合成，任务提交时可单次切换。

---

## 6. Ark 客户端要点

```json
POST https://ark.cn-beijing.volces.com/api/v3/images/generations
Authorization: Bearer <API_KEY>
{
  "model": "doubao-seedream-4-0-250828",
  "prompt": "<用户指令>",
  "image": ["data:image/png;base64,....."],
  "size": "1792x1168",
  "response_format": "b64_json",
  "watermark": false,
  "sequential_image_generation": "disabled"
}
```

- **错误分类**：terminal（400/401/403、内容审核拦截）直接 fail 不重试；可重试（429 读 Retry-After、5xx、网络抖动）指数退避最多 2 次。
- **超时请求绝不自动重发**（无法确认是否已计费），重试按钮交给用户。
- seededit 分支：`size: "adaptive"`，跳过 sizeStrategy 换算。
- API Key 存 `uxp.storage.secureStorage`；错误信息对 key 脱敏。
- 提示词拼装：用户指令 + 可选固定后缀模板（默认「保持选区外画面完全不变」），模板可在设置中修改。

---

## 7. manifest / 工程变更

- `uxp.config.ts` → `requiredPermissions.network.domains` 增加 `https://ark.cn-beijing.volces.com`（b64_json 路线仅需此域名）。
- `host.minVersion` 24.2 不变；`imaging.getSelection` / `imaging.putSelection` 在 24.2+ 可用。
- 启用已注册的 `${id}.settings` 二级面板（放开 `src/main.tsx` 中 `<uxp-panel>` 注释）。

---

## 8. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0** | 模块骨架 + 设置面板（Key 进 secureStorage）+ manifest 网络权限 | 面板能保存/读取 Key，能发一条测试请求返回 200/401 |
| **M1** | 选区捕获管线：bounds + 8整除扩展 + 蒙版捕获 + copyMerged 导出 | 任意选区（含贴画布边缘、非矩形套索）导出正确 PNG；`selection.ts`/`sizeStrategy.ts` 有 Node 单测 |
| **M2** | Ark 客户端 + 单任务端到端：生成 → 整块替换贴回 | 框选 → 输入指令 → 结果以新图层精确对齐原位置 |
| **M3** | 任务队列 + 状态机 + 任务列表 UI + 自动贴回（蒙版合成）+ guard | 连续框选 3 处并发生成各自自动贴回；小选区（<921600）走放大-缩回路线 |
| **M4** | 打磨：seededit adaptive 分支、失败重试/手动贴回、任务持久化恢复、参考图支持 | 断网/关文档/画布改动等异常路径均有明确 UI 反馈 |

---

## 9. 风险与待验证项

1. **UXP fetch 长请求稳定性**（300s 同步 HTTP）：M2 第一时间实测；若 UXP 层有隐形超时，提示用户重试，不自动重发。
2. **watermark:false 权限**：部分账号需实名/企业认证；设置保留开关，实测不行则明示「水印由账号策略决定」。
3. **b64_json 内存压力**：4K 图 base64 约 30–40MB JSON；M2 实测，必要时大尺寸任务切 url 模式并把 TOS 域名加入白名单（需重新打包）。
4. **copyMerged 透明裁剪坑**：照搬技术像素 workaround，M1 用含透明的 PSD 验证。
5. **贴回时用户正在操作 PS**：placeQueue 全走 modal，PS 忙时排队，卡片显示「等待 PS 空闲」，不强制打断。
6. **计费感知**：同步接口超时/中断无法查询是否已计费——UI 明示，重试为用户主动行为。
