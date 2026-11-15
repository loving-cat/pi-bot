/**
 * Windows 桌面输入（`SendInput` + `SetCursorPos` + `GetLastInputInfo`）。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §5.2 / §5.4 的**平台实现**。
 * 判定在上游两个纯逻辑文件里，这个文件只做三件事：发输入、读光标、读最后输入时间。
 *
 *   · 谁能发 → `desktop-lease.js`（租约 / epoch / 过期 / 吊销）
 *   · 该不该发 → `desktop-takeover.js`（用户接管检测）
 *   · 该发什么 → `desktop-input.js`（规划 + 坐标校验，纯函数）
 *   · 怎么发 → 这里（Win32 调用）
 *
 * ## 为什么观察和输入分成两个文件
 *
 * | | 观察（`desktop-observe.js`） | 输入（这个文件） |
 * |---|---|---|
 * | 失败后果 | 画面是旧的，模型看错 | **点到别的地方去**（删库、付款、发消息） |
 * | 失败策略 | 报错让模型换做法 | 立刻停手，把控制权交还用户 |
 * | 坐标错 25% | 截图糊一点 | 点错整个界面 |
 *
 * 混在一起写，两条完全不同的失败策略会被同一处 `catch` 抹平。
 *
 * ## ★ 坐标必须先「DPI 感知」，否则整屏偏移（本机实测）
 *
 * 2560x1440 / 125% 缩放。同一台机器、同一个 PowerShell 进程：
 *
 * ```
 * 未声明感知：Screen.AllScreens → 2048x1152   （被系统缩小 80% 的逻辑坐标）
 * SetProcessDpiAwarenessContext(-4)：   → 2560x1440   （真实物理坐标）
 * ```
 *
 * Win32 的鼠标 API 认**物理**像素。没声明感知的进程拿到逻辑坐标，
 * 2048 x 1.25 = 2560 —— 不是差一点，是**整屏偏移**，而且不报错。
 * 所以脚本第一件事就是声明感知；拿不到 → **不发输入**（返回 `not_dpi_aware`）。
 * 宁可这一轮干不了，也不能点到别处去。
 *
 * ## ★ 鼠标移动用 `SetCursorPos`，不用 `SendInput` 的绝对坐标（实测）
 *
 * 实测数据（本机）：
 *
 * ```
 * SendInput 绝对坐标 50%/50% → 期望 (1280,720)  实际 (1611,1114)   ✗ 偏 331,394
 * 同上 + MOUSEEVENTF_VIRTUALDESK              → 仍然偏移
 * 声明感知 + SendInput 绝对坐标                → 仍然偏移
 * SetCursorPos(1200,300)                      → 光标 (1200,300)   ✓
 * SetCursorPos(2000,1200)                     → 光标 (2000,1200)  ✓
 * ```
 *
 * 偏移像是"把 65535 刻度当成了物理像素刻度再换算一次"。原因不明（可能
 * 与虚拟桌面/远程桌面适配器有关），但结论清楚：**移动用 SetCursorPos，
 * 按键/滚轮用 SendInput（它们不需要坐标）**。
 *
 * ## ★ 光标复核必须带「容差 + 重试」，否则会误报（本机实测）
 *
 * 这台机器装着 GameViewer（远程控制），它和输入法一样会**碰光标**：
 * 连读八次发现光标自己从 (740,1047) 跳到了 (1264,371)，`GetLastInputInfo`
 * 的 idle 一直归零 —— 系统认为"一直有人在动"。
 *
 * 所以复核判据不是"逐像素相等"：
 *
 * ```
 * 第一次 SetCursorPos(1200,300) → 实测落在 1174,303 / 1204,298 —— 差 3~26 px
 * 重试一次                     → 1200,301 → 再试 → 1200,300  ✓
 * ```
 *
 * 于是：容许 `CURSOR_TOLERANCE_PX`（默认 24）以内的偏差，偏差更大时
 * **再发一次移动**（最多 `MOVE_ATTEMPTS` 次）；仍然不到位就失败返回，
 * 绝不在错的位置上点击。
 *
 * ## ★ 中文/emoji 走剪贴板粘贴，不走 KEYEVENTF_UNICODE
 *
 * `SendInput` 的 unicode 模式绕过输入法，很多应用（尤其自带输入法的聊天窗口）
 * 收不到。所以 `type_text` 是「存原剪贴板 → 设新内容 → Ctrl+V → **还原原剪贴板**」。
 * 不还原就等于把用户正在搬的东西弄丢了。
 *
 * ## 平台状态的诚实记录
 *
 * 实测过的项写在 `docs/WINDOWS.md` 的「桌面输入」一节；没实测的一律标出来，
 * 这份注释里不写"应该可以"。
 */
import { spawnSync } from 'node:child_process';
import {
  INPUT_FAIL, planInput, escapeForPsDoubleQuotes, describePlatform as describePurePlatform,
} from './desktop-input.js';

/** 单次脚本超时。一次点击不该超过几秒。 */
const TIMEOUT_MS = 15_000;

/**
 * 光标复核的容差（物理像素）。
 *
 * 为什么不是 0：这台机器上实测 SetCursorPos 之后光标会落在目标附近
 * 3~26 px 内（远程控制/输入法/系统动画都在碰光标）。要求逐像素相等
 * 会把正常的移动判成失败。超过这个容差才算"没移到"。
 */
const CURSOR_TOLERANCE_PX = 24;

/** 移动最多试几次（每次都会重新 GetCursorPos 复核）。 */
const MOVE_ATTEMPTS = 3;

/**
 * 统一的 Win32 头：**必须在任何 GDI/WinForms 触碰之前执行**。
 *
 * `Add-Type -AssemblyName System.Windows.Forms` 会把进程的 DPI 感知定死，
 * 之后再声明就晚了 —— 所以声明放在这个 prelude 的第一句，且这里
 * 不加载任何 WinForms 程序集（需要剪贴板时那一段自己加载，那时已经声明完了）。
 */
const WIN_PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskIn {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
  [DllImport("kernel32.dll")] public static extern UInt64 GetTickCount64();
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  // ★ 必须是显式联合（Explicit），否则 Marshal.SizeOf 算出来的 size 不对，
  //   SendInput 会静默返回 0（"参数错误"），表现是"什么都没发生"。
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  public const uint FULL = 0;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  public static bool MakeAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
    try { return SetProcessDPIAware(); } catch { return false; }
  }
  public static string ScreenInfo() {
    // SM_XVIRTUALSCREEN(76) / SM_YVIRTUALSCREEN(77) / SM_CXVIRTUALSCREEN(78) / SM_CYVIRTUALSCREEN(79)
    return GetSystemMetrics(76) + "," + GetSystemMetrics(77) + "," + GetSystemMetrics(78) + ","
      + GetSystemMetrics(79) + "," + GetDpiForSystem();
  }
  public static bool HasSession() {
    // 锁屏 / 断开会话时打不开输入桌面 —— 比猜前台窗口标题靠谱得多
    IntPtr h = OpenInputDesktop(0, false, 0x0001);
    if (h == IntPtr.Zero) return false;
    CloseDesktop(h);
    return true;
  }
  public static long LastInputTick() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) return -1;
    return (long)li.dwTime;
  }
  public static long Uptime() { return (long)GetTickCount64(); }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }
  public static uint Send(INPUT[] a) { return SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }

  public static INPUT Btn(uint flag) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi = new MOUSEINPUT(); i.u.mi.dwFlags = flag; return i;
  }
  public static INPUT Wheel(int d) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi = new MOUSEINPUT();
    i.u.mi.dwFlags = MOUSEEVENTF_WHEEL; i.u.mi.mouseData = (uint)d; return i;
  }
  public static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki = new KEYBDINPUT();
    i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0; return i;
  }
  public static string ForegroundTitle() {
    var sb = new System.Text.StringBuilder(512);
    GetWindowTextW(GetForegroundWindow(), sb, 512);
    return sb.ToString();
  }
}
"@
`;

function run(script, { timeout = TIMEOUT_MS } = {}) {
  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (res.error) return { ok: false, error: String(res.error.message || res.error) };
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || '').slice(0, 400) || `exit ${res.status}` };
  }
  return { ok: true, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

/** 这个模块在当前平台能不能用。 */
export function isSupported() {
  return process.platform === 'win32';
}

/**
 * 探一次环境：DPI 感知、虚拟屏矩形、有没有可操作会话。
 *
 * **每次注入前都要重新探**（不缓存）—— 布局会变：外接屏拔了、分辨率改了、
 * 用户锁屏了。规格 §5.4「布局变化使旧坐标失效」。
 *
 * @returns {{ok:true, screen:object, dpi:number, session:boolean}
 *   | {ok:false, code:string, text:string}}
 */
export function probeEnvironment() {
  if (!isSupported()) {
    return { ok: false, code: INPUT_FAIL.notPlatform, text: `当前平台（${process.platform}）没有 Windows 输入实现` };
  }
  const res = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'aware=0'; exit 0 }
$i = [DeskIn]::ScreenInfo() -split ','
$s = [DeskIn]::HasSession()
Write-Output ("aware=1 screen=" + $i[0] + "," + $i[1] + "," + $i[2] + "," + $i[3] + " dpi=" + $i[4] + " session=" + $(if ($s) { 1 } else { 0 }))
`);
  if (!res.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: `取屏幕环境失败：${res.error}` };
  const line = res.stdout || '';
  if (line.includes('aware=0')) {
    return {
      ok: false,
      code: INPUT_FAIL.notAware,
      text: '这个进程声明不了 DPI 感知，坐标基准不可信，本轮不发输入',
    };
  }
  const m = /screen=(-?\d+),(-?\d+),(\d+),(\d+) dpi=(\d+) session=(\d)/.exec(line);
  if (!m) return { ok: false, code: INPUT_FAIL.callFailed, text: `屏幕信息解析失败：${line.slice(0, 200)}` };
  const screen = { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
  if (!(screen.width > 0 && screen.height > 0)) {
    return { ok: false, code: INPUT_FAIL.callFailed, text: '屏幕尺寸为 0 —— 可能没有登录会话' };
  }
  return { ok: true, screen, dpi: Number(m[5]) || 96, session: m[6] === '1' };
}

/**
 * 读「最后一次输入的时刻」（epoch 毫秒），喂给 `desktop-takeover.js` 的 `classify`。
 *
 * 换算链：`GetLastInputInfo().dwTime` 是**开机毫秒**（32 位，约 49.7 天回绕），
 * 用 `GetTickCount64()` 反推。两者同源，所以不需要绝对基准：
 *
 * ```
 * idleMs      = uptime64 - lastTick     （低 32 位对齐，处理回绕）
 * lastInputAt = Date.now() - idleMs
 * ```
 *
 * 比 `bootTime + tick` 稳：不用担心 32 位回绕，也不用猜开机时刻。
 *
 * @returns {{ok:true, lastInputAt:number, idleMs:number} | {ok:false, code:string, text:string}}
 */
export function lastInputAt() {
  if (!isSupported()) {
    return { ok: false, code: INPUT_FAIL.notPlatform, text: `当前平台（${process.platform}）没有 Windows 输入探针` };
  }
  const res = run(`${WIN_PRELUDE}
Write-Output ("tick=" + [DeskIn]::LastInputTick() + " uptime=" + [DeskIn]::Uptime())
`);
  if (!res.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: `取最后输入时间失败：${res.error}` };
  const m = /tick=(-?\d+) uptime=(\d+)/.exec(res.stdout || '');
  if (!m) return { ok: false, code: INPUT_FAIL.probeUnavailable, text: '输入探针返回了无法解析的内容' };
  const tick = Number(m[1]);
  const uptime = Number(m[2]);
  if (tick < 0) {
    // GetLastInputInfo 失败（没有交互式窗口站）—— 探针不可用，**不是**"没人动"
    return { ok: false, code: INPUT_FAIL.probeUnavailable, text: 'GetLastInputInfo 失败（没有交互式会话）' };
  }
  const uptime32 = uptime % 2 ** 32;
  let idleMs = uptime32 - tick;
  if (idleMs < 0) idleMs += 2 ** 32; // 32 位 tick 回绕
  return { ok: true, lastInputAt: Date.now() - idleMs, idleMs };
}

/**
 * 发一个已经规划好的输入。
 *
 * 调用方（工具层）必须先过租约、接管检测、`planInput`。这里**不做判定**，
 * 只负责：声明感知 → 执行 → 复核光标。任何一步不对就失败并说明原因。
 *
 * @param {object} p
 * @param {object} p.plan 来自 `planInput()` 的计划
 * @param {boolean} [p.verifyCursor] 移动类动作是否需要复核光标（默认 true）
 * @returns {{ok:true, at:object|null, foreground:string} | {ok:false, code:string, text:string}}
 */
export function perform({ plan, verifyCursor = true } = {}) {
  if (!isSupported()) {
    return { ok: false, code: INPUT_FAIL.notPlatform, text: `当前平台（${process.platform}）没有 Windows 输入实现` };
  }
  if (!plan || !plan.action) return { ok: false, code: INPUT_FAIL.invalid, text: '没有可执行的输入计划' };
  const fg = foregroundTitle();
  const foreground = fg.ok ? fg.title : '';

  if (plan.action === 'move' || plan.action === 'click') {
    const { x, y } = plan.point;
    // ★ 先移到位、复核、必要时重试；**到位之前绝不点击**
    const moved = verifyCursor ? moveTo({ x, y }) : moveOnce({ x, y });
    if (!moved.ok) return moved;
    const actual = moved.at;
    if (plan.action === 'click') {
      const clicked = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'result=not_aware'; exit 0 }
${clickScript(plan)}
`);
      if (!clicked.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: `点击失败：${clicked.error}` };
      const cout = clicked.stdout || '';
      if (cout.includes('result=not_aware')) {
        return { ok: false, code: INPUT_FAIL.notAware, text: 'DPI 感知声明失败，没发输入' };
      }
      if (!cout.includes('result=clicked')) {
        return { ok: false, code: INPUT_FAIL.callFailed, text: `点击没发出去：${cout.slice(0, 200)}` };
      }
    }
    return { ok: true, at: actual, foreground };
  }

  if (plan.action === 'scroll') {
    const notches = plan.delta;
    const move = plan.point
      ? `[void][DeskIn]::SetCursorPos(${Math.round(plan.point.x)}, ${Math.round(plan.point.y)})\nStart-Sleep -Milliseconds 40\n`
      : '';
    const res = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'result=not_aware'; exit 0 }
${move}$n = [DeskIn]::Send(@([DeskIn]::Wheel(${notches * 120})))
Write-Output ("result=sent n=" + $n)
`);
    if (!res.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: `滚动失败：${res.error}` };
    const out = res.stdout || '';
    if (out.includes('result=not_aware')) {
      return { ok: false, code: INPUT_FAIL.notAware, text: 'DPI 感知声明失败，没发输入' };
    }
    if (!/result=sent n=1/.test(out)) {
      return { ok: false, code: INPUT_FAIL.callFailed, text: `滚轮没发出去：${out.slice(0, 200)}` };
    }
    return { ok: true, at: plan.point ?? null, foreground };
  }

  if (plan.action === 'key' || plan.action === 'keyCombo') {
    const down = plan.codes.map((c) => `[void][DeskIn]::Send(@([DeskIn]::Key(${c}, $false)))`).join('\n');
    const up = [...plan.codes].reverse().map((c) => `[void][DeskIn]::Send(@([DeskIn]::Key(${c}, $true)))`).join('\n');
    const res = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'result=not_aware'; exit 0 }
${down}
Start-Sleep -Milliseconds 30
${up}
Write-Output 'result=sent'
`);
    if (!res.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: `按键失败：${res.error}` };
    const out = res.stdout || '';
    if (out.includes('result=not_aware')) {
      return { ok: false, code: INPUT_FAIL.notAware, text: 'DPI 感知声明失败，没发输入' };
    }
    if (!out.includes('result=sent')) {
      return { ok: false, code: INPUT_FAIL.callFailed, text: `按键没发出去：${out.slice(0, 200)}` };
    }
    return { ok: true, at: null, foreground };
  }

  // type_text：剪贴板 + Ctrl+V（中文/emoji 必须这么走，见文件头）
  const res = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'result=not_aware'; exit 0 }
Add-Type -AssemblyName System.Windows.Forms
$prev = ''
$had = $false
try { $prev = Get-Clipboard -Raw -Format Text -ErrorAction Stop; $had = $null -ne $prev } catch { $had = $false }
Set-Clipboard -Value "${escapeForPsDoubleQuotes(plan.text)}"
Start-Sleep -Milliseconds 90
[void][DeskIn]::Send(@([DeskIn]::Key(0x11, $false)))
Start-Sleep -Milliseconds 20
[void][DeskIn]::Send(@([DeskIn]::Key(0x56, $false)))
Start-Sleep -Milliseconds 20
[void][DeskIn]::Send(@([DeskIn]::Key(0x56, $true)))
Start-Sleep -Milliseconds 20
[void][DeskIn]::Send(@([DeskIn]::Key(0x11, $true)))
Start-Sleep -Milliseconds 150
if ($had) { Set-Clipboard -Value $prev } else { Set-Clipboard -Value '' }
Write-Output 'result=sent'
`);
  if (!res.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: `输入文字失败：${res.error}` };
  const out = res.stdout || '';
  if (out.includes('result=not_aware')) {
    return { ok: false, code: INPUT_FAIL.notAware, text: 'DPI 感知声明失败，没发输入' };
  }
  if (!out.includes('result=sent')) {
    return { ok: false, code: INPUT_FAIL.callFailed, text: `文字没输入成功：${out.slice(0, 200)}` };
  }
  return { ok: true, at: null, foreground };
}

/** 一次移动 + 读回光标（不做重试）。 */
function moveOnce({ x, y }) {
  const res = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'result=not_aware'; exit 0 }
[void][DeskIn]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
Start-Sleep -Milliseconds 40
$p = [DeskIn]::Cursor()
Write-Output ("result=moved x=" + $p[0] + " y=" + $p[1])
`);
  if (!res.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: `发输入失败：${res.error}` };
  const out = res.stdout || '';
  if (out.includes('result=not_aware')) {
    return { ok: false, code: INPUT_FAIL.notAware, text: 'DPI 感知声明失败，坐标不可信，没发输入' };
  }
  const m = /result=moved x=(-?\d+) y=(-?\d+)/.exec(out);
  if (!m) return { ok: false, code: INPUT_FAIL.callFailed, text: `移动没成功：${out.slice(0, 200)}` };
  return { ok: true, at: { x: Number(m[1]), y: Number(m[2]) } };
}

/**
 * 移到目标点并**复核**，偏差超过容差就再试。
 *
 * 为什么需要重试：这台机器实测第一次 SetCursorPos 会落在目标附近
 * 3~26 px（远程控制/输入法/系统动画在碰光标）。要求逐像素相等会把
 * 正常的移动判成失败；而没有上限的重试又可能一直追不上。
 * 所以：容差 `CURSOR_TOLERANCE_PX`，最多 `MOVE_ATTEMPTS` 次，仍不到位就失败。
 *
 * **仍然不到位时绝不点击** —— 在错的位置上点下去比不点危险得多。
 */
function moveTo({ x, y }) {
  let last = null;
  for (let i = 0; i < MOVE_ATTEMPTS; i += 1) {
    const r = moveOnce({ x, y });
    if (!r.ok) {
      // 平台层硬失败（无会话/无感知）不重试，直接上抛
      if (r.code !== INPUT_FAIL.callFailed) return r;
      last = r;
      continue;
    }
    last = r;
    if (Math.abs(r.at.x - x) <= CURSOR_TOLERANCE_PX && Math.abs(r.at.y - y) <= CURSOR_TOLERANCE_PX) {
      return r;
    }
    if (i < MOVE_ATTEMPTS - 1) sleepMs(60);
  }
  if (last?.ok) {
    return {
      ok: false,
      code: INPUT_FAIL.callFailed,
      text: `鼠标没移到目标位置（要到 (${x},${y})，实际 (${last.at.x},${last.at.y})，试了 ${MOVE_ATTEMPTS} 次），已放弃这次动作`,
    };
  }
  return last ?? { ok: false, code: INPUT_FAIL.callFailed, text: '移动失败' };
}

/** 阻塞一小会儿（这里是同步上下文，用 Atomics.wait 而不是忙等）。 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0));
}

/** 点击那一段（在同一个 PS 进程里紧跟移动，减少中间被抢的机会）。 */
function clickScript(plan) {
  const flags = {
    left: ['MOUSEEVENTF_LEFTDOWN', 'MOUSEEVENTF_LEFTUP'],
    right: ['MOUSEEVENTF_RIGHTDOWN', 'MOUSEEVENTF_RIGHTUP'],
    middle: ['MOUSEEVENTF_MIDDLEDOWN', 'MOUSEEVENTF_MIDDLEUP'],
  }[plan.button];
  const one = `$d = [DeskIn]::Send(@([DeskIn]::Btn([DeskIn]::${flags[0]})))
$u = [DeskIn]::Send(@([DeskIn]::Btn([DeskIn]::${flags[1]})))
if ($d -ne 1 -or $u -ne 1) { Write-Output ("result=sendinput_failed d=" + $d + " u=" + $u); exit 0 }`;
  return `
for ($i = 0; $i -lt ${plan.clicks}; $i++) {
  ${one}
  if ($i -lt ${plan.clicks - 1}) { Start-Sleep -Milliseconds 45 }
}
Write-Output 'result=clicked'`;
}

/**
 * 读当前光标位置（物理像素）。
 *
 * 用途：点了之后**核对结果**（规格 §5.2「观察—确认—重新校验目标—执行—核对结果」）。
 */
export function cursorPosition() {
  if (!isSupported()) return { ok: false, code: INPUT_FAIL.notPlatform, text: '当前平台没有 Windows 输入实现' };
  const res = run(`${WIN_PRELUDE}
[void][DeskIn]::MakeAware()
$p = [DeskIn]::Cursor()
Write-Output ("x=" + $p[0] + " y=" + $p[1])
`);
  if (!res.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: `取光标位置失败：${res.error}` };
  const m = /x=(-?\d+) y=(-?\d+)/.exec(res.stdout || '');
  if (!m) return { ok: false, code: INPUT_FAIL.callFailed, text: `光标位置解析失败：${(res.stdout || '').slice(0, 120)}` };
  return { ok: true, x: Number(m[1]), y: Number(m[2]) };
}

/** 当前前台窗口标题（审计用：记下"动的是哪个窗口"，不记窗口内容）。 */
export function foregroundTitle() {
  if (!isSupported()) return { ok: false, code: INPUT_FAIL.notPlatform, text: '当前平台没有 Windows 输入实现' };
  const res = run(`${WIN_PRELUDE}
Write-Output ("title=" + [DeskIn]::ForegroundTitle())
`);
  if (!res.ok) return { ok: false, code: INPUT_FAIL.callFailed, text: res.error };
  return { ok: true, title: (res.stdout || '').replace(/^title=/, '').slice(0, 200) };
}

/**
 * 一次完整动作的便捷入口：探环境 → 规划 → 发送。
 *
 * 工具层要的通常是这个（它已经把租约和接管检查做完了）。
 *
 * @param {object} p 见 `planInput` 的参数
 * @returns {{ok:true, at:object|null, foreground:string, plan:object, screen:object}
 *   | {ok:false, code:string, text:string}}
 */
export function performAction({ action, point = null, button = 'left', clicks = 1, delta = 0, key = null, keyCombo = null, text = '' } = {}) {
  const env = probeEnvironment();
  if (!env.ok) return env;
  if (!env.session) {
    return { ok: false, code: INPUT_FAIL.noSession, text: '当前没有可操作会话（可能锁屏或已断开），交还用户' };
  }
  const planned = planInput({
    action, point, screen: env.screen, button, clicks, delta, key, keyCombo, text,
  });
  if (!planned.ok) return planned;
  const sent = perform({ plan: planned.plan });
  if (!sent.ok) return sent;
  return { ok: true, at: sent.at, foreground: sent.foreground, plan: planned.plan, screen: env.screen };
}

/** 平台状态表（写进文档时用它，别手写"应该可以"）。 */
export function describePlatform() {
  const base = describePurePlatform(process.platform);
  if (process.platform !== 'win32') return base;
  return {
    ...base,
    supported: true,
    verified: 'Windows 11 / 2560x1440 / 125% 缩放（docs/WINDOWS.md「桌面输入」）',
    move: 'SetCursorPos + GetCursorPos 复核（SendInput 绝对坐标实测偏移，见文件头）',
    buttons: 'SendInput（相对 0 位移，不移动光标）',
    text: '剪贴板 + Ctrl+V，用完还原原剪贴板',
  };
}
