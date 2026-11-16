# Spec：收束与交付 v1（rev.2）

> **状态**：待用户审核 · 未开始执行
> **日期**：2026-11-15
> **对应主干**：`main` @ `c20a6b6`（CI 三端全绿）
> **项目定位**：pi-bot 要做**像 pi-coding-agent 那样的多 bot 基座** ——
> 能力靠**声明式登记**扩展，不靠散落的 if 分支。这份 spec 的第一项（W0）
> 就是把这个定位落到代码结构上，其余项都在它之上延伸。
>
> **rev.2 相对 rev.1 的改动**：新增 **W0 能力骨架**（用户要求「先搭骨架再延伸、
> 避免功能之间冲突」），并把「编码风格」与「集成规则」写成可检查的条款。

---

## 0. 五条硬规矩

1. **先骨架，再延伸**。凡是会牵动 2 个以上模块的东西，先把"它属于哪一层、
   唯一事实存在哪"定死，再写业务。**不允许边写边发明结构**。
2. **一个事实只存一份**。同一件事（风险档、谁能用、只读放不放行）
   只能有一个声明点，其余全部**派生**。派生不叫复制。
3. **不装成已完成**。规格 §17 原话要求「不是全禁用，也不是全放开」，
   且「本稿没有任何当前实现通过结论」。任何"已完成"必须附
   commit + 可复跑的验证命令。
4. **一项一项收口**（用户 2026-11-15 原话）。每项独立 commit、独立验证，
   收完再开下一项。
5. **不留半截平台代码**。需要实机的（输入、截图权限、TCC）先落纯逻辑 + 测试，
   平台实现单独一项、失败可整块回退。

---

## 1. 编码风格（从现有仓库实测，不是我的偏好）

pi-bot 已经有一条很稳定的风格。新代码必须照着写，否则看起来像外人写的。

| 约定 | 实例 | 要求 |
|---|---|---|
| **纯逻辑单独成文件**，头部注释先讲"为什么需要这件事"、讲清楚两种错误做法 | `policy-version.js` / `grants.js` / `action-catalog.js` | 新模块必须这样开头 |
| **不 import store / 不读时钟 / 不碰文件** 的才叫纯逻辑 | `grants.js` / `shell-policy.js` / `automations.js` | 能在 `tests/` 里直接单测 |
| **有 IO 的装配层薄**，只接线 | `server-main.js` / `http.js` | 判定不写在接线层 |
| **测试文件同构**：模块头注释讲守什么 → `fixture` 临时目录 → 直方图式 `test()` → `✓/✗` 逐条打印 → `N/N 通过` | `tests/action-catalog.mjs` | 新测试照抄这个骨架 |
| **测试要"守事实"，不守实现细节** | 断言"策略放行的工具必须有对应动作"而不是"数组等于这 5 个" | 否则一改实现就假红/假绿 |
| **注释写"为什么"和"踩过什么坑"**，不写"这一行做什么" | 全仓一致 | 关键分支必须写理由 |
| **commit message 中文、讲改了什么 + 为什么**，不写搬运过程 | 近期 40 个提交 | 保持 |

**落地检查**：W1 里加 `scripts/check-style.mjs`，验证三条机器可判断的：
纯逻辑模块不含 `import { store }`、不含 `Date.now()`（除非显式传入 now）、
`tests/` 里同一个模块的测试文件存在。

---

## 2. 现状事实（实测，不是结论）

### 2.1 已交付（有代码 + 有测试 + 有 commit）

| 能力 | 证据 |
|---|---|
| 授权模型 + 统一网关（父链/撤销/世代/策略版本） | `grants.js` `grant-gate.js` `migration-grants.js` · `tests/grants.mjs` 42 项 · `b130fc6` `c5da8dc` |
| 动作目录（风险/可撤销/目标认法的单一来源） | `action-catalog.js` · `tests/action-catalog.mjs` 20 项 · `ce137d8` |
| HTTP 危险路由接网关 + nonce + 审计 | `http-admin.js` · `tests/http-admin.mjs` 15 项 · `df549c5` |
| 高风险确认（手机通道 / 目标摘要绑定 / 一次一用） | `confirm.js` · `tests/confirm.mjs` 23 项 · `cdb9f5a` |
| 桌面观察（列窗口 / 截指定窗口） | `desktop-observe.js` · `c45eb7c` |
| Git G0/G1/G2-push（push 要手机确认） | `git-ops.js` `git-tools.js` |
| 模板不得签发授权 | `tests/template-grants.mjs` 4 项 · `7f63583` |
| 授权可见 + 可收回 + 判定记录 | `/api/grants` `/api/grant-audit` + App 系统页 · `37ed25b` `7766a11` |
| 主 Bot / 负责人能自己动手（先派后干） | `c20a6b6` · `tests/role-tools.mjs` 11 项 |

**server 105/105 测试文件通过；app 740 项；`flutter analyze` 干净。**

### 2.2 ★ 结构问题：一个能力要在 7 处登记、跨 4 个文件

实测（把 `desktop_observe` 的登记点全找出来）：

```
1. action-catalog.js   ACTIONS        风险档 / 可撤销 / 要不要目标
2. action-catalog.js   TOOLS          哪几个工具产生这个动作
3. action-catalog.js   TARGET_RULES   从哪个入参字段认目标
4. role-tools.js       READONLY_ALLOW 只读档放不放行
5. role-tools.js       CHIEF_ONLY_TOOLS 是否只给主 Bot
6. migration-grants.js MIGRATION_WITHHELD / CHIEF_ONLY_ACTIONS 迁移档给不给
7. tools.js            defineTool     工具实现
```

**这就是"功能之间冲突"的根源。** 加第 8 个能力时漏掉任一处，得到的不是报错，
而是**静默错误**。这一周已经踩到 4 次：

| 漏了哪一处 | 现象 |
|---|---|
| 迁移授权没列新动作 | 主 Bot 一调就 `no_grant`，看着像"功能坏了" |
| 只读名单与网关不同步 | 切成只读后 12 个工具被误拦（连 `web_search` 都不行） |
| 风险档按工具名查动作名 | 审计里 `risk` 恒为 `null` |
| 签发/校验的世代不一致 | 「重启后旧批准不续命」从没生效过 |

**结论**：这不是纪律问题，是结构问题。同一件事写在 7 个地方，人一定会漏。

### 2.3 规格 §11 的账

| 项 | 现状 |
|---|---|
| **P0-3b 桌面输入**（鼠标/键盘 + 输入租约 + 接管检测 + 世代号） | **零代码**（`grep SendInput\|CGEvent\|inputLease` 全空） |
| **P0-3 桌面单写租约**（同一桌面只有一个注入租约） | **零代码** |
| **P0-2 用户自定义覆盖层**（四层配置的②） | **零代码**（只有模板/授权/执行记录三层） |
| **P0-6 Git G2/G3**（merge/rebase/force/reset/clean） | **明确拒绝** —— 属产品决策，本 spec 不动 |
| **P1-1 worktree 授权图** | 解析有了（`gitdir/commondir/realpath`），授权图没有 |
| **P1-2 §12 验收矩阵 14 行** | **基本全空**（Windows 4 处、macOS 1 处"待实机"） |
| **P1-3 审计/崩溃恢复/授权对账/并发** | 审计有，其余未做 |
| **P2 全套** | **未开始** |

### 2.4 状态锈

| 问题 | 影响 |
|---|---|
| 权限规格在 `~/Downloads/architecture-permissions-v1.0.1.md`，**不在仓库** | 驱动代码的规格不跟代码走 |
| `docs/PERMISSIONS-INVENTORY.md` 进度表停在 9 行 | 今天 12 个提交没入账 |
| TaskRun 引擎：**2900 行代码 / 默认关 / `data/taskruns/` 不存在** | 三种状态里最坏的一种：有代码、没数据、界面会画空 |
| TaskRun 测试偏薄 | `task-supervisor` 1564 行实现对 236 行测试 |

---

## 3. 工作项

### W0 · 能力骨架（Capability Manifest）〔半天，**必须先做**〕

> **对应你的两条要求**：「先搭建骨架再延伸」「避免每个功能的冲突」。
> **对应项目定位**：pi-bot 要做像 pi-coding-agent 那样的多 bot 基座 ——
> 那边能力靠 `registerTool()` + 事件声明扩展，我们这边对应的是**一份能力清单**。

**做什么**

新建 `server/src/capabilities.js`（**纯数据，零 import 业务模块**）。一个能力一条声明：

```js
export const CAPABILITIES = Object.freeze({
  'desktop.observe': {
    label: '看屏幕',
    risk: 'medium',          // 审计/界面用
    irreversible: false,     // 确认框架用（拿不准就 true）
    needsTarget: false,      // 窄范围授权是否必须先认出目标
    readonly: true,          // 只读档（dangerous=deny）放不放行
    chiefOnly: true,         // 是否只给主 Bot
    migration: 'chief',      // 迁移授权怎么给：'all' | 'chief' | 'never'
    tools: ['desktop_observe', 'desktop_screenshot'],
    targets: null,           // 目标认法：{ kind, fields } 或 null
  },
  // ... 每个能力一条
});
```

然后**四处改为派生**（不复制、不改行为）：

| 文件 | 现在 | 之后 |
|---|---|---|
| `action-catalog.js` | 手写 `ACTIONS` / `TOOLS` / `TARGET_RULES` | 从 `CAPABILITIES` 派生，保留原导出名 |
| `role-tools.js` | 手写 `READONLY_ALLOW` / `CHIEF_ONLY_TOOLS` | 从 `CAPABILITIES` 派生 |
| `migration-grants.js` | 手写 `MIGRATION_WITHHELD` / `CHIEF_ONLY_ACTIONS` | 从 `CAPABILITIES.migration` 派生 |
| `tools.js` | `defineTool` 各自实现 | 不变（实现和声明本来就该分开） |

**关键：不能有任何行为变化。** 105 个测试文件必须原封不动全绿 ——
这就是这项改造的验收标准：**只换结构，不换语义**。

**加一条自检**（`capabilities.js` 里的 `auditCapabilities()`）：

- 每个 `tools` 里的工具名，在 `tools.js` 里真的有 `defineTool`
- 每个 `tools` 里的工具名，只对应一个能力（不允许一个工具两个身份）
- `needsTarget: true` 但 `targets: null` → 报错（那是"窄范围授权对它失效"）
- `risk: 'critical'` 但 `irreversible: false` → 报错（critical 不该可撤销）

**验收**

```bash
node server/tests/capabilities.mjs      # 新增 ≥ 15 项
cd server && node tests/all.mjs          # 105/105 必须仍是这个数
node scripts/check-capability-drift.mjs  # 新增：确认没有第二份手写清单
```

`check-capability-drift.mjs` 的判据：在 `action-catalog.js` / `role-tools.js` /
`migration-grants.js` 里**不允许**再出现 `'desktop_observe'` 这种硬编码工具名字符串
（排除注释与派生逻辑本身）。

**做完后的收益（可量化）**

```
新增一个能力：7 处跨 4 文件  →  1 处 1 文件
```

---

### W1 · 规格与台账入仓 〔10 分钟〕

**做什么**
- 复制规格到 `docs/spec-permissions-v1.0.1.md`，加状态头
- 重写 `docs/PERMISSIONS-INVENTORY.md` 进度表：按 §11 三层重列，P0 逐条带 commit
- 欠账进 GitHub Issues：每条带「下一步最小动作」（此前是一张 TODO 台账，2026-11 删除）
- 新建 `scripts/check-spec-progress.mjs`：进度表里写的 commit 是否真在 `git log` 里

**验收**
```bash
ls docs/spec-permissions-v1.0.1.md
node scripts/check-spec-progress.mjs   # 进度表与 git log 对得上
node scripts/check-style.mjs           # §1 的三条机器可判断约定
```

---

### W2 · P0-3b 桌面输入（分五步，每步可停）

> 规格 §5.2：*「同一 OS 桌面会话只有一个能注入输入的租约……租约有到期、心跳和
> 世代号；用户显式接管立即吊销租约、丢弃尚未执行输入。」*

**W2a · 租约状态机（纯逻辑）**
`server/src/desktop-lease.js`：`acquire / renew / release / revoke / isValid`
字段：`taskId` `botId` `generation` `epoch`（转让即 +1）`expiresAt` `heartbeatAt`
规则：同一桌面同时只有一个有效租约；旧 epoch 请求一律拒；过期自动失效
**验收**：`tests/desktop-lease.mjs` ≥ 15 项

**W2b · 接管检测（纯逻辑 + 探针接口）**
`server/src/desktop-takeover.js`：判断"用户是否真的动过手"（人类最后输入时间 > 我们最后注入时间）
平台探针**注入式**（Windows `GetLastInputInfo` / macOS `CGEventSourceSecondsSinceLastEventType`），测试用假探针
**验收**：`tests/desktop-takeover.mjs` ≥ 8 项。**探针不可用时保守判定为"用户在"并拒绝注入**

**W2c / W2d · Windows / macOS 实现**（需实机）

> 进度：W2c 已完成（`d3b77fc`，实机记录在 `docs/WINDOWS.md`）。
> W2d 的空壳已就位：`server/src/desktop-input-mac.js` 六个函数返回
> `not_platform`，`describePlatform('darwin').supported === false`，
> 13 项测试守着"空壳不许谎报成功"。要填什么、改哪些文件、先验哪三件事
> 全写在 `docs/MACOS-DESKTOP-INPUT.md`。
`SendInput` / `CGEvent` 封装；坐标带显示器与缩放版本；布局变化使旧坐标失效
辅助功能未授权时**明确交还用户**，不静默降级
**验收**：`docs/WINDOWS.md` / `docs/MACOS.md` 各加一节实机记录（锁屏 / 多屏 / 125% 缩放）

**W2e · 接骨架与网关**
在 `capabilities.js` **加一条**（不再改 7 处）：
```js
'desktop.input': {
  label: '操作屏幕', risk: 'critical', irreversible: true, needsTarget: false,
  readonly: false, chiefOnly: true, migration: 'never',
  tools: ['desktop_input'], targets: null,
},
```
**验收**：`tests/capabilities.mjs` 自动覆盖到；无租约时调用被拒且文案说明"先申请租约"

**可以停的地方**：W2a + W2b 做完就有价值，任何平台实现都能挂上去，且不产生半截平台代码。

---

### W3 · 用户自定义覆盖层（P0-2 的第②层）〔半天〕

**做什么**：`server/src/overrides.js`（纯逻辑）
- 记录「用户对某个模板实例改了职责/范围/偏好」，带 `templateVersion` 与 `conflicts[]`
- 规格 §13.1 逐条落地：
  - 模板升级**不覆盖**用户改过的字段
  - 冲突要**明示**（模板改了同一字段 → 列出让用户选）
  - **覆盖值不得突破有效授权上限**（覆盖不能变成扩权入口）

**验收**：`tests/overrides.mjs` ≥ 12 项

---

### W4 · TaskRun 引擎启用 〔1 天，前置调研〕

**为什么单列**：2900 行代码 + 默认关 + 数据为空 = 最坏的一种状态。**不允许第三种状态（界面画空数据）**。

**W4a · 缺口评估**（半天）：逐条对照 `docs/TASK-RUN-PROTOCOL.md`，产出 `docs/taskrun-gaps.md`，
列出「代码有、测试没有」的断言，每条要么补测试要么标「已知未覆盖 + 理由」
**W4b · 关键路径补测**：准入三模式（direct / createOnly / 新部门）、命令重放幂等、
撤销后旧后台句柄不续命、预算耗尽 —— 预期 ≥ 20 项
**W4c · 默认开启**：`PI_BOT_TASK_INTAKE` 默认 `1`，保留 `=0` 关闭；
开启后必须验证「用户加一条任务 → 真被派出去执行 → 看板出现」
**验收**：`tests/task-intake-e2e.mjs`（新）走一遍真实链路（假模型替身）

---

### W5 · 任务看板（新）〔1.5 天〕

**形态**（参照 Grok Bot Team Kanban）：四列 **待办 / 进行中 / 已完成 / 等你处理**
+ 顶部四格统计 + 「只看等我的」开关 + 卡片（头像+名字+标题+一句摘要+时间）
+ Bot 头像 chip 过滤 + 入口挂主界面左侧

**W5a · 归类模型先落地（纯逻辑，照 §1 风格）**
`app/lib/task_kanban_model.dart`：11 个状态 → 4 列的映射、优先级、截断规则
**验收**：`app/test/task_kanban_model_test.dart` ≥ 10 项（四列归类不丢信息、等你处理优先、空列、超长标题、无负责人）

**W5b · 看板页**
`app/lib/widgets/task_kanban.dart`（只做展示，状态判定不写在这里）
**说明**：服务端**不需要改** —— `/api/task-runs` 已返回 `phase`（四类）/`waiting`/`leadBotId`

**W5c · 旧数据迁移**
现有 39 条 `TaskItem`（3 未完成 / 36 已完成）迁成 TaskRun 历史
**Done 列只显示有交付物的**：36 条里大部分是对话片段（"收到。先看基线和色板…"整段被记成任务），
迁移时标 `legacy-note` 并**默认折叠**
**验收**：`tests/legacy-task-migration.mjs` —— 幂等、原 ID 可追溯、不产生重复

---

### W6 · §12 验收矩阵实机 〔分批〕

14 行逐行填 Windows + macOS 证据（版本/输入/预期/原始结果/证据引用/静态or实机）
**优先序**：P0 五行先做 —— 用户确认 / 撤销与后台 / 凭据与隐私 / 模板安全 / push-merge
**验收**：`docs/acceptance-matrix.md`（新），每行标 `静态 | 实机 ✓ | 实机 ✗`，✗ 的写明「交还用户」的条件

---

### W7 · P1/P2 欠账登记（不实现）
把 §2.3 里未开始的（worktree 授权图、审计对账、公平排队、优先级、截图增量、
证据外置、模板权限差异预览、许可证清单）写进 GitHub Issues，每条带「阻塞谁 / 最小下一步」

---

## 4. 集成规则（写下来是因为最容易破）

新能力接入现有系统时，**按这个顺序**，每一步都有对应的自检：

| 步骤 | 在哪 | 自检 |
|---|---|---|
| ① 声明能力 | `capabilities.js` 加一条 | `auditCapabilities()` 通过 |
| ② 实现工具 | `tools.js` `defineTool` | `check-capability-drift.mjs`：工具名在清单里 |
| ③ 走网关 | 无需改（`policy-hook` 自动读清单） | `tests/grants.mjs` 的工具覆盖用例 |
| ④ 要人确认 | `capabilities.irreversible = true` 自动生效 | `tests/confirm.mjs` |
| ⑤ 只读档 | `capabilities.readonly` 自动生效 | `tests/action-catalog.mjs` 的漂移用例 |
| ⑥ 进 HTTP | `http-admin.js` 加一条路由分级 | `tests/http-admin.mjs` |
| ⑦ 有界面 | App 侧独立 model + widget 两层 | `app/test/*_model_test.dart` |

**禁止**：在 `tools.js` 的 `execute` 里写授权判定（那是网关的事）、
在 `policy-hook` 里写业务规则（那是 capability 声明的事）。

---

## 5. 顺序与依赖

```
W0（能力骨架）  ← 必须先做，否则后面每个新能力都要改 7 处
 ├─→ W1（规格/台账入仓）
 ├─→ W3（覆盖层）              ← 独立
 ├─→ W2a → W2b                 ← 纯逻辑
 │     └─→ W2c / W2d           ← 需实机，可分开
 │           └─→ W2e           ← 骨架里加一条即可
 ├─→ W4a → W4b → W4c
 │                 └─→ W5（看板）   ← W4c 没完成就不做 W5b
 └─→ W6（验收矩阵）            ← 每项做完补自己的行
W7 最后一次性登记
```

**最小可停线**：W0 + W1 + W2a + W2b —— 骨架站住、账目清楚、租约与接管的纯逻辑成立。

---

## 6. 明确不做（边界）

| 不做 | 理由 |
|---|---|
| Git merge / rebase / force / reset --hard / clean | 规格 §7.1 的 G2/G3，属**产品决策** |
| 桌面输入给非主 Bot | 规格 §5.3：普通桌面输入默认仅主 Bot |
| 让模板携带授权 | 规格 §13.1 明令禁止，已有用例守着 |
| 把「先派后干」写成硬规则（禁止自己上） | 用户 2026-11-15 已明确否掉 |
| 改沙箱策略 | 规格 §8 撤销旧全局规则，但那是产品决策 |
| **再加一层权限抽象** | `capabilities → {catalog, role-tools, migration, gate}` 四层已经够；W0 是把 7 处收成 1 处，不是加第 8 处 |

---

## 7. 风险与不做假承诺

| 风险 | 应对 |
|---|---|
| W0 改造引入行为变化 | **验收标准就是 105/105 不变**；`check-capability-drift.mjs` 保证没有第二份手写清单 |
| W2c/W2d 实机不可控（锁屏、UAC、TCC） | 平台实现单独一项，失败整块回退；租约/接管逻辑仍有效 |
| W4c 打开引擎后任务乱跑 | W4a/W4b 是前置门；保留 `=0` 关闭开关 |
| W5 看板显示空数据 | 依赖 W4c；**W4c 没完成就不做 W5b** |
| 迁移 36 条对话片段污染看板 | 默认折叠 + 标 `legacy-note` |
| 台账再次过期 | `check-spec-progress.mjs` 进 CI，commit 不在 git log 就红 |

---

## 8. 审核点（请你定这六个）

1. **W0 骨架**：`capabilities.js` 一份清单 + 四处派生，这个结构你认可吗？
   （这是 rev.2 的核心，也是"多 bot 基座"的地基）
2. **顺序**：W0 → W1 → W3 → W2a/b → W2c/d → W2e → W4 → W5 → W6 → W7？
3. **看板数据源**：坚持建在 TaskRun 上（要先做 W4），还是先做个只看旧 TaskItem 的临时板？
4. **W4 的胆量**：补完测试再开（我推荐），还是先开 + 真机观察？
5. **W2c/W2d**：现在就做实机（需要你配合验几个场景），还是先只做 W2a/W2b 逻辑层？
6. **W6 验收矩阵**：14 行全填，还是先只填 P0 那 5 行？

---

*本 spec 未执行任何改动。你审完后我按 W0 开工，每项独立 commit + 独立验证。*
