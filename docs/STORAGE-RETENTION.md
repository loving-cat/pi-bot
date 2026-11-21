# 运行数据清理（保留期 / 自动清理 / `cleanup_storage`）

Orbis 会在数据目录里留下几类**自己的运行产物**。它们不像聊天记录那样被引用，
但只增不减：一天之后基本没有价值，留着只会让备份变大、排障变吵。

这份文档说明**删什么、留什么、谁触发**。改代码前先读「红线」。

## 红线（任何一条都不能破）

| # | 红线 | 为什么 |
|---|---|---|
| 1 | **绝不触碰用户产出与核心账本**：`workspace/`、`state.json`、`rooms/`、`sessions/` | 那是用户的东西。清理工具只处理"程序自己跑出来的垃圾" |
| 2 | **TaskRun 按整棵根任务树裁剪**（`rootTaskId ?? id` 分组） | 树里只要还有一个非终态节点，删任何一个文件都会拆散封口判定、预算结算与 `rootOf` |
| 3 | **孤儿附件只能走 `attachments.js` 的 `deleteAttachments()`** | 裸 `fs.unlink` 会绕掉墓碑、`attachmentDeletionRevision()` 和 `attachments.deleted` 广播，已删附件会"复活"在客户端缓存里 |
| 4 | **定时自动清理不删附件** | 附件被老消息引用是常态；按年龄删等于删用户看得见的数据。孤儿附件只在**显式**请求时回收 |
| 5 | **低频**：启动后延迟 2 分钟首扫，之后 15 分钟最多一次 | `housekeeping` 是 60s 节拍；每分钟全量读一遍 `taskruns/` 是磁盘噪音，不是清理 |

## 分三层

```
storage-retention.js     纯函数：给清单 + now + 阈值 → 选中哪些（零 IO，单测覆盖每个边界）
storage-housekeeping.js  执行：读目录 / realpath 校验 / 真删 / 统计字节
cleanup_storage (工具)   主控入口：默认 dryRun，scope 白名单
```

`server-main.js` 的 `housekeeping` 定时器只自动跑 **安全三项**（`STORAGE_AUTO_SCOPES`）：
`instanceTmp` / `taskRequests` / `taskRuns`。

- **孤儿附件永远不进自动档**（红线 4）。
- **旧截图也不进**：它由既有的 `pruneScreenshots()` 在同一个 60s 节拍里独立清理
  （`desktop-shots/*.png` 超过 24h）。清理工具里保留 `screenshots` scope 只是给
  手动/显式调用用，避免两处重复扫同一个目录。

## 阈值（`STORAGE_RETENTION_DEFAULTS`，唯一真源）

| 项 | 默认 | 说明 |
|---|---|---|
| `instanceTmpTtlMs` | 24h | `instances/<botKey>`：在跑 bot 的目录永远跳过 |
| `requestReceiptTtlMs` | 14d | `task-requests/*.json`：`received` / `running` 阶段、以及指向活任务的回执永远不选 |
| `taskRunTtlMs` | 30d | 已终结的根任务树（最老时间戳超过 30 天才算过期） |
| `taskRunMaxTerminal` | 500 | 已终结的根树最多留 500 棵，多出来的按最老裁 |
| `orphanUploadTtlMs` | 30d | 仅显式清理；且必须**先算出引用集**（扫不全就整项跳过） |

## `cleanup_storage` 工具

只给主控（`chiefOnly: true` + `mutating: true`；`dangerous: ask` 下逐次批准，
`deny` 下整类被只读门拦住）。

| scope | 包含 |
|---|---|
| `safe`（默认） | 实例临时目录、接单回执、已终结任务、旧截图（**不含孤儿附件**） |
| `tmp` / `receipts` / `taskruns` / `screenshots` | 单项 |
| `orphan_uploads` | 仅孤儿附件（显式才跑） |
| `all` | 上面全部（仍不含 `workspace/` / 状态账本 / 活跃任务） |

**默认 `dryRun: true`**：先汇报"能清多少条、多少空间"，显式传 `dryRun: false` 才动手。
截图没有预演实现，`dryRun` 下会在 `problems` 里说明"未统计"，不会假装 0 张。

## 删除前的安全校验

- 每个目标都要通过 `realpath` 严格落在对应子目录内（`..` / 符号链接逃逸一律拒绝）；
- 实例目录额外要求**本身不是符号链接**；
- `taskruns` 目录读不完整（`listAll().complete === false`）时，**任务与回执两项直接跳过**
  —— 读不全就可能把"还在跑的树"当成已终结；
- 任一步异常只记日志 + 进 `problems`，其它 scope 继续跑。

## 相关测试

- `server/tests/storage-retention.mjs`：四个选择函数的全部边界（整树免疫、TTL + 上限并集、
  `running` 回执免疫、在跑 bot 跳过、被引用附件免疫）。
- `server/tests/storage-housekeeping.mjs`：真实临时目录端到端（`dryRun` 零删除、
  计数与字节、`deleteBot` 清 `instances/<botId>`、孤儿附件留墓碑、`workspace/` 与
  活跃任务零触碰、`cleanup_storage` 经 `buildChiefTools` 调通、读不完整时保守跳过）。
