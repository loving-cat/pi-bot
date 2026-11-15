/**
 * 桌面租约的测试（规格 P0-3b / §5.2「同一桌面调度」）。
 *   node tests/desktop-lease.mjs
 *
 * 守的是规格 §5.2 那几句硬话：
 *
 *   · 「同一 OS 桌面会话只有一个能注入输入的租约」→ 第二个任务排队，不报错
 *   · 「租约属于任务，不属于进程全局的当前 Bot」→ 换了 bot 也不行
 *   · 「租约有到期、心跳和世代号」→ 过期 / 心跳超时 / epoch 不符都拒
 *   · 「旧持有者恢复后不能用旧租约继续输入」→ 带旧 epoch 一律 stale
 *   · 「用户显式接管立即吊销租约、丢弃尚未执行输入」→ revoke 后输入全拒
 *   · 「按键释放、拖拽中断和超时恢复纳入验收」→ sweep 回收僵住的租约
 *
 * 这些全是纯逻辑，不需要真机。平台实现（SendInput / CGEvent）另做，
 * 而且必须共用这一套判定 —— 否则会出现「Windows 严格、macOS 宽松」的漂移。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-'));
Object.assign(process.env, {
  PI_BOT_HOME: path.join(root, 'data'),
  PI_BOT_WORKSPACE: path.join(root, 'ws'),
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_PROBE: '0',
});
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const L = await import(new URL('../src/desktop-lease.js', import.meta.url));
const {
  LEASE, DENY, createLeaseState, checkLease, acquire, renew, release, revoke,
  assertHolder, sweep, queuePosition, describeLease,
  DEFAULT_TTL_MS, DEFAULT_HEARTBEAT_MS, MAX_QUEUE,
} = L;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const T0 = 1_700_000_000_000;
const opts = (over = {}) => ({ now: T0, generation: 'gen-1', ...over });

// ---------------------------------------------------------------- 基本占有
test('空闲时第一次申请就拿到，epoch 从 0 → 1', () => {
  const s = createLeaseState();
  assert.equal(s.status, LEASE.idle);
  const r = acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  assert.equal(r.ok, true);
  assert.equal(r.epoch, 1);
  assert.equal(s.status, LEASE.held);
  assert.equal(s.taskId, 'tr_a');
  assert.equal(s.botId, 'b_a');
  assert.equal(s.generation, 'gen-1');
  assert.equal(checkLease(s, opts()).ok, true);
});

test('★ 同一桌面只有一个租约：第二个任务排队，不报错', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  const r = acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts() });
  assert.equal(r.ok, false);
  assert.equal(r.code, DENY.busy);
  assert.equal(r.queued, true);
  assert.equal(r.position, 1, '排队时应当告诉它排第几');
  assert.equal(queuePosition(s, { taskId: 'tr_b' }), 1);
  // 持有者没被换掉
  assert.equal(s.taskId, 'tr_a');
});

test('重复申请不重复入队（轮询式调用不能把队列撑爆）', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  for (let i = 0; i < 20; i++) acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts() });
  assert.equal(s.queue.length, 1);
});

test('队列有上限，满了明确说清楚（不静默丢弃）', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_owner', botId: 'b', ...opts() });
  for (let i = 0; i < MAX_QUEUE; i++) {
    acquire(s, { taskId: `tr_q${i}`, botId: 'b', ...opts() });
  }
  assert.equal(s.queue.length, MAX_QUEUE);
  const denied = acquire(s, { taskId: 'tr_overflow', botId: 'b', ...opts() });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, DENY.busy);
  assert.match(denied.text, /排队也是满的/);
});

test('持有者自己再申请 = 续期，不动 epoch', () => {
  const s = createLeaseState();
  const first = acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  const again = acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts({ now: T0 + 5000 }) });
  assert.equal(again.ok, true);
  assert.equal(again.renewed, true);
  assert.equal(again.epoch, first.epoch, '自己续期不该推进世代，否则自己的下一次输入就被当成旧世代');
});

// ---------------------------------------------------------------- 世代号
test('★ 带旧 epoch 的输入一律拒（规格「旧持有者恢复后不能用旧租约继续输入」）', () => {
  const s = createLeaseState();
  const a = acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  assert.equal(assertHolder(s, { taskId: 'tr_a', botId: 'b_a', epoch: a.epoch, ...opts() }).ok, true);
  // 租约被抢占（A 过期 → B 拿到，epoch +1）
  const b = acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts({ now: T0 + DEFAULT_TTL_MS + 1 }) });
  assert.equal(b.ok, true);
  // A 用旧 epoch 继续输入 —— 必须拒
  const stale = assertHolder(s, { taskId: 'tr_a', botId: 'b_a', epoch: a.epoch, ...opts({ now: T0 + DEFAULT_TTL_MS + 2 }) });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, DENY.notHolder, '首先它已经不是持有者了');
  // 即使它自称是新持有者，epoch 也不对
  const wrongEpoch = assertHolder(s, { taskId: 'tr_b', botId: 'b_b', epoch: a.epoch, ...opts({ now: T0 + DEFAULT_TTL_MS + 2 }) });
  assert.equal(wrongEpoch.ok, false);
  assert.equal(wrongEpoch.code, DENY.staleEpoch);
});

test('抢占会推进 epoch（转让一次 +1）', () => {
  const s = createLeaseState();
  const a = acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  release(s, { taskId: 'tr_a', ...opts() });
  const b = acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts() });
  assert.equal(b.epoch, a.epoch + 1);
});

test('release 不重置 epoch（重置会让旧持有者的 epoch 意外撞上）', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  const before = s.epoch;
  release(s, { taskId: 'tr_a', ...opts() });
  assert.equal(s.epoch, before);
  assert.equal(s.status, LEASE.idle);
});

// ---------------------------------------------------------------- 到期与心跳
test('★ 硬到期后不再有效，且新任务可以直接拿走', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts({ ttlMs: 10_000 }) });
  assert.equal(checkLease(s, opts({ now: T0 + 9_000, ttlMs: 10_000 })).ok, true);
  const expired = checkLease(s, opts({ now: T0 + 10_000, ttlMs: 10_000 }));
  assert.equal(expired.ok, false);
  assert.equal(expired.code, DENY.expired);
  const takeOver = acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts({ now: T0 + 10_000, ttlMs: 10_000 }) });
  assert.equal(takeOver.ok, true, '过期后别人应当能直接拿走，不该卡住');
});

test('★ 心跳超时也算失效（持有者进程可能已经死了）', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts({ ttlMs: 600_000, heartbeatMs: 5_000 }) });
  const dead = checkLease(s, opts({ now: T0 + 6_000, ttlMs: 600_000, heartbeatMs: 5_000 }));
  assert.equal(dead.ok, false);
  assert.equal(dead.code, DENY.expired);
  assert.match(dead.text, /心跳超时/);
});

test('心跳续期能一直撑住（长任务不该被硬到期打断）', () => {
  const s = createLeaseState();
  const a = acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts({ ttlMs: 10_000, heartbeatMs: 5_000 }) });
  let now = T0;
  for (let i = 0; i < 5; i++) {
    now += 4_000;
    const r = renew(s, { taskId: 'tr_a', botId: 'b_a', epoch: a.epoch, ...opts({ now, ttlMs: 10_000, heartbeatMs: 5_000 }) });
    assert.equal(r.ok, true, `第 ${i + 1} 次心跳失败：${r.text}`);
  }
  assert.equal(checkLease(s, opts({ now, ttlMs: 10_000, heartbeatMs: 5_000 })).ok, true);
});

test('★ 被抢占过的持有者拿旧 epoch 续不了期（这是最容易漏的一条）', () => {
  const s = createLeaseState();
  const a = acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts({ ttlMs: 10_000 }) });
  acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts({ now: T0 + 20_000, ttlMs: 10_000 }) });
  const revive = renew(s, { taskId: 'tr_a', botId: 'b_a', epoch: a.epoch, ...opts({ now: T0 + 20_001, ttlMs: 10_000 }) });
  assert.equal(revive.ok, false);
});

// ---------------------------------------------------------------- 释放与交接
test('释放把租约交给队列第一个等待者，并且告诉上层该唤醒谁', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts() });
  acquire(s, { taskId: 'tr_c', botId: 'b_c', ...opts() });
  const r = release(s, { taskId: 'tr_a', ...opts() });
  assert.equal(r.next?.taskId, 'tr_b', 'FIFO：先来的先拿');
  assert.equal(s.status, LEASE.idle);
  assert.equal(queuePosition(s, { taskId: 'tr_c' }), 1, 'C 往前挪了一位');
});

test('非持有者不能释放别人的租约', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  const r = release(s, { taskId: 'tr_b', ...opts() });
  assert.equal(r.ignored, true);
  assert.equal(s.taskId, 'tr_a', 'A 的租约不该被 B 释放');
});

// ---------------------------------------------------------------- 用户接管
test('★ 用户接管：立刻吊销，输入全拒，排队者一并清掉', () => {
  const s = createLeaseState();
  const a = acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts() });
  const r = revoke(s, { reason: '用户动了鼠标', by: 'user', ...opts() });
  assert.equal(r.ok, true);
  assert.equal(r.dropped, 1, '排队者也该清掉');
  assert.equal(s.status, LEASE.revoking);

  // 持有者下一次输入必须被拒 —— 即使 epoch 它自己记对了（epoch 已被推进）
  const after = assertHolder(s, { taskId: 'tr_a', botId: 'b_a', epoch: a.epoch, ...opts() });
  assert.equal(after.ok, false);
  assert.ok([DENY.revoked, DENY.staleEpoch].includes(after.code), `实际 ${after.code}`);
  assert.match(describeLease(s, opts()), /吊销/);
});

test('吊销后新任务可以直接拿走（不会卡在 revoking）', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  revoke(s, { reason: '用户接管', ...opts() });
  const next = acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts() });
  assert.equal(next.ok, true);
  assert.equal(s.status, LEASE.held);
  assert.equal(s.revokedReason, '', '新租约不该背着上一个的吊销原因');
});

test('空闲时吊销只清队列，不制造一个假租约', () => {
  const s = createLeaseState();
  const r = revoke(s, { reason: '空跑', ...opts() });
  assert.equal(r.ok, true);
  assert.equal(s.status, LEASE.idle);
  assert.equal(s.taskId, null);
});

// ---------------------------------------------------------------- 实例世代
test('★ 进程重启后旧租约作废（规格 §6.3「后台任务不得续接旧权限」）', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts({ generation: 'gen-old' }) });
  const stale = checkLease(s, opts({ generation: 'gen-new' }));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, DENY.expired);
  assert.match(stale.text, /上一个实例/);
});

// ---------------------------------------------------------------- 回收
test('sweep 回收僵住的租约并把位置让给下一个', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts({ ttlMs: 10_000 }) });
  acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts({ ttlMs: 10_000 }) });
  const r = sweep(s, opts({ now: T0 + 20_000, ttlMs: 10_000 }));
  assert.equal(r.released?.taskId, 'tr_a');
  assert.equal(r.next?.taskId, 'tr_b');
  assert.equal(s.status, LEASE.idle);
});

test('sweep 对健康租约什么都不做（不能误杀正在干活的）', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  const r = sweep(s, opts({ now: T0 + 1_000 }));
  assert.equal(r.released, null);
  assert.equal(s.status, LEASE.held);
  assert.equal(s.taskId, 'tr_a');
});

// ---------------------------------------------------------------- 参数校验
test('没有任务或没有 bot 不许申请（租约必须绑定到具体主体）', () => {
  const s = createLeaseState();
  assert.equal(acquire(s, { botId: 'b', ...opts() }).code, DENY.invalid);
  assert.equal(acquire(s, { taskId: 'tr_a', ...opts() }).code, DENY.invalid);
  assert.equal(acquire(s, { taskId: 'tr_a', botId: 'b' }).ok, true, '不传 now 应当回退到 Date.now()');
});

test('没有租约时 assertHolder 明确报 no_lease（不是静默放行）', () => {
  const s = createLeaseState();
  const r = assertHolder(s, { taskId: 'tr_a', botId: 'b', epoch: 1, ...opts() });
  assert.equal(r.ok, false);
  assert.equal(r.code, DENY.noLease);
});

// ---------------------------------------------------------------- 描述
test('describeLease 说清谁在持有、还剩多久、几个人排队', () => {
  const s = createLeaseState();
  acquire(s, { taskId: 'tr_a', botId: 'b_a', ...opts() });
  acquire(s, { taskId: 'tr_b', botId: 'b_b', ...opts() });
  const text = describeLease(s, opts({ now: T0 + 1000 }));
  assert.match(text, /b_a/);
  assert.match(text, /tr_a/);
  assert.match(text, /epoch 1/);
  assert.match(text, /排队/);
  assert.equal(describeLease(createLeaseState(), opts()), '桌面空闲');
});

test('默认时长是"能干活但不过度霸占"的量级', () => {
  assert.ok(DEFAULT_TTL_MS >= 30_000 && DEFAULT_TTL_MS <= 10 * 60_000, `TTL=${DEFAULT_TTL_MS}`);
  assert.ok(DEFAULT_HEARTBEAT_MS < DEFAULT_TTL_MS, '心跳必须比到期更频繁，否则一定误杀');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
