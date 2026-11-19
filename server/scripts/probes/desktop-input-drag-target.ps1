# 拖拽靶子：把 MouseDown / MouseMove / MouseUp（物理坐标）逐条落盘，供 node 侧核对。
#
# 为什么要有这个靶子：`performDrag` 声称"按住—分步移动—抬起，中断也一定抬起"。
# 这几件事只有**在真实窗口里收到真实鼠标事件**才证明得了 —— 单元测试里的
# 假平台只能证明我们调了它，证明不了 Windows 真的把 DOWN/MOVE/UP 发过去了。
#
# 用法（由 desktop-input-drag-probe.mjs 拉起，不手工跑）：
#   powershell -NoProfile -File desktop-input-drag-target.ps1
# 日志：%TEMP%\pib-drag-log.txt
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Aware { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }
"@
[void][Aware]::SetProcessDpiAwarenessContext([IntPtr](-4))   # 先声明，否则记录的是逻辑坐标
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$log = Join-Path $env:TEMP 'pib-drag-log.txt'
Set-Content -Path $log -Value 'ready' -Encoding UTF8

$form = New-Object System.Windows.Forms.Form
$form.Text = 'pi-bot drag target'
$form.StartPosition = 'Manual'
# 固定位置 + 置顶：探针按死坐标算，不依赖窗口管理器
$form.Location = New-Object System.Drawing.Point(200, 150)
$form.Size = New-Object System.Drawing.Size(900, 700)
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 40)
$form.TopMost = $true

$script:lastMove = 0
$form.Add_MouseDown({
  # ★ 必须 capture：真实可拖拽控件（列表/滑块）在按下时都会 SetCapture，
  #   系统才会把后续的移动消息都路由给它。不 capture 的窗口收不到 move，
  #   拿它当靶子会误判成"拖拽没生效"。
  $form.Capture = $true
  $p = [System.Windows.Forms.Cursor]::Position
  Add-Content -Path $log -Value ("down button=" + $_.Button + " cursor=" + $p.X + "," + $p.Y) -Encoding UTF8
})
$form.Add_MouseMove({
  # 30ms 节流：够看轨迹，又不至于一条拖拽写几千行
  $now = [Environment]::TickCount64
  if (($now - $script:lastMove) -ge 30) {
    $script:lastMove = $now
    $p = [System.Windows.Forms.Cursor]::Position
    Add-Content -Path $log -Value ("move cursor=" + $p.X + "," + $p.Y) -Encoding UTF8
  }
})
$form.Add_MouseUp({
  $form.Capture = $false
  $p = [System.Windows.Forms.Cursor]::Position
  Add-Content -Path $log -Value ("up button=" + $_.Button + " cursor=" + $p.X + "," + $p.Y) -Encoding UTF8
})

$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
