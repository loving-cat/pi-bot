/**
 * 桌面**观察**能力（只读）：列窗口、截图指定窗口。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §5.1 / §5.4 / §11 P0-3 的**观察层**。
 *
 * ## 为什么先做观察、不做输入
 *
 * 规格把 computer use 当一个整体（P0-3），但这两半的风险和技术难度完全不同：
 *
 *   · **观察**（截屏、列窗口）：看得到，改不了。系统接口成熟，一条 PowerShell /
 *     一条 `screencapture` 就够。风险是隐私（截图里可能有别的窗口），
 *     靠"只截目标窗口 + 落任务目录 + 不进群不进记忆"控制。
 *   · **输入**（鼠标、键盘、焦点）：等于把当前登录账号交出去。需要输入租约、
 *     用户接管检测、世代号、旧坐标失效这一整套（§5.2）。
 *
 * 所以这里只做观察。输入另开一层，排在确认框架之后。
 *
 * ## 默认只截目标窗口，不截全屏
 *
 * 规格 §5.5 要求"最小化取景"。全屏截图会把用户所有窗口（密码管理器、别的项目、
 * 私聊）一起送进模型上下文 —— 那不是在"观察任务需要的"，是在收集。
 *
 * 所以 `screenshot_screen` 必须**显式指定**，而且调用方（工具层）会要求
 * 当次授权；默认路径是 `screenshot_window`。
 *
 * ## 平台状态（据实记录，不假装已完成）
 *
 * | 能力 | Windows | macOS |
 * |---|---|---|
 * | 列窗口 | 已实现（EnumWindows + DWM 边框） | 已实现（System Events，需辅助功能授权） |
 * | 截指定窗口 | 已实现（窗口矩形 + CopyFromScreen） | 已实现（`screencapture -l`，需屏幕录制授权） |
 * | 截全屏 | 已实现 | 已实现 |
 *
 * **未实测项**：macOS 的窗口 id 来源走 `System Events` 拿不到 CGWindowID，
 * 这里用"进程 + 标题"定位后交给 `screencapture -R <rect>` 按矩形截 ——
 * 需要 macOS 实机验证（本机是 Windows）。规格 §16.1 要求把这类项标出来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

/** 单次脚本超时。截屏不该超过几秒。 */
const TIMEOUT_MS = 20_000;

/** 截图最长边：超过就缩，避免把几十 MB 的 PNG 塞进模型上下文。 */
const MAX_EDGE = 1600;

/** 列窗口最多返回多少个（按面积降序，大的通常是主窗口）。 */
const MAX_WINDOWS = 40;

function run(cmd, args, { timeout = TIMEOUT_MS } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) return { ok: false, error: String(res.error.message || res.error) };
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || '').slice(0, 500) || `exit ${res.status}` };
  }
  return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * Windows 侧的 PowerShell 脚本：列可见顶层窗口（带矩形与所属进程）。
 *
 * 为什么用 Add-Type P/Invoke 而不是 Get-Process：`Get-Process` 给的是进程，
 * 不是窗口；一个进程可能有多个窗口，也可能有窗口属于别的进程（宿主）。
 * 要"只截目标窗口"就必须拿到窗口句柄和它在屏幕上的矩形。
 *
 * 用 DWM 的 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 取边框：
 * `GetWindowRect` 在 Win10+ 会把不可见的阴影边距也算进去，
 * 按那个矩形裁出来的截图右边和下边会多一圈别的窗口。
 */
const PS_LIST_WINDOWS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<object[]> List() {
    var outv = new List<object[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      // 跳过工具窗口（WS_EX_TOOLWINDOW）：输入法、托盘浮层之类
      int ex = GetWindowLongW(h, -20);
      if ((ex & 0x80) != 0) return true;
      var title = new StringBuilder(512);
      GetWindowTextW(h, title, 512);
      var cls = new StringBuilder(256);
      GetClassNameW(h, cls, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r;
      int hr = DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT)));
      if (hr != 0) { r = new RECT(); }
      outv.Add(new object[] {
        h.ToInt64(), title.ToString(), cls.ToString(), (int)pid,
        r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top,
        IsIconic(h) ? 1 : 0
      });
      return true;
    }, IntPtr.Zero);
    return outv;
  }
}
"@
$rows = [W]::List()
$result = @()
foreach ($r in $rows) {
  $pid2 = [int]$r[3]
  $pname = ''
  try { $pname = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch { $pname = '' }
  $result += [pscustomobject]@{
    handle  = [long]$r[0]
    title   = [string]$r[1]
    class   = [string]$r[2]
    pid     = $pid2
    process = $pname
    x       = [int]$r[4]
    y       = [int]$r[5]
    width   = [int]$r[6]
    height  = [int]$r[7]
    minimized = ([int]$r[8] -eq 1)
  }
}
$result | ConvertTo-Json -Compress -Depth 6
`;

/**
 * Windows：截指定窗口。
 *
 * ## 为什么用 PrintWindow 而不是 CopyFromScreen
 *
 * 实测对比（同一个 Spotify 窗口）：
 *   · `CopyFromScreen(窗口矩形)` → 截到的是**该矩形上的屏幕内容**，
 *     窗口被别的东西盖住时，截回来的是上面那个窗口（本机实际踩到：
 *     想截编辑器，结果截到了自己终端）。而且窗口在屏幕外/最小化时完全截不到。
 *   · `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` → 让**窗口自己画自己**。
 *     被遮住也截得到，标题栏按钮、圆角都对。
 *
 * `PW_RENDERFULLCONTENT`(2) 对 Chrome/Electron/UWP 这类自绘窗口是必要的，
 * 不加只会得到一片空白。
 *
 * 老程序的 PrintWindow 可能返回全黑（它们靠 WM_PRINTCLIENT，不一定实现），
 * 所以调用方会在拿到图后做一次「是不是全黑」的检测，必要时回退到屏幕矩形。
 */
function psPrintWindow({ handle, outFile }) {
  const safe = String(outFile).replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [IntPtr]::new([long]${Math.trunc(handle)})
$r = New-Object PW+RECT
$hr = [PW]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf([type]('PW+RECT')))
if ($hr -ne 0) { [void][PW]::GetWindowRect($h, [ref]$r) }
# ★ 变量名不能叫 $W / $H：PowerShell 变量大小写不敏感，
#   $H 会直接覆盖上面那个窗口句柄 $h —— 实测表现是 PrintWindow 返回 False，
#   然后静默回退到 CopyFromScreen (截到的是压在窗口上面的东西)。
$winW = $r.Right - $r.Left
$winH = $r.Bottom - $r.Top
if ($winW -le 0 -or $winH -le 0) { Write-Error '窗口尺寸为 0'; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($winW, $winH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $hdc = $g.GetHdc()
  try { $ok = [PW]::PrintWindow($h, $hdc, 2) } finally { $g.ReleaseHdc($hdc) }
} finally { $g.Dispose() }
try {
  $bmp.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bmp.Dispose() }
Write-Output ("printwindow=" + $ok + " size=" + $winW + "x" + $winH)
`;
  return run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

/** Windows：截一块屏幕矩形到 PNG（回退路径）。 */
function psCaptureRect({ x, y, width, height, outFile }) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# 不用 $w / $h：PowerShell 变量大小写不敏感，$h 撞窗口句柄会静默出错。
$capW = ${Math.round(width)}
$capH = ${Math.round(height)}
if ($capW -le 0 -or $capH -le 0) { Write-Error '区域为空'; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($capW, $capH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen(${Math.round(x)}, ${Math.round(y)}, 0, 0, (New-Object System.Drawing.Size($capW, $capH)))
} finally { $g.Dispose() }
try {
  $bmp.Save('${outFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bmp.Dispose() }
Write-Output 'ok'
`;
  return run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/**
 * macOS 侧：用 System Events 列前台应用窗口。
 *
 * 注意：System Events 拿不到 CGWindowID，所以只能拿到"应用 + 标题 + 位置尺寸"。
 * 截图时用 `screencapture -R <x,y,w,h>` 按矩形截 —— 结果与"截这个窗口"等价，
 * 前提是窗口没有被别的窗口部分遮挡（遮挡部分截到的是上面的窗口）。
 * 这个限制写在这里，不藏。
 */
const OSA_LIST = `
tell application "System Events"
  set out to ""
  repeat with p in (every process whose background only is false)
    set pname to name of p
    try
      repeat with w in (every window of p)
        set t to ""
        try
          set t to name of w
        end try
        set pos to position of w
        set sz to size of w
        set out to out & pname & tab & t & tab & (item 1 of pos) & tab & (item 2 of pos) & tab & (item 1 of sz) & tab & (item 2 of sz) & linefeed
      end repeat
    end try
  end repeat
  return out
end tell
`;

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 列当前可见窗口。
 *
 * @param {object} [o]
 * @param {number} [o.limit] 最多返回多少个
 * @returns {{ok:true, windows:Array, platform:string}|{ok:false, error:string}}
 */
export function listWindows({ limit = MAX_WINDOWS } = {}) {
  if (process.platform === 'win32') {
    const res = run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_LIST_WINDOWS]);
    if (!res.ok) return { ok: false, error: res.error };
    let rows;
    try {
      const text = (res.stdout || '').trim();
      if (!text) return { ok: true, windows: [], platform: 'win32' };
      rows = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `窗口列表解析失败：${String(err?.message || err).slice(0, 200)}` };
    }
    const list = (Array.isArray(rows) ? rows : [rows])
      .map((r) => ({
        handle: Number(r.handle) || 0,
        title: String(r.title ?? '').slice(0, 200),
        app: String(r.process ?? ''),
        class: String(r.class ?? ''),
        pid: Number(r.pid) || 0,
        x: Number(r.x) || 0,
        y: Number(r.y) || 0,
        width: Number(r.width) || 0,
        height: Number(r.height) || 0,
        minimized: r.minimized === true,
      }))
      // 只留能截的：有标题、有面积、没最小化
      .filter((w) => w.width > 0 && w.height > 0 && !w.minimized)
      .filter((w) => w.title || w.app)
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, Math.max(1, Math.min(limit, MAX_WINDOWS)));
    return { ok: true, windows: list, platform: 'win32' };
  }

  if (process.platform === 'darwin') {
    const res = run('osascript', ['-e', OSA_LIST], { timeout: TIMEOUT_MS });
    if (!res.ok) {
      return {
        ok: false,
        error: 'System Events 没返回窗口（可能缺「辅助功能」授权）：' + res.error,
      };
    }
    const list = (res.stdout || '')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((p) => p.length >= 6)
      .map(([app, title, x, y, w, h]) => ({
        handle: 0,
        title: String(title ?? '').slice(0, 200),
        app: String(app ?? ''),
        x: Number(x) || 0,
        y: Number(y) || 0,
        width: Number(w) || 0,
        height: Number(h) || 0,
      }))
      .filter((w) => w.width > 0 && w.height > 0)
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, Math.max(1, Math.min(limit, MAX_WINDOWS)));
    return { ok: true, windows: list, platform: 'darwin' };
  }

  return { ok: false, error: `当前平台（${process.platform}）不支持桌面观察` };
}

/** 屏幕尺寸（截全屏时用）。 */
function screenSize() {
  if (process.platform === 'win32') {
    const res = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.SystemInformation]::VirtualScreen; \"$($s.Width)x$($s.Height)\""]);
    if (res.ok) {
      const m = /^(\d+)x(\d+)$/.exec((res.stdout || '').trim());
      if (m) return { width: Number(m[1]), height: Number(m[2]) };
    }
    return null;
  }
  if (process.platform === 'darwin') {
    const res = run('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']);
    if (res.ok) {
      const nums = (res.stdout || '').match(/-?\d+/g);
      if (nums && nums.length >= 4) {
        return { width: Number(nums[2]) - Number(nums[0]), height: Number(nums[3]) - Number(nums[1]) };
      }
    }
  }
  return null;
}

/**
 * 截一张图。
 *
 * @param {object} p
 * @param {string} p.outFile 落盘路径（调用方负责选目录；这里不再决定存哪）
 * @param {object} [p.window] 目标窗口（来自 listWindows 的条目）
 * @param {boolean} [p.fullScreen] 截整个屏幕（必须显式要求）
 * @param {number} [p.maxEdge] 最长边上限（超过缩放）
 * @returns {{ok:true, file:string, width:number, height:number, scope:string}|{ok:false, error:string}}
 */
export function captureScreenshot({ outFile, window: target = null, fullScreen = false, maxEdge = MAX_EDGE } = {}) {
  if (!outFile) return { ok: false, error: '缺少落盘路径' };
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, error: `建目录失败：${String(err?.message || err)}` };
  }

  let rect = null;
  let scope = 'window';
  if (fullScreen) {
    const size = screenSize();
    rect = size ? { x: 0, y: 0, width: size.width, height: size.height } : null;
    scope = 'screen';
    if (!rect) return { ok: false, error: '取不到屏幕尺寸' };
  } else {
    if (!target) return { ok: false, error: '没有指定窗口（要截全屏请显式要求）' };
    rect = { x: target.x, y: target.y, width: target.width, height: target.height };
    if (!rect.width || !rect.height) return { ok: false, error: '窗口尺寸为 0（可能已最小化）' };
  }

  let res;
  if (process.platform === 'win32') {
    // 先试"窗口自己画自己"（被遮蔽/最小化也能截）
    if (!fullScreen && Number(target?.handle) > 0) {
      const printed = psPrintWindow({ handle: target.handle, outFile });
      if (printed.ok && fs.existsSync(outFile) && !isMostlyBlank(outFile)) {
        res = printed;
      } else {
        // 老程序不实现 WM_PRINTCLIENT，PrintWindow 会返回全黑 —— 退回屏幕矩形
        res = psCaptureRect({ ...rect, outFile });
      }
    } else {
      res = psCaptureRect({ ...rect, outFile });
    }
  } else if (process.platform === 'darwin') {
    // -x 关掉快门声；-R 按矩形截（见上面的注释：窗口 id 拿不到）
    res = run('screencapture', ['-x', '-R', `${rect.x},${rect.y},${rect.width},${rect.height}`, outFile]);
  } else {
    return { ok: false, error: `当前平台（${process.platform}）不支持截图` };
  }
  if (!res.ok) return { ok: false, error: `截图失败：${res.error}` };
  if (!fs.existsSync(outFile)) return { ok: false, error: '截图没生成文件' };

  const shrunk = shrinkIfNeeded(outFile, maxEdge);
  const stat = fs.statSync(outFile);
  return {
    ok: true,
    file: outFile,
    bytes: stat.size,
    scope,
    ...(shrunk ?? {}),
  };
}

/**
 * 太大就缩。
 *
 * 为什么不用现成的 resizeImage：那是 pi SDK 给 `read` 用的，依赖 sharp 一类的
 * 原生模块；桌面观察是**可选能力**，不该为了它把原生依赖变成硬要求。
 * 这里用系统自带的办法（Windows 走 .NET，macOS 走 sips），失败就原样返回。
 */
function shrinkIfNeeded(file, maxEdge) {
  const dim = probeSize(file);
  if (!dim) return null;
  const longest = Math.max(dim.width, dim.height);
  if (longest <= maxEdge) return { width: dim.width, height: dim.height, resized: false };
  const scale = maxEdge / longest;
  const w = Math.max(1, Math.round(dim.width * scale));
  const h = Math.max(1, Math.round(dim.height * scale));

  if (process.platform === 'win32') {
    // ★ 必须先把图读进内存再关掉文件。
    //
    //   `Image.FromFile(path)` 会把文件**锁住**直到 Dispose，
    //   而这里要写回同一个路径 —— GDI+ 直接报
    //   “A generic error occurred in GDI+”（实测）。
    //   绕法是：读进 MemoryStream、关掉文件、再存盘。
    const safe = file.replace(/'/g, "''");
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bytes = [System.IO.File]::ReadAllBytes('${safe}')
$ms = New-Object System.IO.MemoryStream(,$bytes)
$src = [System.Drawing.Image]::FromStream($ms)
try {
  $bmp = New-Object System.Drawing.Bitmap(${w}, ${h})
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($src, 0, 0, ${w}, ${h})
    } finally { $g.Dispose() }
    $bmp.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }
} finally { $src.Dispose(); $ms.Dispose() }
`;
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    if (!r.ok) return { width: dim.width, height: dim.height, resized: false, shrinkError: r.error };
  } else if (process.platform === 'darwin') {
    const r = run('sips', ['-Z', String(maxEdge), file, '--out', file]);
    if (!r.ok) return { width: dim.width, height: dim.height, resized: false, shrinkError: r.error };
  } else {
    return { width: dim.width, height: dim.height, resized: false };
  }
  return { width: w, height: h, resized: true, originalWidth: dim.width, originalHeight: dim.height };
}

/**
 * 这张图是不是基本全空（全黑/全白/全单色）。
 *
 * 为什么需要：`PrintWindow` 对不实现 WM_PRINTCLIENT 的老程序会返回整张全黑，
 * 而且**返回 true 表示“调用成功”** —— 不检查像素就会把一块黑色方块当截图交给模型，
 * 模型看到“黑色画面”会开始猜（“窗口可能最小化了”），比直接说截不到更糟。
 *
 * 做法：把 IDAT 解压后看字节分布。单色图经过 PNG 行过滤后绝大多数字节是 0，
 * 所以“最大频次字节占比 > 99%”就是个很可靠的判据，不用引入图像解码库。
 */
function isMostlyBlank(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.slice(1, 4).toString('ascii') !== 'PNG') return false;
    const idat = [];
    let pos = 8;
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.slice(pos + 4, pos + 8).toString('ascii');
      const data = buf.slice(pos + 8, pos + 8 + len);
      if (type === 'IDAT') idat.push(data);
      if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (!idat.length) return false;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (!raw.length) return false;
    const counts = new Uint32Array(256);
    for (let i = 0; i < raw.length; i += 1) counts[raw[i]] += 1;
    let top = 0;
    for (let i = 0; i < 256; i += 1) if (counts[i] > top) top = counts[i];
    return top / raw.length > 0.99;
  } catch {
    // 解不出来就不要因为“判不出来”而把好图丢掉
    return false;
  }
}

/** 读 PNG 的宽高（只解析 IHDR，不引依赖）。 */
function probeSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(24);
      fs.readSync(fd, buf, 0, 24, 0);
      // PNG 签名 8 字节 + 长度 4 + 'IHDR' 4，宽高在 16..24
      if (buf.slice(1, 4).toString('ascii') !== 'PNG') return null;
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (!width || !height) return null;
      return { width, height };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 截图落点：任务目录下的 screenshots/。
 *
 * 规格 §5.5：**截图按任务本地受控保存，最小化取景和保留期；含秘密时不入群、
 * 不放通用记忆**。所以这里不进 workspace（那里会被 changed_files 扫到、
 * 可能被自动附件发出去），而是放在数据目录下一个独立位置。
 *
 * @param {object} p
 * @param {string} p.dataDir
 * @param {string} [p.taskId] 归属任务（没有任务时按 bot 分）
 * @param {string} [p.botId]
 * @returns {{dir:string, file:string}}
 */
export function screenshotPath({ dataDir, taskId = null, botId = null } = {}) {
  const scope = String(taskId || botId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  const dir = path.join(dataDir || os.tmpdir(), 'desktop-shots', scope);
  const name = `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`;
  return { dir, file: path.join(dir, name) };
}

/** 一句话描述窗口，给模型看（不含进程绝对路径）。 */
export function describeWindow(w, index = null) {
  const prefix = index === null ? '' : `${index + 1}. `;
  const size = w.width && w.height ? ` ${w.width}x${w.height}` : '';
  const pos = Number.isFinite(w.x) && Number.isFinite(w.y) ? ` @${w.x},${w.y}` : '';
  const title = w.title || '(无标题)';
  return `${prefix}[${w.app || '?'}] ${title}${size}${pos}`;
}

/** 清理旧截图（按年龄）。只在调用方明确要求时调 —— 不自动删用户要的证据。 */
export function pruneScreenshots({ dataDir, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  const root = path.join(dataDir || os.tmpdir(), 'desktop-shots');
  let removed = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.png')) continue;
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > maxAgeMs) { fs.unlinkSync(full); removed += 1; }
      } catch { /* 忽略单个失败 */ }
    }
  };
  walk(root);
  return { removed };
}
