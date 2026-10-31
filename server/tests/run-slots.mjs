/**
 * 全局运行槽位：并发上限、人的保底位、等待超时、释放幂等。
 *
 * 要守住的性质：
 *   · 上限不能被突破（尤其不能因为重复 release 被突破）
 *   · 人永远优先，且能用到保底位
 *   · 等不到要有结论（超时/取消），不能永远挂着
 */
import assert from 'node:assert/strict';
import { PRIORITY, RunSlots } from '../src/run-slots.js';

let passed = 0;
const checks = [];
function test(name, fn) {
  checks.push([name, fn]);
}

const tick = () => new Promise((r) => setImmediate(r));

test('capacity<=0 表示不限并发，永远拿得到', async () => {
  const slots = new RunSlots({ capacity: 0 });
  assert.equal(slots.unlimited, true);
  const a = await slots.acquire();
  const b = await slots.acquire();
  assert.equal(a.ok && b.ok, true);
  a.release();
  b.release();
});

test('★ 上限内直接放行', async () => {
  const slots = new RunSlots({ capacity: 2, reserve: 0 });
  const a = await slots.acquire();
  const b = await slots.acquire();
  assert.equal(slots.active, 2);
  assert.equal(a.ok && b.ok, true);
  a.release();
  b.release();
  assert.equal(slots.active, 0);
});

test('★ 超出上限要排队，释放后按顺序放行', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  const first = await slots.acquire({ name: 'a' });
  let secondDone = false;
  const second = slots.acquire({ name: 'b' }).then((r) => { secondDone = true; return r; });
  await tick();
  assert.equal(secondDone, false, '超上限必须先排队');
  assert.equal(slots.waiting, 1);
  first.release();
  const r = await second;
  assert.equal(r.ok, true);
  assert.equal(slots.active, 1);
  r.release();
});

test('★★ release 幂等：重复调用不能放大并发上限', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  const a = await slots.acquire();
  a.release();
  a.release();
  a.release();
  assert.equal(slots.active, 0, '重复 release 不能变成负数或多次归还');
  const b = await slots.acquire();
  assert.equal(b.ok, true);
  // 上限仍是 1：第二个必须拿不到（若上限被偷偷放大，它就会直接成功）
  const c = await slots.acquire({ timeoutMs: 20 });
  assert.equal(c.ok, false, '第二个拿到说明上限被放宽了');
  assert.equal(c.reason, 'timeout');
  b.release();
});

test('★★ 人优先：队列里普通活在前，人来了也先给', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  const held = await slots.acquire();
  const order = [];
  const machine = slots.acquire({ priority: PRIORITY.normal, name: 'bot' }).then((r) => { order.push('bot'); return r; });
  await tick();
  const human = slots.acquire({ priority: PRIORITY.human, name: 'user' }).then((r) => { order.push('user'); return r; });
  await tick();
  held.release();
  const got = await human;
  assert.equal(got.ok, true);
  assert.deepEqual(order, ['user'], '人应当先拿到槽');
  got.release();
  const m = await machine;
  m.release();
});

test('★★ 保底位：上限占满时人还能用保底槽，普通活不行', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 1 });
  const a = await slots.acquire();
  assert.equal(slots.free, 0);
  // 普通活拿不到（超时收手）
  const machine = await slots.acquire({ priority: PRIORITY.normal, timeoutMs: 20 });
  assert.equal(machine.ok, false);
  assert.equal(machine.reason, 'timeout');
  // 人拿得到（上限 1 + 保底 1）
  const human = await slots.acquire({ priority: PRIORITY.human });
  assert.equal(human.ok, true, '人必须能用保底位');
  assert.equal(slots.active, 2);
  human.release();
  a.release();
});

test('★ 等不到槽位 → 超时返回 timeout，不静默挂住', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  const held = await slots.acquire();
  const r = await slots.acquire({ timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.ok(r.waitedMs >= 0);
  assert.equal(slots.waiting, 0, '超时要摘出队列');
  held.release();
});

test('★ 取消等待 → 返回 aborted 并出队', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  const held = await slots.acquire();
  const ctl = new AbortController();
  const p = slots.acquire({ timeoutMs: 5000, signal: ctl.signal });
  await tick();
  assert.equal(slots.waiting, 1);
  ctl.abort();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'aborted');
  assert.equal(slots.waiting, 0);
  held.release();
});

test('已经 aborted 的 signal 直接返回，不进队列', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  const held = await slots.acquire();
  const ctl = new AbortController();
  ctl.abort();
  const r = await slots.acquire({ signal: ctl.signal });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'aborted');
  assert.equal(slots.waiting, 0);
  held.release();
});

test('超时后再释放槽位，不会误发给已经超时的等待者', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  const held = await slots.acquire();
  const timedOut = await slots.acquire({ timeoutMs: 15 });
  assert.equal(timedOut.ok, false);
  held.release();
  assert.equal(slots.active, 0, '超时者不该占用槽');
  const next = await slots.acquire();
  assert.equal(next.ok, true);
  next.release();
});

test('非法参数回落到安全默认值', async () => {
  const slots = new RunSlots({ capacity: 'x', reserve: -3 });
  assert.equal(slots.capacity, 0, '非法上限 → 不限并发（不卡死）');
  assert.equal(slots.reserve, 0);
  const r = await slots.acquire();
  assert.equal(r.ok, true);
  r.release();
});

/**
 * ★ 回归：调用方在 try/finally 里用槽位时，即使业务代码抛异常，
 *   槽位也必须回到池子里 —— 否则跑得越多、可用槽越少，服务端等于慢性停摆。
 *   这里用 try/finally 模拟 run() 的结构。
 */
test('★★ 业务抛异常时 finally 归还槽位（run() 的真实使用方式）', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  let ticket = null;
  try {
    ticket = await slots.acquire();
    throw new Error('模拟这一轮跑挂了');
  } catch {
    // 吞掉：这里只关心槽位有没有还
  } finally {
    ticket?.release?.();
  }
  assert.equal(slots.active, 0, '异常路径必须归还槽位');
  // 槽位确实能再次被拿到
  const again = await slots.acquire({ timeoutMs: 50 });
  assert.equal(again.ok, true, '异常之后槽位必须能重新分配');
  again.release();
});

test('★ 拿不到槽位就不该被 release 影响（失败结果不带 release）', async () => {
  const slots = new RunSlots({ capacity: 1, reserve: 0 });
  const held = await slots.acquire();
  const failed = await slots.acquire({ timeoutMs: 15 });
  assert.equal(failed.ok, false);
  assert.equal(failed.release, undefined, '失败结果不该提供 release');
  held.release();
  assert.equal(slots.active, 0);
});

test('等待者能观察到队列长度（用于日志/观测）', async () => {
  const slots = new RunSlots({ capacity: 2, reserve: 0 });
  const held = await slots.acquire();
  const also = await slots.acquire();
  const p1 = slots.acquire({});
  const p2 = slots.acquire({});
  await tick();
  assert.equal(slots.waiting, 2);
  held.release();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  also.release();
  const r2 = await p2;
  assert.equal(r2.ok, true);
  assert.equal(slots.waiting, 0);
  r1.release();
  r2.release();
});

(async () => {
  for (const [name, fn] of checks) {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  }
  console.log(`\n${passed} 项通过`);
})().catch((err) => {
  console.error(`✗ ${err?.message || err}`);
  process.exit(1);
});
