# Same capture as the harness, but executed ON the island (a process whose thread owns
# that desktop). Kept because the two callers do NOT behave the same, and that decides
# the architecture: the agent should stay on the user's desktop and capture across,
# instead of running a helper inside the island.
#
# Measured 2026-11-16 on Windows 11: Win11 Notepad -> 1.000 (all black) from in here,
# 0.025 (fine) from the user's desktop. WinForms/WordPad look the same from both.
param(
  [string]$Out = "$env:TEMP\pibot-island-probe\island-capture-check.txt",
  [string]$Png = ""
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class IslandCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
  public static extern bool GetUoi(IntPtr h, int i, StringBuilder b, int l, out int n);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr d, EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public static string Name(IntPtr h) { var sb = new StringBuilder(260); int n; if (!GetUoi(h, 2, sb, sb.Capacity, out n)) return "(err)"; return sb.ToString(); }
  public static string C(IntPtr h) { var sb = new StringBuilder(200); GetClassName(h, sb, 200); return sb.ToString(); }
  public static string T(IntPtr h) { var sb = new StringBuilder(300); GetWindowText(h, sb, 300); return sb.ToString(); }
}
'@

$lines = New-Object 'System.Collections.Generic.List[string]'
$desk = [IslandCap]::GetThreadDesktop([IslandCap]::GetCurrentThreadId())
$lines.Add("thread_desktop=" + [IslandCap]::Name($desk))

$script:wins = New-Object 'System.Collections.Generic.List[object]'
$cb = [IslandCap+EP]{
  param($h, $l)
  if (-not [IslandCap]::IsWindowVisible($h)) { return $true }
  $r = New-Object IslandCap+RECT; [IslandCap]::GetWindowRect($h, [ref]$r) | Out-Null
  if (($r.R - $r.L) -lt 200 -or ($r.B - $r.T) -lt 200) { return $true }
  $script:wins.Add([pscustomobject]@{ H = $h; Cls = [IslandCap]::C($h); Title = [IslandCap]::T($h); W = ($r.R - $r.L); H2 = ($r.B - $r.T) })
  return $true
}
[IslandCap]::EnumDesktopWindows($desk, $cb, [IntPtr]::Zero) | Out-Null

$t = $script:wins | Sort-Object { $_.W * $_.H2 } -Descending | Select-Object -First 1
if (-not $t) {
  $lines.Add("result=no window")
  [IO.File]::WriteAllLines($Out, $lines)
  exit 0
}
$lines.Add("target=" + $t.Cls + " [" + $t.Title + "] " + $t.W + "x" + $t.H2)

$bmp = New-Object Drawing.Bitmap($t.W, $t.H2)
$g = [Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
$ok = [IslandCap]::PrintWindow($t.H, $hdc, 2)
if (-not $ok) { $ok = [IslandCap]::PrintWindow($t.H, $hdc, 0) }
$g.ReleaseHdc($hdc); $g.Dispose()
$dark = 0; $tot = 0
for ($y = 0; $y -lt $bmp.Height; $y += 8) { for ($x = 0; $x -lt $bmp.Width; $x += 8) {
  $c = $bmp.GetPixel($x, $y); $tot++; if (($c.R + $c.G + $c.B) -lt 24) { $dark++ } } }
$lines.Add("printwindow=" + $ok)
$lines.Add("dark_ratio=" + ("{0:N3}" -f ($dark / [double]$tot)))
if ($Png) { $bmp.Save($Png, [Drawing.Imaging.ImageFormat]::Png); $lines.Add("saved=" + $Png) }
$bmp.Dispose()
[IO.File]::WriteAllLines($Out, $lines)
