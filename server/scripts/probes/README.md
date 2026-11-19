# 桌面输入的实机探针（Windows）

这几个文件是**给人手动跑的一次性探针**，不在 CI 里、不被 `tests/all.mjs` 引用。
留着的理由是它们记录了真机验证的方法：`docs/WINDOWS.md` 的「桌面输入」一节
那几条结论，就是用它们在本机（Windows 11 / 2560x1440 / 125% 缩放）跑出来的。

跑法（在 `server/` 目录下，需要一个能弹出窗口的交互式会话）：

```powershell
# 1) 点击坐标验证：打开一个靶子窗口，它会记录每次 MouseDown 时的光标物理坐标
powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/probes/desktop-input-click-target.ps1
#    日志落在 %TEMP%\pib-click-log.txt
#    另开一个终端：
node scripts/probes/desktop-input-session-probe.mjs

# 2) 粘贴内容验证：靶子是一个只有 TextBox 的窗体，每秒把自己内容写到
#    %TEMP%\pib-paste-target.txt，用来核对中文/emoji/特殊字符是否逐字相符
powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/probes/desktop-input-paste-target.ps1

# 3) 拖拽验证（自己拉起靶子、自己收尾）：记录 down/move/up，
#    A 段拖一次完整的，B 段在第 4 站报中断，验证“中断时鼠标真的松开了”
node scripts/probes/desktop-input-drag-probe.mjs
```

拖拽靶子刻意**不做日志节流**：`[Environment]::TickCount64` 是 .NET Core 3.0+ 的属性，
Windows PowerShell 5.1 跑在 .NET Framework 上会**静默返回 `$null`**，节流条件永远为假
—— 于是“一条 move 都没记录”看起来像“系统不发鼠标移动消息”，差点把探针 bug 当成产品 bug
（2026-11-19 实测踩到）。要时间戳就用 `[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()`。

两个靶子都必须**自己先声明 DPI 感知**：不声明的话它记录的坐标是逻辑坐标
（本机 2048x1152 而不是 2560x1440），拿它去和物理坐标比就会误判成"点偏了"。
这一点踩过，脚本里有注释。

## 注入回归

`desktop-input-injection-probe.mjs` 验证 `type_text` 的 PowerShell 转义：
它把一串元字符（`"` `$` `` ` `` `'`）喂进去，判据是**靶子收到原文**且
**用来做标记的文件没被创建**。本机实测两条都过。

```powershell
node scripts/probes/desktop-input-injection-probe.mjs
```
