/**
 * 实机验收 #31：锁屏 / 断开会话后的桌面输入（交互式，会占你约 30 秒）。
 *
 *   cd server && node scripts/probes/acceptance-lock-screen.mjs
 *
 * 对应 `docs/acceptance-matrix.md` §1「电脑操作」里的「锁屏后不盲点」
 * （现在状态 `静态`），以及 §2「桌面调度」的恢复语义。
 *
 * 它**不是**在测某个纯函数，而是走真实的 `desktop-input-session`：
 *
 *   1. 申请租约 + 发一次正常移动 —— 证明“锁屏前这条路是通的”；
 *   2. 提示你按 Win+L（脚本用平台探针轮询到 session 变 false 为止）；
 *   3. 在**锁屏状态下**再发一次输入 —— 期望 `no_session`，且租约当场被吊销
 *      （规格 §5.4：「暂停输入并释放租约，恢复后重新观察」）；
 *   4. 提示你解锁，脚本等到会话恢复，再验证“解锁后必须重新申请租约”。
 *
 * 任何一步不符合预期都打印 ✗ 并以非零码退出，输出可以直接贴进验收表。
 */
import {
  desktopInputSession, desktopInputPlatform, resetDesktopInputSession,
} from '../../src/desktop-input-session.js';

if (process.platform !== 'win32') {
  console.log('（非 Windows，跳过）');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const taskId = 'acceptance-lock-screen';
const botId = 'acceptance-bot';
const problems = [];
const POINT = { x: 12, y: 12 }; // 屏幕左上角，移动没有副作用

resetDesktopInputSession();
const session = desktopInputSession();
const platform = desktopInputPlatform();
const envOf = () => platform.probeEnvironment();

// ────────────────────────────── 1. 锁屏前：证明链路可用
const lease = session.acquireLease({ taskId, botId });
if (!lease.ok) {
  console.error(`✗ 拿不到桌面租约：${lease.text ?? lease.code} —— 先结束别的在用桌面的任务`);
  process.exit(1);
}
console.log(`租约已拿到（epoch ${lease.epoch}）`);

const before = session.act({
  identity: { taskId, botId, epoch: lease.epoch },
  input: { action: 'move', point: POINT },
});
if (!before.ok) {
  console.error(`✗ 锁屏前的一次移动就失败了：${before.code} ${before.text}`);
  process.exit(1);
}
console.log('锁屏前的一次移动：OK（这条路本来是通的）');

// ────────────────────────────── 2. 等用户锁屏
console.log('');
console.log('请在 20 秒内按 **Win+L** 锁屏。锁上之后不用回来，脚本自己继续。');
console.log('不想测就 Ctrl+C，这一项记「未做」。');
let locked = false;
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  const env = envOf();
  if (env.ok && env.session === false) {
    locked = true;
    break;
  }
}
if (!locked) {
  console.error('');
  console.error('✗ 20 秒内没检测到锁屏。这一项没有证据，保持「未做」。');
  process.exit(2);
}

// ────────────────────────────── 3. 锁屏状态下发输入：必须拒绝 + 吊销租约
console.log('');
console.log('检测到锁屏，现在在锁屏状态下试着发一次输入……');
const during = session.act({
  identity: { taskId, botId, epoch: lease.epoch },
  input: { action: 'move', point: POINT },
});
console.log(`  → ${during.ok ? 'ok（不该发生！）' : `${during.code}：${during.text}`}`);
if (during.ok) problems.push('锁屏状态下居然发出了输入（这是安全底线）');
if (during.code !== 'no_session') problems.push(`期望 no_session，实际 ${during.code}`);
if (session.lease.status === 'held') problems.push('锁屏时租约没有被吊销（应立刻释放）');
else console.log(`  租约状态：${session.lease.status}（已释放 ✓）`);

// ────────────────────────────── 4. 等解锁
console.log('');
console.log('请解锁。脚本会等会话恢复……');
let unlocked = false;
for (let i = 0; i < 240; i += 1) {
  await sleep(500);
  const env = envOf();
  if (env.ok && env.session === true) {
    unlocked = true;
    break;
  }
}
if (!unlocked) {
  console.error('✗ 没等到会话恢复（超时 2 分钟）。');
  process.exit(3);
}
console.log('会话已恢复。');

// ────────────────────────────── 5. 解锁后必须重新申请租约
const reacquired = session.acquireLease({ taskId, botId });
if (!reacquired.ok) {
  problems.push(`解锁后重新申请租约失败：${reacquired.text ?? reacquired.code}`);
} else {
  console.log(`解锁后重新申请租约：OK（epoch ${reacquired.epoch}）`);
  const again = session.act({
    identity: { taskId, botId, epoch: reacquired.epoch },
    input: { action: 'move', point: POINT },
  });
  if (!again.ok) problems.push(`解锁后重新拿到租约仍发不出输入：${again.code} ${again.text}`);
  else console.log('解锁后重新输入：OK');
  session.releaseLease({ taskId, reason: '验收结束' });
}

console.log('');
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('LOCK_NO_SESSION true');
console.log('LEASE_RELEASED_ON_LOCK true');
console.log('REACQUIRE_AFTER_UNLOCK true');
