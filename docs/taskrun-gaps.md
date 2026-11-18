# TaskRun 引擎缺口清单（W4a）

> 对应 `docs/spec-convergence-v1.md` 的 W4a：**逐条对照协议，列出「代码有、测试没有」的断言。**
>
> 结论先放前面：**引擎 14 691 行 / 45 个模块，有测试引用的只有 3 509 行（23%）。**
> 而且"有引用"不等于"有断言" —— 大部分只是被 `import` 进来当夹具用。
>
> **进展（W4b 五步已补）**：命令重放 / 预算 / 归约器不变量 / 未知副作用 /
> 撤销与后台句柄，五块补了 68 项断言，2 283 行从"零覆盖"变成"有直接测试"。
> 但准入三模式、请求回执、专业验收、存储并发仍是零覆盖，所以
> `PI_BOT_TASK_INTAKE` 继续默认关闭。

## 怎么算的

```bash
cd server
# 每个模块被多少个测试文件提到（名字出现在测试里）
python3 - <<'PY'
import os, glob, re
...
PY
```

判据刻意宽松：**模块名在测试文件里出现过**就算"有引用"。所以 23% 是**上限**，
真实断言覆盖只会更低。这不是精确的覆盖率工具（没装 c8），但它足够回答
"打开开关前还差多少"。

---

## 一、模块 × 测试引用

`Y` = 有测试文件提到，`N` = 完全没有。

| | 模块 | 行数 | 测试文件 |
|---|---|---|---|
| Y | `task-supervisor` | 1564 | `task-supervisor.mjs`（5 项）、`task-file-claims.mjs`、`all.mjs` |
| N | `task-reduce` | 1198 | — |
| N | `task-run-store` | 961 | — |
| N | `task-verification` | 795 | — |
| N | `task-progress` | 640 | — |
| N | `task-runtime` | 580 | — |
| N | `task-contract` | 578 | — |
| N | `attempt-ledger` | 485 | — |
| Y | `department-service` | 446 | `server-mode.mjs`（只是 import） |
| N | `task-controls` | 407 | — |
| N | `task-admission` | 376 | — |
| N | `task-budget-coordinator` | 371 | — |
| N | `task-attempt` | 332 | — |
| N | `task-attempt-lifecycle` | 329 | — |
| N | `department-policy` | 302 | — |
| N | `task-insight-tool` | 299 | — |
| Y | `handoff-host` | 291 | `server-mode.mjs` |
| Y | `task-file-claims` | 286 | `task-file-claims.mjs`（15 项，**这块测得好**） |
| Y | `task-run-factory` | 267 | `task-supervisor.mjs`、`task-file-claims.mjs` |
| N | `task-commands` | 266 | — |
| N | `task-budget` | 260 | — |
| N | `intake` / `intake-tool` | 419 | — |
| N | `task-request-receipts` / `-result` | 311 | — |
| N | `task-routes` | 194 | — |
| N | `task-goal` | 194 | — |
| Y | `task-transport` | 194 | `task-projection.mjs` |
| N | `task-context` | 189 | — |
| Y | `task-subtasks` | 186 | `task-file-claims.mjs` |
| Y | `task-mentions` | 139 | `task-file-claims.mjs` |
| N | 其余 19 个模块 | 2 132 | — |

**合计：45 个模块 / 14 691 行；有引用 3 509 行（23%）。**

`task-supervisor` 是唯一有真正断言的大模块（5 项，守"执行有界性"），
其余 12 000 行基本没有直接测试。

---

## 二、协议条款 × 覆盖情况

按 `docs/TASK-RUN-PROTOCOL.md` 的每个 `##` 小节逐条对。**判定标准**：
测试里有没有一条断言能让这条规则**在写错时变红**。只是 import 不算。

| 协议条款 | 代码 | 测试 | 判定 |
|---|---|---|---|
| 请求闸门（并发同键 inflight / 不同内容冲突 / 坏回执拒绝） | `task-request-gate.js` | 无 | ⛔ **缺口** |
| 回执 corrupt 判定（只有 ENOENT 算不存在） | `task-request-receipts.js` | 无 | ⛔ **缺口** |
| 准入三模式（direct / createOnly / 新部门） | `task-admission.js` | 无 | ⛔ **缺口** |
| discussion 模式不建任务不派执行 | `intake.js` | 无 | ⛔ **缺口** |
| 命令应用事实（appliedCommands，重放不重复） | `task-commands.js` | 无 | ⛔ **缺口（协议明确要求"重放只认应用事实"）** |
| 未应用 + sequence 变化 → 不确定拒绝 | `task-commands.js` | 无 | ⛔ **缺口** |
| outbox 写盘失败不发送 | `task-transport.js` / app 侧 | 无（服务端） | ⛔ **缺口** |
| 同步完整性（hello 快照 / 分页 complete） | `task-routes.js` | 无 | ⛔ **缺口** |
| DM 受管执行走 `run()` 而不是 `runRound()` | `task-runtime.js` | 无 | ⛔ **缺口** |
| createOnly 用主机收据收口，不伪造 attempt | `handoff-host.js` | 无 | ⛔ **缺口** |
| 输入提交校验（被拒文本不进 inputs / 不进 prompt） | `task-controls.js` | 无 | ⛔ **缺口** |
| 稳定分页游标（同毫秒不跳过） | `task-routes.js` | 无 | ⛔ **缺口** |
| 预算：`min(任务默认, 用户 groupLimits.maxRuns)` 只收紧不放宽 | `task-budget.js` | `unit.mjs` 有 9 处 budget 相关 | 🟨 部分 |
| 暂停/阻塞不擦掉审批门槛 | `task-reduce.js` | 无 | ⛔ **缺口（审查 H04 就是因为这个出的）** |
| 旧版本结果按自己版本归档（改版后仍能落地） | `task-reduce.js` | 无 | ⛔ **缺口** |
| 事件身份绑定（外层 attemptId 与内层结果不一致要拒） | `task-reduce.js` | 无 | ⛔ **缺口（第五轮 P2 修的，修完没测）** |
| 完成候选只认 `returned` | `task-attempt.js` | 无 | ⛔ **缺口（R04 同类 bug 有过两次）** |
| expert 条件没记录 → needsReview（普通文本不能放行） | `task-verification.js` | 无 | ⛔ **缺口** |
| 缺失文件 → blocked，不把"不存在"当正文 | `task-verification.js` | 无 | ⛔ **缺口** |
| 初次交接恢复（pending_handoff / handoff_failed） | `task-recovery.js` / `handoff-host.js` | `server-mode.mjs` 提到 | 🟨 部分 |
| 首派意图识别（dispatch + 0 attempt + queued） | `task-supervisor.js` | `task-supervisor.mjs` 有 | 🟨 部分 |
| 执行次数上界 / 高频 notify 不放大 | `task-supervisor.js` | `task-supervisor.mjs` 5 项 | ✅ |
| 文件占用互斥（撞车排队而不是同时写） | `task-file-claims.js` | `task-file-claims.mjs` 15 项 | ✅ |
| 撤销后旧后台句柄不续命 | `task-controls.js` | 无 | ⛔ **缺口** |
| 未知副作用不重放 | `run-managed-attempt.js` | 无 | ⛔ **缺口** |

**统计：✅ 2 条 / 🟨 3 条 / ⛔ 19 条。**

---

## 三、按"打开开关会怎样"排序的优先级

开关一开，这些缺口会直接变成生产事故。按后果排：

### P0 · 开了就可能重复付钱 / 重复改动

1. **命令重放幂等**（`task-commands.js`）：协议写了整套 appliedCommands +
   fingerprint 机制，**零测试**。写错的表现是"用户点一次继续，执行了两次"。
2. **预算耗尽**（`task-budget.js`）：只有 `unit.mjs` 里 9 处零散提到，
   没有一条测"耗尽后真的停"。写错的表现是无界烧 token。
3. **未知副作用不重放**（`run-managed-attempt.js`）：`unknown_outcome` 之后
   重试会重复执行。**零测试**。
4. **撤销不续命**（`task-controls.js`）：`write_stdin` 那条在 shell 层测过，
   但**任务层**没有 —— 撤销后旧 attempt 句柄能不能继续写，没人验证。

### P1 · 开了会静默丢事实

5. **门槛不被组合丢掉**（`task-reduce.js` 的 H04）：暂停再恢复后审批门槛还在吗？
   审查当时就是因为这个出的 bug，现在**没有回归测试**。
6. **旧版本结果按自己版本归档**：改版后旧 attempt 的结果能不能结算？
   代码注释写了一大段"为什么必须按记录版本"，没有测试守着。
7. **完成候选只认 `returned`**：R04 实测过"辅助函数说不行、归约器却推进了"。
   两处已经统一成同一份常量，但**没有测试守住这个统一**。

### P2 · 开了会让用户看到错的东西

8. **expert 条件未记录 → needsReview**：普通完成文本能不能冒充专业判断？
   `task-verification.js` 795 行零测试。
9. **缺失文件 → blocked**：把"文件不存在"当正文通过，用户会以为交付了。
10. **分页游标同毫秒不跳过**：只有 500 条任务时才暴露，本地测不出来。

---

## 四、明确不做的（写下来免得反复讨论）

| 不做 | 理由 |
|---|---|
| 追 80% 行覆盖率 | 覆盖率不代表"关键约束被守住"。上面 10 条是按**后果**挑的，不是按行数挑的。 |
| 给每个模块配一个测试文件 | 那是形式主义。`task-contract.js`（578 行）是纯常量，测它就是测 `Object.freeze`。 |
| 在 CI 里跑真实模型 | 那不是单元测试。用假模型替身就够（见 W4c）。 |

---

## 五、结下来的顺序（W4b）

按 P0 → P1 逐条补，每条一个测试文件、一个 commit：

| 步 | 补什么 | 文件 | 项数 | 状态 |
|---|---|---|---|---|
| 1 | 命令重放：已应用回放不重复 / 未应用且 sequence 变 → 不确定 / 身份篡改与坏回执 | `tests/task-commands.mjs`（新） | 14 | ✅ `7cd6147` |
| 2 | 预算：耗尽即停 / 账本才是权威 / 只收紧不放宽 / 退款不退成负数 | `tests/task-budget.mjs`（新） | 15 | ✅ `7088c5a` |
| 3 | 归约器不变量：暂停阻塞不擦门槛 / 旧版本结果归档 / 事件身份绑定 / 完成候选只认 returned | `tests/task-reduce.mjs`（新） | 16 | ✅ `0483814` |
| 4 | 未知副作用：unknown_outcome 不结算不退款 / 结算被拒不退款 / 派发失败才退款 | `tests/run-managed-attempt.mjs`（新） | 10 | ✅ 本提交 |
| 5 | 撤销与后台句柄：控制事实身份 / 旧版本批准不放行 / 重复消费只一次 / 取消级联不连坐 / 旧句柄标取消 | `tests/task-controls.mjs`（新） | 13 | ✅ 本提交 |
| 6 | 准入三模式与讨论态不建单：`discussion` / `direct` / `createOnly` / `new` & `existing` / 专家验收 Route 守卫 | `server/tests/task-admission.mjs` | 11 | ✅ W4b 收口 |
| 7 | 请求闸门与坏回执：`inflight` 并发抑制 / 租约抢占 / `EISDIR`·坏 JSON·残缺字段 `corrupt` / 权威 TaskRun 优先 | `server/tests/task-request-gate.mjs` | 7 | ✅ W4b 收口 |
| 8 | 产出验收门禁：`expert` 无审核 `needs_review` / `format` 缺文件 `blocked` / 不可信完成声明拒收 / 改版重验 | `server/tests/task-verification.mjs` | 9 | ✅ W4b 收口 |
| 9 | 存储并发事务与根授权：10 路并发 `mutate` / 并发 `acceptRequest` / CAS 守卫 / 子任务根授权全分支 | `server/tests/task-run-store.mjs` | 5 | ✅ W4b 收口 |

**九步全部补齐**：准入三模式、请求闸门与回执、专业验收门禁、存储并发写与根授权全部已有直接回归测试，W4b 门禁已通过（接下来转入 W4c 全双工/Jarvis/SDK 协同开启与端到端测试）。
