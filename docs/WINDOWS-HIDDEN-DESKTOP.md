# 独立桌面（island）：能不能"在后台操作 GUI 而不碰用户" —— 实测记录

> 2026-11-16，Windows 11。探针在 `server/tests/fixtures/island/`，可重跑。
> 结论先行：**能**，代价是它只对"经典 Win32 应用"可靠；而且它**不是安全边界**。

## 为什么要做这件事

现在的桌面输入（`desktop-input-win.js`）走 `SendInput` / `SetCursorPos`，
打的是**用户当前会话**。于是有了那套租约、接管检测、`GameViewer` 一直让开的问题 ——
本质原因是：**一张桌面只有一个光标，两个人抢**。

Codex / Operator 那种"agent 有自己的光标、永远在后台跑"的观感，不是同一张桌面上
真有两个光标（OS 不支持），而是**它操作的压根不是你的桌面**。可选的四条路：

| 路线 | 隔离来源 | 代价 |
|---|---|---|
| 云端 VM/容器 | 另一台机器 | 碰不到本地文件与登录态 |
| **本机另一个 desktop 对象（本文）** | 同一会话内的另一个 desktop | 只对 GDI 应用可靠；不是安全边界 |
| 无头浏览器（CDP） | 没有 UI | 只能做网页 |
| 同桌面共享指针（现状） | 无 | 必然抢用户的鼠标 |

本文件只把第三条（desktop 对象）测清楚，因为它零依赖、零安装、可回退。

## 机制（一段话）

`CreateDesktopW` 在**同一个 window station** 里创建一个新的 desktop 对象；
用 `CreateProcessW` + `STARTUPINFO.lpDesktop` 把应用启动到那个 desktop 上，
它创建的每个窗口都属于那里。**一个 desktop 有自己的输入队列和光标位置**，
而系统的输入注入（`SendInput`）只打给**活动输入桌面** —— 所以岛上的线程发不出、
也收不到真实输入。

观察与驱动都不需要住在岛上：拿到 `HDESK` 句柄之后，
`EnumDesktopWindows` 能列出岛上的窗口、`PrintWindow` 能跨桌面取帧、
`PostMessage`/`SendMessage` 能直接打给具体控件。**agent 进程留在用户桌面上就行。**

## 实测

三个独立断言，全部可复现（`probe-island.ps1`）：

| 断言 | 结果 | 证据字段 |
|---|---|---|
| 岛上的窗口在用户桌面上出现 | ✗ | `windows_leaked_to_user_desktop=0` |
| 岛有自己的光标（与用户互不影响） | ✓ | `island_in.island_cursor_before=0,0` 全程 `0,0`；`user_cursor_changed_by_probe=False` |
| 岛上的线程发 `SendInput` | ✗ 拒绝 | `island_in.sendinput_move=sent=0 err=5`（`ERROR_ACCESS_DENIED`） |
| 岛上的线程调 `SetCursorPos` | ✗ 拒绝 | `island_in.setcursorpos_returned=False err=5` |
| 跨桌面取帧（自建 WinForms） | ✓ | `capture_dark_ratio=0.079`、6.2 KB PNG |
| 跨桌面取帧（WordPad，经典 GDI） | ✓ | `capture_dark_ratio=0.022`、60 KB PNG，界面完整 |
| 跨桌面取帧（Win11 记事本，现代合成） | ✓ 多数次 / ✗ 个别次 | 见下方"不稳定" |
| `PostMessage` 点按钮 | ✓ | 靶子写出标记文件，`postmessage_click_effect=True` |
| `WM_CHAR` 打字 + `WM_GETTEXT` 读回 | ✓ | `wm_char_typed_text=[HACKED-BY-AGENT]`（WordPad 的 `RICHEDIT50W`、记事本控件同样吃） |

### 一个必须承认的不稳定

同一台机器、同一个 `notepad.exe`，取帧出现过两种结果：

```
dark_ratio = 1.000   （全黑，1 次：child2 在岛上取帧的那次）
dark_ratio = 0.025   （正常，6 次：用户桌面跨桌面取帧 ×3、岛上取帧 ×1、1s/2s/3s 等待 ×3）
```

试过把等待从 1s 调 3s、换调用方（岛上 vs 用户桌面），**都没能复现全黑**，
所以原因不明（最可能是首次启动时窗口还没完成首帧绘制，或者是 DWM 的瞬时状态）。

**这条不稳定本身就是结论**：实现不能假设"截得到"，必须把全黑/低信息量当失败并重试，
把"看不见"如实报给上层 —— 否则模型会拿着一张黑图开始瞎点。

## 边界（哪些不要指望它）

1. **不是安全边界。** 岛上的进程仍以当前用户身份运行：同一份文件、同一张网卡、
   同一批凭据。它隔离的只有"窗口与输入"。授权判定照样按 §6 走，不能因为"在岛上"就放宽。
2. **只对 Win32 消息模型可靠。** 现代合成应用（DirectComposition/WinUI/UWP 的一部分）
   可能既截成黑帧、也没有可 `PostMessage` 的控件；这类要么走 CDP，要么上 VM。
3. **控制台程序另算。** `cmd.exe` 能起来，但它的控制台窗口由 `conhost` 创建，
   不在岛上（`island_windows` 里数不到它）。要在岛上跑命令行，重定向 stdio 或用无窗口方式。
4. **macOS 没有等价 API。** 没有 `CreateDesktop`，只能 VM，或者回到同桌面共享。
5. **启动应用等于执行命令**，权限按 `cmd.exec` 算，不能因为"看着像 GUI 操作"就降级。

## 对实现的决定（已落地）

- agent 进程**留在用户桌面**，靠 `HDESK` 句柄跨桌面工作；**不在岛上跑助手**。
- 每个岛配一个**常驻 island server**（`desktop-island-win.js`）：它在启动时
  打开/新建桌面并**一直握着句柄**，然后按行收发 JSON。为什么必须这样：
  实测"每次调用起一个 powershell、用完关句柄"会让岛在第一次调用结束时就消失
  （第二次调用 `ERROR_FILE_NOT_FOUND`）。副产品是**同岛串行**（一条 stdin 一条 stdout）
  和毫秒级操作。
- 取帧结果要**自己判是不是黑**（`captureVerdict`：暗像素 > 98% 或尺寸过小 → 失败），
  失败时把那 PNG 删掉 —— 留着迟早被当证据。
- 驱动只用窗口消息（`WM_LBUTTONDOWN/UP`、`WM_CHAR`、`WM_SETTEXT`），
  永不在岛上尝试系统输入 —— 反正也被拒，而且那条路径会误导上层以为能用。
- 空闲 10 分钟的岛由 `server-main` 的 housekeeping 自动收
  （岛上的应用是用户身份下的真实进程，空转一晚上等于在用户机器上挂一堆窗口）。

### 三个工具

| 工具 | 动作 | 干什么 |
|---|---|---|
| `desktop_island_launch` | `cmd.exec` | 在岛上起应用。只允许 `ISLAND_APPS` 里的可执行体；参数不许含 shell 元字符（不接命令串） |
| `desktop_island_observe` | `desktop.observe` | 列窗口 / 列控件 / 截图（黑帧一律报失败） |
| `desktop_island_input` | `desktop.input` | 点（可点控件中心）/ 打字（回读确认）/ `setText` / `close`（连 pid 一起杀） |

**都不需要 `desktop_lease`** —— 租约存在的理由是"一张桌面只有一个光标，两个人抢"；
岛上没有第二个人，OS 也拒绝我们发系统输入。同岛串行由 island server 的管道保证。
