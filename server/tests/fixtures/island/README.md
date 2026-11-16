# 独立桌面（island）探针

四个 PowerShell 脚本，验证"在不碰用户桌面的前提下，能不能起应用、看见它、驱动它"。
纯 Win32，无第三方组件，无驱动，无虚拟机。

```powershell
# 1) 自带的 WinForms 靶子：能看到、能点、能打字
powershell -NoProfile -ExecutionPolicy Bypass -File probe-island.ps1

# 2) 真应用（任选）：看取帧与控件的差别
powershell -NoProfile -ExecutionPolicy Bypass -File probe-island.ps1 -Exe "C:\Windows\System32\write.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File probe-island.ps1 -Exe "C:\Windows\System32\notepad.exe"

# 3) 窗口留着不关，自己眯一眼"用户桌面上到底看不看得见"
powershell -NoProfile -ExecutionPolicy Bypass -File probe-island.ps1 -HoldSeconds 20
```

| 文件 | 在哪跑 | 干什么 |
|---|---|---|
| `probe-island.ps1` | 用户桌面（这是重点） | 建岛、起应用、枚举、取帧、发窗口消息、收尾 |
| `island-fixture.ps1` | 岛上 | 一个 WinForms 靶子：一个输入框 + 一个按钮，点了写标记文件 |
| `island-input-check.ps1` | 岛上 | 问 OS：没有输入桌面的线程能不能发 `SendInput` / `SetCursorPos` |
| `island-capture-check.ps1` | 岛上 | 同样的取帧，但调用者住在岛上 —— 用来对照"谁调 `PrintWindow`"的差别 |

输出全是 `key=value`，图片落在 `%TEMP%\pibot-island-probe\`。实测数字与结论见
`docs/WINDOWS-HIDDEN-DESKTOP.md`。

## 三个踩过的坑（都会静默失败）

1. `CreateDesktopW` 的 `lpDevice` 必须是 **`IntPtr`**。声明成 `string` 并传 `null`/`""`
   时 .NET 的封送会让它返回 `ERROR_INVALID_PARAMETER (87)`。
2. `CreateProcessW` 的 `lpApplicationName` 必须是**真的 NULL**。PowerShell 把 `$null`
   转成 `""` 再传进去会得到 `ERROR_INVALID_NAME (123)` —— 所以这一步必须在 C# 里做。
3. `SendInput` / `SetCursorPos` 作用在**调用者所在的桌面**上。从用户桌面调用它们
   *就是*在动用户的鼠标（早期版本的探针干过这事，把光标挪到了 77,66）。
   要验证隔离，必须在岛上另起一个进程来试。
