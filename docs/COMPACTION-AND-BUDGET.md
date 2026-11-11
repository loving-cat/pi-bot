# 上下文压缩与群聊轮次的评估（2026-11-05）

> 已修：`047cab3`（5 个缺陷）、`950af2e`（压缩失败退避重试）、`776f350`（压缩期间不算忙）。
> 下面保留完整分析，供后续阶段（后台预压缩 / 滚动摘要 / 轮次默认值）决策使用。
>
> **2026-11-05 复核**：第 7 项的「400 条扫描」实测不是性能问题
> （单次 0.0093ms，5 bot 群跑 20 轮共 0.9ms，读的是内存 Map 不是磁盘），
> 已降级为观察项。真正待办的只剩「摘要不进上下文」。

## 一、上下文压缩：让用户无感知

### 1.1 原先的问题（已修 / 待修）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 主动压缩在建消息与订阅事件之前执行，压缩期间无任何 UI 信号，界面静止 0–5 分钟 | 已修 `047cab3` |
| 2 | 压缩横条落在正在流式的回复之后，顺序与重载后不一致 | 已修 |
| 3 | `PI_BOT_AUTO_COMPACT=0` 关不掉主动压缩 | 已修 |
| 4 | ContextChip 在刚压缩完时整个消失（不是跳变，是消失再出现） | 已修 |
| 5 | 压缩失败后只 log，接着照常跑 → 撞 pi 的 98% 阈值，用户经历两段卡顿 | 已修 `950af2e` |
| 6 | 群聊压缩期间 `entry.busy=true`，用户一说话就 `#interruptRoundForUser` 把全群 abort | 已修 `776f350` |
| 7 | 记忆摘要**不进上下文**，纯 UI 展示 | 待做（阶段 2，见下） |
| 7b | 每轮 finally 跑一次 400 条全量扫描 | **不成立** — 实测 0.0093ms/次，读内存 Map |

### 1.2 分阶段落地

**阶段 0（半天，纯观测，零风险）** —— 已完成
- 补事件与横条、修正插入顺序（`047cab3`）
- 让「压缩发生了什么」在界面和日志里都看得见
- ~~砍掉每轮 400 条记忆摘要扫描~~ → 实测无必要：`store.listMessages` 返回的是
  内存 `this.messages` 的 `slice(-400)`，不是磁盘 I/O；整条判定链路 0.0093ms。
  真要做增量计数器省下的也是微秒级，不如把注意力放在下面的「摘要进上下文」。

**阶段 1（2–3 天，后台预压缩）**
- 新增 ticker，只在 `session.isIdle && !entry.busy` 时压缩
- 注意与 `#evictSessions` 的 LRU 竞争：压缩中的会话不能被驱逐
- ~~压缩失败要重试退避~~ → 已完成（`950af2e`）：退避重试 2 次，放弃后冷却 10 分钟，
  并在群里发 `bot.compactFailed` 事件
- ~~群聊场景要区分「后台压缩」与「用户等待中的轮次」~~ → 已完成（`776f350`）：
  压缩期间打 `compactingOnly` 标记，`isRoomBusy` 与 `#interruptRoundForUser`
  都跳过它；压缩结束、回合真正开始时清掉，插话语义恢复原样

**记忆摘要：递归更新与写入脱敏** —— 已落地（不涉及 prompt 注入）

- 递归更新：`memory-digest.js` 新增 `buildSummarizePrompt({ botName, previousText, digest })`。
  有旧摘要时开头改成「在已有记忆上更新，不要整份重写」，正文分「【已有记忆】」和「【新增对话】」两段；
  并补一条矛盾处理规则：**以用户更正为准，只保留现行结论，不并列两份相反事实**，
  旧摘要里仍成立的结论和数字必须保留。
  `#summarizeMemoryNow` 有缓存文本时只对 `memoryProgress` 返回的 **newMessages** 做 digest，
  首次仍取整窗口。开关 `PI_BOT_MEMORY_RECURSIVE=0` 可退回旧行为（整窗口 digest + 旧提示词）。
  空结果、超时、脱敏失败都不覆盖旧摘要。
- 写入脱敏：新增 `memory-sanitize.js`，`setMemorySummary` 落盘前调用，
  `#summarizeMemoryNow` 写入前也过一次（双重把关）。抹掉邮箱、PEM 私钥块、Bearer 令牌、
  赋值式 api_key / access_token / secret / password。**本阶段不处理文件路径** —— 路径脱敏还没拍板。
  规则锚定在「像赋值 / 像令牌」的形状上，不用裸 token 字样匹配，避免误删「token 预算」这类表述。
- 未改：提示词第 4 条「重要的文件路径或系统状态」、`memory-policy.js` 的 `IMPORTANT_SIGNALS` 路径正则、
  `memorySummaries` 存储键形状（仍是 `roomId:botId`）、`GET/POST /memory` 回包形状。

**阶段 2（1–2 周，滚动摘要）** —— 仍是**待拍板**，尚未落地
- 先只在群聊开；复用 `memory-policy.js` + `memory-digest.js`
- 摘要必须**每轮拼进 prompt**，而不是 `appendSystemPrompt`（后者会累积）
- 上之前先算清 prompt cache 命中率的账：摘要每轮变化会击穿缓存
- ⚠️ 上面「递归更新与写入脱敏」只解决了**摘要怎么生成、怎么写干净**，
  **没有**把摘要或结构化事实拼进模型 prompt。注入方案（建议上限「最多 8 条、合计 800 字」）
  连同持仓类状态的唯一写入者规则、结构化共享事实层（facts.js / ADD-UPDATE-DELETE-NOOP）
  都还没定，不要当成已落地。

**上下文压缩：校准路径补上固定开销** —— 已落地
- 背景：`applyCompactionBudget` 调 `capRecentTokens` 时传了
  `fixedOverheadTokens: fixedOverheadOf(session)`（system prompt + 工具定义，
  「每轮都在、压缩动不了」的那部分）；但 `pi-runner.js` 的 `#calibrateKeepRecent`
  里那次「只取窗口上限」的调用**没传**，注释却写着要扣 ——
  于是它以为窗口里全是可用余量，算出的保留量贴到触发线，小窗口压完立刻又触线。
- 改动：
  - `context-budget.js` 把 `fixedOverheadOf` 导出，口径与 `applyCompactionBudget` 完全一致
    （拿不到就返回 0，不猜数字）。
  - `#calibrateKeepRecent` 的那次 `capRecentTokens` 调用补上
    `fixedOverheadTokens: fixedOverheadOf(session)` —— **同一个函数**，两条路径的触发时机才对得上。
  - 用户/主控显式设了 `bot.keepRecentTokens` 仍直接 return，不覆盖；
    算不出 r 或 r 越界时仍不改 keep；`COMPACT_PROMPT` 仍为 `null`。
- 未改：`compactAtPercent`（仍 0.6 触发）、`TARGET_RECENT_TOKENS`（仍 200000 真实 token）、
  `keepRecentTokens` 默认值、精简档（仍不接入自动分类）。
- 测试：`server/tests/context-overhead.mjs` —— 有开销时保留量更小、开销越大越小、
  吃掉余量仍留 1 token、小窗口场景数值、两条路径用同一函数、用户显式设置不被覆盖。

**不建议做**：检索式记忆（要额外向量库与 embedding 推理）、LLMLingua（本地常驻服务再加一路推理，与省延迟目标相悖）。

### 1.3 参考文献

> ⚠️ 核实程度说明：本机对 arxiv / aclanthology / dblp 的网络访问被策略拒绝，
> 以下条目是靠多来源检索交叉核对的**元数据**，未逐篇打开 PDF 原文。
> 引用前请自行打开链接确认。

| 方向 | 论文 | 编号 |
|---|---|---|
| 分层记忆 / 分页上下文 | MemGPT: Towards LLMs as Operating Systems | arXiv 2310.08560 |
| 递归摘要 | Recursively Summarizing Enables Long-Term Dialogue Memory | arXiv 2308.15022 |
| 树式检索摘要 | RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval | arXiv 2401.18059 |
| 记忆层 | Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory | arXiv 2504.19413 |
| 时序知识图记忆 | Zep: A Temporal Knowledge Graph Architecture for Agent Memory | arXiv 2501.13956 |
| 自组织记忆 | A-MEM: Agentic Memory for LLM Agents | arXiv 2502.12110 |
| 注意力汇 / 流式 | Efficient Streaming Language Models with Attention Sinks | arXiv 2309.17453 |
| 提示词压缩 | LLMLingua: Compressing Prompts for Accelerated Inference | arXiv 2310.05736 |
| 长上下文压缩 | LongLLMLingua | ACL 2024 (2024.acl-long.91) |
| 无限注意力 | Leave No Context Behind (Infini-attention) | arXiv 2404.07143 |
| 位置外推 | LongRoPE: Extending LLM Context Window Beyond 2 Million Tokens | arXiv 2402.13753 |
| 长上下文评测 | Lost in the Middle: How Language Models Use Long Contexts | arXiv 2307.03172 |
| 长上下文基准 | LongBench: A Bilingual, Multitask Benchmark for Long Context | arXiv 2308.14508 |
| 产品实现 | Letta (原 MemGPT) 官方文档 | docs.letta.com |
| 离线计算 | Sleep-time Compute（编号未核实） | 未核实 |

## 二、群聊轮次预算

### 2.1 当前默认值

```js
leadTurns: 15,     // 部门老大每次发言最多跑几轮
memberTurns: 15,   // 普通成员每次发言最多跑几轮
maxRuns: 100,      // 一条用户消息最多触发几次 bot 运行
maxSteps: 30,      // 单次最多来回几轮
turnMaxMs: 600000, // 单轮最长 10 分钟
```

### 2.2 核实出的结构性问题

1. **`maxRuns=100` 在 N≤6 的部门里是死参数**：每 bot 预算 `15N`，只有 N≥7 时 100 才会先触发。3–6 人部门永远由 `leadTurns/memberTurns` 先卡住。
2. **静默缺口（部分已修）**：per-bot 预算跳过原先只在 `item.fromId` 非空时留痕，用户自己 @ 时零痕迹 —— 本次已修。
3. **`turnMaxMs` 会被重试放大**：`retry-policy.js` 对超时重试一次，最坏 `2×600s + 3s ≈ 20 分钟`。
4. **收尾轮不受任何预算约束**，实际 runs 上限 = `min(15N, maxRuns) + 1`。
5. **开销结构**：轮次主要买 token（每次 run 重发完整 system prompt + ≤30 条/≤12000 字 transcript），几乎不买时延（时延由波数决定，同波并发）。
6. **迁移缺口**：只在 `leadTurns===4 && memberTurns===2` 精确匹配时升级，`4/3` 这类组合永远不会升级且无提示。

### 2.3 建议区间

| 参数 | 建议 | 理由 |
|---|---|---|
| `leadTurns` / `memberTurns` | 12–20（当前 15 合理） | 覆盖多数多步任务，再高主要是在烧 token |
| `maxRuns` | 改为 ≈`3N` 或废弃 | 当前值在中小部门永不生效，形同虚设 |
| `maxSteps` | 20–40（当前 30 合理） | — |
| `turnMaxMs` | 600–900s，**优先改「超时不重试」** | 重试让最坏耗时翻倍，比调大上限更重要 |

> 这些区间是代码结构推断，**具体值需要线上数据**才能定。

### 2.4 评估方案（未实施）

复用 `room-lock.mjs` / `group-cursor.mjs` / `closing-turn.mjs` 里已经打桩 `PiRunner.prototype.run` 的骨架，写 `group-budget-sim.mjs` 做蒙特卡洛：

- 维度：`N ∈ {2,3,4,6,8,12}` × 行为分布 `p_reply / p_all / p_pass / p_fail / p_user_interrupt`
- 输出：runs 的 P50/P90/P99、waves、skipped_by_turn_budget、silent_terminations、tokens_est（chars/4 估）
- **前置缺口**：行为分布必须从线上日志估，否则只是假设

### 2.5 前置观测缺口

- 没有 `/api/metrics`；`log()` 只写 stdout
- 消息里的 `usage` 在本机实测 84 条中 35 条有，但全是 `totalTokens: 0`
- **建议先加一条 `round.done` 结构化记录**（纯观测，不改默认值）：记录本轮 runs、waves、终止原因、是否触发预算截断、token 估算。有它之后才能谈默认值优化。

### 2.6 待查

本机 `state.json` 里 `maxSteps: 100` 与 `turnMaxMs: 30min` 是**非默认值**，且 `groupLimitsMigrated` 为 `undefined` —— 来源不明，需单独排查是历史遗留还是被某次操作写入。
