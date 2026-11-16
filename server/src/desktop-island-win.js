/**
 * 独立桌面（规格 §5.6 的 T1 档）的 **Windows 实现**。
 *
 * ## 为什么是"每个岛一个常驻进程"
 *
 * desktop 对象是**由最后一个打开它的句柄**维持的：探针里我在同一个进程里
 * `CreateDesktop` → `StartProcess` → 保留句柄，一切正常；改成"每次调用起一个
 * powershell、用完就退出"之后，第二次调用立刻 `ERROR_FILE_NOT_FOUND` ——
 * 岛在第一次调用结束时就没了。实测两次，确认不是偶发。
 *
 * 所以每个岛配一个**常驻的 island server**（powershell 子进程）：
 * 它在启动时打开/新建桌面、**一直握着那个句柄**，然后按行读 JSON 请求、
 * 按行回 JSON。进程活多久，岛就在多久。
 *
 * 顺带解决三件事：
 *   · 每次操作不用再起一个进程（首次之后都是毫秒级）；
 *   · 同一个岛上的操作天然串行（一条 stdin 一条 stdout）——
 *     正好是规格 §5.6 要的"同一个岛内仍要串行"；
 *   · 那个进程跑在**用户桌面**上，因此取帧是"跨桌面取帧"（实测这条路可用），
 *     而不是在岛上自己截自己。
 *
 * ## 这里做什么、不做什么
 *
 * 做：系统调用 + 把结果整理成 `{ok,...}` / `{ok:false,code,text}`。
 * 不做：档位判断、白名单、坐标校验、消息计划、黑帧判定 —— 全在
 * `desktop-island.js`（纯逻辑，28 项测试）。这里只负责"照做"和"如实回"。
 *
 * ## 平台差异（如实）
 *
 * | 平台 | 状态 |
 * |---|---|
 * | win32 | 可用（本文） |
 * | darwin / linux | 没有 `CreateDesktop` 等价 API → 返回 `not_platform`，**不退回 T2** |
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { ISLAND_FAIL, captureVerdict } from './desktop-island.js';

/** 普通操作超时（启动/枚举/发消息）。 */
const OP_TIMEOUT_MS = 20_000;
/** 取帧超时：大窗口 + 首帧可能慢。 */
const CAPTURE_TIMEOUT_MS = 40_000;
/** island server 空闲多久自动收摊（毫秒）。没有操作就没人需要它。 */
const IDLE_CLOSE_MS = 10 * 60_000;

/**
 * Win32 声明。三处坑都踩过（`docs/WINDOWS-HIDDEN-DESKTOP.md` 有记录）：
 *   · `CreateDesktopW` 的 `lpDevice` 必须是 `IntPtr`，传 string 得到 87；
 *   · `CreateProcessW` 的 `lpApplicationName` 必须是真 NULL，PowerShell 的
 *     `$null` 会变成 `""` 得到 123 —— 所以启动放在 C# 里做；
 *   · `SendInput` / `SetCursorPos` 作用在**调用者所在桌面**，这里一律不碰
 *     （岛上的进程发不出去，这正是隔离的证据）。
 */
const WIN_PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
# ★ 必须显式把输出编码设成 UTF-8：不设就是系统代码页（中文机器上是 GBK），
#   JSON 里的中文回包会变成乱码，甚至让上游解析失败。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
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

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateDesktopW")]
  public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sec);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "OpenDesktopW")]
  public static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr d, EP cb, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumChildWindows(IntPtr p, EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  // ★ 必须写 EntryPoint：不写就会去找 user32 里名为 SendMessageText 的导出，
  //   结果是 EntryPointNotFoundException —— 而且只在真正调用时才炸。
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
  public static extern IntPtr SendMessageText(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
  public static extern IntPtr SendMessageGet(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT p);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inh,
    uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

  public static string C(IntPtr h) { var sb = new StringBuilder(200); GetClassName(h, sb, 200); return sb.ToString(); }
  public static string T(IntPtr h) { var sb = new StringBuilder(600); GetWindowText(h, sb, 600); return sb.ToString(); }
  public static string ReadText(IntPtr h) {
    var sb = new StringBuilder(16000);
    SendMessageGet(h, 0x000D, (IntPtr)16000, sb);   // WM_GETTEXT
    return sb.ToString();
  }
  public static int StartOn(string desk, string cmdline, out int pid) {
    var si = new SI(); si.cb = Marshal.SizeOf(si); si.lpDesktop = desk; si.dwFlags = 1; si.wShowWindow = 1;
    PI pi; bool ok = CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
    pid = ok ? pi.dwProcessId : 0;
    if (ok) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
    return ok ? 0 : Marshal.GetLastWin32Error();
  }
  public static bool Kill(int pid) {
    IntPtr h = OpenProcess(0x0001, false, pid);   // PROCESS_TERMINATE
    if (h == IntPtr.Zero) return false;
    bool ok = TerminateProcess(h, 0);
    CloseHandle(h);
    return ok;
  }
}
'@

$script:desk = [IntPtr]::Zero
# 回包必须带回请求的 id：否则调用方无法把"回包"对上"请求"，
# 表现是每一个操作都超时（我第一次就是这么踩的）。
$script:curId = $null
function Reply($obj) {
  if ($null -ne $script:curId -and $obj -is [hashtable]) { $obj['id'] = $script:curId }
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
function Open-Desk($name) {
  $GENERIC_ALL = 0x10000000
  $h = [Island]::OpenDesktop($name, 0, $false, $GENERIC_ALL)
  $created = $false
  if ($h -eq [IntPtr]::Zero) {
    $h = [Island]::CreateDesktop($name, [IntPtr]::Zero, [IntPtr]::Zero, 0, $GENERIC_ALL, [IntPtr]::Zero)
    $created = $true
  }
  return @{ handle = $h; created = $created }
}
`;

/**
 * island server 的主循环脚本。请求/回包都是**单行 JSON**。
 *
 * 用 `[Console]::In.ReadLine()` 而不是管道对象：Node 写过一行就 flush，
 * 这里读一行处理一行，不需要分帧协议。
 */
const SERVER_BODY = String.raw`
$open = Open-Desk $req.name
$script:desk = $open.handle
if ($script:desk -eq [IntPtr]::Zero) {
  Reply @{ ok = $false; code = 'create_failed'; text = '建岛失败 err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  exit 0
}
Reply @{ ok = $true; ready = $true; created = $open.created; name = $req.name }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $r = $line | ConvertFrom-Json } catch { Reply @{ ok = $false; code = 'bad_request'; text = '请求不是 JSON' }; continue }
  $script:curId = $r.id

  switch ($r.op) {
    'launch' {
      $pid2 = 0
      $err = [Island]::StartOn($req.name, $r.commandLine, [ref]$pid2)
      if ($err -ne 0) { Reply @{ ok = $false; code = 'launch_failed'; text = '启动失败 err=' + $err } }
      else { Reply @{ ok = $true; pid = $pid2 } }
    }
    'kill' {
      Reply @{ ok = ([Island]::Kill([int]$r.pid)) }
    }
    'list' {
      $script:list = New-Object 'System.Collections.Generic.List[object]'
      $cb = [Island+EP]{
        param($w, $l)
        $rr = New-Object Island+RECT; [Island]::GetWindowRect($w, [ref]$rr) | Out-Null
        $cr = New-Object Island+RECT; [Island]::GetClientRect($w, [ref]$cr) | Out-Null
        $cls = [Island]::C($w)
        if ($cls -and (($rr.R - $rr.L) -gt 1) -and (($rr.B - $rr.T) -gt 1)) {
          $script:list.Add([pscustomobject]@{
            hwnd = [int64]$w; cls = $cls; title = [Island]::T($w); visible = [Island]::IsWindowVisible($w);
            width = ($rr.R - $rr.L); height = ($rr.B - $rr.T);
            clientWidth = ($cr.R - $cr.L); clientHeight = ($cr.B - $cr.T)
          })
        }
        return $true
      }
      [Island]::EnumDesktopWindows($script:desk, $cb, [IntPtr]::Zero) | Out-Null
      Reply @{ ok = $true; windows = $script:list }
    }
    'children' {
      $host_ = [IntPtr][int64]$r.hwnd
      $script:kids = New-Object 'System.Collections.Generic.List[object]'
      $cb2 = [Island+EP]{
        param($w, $l)
        $cr = New-Object Island+RECT; [Island]::GetClientRect($w, [ref]$cr) | Out-Null
        $cls = [Island]::C($w)
        if ($cls) {
          $script:kids.Add([pscustomobject]@{
            hwnd = [int64]$w; cls = $cls;
            clientWidth = ($cr.R - $cr.L); clientHeight = ($cr.B - $cr.T)
          })
        }
        return $true
      }
      [Island]::EnumChildWindows($host_, $cb2, [IntPtr]::Zero) | Out-Null
      Reply @{ ok = $true; children = $script:kids }
    }
    'capture' {
      $host_ = [IntPtr][int64]$r.hwnd
      $wr = New-Object Island+RECT; [Island]::GetWindowRect($host_, [ref]$wr) | Out-Null
      $w = $wr.R - $wr.L; $hgt = $wr.B - $wr.T
      if ($w -le 0 -or $hgt -le 0) { Reply @{ ok = $false; code = 'no_window'; text = '窗口尺寸为 0' } }
      else {
        $bmp = New-Object Drawing.Bitmap($w, $hgt)
        $g = [Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $pw = [Island]::PrintWindow($host_, $hdc, 2)
        if (-not $pw) { $pw = [Island]::PrintWindow($host_, $hdc, 0) }
        $g.ReleaseHdc($hdc); $g.Dispose()
        $dark = 0; $tot = 0
        for ($y = 0; $y -lt $hgt; $y += 8) { for ($x = 0; $x -lt $w; $x += 8) {
          $c = $bmp.GetPixel($x, $y); $tot++; if (($c.R + $c.G + $c.B) -lt 24) { $dark++ } } }
        $ratio = if ($tot -gt 0) { $dark / [double]$tot } else { 1.0 }
        if ($pw) { $bmp.Save($r.file, [Drawing.Imaging.ImageFormat]::Png) }
        $bmp.Dispose()
        Reply @{ ok = $true; printwindow = $pw; width = $w; height = $hgt; darkRatio = [math]::Round($ratio, 4) }
      }
    }
    'post' {
      $host_ = [IntPtr][int64]$r.hwnd
      $sent = 0
      foreach ($op in $r.ops) {
        switch ($op.msg) {
          'WM_SETTEXT' { [Island]::SendMessageText($host_, 0x000C, [IntPtr]::Zero, [string]$op.text) | Out-Null; $sent++ }
          'WM_CHAR'    { [Island]::PostMessage($host_, 0x0102, [IntPtr][int]$op.wParam, [IntPtr]::Zero) | Out-Null; $sent++ }
          default      { [Island]::PostMessage($host_, [uint32]$op.code, [IntPtr][int64]$op.wParam, [IntPtr][int64]$op.lParam) | Out-Null; $sent++ }
        }
        if ($op.delayMs) { Start-Sleep -Milliseconds ([int]$op.delayMs) }
      }
      Reply @{ ok = $true; sent = $sent }
    }
    'read' {
      $host_ = [IntPtr][int64]$r.hwnd
      $t = [Island]::ReadText($host_)
      if (-not $t) { $t = [Island]::T($host_) }
      Reply @{ ok = $true; text = $t }
    }
    'cursor' {
      $p = New-Object Island+POINT
      [Island]::GetCursorPos([ref]$p) | Out-Null
      Reply @{ ok = $true; x = $p.X; y = $p.Y }
    }
    'bye' {
      if ($script:desk -ne [IntPtr]::Zero) { [Island]::CloseDesktop($script:desk) | Out-Null; $script:desk = [IntPtr]::Zero }
      Reply @{ ok = $true; bye = $true }
      break
    }
    default { Reply @{ ok = $false; code = 'unknown_op'; text = ('不认识的操作：' + $r.op) } }
  }
}
if ($script:desk -ne [IntPtr]::Zero) { [Island]::CloseDesktop($script:desk) | Out-Null }
`;

/** 这个模块在当前平台能不能用。 */
export function isSupported() {
  return process.platform === 'win32';
}

function notPlatform() {
  return {
    ok: false,
    code: ISLAND_FAIL.notPlatform,
    text: `这个平台（${process.platform}）没有 CreateDesktop 等价 API；要 GUI 隔离只能上虚拟机，不会自动退回"动用户鼠标"那一档`,
  };
}

function asIntPtr(v) {
  const n = Number(v);
  // ★ 0 必须拒：`EnumChildWindows(IntPtr.Zero)` 会去枚举**调用者自己**桌面的顶层窗口
  //   （第一次跑测试时它把用户桌面上几百个窗口都返了回来）。
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/** name → { proc, pending: Map<id, deferred>, seq, born, lastUsed, queue } */
const islands = new Map();

/**
 * 起一个 island server 并等它就绪。
 *
 * 就绪前先有一条 `{ok,ready,created}` 回包 —— 这一步失败（建岛失败）要
 * 立刻回给调用方，而不是等后面某一操作超时。
 */
function startServer(name) {
  const encoded = Buffer.from(`${WIN_PRELUDE}\n$req = @'\n${JSON.stringify({ name })}\n'@ | ConvertFrom-Json\n${SERVER_BODY}`, 'utf16le').toString('base64');
  const proc = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let resolveReady = null;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const entry = {
    name,
    proc,
    pending: new Map(),
    seq: 0,
    born: Date.now(),
    lastUsed: Date.now(),
    stderr: '',
    closed: false,
    // 同一个岛上的操作串行：一条 promise 链，谁先来谁先发。
    queue: Promise.resolve(),
    ready,
    resolveReady,
  };
  islands.set(name, entry);

  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const text = String(line).trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      entry.stderr += `非 JSON 回包：${text.slice(0, 200)}\n`;
      return;
    }
    if (msg.ready === true || (msg.ok === false && !entry.readyDone)) {
      entry.readyDone = true;
      entry.resolveReady?.(msg);
      return;
    }
    const id = msg.id;
    const d = entry.pending.get(id);
    if (d) {
      entry.pending.delete(id);
      d.resolve(msg);
    }
  });

  proc.stderr.on('data', (chunk) => {
    entry.stderr = `${entry.stderr}${String(chunk)}`.slice(-4000);
  });

  const finish = (reason) => {
    if (entry.closed) return;
    entry.closed = true;
    islands.delete(name);
    if (!entry.readyDone) {
      entry.readyDone = true;
      entry.resolveReady?.({ ok: false, code: 'call_failed', text: reason });
    }
    for (const [, d] of entry.pending) {
      d.resolve({ ok: false, code: 'call_failed', text: `island server 退出：${reason}` });
    }
    entry.pending.clear();
  };
  proc.on('exit', (code, signal) => finish(`exit=${code}${signal ? ` signal=${signal}` : ''} ${entry.stderr.slice(-300)}`));
  proc.on('error', (err) => finish(`${err?.message ?? err}`));
  return entry;
}

/** 拿一个还活着的 island server（没有就起一个）。 */
async function sessionFor(name) {
  const existing = islands.get(name);
  if (existing && !existing.closed) return existing;
  const entry = startServer(name);
  const ready = await entry.ready;
  if (ready?.ok !== true) {
    entry.closed = true;
    islands.delete(name);
    return null;
  }
  entry.created = ready.created === true;
  return entry;
}

/** 发一条请求（串行、带超时）。 */
function request(entry, op, params = {}, { timeout = OP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (entry.closed) {
      resolve({ ok: false, code: 'call_failed', text: 'island server 已经不在了（岛随最后一个进程退出而销毁）' });
      return;
    }
    entry.seq += 1;
    const id = entry.seq;
    entry.lastUsed = Date.now();
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      resolve({ ok: false, code: 'timeout', text: `${op} 超时（${timeout}ms）` });
    }, timeout);
    entry.pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    });
    try {
      entry.proc.stdin.write(`${JSON.stringify({ ...params, op, id })}\n`);
    } catch (err) {
      clearTimeout(timer);
      entry.pending.delete(id);
      resolve({ ok: false, code: 'call_failed', text: `写不进 island server：${err?.message ?? err}` });
    }
  });
}

/** 串行执行（同一个岛）。 */
function serial(entry, fn) {
  const next = entry.queue.then(fn, fn);
  entry.queue = next.then(() => {}, () => {});
  return next;
}

async function call(name, op, params = {}, opts = {}) {
  if (!isSupported()) return notPlatform();
  const deskName = String(name ?? '').trim();
  if (!deskName) return { ok: false, code: ISLAND_FAIL.badPoint, text: '岛需要一个名字' };
  const entry = await sessionFor(deskName);
  if (!entry) return { ok: false, code: 'call_failed', text: '岛起不来（建岛失败或 powershell 起不来）' };
  return serial(entry, () => request(entry, op, params, opts));
}

// ---------------------------------------------------------------- 公开 API

/**
 * 岛还在不在。
 *
 * ★ "在不在"由**运行在岛上的进程**决定：desktop 在没有任何打开句柄时会被
 *   系统销毁。我们的 island server 持着句柄，所以只要它活着岛就在。
 */
export function islandExists({ name } = {}) {
  const entry = islands.get(String(name ?? ''));
  if (!entry) return { ok: true, exists: false };
  if (entry.closed) return { ok: true, exists: false };
  return { ok: true, exists: true, created: entry.created === true, idleMs: Date.now() - entry.lastUsed };
}

/**
 * 在岛上启动一个应用（命令行必须由 `planIslandLaunch` 生成）。
 *
 * 返回 pid —— 记着它，收尾时要用（岛上没人管的话，那些进程会一直挂着）。
 */
export async function launchOnIsland({ name, commandLine } = {}) {
  const line = String(commandLine ?? '').trim();
  if (!line) return { ok: false, code: ISLAND_FAIL.badPoint, text: '缺命令行（先过 planIslandLaunch）' };
  return call(name, 'launch', { commandLine: line });
}

/** 杀掉一个进程（岛上的应用收尾用）。 */
export async function killProcess({ name, pid } = {}) {
  const target = Number(pid) || 0;
  if (!target) return { ok: false, code: ISLAND_FAIL.badPoint, text: '缺 pid' };
  const r = await call(name, 'kill', { pid: target });
  if (r.ok === true) return { ok: true };
  return { ok: false, code: 'call_failed', text: '杀不掉那个进程（可能已经退了）' };
}

/** 列出岛上的窗口。 */
export async function listIslandWindows({ name } = {}) {
  return call(name, 'list');
}

/** 列一个窗口的子控件（找输入框/按钮用）。 */
export async function listIslandChildren({ name, hwnd } = {}) {
  const h = asIntPtr(hwnd);
  if (!h) return { ok: false, code: ISLAND_FAIL.noWindow, text: `缺窗口句柄：${hwnd}` };
  return call(name, 'children', { hwnd: h });
}

/**
 * 取一帧，并且**自己判它是不是黑的**。
 *
 * 判定用纯逻辑 `captureVerdict`：宁可报失败，也不要把一张黑图当"界面长这样"。
 */
export async function captureIslandWindow({ name, hwnd, file } = {}) {
  const h = asIntPtr(hwnd);
  if (!h) return { ok: false, code: ISLAND_FAIL.noWindow, text: `缺窗口句柄：${hwnd}` };
  const target = String(file ?? '').trim();
  if (!target) return { ok: false, code: ISLAND_FAIL.badPoint, text: '缺保存路径' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    return { ok: false, code: 'call_failed', text: `建目录失败：${err?.message ?? err}` };
  }
  const r = await call(name, 'capture', { hwnd: h, file: target }, { timeout: CAPTURE_TIMEOUT_MS });
  if (r.ok !== true) return r;
  if (r.printwindow !== true) {
    return { ok: false, code: ISLAND_FAIL.blankFrame, text: 'PrintWindow 失败（这个窗口不响应 WM_PRINT）' };
  }
  const verdict = captureVerdict({ darkRatio: r.darkRatio, width: r.width, height: r.height });
  if (!verdict.ok) {
    // 图是黑的就别留着：留着迟早有人当证据用
    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
    return verdict;
  }
  return { ok: true, file: target, width: r.width, height: r.height, darkRatio: r.darkRatio };
}

/** 把一串窗口消息发给某个窗口（消息由 `planIslandMessages` 算）。 */
export async function postIslandMessages({ name, hwnd, ops } = {}) {
  const h = asIntPtr(hwnd);
  if (!h) return { ok: false, code: ISLAND_FAIL.noWindow, text: `缺窗口句柄：${hwnd}` };
  const list = Array.isArray(ops) ? ops : [];
  if (!list.length) return { ok: false, code: ISLAND_FAIL.badText, text: '没有要发的消息' };
  return call(name, 'post', { hwnd: h, ops: list });
}

/** 读控件里的文字（验证"真的打进去了"）。 */
export async function readIslandText({ name, hwnd } = {}) {
  const h = asIntPtr(hwnd);
  if (!h) return { ok: false, code: ISLAND_FAIL.noWindow, text: `缺窗口句柄：${hwnd}` };
  return call(name, 'read', { hwnd: h });
}

/** 当前（调用方所在桌面）的光标位置 —— 用来证明"没动用户的鼠标"。 */
export async function cursorPosition({ name } = {}) {
  return call(name, 'cursor');
}

/**
 * 收摊：关掉岛上的进程、关 desktop 句柄、退出 island server。
 *
 * 不调用也不会泄漏太久（`IDLE_CLOSE_MS` 之后自己收），但任务结束时应该显式收 ——
 * 岛上的应用是**用户身份下的真实进程**。
 */
export async function closeIsland({ name, pids = [] } = {}) {
  const deskName = String(name ?? '').trim();
  const entry = islands.get(deskName);
  for (const pid of Array.isArray(pids) ? pids : []) {
    if (Number(pid) > 0) await killProcess({ name: deskName, pid });
  }
  if (!entry) return { ok: true, alreadyClosed: true };
  await serial(entry, async () => {
    const r = await request(entry, 'bye', {}, { timeout: 5_000 });
    return r;
  });
  try {
    entry.proc.stdin.end();
  } catch { /* ignore */ }
  // 给 powershell 一点时间自己退；不退就杀。
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { entry.proc.kill(); } catch { /* ignore */ }
      resolve();
    }, 3_000);
    entry.proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  islands.delete(deskName);
  return { ok: true };
}

/** 空闲的岛自己收摊（由调用方定时调；测试里不用）。 */
export async function sweepIdleIslands({ now = Date.now(), idleMs = IDLE_CLOSE_MS } = {}) {
  const closed = [];
  for (const [name, entry] of [...islands]) {
    const idleFor = now - entry.lastUsed;
    if (idleFor < idleMs) continue;
    if (entry.pending.size) continue;
    await closeIsland({ name });
    closed.push({ name, idleFor });
  }
  return { closed };
}

export { ISLAND_FAIL };
