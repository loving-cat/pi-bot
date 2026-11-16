# Hidden-desktop ("island") probe harness
#
# Creates a private desktop object, launches an app on it, then — from THIS process,
# which stays on the user's own desktop — enumerates it, captures it, clicks it and
# types into it with window messages only.
#
# Everything here is plain Win32: no third-party components, no driver, no VM.
# ASCII only on purpose (PowerShell 5.1 guesses encoding for non-ASCII files).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-island.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-island.ps1 -Exe "C:\Windows\System32\write.exe"
#
# Exit code is always 0; read the report. Numbers from the recorded run are in
# docs/WINDOWS-HIDDEN-DESKTOP.md.
param(
  [string]$Exe = "",
  [string]$OutDir = "$env:TEMP\pibot-island-probe",
  [int]$WaitSeconds = 3,
  [int]$HoldSeconds = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Island {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SI {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EP(IntPtr h, IntPtr l);

  // NOTE: lpDevice must be IntPtr. Passing a string/null makes the CLR marshal it
  // wrongly and CreateDesktop returns ERROR_INVALID_PARAMETER (87) -- measured.
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateDesktopW")]
  public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sec);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CloseDesktop")]
  public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(int f, bool i, uint a);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
  public static extern bool GetUoi(IntPtr h, int i, StringBuilder b, int l, out int n);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr d, EP cb, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumChildWindows(IntPtr p, EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, MOUSEINPUT[] mi, int size);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inh,
    uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint c);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

  public static string Name(IntPtr h) {
    var sb = new StringBuilder(260); int n;
    if (!GetUoi(h, 2, sb, sb.Capacity, out n)) return "(err " + Marshal.GetLastWin32Error() + ")";
    return sb.ToString();
  }
  public static string C(IntPtr h) { var sb = new StringBuilder(200); GetClassName(h, sb, 200); return sb.ToString(); }
  public static string T(IntPtr h) { var sb = new StringBuilder(300); GetWindowText(h, sb, 300); return sb.ToString(); }
  // lpApplicationName must be a true NULL here: PowerShell turns $null into "" and
  // CreateProcess then fails with ERROR_INVALID_NAME (123). Measured.
  public static int StartOn(string desk, string cmdline, out IntPtr proc, out int pid) {
    var si = new SI(); si.cb = Marshal.SizeOf(si); si.lpDesktop = desk; si.dwFlags = 1; si.wShowWindow = 1;
    PI pi; bool ok = CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
    int e = Marshal.GetLastWin32Error();
    if (!ok) { proc = IntPtr.Zero; pid = 0; return e; }
    proc = pi.hProcess; pid = pi.dwProcessId; return 0;
  }
}
'@

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
function Line($k, $v) { Write-Output ("{0}={1}" -f $k, $v) }

# ---------------------------------------------------------------- session facts
$inDesk = [Island]::OpenInputDesktop(0, $false, 0x10000000)
Line "input_desktop" ([Island]::Name($inDesk))
[Island]::CloseDesktop($inDesk) | Out-Null

$p = New-Object Island+POINT
[Island]::GetCursorPos([ref]$p) | Out-Null
$userCursorBefore = "$($p.X),$($p.Y)"
Line "user_cursor_before" $userCursorBefore

# ---------------------------------------------------------------- island + app
$deskName = "pibot_island_" + [guid]::NewGuid().ToString("N").Substring(0, 6)
$hDesk = [Island]::CreateDesktop($deskName, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
if ($hDesk -eq [IntPtr]::Zero) {
  Line "create_desktop" ("FAILED err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 0
}
Line "create_desktop" "ok name=$deskName"

if (-not $Exe) { $Exe = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\island-fixture.ps1`" -Seconds 40" }
$proc = [IntPtr]::Zero; $pid1 = 0
$err = [Island]::StartOn($deskName, $Exe, [ref]$proc, [ref]$pid1)
Line "launch" "err=$err pid=$pid1 exe=$Exe"
if ($err -ne 0) { [Island]::CloseDesktop($hDesk) | Out-Null; exit 0 }
Start-Sleep -Seconds $WaitSeconds

# ---------------------------------------------------------------- what is on the island
$script:wins = New-Object 'System.Collections.Generic.List[object]'
$cb = [Island+EP]{
  param($h, $l)
  $r = New-Object Island+RECT; [Island]::GetWindowRect($h, [ref]$r) | Out-Null
  $script:wins.Add([pscustomobject]@{ H = $h; Cls = [Island]::C($h); Title = [Island]::T($h); Vis = [Island]::IsWindowVisible($h); W = ($r.R - $r.L); H2 = ($r.B - $r.T) })
  return $true
}
[Island]::EnumDesktopWindows($hDesk, $cb, [IntPtr]::Zero) | Out-Null
Line "island_windows" $script:wins.Count
foreach ($w in $script:wins) {
  Line ("  win") ("{0,-30} vis={1,-5} {2}x{3} [{4}]" -f $w.Cls, $w.Vis, $w.W, $w.H2, $w.Title)
}

# ---------------------------------------------------------------- invisible to the user?
$leaked = 0
$ucb = [Island+EP]{
  param($h, $l)
  $t = [Island]::T($h)
  if ($t -and ($t -match 'ISLAND-FIXTURE|Document - WordPad|Untitled - Notepad')) { $script:leaked++ }
  return $true
}
[Island]::EnumWindows($ucb, [IntPtr]::Zero) | Out-Null
Line "windows_leaked_to_user_desktop" $leaked

# ---------------------------------------------------------------- capture
$target = $script:wins | Where-Object { $_.Vis -and $_.W -gt 200 -and $_.H2 -gt 200 } | Sort-Object { $_.W * $_.H2 } -Descending | Select-Object -First 1
if ($target) {
  Line "capture_target" "$($target.Cls) [$($target.Title)] $($target.W)x$($target.H2)"
  $bmp = New-Object Drawing.Bitmap($target.W, $target.H2)
  $g = [Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
  $ok2 = [Island]::PrintWindow($target.H, $hdc, 2)
  if (-not $ok2) { $ok2 = [Island]::PrintWindow($target.H, $hdc, 0) }
  $g.ReleaseHdc($hdc); $g.Dispose()
  $dark = 0; $tot = 0
  for ($y = 0; $y -lt $bmp.Height; $y += 8) { for ($x = 0; $x -lt $bmp.Width; $x += 8) {
    $c = $bmp.GetPixel($x, $y); $tot++; if (($c.R + $c.G + $c.B) -lt 24) { $dark++ } } }
  $png = Join-Path $OutDir "island-$($target.Cls).png"
  $bmp.Save($png, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Line "capture_ok" $ok2
  Line "capture_dark_ratio" ("{0:N3}" -f ($dark / [double]$tot))
  Line "capture_file" "$png ($((Get-Item $png).Length) bytes)"
} else {
  Line "capture_target" "(none: no visible window bigger than 200x200)"
}

# ---------------------------------------------------------------- drive it with messages
if ($target) {
  $script:btn = [IntPtr]::Zero
  $ccb = [Island+EP]{ param($h, $l) if ([Island]::C($h) -match 'BUTTON|Button') { $script:btn = $h; return $false } return $true }
  [Island]::EnumChildWindows($target.H, $ccb, [IntPtr]::Zero) | Out-Null
  $marker = Join-Path $OutDir "island-clicked.txt"
  if (Test-Path $marker) { Remove-Item $marker -Force }
  # Only the fixture can report a click back to us (it writes the marker). For any
  # other app a posted click is unobservable from here, so say so instead of guessing.
  $canVerify = ($target.Title -match 'ISLAND-FIXTURE') -and ($script:btn -ne [IntPtr]::Zero)
  if ($canVerify) {
    $r2 = New-Object Island+RECT; [Island]::GetWindowRect($script:btn, [ref]$r2) | Out-Null
    $lp = [IntPtr]((([int](($r2.B - $r2.T) / 2)) -shl 16) -bor ([int](($r2.R - $r2.L) / 2) -band 0xFFFF))
    [Island]::PostMessage($script:btn, 0x0201, [IntPtr]1, $lp) | Out-Null
    Start-Sleep -Milliseconds 120
    [Island]::PostMessage($script:btn, 0x0202, [IntPtr]0, $lp) | Out-Null
    Start-Sleep -Milliseconds 250
    Line "postmessage_click_effect" (Test-Path $marker)
  } else {
    Line "postmessage_click_effect" "(skipped: no observable effect; only the fixture reports clicks)"
  }

  $script:edit = [IntPtr]::Zero
  $ecb = [Island+EP]{ param($h, $l) if ([Island]::C($h) -match 'Edit|RichEdit') { $script:edit = $h; return $false } return $true }
  [Island]::EnumChildWindows($target.H, $ecb, [IntPtr]::Zero) | Out-Null
  if ($script:edit -ne [IntPtr]::Zero) {
    foreach ($ch in 'HACKED-BY-AGENT'.ToCharArray()) {
      [Island]::PostMessage($script:edit, 0x0102, [IntPtr][int]$ch, [IntPtr]::Zero) | Out-Null
      Start-Sleep -Milliseconds 20
    }
    Start-Sleep -Milliseconds 250
    $sb = New-Object Text.StringBuilder 512
    [Island]::SendMessageW($script:edit, 0x000D, [IntPtr]512, $sb) | Out-Null
    Line "wm_char_typed_text" "[$($sb.ToString())]"
  } else {
    Line "wm_char_typed_text" "(no Edit/RichEdit control: modern composited apps expose none)"
  }
}

# ---------------------------------------------------------------- capture from INSIDE the island
#
# Different callers, different results (see docs/WINDOWS-HIDDEN-DESKTOP.md): the same
# window can capture fine from the user's desktop and come back black from a process
# that lives on the island. Measure it instead of assuming.
$capFile = Join-Path $OutDir "island-capture-check.txt"
if (Test-Path $capFile) { Remove-Item $capFile -Force }
$icp = [IntPtr]::Zero; $icpid = 0
$capCmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\island-capture-check.ps1`" -Out `"$capFile`""
$icerr = [Island]::StartOn($deskName, $capCmd, [ref]$icp, [ref]$icpid)
if ($icerr -eq 0) {
  [Island]::WaitForSingleObject($icp, 30000) | Out-Null
  [Island]::CloseHandle($icp) | Out-Null
  if (Test-Path $capFile) { foreach ($l in (Get-Content $capFile)) { Write-Output ("inside_capture." + $l) } }
  else { Line "inside_capture" "(no result file)" }
} else {
  Line "inside_capture" "launch failed err=$icerr"
}

# ---------------------------------------------------------------- is the user's input safe?
#
# IMPORTANT: SendInput / SetCursorPos act on the CALLER's desktop. Calling them from
# this process (which lives on the user's desktop) is exactly the T2 behaviour we are
# trying to avoid -- an early version of this probe did that and moved the real cursor.
# So the only meaningful test is from inside the island, in a process of its own.
$p2 = New-Object Island+POINT
[Island]::GetCursorPos([ref]$p2) | Out-Null
Line "user_cursor_after" "$($p2.X),$($p2.Y)"
Line "user_cursor_changed_by_probe" (($userCursorBefore -ne "$($p2.X),$($p2.Y)"))

$checkFile = Join-Path $OutDir "island-input-check.txt"
if (Test-Path $checkFile) { Remove-Item $checkFile -Force }
$cp = [IntPtr]::Zero; $cpid = 0
$checkCmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\island-input-check.ps1`" -Out `"$checkFile`""
$cerr = [Island]::StartOn($deskName, $checkCmd, [ref]$cp, [ref]$cpid)
if ($cerr -eq 0) {
  [Island]::WaitForSingleObject($cp, 30000) | Out-Null
  [Island]::CloseHandle($cp) | Out-Null
  if (Test-Path $checkFile) {
    foreach ($l in (Get-Content $checkFile)) { Write-Output ("island_in." + $l) }
  } else { Line "island_in" "(no result file)" }
} else {
  Line "island_in" "launch failed err=$cerr"
}

# ---------------------------------------------------------------- cleanup
if ($HoldSeconds -gt 0) { Start-Sleep -Seconds $HoldSeconds }
if ($proc -ne [IntPtr]::Zero) { [Island]::TerminateProcess($proc, 0) | Out-Null; [Island]::CloseHandle($proc) | Out-Null }
[Island]::CloseDesktop($hDesk) | Out-Null
Line "done" "true"
