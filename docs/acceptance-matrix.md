# 验收矩阵（规格 §12 逐行对照）

> **状态图例**：`静态` = 代码里做了、有单测守着，但没在真机上验证过；
> `实机 ✓` = 在列出的环境上真的跑过，附证据；`实机 ✗` = 跑过但不通过（写明交还用户的条件）。
>
> 规格 §16.1 原话是「本稿没有任何当前实现通过结论」。所以这份文件**不给总体结论**：
> 只按行记录跑到了哪一步。任何一行没写"实机 ✓ + 证据"的，都不算通过。

## 怎么读这张表

| 列 | 含义 |
|---|---|
| 组 | 规格 §12 的十四个组，原样搬过来 |
| 状态 | `静态` / `实机 ✓` / `实机 ✗` / `未做` |
| 环境 | 实机那一行必须有：OS 版本 + 应用版本 |
| 证据 | 能复跑的**命令**或测试文件名，不是"我看过" |
| 交还条件 | 只在 `实机 ✗` 时填：什么情况下把控制权交还用户 |

**一行都没通过的组，用 `未做` 而不是留空** —— 留空会让人以为"可能做了"。

---

## 一、P0（交付前必须有两平台证据）

### 1. 电脑操作

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 打开应用、定位窗口、输入、保存任务文件 | 静态 | — | `server/tests/desktop-observe.mjs` 10 项（列窗口/截图）；`server/tests/desktop-input.mjs` 38 项（移动/点击/输入的规划与判定） |
| 移动到位、左键点击坐标正确 | 实机 ✓ | Windows 11 x64 / 2560x1440 / 125% / 2026-11-15 | `server/scripts/probes/desktop-input-click-target.ps1`：靶子窗口记录的 `MouseDown` 坐标与目标逐像素一致 |
| 中文 / emoji / `$` / 反引号 / 双引号输入 | 实机 ✓ | 同上 | `server/scripts/probes/desktop-input-paste-target.ps1`：靶子 TextBox 落盘内容与原文逐字相符，且原剪贴板已还原 |
| `type_text` 不会被当成 PowerShell 执行 | 实机 ✓ | 同上 | `server/scripts/probes/desktop-input-injection-probe.mjs`：输出 `MATCH true` / `INJECTION_HAPPENED false` |
| 锁屏后不盲点 | 静态 | — | `desktop-input-session.js` 用 `OpenInputDesktop` 判会话；失败 → `no_session` 且吊销租约。**未实机验证** |
| 多屏 / 混合缩放不盲点 | 静态 | — | 屏幕矩形取自 `SM_XVIRTUALSCREEN` 一族（天然支持负坐标），屏幕外坐标一律拒绝。**未实机验证** |

> ⚠ 组内仍有未实机项，所以这一组**不标通过**。

### 2. 桌面调度

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 两任务排队，单任务持有输入租约 | 静态 | — | `server/tests/desktop-lease.mjs` 21 项 |
| 旧租约 / 超时 / 取消 / 用户接管后输入全部被拒 | 静态 | — | 同上 + `desktop-input.mjs` 38 项（`stale_epoch` / `expired` / `revoked` / `yielded`） |
| 不发生串打（检测到用户输入就停） | 静态 | — | `desktop-takeover.mjs` 21 项；连续命中计数不会被探针抖动偷走 |
| 端到端：真机上用户接管 → 输入停下 | 未做 | — | 需实机：跑一个长动作时手动碰鼠标 |

> ⚠ 本机有个环境问题挡着实机验证：装着远程控制工具时 `GetLastInputInfo`
> 永远报"刚刚有输入"，接管检测会一直让开。`desktop_lease status` 会点名说出来
> （见 `docs/WINDOWS.md`「桌面输入」）。所以这一组的实机验证要换一台干净机器，
> 或者先关掉那个程序。

### 3. 分级委派

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 负责人下发限时任务、执行 Bot 交回证据 | 静态 | — | `server/tests/tasks.mjs` / `task-supervisor.mjs` / `role-tools.mjs` 11 项 |
| 子授权不能扩大资源 / 动作 / 期限 | 静态 | — | `server/tests/grants.mjs` 42 项（含父链、次数、有效期） |
| 跨实例句柄与标识不能复用权限 | 静态 | — | `grants.mjs` 的世代号用例；`session-signature.mjs` |

### 4. GUI 间接越权

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 下级借主 Bot 代办越界读取被拒 | 静态 | — | `server/tests/security-p0.mjs` 26 项 |
| 不能借终端 / 文件对话框 / 浏览器上传越过权限 | 静态 | — | `shell-bypass-regress.mjs`（`write_stdin` 绕过）、`opaqueScriptBlockReason`（`ego_browser` 在命令白名单下关闭） |
| 只换任务标识不能扩权 | 静态 | — | `grants.mjs` 的任务绑定用例 |

### 5. 用户确认

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 展示对象与副作用，批准后执行一次 | 静态 | — | `server/tests/confirm.mjs` 23 项 |
| 屏幕提示注入 / 伪群消息 / 参数变化 / 过期 / 重复请求不得复用确认 | 静态 | — | 同上（目标摘要绑定 + 通道分级 + 一次一用） |
| 手机通道的强确认在真机上有效 | 未做 | — | 需两台设备 |

### 9. push / merge

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 明确确认远端 / 引用 / 差异后执行 | 静态 | — | `server/tests/git-push-flow.mjs` 10 项 |
| 仅有网络授权不能 push | 静态 | — | `grants.mjs`（`git.push` 的 migration 是 `chief`，且需 `confirm`） |
| 强推 / 破坏性操作另确认 | 静态（刻意拒绝） | — | `git-ops.js` 的 `REFUSED_OPERATIONS`：根本没有对应能力，属产品决策 |
| 实机 push 一次 | 未做 | — | 需真远端 + 手机确认 |

### 10. 撤销与后台

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 撤销后停止新动作 | 静态 | — | `grants.mjs`（父链撤销 → 下游立刻失效） |
| `write_stdin` 不能续接旧权限 | 静态 | — | `shell-bypass-regress.mjs`（`write_stdin` 的绕过用例） |
| 旧后台句柄 / 缓存命中不能续接 | 静态 | — | `grants.mjs` 世代号用例 |
| 端到端：会话内撤销 → 下一次工具调用被拒 | 静态 | — | `grants.mjs` + `policy-hook` 的接线用例 |

### 11. 隔离任务

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 不可信构建在适合环境执行 | 静态 | — | `server/tests/sandbox.mjs` 39 项、`sandbox-win.mjs` 30 项 |
| 环境不可用时不回退宿主 | 静态 | — | `sandbox-win` 的 fail-closed 用例；`WINDOWS-SANDBOX.md` 有记录 |
| 仅隔离测试通过不算整个产品通过 | — | — | 这条是**结论纪律**，写在本文开头 |

### 12. 凭据与隐私

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 适配器使用指定凭据完成授权动作 | 静态 | — | `server/tests/secrets.mjs` / `secrets-regress.mjs` 21 项 |
| 凭据不入模型 / 日志 / 群聊 | 静态 | — | 同上 + `check-secrets.mjs`（CI 每次 push 都扫） |
| 截图与敏感工件无权成员不可见 | 静态 | — | `desktop-observe.mjs` 的落盘路径（`desktop-shots`，不进 workspace）；截图默认只截目标窗口 |

### 13. 模板安全

| 项 | 状态 | 环境 | 证据 |
|---|---|---|---|
| 导入角色后重新授权 | 静态 | — | `server/tests/template-grants.mjs` 4 项 |
| 携带旧 grant / 增加能力 / 扩大自定义范围不能扩大权限 | 静态 | — | 同上 + `overrides.mjs`（`checkOverrideBounds`） |
| 父链撤销立即阻止新动作 | 静态 | — | `grants.mjs` |

---

## 二、P1

| 组 | 状态 | 证据 / 下一步 |
|---|---|---|
| 普通 Git（status/diff/add/commit） | 静态 | `git-ops.mjs` 22 项 |
| worktree 授权图 | 未做 | 解析已做，授权图没有（待办见 GitHub Issues） |
| Git 并发（公共目录协调、锁冲突） | 未做 | — |
| 结果真实性（退出码 + 仓库状态 + 差异） | 静态 | `git-ops.mjs` 的退出码与状态断言 |

---

## 三、这张表本身怎么维护

1. **只写跑过的东西**。"静态"是有代码有测试，"实机 ✓"是附证据的。
2. 每次实机验证完成后：填环境、贴证据命令、改状态。**不要顺手把整组标通过** ——
   一组里只要还有一行没验，整组就不是通过。
3. `实机 ✗` 必须写「交还用户的条件」。写不出条件 = 还没想清楚失败策略。
4. 新增能力时，在对应组里加一行，状态先写 `未做`。
