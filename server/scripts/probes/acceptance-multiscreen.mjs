/**
 * 实机验收 #32：多屏 / 混合缩放。
 *
 *   cd server && node scripts/probes/acceptance-multiscreen.mjs
 *
 * 对应 `docs/acceptance-matrix.md` §1「电脑操作」里的
 *   「多屏 / 混合缩放不盲点」那一行（现在状态是 `静态`，跑完填 `实机 ✓/✗`）。
 *
 * 它验两件事：
 *   1. **屏幕矩形是从系统拿的，不是猜的**：直接枚举显示器，列出每块的
 *      矩形与 DPI，再和 `probeEnvironment()` 给的虚拟屏对照；
 *   2. **点在屏外/屏内判定与系统一致**：在每块屏的中心规划一次 move（应当通过），
 *      再给一个明确的屏外点（应当被 `out_of_screen` 拒绝，且**不夹到边缘**）。
 *
 * 只有一块显示器时会明确打印“多屏项跳过”，不假装通过 —— 混合缩放这一项
 * 必须有第二块屏（最好是不同缩放）才算有证据。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const P = await import(new URL('../../src/desktop-input.js', import.meta.url));
const W = await import(new URL('../../src/desktop-input-win.js', import.meta.url));

if (process.platform !== 'win32') {
  console.log('（非 Windows，跳过）');
  process.exit(0);
}

const ENUM_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Mon {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, Proc proc, IntPtr data);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint x, out uint y);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hmon, ref MONITORINFO mi);
  public delegate bool Proc(IntPtr h, IntPtr hdc, ref RECT r, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
  }
  public static List<string> List() {
    var outp = new List<string>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr h, IntPtr hdc, ref RECT r, IntPtr d) => {
      var mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      string work = "";
      if (GetMonitorInfo(h, ref mi)) {
        work = mi.rcWork.left + "," + mi.rcWork.top + "," + mi.rcWork.right + "," + mi.rcWork.bottom;
      }
      uint dx = 0, dy = 0;
      int hr = GetDpiForMonitor(h, 0, out dx, out dy);   // 0 = MDT_EFFECTIVE_DPI
      outp.Add(r.left + "," + r.top + "," + r.right + "," + r.bottom + "|" + dx + "|" + work + "|" + hr);
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
"@
[void][Mon]::SetProcessDpiAwarenessContext([IntPtr](-4))
foreach ($line in [Mon]::List()) { Write-Output ("mon=" + $line) }
`;

const res = spawnSync('powershell', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ENUM_PS,
], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
if (res.error || res.status !== 0) {
  console.error(`✗ 枚举显示器失败：${res.error?.message || res.stderr || `exit ${res.status}`}`);
  process.exit(1);
}

const monitors = [];
for (const line of (res.stdout || '').split(/\r?\n/)) {
  const m = line.match(/^mon=(-?\d+),(-?\d+),(-?\d+),(-?\d+)\|(\d+)\|(.*?)\|(-?\d+)$/);
  if (!m) continue;
  const left = Number(m[1]);
  const top = Number(m[2]);
  const right = Number(m[3]);
  const bottom = Number(m[4]);
  const dpi = Number(m[5]);
  const work = m[6] ? m[6].split(',').map(Number) : null;
  monitors.push({
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    dpi,
    scalePct: Math.round((dpi / 96) * 100),
    work: work && work.length === 4
      ? { x: work[0], y: work[1], width: work[2] - work[0], height: work[3] - work[1] }
      : null,
    dpiHr: Number(m[7]),
  });
}

console.log(`枚举到 ${monitors.length} 块显示器：`);
for (const [i, mon] of monitors.entries()) {
  const r = mon.rect;
  console.log(
    `  #${i + 1} 矩形 ${r.width}x${r.height} @ (${r.x},${r.y})`
    + ` DPI ${mon.dpi}（${mon.scalePct}%）`
    + (mon.work ? ` 工作区 ${mon.work.width}x${mon.work.height}` : ''),
  );
}

const env = W.probeEnvironment();
if (!env.ok) {
  console.error(`✗ 探环境失败：${env.text}`);
  process.exit(1);
}
console.log(`probeEnvironment()：屏幕 ${env.screen.width}x${env.screen.height} @ (${env.screen.x},${env.screen.y})，DPI ${env.dpi}，会话 ${env.session}`);

const problems = [];
// 虚拟屏应当覆盖所有显示器的并集
const union = monitors.reduce((acc, m) => {
  if (!acc) return { ...m.rect };
  const x1 = Math.min(acc.x, m.rect.x);
  const y1 = Math.min(acc.y, m.rect.y);
  const x2 = Math.max(acc.x + acc.width, m.rect.x + m.rect.width);
  const y2 = Math.max(acc.y + acc.height, m.rect.y + m.rect.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}, null);
if (union && (union.x !== env.screen.x || union.y !== env.screen.y
  || union.width !== env.screen.width || union.height !== env.screen.height)) {
  problems.push(
    `虚拟屏 ${env.screen.width}x${env.screen.height}@(${env.screen.x},${env.screen.y})`
    + ` 与显示器并集 ${union.width}x${union.height}@(${union.x},${union.y}) 不一致`,
  );
}

// 每块屏的中心：规划必须通过；光标真的移过去且读回一致
for (const [i, mon] of monitors.entries()) {
  const r = mon.rect;
  const center = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  const planned = P.planInput({ action: 'move', point: center, screen: env.screen });
  if (!planned.ok) {
    problems.push(`#${i + 1} 中心点 ${center.x},${center.y} 规划被拒：${planned.text}`);
    continue;
  }
  const sent = W.perform({ plan: planned.plan });
  if (!sent.ok) {
    problems.push(`#${i + 1} 中心点移动失败：${sent.text}`);
    continue;
  }
  const cur = W.cursorPosition();
  if (!cur.ok || Math.abs(cur.x - center.x) > 2 || Math.abs(cur.y - center.y) > 2) {
    problems.push(`#${i + 1} 光标没到 ${center.x},${center.y}（实际 ${cur.x},${cur.y}）`);
  }
  // 屏外点：必须被拒，且不能被夹到边缘后照点
  const outside = { x: env.screen.x - 50, y: center.y };
  const rejected = P.planInput({ action: 'move', point: outside, screen: env.screen });
  if (rejected.ok) problems.push(`屏外点 ${outside.x},${outside.y} 居然被放行（应 out_of_screen）`);
}

console.log('');
if (monitors.length < 2) {
  console.log('⚠ 只有一块显示器 —— 多屏/混合缩放这一项**没有拿到证据**（需要接第二块屏，最好是不同缩放）。');
  console.log('  已验：屏幕矩形与显示器并集一致、中心点可达、屏外点被拒。');
} else {
  const scales = new Set(monitors.map((m) => m.scalePct));
  console.log(`已验 ${monitors.length} 块屏：矩形、每块屏中心点可点、屏外点被拒。`);
  console.log(scales.size > 1
    ? `缩放混合：${[...scales].join('% / ')}% —— 混合缩放场景已覆盖。`
    : `所有屏缩放相同（${[...scales][0]}%）—— 混合缩放还没覆盖，换一块不同缩放的屏再跑。`);
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('MATCH true');
