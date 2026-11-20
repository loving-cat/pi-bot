# 规格：主控总汇总回传与撞忙浮窗门控（SPEC-CHIEF-SUMMARY）

> **状态**：定稿 v1.2 · **Stage 1–3 全部落地**（Stage 1 `ed17da2` / `6706873`；Stage 2a `7865e84`；Stage 2b `4313f16` / `a823ab5` / `fccdef2`；Stage 3 Flutter 浮窗本轮）。§7 为后续分期演进项，按需开启。
> **对应主干**：`main` @ `7865e84`
> **适用范围**：`server/src/` 派活与汇总编排、`app/lib/` 聊天展示区右上角浮窗交互
> **关联规格**：`docs/ROADMAP-2.0.md`、`docs/SPEC-FULL-DUPLEX-V1.md`、`docs/TASK-RUN-PROTOCOL.md`、`docs/SPEC-MOTION-V1.md`
> **核心定位**：**谁接的单，谁交卷** —— 用户在 `mainBot` 私聊派活由其建组或分发给部门时，部门负责人完成部门内收口，最终由 `mainBot` 回到私聊做统一汇总；若撞上 `mainBot` 正在忙，先阻塞并懒生成，在聊天区右上角弹出浮窗让用户选 **是（发送）/ 否（暂不发、留小角标稍后可点）/ 忽略（放弃主控汇总、留在各部门群）**。

---

## 0. 五条硬规矩

1. **纯逻辑先行**：批次状态机、多部门汇聚判定、撞忙路由、三选一状态流转与汇总提示词组装全部写在零 IO 纯模块 `server/src/chief-summary.js`（已纳入 `scripts/check-style.mjs` 的 `PURE_MODULES`），配齐单测后再接执行层。
2. **一个事实只存一份**：非受管直派（`dispatch_to_department`）与受管任务（`TaskRun`）统一写入同一个主控汇总账本 `store.state.chiefSummaries`；受管任务纳入主控汇总后不再往私聊重复刷 400 字 `authorType: 'system'` 终态卡片。
3. **懒汇总、零浪费**：撞忙阻塞时**只保存各部门收口交付包，绝不提前调 `mainBot` 模型**；仅在空闲直发或用户点击「是」时才唤醒 `mainBot` 生成汇总（用户点「忽略」零 token 消耗、零会话锁竞争）。
4. **硬防循环派活**：汇总轮（`summaryTurn: true`）在工具层硬拦截 `dispatch_to_department` / `create_department` / `accept_task`，只允许如实汇报缺项并询问用户是否返工，禁止模型自行循环打回。
5. **只影响私聊派出的活**：用户在部门群里直接找团队布置的任务不建主控汇总批次，保持现状由部门负责人群内收口。

---

## 1. 现状断链与产品边界

### 1.1 三种场景对照

| 场景 | 现状行为 | 差距与决定 |
|---|---|---|
| **1. 用户直接在部门群布置任务** | 部门成员讨论/执行后，由部门负责人执行收尾轮（`planClosing`）在群里汇总 | **现状合理，保持不变**（不惊动 `mainBot`，不建汇总批次） |
| **2. 用户在 `mainBot` 私聊派活（非受管直派）** | `server/src/tools.js` 的 `dispatch_to_department` → `server/src/pi-runner.js` 的 `dispatchToGroup` → `server/src/runner/group-orchestrator.js` 的 `planClosing` | 现状没记 `originRoomId`，部门跑完后 `mainBot` 私聊**零通知** → 须接入主控汇总闭环 |
| **3. 用户在 `mainBot` 私聊派活（受管 `TaskRun`）** | `server/src/tasks/task-runtime.js` 的 `reportTerminal` 往 `origin.roomId` 写一条最多 400 字 `authorType: 'system'` 消息 | 现状**未唤醒 `mainBot`**，`mainBot` 会话上下文不知道团队交付了什么，后续追问断层 → 改为统一走主控汇总，停止重复刷系统卡片 |

### 1.2 为什么必须唤醒 `mainBot` 汇总（而不是静态转发负责人原话）

- **追问不失忆**：只发系统消息时，`mainBot` 会话历史里没有交付内容，用户紧接着追问「第 2 点再改一下」会接不上话。
- **多部门能合卷**：一次拆分给 A、B 两个部门的任务，只有 `mainBot` 能结合用户原诉求合成一份统一答复。
- **短上下文低成本**：汇总轮只把各部门负责人的最终收尾结论与产物路径喂给 `mainBot`，绝不塞入部门群全量过程对话。

---

## 2. 纯逻辑数据契约与状态机 —— `server/src/chief-summary.js` ✅ 已落地（Stage 1 `ed17da2` / `6706873`）

### 2.1 `DispatchBatch` 结构

持久化于 `store.state.chiefSummaries`（单仓最多保留 50 条，自动清理超过 7 天的 `sent` / `ignored` 终态记录）：

```jsonc
{
  "id": "sum_01...",
  "originTurnKey": "msg_or_root_task_id",     // 同轮聚合键：本轮 mainBot liveMsgId 或根 taskRunId
  "originRoomId": "room_dm_main",             // mainBot 私聊 roomId
  "originMessageId": "msg_user_01",           // 触发派活的用户消息 id（可选）
  "taskTitle": "重构行情抓取并发调度",          // ≤ 28 字简短标题，供浮窗展示
  "dispatchOpen": true,                       // 发起轮是否仍在派活（防止部门 A 比派活轮先结束导致早产汇总）
  "targets": [
    {
      "key": "group:room_dev:disp_01",
      "departmentId": "room_dev",
      "departmentName": "研发组",
      "kind": "group",                        // 'group' | 'taskRun'
      "refId": "disp_01",
      "status": "running",                    // 'running' | 'done' | 'failed'
      "leadSummary": "",                      // 部门负责人收口结论（截断上限 2000 字）
      "artifacts": [],                        // 部门产出物路径/附件摘要
      "sourceMsgId": null,                    // 部门收尾消息 id（用于 refs 直达原群消息）
      "error": "",
      "finishedAt": 0
    }
  ],
  "state": "collecting",                      // 'collecting' | 'ready_blocked' | 'deferred' | 'queued_send' | 'sending' | 'sent' | 'ignored'
  "createdAt": 1795000000000,
  "readyAt": 0,
  "resolvedAt": 0,
  "summaryMessageId": null
}
```

### 2.2 多部门汇聚与就绪判定（选项 1）

- **同轮聚合**：`mainBot` 在同一轮里连续多次调用 `dispatch_to_department` / `create_department` 或挂出多个子任务时，共享同一个 `originTurnKey` 写入同一批次的 `targets`；`dispatchOpen` 在 `mainBot` 该发起轮 `finally` 封口为 `false`。
- **正常全完**：所有 `targets` 均到达终态（`done` / `failed`）且 `dispatchOpen === false` → 批次就绪。
- **失败 / 受阻不傻等**：任意 `target` 进入 `failed`（失败、受阻或额度暂停），只要 `dispatchOpen === false` 立即触发批次就绪（汇总提示里如实标明已完成部分与具体受阻部门及原因）。
- **提前就绪后的晚到刷新**：若因某部门先失败而提前就绪，后续其余部门又结束回报时：
  - 若当前批次已 `ignored` → 静默落库更新该 target 交付包即可，不再打扰用户；
  - 若当前仍处于 `ready_blocked` / `deferred` → 合并更新对应 target 状态并刷新前端快照。

### 2.3 撞忙检测、阻塞与三选一动作（选项 3）

批次就绪瞬间，判定 `mainBot` 私聊忙碌态 `isMainBusy = runner.isBusy(mainDmId, mainBot.id) || runner.mergeQueue.hasPending(mainDmId)`：

```text
批次就绪
  ├── isMainBusy === false ──► state = 'sending' ──► 立即唤醒 mainBot 发汇总 ──► 'sent'
  └── isMainBusy === true  ──► state = 'ready_blocked'（懒汇总，不调模型，推 summaries.updated）
                                  │
                                  ├── 用户选「是 · 发送汇总」(send)
                                  │      ├─ mainBot 现已空闲 ──► 'sending' 立即发送 ──► 'sent'
                                  │      └─ mainBot 仍在忙   ──► 'queued_send'（不打断当前对话，本轮 finally 后立即发）
                                  │
                                  ├── 用户选「否 · 暂不发送」(defer)
                                  │      └─ 'deferred'（收起浮窗，右上角保留小角标；点开后仍可选 send / ignore）
                                  │
                                  └── 用户选「忽略」(ignore)
                                         └─ 'ignored'（彻底取消本次主控汇总，零模型调用，结果留在各部门群）
```

> 状态流转必须在纯函数 `resolveSummary(batch, action, { mainBusy })` 里写死并穷举单测，禁止路由或前端各自拼状态字面量。

---

## 3. 服务端接线点与硬防循环护栏

### 3.1 双入口统一收敛

| 入口 | 改动位置 | 动作 |
|---|---|---|
| **非受管直派** | `server/src/tools.js`（`dispatch_to_department`） | 若当前执行房间为 `mainBot` 私聊且操作者为 `mainBot`，向 `store` 登记到当前 `originTurnKey` 的 `DispatchBatch`（并把 `summaryBatchId` / `summaryTargetKey` 透传给 `runner.dispatchToGroup`） |
| **群派活入口** | `server/src/pi-runner.js`（`dispatchToGroup`） | 接收可选 `{ summaryBatchId, summaryTargetKey }` 并透传给 `runRound` |
| **群收尾回传** | `server/src/runner/group-orchestrator.js`（`executeGroupRound`） | 负责人收尾轮结束（或成员失败未产生收尾轮但本轮结束）且未因用户插话触发 `stale()` 时，把负责人结论（或末条有效产出/失败原因）+ 附件 + `sourceMsgId` 回报汇总调度器；若 `stale()` 丢弃旧轮则等待重跑后的新轮回报或标失败，不拿作废半截当交卷 |
| **受管 `TaskRun`** | `server/src/tasks/task-runtime.js`（`reportTerminal`） | 当 `run.origin?.roomId === mainDmId` 且为部门派活任务时，按去重键 `taskRun:${run.id}` 上报至同一套主控汇总账本；**已纳入主控汇总的不再额外写入 400 字 `authorType: 'system'` 卡片** |

### 3.2 发起轮封口与排队排空 —— `server/src/runner/turn-executor.js`

- `mainBot` 私聊轮次进入 `finally`：
  1. 清理 `entry.summaryTurn = false`（防止异常退出污染下一轮）；
  2. 若本轮曾新建/追加过 `originTurnKey` 批次，调用 `sealDispatchBatch` 将 `dispatchOpen` 置 `false` 并立即重算一次就绪状态；
  3. 仅当非取消退出且 `mainBot` 空闲时，调用 `drainPendingSummaries()` 顺序消费 `queued_send`（以及封口瞬间刚刚就绪且未撞忙的批次）。

### 3.3 汇总轮执行与硬防循环护栏 —— `server/src/runner/chief-summary-runner.js` ✅ 骨架已落地（Stage 2a `7865e84`）

- 薄编排模块 `server/src/runner/chief-summary-runner.js`（已落地，Stage 2b 补全以下提示词微调）：
  - 将各部门的 `departmentName`、`status`、`leadSummary`、`artifacts`、用户原任务拼成结构化只读提示词，并在 Stage 2b 补齐两条写作纪律：
    1. **回调唤醒显式打标**：`buildChiefSummaryPrompt` 开头明确声明「这是**已有任务的内部交付回调唤醒，不是用户的新提问**」，防止模型把部门回执误当新任务重新立项；
    2. **收口总结严格限长**：强制主控先用 **≤ 3 句**给出核心结论 + 关键产物清单 + 缺项/受阻提示与是否返工的询问，**绝不复述各部门已经写在群里的长明细**（过程细节靠 `refs` 直达部门群查看）；
  - 通过常规私聊执行通道以 `{ skipUserMessage: true, summaryTurn: true, summaryBatchId: batch.id, meta: { via: 'chief_summary', batchId: batch.id, refs } }` 唤醒 `mainBot`（`refs` 指向各部门群及收尾消息，供界面渲染直达链接）；
  - 发送失败 / 429 / 异常时通过 `markSummarySendFailed` 从 `sending` 退回 `ready_blocked`（保留 `lastError`），确保不会卡死在幽灵状态（已在 `6706873` / `7865e84` 落地）。
- **代码级硬防循环护栏（选项 2）**：
  - 在 `server/src/runner/turn-executor.js` 维护 `entry.summaryTurn = Boolean(opts.summaryTurn)`；
  - 在 `server/src/tools.js` 的 `dispatch_to_department`、`create_department` 与 `server/src/coordination/intake-tool.js` 的 `accept_task` 入口前置守卫 `if (entry?.summaryTurn === true)`，直接返回工具错误引导向用户汇报缺口（已在 `7865e84` 落地）。

### 3.4 HTTP / WS / 服务接口

- 业务逻辑统一收口到 `server/src/services/`（经 `server/src/services/index.js` 注入 `runner` 与 `server/src/http.js`；若新增服务方法触发 `server/tests/sdk-contract.mjs` 快照检查，按要求显式 `UPDATE_SDK_CONTRACT=1` 过 diff 审查）：
  - `GET /api/summaries`：返回当前未终结的汇总列表（`ready_blocked` / `deferred` / `queued_send` / `sending`）；
  - `POST /api/summaries/:id/resolve`：请求体 `{ action: 'send' | 'defer' | 'ignore' }`（常规聊天互动路由，要求 `x-orbis-client` 头，无需额外 admin nonce）；
  - WS 广播事件：`summaries.updated`，payload 为 `{ t: 'summaries.updated', items }`（全量未终结列表，对齐 `lessons.updated` 风格，保证多端与断线重连状态一致）。

### 3.5 在跑成员保护（并入 Stage 2b）

- 在 `server/src/services/bot-service.js`（删除 bot 的 `remove()` 与将成员移出部门路径）增加活跃任务检查：只要目标 bot 当前在任意房间 `busy`、正承担未终结 `TaskRun`、或作为未终结 `chiefSummaries` 目标部门的在跑成员，拒绝删除/移出并返回明确提示（「该成员正在执行任务，请先终止或等完成后再操作」），避免留下孤儿任务或让主控总汇总永远挂起。

---

## 4. 前端交互设计（聊天区右上角浮窗）✅ 已落地（Stage 3）

### 4.1 位置与文件落点

- **叠放落点**：`app/lib/screens/chat_screen.dart` 消息展示区 `Stack` 内 `Positioned(top: 12, right: 28)`——与底部 `ActivityMonitor`、右侧 `MessageAnchorRail`、右下角回到底部按钮同层，避开右侧 18px 锚点轨，出现/消失不引起消息列表高度跳动。
- **新增组件**：`app/lib/widgets/chief_summary_card.dart`（待新增）。
- **状态与文案**：`app/lib/app_state.dart` 订阅 `summaries.updated` 并在首拉/重连时同步 `/api/summaries`；词条收口到 `app/lib/l10n/strings/chat.dart`。

### 4.2 三种视觉态

1. **展开浮窗卡片（存在 `ready_blocked` 时显示，最大宽度 300px）**：
   - 标题：`「{taskTitle}」汇总已准备好`；
   - 副行：部门列表与结果状态（如「研发组已完成」或「2 部门已完成 · 测试组受阻」）；
   - 三颗动作按钮：
     - **「是 · 发送」**（主按钮）→ 调 `POST /api/summaries/:id/resolve` 传 `action: 'send'`；
     - **「否 · 暂不」** → 传 `action: 'defer'`，卡片立刻收起为右上角小角标；
     - **「忽略」** → 传 `action: 'ignore'`，卡片消失，各部门结果仍保留在各自部门群内。
   - **防刷屏折叠**：同时存在多个待确认汇总时只渲染队首 1 张，底部提示「还有 N 条汇总待处理」，处理完一条自动顺延下一条。
2. **收起小角标（仅存在 `deferred` 时显示）**：
   - 右上角显示紧凑胶囊 `汇总待看 ({n})`，点击后就地展开选择「发送汇总」「忽略」或「去部门看」。
3. **排队 / 生成中（`queued_send` / `sending`）**：
   - 紧凑只读状态胶囊：「本轮结束后发送汇总」/「正在汇总…」，汇总消息落地后自动消失。

### 4.3 跨房间可见性与动效约束

- **跨房间可见**：只要存在 `ready_blocked` 或 `deferred` 记录，聊天区右上角即可见提醒；若用户在部门群里点击「是 · 发送」，汇总依然写入 `mainBot` 私聊，当前页弹轻提示提供一键跳回 `mainBot` 私聊。
- **动效红线**：严格遵守 `docs/SPEC-MOTION-V1.md`，空闲 6 秒后必须归零 Ticker（禁止无限脉冲动画或常驻旋转）。

---

## 5. 分阶段落地与验收（每条可测得红）

| 阶段 | 范围与测试 | 核心断言（可测得红） |
|---|---|---|
| ✅ **Stage 1 · 纯逻辑与持久化**（已落地 `ed17da2` / `6706873`） | `server/src/chief-summary.js` 进 `PURE_MODULES`（现 22 个纯模块）+ `store.state.chiefSummaries`（含 7 天/50 条保留策略与 `lastError`）+ `server/tests/chief-summary.mjs`（27 条） | 单部门直接就绪；多部门等齐才就绪；单部门失败不傻等（含 `[A: failed, B: running]`）；`dispatchOpen=true` 时部门秒回先挂起、封口后立刻就绪；撞忙落 `ready_blocked`；`send`/`defer`/`ignore` 幂等全分支；失败退回 `ready_blocked`；`pendingChiefSummaries` 不推 `collecting`；重启重载不丢 |
| ✅ **Stage 2a · 防循环护栏与汇总执行轮**（已落地 `7865e84`） | `server/src/runner/chief-summary-runner.js` + `server/src/runner/turn-executor.js` + `server/src/tools.js` / `server/src/coordination/intake-tool.js` 三工具硬拦 + `server/tests/chief-summary-flow.mjs`（13 条） | 三工具汇总轮被硬拦；普通轮不拦；`429`/异常退回 `ready_blocked` 并保留 `lastError`；未点「是」零模型调用；`drain` 串行发两条、第一条失败立即停 |
| ✅ **Stage 2b · 双入口接线 + 路由 + 提示词精简 + 在跑成员保护**（已落地 `4313f16`/`a823ab5`/`fccdef2`） | `server/src/tools.js` 登记、`server/src/pi-runner.js` / `server/src/runner/group-orchestrator.js` 收尾回传、`server/src/tasks/task-runtime.js` 收敛抑制 400 字 system 重复卡、`server/src/http.js` `GET /api/summaries` & `POST /api/summaries/:id/resolve` + `buildChiefSummaryPrompt` 回调打标与 ≤3 句限长 + `server/src/services/bot-service.js` 在跑成员禁删/禁移出（扩 `server/tests/chief-summary-flow.mjs`） | 私聊直派空闲直发总结（`meta.refs` 直达部门）；撞忙阻塞时 **0 次模型调用**；选 `send` 排队至当前轮结束发送；选 `ignore` 全程 0 调模型；受管任务接主控汇总后不再写 400 字 `system` 重复消息；部门群内直接发任务不触发主控汇总；在跑成员禁止删除/移出；提示词显式打标回调且约束 ≤3 句不复述长明细 |
| ✅ **Stage 3 · Flutter 右上角浮窗**（已落地） | `app/lib/widgets/chief_summary_card.dart`（待新增）+ `app/lib/screens/chat_screen.dart` + `app/lib/app_state.dart` + `app/lib/l10n/strings/chat.dart` + `app/test/chief_summary_card_test.dart`（待新增） | 展开态三按钮各自触发正确 action；`defer` 缩成右上角小角标且点击可再展开；`ignore` 清空提示；多条碰撞仅显示 1 张 + 剩余计数；6 秒空闲回归 **0 Ticker** |
| ⬜ **Stage 4+ · 分期演进增强**（按需开启，见 §7） | 主控统筹模式轻护栏 / 逻辑级轻量看门狗 / 云端轻入口+本地执行节点桥接 | 独立开关与专项验收，不阻塞 Stage 2b 与 Stage 3 主线交付 |

---

## 6. 不做什么（Non-goals）

- ❌ 不在用户在部门群直接布置任务时触发主控二次汇总；
- ❌ 不在撞忙阻塞期间预生成或缓存模型汇总草稿（绝不提前烧 token）；
- ❌ 不允许汇总轮擅自自动打回部门返工（只允许如实汇报缺口并询问用户）；
- ❌ 不把部门群全量中间讨论过程喂给 `mainBot`（仅传各部门负责人的收口结论与产物清单）；
- ❌ **不做「推测执行（Speculative Execution）」** —— 未经用户明确派活前，不在后台偷跑复现脚本或预改代码（守住 token 账单与权限可控底线）；
- ❌ **不退回纯内存事件收件箱** —— 汇总账本与活跃任务状态始终落盘持久化，重启不丢在途记录。

---

## 7. 后续分期演进（吸收 Super-agent / Octop，按需开启、不急于马上全部落地）

以下三项均源于对外部双层调度与团队协同实践的架构对照，与当前 Stage 2b / Stage 3 解耦，后续按真实需求与版本节奏逐项开启：

### 7.1 主控“统筹模式”轻护栏（缓解协调者“自己闷头干大活”）

- **背景**：Super-agent 实测表明，协调者只要自身保留执行工具，仅靠提示词往往会跳过派工直接自己下手并堵死前台；但 Orbis 作为个人/小团队助手，用户私聊时常需要 `mainBot` 顺手查文件、看桌面（如 `desktop_observe`），不能一刀切剥夺为 0 工具纯 Router。
- **方案**：保留轻量日常只读/桌面交互能力，后续在 `server/src/role-tools.js` 与策略层提供可选的**「主控统筹模式」开关**（或当主控单轮连续重型工具调用超过阈值时在会话内注入交接提醒，引导转交 `dispatch_to_department`）。
- **落地时机**：Stage 3 交付后，按真实日常使用体感决定是否开启。

### 7.2 逻辑级轻量看门狗（Watchdog · 查原地死循环与目标漂移）

- **背景**：现有 `maxSteps` 与接口熔断只能拦住超时和网络报错，拦不住「模型陷入逻辑死循环、反复改坏同一处测试或严重偏离原需求」。
- **方案**：复用现有 `server/src/decision-router.js` 与 `server/src/lesson-reflect.js` 中已抽出的无工具隔离会话 `askIsolated()`，在长任务连续多步工具调用高度重复或耗时超阈值时触发一次低成本只读巡检；命中死循环或严重偏题即提前中止，并通过 `chief-summary` 的失败通道立刻触发主控汇总提醒用户介入（默认关闭、按配置启用）。
- **落地时机**：2.0 后半或 2.1 按独立功能立项，不侵入 Stage 2b / Stage 3。

### 7.3 云端轻入口 + 本地执行节点桥接（脑手分离远端协作）

- **背景**：支持用户在外出/手机端随时访问常驻在线入口，同时保证代码仓库、敏感凭据与内网权限永不离开本地机器。
- **方案**：基于现有 `server/src/relay/server.js` 中继通道与客户端证书指纹固定能力，演进为「云端轻控制面 + 本地执行节点」桥接架构（模型执行、工具调用与会话落盘留在本机，执行进度与最终结论流式回传云端/手机端）。
- **落地时机**：2.1 独立立项，不与 2.0 收敛主线耦合。
