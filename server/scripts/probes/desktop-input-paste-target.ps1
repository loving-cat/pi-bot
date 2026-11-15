# 靶子：一个只有 TextBox 的窗体。把收到粘贴后的内容写到文件，供 node 侧核对。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'pi-bot paste target'
$form.Width = 700; $form.Height = 260
$form.StartPosition = 'CenterScreen'
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$form.Controls.Add($box)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ Set-Content -Path 'C:\Users\XL\AppData\Local\Temp\pib-paste-target.txt' -Value $box.Text -Encoding UTF8 })
$form.Add_Shown({ $form.Activate(); $box.Focus(); $timer.Start() })
[void]$form.ShowDialog()
