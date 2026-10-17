/**
 * 定时任务测试：排期计算、校验、到点判定、调度器防重入。
 *   node tests/automations.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_automations');
const HOME = process.env.PI_BOT_HOME;
fs.rmSync(HOME, { recursive: true, force: true });

const {
  computeNextRun,
  validateSchedule,
  shouldRun,
  createAutomationScheduler,
  MIN_EVERY_MINUTES,
} = await import('../src/automations.js');
const { store } = await import('../src/store.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

await test('everyMinutes：下一次在 N 分钟之后，且不低于下限', () => {
  const now = Date.now();
  const next = computeNextRun({ everyMinutes: 10 }, now);
  assert.equal(next - now, 10 * 60_000);
  const clamped = computeNextRun({ everyMinutes: 1 }, now);
  assert.equal(clamped - now, MIN_EVERY_MINUTES * 60_000);
});

await test('dailyAt：今天没到就今天，过了就明天', () => {
  const base = new Date(2026, 9, 17, 8, 0, 0).getTime(); // 本地 08:00
  const today = computeNextRun({ dailyAt: '09:30' }, base);
  const t = new Date(today);
  assert.equal(t.getDate(), 17);
  assert.equal(t.getHours(), 9);
  assert.equal(t.getMinutes(), 30);

  const later = new Date(2026, 9, 17, 23, 0, 0).getTime();
  const tomorrow = computeNextRun({ dailyAt: '09:30' }, later);
  assert.equal(new Date(tomorrow).getDate(), 18);
});

await test('非法排期不排（返回 null）', () => {
  assert.equal(computeNextRun({ dailyAt: '9点半' }), null);
  assert.equal(computeNextRun({}), null);
});

await test('校验：间隔太小 / 时间格式错 / 两个都没给', () => {
  assert.match(validateSchedule({ everyMinutes: 1 }), /不能小于/);
  assert.match(validateSchedule({ dailyAt: '25:00' }), /HH:MM/);
  assert.match(validateSchedule({}), /everyMinutes|dailyAt/);
  assert.equal(validateSchedule({ everyMinutes: 5 }), null);
  assert.equal(validateSchedule({ dailyAt: '09:05' }), null);
});

await test('到点判定：关掉的、没排期的、还没到的都不跑', () => {
  const now = 1_000_000;
  assert.equal(shouldRun({ enabled: true, nextRunAt: now - 1 }, now), true);
  assert.equal(shouldRun({ enabled: false, nextRunAt: now - 1 }, now), false);
  assert.equal(shouldRun({ enabled: true, nextRunAt: 0 }, now), false);
  assert.equal(shouldRun({ enabled: true, nextRunAt: now + 1000 }, now), false);
});

await test('store：建/改/删 + 跑完回写', () => {
  const room = store.createGroup({ name: '定时测试组' });
  assert.equal(store.createAutomation({ roomId: room.id, title: '', prompt: 'x' }), null);

  const a = store.createAutomation({
    roomId: room.id,
    title: '盘前简报',
    prompt: '汇报今天要盯的三只票',
    everyMinutes: 10,
    nextRunAt: Date.now() + 1000,
  });
  assert.ok(a.id);
  assert.equal(store.listAutomations({ roomId: room.id }).length, 1);

  store.updateAutomation(a.id, { enabled: false });
  assert.equal(store.getAutomation(a.id).enabled, false);

  // 换成每天定点：间隔要清掉（两种排法互斥）
  store.updateAutomation(a.id, { dailyAt: '09:00' });
  assert.equal(store.getAutomation(a.id).everyMinutes, null);
  assert.equal(store.getAutomation(a.id).dailyAt, '09:00');

  const next = Date.now() + 5000;
  store.markAutomationRan(a.id, next);
  assert.ok(store.getAutomation(a.id).lastRunAt > 0);
  assert.equal(store.getAutomation(a.id).nextRunAt, next);

  assert.equal(store.deleteAutomation(a.id), true);
  assert.equal(store.getAutomation(a.id), null);
});

await test('调度器：只跑到点的，跑完排下一次，失败不重试', async () => {
  const room = store.createGroup({ name: '调度测试组' });
  const due = store.createAutomation({
    roomId: room.id,
    title: '到点了',
    prompt: '做事',
    everyMinutes: 10,
    nextRunAt: Date.now() - 1000,
  });
  const future = store.createAutomation({
    roomId: room.id,
    title: '还没到',
    prompt: '做事',
    everyMinutes: 10,
    nextRunAt: Date.now() + 3_600_000,
  });

  const ran = [];
  const scheduler = createAutomationScheduler({
    store,
    run: async (a) => {
      ran.push(a.id);
      if (a.id === due.id) throw new Error('故意失败');
    },
  });
  await scheduler.tickOnce();
  assert.deepEqual(ran, [due.id], '只该跑 due 那条');
  assert.ok(store.getAutomation(due.id).nextRunAt > Date.now(), '失败也要排下一次');

  // 同一拍再跑一次不该重复触发
  await scheduler.tickOnce();
  assert.deepEqual(ran, [due.id]);
  assert.ok(future.nextRunAt > Date.now());
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 定时任务测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
