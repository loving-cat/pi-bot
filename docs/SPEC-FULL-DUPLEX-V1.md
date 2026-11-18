# 规格：全双工边干边聊架构（SPEC-FULL-DUPLEX-V1）

> **状态**：草案 · 待实施（v1.0）
> **适用范围**：`server/src/` 调度与执行层、`app/lib/` 客户端状态与聊天交互层
> **关联规格**：`docs/spec-convergence-v1.md`、`docs/AGENT-MODEL.md`、`docs/DECISION-ROUTER.md`、`docs/TASK-RUN-PROTOCOL.md`、`docs/SPEC-MOTION-V1.md`
> **核心定位**：让「正在干活的手（`Work Lane`）」与「随时陪聊的嘴（`Talk Lane`）」物理拆轨——后台跑长命令、改代码、调成员期间，用户在私聊或部门群发新消息时，Bot 能 1 秒内结合实时进度秒回，不排队卡死、不误掐运行中的工作流。

---

## 0. 五条硬规矩

对齐 `docs/spec-convergence-v1.md` 第 0 节，全双工改造必须守住以下五条结构约束：

1. **先骨架，再延伸**：忙时意图分流器（`server/src/duplex-router.js`）与实时工作台快照投影（`server/src/live-work-snapshot.js`）必须写成**零 IO、不 import `store`、不隐式读时钟**的纯逻辑模块，先配齐单测，再接入 `pi-runner.js` / `ws.js` 薄接线层。
2. **一个事实只存一份**：旁路对话轨（`Talk Lane`）的只读工具边界必须直接派生自 `server/src/capabilities.js`（复用 `READONLY_ALLOW` 与 `dangerous: 'deny'` 策略过滤，再显式停用副作用扩展），禁止在第二个文件里手写工具白名单。
3. **单写多读、零并发写冲突**：同一 `(roomId, botId)` 任意时刻最多只有 **1 个**持久会话（`Work Lane`）有权打开并写入磁盘会话文件（`store.sessionFileFor(roomId, botId)`）及执行写文件 / 写 Shell / Git 操作；旁路对话轨（`Talk Lane`）强制运行在**内存态临时会话**中，严禁打开同一会话文件或挂载写类工具。
4. **请求回执与幂等不退化**：完整保留 `app/lib/app_state.dart` 的 `RequestOutbox`、`server/src/ws.js` 的 `openRequest` / `closeRequest`（`server/src/coordination/task-request-gate.js`）与 `request.result` 终态确认闭环——绝不能靠去掉 `requestId` 来“绕出”忙时秒回。
5. **一项一项收口**：按 `FD-0 → FD-1 → FD-2 → FD-3` 四阶段落地，由总开关 `PI_BOT_FULL_DUPLEX`（受控灰度 → 默认开启）护航；每阶段独立提交、独立测试、可无损退回半双工串行行为。

---

## 1. 现状实测与四个结构性根因

当前 `pi-bot` 看似允许用户在忙碌时继续打字发送，但实测行为仍是**半双工串行 / 粗暴打断**，根因集中在以下四处：

| # | 现状现象 | 代码真因（精确位置） | 后果 |
|---|---|---|---|
| **A** | **私聊忙时连“插话”都变成死排队** | `app/lib/app_state.dart`（`sendMessageTracked`）每次发送都携带 `requestId`；`server/src/ws.js`（`startAdmittedSend`）封装 `request: { scope }` 传给 `runner.send`。进入 `server/src/pi-runner.js` 的 `send()` 后，优先命中 `if (this.isBusy(roomId, botId) && request)`，**无论 `PI_BOT_TASK_INTAKE` 是否开启**，忙时消息一律进 `requestQueues` 等整轮完全结束再由 `#drainRequestQueue` 串行拉起。 | 哪怕后台正在跑 3 分钟脚本、只是问一句“到哪步了”，用户消息也会干等 3 分钟才进模型，连原有的 `steer` 通道也被旁路。 |
| **B** | **单会话“脑手耦合” + 跨 Bot 同步死等** | `PiRunner.sessions` 按 `${roomId}:${botId}` 单实例缓存；正在跑工具时 `entry.busy = true`，同一 `AgentSession` 无法并行第二个 `prompt()`。即使走旧 `steer()`，也需等当前阻塞工具返回，并调用 `store.moveMessageAfter` 将正在流式写的 `liveMsgId` 强行挪到用户新消息后面；同时 `server/src/tools.js` 的 `message_bot` 内部 `await runner.runBotOnce` 同步阻塞最长达 `300_000ms`。 | 1. 气泡在时间线上来回瞬移，因果顺序错乱。<br>2. 主控用 `message_bot` 找同事帮忙期间，主控自己也被整整堵死几分钟，无法陪用户说话。 |
| **C** | **部门群“一开口就全员急刹”** | `server/src/pi-runner.js` 的 `#dispatchGroupRound`（及 `send()` 的 `room.kind === 'group'` 分支）规定“用户说话 = 本轮作废”：无条件将房间加入 `aborting`、清空 `roundQueue`、向所有运行中成员发出 `abort`。 | 在群聊里随口问负责人一句“大家跑得怎么样了？”，正在执行测试或修改代码的成员会话会被当场掐断重来。 |
| **D** | **客户端单流 `typing` 假设误抹忙碌态** | `app/lib/app_state.dart` 对 `typing` 事件只维护 `typing[rid] = active` 布尔值与按 `botId` 去重的 `typingBots[rid]` Set，并在 `ev['active'] != true` 时执行 `queued.remove(ev['roomId'])`。 | 若服务端开出并行 `Talk` 轨并在 1 秒后发 `typing(active: false)`，客户端会误以为整房彻底空闲，当场抹除仍在后台执行的 `Work` 状态提示。 |

---

## 2. 总体架构：双轨会话（Work Lane + Talk Lane）与三路分流

### 2.1 三路分流决策模型

当 `(roomId, botId)`（或部门群）处于空闲状态时，仍走传统首轮调度；**仅当后台 `Work Lane` 处于 `busy` 时**，新到达的用户消息进入全双工路由器：

```text
用户新消息（后台 Work Lane 正在运行：entry.busy === true）
   │
   ▼
[Duplex Router：server/src/duplex-router.js]
   │（显式参数 explicit → 确定性规则 rules → 可选 Jev busy-intent → 保守 fallback）
   │
   ├──► 1. side_reply（问进度 / 追问原因 / 闲聊 / 只读查询）
   │         ├─ Work Lane ：零中断继续运行（工具/命令/成员派发原样推进）
   │         └─ Talk Lane ：使用 PRIORITY.human 保底槽 + LiveWorkSnapshot 只读快照
   │                        1s 内在聊天末尾生成独立气泡 talkMsgId，结束即销毁内存会话
   │
   ├──► 2. amend（补充约束 / 追加条件 / 顺手微调）
   │         ├─ Talk Lane ：秒回 1~2 句口头确认（"收到，已把新条件同步给当前执行"）
   │         └─ Work Lane ：保留原位置 workMsgId，调用 session.steer(structuredNote)
   │                        （或受管态走 taskControls），不强杀当前工具，下一步自动吸收
   │
   └──► 3. abort_replace（明确叫停 / 取消 / 推翻需求重来）
             └─ Work Lane ：触发精确 abort（最多 graceMs=5000ms），释放会话与房间锁后，
                            由新的主 Work 轮次按新需求重新开跑
```

### 2.2 双轨会话规格对照表

| 维度 | `Work Lane`（后台执行轨） | `Talk Lane`（前台陪聊轨） |
|---|---|---|
| **职责定位** | 干活：写代码、跑命令、调工具、跨 Bot 派发与验收 | 说话：秒回状态、解释原理、澄清需求、确认收到追加约束 |
| **会话池键** | `${roomId}:${botId}`（复用既有主会话键） | `${roomId}:${botId}:talk`（短生命周期旁路键） |
| **历史存储** | 持久化读写 `store.sessionFileFor(roomId, botId)` | **纯内存会话（In-Memory `SessionManager`）**，绝不碰磁盘会话文件 |
| **注入上下文** | 完整工作区、历史 JSONL 记忆、记忆摘要、技能/经验 | 系统人设 + 记忆摘要 + 最近 12 条房间消息 + `LiveWorkSnapshot` 实时只读投影 |
| **工具能力** | 按既有角色（`toolsForRole` / `customToolsForRole`）+ 部门策略授权 | **强制只读**：策略覆盖 `dangerous: 'deny'`；剥离 `bash` / `powershell` / `run_background` / `git` / MCP 扩展 / `accept_task` / `dispatch_to_department` / `message_bot` / `dispatch_bot` / `ask_user` |
| **并发槽位** | 普通/人类开轮按原有 `PRIORITY` 获取 `RunSlots` | **固定 `PRIORITY.human`**（使用 `PI_BOT_RUN_SLOT_RESERVE` 保底位，不被后台长任务堵死） |
| **消息承载** | 锚定在触发轮次创建时的原位 `workMsgId`（保留步骤列表） | 在用户最新发言正下方新建 `talkMsgId` 气泡，**永不调用 `moveMessageAfter`** |
| **生命周期** | 会话池缓存 + LRU 驱逐（`evictIdle`） | 单实例串行互斥（`talkInflight`），流式回复结束并在记忆摘要入队后立即 `releaseEntry` 释放 |

---

## 3. 核心纯逻辑模块规格（零 IO，可独立单测）

### 3.1 `server/src/duplex-router.js`（忙时意图路由器）

本模块**不 import `store`、不碰网络、不读全局时钟**。参考 `docs/DECISION-ROUTER.md` 第十节的**两段式设计**：明确结论必须在同步阶段直接返回，避免 `await` 让出事件循环导致用户的「停下」动作晚一拍生效。

#### 输入与输出契约
```js
/**
 * 同步预判输入（绝不 await）：能确定就立刻返回结果对象；拿不准时返回 kind: null 交由异步 Jev。
 */
export function classifyBusyInputSync({
  text = '',
  hasAttachments = false,
  explicitMode = 'auto',   // 'auto' | 'side_reply' | 'amend' | 'abort_replace'
  workSnapshot = null,     // 来自 LiveWorkSnapshot 的摘要，无则 null
  roomKind = 'dm',         // 'dm' | 'group'
  taskIntakeEnabled = false,
} = {}) -> {
  kind: 'side_reply' | 'amend' | 'abort_replace' | null,
  decidedBy: 'explicit' | 'rules' | 'fallback',
  confidence: number,
  reason: string,
}

/**
 * 异步统一入口：先跑同步预判；只有 kind === null 且开启决策路由时才调 jevDecidePoint。
 */
export async function routeBusyInput(input, {
  askDecision = null,      // 依赖注入：({ point, payload }) => Promise<result>
  signal = null,
} = {}) -> {
  kind: 'side_reply' | 'amend' | 'abort_replace',
  decidedBy: 'explicit' | 'rules' | 'jev' | 'fallback',
  confidence: number,
  reason: string,
}
```

#### 四级判定规则（优先级由高到低）
1. **`explicit`（最高优先级）**：若前端显式传入合法 `explicitMode`（`'side_reply' | 'amend' | 'abort_replace'`，非 `'auto'`），直接返回 `decidedBy: 'explicit', confidence: 1.0`。
2. **`rules`（确定性正则规则，零网络开销）**：
   - **明确打断重来（`abort_replace`）**：短句（`<= 40` 字）且命中强终止/推翻意图（如 `停` / `停下` / `停止` / `算了` / `取消` / `不用做了` / `别做了` / `重写` / `重来` / `换个方案` / `stop` / `cancel` / `abort`），同时**显式排除否定与无关句式**（如 `别停`、`不要停`、`不停`、`停不下来`、`先别取消`）。
   - **明确旁路问答（`side_reply`）**：纯进度/状态/闲聊询问，或以问号收尾且不含行动修改词（如 `怎么样了`、`到哪一步了`、`卡住了吗`、`报错是什么`、`为什么`、`在干嘛`、`status`、`progress`、`你好`、`在吗`），且不附带新文件附件（`!hasAttachments`）。
   - **明确附带附件的新指令（`amend` / 待裁决）**：若 `hasAttachments === true`（用户补发了新截图/新文档），`rules` 绝不判为 `side_reply`，默认进入需要 `Work` 感知的阶段。
3. **`jev`（注册决策点 `'busy-intent'`）**：
   - 在 `server/src/decision-router.js` 的 `POINTS` 注册 `'busy-intent'`：
     - `weight: POINT_WEIGHT.careful`（要求置信度门槛，比如 `>= 0.72`，否则落回 `fallback`）
     - `questions.intent`：`type: 'choice'`，`criteria` 分别定义 `side_reply` / `amend` / `abort_replace` 的清晰边界。
     - `build`：截取最近用户文本（`<= 1200` 字）+ `workSnapshot.goalExcerpt` + `workSnapshot.phase`。
4. **`fallback`（保守安全降级）**：
   - 含明确问句特征 → `side_reply`；
   - 否则统一落为 `amend`（把新条件顺带塞给后台）。
   - **铁律**：`fallback` **永远不自动返回 `abort_replace`**——宁可让 `Talk` 轨先确认一句，也绝不在语义模糊时误杀跑了 10 分钟的构建/分析任务。

---

### 3.2 `server/src/live-work-snapshot.js`（实时工作台只读快照投影）

`Talk Lane` 本身不打开磁盘会话、不跑命令，它为什么能答得准“我在干嘛”？全靠这个纯内存投影函数在发起 `Talk` 瞬间从服务端内存中拼出一份**脱敏、有界、结构化**的实时视图：

```js
export function buildLiveWorkSnapshot({
  roomId = '',
  botId = '',
  botName = '',
  goalText = '',
  workMsgId = null,
  workStartedAt = 0,
  nowMs = 0,
  recentSteps = [],     // 正在写的消息上的 msg.steps
  draftText = '',       // 正在写的消息已经吐出的部分文本
  activeShells = [],    // 从 ShellRegistry 筛选并预读取尾部输出的当前运行进程
  pendingAmends = [],   // 本轮已收到但还没完全落定的补充要求
  activeTaskRun = null, // 若开启 TaskRun：目标/版本/最近 attempt/打开的 gate
  maxChars = 2400,      // 总预算硬上限（避免挤占 Talk 首字速度）
} = {}) -> LiveWorkSnapshot
```

#### 投影字段与硬截断预算
| 字段 | 来源 | 上限控制 | 用途说明 |
|---|---|---|---|
| `phase` | 最近一条 `ToolStep` + `draftText` | 枚举：`thinking` / `tool_calling` / `streaming_reply` / `delegating` / `waiting_approval` | 让 `Talk` 一句话说清正在哪阶段 |
| `elapsedMs` | `Math.max(0, nowMs - workStartedAt)` | 整数毫秒 | 回答“跑了多久” |
| `goalExcerpt` | 触发本轮的用户消息/派活描述 | `<= 300` 字（单行清洗） | 防止 `Talk` 忘记当前后台到底在干什么活 |
| `steps` | `recentSteps.slice(-8)` | 每步只留 `tool`、`status`、`argsSummary`（`<= 120` 字）、`elapsedMs` | 回答“刚才跑了什么、成功还是卡在某一步” |
| `activeShells` | `ShellRegistry` 中同房间/Bot 未退出进程 | 最多 3 条；每条尾部输出 `<= 600` 字符 + 已做敏感脱敏 | 回答“ dev server 启动到哪、测试输出几行了” |
| `draftTail` | `draftText` 末尾截取 | `<= 400` 字符 | 让 `Talk` 与后台已初步成型的半截结论保持口径一致 |
| `sideNotes` | `workEntry.sideContext` + `pendingAmends` | 最多 5 条 | 避免用户连追问两句时 `Talk` 前言不搭后语 |
| `taskRunSummary` | `activeTaskRun`（仅受管模式有值） | `id`、`state`、`revision`、`attemptsCount`、`openGates` | 告知当前任务板状态 |

同时提供纯文本序列化函数 `formatLiveWorkSnapshotPrompt(snapshot)`（输出 `<= maxChars` 字的高密度状态卡片），以及群聊版 `buildGroupWorkSnapshot({ room, memberSnapshots })`——让部门负责人在群里一眼掌握每个在跑成员正在调用的工具与耗时。

---

## 4. 执行层改造规格（`session-factory.js` / `pi-runner.js` / `tools.js`）

### 4.1 内存旁路 `Talk` 会话构建（`server/src/session-factory.js`）

在 `createSessionBuilder` 下新增导出方法 `buildTalkSession(roomId, botId, { snapshotPrompt = '', recentMessages = [], memoryDigest = '' })`：

1. **零磁盘会话碰撞**：
   - 使用 SDK 内存态会话管理（不传 `store.sessionFileFor(roomId, botId)`，不读写磁盘 `.jsonl`），因此无论后台 `Work` 正在往同一会话文件写什么，物理上完全隔离。
2. **工具能力硬只读裁剪**：
   - 基于 `roleTools.toolsForRole` 与 `capabilities.js` 计算可用列表，但强制注入 `policy = { ...store.policy(), dangerous: 'deny' }`；
   - **不注册**任何工作区执行与状态修改工具：`bash` / `powershell` / `run_background` / `write_stdin` / `kill_shell` / `git-tools` / MCP 扩展 / `buildIntakeTools` / `buildReportTool` / `buildPlanTool` / `buildMemberTaskTool` / `buildExpertReviewTool` / `ask_user` / `message_bot` / `dispatch_bot` / `dispatch_to_department`。
   - 系统提示追加短指令：
     > 你现在处于「边干活边回话」的快速旁路频道：后台工具正在执行，请结合《实时工作台快照》直接用自然口吻在 2～4 句内回答用户问题或确认已记下补充要求；你无法在当前旁路频道直接改文件或跑命令，也不要重复复述快照格式。
3. **快速模型选择与低思考档位**：
   - 默认沿用 Bot 配置的模型；对强制高思考延迟过长的模型，可通过可选环境变量 `PI_BOT_TALK_THINKING`（默认 `'low'` 或 `'minimal'`）降延迟以保证 ~1s 级首字输出。

### 4.2 `PiRunner` 双轨调度与消息时间线（`server/src/pi-runner.js`）

#### (1) 新增运行期状态表
- `talkInflight = new Map()`：`key = "${roomId}:${botId}"`，记录正在运行的旁路 `Talk` 控制器与待合并尾随队列 `pendingTexts`（保证同一 Bot 同一时间**最多 1 路活跃 `Talk`**）。
- `runSlots.acquire(...)`：`Talk` 统一传入 `{ priority: PRIORITY.human, name: "talk:${botId}", timeoutMs: 5000 }`。

#### (2) 修通 `send()` 忙时路径（先修复根因 A，再接双轨）
```text
PiRunner.send(roomId, text, { mode, attachments, request, duplexMode })
  │
  ├─ room.kind === 'dm' && this.isBusy(roomId, botId)
  │    ├─ 若 !fullDuplexEnabled：
  │    │    · taskIntakeEnabled=true  -> 保持既有 requestQueues 排队不借身份
  │    │    · taskIntakeEnabled=false -> 修复回现有 steer/followUp + 正常在收尾 close(scope)
  │    └─ 若 fullDuplexEnabled：
  │         1. 先追加 userMessage 落盘并广播（不阻塞）
  │         2. 取当前 workEntry 构建 LiveWorkSnapshot
  │         3. 调用 routeBusyInput(...) 得 decision = { kind, decidedBy, confidence }
  │            广播 { t: 'duplex.routed', roomId, messageId: userMessage.id, requestId, ...decision }
  │         4. 按 decision.kind 分发（详见下方 4.2.3）
```

#### (3) 三路分发精确动作
- **分支 1：`side_reply`**：
  1. `Work` 会话与 `workEntry.liveMsgId` 原封不动继续跑；
  2. 触发 `#runTalkTurn({ roomId, botId, userMessage, snapshot, scope })`：
     - 创建新回复气泡 `talkMsg`（`meta: { duplex: 'side_reply', duringMsgId: workMsgId, re: userMessage.id }`）；
     - 推送 `{ t: 'typing', roomId, botId, active: true, lane: 'talk', msgId: talkMsg.id }`；
     - 流式 `msg.delta` → `msg.done`，结束推送 `{ t: 'typing', roomId, botId, active: false, lane: 'talk', msgId: talkMsg.id }`；
     - 将本轮一问一答写入 `workEntry.sideContext.push(...)`（FIFO 上限 1200 字）；
     - 立即 `releaseEntry` 销毁内存 `Talk` 会话；
     - 若存在 `request.scope`，调用 `this.requestLifecycle?.close?.(scope, err, 'answer')`。
- **分支 2：`amend`**：
  1. 若 `taskIntakeEnabled && hasActiveManagedTaskRun(roomId)`，**禁止私自 steer 改目标**，改为在 `Talk` 轨提示或桥接至受管修订/输入接口（见第 5 节）；
  2. 普通模式（或主控尚未建单）：
     - 先构造补充指令喂给后台 `workEntry.session.steer(amendedPrompt, files)`，记录 `workEntry.sideContext`；
     - **废弃**对用户来说破坏时间线的 `store.moveMessageAfter(roomId, liveMsgId, userMessage.id)`（不再把旧干活气泡从顶部抽到下面！）；
     - 同时拉起 1~2 句轻确认的 `#runTalkTurn(..., mode: 'amend_ack')` 立即安抚用户；
     - 在 `steer` 投递且轻确认完成后调用 `this.requestLifecycle?.close?.(scope, err, 'answer')`。
- **分支 3：`abort_replace`**：
  1. 将 `workEntry` 标记为 replaced 并发出 `abort`（复用 `#awaitPending(..., { graceMs: 5000 })` 防锁死）；
  2. `workMsgId` 保留已执行步骤并置终态 `done/aborted`，新需求携 `scope` 在锁释放后立即按新轮次启动。

#### (4) 记忆与气泡收尾闭合（防止“嘴上答应、下手忘了”）
- **旁路对话防遗忘**：后台 `Work` 正常结束时，如果 `workEntry.sideContext` 非空，服务端向持久主 `Work` 会话注入一条**静默系统备忘消息**（不单独生成用户可见气泡，只落进下一轮上下文，或在触发下次 `Work` 时拼入 `#buildInput` 前置备忘），确保“刚刚边干活边口头敲定的细节”绝不丢失。
- **跨屏交付锚点**：若 `Work` 结束时，房间里在 `workMsgId` 之后已经有了至少 1 条新对话消息：
  - 原 `workMsgId` 封口保留完整的 `ToolSteps` 过程记录；
  - 若 `Work` 产出了实质最终结论正文，为避免答案埋没在几十条聊天记录上面让用户滚回去找，在房间底部补一条带 `meta: { re: workOriginUserMsgId, fromWorkMsgId: workMsgId, via: 'work_finish' }` 的简洁结果回复（或若上面尚未产出正文仅跑了工具，则直接在底部创建最终交付消息）。

### 4.3 跨 Bot 异步派活工具 `dispatch_bot`（`server/src/tools.js` + `capabilities.js`）

解决根因 B 中的“主控派活被子 Bot 卡死 300 秒”：

1. 在 `server/src/capabilities.js` 的 `TOOL_SPECS` 单点新增能力声明 `'delegation.dispatch'`（绑定工具 `dispatch_bot`），按现有派手机制自动同步到 `action-catalog.js` / `role-tools.js` / `migration-grants.js`。
2. 形成清晰的跨 Bot 协作三层体系：
   - `reply_bot`（既有）：向同事问一句话（`<= 60s`），不立项。
   - `dispatch_bot`（新增推荐）：主控或非成员在确认目标、交付物与约束后异步投递，**不 `await runBotOnce` 结束**：
     - 立即返回 `{ ok: true, dispatchId, botId, status: 'dispatched' }`，主控当场结束自己这轮工具等待、可立刻面向用户说话；
     - 后台子任务通过 `PRIORITY.normal` 获取运行槽位执行；完成时调用现有 `mirrorDelegatedResult`（`server/src/delegated-delivery.js`）将成果与附件投递至当前派活房间，若来源会话空闲则唤起主控简短汇总（忙碌则进 `followUp` 队列）。
   - `message_bot`（既有保留）：继续用于明确需要**当前推理链立刻拿到结果再做下一步决策**的短同步调用。

### 4.4 部门群聊全双工（`pi-runner.js` `#dispatchGroupRound`）

当 `room.kind === 'group'` 且房间内有成员/负责人正在忙时：
- 不再无条件 `abort` 全员；同样走 `routeBusyInput({ roomKind: 'group', ... })`：
  - `side_reply`：保持 `roundQueue` 和当前在跑成员会话完全不断，仅唤醒**部门负责人 `leadBotId`** 挂载 `buildGroupWorkSnapshot` 走只读 `Talk` 轨在群里秒回进度与解释。
  - `amend`：负责人 `Talk` 轨立即回复确认 + 对受影响且正在跑的成员注入 `steer`（已排队未开跑的 `roundQueue` 条目追加补充约束提示）。
  - `abort_replace`：执行既有 `#dispatchGroupRound` 全员急刹、`roundQueue` 清空与负责人重新派发。

---

## 5. 与 `TaskRun` 受管引擎及 `RequestOutbox` 的协议对齐

必须与 `docs/TASK-RUN-PROTOCOL.md` 保持 100% 一致，绝不撕裂请求终态闭环：

| 开关态 | 忙时路由结果 | 服务端 `scope` 与回执动作 | 客户端 `RequestOutbox` 表现 |
|---|---|---|---|
| **`PI_BOT_TASK_INTAKE = 0`**<br>（默认聊天态） | `side_reply` | 由 `Talk` 轨独占该 `scope`；`Talk` 流式结束时调用 `requestLifecycle.close(scope, err, 'answer')` | 收到 `request.result (status: 'answered')`，当场清理该条 outbox |
| **`PI_BOT_TASK_INTAKE = 0`** | `amend` | `steer` 投递成功且 `Talk` 轻确认完成后调用 `close(scope, err, 'answer')` | 同上，绝不因为后台还在跑就永挂等待 |
| **`PI_BOT_TASK_INTAKE = 0`** | `abort_replace` | `scope` 移交给新启动的 `Work` 轮次，新轮次彻底结束时 `close` | 与正常一轮发言一致 |
| **`PI_BOT_TASK_INTAKE = 1`**<br>（受管接单态） | `side_reply` | 只读旁路不触发 `accept_task`、**不消耗**根预算 `PI_BOT_TASK_MAX_RUNS`；结束时 `close(..., 'answer')` | 正常收口，不影响受管任务状态机 |
| **`PI_BOT_TASK_INTAKE = 1`** | `amend` | 若房间无活跃受管 `TaskRun`，按普通 `amend` 或接单队列处理；若已有活跃受管 `TaskRun`，严禁绕过 `appliedCommands` 私改目标，由 `Talk` 告知已转交修订确认（或引导至 `task_revise` / `taskControls` 并校验 `expectedRevision`） | 保持命令应用事实与版本号强一致 |

---

## 6. WebSocket 报文扩展与 Flutter 双层 UI 规格

所有扩展字段均设计为**向后兼容**（老客户端不传新增字段、老服务端不发新增字段时行为完整降级兼容）。

### 6.1 WS 协议增量（`server/src/ws.js`）

1. **客户端上行**：
   - `send` 新增可选字段：`duplexMode?: 'auto' | 'side_reply' | 'amend' | 'abort_replace'`（缺省为 `'auto'`）。
   - `abort` 新增可选字段：`scope?: 'all' | 'work' | 'talk'`（缺省 `'all'`；用户点后台工作条的停止按钮仅传 `'work'`，不误掐正在回复文字的 `Talk` 气泡）。
2. **服务端下行**：
   - `typing` 新增可选字段：`lane?: 'work' | 'talk'`、`msgId?: string`（缺省 `lane` 时客户端默认为 `'work'`）。
   - 新增事件 `duplex.routed`：
     ```json
     {
       "t": "duplex.routed",
       "roomId": "rm_1",
       "messageId": "msg_u10",
       "requestId": "req_abc123",
       "kind": "side_reply",
       "decidedBy": "rules",
       "duringMsgId": "msg_w8"
     }
     ```

### 6.2 `AppState` 分轨状态管理（`app/lib/app_state.dart`）

1. **拆分忙碌集合，修复根因 D**：
   - 新增 `final Map<String, Set<String>> workingBots = {};` 与 `final Map<String, Set<String>> talkingBots = {};`；
   - 原 `typing[rid]` 与 `typingBots[rid]` 改为两者的只读合并语义，不破坏旧组件读取：
     - `workingBots[rid]` 仅响应 `lane == 'work'`（或未带 `lane` 的旧事件）；
     - `talkingBots[rid]` 仅响应 `lane == 'talk'`；
     - `queued.remove(rid)` **仅在 `workingBots[rid]` 变为空集时执行**。
2. **多消息并行流式刷新确认**：
   - `_streamTicks` 本身按 `msgId` 独立计数，需补单测验证同一房间内 `workMsgId` 连续接收 `msg.steps` 与 `talkMsgId` 连续接收 `msg.delta` 时，两者的 `ValueNotifier<int>` 互不丢帧、不抢 `_retireStreamTick`。

### 6.3 聊天界面双层微交互（`app/lib/screens/chat_screen.dart` + `widgets/`）

严格遵守 `docs/SPEC-MOTION-V1.md` 性能红线（禁用离屏 `saveLayer` 与模糊滤镜；闲置 6 秒停表归零 `0 Ticker`）：

1. **后台工作流光条（`WorkLanePill`）**：
   - **出现条件**：`workingBots[roomId]?.isNotEmpty == true`，且该 `workMsgId` 已经滑出可视区上方或下方出现了新消息（`Talk` 对话）。
   - **视觉形态**：输入胶囊上方紧凑单行徽章（高度 `<= 32px`），左端复用 `ThinkingShimmer` 显示当前工具名/阶段与实时耗时（如 `正在运行 npm test · 14s`），点开可浮层/展开查看最新 `ToolSteps`，右端一个小型停止按钮触发 `abort(roomId, scope: 'work')`——**完全不占用聊天流文字输入区**。
2. **可选发送意图胶囊（`DuplexModeChip`）**：
   - 仅当当前房间 `workingBots[roomId]` 非空且输入框有文本时温和出现，默认 `自动`（走 `duplex-router`），用户也可一键锁定 `仅问答` / `追加要求` / `打断重来`，发送完当前句自动复位 `自动`。
3. **消息旁白角标**：
   - 被判定为 `side_reply` 或 `amend` 的用户消息下沿显示轻量灰色徽注（如「已旁路解答 · 后台继续」或「已同步至后台任务」），替代此前令人焦虑的“它下一步才会看到（排队中）”。
4. **活体头像五态精确联动（对接 `SPEC-MOTION-V1.md`）**：
   - 优先级：`talkingBots` 含该 Bot → `AvatarMood.speaking`（清亮眼神 + 5.5s 快呼吸）；
   - 否则 `workingBots` 含该 Bot → `AvatarMood.busy`（微眯审视扫视）；
   - 当 `Talk` 结束而后台仍在跑时，头像从 `speaking` 平滑切回 `busy`；全部结束后短暂展现 `AvatarMood.happy` 随后 6 秒休眠。

---

## 7. 六大致命边界与硬性防坑不变量（Invariants）

| # | 潜在致命陷阱 | 事故表现 | 本规格强制不变量 |
|---|---|---|---|
| **1** | `Work` 与 `Talk` 并发写同一会话文件 | `.jsonl` 树父节点分叉或 JSON 行写入交错损坏，整段记忆打不开 | `Talk` **禁止**触碰 `store.sessionFileFor(roomId, botId)`，必须在内存态创建并随用随弃 |
| **2** | `Talk` 先结束发 `typing(active: false)` 覆盖状态 | 后台测试还在跑，界面旋转指示灯、头像 `busy` 与流光条全部消失 | 服务端 `typing` 强制带 `lane`；客户端独立维护 `workingBots` 与 `talkingBots` |
| **3** | 用户快速连发 5 句“在吗/好了吗/跑完没” | 同时起 5 个 `Talk` 实例打爆供应商并发配额 | 每个 `(roomId, botId)` 最多 **1 个**在跑 `Talk` 实例（`talkInflight`）；连发自动合并下一拍，且受 `talking` 总数软上限约束 |
| **4** | 模糊一句“好像有点不对”被误判成 `abort_replace` | 跑了 8 分钟的任务当场被掐断重来，用户崩溃 | `fallback` 恒不输出 `abort_replace`；`rules` 排除否定句式；Jev 必须达高置信度门槛且受 `careful` 护栏约束 |
| **5** | `Talk` 里敲定“先别改 B 文件”，下一轮 `Work` 忘了 | Bot 嘴上说好、下一轮继续动手改了 B 文件 | `workEntry.sideContext` 必须落进 `Work` 收尾及下轮 `#buildInput` 增量备忘中 |
| **6** | `side_reply` 没调 `requestLifecycle.close` | 客户端 `RequestOutbox` 永远残留未确认记录，重启客户端重复发送同一句闲聊 | 无论走 `Work`、`Talk` 还是 `amend`，每条携带 `scope` 的请求都保证**有且仅有一次** `close(scope, ...)` 终态落盘与 WS 回执 |

---

## 8. 分阶段实施路线图与验收矩阵（`FD-0` ～ `FD-3`）

使用配置开关 `PI_BOT_FULL_DUPLEX`（`config.js`，支持热读取 / 测试注入）：**开发阶段默认可灰度开启，异常时关掉即完整退回原串行行为**。

| 阶段 | 包含范围与交付模块 | 必过自动化验收标准（写错必须变红） |
|---|---|---|
| **FD-0**<br>路由骨架 & 修复假排队 | - 新建 `server/src/duplex-router.js`<br>- 更新 `server/src/decision-router.js` 注册 `'busy-intent'`<br>- 修复 `server/src/pi-runner.js` 在 `taskIntakeEnabled=false` 下有 `request` 却被死排队的问题 | - 新增 `server/tests/duplex-router.mjs`：覆盖显式覆盖、否定句防误停（“先别停”不触发 `abort_replace`）、纯问进度、带附件不走旁路、Jev 超时/低置信度保守落回 `side_reply`/`amend`<br>- 既有 `server/tests/task-request-gate.mjs` / `decision-router.mjs` / `unit.mjs` 100% 通过 |
| **FD-1**<br>单 Bot 私聊全双工 | - 新建 `server/src/live-work-snapshot.js`<br>- `session-factory.js` 扩展 `buildTalkSession`<br>- `pi-runner.js` 实现 `#runTalkTurn`、双轨状态、`sideContext` 记忆闭合及废弃 `moveMessageAfter` | - 新增 `server/tests/live-work-snapshot.mjs`：验证字段截断上限、`activeShells` 脱敏截取、0 外部 IO 依赖<br>- 新增 `server/tests/full-duplex-dm.mjs`（Mock Slow Tool + Mock Model）：验证 `Work` 执行 2 秒阻塞工具期间发送问进度消息，**~200ms 内触发 `Talk` 气泡输出，且阻塞工具零中断顺利交付**；验证 `Talk` 不写入原 `sessionFile`；验证 `side_reply` / `amend` 均正确发出 `request.result` 终态；验证 `sideContext` 注入下一轮 `Work` 输入 |
| **FD-2**<br>异步派活与部门群全双工 | - `capabilities.js` + `tools.js` 新增 `dispatch_bot`<br>- `pi-runner.js` `#dispatchGroupRound` 支持负责人 `Talk` 轨秒答进度、不惊动在跑成员 | - 新增 `server/tests/full-duplex-group.mjs`：群聊成员运行期间用户发问“跑完没”，**仅负责人走 `Talk` 回复，成员不触发 `abort` 且 `roundQueue` 保留**；发“全停重来”才全员中断<br>- `node scripts/check-consistency.mjs` 能力目录一致性检查 100% 通过 |
| **FD-3**<br>WS 协议 & Flutter 双层 UI | - `server/src/ws.js` 广播 `lane` 与 `duplex.routed`<br>- `app/lib/app_state.dart` 拆分 `workingBots`/`talkingBots`<br>- `app/lib/screens/chat_screen.dart` + widgets 接入 `WorkLanePill`、`DuplexModeChip`、分流角标与头像状态无缝衔接 | - 新增 `app/test/full_duplex_ui_test.dart`：同房 `workMsgId` 跑 `msg.steps` + `talkMsgId` 跑 `msg.delta` 并行流式互不覆盖；`Talk` 结束时 `WorkLanePill` 与 `AvatarMood.busy` 不闪断；点击 `WorkLanePill` 停止仅发送 `scope: 'work'`；6 秒空闲回归 `0 Ticker`<br>- `flutter analyze --no-pub` 零警告 & 全量 `flutter test --no-pub` 100% 通过 |

### 全量回归底线（每个阶段收口必跑）
1. `node scripts/check-secrets.mjs`（敏感信息与本机路径扫描 0 检出）
2. `cd server && node scripts/check-consistency.mjs` & `cd server && node tests/all.mjs`
3. `cd app && flutter analyze --no-pub` & `cd app && flutter test --no-pub`
