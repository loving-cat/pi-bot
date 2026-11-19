/**
 * 实机探针：拖拽真的能拖、中断真的会松开。
 *
 *   cd server && node scripts/probes/desktop-input-drag-probe.mjs
 *
 * 这个探针解决的问题：单元测试里的平台是假的 —— 它能证明"装配层把
 * shouldAbort 交下去了"，但证明不了两件真机上才成立的事：
 *
 *   1. Windows 真的按"按住 → 分步移动 → 抬起"收到了鼠标事件
 *      （一步到位的 SetCursorPos 在多数窗口里根本进不了拖拽状态：
 *      实测靶子窗口只收到 down/up，中间一条 move 都没有）；
 *   2. **中断时鼠标真的被松开了** —— 半截实现会在用户桌面上留一只
 *      按着不放的手，这比不实现拖拽危险得多。
 *
 * 做法：拉起一个置顶靶子窗口（desktop-input-drag-target.ps1），它把收到的
 * DOWN / MOVE / UP（物理坐标）逐条写进 %TEMP%\pib-drag-log.txt，然后：
 *
 *   A. 拖一次完整的：验证 down@起点、≥3 条 move、up@终点；
 *   B. 拖到第 4 站时报中断（模拟用户接管）：验证 down 之后仍然出现 up。
 *
 * 靶子窗口固定在 (200,150) 900x700，所以拖拽坐标都是窗口内的死坐标。
 * 探针跑完会自己关掉窗口，不会留在桌面上。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const targetScript = path.join(here, 'desktop-input-drag-target.ps1');
const logPath = path.join(os.tmpdir(), 'pib-drag-log.txt');

const P = await import(new URL('../../src/desktop-input.js', import.meta.url));
const W = await import(new URL('../../src/desktop-input-win.js', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (process.platform !== 'win32') {
  console.log('（非 Windows，跳过：这个探针只验 Windows 实现）');
  process.exit(0);
}

fs.rmSync(logPath, { force: true });
const ps = spawn('powershell', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', targetScript,
], { windowsHide: false, stdio: 'ignore' });

// 等靶子把 ready 写下来（那时窗口还没显示），窗口出现并激活要再等一会儿
for (let i = 0; i < 60; i += 1) {
  if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('ready')) break;
  await sleep(250);
}
if (!fs.existsSync(logPath)) fail('靶子窗口没起来（没有 pib-drag-log.txt）');
await sleep(1500);

const env = W.probeEnvironment();
if (!env.ok) fail(`探环境失败：${env.text}`);
if (!env.session) fail('当前没有可操作会话（锁屏？）—— 先解锁再跑');

// ★ 先看一眼这台机器的鼠标噪声：有程序一直在合成输入时（issue #34），
//   拖拽探针的结论就不可信 —— 得先把这件事说出来，而不是把它当成代码 bug。
const noise = W.sampleInputNoise({ samples: 3, intervalMs: 120, quietMs: 200 });
if (noise?.ok && noise.synthetic) {
  console.log(`⚠ 本机有持续合成鼠标输入的源（${noise.reason || 'noise'}）—— 拖拽实机结论不可信，先看下面具体现象`);
}

const readLines = () => fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
const parse = (line) => {
  const m = line.match(/^(down|move|up) .*cursor=(-?\d+),(-?\d+)/);
  return m ? { kind: m[1], x: Number(m[2]), y: Number(m[3]) } : null;
};
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

// ────────────────────────────── A. 完整拖拽
const from = { x: 350, y: 320 };
const to = { x: 850, y: 700 };
const planA = P.planInput({ action: 'drag', point: from, to, screen: env.screen });
if (!planA.ok) fail(`规划失败：${planA.text}`);
const markA = readLines().length;
const a = W.performDrag({ plan: planA.plan });
await sleep(400);

// ────────────────────────────── B. 中断必松开
// 不用真用户动鼠标：shouldAbort 在第 4 站返回中止，等价于上层发现用户接管。
const markB = readLines().length;
let abortedAt = null;
const planB = P.planInput({
  action: 'drag', point: { x: 400, y: 400 }, to: { x: 900, y: 760 }, screen: env.screen,
});
if (!planB.ok) fail(`规划失败（B）：${planB.text}`);
const b = W.performDrag({
  plan: planB.plan,
  shouldAbort: ({ index }) => {
    if (index >= 4) {
      abortedAt = index;
      return { code: 'yielded', text: '模拟：用户接管了鼠标' };
    }
    return null;
  },
});
await sleep(400);

ps.kill();
await sleep(200);

// ────────────────────────────── 核对
const lines = readLines();
const segA = lines.slice(markA, markB).map(parse).filter(Boolean);
const segB = lines.slice(markB).map(parse).filter(Boolean);

const problems = [];
const check = (events, label, { expectOk, expectFinish }) => {
  const downs = events.filter((e) => e.kind === 'down');
  const ups = events.filter((e) => e.kind === 'up');
  const moves = events.filter((e) => e.kind === 'move');
  if (downs.length !== 1) problems.push(`${label}：down 应 1 次，实际 ${downs.length} 次`);
  if (ups.length !== 1) problems.push(`${label}：up 应 1 次，实际 ${ups.length} 次（**鼠标可能没松开**）`);
  if (moves.length < 3) problems.push(`${label}：move 只有 ${moves.length} 条（没到 3 条说明进不了拖拽状态）`);
  if (downs.length === 1 && !(near(downs[0].x, expectOk.x) && near(downs[0].y, expectOk.y))) {
    problems.push(`${label}：按下位置 (${downs[0].x},${downs[0].y}) ≠ 起点 (${expectOk.x},${expectOk.y})`);
  }
  if (expectFinish && ups.length === 1
    && !(near(ups[0].x, expectFinish.x) && near(ups[0].y, expectFinish.y))) {
    problems.push(`${label}：抬起位置 (${ups[0].x},${ups[0].y}) ≠ 终点 (${expectFinish.x},${expectFinish.y})`);
  }
  const kinds = events.map((e) => e.kind).join(',');
  if (!/^down(,move)+,up$/.test(kinds)) problems.push(`${label}：事件顺序不对：${kinds}`);
  return { moves: moves.length, downs, ups };
};

const A = check(segA, 'A 完整拖拽', { expectOk: from, expectFinish: to });
if (!a.ok) problems.push(`A：返回失败 ${a.code} ${a.text}`);

const B = check(segB, 'B 中断拖拽', { expectOk: { x: 400, y: 400 }, expectFinish: null });
if (b.ok) problems.push('B：中断拖拽居然返回成功（应当报中止）');
if (abortedAt === null) problems.push('B：shouldAbort 一次都没被调用');
if (!b.released) problems.push('B：中断返回值没标 released=true');
if (B.ups.length === 1 && !(near(B.ups[0].x, 400, 20) || true)) {
  // 中断位置随段数变化，不硬比较；这里只保证"抬起了"
}

console.log(`A 完整拖拽：${A.moves} 条 move，down=(${A.downs[0]?.x},${A.downs[0]?.y}) up=(${A.ups[0]?.x},${A.ups[0]?.y})`);
console.log(`B 第 ${abortedAt} 站中断：${B.moves} 条 move，up ${B.ups.length} 次，released=${b.released}，code=${b.code}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  if (noise?.ok && noise.synthetic) {
    console.error('（已知环境原因：本机有程序在持续合成鼠标输入，见 issue #34；'
      + '换到干净环境重跑这个探针才算实机证据）');
  }
  process.exit(1);
}
console.log('MATCH true');
console.log('DRAG_OK true');
console.log('RELEASE_ON_ABORT true');
