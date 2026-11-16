# Runs ON the hidden desktop (launched via STARTUPINFO.lpDesktop) and asks the OS the
# only question that matters for isolation: can a thread that owns no input desktop
# inject system input?
#
# Writes "<key>=<value>" lines to -Out. Expected on Windows 11: SendInput refused,
# SetCursorPos refused, and this desktop's own cursor is separate from the user's.
param([string]$Out = "$env:TEMP\pibot-island-probe\island-input-check.txt")

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class IslandIn {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public MOUSEINPUT mi; }

  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
  public static extern bool GetUoi(IntPtr h, int i, StringBuilder b, int l, out int n);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] a, int size);

  public static string Name(IntPtr h) {
    var sb = new StringBuilder(260); int n;
    if (!GetUoi(h, 2, sb, sb.Capacity, out n)) return "(err " + Marshal.GetLastWin32Error() + ")";
    return sb.ToString();
  }
  public static string SendMove(int dx) {
    var a = new INPUT[1];
    a[0].type = 0; a[0].mi.dx = dx; a[0].mi.dy = 0; a[0].mi.dwFlags = 1;  // MOUSEEVENTF_MOVE
    uint sent = SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
    return "sent=" + sent + " err=" + Marshal.GetLastWin32Error();
  }
}
'@

$lines = New-Object 'System.Collections.Generic.List[string]'
$h = [IslandIn]::GetThreadDesktop([IslandIn]::GetCurrentThreadId())
$lines.Add("thread_desktop=" + [IslandIn]::Name($h))

$p = New-Object IslandIn+POINT
[IslandIn]::GetCursorPos([ref]$p) | Out-Null
$lines.Add("island_cursor_before=$($p.X),$($p.Y)")

$lines.Add("sendinput_move=" + [IslandIn]::SendMove(2))
$lines.Add("sendinput_move_back=" + [IslandIn]::SendMove(-2))

$ok = [IslandIn]::SetCursorPos(77, 66)
$lines.Add("setcursorpos_returned=" + $ok)
$lines.Add("setcursorpos_err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())

[IslandIn]::GetCursorPos([ref]$p) | Out-Null
$lines.Add("island_cursor_after=$($p.X),$($p.Y)")

[IO.File]::WriteAllLines($Out, $lines)
