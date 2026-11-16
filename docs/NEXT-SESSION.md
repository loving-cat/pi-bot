# 明天从哪继续（交接便条）

> 写于 2026-11-16 上午。**server 124/124 个测试文件全绿**、app 776 项全绿、
> 七项一致性检查 + 能力清单（16 动作 / 54 工具）+ 敏感信息扫描全过。
> main 已推送，工作区干净。
>
> 这份便条只回答一件事：**下次打开这个仓库，先干什么。**
> 完整账目在 `docs/SPEC-COVERAGE.md`（逐条对着规格核实过）和 `docs/TODO.md`。

---

## 一句话

昨晚把 §13.2 首次授权流程做到 4/5 步；今天上午补了**§5.6 三档 GUI 执行**并把
**独立桌面（T1）从探测做到了工具层** —— 现在 agent 能在一个用户看不见的桌面上
开应用、截图、点按钮、打字，**完全不碰用户的鼠标**。

---

## 建议顺序

| # | 做什么 | 为什么是它 | 大概 |
|---|---|---|---|
| **1** | **T2 共享桌面补上 §5.2 的确认环节** | 现在 `desktop_input` 能直接点，缺"观察—确认—重新校验目标—执行—核对"里的"确认"和"重新校验目标窗口"两段（`SPEC-COVERAGE` §5.2 两行标 🟨）。岛上的活已经不需要它了，但真需要动用户桌面时它是唯一的闸 | 半天 |
| 2 | §13.2 第⑤步：跑完自动回收 | `planWrapUp` 已算好该收哪几条，缺任务终态钩子（`cascadeImplemented: false`） | 半天 |
| 3 | §13.2 正文英文文案 | 步骤正文由服务端返回整句中文；本地化得先改成返回 `id` | 半天 |
| 4 | §7.3 worktree 信任域判定 | 登记全了（gitdir/commondir/alternates），差"必须属于授权域否则拒绝" | 2 小时 |
| 5 | §6.3 剩余回收点 | 解绑工具不回收 / 项目变更不重校 / 后台执行靠手动 kill | 2 小时 |
| 6 | macOS 桌面：要么 VM 路线，要么继续如实 `not_platform` | 没有 `CreateDesktop` 等价 API；已如实报，别为了"一致"偷偷降级到动用户鼠标 | 需实机 |
| 7 | TaskRun 继续补测 | 准入三模式 → 请求回执 → 产出验收，之后才能开 `PI_BOT_TASK_INTAKE` | 1 天+ |

---

## 今天上午做完的（§5.6 独立桌面，5 个提交）

| commit | 内容 |
|---|---|
| `c11ff4d` | 规格 §5.6（三档、五条硬要求）+ `docs/WINDOWS-HIDDEN-DESKTOP.md` + 可重跑探针（`server/tests/fixtures/island/`） |
| `9efe4ce` | `desktop-island.js` 纯逻辑 28 项：档位选择不静默降级、启动白名单、窗口消息计划、截帧判定 |
| `12bf259` | `desktop-island-win.js` + 端到端接线测试 9 项（真起岛、真取帧、真点、岛上 SendInput 被拒） |
| `2db401a` | 三个主控专属工具 + 工具层测试 8 项（收尾杀 pid、不留守孤儿） |
| 本次 | 空闲岛自动收（housekeeping）+ 台账同步 |

## 这轮踩到的坑（都写进了代码注释，值得记住）

1. **desktop 对象靠"最后一个打开的句柄"活着。** 每次调用起一个 powershell、
   用完关句柄 → 岛在第一次调用结束时就没了（第二次 `ERROR_FILE_NOT_FOUND`）。
   解法：每个岛一个常驻 island server，一直握着句柄。
2. **C#/P-Invoke 的三个静默失败**：`CreateDesktopW` 的 `lpDevice` 必须是 `IntPtr`（传 string → err 87）；
   `CreateProcessW` 的 `lpApplicationName` 必须是真 NULL（PowerShell 的 `$null` 变 `""` → err 123）；
   `SendMessageText/Get` 不写 `EntryPoint` 会在**调用时**抛 `EntryPointNotFoundException`。
3. **回包必须带回请求 id**，否则每个操作都超时，而服务端看起来一切正常。
4. **不设 `[Console]::OutputEncoding`** 就是系统代码页（GBK），中文回包变乱码。
5. **`IntPtr.Zero` 传给 `EnumChildWindows` 会去枚举调用者自己的桌面**（第一次跑测试时
   它把用户桌面几百个窗口全返了回来）。
6. **同一个应用取帧会偶尔全黑**（记事本实测 1 次 1.000 / 6 次 0.025）。
   所以 `captureVerdict` 把 >98% 暗判失败，并把那张 PNG 删掉。
7. **别从用户桌面测 `SendInput`** —— 那本身就是 T2 行为，会真的挪动用户的鼠标
   （早期探针把光标挪到了 77,66）。隔离只能在岛上测。

---

## 工作流（第二天不用重新摸索）

```bash
cd server
node tests/all.mjs                     # 必须 124/124（Windows 上含真起岛的 17 项）
node scripts/check-consistency.mjs     # 必须「七项一致性检查全部通过」
node scripts/check-capability-drift.mjs
cd ../app
flutter test                           # 必须 776 全绿
flutter analyze                        # 必须 No issues
cd .. && node scripts/check-secrets.mjs
```

三条纪律：

1. **commit 作者/邮箱用仓库配置的那个 noreply**（别用 `-c user.email=` 覆盖）——
   `secret scan` 的 `--push` 模式会扫提交元数据；强推会让它改扫整条历史。
2. 用脚本生成 JS 代码时注意 `\r?\n` 这类转义会被再解释一次 → 用 `RegExp` 构造函数
3. 每完成一块立即 commit + push，全绿才算完

## 还有那个已知挡路问题

本机装着 **GameViewer 远程控制**，它持续合成输入 → `GetLastInputInfo` 永远报
"刚刚有人动"，于是接管检测永远让开，`desktop_input` 第一次永远发不出去。
**独立桌面（今天做的这套）不受它影响** —— 那条路根本不用系统输入。
