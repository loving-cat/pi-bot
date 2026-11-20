# 规格：主控总汇总回传与撞忙浮窗门控（SPEC-CHIEF-SUMMARY）

> **状态**：定稿 v1.0 · 待排期实施（建议紧接 Phase 1 `lessons` v2 收口后进入，或按用户指令插队）
> **对应主干**：`main` @ `2f8ef6e`
> **适用范围**：`server/src/` 派活与汇总编排、`app/lib/` 聊天展示区右上角浮窗交互
> **关联规格**：`docs/ROADMAP-2.0.md`、`docs/SPEC-FULL-DUPLEX-V1.md`、`docs/TASK-RUN-PROTOCOL.md`、`docs/SPEC-MOTION-V1.md`
> **核心定位**：**谁接的单，谁交卷** —— 用户在 `mainBot` 私聊派活由其建组或分发给部门时，部门负责人完成部门内收口，最终由 `mainBot` 回到私聊做统一汇总；若撞上 `mainBot` 正在忙，先阻塞并懒生成，在聊天区右上角弹出浮窗让用户选 **是（发送）/ 否（暂不发、留小角标稍后可点）/ 忽略（放弃主控汇总、留在各部门群）**。

---

## 0. 五条硬规矩

1. **纯逻辑先行**：批次状态机、多部门汇聚判定、撞忙路由、三选一状态流转与汇总提示词组装全部写在零 IO 纯模块 `server/src/chief-summary.js`（待新增），纳入 `scripts/check-style.mjs` 的 `PURE_MODULES`，配齐单测后再接执行层。
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

## 2. 纯逻辑数据契约与状态机 —— `server/src/chief-summary.js`（待新增）

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

### 3.3 汇总轮执行与硬防循环护栏 —— `server/src/runner/chief-summary-runner.js`（待新增）

- 新建薄编排模块 `server/src/runner/chief-summary-runner.js`（待新增），只做一件事：
  - 将各部门的 `departmentName`、`status`、`leadSummary`、`artifacts`、用户原任务拼成结构化只读提示词（提示词明确要求：**直接面向用户总结交付结果、附上关键产物，若发现缺项或失败如实向用户说明并询问是否需要返工，不要自行重新建组或再派活**）；
  - 通过常规私聊执行通道以 `{ skipUserMessage: true, summaryTurn: true, summaryBatchId: batch.id, meta: { via: 'chief_summary', batchId: batch.id, refs } }` 唤醒 `mainBot`（`refs` 指向各部门群及收尾消息，供界面渲染直达链接）。
- **代码级硬防循环护栏（选项 2）**：
  - 在 `server/src/runner/turn-executor.js` 维护 `entry.summaryTurn = Boolean(opts.summaryTurn)`；
  - 在 `server/src/tools.js` 的 `dispatch_to_department`、`create_department` 与 `server/src/coordination/intake-tool.js` 的 `accept_task` 入口增加前置守卫：若 `entry?.summaryTurn === true`，直接返回工具错误（说明「当前为汇总交卷轮，请向用户如实汇报缺口并等待用户决定是否返工，禁止自行再派活」）。

### 3.4 HTTP / WS / 服务接口

- 业务逻辑统一收口到 `server/src/services/`（经 `server/src/services/index.js` 注入 `runner` 与 `http.js`；若新增服务方法触发 `server/tests/sdk-contract.mjs` 快照检查，按要求显式 `UPDATE_SDK_CONTRACT=1` 过 diff 审查）：
  - `GET /api/summaries`：返回当前未终结的汇总列表（`ready_blocked` / `deferred` / `queued_send` / `sending`）；
  - `POST /api/summaries/:id/resolve`：请求体 `{ action: 'send' | 'defer' | 'ignore' }`（常规聊天互动路由，要求 `x-orbis-client` 头，无需额外 admin nonce）；
  - WS 广播事件：`summaries.updated`，payload 为 `{ t: 'summaries.updated', items }`（全量未终结列表，对齐 `lessons.updated` 风格，保证多端与断线重连状态一致）。

---

## 4. 前端交互设计（聊天区右上角浮窗）

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

| 阶段 | 范围与新增测试 | 核心断言（可测得红） |
|---|---|---|
| **Stage 1 · 纯逻辑与持久化** | `server/src/chief-summary.js`（待新增）进 `PURE_MODULES` + `store.state.chiefSummaries` + `server/tests/chief-summary.mjs`（待新增） | 单部门直接就绪；多部门等齐才就绪；单部门失败不傻等；`dispatchOpen=true` 时部门秒回先挂起、封口后立刻就绪；撞忙落 `ready_blocked`；`send`/`defer`/`ignore` 状态机全分支；重启重载不丢 |
| **Stage 2 · 双入口接线与防循环护栏** | `tools.js` + `intake-tool.js` + `pi-runner.js` + `group-orchestrator.js` + `task-runtime.js` + `turn-executor.js` + `chief-summary-runner.js`（待新增） + `http.js` + `server/tests/chief-summary-flow.mjs`（待新增） | 私聊直派空闲直发总结（成员层 `summary` 含 `refs`）；撞忙阻塞时 **0 次模型调用**；选 `send` 排队至当前轮结束发送；选 `ignore` 全程 0 调模型；汇总轮调 `dispatch_to_department`/`accept_task` 被硬拦；受管任务接主控汇总后不再写 400 字 `system` 重复消息；部门群内直接发任务不触发主控汇总 |
| **Stage 3 · Flutter 右上角浮窗** | `app/lib/widgets/chief_summary_card.dart`（待新增）+ `chat_screen.dart` + `app_state.dart` + `chat.dart` + `app/test/chief_summary_card_test.dart`（待新增） | 展开态三按钮各自触发正确 action；`defer` 缩成右上角小角标且点击可再展开；`ignore` 清空提示；多条碰撞仅显示 1 张 + 剩余计数；6 秒空闲回归 **0 Ticker** |

---

## 6. 不做什么（Non-goals）

- ❌ 不在用户在部门群直接布置任务时触发主控二次汇总；
- ❌ 不在撞忙阻塞期间预生成或缓存模型汇总草稿（绝不提前烧 token）；
- ❌ 不允许汇总轮擅自自动打回部门返工（只允许如实汇报缺口并询问用户）；
- ❌ 不把部门群全量中间讨论过程喂给 `mainBot`（仅传各部门负责人的收口结论与产物清单）。
