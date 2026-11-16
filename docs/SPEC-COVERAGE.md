# 规格逐条对照：还差什么（余账全表）

> 依据 `docs/spec-permissions-v1.0.1.md` §1～§18，**逐条对着代码核实**，
> 不是照抄台账。核实方法写在每条后面的「怎么核的」。
>
> **生成时间**：2026-11-15 深夜。核实时 `server/tests/all.mjs` = 117/117 通过。
>
> 图例：✅ 有代码 + 有测试 ｜ 🟨 有代码但覆盖不全 ｜ ⬜ 没做 ｜ ⛔ 产品决策（刻意不做）

---

## 零、曾经"规格写了但代码里没生效"的六条 —— **已全部收口**

这六条不是"再加点功能"，是规格明确要求、代码里其实没生效。
核实出来时它们**都不报错、不告警**，只是安静地不起作用。
2026-11-15 夜里全部修完：

| # | 曾经的问题 | 修法 | commit |
|---|---|---|---|
| 1 | **执行模式从来没被传进网关**。`grants.js` 有完整三档、`check()` 支持按 mode 过滤，但唯一调用方 `policy-hook.js` 不传 → 那道过滤永远短路，§8 整节运行时不生效 | 新增 `exec-mode.js`（纯逻辑）+ `session-factory` 算一次 + `policy-hook` 传进去 | `406fb89` |
| 2 | **桌面租约不随任务结束释放**。`revokeLease()` 生产零调用，只有模型自己调 `desktop_lease release` | `task-runtime.onCancel` 先撤租约再落状态；`reportTerminal` 对三条终态兜底释放 | `202f0d7` |
| 3 | **主体移除不回收授权**。`deleteBot` 删房间/会话/沙箱 ACE，但不碰 grant → 删掉同名重建会继承旧授权 | `deleteBot` 撤销它的全部授权（`revokedBy: 'user'`，自动补登记不会发回来）；子授权两轮分开标父链失效 | `202f0d7` |
| 4 | **两个清理函数有实现、零调用**：`sweepLeases()`（僵住的租约）、`pruneScreenshots()`（§5.5 的保留期） | `server-main` 起 60 秒 housekeeping（`unref`，不阻止退出），收工时清掉 | `202f0d7` |
| 5 | **objects alternates 从来没被解析**（`grep alternates src/` 零命中）→ "这个仓库能读到别处的全部对象"完全看不见 | `readAlternates()` 登记绝对/相对路径，挂进 `resolveRepoLayout()` 返回 | `25b9092` |
| 6 | **首启页永远不会弹**：拿"有没有未撤销授权"判首次，但 `server-main` 每次启动都给每个 bot 补发 `legacy-policy` 迁移授权 → 任何真机器上都算"已配过" | 首次只认**人类来源**（`user` / `saved-rule`）；迁移授权单独计数并在第 2 步点名"它不会自动收窄" | `0fc8c97` |

**这六条的共同点**：都不报错。规格写的是"必须做 X"，代码里写的是"X 的机制都有了"，
中间那一根线没人接 —— 而**没有测试守着的接线，一定会断**。
所以每条修完都配了测试，而且优先守"接线"本身
（`policy-hook 真的传了 mode` 这种），不是只守"纯函数算得对"。

---

## 一、§5 Computer use

| 条款 | 状态 | 实际 / 差距 | 怎么核的 |
|---|---|---|---|
| §5.1 动作代理独立校验，不接受任意 Bot 直接调用低层输入 | ✅ | `policy-hook.js` 在执行边界逐次过网关；`desktop_input` 必须持租约 | 读 `policy-hook.js:165-195` |
| §5.2 同一桌面只有一个输入租约 | ✅ | `desktop-lease.js` 24 项测试 | `tests/desktop-lease.mjs` |
| §5.2 租约属于任务，不属于进程 | ✅ | `acquire()` 必填 `taskId` + `botId` | 同上 |
| §5.2 租约到期 / 心跳 / 世代号 | ✅ | TTL 60s、心跳 20s、epoch 每次转让 +1 | 同上 |
| §5.2 每次输入前检查取消状态、会话、目标窗口 | ✅ `9967d82` | 调用方传 `expectWindow`，执行前核对前台窗口标题；发完之后再核一次，变了返回 `targetKept=false` 并明确警告 | `tests/desktop-input.mjs`（target_changed / targetKept 三项） |
| §5.2 高风险动作「观察—确认—重新校验目标—执行—核对结果」 | 🟨 | 观察 ✅、重新校验目标 ✅（`expectWindow` + 发后 `targetKept`）、核对结果 ✅（光标复核）；**只缺"确认"** —— 桌面输入不走 `confirm.js`，现在靠租约当同意 | `tests/desktop-input.mjs` |
| §5.2 用户接管立即吊销并丢弃未执行输入 | ✅ | `watch()` → `revoke()`；抖动抑制 2 次 | `tests/desktop-takeover.mjs` 21 项 |
| §5.2 按键释放 / 拖拽中断 / 超时恢复纳入验收 | 🟨 | 拖拽**刻意不做**（明确拒绝）；按键释放有（down/up 成对发）；超时恢复：`server-main` 的 60 秒 housekeeping 调 `sweepLeases()`（已接，`202f0d7`）。**差的只剩拖拽的验收用例** | `tests/reclamation.mjs` + `grep sweepLeases server-main.js` |
| §5.4 多屏/缩放：坐标与显示器绑定 | 🟨 | 屏幕矩形每次重探，屏幕外坐标拒绝；**但坐标本身不带"哪个显示器/哪次布局"的标记**，两次动作之间布局变了不会被发现 | `desktop-input.js` `planInput` |
| §5.4 锁屏/断开：暂停输入并释放租约 | ✅ | `OpenInputDesktop` 失败 → `no_session` + 自动 revoke | `tests/desktop-input.mjs` |
| §5.5 审计记录授权引用、发起者、实际执行角色、目标摘要、结果 | ✅ `9967d82` | `policy-hook` 把放行的那条 grantId 记进 `grant-context`（5 分钟过期、动作必须对得上），桌面执行时读出来落审计；记不出就不记，不猜 | `tests/grant-context.mjs` 6 项 + `desktop-input.mjs` 的审计用例 |
| §5.5 截图最小化取景 / 保留期 | ✅ | 默认只截目标窗口；`server-main` 的 60 秒 housekeeping 调 `pruneScreenshots()` | `tests/reclamation.mjs` |
| **§5.6 三档 GUI 执行（T0 程序化 / T1 独立桌面 / T2 共享）** | 🟨 新增 | `desktop-island.js`（纯逻辑）+ `desktop-island-win.js`（每岛一个常驻 island server）+ 三个主控专属工具。实测：岛上的窗口用户看不到、两边光标各归各、岛上发 `SendInput` 被拒（err=5）、跨桌面取帧与 `PostMessage`/`WM_CHAR` 驱动全通。**差距**：只对经典 Win32 应用可靠；macOS 无等价 API（如实报 `not_platform`）；同桌面那档（T2）仍没接「确认」环节（见上两行） | `tests/desktop-island.mjs` 28 项、`tests/desktop-island-win.mjs` 9 项、`tests/desktop-island-tools.mjs` 8 项；`docs/WINDOWS-HIDDEN-DESKTOP.md` |
| §5.6-1 截到黑帧必须报失败 | ✅ | `captureVerdict()`：`darkRatio > 0.98` 或尺寸过小 → `blank_frame`，并**删掉那张图**（留着迟早被当证据） | 同上；实测确实出现过一次全黑 |
| §5.6 island 对每个 Bot 开放（按部门一张） | ✅ `f6bdbf1` 后 | 工具进 `buildCommonTools`（成员也有）；岛名 `island-dept-<roomId>`；同岛串行、跨部门隔离；`desktop.input` 仍不从迁移继承 | `tests/capabilities.mjs`、`tests/desktop-island-tools.mjs` |
| §5.6-2 island 不是安全边界 | ✅ 已声明 | 规格、工具说明、`ISLAND_LIMITS` 三处都写了；授权判定没因它放宽一条 | grep `ISLAND_LIMITS` |
| §5.6-4 起应用等于执行命令 | ✅ | `desktop_island_launch` → `cmd.exec`，且只允许 `ISLAND_APPS` 里的可执行体、参数不得含 shell 元字符 | `tests/desktop-island.mjs`、`tests/capabilities.mjs` |

---

## 二、§6 授权模型与生命周期

| 条款 | 状态 | 实际 / 差距 | 怎么核的 |
|---|---|---|---|
| §6.1 服务端生成标识 | ✅ | `grants.js` `normalizeGrant` | `tests/grants.mjs` 43 项 |
| §6.1 用户批准来源（只有 user / savedRule 能建根） | ✅ | `SOURCE` 封闭集合 + 测试 | 同上 |
| §6.1 主体（角色/Bot/实例） | ✅ | `subject: {botId, role, instanceId}` | 同上 |
| §6.1 任务 / 资源范围 / 动作集合 | ✅ | `taskId` / `resources[]` / `actions[]` | 同上 |
| §6.1 参数约束 | ✅ | `checkConstraints` 支持 deny / allow / maxBytes 三种；`tests/grants.mjs:191` 有专门用例 | 读 `grants.js:362-388` + `tests/grants.mjs:191` |
| §6.1 风险等级 | ✅ | 从 `capabilities.js` 派生（`riskOf`） | `tests/capabilities.mjs` |
| §6.1 **执行模式** | ✅ `406fb89` | `exec-mode.js` 判档 → `session-factory` 算一次 → `policy-hook` 的 `mode` 参数传进网关；一致性检查第 7 项静态守着这一根线 | `check-consistency.mjs` 第 7 项 |
| §6.1 有效期 / 策略修订号 / 使用次数 / 可否子授权 | ✅ | `expiresAt` / `policyRevision` / `maxUses` / `canDelegate` | `tests/grants.mjs` |
| §6.1 撤销状态 | ✅ | `revokedAt` / `revokedBy`（user/policy/parent 三态） | 同上 |
| §6.1 子授权只能收窄 | ✅ | `deriveGrant` 逐项比；**执行 Bot 默认不能转授**（`canDelegate` 强制 false） | 同上 |
| §6.2 分能力规则（文件/命令/GUI/Git/网络/凭据） | 🟨 | 五类都接网关了；**GUI 那一行的「删除、发送、付款、提权仍需确认」没实现**（桌面输入不走 `confirm.js`） | 读 `capabilities.js` + `confirm.js` |
| §6.3 级联回收（七触发点） | 🟨 六条已接通 | 已接：父链撤销、策略变更、任务取消撤租约、三终态兜底释放、删 bot 回收授权、截图保留期、**任务终态回收临时授权**（`a9ba2ca`）、**任务终态回收后台进程**（`2ea879f`）。**还差**：解绑工具不回收该工具授权、项目变更不重校 | `tests/reclamation.mjs`、`task-grant-reclaim.mjs` 9 项、`shells.mjs` 12 项 |
| §6.3 后台任务记录主体和资源世代，不能通过 `write_stdin` 续接越过撤销 | ✅ | `write_stdin` 走同一套策略；`tests/shell-bypass-regress.mjs` 守着 | 该测试文件 |

---

## 三、§7 Git

| 条款 | 状态 | 实际 / 差距 | 怎么核的 |
|---|---|---|---|
| §7.1 G0 普通读取（检查 external diff / textconv / pager） | ✅ | `--no-pager` + `--no-ext-diff` + `--no-textconv` + `-c core.pager=cat` | `git-ops.js:65-73, 349-353` |
| §7.1 G1 普通开发（hooks 会跑，策略要评估，记录） | ✅ | hooks 照跑、跳过是禁止的、跑过哪些记进返回值与审计 | `git-ops.js:33-37`, `listActiveHooks` → `git-tools.js:293` |
| §7.1 G2 push（确认后执行） | ✅ | 手机强确认 + 目标摘要绑定 | `tests/git-push-flow.mjs` 10 项 |
| §7.1 G3 破坏性操作 | ⛔ | 刻意不给（`REFUSED_OPERATIONS` 里根本没有） | `git-ops.js` |
| §7.2 三种工作区（同树/worktree/独立 clone） | 🟨 | 同树 ✅（`worktree` 字段能认）；**独立 clone 没有独立入口**（靠用户自己 clone 到别的路径）；**同一工作树的写租约没有** | grep `worktree` in git-tools |
| §7.3 解析 `.git` 指针 / gitdir / commondir | ✅ | `resolveRepoLayout` 三种情况都处理，含 Windows 正反斜杠归一化 | `git-ops.js:228-290` |
| §7.3 objects alternates | ✅ | `readAlternates()` 登记绝对/相对路径，挂进 `resolveRepoLayout()` 返回 | `tests/git-ops.mjs` 3 项 |
| §7.3 所有目标必须属于授予的信任域，否则拒绝并提出授权差异 | ✅ `8910ddb` | `repo-trust.js`：repo/gitdir/commondir/alternates 逐条核对，越界就整体拒绝并点名是哪一条；判定放在 `runGit` 里（所有 git 操作的共同入口） | `tests/repo-trust.mjs` 11 项 |
| §7.3 同一公共目录的 Git 写入按公共目录标识协调 | ✅ `6974fc3` | `repo-lock.js`：按 commonDir 归一化加写锁，只锁 mutates 的操作，同任务重入放行，拿不到就拒绝（不排队）；三种返回路径都放锁 | `tests/repo-lock.mjs` 10 项 |
| §7.3 尊重原生锁，禁止见锁就删 | ✅ | 遇到 `index.lock` 只翻译成一句人话并**明确禁止用户手动删锁**（`git-ops.js:452`）；我们自己从不删锁 | 读 `git-ops.js:452-455` |
| §7.3 worktree 删除/移动/清理必须明确确认 | ⛔ | 那些操作在 G3 里，没有入口 | — |
| §14.3 Git 兼容性证据（PowerShell git.exe / Git Bash / macOS 分列） | ⬜ | 只走 `spawnCommand` 统一路径；**没有"三种方式分别验证"的记录** | grep `powershell.*git` |

---

## 四、§8 执行模式

| 条款 | 状态 | 实际 | 差距 |
|---|---|---|---|
| 三种模式定义（host / project / isolated） | ✅ | `MODE` 常量 + `ALL_MODES` + 迁移授权按主 Bot / 其他分派 | — |
| 模式在判定时被真的使用 | ✅ | `exec-mode.js` 判档 → `session-factory` 算一次 → `policy-hook` 传给网关；一致性检查第 7 项守着 | `tests/exec-mode.mjs` 11 项 |
| 模式不能自动降级 | ✅ `406fb89` | `exec-mode.js` 就是"当前模式"的判定：它在会话建立时算一次实际档位（沙箱化=isolated / 主 Bot=host / 其余=project），网关按它过滤授权 —— **没有降级路径**，判成什么就是什么，不够用就报拒绝 | `tests/exec-mode.mjs` 17 项 |
| 「主 Bot 可信宿主模式，OS 实际能力须明示」 | 🟨 | 文档写了（`docs/WINDOWS.md`/`MACOS.md`）；**界面上没有明示这个能力边界** | — |

---

## 五、§9 高风险确认与提示注入

| 条款 | 状态 | 实际 / 差距 |
|---|---|---|
| 删除 / 对外发送 / 付款 / 提权 / 破坏性 Git / 扩范围必须真实用户确认 | ✅ | `confirm.js` 按 `irreversible` 判定；不可撤销必须走上位通道（`device`） |
| 负责人不能代替用户完成这些确认 | ✅ | `confirm.js` 的 `channelSuffices`：本机通道只放行可恢复动作 |
| 确认绑定对象/内容/差异/金额/目的地/有效期/策略版本 | 🟨 | 目标摘要 + 有效期 + 一次一用 + 策略版本都有；**"内容/差异"只有 `send_image` 这种把文件内容哈希进摘要的才算**，其他是入参哈希 |
| 目标变化则重新确认 | ✅ | `checkConfirmation` 重算摘要 |
| 确认 UI 真实性不能假设 nonce（同机可自动化 UI） | ✅ | 通道分级：本机 = 弱确认，只放行可恢复；`device` = 强确认 |
| 「能力做不到时不得提供相应强保证」 | ✅ | 没有配对设备时，不可撤销动作直接拒绝并说明 |

**已知缺口**：桌面输入（`critical` / `irreversible`）**不走 `confirm.js`** ——
它靠的是租约 + 接管检测。这可以被论证成"另一种强确认"（用户随时可以物理接管），
但规格 §6.2 的 GUI 那一行明确要求「删除、发送、付款、提权等动作仍需用户确认」。
→ **需要产品决策**：桌面输入里的"点击"算不算需要确认的动作。

---

## 六、§10 交接与失败升级

| 条款 | 状态 | 实际 / 差距 |
|---|---|---|
| 统一交接字段（目标引用 / 父任务 / 主体 / 授权引用 / 资源边界 / 允许禁止动作 / 执行模式 / 预期产物 / 验收 / 期限 / 升级对象 / 脱敏） | 🟨 | `task-plan-tool.js` + `task-context.js` 覆盖了大部分；**「执行模式」和「脱敏要求」不在交接单里** |
| 接收方核对范围并确认接收后才执行 | 🟨 | 有受管执行与 `accept_task`；**没有"核对范围"这一步**（直接派） |
| 接收回执不是新增授权 | ✅ | 回执只写事实，不产生 grant |
| 统一回报（完成/部分/阻断/取消中/结果未知 + 哪些静态哪些实机） | 🟨 | `task-report.js` 有 5 类状态；**"哪些是静态确认、哪些已实机"这个区分没有** |
| 升级链（执行 Bot → 负责人 → 主 Bot → 用户） | ✅ | `escalate()` + `prefer: 'chief'` |
| 升级不自动扩大子授权 | ✅ | 升级只是消息，不改 grant |

---

## 七、§11 增量迁移

### P0

| 项 | 状态 |
|---|---|
| 所有入口逐次强制核对有效授权及完整父链撤销 | ✅ |
| 模板 / 覆盖 / 有效授权 / 执行记录分离 | ✅ |
| 任务授权 + 级联撤销 + 桌面单写租约 + 用户接管 | ✅（级联只做了父链与策略两条，见 §6.3） |
| 保留隔离能力，不全局删沙箱 | ✅ |
| 隔离旧规则与新策略版本 | ✅ |
| **可验收最小闭环**（主 Bot 观察/操作普通应用、负责人管一个项目、执行 Bot 改并测、用户确认后交付） | 🟨 **部分**：前三段有；"用户确认后按范围交付"这一段没有端到端验证 |

### P1

| 项 | 状态 |
|---|---|
| 普通仓库 / worktree / 独立 clone 三条路径与元数据授权图 | 🟨 前两条部分，第三条与授权图没有 |
| status/diff/add/commit + 确认后 push/merge | 🟨 push ✅，merge ⛔ |
| Win/mac 分别完成 computer use 与开发闭环 | 🟨 Win 部分（锁屏/多屏未实测）；macOS 空壳 |
| 审计 / 崩溃恢复 / 授权对账 / 共享元数据并发 / 有限缓存 | 🟨 审计与崩溃恢复有；**授权对账没有**；共享元数据并发没有；缓存没有 |

### P2

| 项 | 状态 |
|---|---|
| 公平排队 / 任务优先级 | ⬜ |
| 截图增量 / 输出分页 / 证据外置 | ⬜（截图清理甚至没接上） |
| 模板权限差异预览 | ⬜ |
| 审计检索与恢复体验 | 🟨 `/api/grant-audit` 只有"列表 + 只看被拒"，没有条件筛选/恢复 |
| 内置组件宽松许可证准入 + 依赖与打包清单核对 | 🟨 `5edbde2` | 清单有了；打包清单（安装器里实际带了哪些）还没核对 | `docs/LICENSES.md` |

---

## 八、§12 验收矩阵

`docs/acceptance-matrix.md` 已逐行标注。**14 行里 0 行能整组标通过**，
实机项还缺 6 个：手机强确认、实机 push、锁屏、多屏、用户接管端到端、macOS 全列。

## 九、§13 模板与首次授权

| 条款 | 状态 |
|---|---|
| 四层配置（模板默认 / 用户覆盖 / 运行期授权 / 执行记录）分离 | ✅ `overrides.js` + `grants.js` |
| 模板不得签发授权 | ✅ `tests/template-grants.mjs` 4 项 |
| 覆盖值不得突破有效授权上限 | ✅ `checkOverrideBounds` |
| 冲突需明示 | ✅ `diffOnUpgrade` 出 `conflicts[]` |
| **§13.2 首次授权流程 5 步** | 🟨 五步全通（第⑤步已闭环 `a9ba2ca`）。`server/src/onboarding.js`（纯逻辑，55 项测试）+ `GET /api/onboarding` + `POST /api/onboarding/apply`（defense 档 + policy nonce + 审计）+ App 首启页 `widgets/permission_setup_gate.dart`（12 项组件测试）。逐条：①全机视野 / 真实系统权限（探针**真探**，失败按实际结果报）✅ ②项目 + 普通 Git 范围（选完**真的建授权根**，动作清单不手写）✅ ③任务级最小权限：只讲清楚，**分配留在派活时** —— 首启页做下拉框会把 `host` 摆上桌 🟨 ④有效权限 / 逐次确认 / 硬隔离边界汇总（`perCallConfirm` 把"不受 policy 影响"的两条单列）✅ ⑤收尾：任务终态按 `taskId` 回收临时授权（`revokedBy: 'task'`，项目级一条不碰），`planWrapUp.cascadeImplemented` 已翻成 true ✅ |

## 十、§14 工具链与许可证

| 条款 | 状态 |
|---|---|
| 优先系统原生接口 | ✅ Windows 走 Win32；macOS 文档要求走原生 |
| 第三方封装须查源码/依赖/产物/许可证 | ✅ `5edbde2` | `scripts/check-licenses.mjs` 从真的装了什么生成 `docs/LICENSES.md`（200 个组件）；GPL/AGPL/未声明一律红 | 跑一次脚本 |
| 内置组件许可证准入 + 传递依赖核对 + 打包清单 | 🟨 `5edbde2` | 许可证清单有了（含传递依赖）；**打包清单**（哪些真正随包发出去）还没单独列 | `docs/LICENSES.md` |
| 调用用户已有工具不因准入规则被禁 | ✅（`spawnCommand` 走 PATH） |
| 引入替代 Git 库需核实功能/许可/传递依赖 | ⛔ 没引入，也不打算 |

## 十一、§16 未解决项

| 项 | 状态 |
|---|---|
| Win/mac 宿主代理、截图/输入权限、多屏、接管的 API 与兼容矩阵 | 🟨 Win 已实测大部分；macOS 空壳 |
| 各能力适配器不可绕过的调用链证据 | 🟨 有（`check-consistency.mjs` 六项 + 能力漂移检查） |
| linked worktree 精细授权与并发锁可行性 | 🟨 `6974fc3` | 写锁按 commonDir 协调已验证（10 项测试）；**精细到文件级的授权**还没做 |
| 第三方内置封装来源/许可/传递依赖 | ✅ `5edbde2` | 见 `docs/LICENSES.md`（按法律含义判 OR/AND 复合表达式） | 同上 |
| 历史代码按本稿重新验收 | 🟨 部分（本轮补了很多，但 `docs/PERMISSIONS-INVENTORY.md` 进度表仍停在旧版） |

---

## 十二、汇总：还差多少

### 按状态

| 状态 | 条数 | 说明 |
|---|---|---|
| ✅ 完成 | 43 | 有代码 + 有测试 |
| 🟨 部分 | 22 | 有代码但覆盖不全，或只做了多重触发点里的一两个 |
| ⬜ 没做 | 13 | 规格明确要求、代码里没有 |
| ⛔ 产品决策 | 3 | 刻意不做：G3 破坏性 Git / merge-rebase / 替代 Git 库 |

### 按优先级（我建议的顺序）

**P0 · ~~规格写了但代码里没生效~~ → 已全部收口（见零）**

**P1 · 规格明确要、但整个模块没做**

1. §7.3 worktree **信任域判定**（登记有了，"必须属于授权域否则拒绝"还没有）
2. §6.3 剩下的回收点（解绑工具 / 项目变更 / 后台执行）
3. §13.2 第⑤步的**自动收割**（`planWrapUp` 已算出该收哪几条，缺任务收尾钩子）
4. §13.2 正文的**英文文案**（现在步骤正文由服务端返回整句中文；要本地化得先改成返回 `id`）
5. macOS 桌面输入（`docs/MACOS-DESKTOP-INPUT.md`，需实机）

**P2 · 补覆盖（不补会影响"这条到底能不能用"的判断）**

8. `constraints`（参数约束）的测试
9. `pruneScreenshots` / `sweepLeases` 接上定时器
10. `docs/PERMISSIONS-INVENTORY.md` 按 §11 三层重写
11. `scripts/check-spec-progress.mjs` + `check-style.mjs`（收束 spec 的 W1 里承诺过，没做）

**P3 · P2 效率类**

12. 公平排队 / 优先级 / 截图增量 / 输出分页 / 证据外置 / 模板差异预览 / 许可证清单

---

## 十三、这份表怎么维护

1. **只写核实过的东西。** 每条都要有「怎么核的」：grep 命令、文件名、测试名。
   写不出核实方法 = 没核，别写。
2. 状态变化时改这一行的状态，不要另开一份表（实测过：另开一份一定会过期）。
3. ⛔ 那 5 条不是欠账，是刻意的。改它们要先有产品决策，不是"顺手做了"。
4. 每完成一项，在 `docs/TODO.md` 勾掉并在本文档把状态改掉 —— 两份都改，
   否则又会出现"台账说做完了、代码里没有"。
