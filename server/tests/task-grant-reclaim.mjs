/**
 * 任务结束回收临时授权（规格 §13.2 第⑤步 / §6.3）。
 *   node tests/task-grant-reclaim.mjs
 *
 * ## 守什么
 *
 * 收尾时的错误方向**两边都有代价**：
 *
 *   · 收少了 → 一堆"任务早结束了"的授权还活着，用户在面板里看不出哪条有效；
 *   · 收多了 → 把用户自己配的**项目级授权**顺手删了，他的 bot 突然不会干活。
 *
 * 所以这里逐条钉死"什么算临时"：只有带 `taskId` / `expiresAt` / `maxUses` 的
 * 才在收尾范围内，而且项目级授权**一条都不碰**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { planTaskGrantReclaim, reclaimTaskGrants } = await import(src('tasks/task-grant-reclaim.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const NOW = 1_700_000_000_000;
const g = (over) => ({ id: 'g', actions: ['file.read'], resources: [], mode: 'project', ...over });

// ---------------------------------------------------------------- 纯逻辑
test('★ 这次任务的临时授权会被收', () => {
  const plan = planTaskGrantReclaim({
    grants: [g({ id: 'g_task', taskId: 'tr_1' }), g({ id: 'g_other', taskId: 'tr_2' })],
    taskId: 'tr_1',
    now: NOW,
  });
  assert.deepEqual(plan.reclaim.map((r) => r.id), ['g_task']);
  assert.deepEqual(plan.keep.map((k) => k.id), ['g_other']);
});

test('★ 项目级授权（没有 taskId / 期限 / 次数）一条都不碰', () => {
  const plan = planTaskGrantReclaim({
    grants: [g({ id: 'g_project' })],
    taskId: 'tr_1',
    now: NOW,
  });
  assert.equal(plan.reclaim.length, 0);
  assert.match(plan.keep[0].why, /项目级/);
});

test('已撤销的不重复回收', () => {
  const plan = planTaskGrantReclaim({
    grants: [g({ id: 'g_dead', taskId: 'tr_1', revokedAt: NOW - 1000 })],
    taskId: 'tr_1',
    now: NOW,
  });
  assert.equal(plan.reclaim.length, 0);
});

test('别的任务里已经过期/用完的，也顺手登记（但那是上层决定）', () => {
  const plan = planTaskGrantReclaim({
    grants: [
      g({ id: 'g_exp', taskId: 'tr_9', expiresAt: NOW - 1 }),
      g({ id: 'g_used', taskId: 'tr_9', maxUses: 2, usedUses: 2 }),
      g({ id: 'g_live', taskId: 'tr_9', expiresAt: NOW + 60_000 }),
    ],
    taskId: 'tr_1',
    now: NOW,
  });
  const ids = plan.reclaim.map((r) => r.id);
  assert.ok(ids.includes('g_exp'));
  assert.ok(ids.includes('g_used'));
  assert.ok(!ids.includes('g_live'), '还有效、又不是这次任务发的，不能收');
});

test('空 taskId 时不会"把没有 taskId 的授权都当成这次的"', () => {
  const plan = planTaskGrantReclaim({
    grants: [g({ id: 'g_a' }), g({ id: 'g_b', taskId: 'tr_1' })],
    taskId: '',
    now: NOW,
  });
  assert.equal(plan.reclaim.length, 0);
});

test('脏数据不炸', () => {
  const plan = planTaskGrantReclaim({ grants: [null, undefined, { id: 'x' }], taskId: 'tr_1', now: NOW });
  assert.ok(Array.isArray(plan.reclaim));
});

// ---------------------------------------------------------------- 落盘
test('★ 回收只标撤销、不删记录，并且标明"是任务收尾收的"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reclaim-'));
  const grants = [
    { id: 'g_task', taskId: 'tr_1', revokedAt: null },
    { id: 'g_project', revokedAt: null },
  ];
  let saved = false;
  const store = {
    state: { grants },
    scheduleSave: () => { saved = true; },
  };
  const r = reclaimTaskGrants({ store, taskId: 'tr_1', now: NOW });
  assert.deepEqual(r.revoked, ['g_task']);
  assert.equal(grants.length, 2, '记录要留着，审计要能查');
  const taskGrant = grants.find((x) => x.id === 'g_task');
  assert.equal(taskGrant.revokedAt, NOW);
  assert.equal(taskGrant.revokedBy, 'task', '要能和"用户在界面上收回"分开');
  assert.match(taskGrant.revokedReason, /任务结束回收/);
  assert.equal(grants.find((x) => x.id === 'g_project').revokedAt, null, '项目级授权不许动');
  assert.equal(saved, true, '改完要落盘');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('没有可收的时候不落盘、不报错', () => {
  let saved = false;
  const r = reclaimTaskGrants({
    store: { state: { grants: [{ id: 'g', revokedAt: null }] }, scheduleSave: () => { saved = true; } },
    taskId: 'tr_1',
    now: NOW,
  });
  assert.equal(r.revoked.length, 0);
  assert.equal(saved, false);
});

test('store 没装好也不炸（收尾失败不该拖垮回报）', () => {
  const r = reclaimTaskGrants({ store: null, taskId: 'tr_1', now: NOW });
  assert.deepEqual(r.revoked, []);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
