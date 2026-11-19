# 真机验收清单（2026-11-19）

> **这份清单只做一件事**：把 `docs/acceptance-matrix.md` 和 `docs/WINDOWS.md` 里
> 还挂在 `静态` / `未做` 的那几行，用最小的操作量填成 `实机 ✓` 或 `实机 ✗`。
>
> 三条约定的执行纪律（跟这份清单一起定下的）：
> 1. **走真实装配层**：不在底层纯函数上打勾。脚本驱动的是
>    `desktop-input-session` / `createPolicyExtension` / `grant-gate` 这些真实接线；
>    手机确认那一步必须在真 App 上点，不接受“模拟通道”。
> 2. **非破坏性**：所有脚本用 `%TEMP%` 下的临时 `dataDir`，不碰你正在用的配置；
>    需要造数据的（Bot / 授权）用完即删，或者刻意建带 `__验收` 前缀的临时对象。
> 3. **一条对一行**：每条都写清「回填哪一行」，见文末表格。

先说结论式的顺序：**先跑 3 个脚本（合计约 1 分钟），再花 10 分钟做手机确认那项**。
中途唯一会打断你的是 #31（要锁屏十几秒）。

---

## 0. 前置

```bash
cd D:/pi-bot/server
node tests/all.mjs | tail -2        # 期望 157/157
```

- 关闭或至少知道：本机装了远程控制软件（`GameViewer` / UU 远程那一类）时，
  它会持续合成鼠标输入，接管检测会一直让开 —— `docs/WINDOWS.md`「环境噪声」一节有记账。
  验收"用户接管"那行必须换干净机器，其余行不受影响。
- 多屏那项：需要一块**不同缩放**的外接屏，只有一块屏时脚本会明确打印"没有拿到证据"。

---

## 1. `#31` 锁屏后不盲点（脚本 · 约 40 秒，含锁屏/解锁）

```bash
node scripts/probes/acceptance-lock-screen.mjs
```

按提示在 20 秒内 **Win+L** 锁屏，然后不用管，脚本自己继续；它会在锁屏状态下真的
发一次输入，再等你解锁。期望结尾三行：

```
LOCK_NO_SESSION true
LEASE_RELEASED_ON_LOCK true
REACQUIRE_AFTER_UNLOCK true
```

**失败时看什么**：如果打印 `✗ 20 秒内没检测到锁屏`，是脚本没等到会话断开（可能锁屏
被组策略/远程会话禁用）；如果打印 `锁屏状态下居然发出了输入`，那是**安全底线破了**，
把输出整段留下。

---

## 2. `#32` 多屏 / 混合缩放（脚本 · 约 10 秒）

```bash
node scripts/probes/acceptance-multiscreen.mjs
```

它枚举显示器（矩形 + 每块屏的 DPI + 工作区），把光标移到**每块屏的中心**读回核对，
再给一个屏外点确认被 `out_of_screen` 拒掉。

- 两块屏（不同缩放）→ 期望结尾 `MATCH true`，且中间打印
  `缩放混合：100% / 125% —— 混合缩放场景已覆盖。`
- 只有一块屏 → 打印 `⚠ 只有一块显示器 …… 没有拿到证据`。
  **这时不要把这一行标成实机 ✓**，保持 `静态`，等接了第二块屏再跑。

---

## 3. W6-2 · T1 独立桌面 vs T2 用户桌面（脚本 · 约 5 秒）

```bash
node scripts/probes/acceptance-island-vs-desktop.mjs
```

三段都走真实装配（临时 `dataDir`，不碰你的配置）：

1. **工具集**：成员 68 个工具、主控 72 个 —— 差的 4 个正是
   `desktop_observe` / `desktop_screenshot` / `desktop_input` / `desktop_lease`；
   而 `desktop_island_*` 成员都有（T1 该用的那张岛）。
2. **授权网关**：成员调 `desktop.observe` 这个**动作**是放行的（`migration: 'all'`，
   T1 共用它，属设计）；但成员调 `desktop.input` 直接 `action_not_covered`。
3. **执行边界**：用真实 `createPolicyExtension` 驱动一次 `tool_call` —— 成员调
   `desktop_observe` 被 `block`（`no_grant`），主控同一个调用 `allow`。

期望结尾：

```
T2_CHIEF_ONLY true
MEMBER_TOOLSET_CLEAN true
GATEWAY_BLOCKS_MEMBER true
HOOK_BLOCKS_MEMBER true
```

---

## 4. W6-1 · Jarvis 高危确认门禁（真 App + 手机 · 约 10 分钟）

这一项**没有脚本**：核心动作是"在手机上点确认"，任何脚本模拟都等于绕过验收目标。
脚本只能帮你查状态，命令在下面。

### 4.1 准备（不碰你现有的 Bot）

在 App 里新建一个临时 Bot，名字以 `__验收` 开头（例如 `__验收临时__`），
**不要**改任何现有 Bot / 知识库 / 全局策略。

### 4.2 让主 Bot 触发一次高危动作

在电脑端主控会话里发：

```
把刚建的「__验收临时__」这个 Bot 删掉
```

### 4.3 预期（这一步是验收的核心）

| 检查点 | 期望 |
|---|---|
| App 里出现确认卡片 | 卡片写明「删除 Bot」+ 目标名，且提示**需要在手机上确认** |
| 本机（桌面）批准 | **被拒**，理由指向"不可撤销动作要在已配对设备上确认" |
| 手机端能看到同一条确认 | 能看到，且能点确认 |
| 手机确认后 | 动作真的执行：那个临时 Bot 从花名册消失 |
| 同一条确认不能再批一次 | 第二次会被拒（一次一用） |

查状态用（`TOKEN` 换成 App「系统 → 连接」里的 API token，端口按实际）：

```bash
TOKEN=<你的 API token>
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/confirmations | head -c 800
```

### 4.4 如果失败了

- 卡片没出现 → 说明 `isJarvisApprovalCall` 没认出来，把主控那条回复整段留下
- 本机批准居然成功了 → **安全底线破了**，立刻停下并把 `relevant audit` 贴出来
- 手机确认后没执行 → 看 `GET /api/grant-audit` 里那条 `deny` 的 `code`

### 4.5 收尾

把临时 Bot 删干净（如果第 4.3 步没删掉）；确认没有留下多余的授权
（`GET /api/grants` 里不该有 `__验收临时__` 相关的条目）。

---

## 5. 回填对照表

| # | 验收项 | `docs/acceptance-matrix.md` 的行 | 期望关键字 |
|---|---|---|---|
| 1 | 锁屏后不盲点 | §1「电脑操作」→ `锁屏后不盲点` | `LOCK_NO_SESSION true` |
| 2 | 多屏 / 混合缩放 | §1「电脑操作」→ `多屏 / 混合缩放不盲点` | `MATCH true` + `缩放混合` |
| 3 | T1/T2 隔离 | §4「GUI 间接越权」→ `T1 独立桌面不能越界操控 T2 用户桌面` | `HOOK_BLOCKS_MEMBER true` |
| 4 | 手机强确认 | §5「用户确认」→ `手机通道的强确认在真机上有效` | 卡片 + 本机批准被拒 |

回填时按 `acceptance-matrix.md` 开头的规矩：填**环境**（OS 版本 / 屏幕 / 缩放到百分比）、
贴**证据命令**、改**状态**；一条没验就不要顺手把整组标通过。

`docs/WINDOWS.md`「桌面输入」表里还剩两行 `⚠ 静态实现，未实测`：

| 行 | 用哪条脚本 |
|---|---|
| 锁屏 / 断开会话 | 本清单第 1 条（`acceptance-lock-screen.mjs`） |
| 多屏 | 本清单第 2 条（`acceptance-multiscreen.mjs`） |

---

## 6. 还不能自动化的部分（写清楚，避免误以为漏了）

| 项 | 为什么还不能自动化 |
|---|---|
| `§2 桌面调度`「端到端：真机上用户接管 → 输入停下」 | 需要人在拖拽/输入过程中动手；且本机有合成输入源时判据不可信（见 §0） |
| `§9 push/merge`「实机 push 一次」 | 需要真远端 + 手机确认；`git-push-flow.mjs` 已经覆盖了确认链路，缺的是真手机那一下 |
| `#30 macOS 桌面输入` | 需要 Mac 硬件 |
