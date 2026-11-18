# Spec：收束与交付 v1（rev.3）

> **状态**：执行中（W0 / W1 / W3 / W4 / W7 ✅ 已收口；W5 ✅ 看板/顶栏已统一 TaskRun、W5c 已打标；W2 / W6 🟡 推进中）
> **日期**：2026-11-19（rev.4：同步实测基线、R1–R4 收口、补记 2026-11-18 已落地但未入账的 5 项）
> **对应主干**：`main` @ `dc09e85`（在 `fe4e501` 后已合入 W4 收口 `527040f`、品牌环境变量统一 `81065f1`、W1 CI 守卫 `4adac4b` 及 W5 看板与房间面板阶段提交 `c0aaeea`..`dc09e85`）
> **实测基线（2026-11-19 复跑）**：服务端 **157/157** 测试文件通过（含 `sandbox-win` **30/30**，此前记录的 1 项环境失败已消失；口径以 `cd server && node tests/all.mjs` 输出为准）、App `flutter test` **928** 通过、`check-capability-drift`（16 动作 / 72 工具）、`check-consistency`、`check-style`（20 个纯逻辑模块）、`check-spec-progress` 全绿。
> **项目定位**：**Orbis**（兼容 `PI_BOT_*` 与旧导出名）要做**像 `pi-coding-agent` 那样的可嵌入多 Agent 基座** ——
> 能力靠**声明式清单 + 统一领域服务**扩展，不靠散落的 `if` 分支；以单骨架（`Capabilities + Services + Runner 子模块 + GrantGate`）同时支撑 App、主控 Jarvis 总管家与 SDK（`createOrbisRuntime` / `createOrbisClient`）。
>
> **rev.3 相对 rev.2 的改动**：
> 1. 同步主干现实基线（`037620e` / `ee4e9a7` / `1f116ee` / `fe4e501` 及 `server/src/pi-runner.js` 模块化拆分）；
> 2. W0 示例代码对齐真实的 `ACTIONS` + `TOOL_SPECS` 双层声明结构，并修正自检路径为 `server/scripts/check-capability-drift.mjs`；
> 3. §4 集成规则升级为四层单骨架（清单 → `services/*` → `runner/*` → HTTP/SDK/App）；
> 4. 补充 **W4c 与全双工（Full-Duplex）/ Jarvis / Orbis SDK 的协同契约**（日常问答与 Jarvis 零二次追问、`amend` 不被接单队列劫持、SDK 默认隔离）；
> 5. 明确 **W5 任务看板与房间内任务面板保留并统一 `TaskRun` 数据源**、通用旧数据启发式迁移规则；
> 6. 更新 §6 边界（`git_destructive` 经手机确认开放、`T1 独立桌面` 与 `T2 用户真实桌面` 分级）并完成 **W1** 进度/风格 CI 自检。

---

## 0. 五条硬规矩

1. **先骨架，再延伸**。凡是会牵动 2 个以上模块的东西，先把“它属于哪一层、唯一事实存在哪”定死，再写业务。**不允许边写边发明结构**。
2. **一个事实只存一份**。同一件事（风险档、谁能用、只读放不放行、领域校验）只能有一个声明点，其余全部**派生**或**复用**。派生不叫复制。
3. **不装成已完成**。规格 §17 原话要求「不是全禁用，也不是全放开」，且「本稿没有任何当前实现通过结论」。任何“已完成”必须附 commit 或可复跑的验证命令。
4. **一项一项收口**（用户 2026-11-15 原话）。每项独立验证、独立收口，确认通过再开下一项。
5. **不留半截平台代码**。需要实机的（输入、截图权限、TCC）先落纯逻辑 + 测试，平台实现单独一项、失败可整块回退。

---

## 1. 编码风格（从现有仓库实测，机器可检查）

Orbis 已经有一条稳定的代码骨架与风格约定。新代码必须遵守：

| 约定 | 实例 | 要求 |
|---|---|---|
| **纯逻辑单独成文件**，头部注释讲清“为什么需要这件事” | `policy-version.js` / `grants.js` / `duplex-router.js` | 新纯逻辑模块必须以 `/**` 注释开头 |
| **不引 `store` / `config` / FS / 进程 / 网络、不暗自读时钟** | `grants.js` / `overrides.js` / `desktop-lease.js` | `Date.now()` 仅允许作为 `now = Date.now()` 可注入默认参数，能在 `server/tests/` 直接单测 |
| **领域逻辑进 `services/`，装配层保持薄** | `server/src/services/*.js` / `http.js` / `sdk/index.js` | HTTP、Jarvis 工具、SDK 三端复用同一服务，不在路由或外观层重复写业务逻辑 |
| **运行时严格单向模块化（DAG）** | `server/src/pi-runner.js` → `server/src/runner/*.js` | `pi-runner.js` 外观层 `<= 850` 行；`runner/*.js` 各 `<= 1350` 行且禁止反向导入 `pi-runner.js` |
| **测试文件同构且“守事实”** | `server/tests/action-catalog.mjs` | 模块头说明守什么 → 临时目录隔离 → 直方图式校验 → 打印 `N/N 通过` |
| **注释写“为什么”和“踩过什么坑”** | 全仓一致 | 关键分支与兼容边界必须写明理由 |
| **commit message 中文、讲改了什么 + 为什么** | 近期提交历史 | 保持 |

**落地检查（W1，已入仓 `scripts/check-style.mjs`）**：
1. 指定的 20 个纯逻辑模块必须有 `/**` 文件头，且排除注释后不得 import `store.js`、`config.js`、`fs`/`node:fs`、`child_process`/`node:child_process`、`http`/`https`/`net`，且 `Date.now()` 仅限默认参数注入；
2. 这 20 个纯逻辑模块各自在 `server/tests/` 中都有对应回归测试覆盖（拒绝为纯常量文件形式主义凑空测试）；
3. `server/src/pi-runner.js` 行数 `<= 850`，`server/src/runner/*.js` 行数各 `<= 1350` 且保持无环单向 DAG。

---

## 2. 现状事实（实测，不是结论）

### 2.1 已交付（有代码 + 有测试 + 已验证）

| 能力 | 证据 |
|---|---|
| W0 能力单一事实源 + 自检 | `server/src/capabilities.js` + 三处派生 + `server/scripts/check-capability-drift.mjs`（16 动作 / 72 工具）+ `server/scripts/check-consistency.mjs` |
| 授权模型 + 统一网关（父链/撤销/世代/策略版本） | `grants.js` `grant-gate.js` `migration-grants.js` · `server/tests/grants.mjs` 43 项 · `b130fc6` `c5da8dc` |
| 动作目录（从清单派生，零漂移） | `server/src/action-catalog.js` · `server/tests/action-catalog.mjs` 20 项 · `ce137d8` |
| HTTP 危险路由接网关 + nonce + 审计 | `server/src/http-admin.js` · `server/tests/http-admin.mjs` 15 项 · `df549c5` |
| 高风险确认（手机通道 / 目标摘要绑定 / 一次一用） | `server/src/confirm.js` · `server/tests/confirm.mjs` 23 项 · `cdb9f5a` |
| 桌面观察（T2 用户桌面 + T1 独立桌面） | `server/src/desktop-observe.js`（`c45eb7c`）+ `server/src/desktop-island.js`（`desktop-island*.mjs` 47 项） |
| W2 桌面输入逻辑与 Windows 实现（W2a/b/c/e） | `desktop-lease.js`（24 项）`desktop-takeover.js`（31 项）`desktop-input.js`（50 项 · `d3b77fc`） |
| W3 用户自定义覆盖层 | `server/src/overrides.js` · `server/tests/overrides.mjs` 29 项 |
| Git G0/G1 + G2/G3 受控操作 | `git-ops.js`（27 项）`git-push-flow.mjs`（10 项，`git_destructive` 绑定手机强确认） |
| 模板不得签发授权 | `server/tests/template-grants.mjs` 4 项 · `7f63583` |
| 授权可见 + 可收回 + 判定记录 | `/api/grants` `/api/grant-audit` + App 系统页 · `37ed25b` `7766a11` |
| 全双工边干边聊、Jarvis 总管家与 Orbis SDK | `037620e` `ee4e9a7` `1f116ee` `fe4e501` · `duplex-router`/`full-duplex`/`jarvis-mode`/`sdk-runtime` |
| `PiRunner` 六子模块单向架构拆分 | `server/src/pi-runner.js`（825 行）+ `server/src/runner/*.js` · `server/tests/runner-modular.mjs` 5 项 |
| 派活流水不再当任务（2026-11-18 落地） | `server/src/task-title.js`（`isTaskWorthy` / `normalizeTaskTitle`）+ `server/tests/task-title.mjs` 8 项：自我介绍/招呼/纯应答/短问句不建任务，真派活标题压成一句话（去 markdown、48 字、不切 emoji） |
| 看板取消与完成区分（2026-11-18） | `app/lib/task_kanban_model.dart` + `app/lib/widgets/task_kanban.dart`：`cancelled` 卡片在「已完成」列打「已取消」标签并压暗至 72% |
| 记忆摘要按 markdown 渲染（2026-11-18） | `app/lib/widgets/room_panel.dart`：全文用 `MdText`，卡片预览先 `preview(stripMarkdown(...))` |
| 在跑 bot 胶囊并列显示（2026-11-18） | `app/lib/widgets/activity_monitor.dart`：去掉 2.2s 轮播，按「在跑工具 > 在写 > 在思考」排序并列最多 3 个 + `+N` |
| 任务浮层开关与点叉修复（2026-11-18） | `app/lib/widgets/task_board.dart` / `app/lib/screens/chat_screen.dart`：详情弹窗用 `dialogContext` 关闭；顶栏按钮持关闭句柄并对 500ms 内的“关闭→反触发”吞掉 |
| W4 TaskRun 引擎补测与默认开启 | `server/tests/task-admission.mjs` / `server/tests/task-request-gate.mjs` / `server/tests/task-verification.mjs` / `server/tests/task-run-store.mjs` / `server/tests/task-intake-e2e.mjs` · `527040f`（共 9 块测试 + `ORBIS_TASK_INTAKE` 默认开启 + SDK 默认隔离） |

**当前实测基线：服务端 145/146 测试文件通过（`sandbox-win` 在 Windows `.git` 文件型 worktree 有 1 项环境失败待排查）；漂移检查与八项一致性检查全绿。**

### 2.2 历史结构问题“7 处登记”已由 W0 收口验证

此前新增一个能力需要跨 4 个文件改 7 处（`action-catalog.js` × 3、`role-tools.js` × 2、`migration-grants.js` × 1、`tools.js`），漏改会造成静默故障。
在 `037620e` 接入 10 个 Jarvis 工具与独立桌面工具时，实测仅修改 `server/src/capabilities.js`（动作与工具声明）及工具实现即可生效，`action-catalog.js` 一行未改，`server/scripts/check-capability-drift.mjs` 验证零漂移，**证明 W0 的核心结构目标已经成立**。

### 2.3 规格 §11 账本与当前差值

| 项 | 现状 |
|---|---|
| **P0-1 执行入口与授权网关** | ✅ 已收口（`capabilities` → `grant-gate` / `policy-hook` / `http-admin`） |
| **P0-2 用户自定义覆盖层**（四层配置的②） | ✅ 已完成（`server/src/overrides.js` + 29 项测试） |
| **P0-3 / P0-3b 桌面输入与单写租约** | 🟡 W2a/W2b/W2c/W2e 完成；缺 W2d macOS（#30）、锁屏/多屏实机（#31/#32）、拖拽（#33） |
| **P0-4 高风险确认** | ✅ 已落地（含 `isJarvisApprovalCall`；待补双设备真机互验） |
| **P0-6 Git G0/G1 与受控 G2/G3** | ✅ `git_push` 与 `git_destructive` 均接入手机确认 + 目标绑定，拒绝无确认强破坏 |
| **P1-1 / P1-2 / P1-3** | 🟡 已建 Issue #37；`docs/acceptance-matrix.md` 已入仓，P0 实机仍缺双端补全；Windows `sandbox-win` worktree 待修 |
| **TaskRun 引擎与看板（W4/W5）** | 🟡 W4 已收口（9 块测试 + `ORBIS_TASK_INTAKE` 默认开启，`527040f`）；W5 全局看板与部分房间修复已落地（`dc09e85`），待处理 Code Review `R1`–`R4`、`task_board.dart` 数据源统一与 W5c 旧数据迁移（#35/#36） |

---

## 3. 工作项（W0 ~ W7）

### W0 · 能力骨架（Capability Manifest）〔✅ 已完成〕

> **对应项目定位**：Orbis 作为可嵌入的多 Agent 基座，能力声明全部收口在 `server/src/capabilities.js`（纯数据叶子模块，分为 **`ACTIONS` 动作层** 与 **`TOOL_SPECS` 工具层**，避免同一动作下只读工具与动手工具属性打架）。

```js
// server/src/capabilities.js —— 双层单一事实源（示意，非完整清单）
export const ACTIONS = Object.freeze({
  [ACTION.desktopObserve]: {
    label: '看屏幕', risk: RISK.medium, irreversible: false, needsTarget: false, migration: 'all',
  },
  [ACTION.desktopInput]: {
    label: '操作屏幕', risk: RISK.critical, irreversible: true, needsTarget: false, migration: 'never',
  },
});

export const TOOL_SPECS = Object.freeze({
  desktop_observe:        { action: ACTION.desktopObserve, readonly: true, chiefOnly: true },
  desktop_island_observe: { action: ACTION.desktopObserve, readonly: true }, // T1 独立桌面按动作授权
  desktop_input:          { action: ACTION.desktopInput,   mutating: true, chiefOnly: true },
});
```

三处派生层只转发、不手写工具名：
- `server/src/action-catalog.js`：派生 `ACTIONS`、`TOOLS`、`TARGET_RULES`
- `server/src/role-tools.js`：派生 `READONLY_ALLOW`、`CHIEF_ONLY_TOOLS` 等工具白名单
- `server/src/migration-grants.js`：从 `ACTIONS.migration` 派生迁移授权范围

**验收命令**：
```bash
cd server
node tests/capabilities.mjs
node scripts/check-capability-drift.mjs
node scripts/check-consistency.mjs
```

---

### W1 · 规格与台账入仓及自检守卫 〔✅ 已完成〕

- 主权限规格入仓：`docs/spec-permissions-v1.0.1.md`
- 执行入口盘点同步：`docs/PERMISSIONS-INVENTORY.md`
- 欠账台账已转 GitHub Issues（每条附「下一步最小动作」）
- 新增并接入 CI（`.github/workflows/ci.yml`）：
  - `scripts/check-spec-progress.mjs`：核对规格/台账里的 commit SHA 是否存在于 `git log`（浅克隆自动跳过历史查重），且标注为已落地的仓库文件路径全部真实存在；
  - `scripts/check-style.mjs`：执行 §1 的三条机器可检查规范（纯逻辑隔离 + 对应回归测试 + `pi-runner.js` / `runner/*.js` 单向模块体积预算）。

**验收命令**：
```bash
node scripts/check-spec-progress.mjs
node scripts/check-style.mjs
node scripts/check-secrets.mjs
```

---

### W2 · P0-3b 桌面输入与分级隔离 〔🟡 推进中〕

> 规格 §5.2 与 §5.6 将桌面操作划分为两级：**T2 用户真实桌面**（仅主 Bot、`desktop_observe` / `desktop_input`）与 **T1 独立虚拟桌面**（Bot 隔离会话可按动作授权的 `desktop_island_observe` / `desktop_island_launch` / `desktop_island_input`）。两级共用同一套 `desktop-lease` 互斥租约思想与能力骨架。

- **W2a · 租约状态机（✅）**：`server/src/desktop-lease.js` + `server/tests/desktop-lease.mjs`（24 项）
- **W2b · 接管检测（✅）**：`server/src/desktop-takeover.js` + `server/tests/desktop-takeover.mjs`（31 项）
- **W2c · Windows 实现（✅ 基础实机，`d3b77fc`）**：`server/src/desktop-input.js` + `docs/WINDOWS.md` + `server/tests/desktop-input.mjs`（50 项）；**待补实机**：锁屏（#31）、多屏与混合缩放（#32）、拖拽（#33）
- **W2d · macOS 实现（❌ 空壳，#30）**：`server/src/desktop-input-mac.js` + `docs/MACOS-DESKTOP-INPUT.md` + `server/tests/desktop-input-mac.mjs`（13 项守门）
- **W2e · 能力骨架接入（✅）**：`desktop_observe` / `desktop_screenshot` / `desktop_lease` / `desktop_input`（T2）与 `desktop_island_*`（T1）已在 `server/src/capabilities.js` 声明并经网关校验

---

### W3 · 用户自定义覆盖层（P0-2 第②层）〔✅ 已完成〕

- `server/src/overrides.js`（纯逻辑）实现用户覆盖优先、冲突显式标注、`checkOverrideBounds` 禁止覆盖突破有效授权上限
- **验收**：`server/tests/overrides.mjs`（29 项全过）

---

### W4 · TaskRun 引擎启用与全双工 / SDK 协同 〔✅ 已完成，#35〕

**为什么单列**：不能在关键并发与验收路径零覆盖、且与全双工实时插话冲突时盲目打开 `TASK_INTAKE=1`。

- **W4a · 缺口评估（✅）**：`docs/taskrun-gaps.md`（梳理 45 模块 / 14,691 行与 19 条协议缺口）
- **W4b · 关键路径补测（✅，共 9 块测试文件）**：
  - **首批 5 块共 68 项断言**：
    - `server/tests/task-commands.mjs`（14 项，`7cd6147`）
    - `server/tests/task-budget.mjs`（15 项，`7088c5a`）
    - `server/tests/task-reduce.mjs`（16 项，`0483814`）
    - `server/tests/run-managed-attempt.mjs`（10 项）
    - `server/tests/task-controls.mjs`（13 项）
  - **补齐剩余 4 块（✅，`527040f`）**：
    1. `server/tests/task-admission.mjs` —— 准入三模式与讨论态不建单（`server/src/coordination/task-admission.js` / `server/src/coordination/intake.js`）
    2. `server/tests/task-request-gate.mjs` —— 请求闸门与坏回执 corrupt 拒绝（`server/src/coordination/task-request-gate.js` / `server/src/tasks/task-request-receipts.js`）
    3. `server/tests/task-verification.mjs` —— 专业验收 `needsReview` 与缺失文件 `blocked`（`server/src/tasks/task-verification.js`）
    4. `server/tests/task-run-store.mjs` —— `server/src/tasks/task-run-store.js` 并发写入与根授权一致性

- **W4c · 默认开启与全双工 / Jarvis / Orbis SDK 协同契约（✅，`527040f`）**：
  1. **品牌环境变量与宿主边界**：
     - 统一经 `server/src/brand.js` `readBrandEnv(env, 'TASK_INTAKE')` 读取 **`ORBIS_TASK_INTAKE`**（向后兼容 `PI_BOT_TASK_INTAKE`）；
     - 完整桌面/服务端宿主（`server/src/server-main.js`）默认开启（显式设 `0` 可关闭）；
     - **SDK 轻量嵌入边界**：`createOrbisRuntime`（`server/src/sdk/index.js`）默认 `taskIntake: false`（支持 `options.taskIntake: true` 显式打开），确保外部调用 `rt.askMain()` 不因未挂 `taskHost` 而被接单作用域卡死。
  2. **日常私聊与 Jarvis 即时控制“零额外延迟”（已拍板）**：
     - 在 `server/src/runner/task-bridge.js`（`withRequestEnvelope`）中，当主控直接回复用户、或调用 Jarvis 即时配置/查询工具、且本轮未产生部门建单或长任务派活意图时，直接按 `'answer'` 结束该次请求生命周期 —— **严禁强跑第二次 `runner.run()` 追问模型补调 `accept_task`**；
     - 只有真正创建/修订长任务或向部门派活时才写入 `TaskRun` 账本并进入看板。
  3. **与全双工三路分流协同（`server/src/runner/duplex-lane.js`）**：
     - `side_reply`：走独立旁路 Talk 会话并返回 `'answer'` 关停该次 `request.scope`，不影响后台在跑的 `TaskRun`；
     - `amend`：主控工作轮忙碌时，用户的补充微调直通 `entry.session.steer()`（写入 `turnAmends`），**不得因携带 `request` 信封就被 `requestQueues` 拦截干等下一轮**；仅明确独立的后续新任务才排队；
     - `abort_replace`：用户要求换方向重来时，若被打断轮绑有受管 `TaskRun`，同步调用 `abortManagedTask` 收口旧尝试后再开启新轮。
  4. **端到端验收（✅，`527040f`）**：`server/tests/task-intake-e2e.mjs`（用假模型替身端到端验证日常聊天/Jarvis 零追问、部门派活建 `TaskRun`、全双工 `side_reply`/`amend`/`abort_replace` 与 `createOrbisRuntime` 默认隔离）。

---

### W5 · 任务看板与房间面板数据源统一 〔🟡 W5a ✅，W5b 🟡，W5c ❌ 未开始，#36〕

**产品形态（对照全双工与团队协作界面）**：
- **全局四列看板**（主界面左侧入口）：**待办 / 进行中 / 已完成 / 等你处理** + 顶部四格统计 + 「只看等我的」开关 + Bot 头像 chip 过滤 + 卡片（头像、名字、标题、当前状态/摘要、时间，遵循 `docs/SPEC-MOTION-V1.md` 动效规范与全双工在跑/旁路状态视觉）。
- **保留房间内任务面板并统一数据源（已拍板）**：保留右侧栏 `app/lib/widgets/room_task_panel.dart` 与聊天顶栏 `app/lib/widgets/task_board.dart`（`showTaskBoard`），将其读写数据源**全部统一到 `TaskRun`（`app/lib/task_run_controller.dart`）**，按当前房间/关联部门过滤展示，淘汰旧版独立 `TaskItem` 双轨维护。

**细分步序**：
- **W5a · 归类纯逻辑模型**：✅ `app/lib/task_kanban_model.dart`（11 状态 → 四列、等你处理优先级、rune 安全截断、旧片段启发式）+ `app/test/task_kanban_model_test.dart`（`c0aaeea` / `cffcc00`；`cd app && flutter test test/task_kanban_model_test.dart`）。
- **W5b · 全局看板页 + 房间面板接线**：✅ 看板页与房间面板都已统一到 `TaskRun`：全局看板 `app/lib/widgets/task_kanban.dart`（四列 + 一行摘要 + 只看等我的 + 负责人过滤 + 旧记录折叠，`1240db7` 去掉了与列头重复的四格统计），入口在 `app/lib/screens/rooms_screen.dart`（平时不显示总数，只在有待处理时亮橙色角标）。**房间顶栏浮层已重写为 TaskRun 面板**：`app/lib/widgets/task_board.dart` 现在读 `state.taskRuns.forRoom()`，卡点开走 `showTaskRunSheet`（pause/resume/cancel/批准/回答都在那里）；旧 `TaskItem` 的“加一行/勾完成/置顶”整套双轨界面已删除（`task_board_test.dart` / `task_board_visual_test.dart` 一并移除），聊天顶栏角标也改成数 TaskRun。R1–R4 已全部收口（见下方表）。
- **W5c · 旧数据打标（✅ 已落地）**：`server/src/tasks/legacy-task-migration.js`（纯逻辑：`looksLikeChatFragment` / `planLegacyNotes` / `withLegacyNotes`）+ `server/tests/tasks/legacy-task-migration.mjs`（7 项：只标已完成且无交付物、寒暄/长句标题，幂等、不丢条目、不改入参）。启动时由 `store.markLegacyTaskNotes()` 幂等打上 `meta.legacyNote`（不删不改正文），界面默认折叠——历史对话片段不再污染「已完成」列。

#### W5 收口与 Code Review 交接清单（R1–R4 已于 2026-11-19 全部收起，保留记录供复查）

**本轮实际收口（均含回归测试）**：

| 项 | 修法 | 测试 |
|---|---|---|
| R1 子任务重复出卡 | `buildKanbanCards(onlyRoot: true)` 默认跳过 `!run.isRoot`，子任务只在根卡的 `childrenSummary` 里展示 | `task_kanban_model_test.dart`：根+2 子 → 只出 1 张卡；`onlyRoot: false` 仍可拿全 |
| R2 两个过滤互斥 | 改成合取：`(!_onlyMine || c.needsYou) && (_lead == null || c.leadName == _lead)` | `task_kanban_page_test.dart`：开「只看等我的」再按负责人 → 只剩那一人的待处理 |
| R3 进板不拉历史 | `_TaskKanbanPageState.initState` 调 `refresh() + refreshHistory()`，顶栏加刷新入口 | 刷新入口存在断言（数据层由现有 controller 测试覆盖） |
| R4.1 切页残留浮层 | `_ChatScreenState.dispose()` 调 `_closeTaskBoard?.call()` 并置空 | `task_board_toggle_test.dart`：换页后浮层消失 |
| R4.2 向下弹出下方竖带点不关 | 不再用 left/top/bottom 推演，改为 `GlobalKey` 量真实 `RenderBox` 矩形判定“里/外”；点同一锚点按钮仍算“再点一下” | `task_board_toggle_test.dart`：点浮层正下方空白能关闭 |

1. **R1（P1 · 子任务重复出卡与统计虚增）**
   - **涉及文件**：`app/lib/task_kanban_model.dart`（`buildKanbanCards`）、`app/lib/widgets/task_kanban.dart`、`app/lib/screens/rooms_screen.dart`
   - **问题**：`state.taskRuns.tasks` 同时包含根任务（`isRoot == true`）与成员子任务（`parentTaskId != null`）。根卡片内部已展示子任务进度（`childrenSummary`），但 `buildKanbanCards` 未过滤 `run.isRoot`，导致子任务作为独立卡片重复出现在看板列中，并使总数统计与 `needsYou` 角标虚增。
   - **要求**：
     - `buildKanbanCards` 增加 `bool onlyRoot = true` 参数，默认跳过 `!run.isRoot` 的子任务；
     - 在 `app/test/task_kanban_model_test.dart` 补充一条包含 `parentTaskId != null` 子任务的防重复出卡与计数断言。
2. **R2（P2 · 「只看等我的」与「成员过滤」互斥覆盖）**
   - **涉及文件**：`app/lib/widgets/task_kanban.dart`（`_TaskKanbanPageState.build` 第 92–96 行）
   - **问题**：`_onlyMine ? ... : (_lead == null ? ...)` 为二选一互斥分支，开启 `_onlyMine` 后点击负责人胶囊 `_lead` 不会叠加过滤成员。
   - **要求**：
     - 改为合取过滤：`allCards.where((c) => (!_onlyMine || c.needsYou) && (_lead == null || c.leadName == _lead)).toList()`；
     - 在 `app/test/task_kanban_page_test.dart` 补充一条同时启用「只看等我的」与成员过滤的组合单测。
3. **R3（P2 · 打开看板页未拉取历史 `TaskRun`）**
   - **涉及文件**：`app/lib/widgets/task_kanban.dart`（`_TaskKanbanPageState`）
   - **问题**：WebSocket 初始同步以活跃任务与近期摘要为主，首次进入看板页未触发刷新与历史拉取，「已完成」列可能缺失历史记录。
   - **要求**：在 `_TaskKanbanPageState.initState()` 中触发 `widget.state.taskRuns.refresh()` 与 `widget.state.taskRuns.refreshHistory()`，并在看板顶栏提供手动刷新按钮。
4. **R4（P2 · 聊天顶栏 `_TaskBoardPopover` 两个边界漏洞）**
   - **涉及文件**：`app/lib/screens/chat_screen.dart`（`_ChatScreenState.dispose`）、`app/lib/widgets/task_board.dart`（`_TaskBoardPopoverState.build` 第 689–697 行）
   - **问题**：
     1. `_ChatScreenState.dispose()` 未调用 `_closeTaskBoard?.call()`，桌面端左栏切换房间时，旧房间挂在根 `Overlay` 上的任务浮层会残留；
     2. `_TaskBoardPopover` 向下弹出（`widget.top != null && widget.bottom == null`）时 `aboveBottom` 恒为 `true`，导致点击浮层正下方直到窗口底部的 `420px` 竖带不会关闭浮层。
   - **要求**：
     - 在 `_ChatScreenState.dispose()` 调用 `_closeTaskBoard?.call()`；
     - 给 `_TaskBoardPopover` 浮层容器挂 `GlobalKey`，通过测量真实 `RenderBox` 矩形判定外部点击关闭，不再依赖固定竖带推导。
5. **W5b 剩余（房间顶栏任务面板数据源统一到 `TaskRun`）**
   - **涉及文件**：`app/lib/widgets/task_board.dart`、`app/lib/screens/chat_screen.dart`、`app/lib/app_state.dart`
   - **要求**：
     - 将 `app/lib/widgets/task_board.dart` 顶栏浮层的读写数据源全面迁到 `TaskRun`（按当前房间/关联部门过滤，保留置顶与勾选状态交互）；
     - `app/lib/screens/chat_screen.dart` 中 `_taskAnchor` 的角标用 `ListenableBuilder(listenable: state.taskRuns, ...)` 监听 `TaskRun` 变化；
     - `app/lib/app_state.dart` 中 `createTask` 移除向旧 `/api/tasks` 的双写。
6. **W5c 剩余（旧 `TaskItem` → `TaskRun` 通用幂等迁移）**
   - **涉及文件**：`server/src/tasks/legacy-task-migration.js`（❌ 待新增）、`server/src/tasks/task-transport.js`、`server/src/server-main.js`、`server/tests/legacy-task-migration.mjs`（❌ 待新增）
   - **要求**：
     - 启动时把历史 `state.tasks` 幂等迁入 `store.taskRuns`（`done` → `completed`，无产物或属对话片段者标 `legacy-note` 供看板默认折叠；`open`/`doing` → `paused_user` 防止服务重启自动误执行）；
     - 在（待新增）`server/tests/legacy-task-migration.mjs` 覆盖重复启动幂等性、`legacy-note` 分类与状态降级语义，并接入 `server/tests/all.mjs`。

---

### W6 · §12 验收矩阵实机 〔🟡 分批推进〕

对照 `docs/acceptance-matrix.md`（14 组），在原有 Windows + macOS 实机项基础上补充三项必验门禁：
1. **Jarvis 高危操作确认门禁（`isJarvisApprovalCall`）**：删除 Bot / 清理知识库 / 修改全局安全策略在手机/桌面端的确认绑定；
2. **T1 独立桌面 vs T2 用户桌面隔离实机**：成员 Bot 调用 `desktop_island_*` 无法越界观察或操控用户真实桌面；
3. **Windows `sandbox-win` worktree 环境修复**：查清并修复 `.git` 为指针文件时 AppContainer SID 写入失败的问题。

---

### W7 · P1/P2 欠账登记 〔✅ 已完成〕

`P1/P2` 未实现项（worktree 授权图、审计对账、公平排队、截图增量、许可证清单等）已登记在 GitHub Issue #37，每条附阻塞对象与下一步最小动作。

---

## 4. 集成规则（Orbis 四层单骨架，写下来防止结构回退）

新增或扩展能力时，**按固定顺序落盘，严禁跳层写逻辑**：

| 步骤 | 落点 | 自检 |
|---|---|---|
| ① 声明能力 | `server/src/capabilities.js`（`ACTIONS` + `TOOL_SPECS`） | `auditCapabilities()` + `server/scripts/check-capability-drift.mjs` |
| ② 领域服务 | `server/src/services/*.js`（纯协调逻辑，不绑传输协议） | HTTP、Jarvis 工具、Orbis SDK 三端共用 |
| ③ 工具/执行 | `server/src/tools.js` / `jarvis-tools.js`；长流程逻辑入 `server/src/runner/*.js` | `scripts/check-style.mjs`（`pi-runner.js` `<= 850` 行、无反向循环引用） |
| ④ 权限与确认 | 自动经 `policy-hook.js` → `grant-gate.js`；高危标 `irreversible: true` | `server/scripts/check-consistency.mjs` + `grants.mjs` / `confirm.mjs` |
| ⑤ HTTP 管理面 | 危险管理路由在 `server/src/http-admin.js` 分级并挂 nonce/审计 | `server/tests/http-admin.mjs` |
| ⑥ 界面呈现 | App 侧遵循 `*_model.dart` 纯逻辑与 `widgets/*.dart` 展示分离 | `flutter test` / `flutter analyze` |

**禁止**：在 `tools.js` 的 `execute` 里手写授权分支；在 `http.js`、`jarvis-tools.js` 与 `sdk/index.js` 里各写一份重复业务代码；把已拆分的运行逻辑堆回 `server/src/pi-runner.js`。

---

## 5. 顺序与依赖

```
W0（✅ 能力骨架）
 ├─→ W1（✅ 规格/台账与 CI 守卫）
 ├─→ W3（✅ 用户覆盖层）
 ├─→ W2a → W2b → W2c/W2e（✅）→ W2d macOS & 实机补齐（#30/#31/#32/#33）
 ├─→ W4a → W4b（9 块测试）→ W4c 默认开启 + 全双工/Jarvis/SDK（✅，527040f，#35）
 │                            └─→ W5 全局四列看板 + Review 修复（R1–R4）+ 顶栏 TaskRun 统一 + W5c 迁移（🟡，#36）
 └─→ W6（🟡 验收矩阵补实机 + sandbox-win 修复）
W7（✅ Issue #37）
```

**当前可安全停线**：W0 + W1 + W3 + W4 + W2a/b/c/e + `PiRunner` 模块化 + Orbis SDK 与全双工 + 全局看板初始页已完成并入仓；下一步按 **W5 收口与 Code Review 交接清单（R1–R4 → W5b 顶栏统一 → W5c 旧数据迁移）** 推进并收口 `#36`。

---

## 6. 明确不做与边界约定

| 边界 | 说明 |
|---|---|
| 不做无确认的破坏性 Git | `git-ops.js` 严格拒绝未经确认的 `force` / `--no-verify`；`git_destructive`（merge/rebase/reset/clean）必须经 `git.destructive` 授权 + 目标摘要 + 手机强确认方可执行 |
| T2 用户真实桌面严格仅主 Bot | `desktop_observe` / `desktop_input`（T2）保持 `chiefOnly: true`、`migration: 'never'`；非主 Bot 仅能按授权使用 T1 隔离虚拟桌面（`desktop_island_*`） |
| 禁止模板自带授权 | 规格 §13.1 明令禁止，由 `server/tests/template-grants.mjs` 守门 |
| 禁止把“先派后干”写成死规则 | 保留主 Bot 自主决定直接动手或拆部门分派（用户 2026-11-15 已明确否掉硬限制） |
| 禁止在网关外再包第八层权限抽象 | `capabilities → {catalog, role-tools, migration, gate}` 足够覆盖权限判断 |
| 禁止绕开 `services/` 在 SDK/Jarvis/HTTP 三端复制代码 | 领域动作统一收口 `server/src/services/*.js` |

---

## 7. 风险与应对

| 风险 | 应对 |
|---|---|
| W4c 打开后劫持全双工 `amend` 或拖慢日常聊天 | 三层口径（2026-11-19 实测修订）：**问进度/状态 → 负责人旁路回答**（不打断任何人）；**补约束 → 只 steer 负责人或被 @ 者**（不打断其他人）；**新任务 → 仍走插话重排**；日常回答与 Jarvis 配置按 `'answer'` 收口、零二次追问 |
| W4c 打开后外部 SDK `createOrbisRuntime` 被卡死 | SDK 运行时默认 `taskIntake: false`，由宿主显式装配开启 |
| W5 看板显示空数据或与房间面板打架 | W4c 完成前不开 W5b；保留房间内任务面板并统一数据源到 `state.taskRuns` |
| 历史闲聊型 `TaskItem` 迁移后刷屏已完成列 | 通用启发式识别无交付物对话片段并标 `legacy-note` 默认折叠 |
| 规格台账或代码规范随开发再次退化 | `check-spec-progress.mjs`、`check-style.mjs`、`check-capability-drift.mjs`、`check-consistency.mjs` 全量接入 CI |

---

## 8. 已拍板决议（含 2026-11-18 确认项）

1. **W0 能力骨架**：采用双层清单（`ACTIONS` + `TOOL_SPECS`）+ 三处派生（已完成）。
2. **推进主序**：W0 → W1 → W3 → W2（逻辑与 Windows 先行，macOS 单独推进）→ W4 → W5 → W6 / W7。
3. **W4 胆量**：先补齐 W4b 剩余 4 块测试（准入/回执/验收/并发写），并与全双工/Jarvis 契约对齐后再默认开启 W4c。
4. **W4c 日常问答与 Jarvis 延迟控制（2026-11-18 用户确认）**：日常私聊与 Jarvis 即时动作保持**零额外轮次延迟**，不强迫多调一次 `accept_task(answer)`，仅明确派活/长任务建 `TaskRun`。
5. **W5 任务看板数据源策略（2026-11-18 用户确认）**：新增全局四列看板同时**保留房间内任务面板入口**，两者数据源统一收敛到 `TaskRun`，废弃旧 `TaskItem` 独立维护链路。
6. **W6 验收矩阵**：先确保 P0 核心门禁、Jarvis 高危确认、T1/T2 隔离与 `sandbox-win` 实机收口。
