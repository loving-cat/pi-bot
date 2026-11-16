# 待办总账

> 一页看完所有欠账。每条都写清「阻塞谁 / 下一步最小动作」。
> 更新规则：做完一项就把那一行删掉或标 ✅，不要留着手工维护的"进度表"
> （那种表一定会过期 —— 实测过一次，停在 9 行，后面 12 个提交全没入账）。
>
> **逐条对照规格的总表在 [`SPEC-COVERAGE.md`](SPEC-COVERAGE.md)** ——
> 那份按 §1～§18 一条条核实过（带"怎么核的"），本文件只放"下一步做什么"。
> **下次开工先看 [`NEXT-SESSION.md`](NEXT-SESSION.md)** —— 一页写清"先干什么、为什么、怎么开工"。

**状态图例**：⬜ 未开始 · 🟨 进行中 · ✅ 已完成（附 commit）

---

## 一、权限层 P0（规格 `docs/spec-permissions-v1.0.1.md` §11）

| 项 | 状态 | 阻塞谁 | 下一步最小动作 |
|---|---|---|---|
| 授权模型 + 网关 + 父链撤销 | ✅ `b130fc6` | — | — |
| HTTP 危险路由接网关 + nonce + 审计 | ✅ `df549c5` | — | — |
| 桌面观察（P0-3a） | ✅ `c45eb7c` | — | — |
| Git G0/G1 + G2 push（要手机确认） | ✅ `f73f3f9` `bcc8fce` | — | — |
| 确认框架 P0-4（手机通道） | ✅ `cdb9f5a` | — | — |
| 模板不得签发授权 | ✅ `7f63583` | — | — |
| 授权可见 + 可收回 + 判定记录 | ✅ `37ed25b` `7766a11` | — | — |
| 能力清单单一来源（W0） | ✅ `6c02f1c` | — | — |
| 桌面输入租约状态机（W2a） | ✅ `9068d16` | — | — |
| 用户接管检测（W2b） | ✅ `296a744` | — | — |
| 用户自定义覆盖层（W3） | ✅ `fb3fe31` | — | — |
| 桌面输入 Windows 实现（W2c） | ✅ `d3b77fc` | — | 实机记录见 `docs/WINDOWS.md`「桌面输入」；锁屏/多屏仍是 ⚠ 未实测 |
| **桌面输入 macOS 实现**（W2d） | 🟨 空壳就位 `docs/MACOS-DESKTOP-INPUT.md` | 缺实机 | 六个函数已留好实现槽位 + 13 项测试守着"不许谎报成功"；照文档填 `desktop-input-mac.js`，先验三件事（探针可用性 / 授权被拒行为 / 坐标单位） |
| desktop_input 工具 + 接网关（W2e） | ✅ `eaca498` | — | — |
| 锁屏 / 断开会话的实机验证 | ⬜ | 静态实现已有（`OpenInputDesktop` 失败 → 交还并吊销） | 锁屏后调一次 `desktop_lease status` + `desktop_input`，把结果填进 `docs/WINDOWS.md` 那张表 |
| 多屏 / 混合缩放的实机验证 | ⬜ | 屏幕矩形已用虚拟屏 API（天然支持负坐标） | 接一块不同缩放的屏，验证窗口坐标 → 点击位置对得上 |
| 拖拽支持 | ⬜ | 刻意不做（要"按下—移动—抬起"持续持租约 + 中断恢复，规格 §5.2 要求纳入验收） | 先写中断恢复的验收用例，再实现 |
| **本机有程序持续合成输入** | ⚠ 已知环境问题 | 接管检测会一直判"有人在动"，第一次输入发不出去 | `desktop_lease status` 现在会点名说出来；根治要么关掉那个程序，要么由你决定"信任这台桌面"（产品决策） |

### 规格写了但代码里没生效 —— **已全部收口**

| 项 | 状态 | 怎么修的 |
|---|---|---|
| 执行模式从没传进网关 | ✅ `406fb89` | `exec-mode.js` 判档 → `session-factory` 算一次 → `policy-hook` 传给网关；一致性检查加第 7 项 |
| 桌面租约不随任务结束回收 | ✅ `202f0d7` | `task-runtime.onCancel` 先撤租约再落状态；`reportTerminal` 三条终态兜底 |
| 主体移除不回收授权 | ✅ `202f0d7` | `deleteBot` 撤销它的 grant（`revokedBy:'user'`，自动补登记不会发回来） |
| 截图清理 / 租约 sweep 没接上 | ✅ `202f0d7` | `server-main` 60 秒 housekeeping（`unref`） |
| objects alternates 从没解析 | ✅ `25b9092` | `readAlternates()` → `resolveRepoLayout()` 返回里带 `alternates[]` |

## 二、权限层 P1 / P2

| 项 | 状态 | 阻塞谁 | 下一步最小动作 |
|---|---|---|---|
| 独立桌面（§5.6 T1） | ✅ `12bf259` `2db401a` | 只对经典 Win32 应用可靠；macOS 无等价 API | 把「T2 共享桌面」也接上 §5.2 的确认环节；补 `targetWindow` 复核（同一窗口在两帧之间被换掉） |
| worktree 授权图（登记公共元数据并限制） | ⬜ | §7.3；解析已做（`gitdir/commondir/realpath`） | 先写"哪些路径必须属于授权域"的纯判定 + 测试 |
| **§13.2 首次授权流程** | 🟨 `04bb8df` `808a6a7` `0fc8c97` `e413d62` `946f622` | 5 步里四步到位：`onboarding.js` 纯逻辑 + `GET /api/onboarding`（桌面权限真探）+ `POST /api/onboarding/apply`（defense + nonce，真的建授权根）+ App 首启页 | 第⑤步的**跑完自动收割**：`planWrapUp` 已算好，缺任务终态钩子（现在 `cascadeImplemented: false`）。另外正文还是服务端中文整句，英文界面要本地化得先返回 `id` |
| **§14 第三方组件许可证清单** | ⬜ | §14.2；仓库只有根 `LICENSE` | `npm ls --all` 导出 + 许可证列，写进 `docs/LICENSES.md` |
| `scripts/check-spec-progress.mjs` / `check-style.mjs` | ⬜ | 收束 spec 的 W1 承诺过，没做 | 前者校验台账里的 commit 真在 `git log`；后者校验 §1 三条机器可判断的风格约定 |
| §12 验收矩阵 14 行（Win + macOS） | 🟨 P0 已逐行标证据，实机项仍缺 | §17 交付结论；矩阵在 `docs/acceptance-matrix.md` | 补实机的六项：手机强确认、实机 push、锁屏、多屏、用户接管端到端、macOS 全列 |
| 验收矩阵单独成档 | ✅ `docs/acceptance-matrix.md` | — | 每行带静态/实机标记，`实机 ✗` 要写交还条件 |
| 审计检索与恢复体验 | ⬜ | P2 | 判定接口已有（`/api/grant-audit`），缺按条件筛 + 恢复 |
| 公平排队 / 任务优先级 | ⬜ | P2 | — |
| 截图增量 / 输出分页 / 证据外置 | ⬜ | P2 | — |
| 模板权限差异预览 | ⬜ | P2 | — |
| 内置组件许可证清单 | ⬜ | P2 §14 | — |
| **Git G2/G3**（merge/rebase/force/reset/clean） | ⛔ 产品决策 | 需要你定"什么算不可撤销" | 不是欠账，是刻意的 `REFUSED_OPERATIONS` |

## 三、TaskRun 引擎（`docs/TASK-RUN-PROTOCOL.md`）

| 项 | 状态 | 阻塞谁 | 下一步最小动作 |
|---|---|---|---|
| 引擎代码 | 🟨 2900 行（`task-supervisor` 1564 行） | — | — |
| **默认关闭**（`PI_BOT_TASK_INTAKE`） | ⬜ | 任务看板 W5 无法显示活数据 | W4a 已完成（`docs/taskrun-gaps.md`）：14691 行里只有 23% 被测试引用，19 条协议条款零覆盖 |
| 核心路径测试偏薄 | ⬜ | 开启前的前置门 | 按 `docs/taskrun-gaps.md` P0 四条补：命令重放幂等 / 预算耗尽 / 撤销不续命 / 未知副作用不重放（约 36 项） |
| 端到端（用户加任务 → 真派出去执行） | ⬜ | 开启验收 | `task-intake-e2e.mjs`（假模型替身） |

## 四、新功能

| 项 | 状态 | 阻塞谁 | 下一步最小动作 |
|---|---|---|---|
| **任务看板**（四列 + 头像 chip + 等你处理） | ⬜ | 依赖 TaskRun 引擎开启（否则显示空数据） | 先做 `task_kanban_model.dart` 纯逻辑 + 测试（11 状态 → 4 列） |
| 旧 39 条 TaskItem 迁成 TaskRun 历史 | ⬜ | 看板 Done 列 | 36 条里大部分是对话片段，迁移时标 `legacy-note` 并默认折叠 |

## 四之半、一致性自查（已进 CI）

| 脚本 | 守什么 |
|---|---|
| `server/scripts/check-capability-drift.mjs` | 加能力只该改 capabilities.js；派生层出现手写工具名就红 |
| `server/scripts/check-consistency.mjs` | 六项：只读漂移 / allow 档覆盖 / 新主体 / 审计完整 / 窄范围 fail-closed / 空范围不限 |

改完网关或能力清单，本地跑这两条就知道有没有退化，不用等 CI。

## 五、记录类欠账

| 项 | 状态 | 下一步最小动作 |
|---|---|---|
| 权限规格入仓 | ✅ `d8dfaa9` | — |

| `docs/PERMISSIONS-INVENTORY.md` 进度表重写 | ⬜ | 按 §11 三层重列，本文件即来源 |

---

## 已完成但不在这张表里的

- 主 Bot / 负责人能自己动手（先派后干）—— `c20a6b6`
- 收权不发 nonce、不写管理审计 —— `544bf8f`
- 授权判定记录可见 + 只看被拒 —— `313249f` `7766a11`
- 迁移授权补齐（桌面观察 / push / 世代 / 运行期新 bot）—— `c8f33f3` `c5da8dc`
- 不限范围授权不再误拒带目标的动作 —— `c859209`
