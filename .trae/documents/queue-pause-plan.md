# 可阻塞（可暂停）队列 —— 计划文档

分支：`feat/pausable-queue`（基于 main @ 22ec4df）
状态：待评审

## 1. 需求理解

用户原话：「有一个按钮可以在开始前停止队列，并非不接收队列，例如我有 10 张图，我可以先暂停队列，然后将我所有需要修改的全部做好选区，然后点开始队列，这样就不会在我使用时抢占资源」。

语义澄清（调查后确认的理解）：

| 维度 | 结论 |
| --- | --- |
| 暂停什么 | **队列的执行（出队）**，不是接收。暂停期间用户继续点「生成」，任务照常入队、照常落盘，只是不启动 |
| 开始什么 | 恢复出队：点击「开始」后，积压任务按创建时间 FIFO 依次执行 |
| 典型场景 | 暂停 → 批量做选区（每个选区点生成 → 入队挂起）→ 开始 → 10 个任务依次跑 |
| 目的 | Siliconed 渲染 / 云端请求不与用户操作（选区、PS 交互）抢资源 |
| 正在执行的任务 | 暂停**不中断**已启动的任务：它跑完自然结束，此后 Siliconed 空闲。不做渲染中途挂起（Siliconed 无检查点，中断即作废，且需要改 CLI） |

用户提到「这个还需要修改 Siliconed CLI，先暂停」——调查结论：**插件侧暂停不需要修改 Siliconed CLI**（见 §2.3）；「修改 CLI 先搁置」的正确理解是本分支完全不动 CLI。

## 2. 调查结论

### 2.1 现有调度链路

```
入队（不判暂停）                         执行（暂停拦截点）
RedrawPanel 生成按钮                      QueueScheduler.notify()（队列变化/任务结束）
  → enqueueCapture / enqueueExpandCapture   → dispatch()
    → persistCapture 落盘（立即）              → selectRunnableJobs(jobs, {active, concurrency})   ← 纯函数，queue.ts
    → queueStore.add（入队+落盘）                → 按 lane 容量选 queued / autoPlace 任务
    → queueScheduler.notify()                 → start(job) → runner.run(job)
```

- `selectRunnableJobs`（[queue.ts](../../src/task/queue.ts#L199-L216)）是唯一的出队选择点：`job.status !== "queued" && !(placePhase && job.autoPlace)` 则跳过。**在这里加「暂停」判定即可**，纯函数可单测。
- 调度器不记录「暂停」概念；中断 inFlight 任务不属于调度器职责（runner 持有 controller）。
- 入队路径完全独立于出队；容量语义变更见 §3.7。

### 2.2 关键行为事实

- `busy`（RedrawPanel L267）= `queue.some(isActive)`，暂停后 inFlight 任务跑完即变 false；「清空已完成」按钮不受暂停影响。
- lane 容量：siliconed / iopaint / place 各为 1，network 按 `concurrency` 设置。
- 贴回 lane（`pendingPlace` + `autoPlace`）是 PS 本地操作，不占 Siliconed，生成完成即自动贴回。
- 队列元数据 `queue.json`（`QueueMeta`）已有 `version`/`jobs` 字段，`serializeQueue`/`parseQueue` 为纯函数，加字段即可随任务一起持久化。
- **重启现状**：`initQueueRuntime()`（[queueRunner.ts](../../src/task/queueRunner.ts#L799-L809)）加载磁盘队列后立即 `notify()` → 重启后积压的 queued 任务**会自动开跑**。这是暂停状态必须持久化的直接依据（D4）：否则暂停后重启，积压任务会立即抢占资源，违背用户预期。
- **队列容量现状**（用户确认：暂停场景必须解除限制）：
  - `QUEUE_LIMIT = 20`（[queue.ts](../../src/task/queue.ts#L34)）：满 20 条时入队**只淘汰最旧终态项**（[add()](../../src/task/queueStore.ts#L386-L403)），排队任务绝不挤掉；但**没有终态项可淘汰时会拒绝入队**（报「队列已满」）——暂停期间批量做选区，第 21 条进不来。
  - **失败项会被挤掉**：`isTerminalQueueStatus` 含 `failed`（[queue.ts](../../src/task/queue.ts#L124-L128)），可重试的失败任务算「未执行完」，不应被新任务挤出。
  - **重启恢复截断**：`queueStore.init()` 里 `recoverInterruptedJobs(...).slice(0, QUEUE_LIMIT)`（[queueStore.ts](../../src/task/queueStore.ts#L338)）——暂停期间入队 50 条后重启会真的丢任务（截掉最旧的），必须一并修。
  - **磁盘上限已经安全**：`planDiskCleanup` 只清终态项文件（[queueStore.ts](../../src/task/queueStore.ts#L89-L90)），queued/running/pendingPlace 永不清理；磁盘真满时入队写文件失败属合理物理保护，无需改。

### 2.3 为什么不需要修改 Siliconed CLI

- 暂停发生在**插件出队层**：暂停期间插件不再调用 `silicontrol add`，Siliconed 侧队列自然清空（排队中的远端任务已取消 / 已结束），用户做选区时 Siliconed 完全空闲。
- 需要改 CLI 的场景只有「暂停时把正在渲染中的 Siliconed 任务也挂起、恢复后从断点继续」——Siliconed 渲染没有检查点，挂起等于作废，价值低、成本高。**不做。**
- 「开始」后依次提交积压任务，Siliconed 自己的排队（64 上限）不介入：插件保持单飞（siliconed lane 容量 1），一次只投一个。

## 3. 方案

### 3.1 状态与持久化

- `QueueMeta` 增加 `paused?: boolean`（缺省 = 未暂停，兼容旧文件）。
- `QueueStore`：
  - `isPaused(): boolean` / `setPaused(paused: boolean): void`（`notify()` + `scheduleSave()`，与其他修改同一落盘管道）；
  - `pendingCount(): number`（`status === "queued"` 计数，UI 显示积压量）。
- `parseQueue`：对象级解析保留 `paused`（字段缺省 false；旧文件无此字段不受影响）。
- **暂停状态跨会话持久**：重启 Photoshop 后若上次为暂停态，积压任务保持挂起，不会自动开跑——与队列任务持久化的语义一致（启动恢复只把 running 标失败，queued 原样保留）。

### 3.2 出队拦截（纯函数）

```ts
export interface RunnableOptions {
  active: Readonly<Record<string, number>>;
  concurrency: number;
  /** 全局暂停：生成 lane 不再选出新任务；place lane 照常。 */
  paused?: boolean;
}

// selectRunnableJobs 内：
if (options.paused && !placePhase) continue;   // 生成任务全部跳过（仍按 FIFO 继续找 place 项）
```

- 贴回（place lane）**不暂停**：贴回不占 Siliconed、通常数秒完成；暂停它只会让用户晚拿到结果，与「不抢资源」的目标无关。
- 已在跑的任务：调度器从不中断 inFlight（`start` 的 promise 未结算前不会重复派出同一 job），暂停天然只作用于「还没启动的」。

### 3.3 调度器接线

- `QueueSchedulerHost` 增加 `paused: () => boolean`；`dispatch()` 把它传给 `selectRunnableJobs`。
- 运行时（[queueRunner.ts](../../src/task/queueRunner.ts#L781-L787)）：`paused: () => queueStore.isPaused()`。
- `QueueStore.setPaused()` 内部 `notify()` → 调度器立即重派发（暂停时选不出任务；恢复时立刻开始积压任务）。

### 3.4 UI（RedrawPanel 队列头）

- `queue-tools` 增加「开始队列 / 暂停队列」按钮（放在「清空已完成」左边）：
  - 未暂停：`暂停队列`（点击 → `setPaused(true)`）；有积压时按钮文案带数量 `暂停队列（12）` 可选，见 §4 决策点 D1；
  - 已暂停：`开始队列`（点击 → `setPaused(false)`）；
  - 两种状态都始终可点（无 disabled），幂等。
- 标题行状态字（L836 `busy ? " · 进行中" : ""`）改为三态：
  - 已暂停且无 inFlight：` · 已暂停（积压 N）`；
  - 已暂停但有 inFlight：` · 收尾中（渲染结束后暂停生效）`；
  - 未暂停：维持现状（` · 进行中` / 空白）。
- 暂停期间入队成功提示不变（「已加入队列」）；可在提示后追加「（队列已暂停，点击「开始队列」执行）」，见 §4 决策点 D2。
- 队列折叠态同样显示暂停按钮（tools 在 head 里，不受折叠影响）。

### 3.5 与既有功能的交互

| 功能 | 暂停时的行为 |
| --- | --- |
| 入队（生成 / 扩图） | 照常入队落盘（用户要求：不拒收） |
| 取消（cancel） | 照常：queued 任务直接 drop-now；running 任务不受暂停影响 |
| 重试（retry） | 照常改回 queued，恢复后按 FIFO 执行 |
| 手动贴回（requestPlace） | 照常进 place lane 并执行（贴回不暂停） |
| 队列容量 | 变更后语义（§3.7）：completed/cancelled 超 20 自动淘汰；failed/queued 不受 20 条约束；总硬上限 200 条。磁盘字节上限（默认 2GB）照旧，满时入队报错 |
| 设置变化（并发数） | `refreshQueueRuntime` 会 notify → 暂停态下仍选不出任务，无副作用 |
| 清空已完成 | 不受暂停影响 |

### 3.6 单测（纯函数优先）

- `queue.test.ts`：
  - `selectRunnableJobs` 带 `paused: true`：queued 全部跳过；pendingPlace+autoPlace 照常选中；paused 缺省（旧调用方）行为不变；
  - `paused: true` 且无 place 任务 → picks 为空。
  - `findEvictableFinishedJob`（新，替代 findEvictableJob 的调用点）：只返回 completed/cancelled，不含 failed。
- `queueStore.test.ts`：
  - `setPaused`/`isPaused` 往返；`parseQueue` 读旧文件（无 paused 字段）→ false；
  - `serializeQueue` 写入 paused → 再读回一致。
  - 容量语义：终态项超 20 自动淘汰最旧 completed/cancelled；failed 不被淘汰；非终态（queued）超过 20 条仍能入队；总数超硬上限（`QUEUE_HARD_LIMIT`）才报错；init 恢复不再 `.slice()` 截断（只截终态）。
- 调度器（如有既有测试）：host.paused 返回 true 时 dispatch 不启动任务、恢复后 notify 触发启动。

### 3.7 队列容量语义变更（用户确认）

核心原则：**未执行的不淘汰、执行结束的淘汰**（用户原话）。

- **条数上限语义变更**：`QUEUE_LIMIT`（20）从「总队数上限」改为「**终态项保留上限**」：
  - `completed` / `cancelled` 超过 20 条 → 入队时自动淘汰最旧终态项（现状逻辑保留，语义更明确）；
  - **`failed` 不再可被淘汰**（可重试，算未执行完）：`findEvictableJob` → 新纯函数 `findEvictableFinishedJob`（completed/cancelled only）；
  - **非终态项（queued / running / pendingPlace / failed）不计入上限**，暂停期间可连续入队；
  - **失控保护**：新增 `QUEUE_HARD_LIMIT = 200`（纯防御，正常触不到；触发时报错文案改为「队列积压过多（>200 条），请先执行或清理队列」）。200 条同时对 UI 列表渲染（缩略图）留有余量。
- **重启恢复不再截断**：`init()` 移除 `.slice(0, QUEUE_LIMIT)`，改为只保留硬上限内任务（实际由 `add()` 保证；恢复时超硬上限只截终态）。
- **磁盘上限不变**：`planDiskCleanup` 现状已满足「未执行不清理」（只清终态文件）；暂停期间大量入队的实际约束是磁盘字节（默认 2GB，可在设置调整），磁盘满时入队失败报错——物理保护，不改。
- **提示语**：入队成功提示不变；被自动淘汰的终态项无需提示（用户可见列表里终态项数量恒 ≤ 20）。

## 4. 决策点（默认按推荐值实现，评审时可改）

| # | 决策 | 推荐 | 备选 |
| --- | --- | --- | --- |
| D1 | 暂停按钮是否显示积压数 | 暂停后显示 `开始队列（12）`；运行态只显示 `暂停队列`（数量看标题行） | 按钮恒显数量 |
| D2 | 暂停期间入队提示 | 「已加入队列（队列已暂停）」一次性提示 | 静默 |
| D3 | place lane 是否随暂停 | 不暂停（推荐，见 §3.2） | 一并暂停 |
| D4 | 暂停状态持久化 | 持久（重启后保持暂停，见 §3.1） | 会话内（重启自动恢复执行） |
| D5 | 失控保护硬上限 | `QUEUE_HARD_LIMIT = 200`（非终态 + 终态总数；触发报错「请先执行或清理」） | 不设上限（磁盘字节上限兜底） |

## 5. 里程碑

- **M1 状态与拦截**（纯函数 + store + 调度器接线）：
  - 暂停：`QueueMeta.paused`、`QueueStore.setPaused/isPaused/pendingCount`、`RunnableOptions.paused`、`QueueSchedulerHost.paused`、运行时接线；
  - 容量语义（§3.7）：`findEvictableFinishedJob`、`QUEUE_HARD_LIMIT`、`init()` 恢复不截断；
  - 配套单测。
- **M2 UI**：RedrawPanel 队列头「暂停/开始」按钮 + 三态标题字 + 入队提示（D1/D2 默认值）+「队列积压过多」错误文案；全量 `npm test` + `npm run build`。

## 6. 风险

- **重复入队心智**：暂停期间用户可能误以为任务没进队列。靠入队提示（D2）+ 队列列表可见（queued 项本来就在列表里）缓解。
- **积压恢复顺序**：FIFO 按 `createdAt`，与现有 `selectRunnableJobs` 排序一致，无新增逻辑。
- **暂停与「清空已完成」并存**：clearFinished 不动 queued/running，无冲突。
- **旧版本队列文件**：`parseQueue` 对未知字段宽松（只校验必备字段），`paused` 缺省 false，无兼容问题。
- **大量积压的 UI 渲染**：硬上限 200 条，列表渲染（缩略图懒加载已有 tick 机制）可承受；磁盘字节上限（默认 2GB）先于条数上限到达——每条任务文件约 1-10MB，200 条 ≈ 0.2-2GB，二者量级匹配。
- **终态项自动淘汰是静默行为**：completed/cancelled 超 20 条时最旧的被删（结果文件一并删）。现状行为不变（原本也只在入队时淘汰），但暂停场景用户可能积累大量终态项后再入队触发连锁淘汰——文案与 UI 数量上限保持透明即可。
