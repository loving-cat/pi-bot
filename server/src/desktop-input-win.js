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
  INPUT_FAIL, planInput, escapeForPsDoubleQuotes, classifyInputNoise,
  describePlatform as describePurePlatform,
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
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  // ★ 拖拽移动必须走 SendInput 的相对移动（MOUSEEVENTF_MOVE），不能用 SetCursorPos：
  //   实测（本机 2560x1440 / 125%）：SetCursorPos 只改光标位置，**不给窗口发
  //   WM_MOUSEMOVE** —— 靶子只记录到 down 和 up，中间一条 move 都没有，拖拽退化成
  //   “瞬移”，文件列表/滑块根本不认。相对移动则会像真实鼠标一样产生 move。
  //
  // ★ 为什么不用 MOUSEEVENTF_ABSOLUTE：本机实测不准（目标 350,320 落在 1499,640）。
  //   相对移动实测是准的：每步 +20,+12 走五步后正好 +100,+60。
  public static INPUT MoveRel(int dx, int dy) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi = new MOUSEINPUT();
    i.u.mi.dx = dx; i.u.mi.dy = dy;
    i.u.mi.dwFlags = MOUSEEVENTF_MOVE;
    return i;
  }

  // 移动到绝对坐标：SetCursorPos 定位 + 一次 ±1px 相对移动来把 move 投递给窗口。
  //   ★ 为什么不能只靠相对移动：大位移会被系统“提高指针精确度”（加速曲线）放大，
  //     实测要移到 (350,320)，五步累加后落在 (0,252)（撞到屏幕左边被 clamp）。
  //     小位移（20px 级）是准的，所以拿 ±1px 这一下只负责“通知窗口”，不负责位移。
  //   ★ 为什么不能只靠 SetCursorPos：它只改光标位置，不发 WM_MOUSEMOVE。
  //   返回 1 = 光标已到位（位置差在 1px 内），0 = 没到位，上层应当报错而不是继续。
  public static int MoveTo(int x, int y) {
    if (!SetCursorPos(x, y)) return 0;
    int[] c = Cursor();
    if (c[0] != x || c[1] != y) return 0;
    Send(new INPUT[] { MoveRel(1, 0) });
    Send(new INPUT[] { MoveRel(-1, 0) });
    return 1;
  }

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
export function perform({ plan, verifyCursor = true, shouldAbort = null, onStep = null } = {}) {
  if (!isSupported()) {
    return { ok: false, code: INPUT_FAIL.notPlatform, text: `当前平台（${process.platform}）没有 Windows 输入实现` };
  }
  if (!plan || !plan.action) return { ok: false, code: INPUT_FAIL.invalid, text: '没有可执行的输入计划' };
  const fg = foregroundTitle();
  const foreground = fg.ok ? fg.title : '';

  if (plan.action === 'drag') return performDrag({ plan, shouldAbort, onStep });

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

/** 拖拽时每段最多走几站。段内一次 PS 调用，段间回 Node 判一次中断。 */
const DRAG_BATCH = 4;

/**
 * 按住 → 分段移动 → 抬起。
 *
 * ★ 为什么分段，而不是一条脚本拖到底
 *
 * 一条脚本里我们**没法中断**：用户中途接管、租约被撤、锁屏，都只能等脚本
 * 跑完才知道 —— 那时鼠标已经拖到终点了。分段后每段之间都能回头问一句
 * `shouldAbort`，所以中断粒度是“最多 4 站”。
 *
 * ★ 任何一条返回路径都先抬起
 *
 * 用户桌面上留一个“按住不放”的鼠标，比不实现拖拽危险得多 —— 下一个鼠标
 * 移动就会变成继续拖拽（可能把文件拖进回收站）。所以：成功也抬起、失败也
 * 抬起、中断更要抬起；抬起失败要在文案里明确让人手动点一下左键。
 *
 * @param {object} p
 * @param {object} p.plan 来自 `planInput({action:'drag'})`
 * @param {(info:{at?:object,index?:number,total?:number}) => ({code:string,text:string}|null)} [p.shouldAbort]
 * @param {(info:{at:object,index:number,total:number}) => void} [p.onStep]
 * @returns {{ok:true, at:object, foreground:string, released:true}
 *   | {ok:false, code:string, text:string, released:boolean}}
 */
export function performDrag({ plan, shouldAbort = null, onStep = null } = {}) {
  if (!plan || plan.action !== 'drag') {
    return { ok: false, code: INPUT_FAIL.invalid, text: '不是一条拖拽计划', released: true };
  }
  const stops = Array.isArray(plan.stops) ? plan.stops : [];
  if (!plan.from || !plan.to || !stops.length) {
    return {
      ok: false, code: INPUT_FAIL.invalid, text: '拖拽路径不完整（缺起点/终点/中间站）', released: true,
    };
  }
  const button = ['left', 'right', 'middle'].includes(plan.button) ? plan.button : 'left';
  const [downFlag, upFlag] = {
    left: ['MOUSEEVENTF_LEFTDOWN', 'MOUSEEVENTF_LEFTUP'],
    right: ['MOUSEEVENTF_RIGHTDOWN', 'MOUSEEVENTF_RIGHTUP'],
    middle: ['MOUSEEVENTF_MIDDLEDOWN', 'MOUSEEVENTF_MIDDLEUP'],
  }[button];
  const stepMs = Math.min(200, Math.max(5, Math.trunc(Number(plan.stepMs)) || 12));
  const fg = foregroundTitle();
  const foreground = fg.ok ? fg.title : '';
  let released = false;

  /** 松开鼠标键。幂等：已经松开就返回 true。 */
  const up = () => {
    if (released) return true;
    const r = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'result=not_aware'; exit 0 }
$u = [DeskIn]::Send(@([DeskIn]::Btn([DeskIn]::${upFlag})))
Write-Output ("result=up n=" + $u)
`);
    released = r.ok && /result=up n=1/.test(r.stdout || '');
    return released;
  };

  /** 按住的是哪个键（文案要说对：拖拽支持 right / middle）。 */
  const heldName = button === 'right' ? '右键' : button === 'middle' ? '中键' : '左键';

  /** 中断/失败统一出口：**先抬起再报错**。 */
  const stop = (code, text) => {
    const ok = up();
    return {
      ok: false,
      code,
      text: ok
        ? `${text}（${heldName}已松开）`
        : `${text}（⚠ ${heldName}松开失败，请手动点一下${heldName}）`,
      released: ok,
    };
  };

  /**
   * 还没按下鼠标就失败：**没有需要松开的东西**。
   * 走 `stop()` 会多发一次 up —— 虽然无害，但审计里会看起来像"按了又松"，
   * 而真实情况是"一次都没按"。并且多一次 PS 进程启动约 100ms。
   */
  const failBeforeDown = (code, text) => ({
    ok: false,
    code,
    text: `${text}（还没按下鼠标，不需要松开）`,
    released: true,
  });

  // ① 移到位 + 按下（同一条脚本，减少中途被抢的机会）
  const down = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'result=not_aware'; exit 0 }
$n0 = [DeskIn]::MoveTo(${Math.round(Number(plan.from.x))}, ${Math.round(Number(plan.from.y))})
if ($n0 -ne 1) { Write-Output 'result=move_failed'; exit 0 }
Start-Sleep -Milliseconds 30
$c0 = [DeskIn]::Cursor()
# ★ 偏移判断必须写在**按下之前**：先按再判，等于已经在错的位置点了一下，
#   回 Node 再抬起也收不回那一下点击。
if ([Math]::Abs($c0[0] - ${Math.round(Number(plan.from.x))}) -gt 2 -or [Math]::Abs($c0[1] - ${Math.round(Number(plan.from.y))}) -gt 2) {
  Write-Output ("result=misaligned at=" + $c0[0] + "," + $c0[1]); exit 0
}
$d = [DeskIn]::Send(@([DeskIn]::Btn([DeskIn]::${downFlag})))
Write-Output ("result=down n=" + $d + " at=" + $c0[0] + "," + $c0[1])
`);
  // ★ 到这里鼠标**一次都还没按下**：失败一律走 failBeforeDown，不发多余的 up。
  if (!down.ok) return failBeforeDown(INPUT_FAIL.callFailed, `拖拽按下失败：${down.error}`);
  if ((down.stdout || '').includes('result=not_aware')) {
    return failBeforeDown(INPUT_FAIL.notAware, 'DPI 感知声明失败，没发输入');
  }
  if ((down.stdout || '').includes('result=move_failed')) {
    return failBeforeDown(INPUT_FAIL.callFailed, '光标没移到起点（相对移动没发出去）');
  }
  // 偏移判断在 PowerShell 里做完了（在按下之前），这里只把结论翻译成人话。
  if ((down.stdout || '').includes('result=misaligned')) {
    const at = (down.stdout || '').match(/at=(-?\d+),(-?\d+)/);
    const where = at ? `(${at[1]},${at[2]})` : '别处';
    return failBeforeDown(
      INPUT_FAIL.callFailed,
      `按下前光标不在起点（要到 (${plan.from.x},${plan.from.y})，实际 ${where}）`
      + ' —— 这台机器上可能有程序在合成鼠标输入',
    );
  }
  if (!/result=down n=1/.test(down.stdout || '')) {
    return failBeforeDown(INPUT_FAIL.callFailed, `鼠标没按下去：${(down.stdout || '').slice(0, 200)}`);
  }

  // ② 分段走：每段一次 PS 调用，段间回来判一次要不要停
  let moved = 0;
  for (let i = 0; i < stops.length; i += DRAG_BATCH) {
    const batch = stops.slice(i, i + DRAG_BATCH);
    const body = batch
      .map((p) => {
        const x = Math.round(Number(p.x));
        const y = Math.round(Number(p.y));
        // ★ 用相对移动（MoveTo）而不是 SetCursorPos：只有相对移动才会给窗口
        //   发 WM_MOUSEMOVE，拖拽语义才成立（见 prelude 里 MoveRel 的注释）。
        //   返回值必须查：SendInput 没插进去时返回 0，光标不会报错、也不会动。
        return `$n = [DeskIn]::MoveTo(${x}, ${y})\n`
          + `if ($n -ne 1) { Write-Output 'result=move_failed'; exit 0 }\n`
          + `Start-Sleep -Milliseconds ${stepMs}`;
      })
      .join('\n');
    const seg = run(`${WIN_PRELUDE}
$aware = [DeskIn]::MakeAware()
if (-not $aware) { Write-Output 'result=not_aware'; exit 0 }
${body}
$c = [DeskIn]::Cursor()
Write-Output ("result=moved at=" + $c[0] + "," + $c[1])
`);
    if (!seg.ok) return stop(INPUT_FAIL.callFailed, `拖拽移动失败：${seg.error}`);
    if ((seg.stdout || '').includes('result=not_aware')) {
      return stop(INPUT_FAIL.notAware, 'DPI 感知声明失败，没发输入');
    }
    if ((seg.stdout || '').includes('result=move_failed')) {
      return stop(INPUT_FAIL.callFailed, '拖拽途中移动事件没发出去');
    }
    if (!(seg.stdout || '').includes('result=moved')) {
      return stop(INPUT_FAIL.callFailed, `拖拽没走动：${(seg.stdout || '').slice(0, 200)}`);
    }
    // ★ 段后核对光标真的到了：这台机器上有程序在合成鼠标输入（issue #34），
    //   移动事件可以返回成功、光标却被拉回 —— 不核对就会“报告成功但没拖到”。
    const last = batch[batch.length - 1];
    moved = i + batch.length;
    const at = (seg.stdout || '').match(/at=(-?\d+),(-?\d+)/);
    const actual = at
      ? { x: Number(at[1]), y: Number(at[2]) }
      : { x: Number(last.x), y: Number(last.y) };
    if (Math.abs(actual.x - Number(last.x)) > 2 || Math.abs(actual.y - Number(last.y)) > 2) {
      return stop(
        INPUT_FAIL.callFailed,
        `拖到第 ${moved}/${stops.length} 站时光标没到位`
        + `（要到 (${last.x},${last.y})，实际 (${actual.x},${actual.y})）`
        + ' —— 这台机器上可能有程序在合成鼠标输入',
      );
    }
    // ★ 顺序不能反：先报位置（上层据此更新“鼠标该在哪”），再问要不要停。
    //   反过来的话上层还拿着上一段的位置去比光标，会把自己刚走的一段误判成用户接管。
    // ★ 报的是**实测**坐标，不是理论站号：平台允许 ±2px，报理论值会让装配层
    //   把 1~2px 的正常抖动当成“用户动了鼠标”，然后中止拖拽并吊销租约。
    if (typeof onStep === 'function') onStep({ at: actual, index: moved, total: stops.length });
    if (typeof shouldAbort === 'function') {
      const verdict = shouldAbort({ at: last, index: moved, total: stops.length });
      if (verdict) return stop(verdict.code || INPUT_FAIL.yielded, verdict.text || '拖拽被中断');
    }
  }

  // ③ 抬起（终点已经在 stops 里走过了）
  if (!up()) {
    return {
      ok: false,
      code: INPUT_FAIL.callFailed,
      text: `拖到终点了，但${heldName}松开失败 —— 请手动点一下${heldName}确认已松开`,
      released: false,
    };
  }
  // ★ 抬起后再看一眼光标：本机上实测过“段校都通过了、抬起时位置却被拉走”（issue #34
  //   的那种合成输入）。消息已经发出去了，撤回不了 —— 所以这不算失败，但必须
  //   如实告诉上层“落在哪儿”，而不是回一个理想的终点。
  const cur = cursorPosition();
  const at = cur?.ok ? { x: Number(cur.x), y: Number(cur.y) } : { x: Number(plan.to.x), y: Number(plan.to.y) };
  const drifted = cur?.ok
    && (Math.abs(at.x - Number(plan.to.x)) > 2 || Math.abs(at.y - Number(plan.to.y)) > 2);
  return {
    ok: true,
    at,
    foreground,
    released: true,
    drifted,
    note: drifted
      ? `松开时光标在 (${at.x},${at.y})，不在终点 (${plan.to.x},${plan.to.y}) —— `
        + '这台机器上可能有程序在合成鼠标输入，拖拽结果要重新观察一次'
      : '',
  };
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

/**
 * 采样一次「输入噪声」：连续读几遍 `GetLastInputInfo`，看这台机器是不是**一直在产生输入**。
 *
 * ## 为什么需要这个
 *
 * 本机实测踩到的真实情况：装着一个远程控制工具（GameViewer），它持续合成输入。
 * 连续四次采样的 idle 分别是 0 / 93 / 0 / 15 ms —— `GetLastInputInfo` 永远报
 * "刚刚有人在动"。
 *
 * 后果：接管检测（`desktop-takeover.js`）在"我们还没注入过"那一支里保守地判
 * `user_active`，于是**这台机器上第一次输入永远发不出去**，而错误文案说的是
 * "用户在动" —— 用户本人根本没动，他会以为是自己鼠标碰了一下，然后反复重试。
 *
 * 所以探针要能自己说清楚"这里不是用户在手一动，是环境里有东西一直在合成输入"。
 * 工具层拿到这个结论就能给出正确的下一步（换掉/关闭那个程序，或者由用户明确
 * 决定要不要"信任这个桌面"—— 那是产品决策，不在这里偷偷放宽）。
 *
 * ## 判据
 *
 * 连续采样 `samples` 次（默认 5，间隔 120ms），满足两件事才判 `phantom`：
 *
 *   · **噪声**：超过一半采样 `idleMs < quietMs`（默认 250）
 *   · **光标没动**：全程 `GetCursorPos` 读到同一个点
 *
 * 第二条让诊断更硬：会重置 `GetLastInputInfo` 的东西不少（远程控制心跳、
 * 驱动、输入法候选窗），但真正"有人在用鼠标"必定移动光标。光标不动却一直
 * 报"刚有输入"，就是合成输入，不是人在操作界面。
 *
 * 为什么不是"全部"：本机实测是 `15 / 172 / 625 / 250 / 703` —— 前两次明显是
 * 合成输入，后三次只是采样被系统拖慢了。用 every 会得出"没问题"的错误结论，
 * 因为它把"采样慢"当成了"没人动"。用人不会以毫秒级精度连续动输入这一点判方向，
 * 用"多数"抗住偶发的调度抖动。
 *
 * @param {object} [o]
 * @param {number} [o.samples]
 * @param {number} [o.intervalMs]
 * @param {number} [o.quietMs]
 * @returns {{ok:true, phantom:boolean, samples:number[], min:number, max:number}
 *   | {ok:false, code:string, text:string}}
 */
export function sampleInputNoise({ samples = 5, intervalMs = 120, quietMs = 250 } = {}) {
  if (!isSupported()) {
    return { ok: false, code: INPUT_FAIL.notPlatform, text: `当前平台（${process.platform}）没有 Windows 输入探针` };
  }
  const n = Math.max(2, Math.min(20, Math.trunc(Number(samples) || 5)));
  const gaps = [];
  const cursors = [];
  for (let i = 0; i < n; i += 1) {
    const r = lastInputAt();
    if (!r.ok) return r;
    gaps.push(Math.max(0, Math.round(Number(r.idleMs) || 0)));
    const c = cursorPosition();
    if (!c.ok) return c;
    cursors.push({ x: c.x, y: c.y });
    if (i < n - 1) sleepMs(intervalMs);
  }
  // ★ 光标全程没动 = 这批"输入"没有真的在指东西。
  //   合成输入的常见来源（远程控制心跳、驱动、输入法候选窗）会重置
  //   GetLastInputInfo 但不移动光标。这条证据让诊断更硬：
  //   "有人在动鼠标"和"有东西在合成输入"是两种完全不同的处理方式。
  const cursorStill = cursors.every((c) => c.x === cursors[0].x && c.y === cursors[0].y);
  // ★ 判据是"最常见的那一档"而不是 every：只要**一半以上**采样都挤在
  //   quietMs 以内，就说明有东西在持续合成输入。用 every 太容易被一次
  //   正常间隔否掉（本机实测 15/172/625/250/703 —— 前两次明显是合成的，
  //   后三次只是程序忙起来采样变慢，every 会判"没问题"）。
  // 判据（噪声/光标是否在动）是**纯逻辑**，在 desktop-input.js 里 ——
  // 平台只负责采样。这样两个平台共用同一套判断，也不会出现
  // "Windows 判 phantom、macOS 判 moving"这种漂移。
  const cls = classifyInputNoise({ gaps, cursors, quietMs });
  return {
    ok: true,
    kind: cls.kind,
    phantom: cls.kind === 'phantom',
    noisy: cls.noisy,
    cursorStill: cls.cursorStill,
    samples: gaps,
    cursor: cursors[0],
    min: Math.min(...gaps),
    max: Math.max(...gaps),
  };
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
    knownIssue: '装着持续合成输入的程序（远程控制/驱动）时 GetLastInputInfo 永远报"刚刚有人动"，'
      + '接管检测会一直让开。用 sampleInputNoise() 能区分这种环境与真人操作。',
  };
}
