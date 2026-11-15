# 点击靶子：记录每次鼠标按下时的物理坐标，写到文件供 node 侧核对。
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Aware { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }
"@
[void][Aware]::SetProcessDpiAwarenessContext([IntPtr](-4))   # 先声明，否则记录的是逻辑坐标
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$log = Join-Path $env:TEMP 'pib-click-log.txt'
Set-Content -Path $log -Value '' -Encoding UTF8
$form = New-Object System.Windows.Forms.Form
$form.Text = 'pi-bot click target'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(200, 150)
$form.Size = New-Object System.Drawing.Size(900, 700)
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 40)
$form.TopMost = $true
$form.Add_MouseDown({
  $p = [System.Windows.Forms.Cursor]::Position
  Add-Content -Path $log -Value ("down button=" + $_.Button + " cursor=" + $p.X + "," + $p.Y) -Encoding UTF8
})
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
