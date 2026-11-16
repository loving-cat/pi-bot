# A tiny WinForms app used as the probe's target. It is launched ON the hidden desktop
# (via CreateProcess + STARTUPINFO.lpDesktop), so everything it paints happens on a
# desktop the user cannot see.
#
# It writes a marker file when the button is clicked, which is how the probe proves that
# a window-message click actually landed.
param(
  [int]$Seconds = 40,
  [string]$Marker = "$env:TEMP\pibot-island-probe\island-clicked.txt"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dir = Split-Path $Marker
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
if (Test-Path $Marker) { Remove-Item $Marker -Force }

$form = New-Object Windows.Forms.Form
$form.Text = 'ISLAND-FIXTURE'
$form.Width = 520
$form.Height = 320
$form.StartPosition = 'Manual'
$form.Left = 0
$form.Top = 0

$edit = New-Object Windows.Forms.TextBox
$edit.SetBounds(20, 30, 460, 28)
$form.Controls.Add($edit)

$btn = New-Object Windows.Forms.Button
$btn.Text = 'CLICK'
$btn.SetBounds(20, 80, 160, 44)
$btn.Add_Click({ [IO.File]::WriteAllText($Marker, [DateTime]::Now.ToString('o')) })
$form.Controls.Add($btn)

$timer = New-Object Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, $Seconds) * 1000
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$timer.Start()

[Windows.Forms.Application]::Run($form)
