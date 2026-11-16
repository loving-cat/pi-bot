/**
 * 实例世代续期（规格 §6.3）：回归测试。
 *   node tests/grant-generation.mjs
 *
 * ## 这个 bug 的样子
 *
 * 用户批过的长期授权，**重启一次就全没了**，界面上的原话是
 * "授权属于实例世代 gen-xxx，当前是 gen-yyy"。
 *
 * 根因是世代号想防的是"上个进程批准的后台任务继续跑"（§6.3 原话），
 * 但实现变成了"任何带 generation 的授权，重启即死"：
 *
 *   · 迁移授权：`ensureLegacyGrant` 看到同规矩的那条还在 → 走 existing 分支
 *     → 不重发、也不刷新世代；
 *   · 用户长期授权：`gate.add` 时盖的是当时的世代。
 *
 * 所以这里守两边：**站得住的必须续**，**任务级的必须死**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { restampPlan, applyRestamp } = await import(src('grant-generation.js'));

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
const OLD = 'gen-old';
const NEW = 'gen-new';
const g = (over) => ({
  id: 'g', source: 'user', generation: OLD, taskId: null, revokedAt: null, expiresAt: null, ...over,
});

// ---------------------------------------------------------------- 该续的
test('★ 用户给的长期授权（无 taskId）→ 续到本代', () => {
  const plan = restampPlan({ grants: [g({ id: 'u1' })], generation: NEW, now: NOW });
  assert.deepEqual(plan.restamp.map((r) => r.id), ['u1']);
});

test('★ 迁移授权也要续（ensureLegacyGrant 走 existing 时不会自己刷世代）', () => {
  const plan = restampPlan({
    grants: [g({ id: 'legacy1', source: 'legacy-policy' })],
    generation: NEW,
    now: NOW,
  });
  assert.deepEqual(plan.restamp.map((r) => r.id), ['legacy1']);
});

test('已保存的窄范围规则一起续', () => {
  const plan = restampPlan({ grants: [g({ id: 'sr', source: 'saved-rule' })], generation: NEW, now: NOW });
  assert.deepEqual(plan.restamp.map((r) => r.id), ['sr']);
});

// ---------------------------------------------------------------- 不该续的
test('★ 任务级授权（带 taskId）不续 —— 这正是 §6.3 要防的"后台动作续命"', () => {
  const plan = restampPlan({ grants: [g({ id: 't1', taskId: 'tr_1' })], generation: NEW, now: NOW });
  assert.equal(plan.restamp.length, 0);
  assert.match(plan.keep[0].why, /任务级/);
});

test('派生的子授权（delegated）不擅自续（它的父授权会管）', () => {
  const plan = restampPlan({ grants: [g({ id: 'd1', source: 'delegated' })], generation: NEW, now: NOW });
  assert.equal(plan.restamp.length, 0);
  assert.match(plan.keep[0].why, /delegated/);
});

test('已撤销 / 已过期的跳过（它们本来就不该被用）', () => {
  const plan = restampPlan({
    grants: [
      g({ id: 'rev', revokedAt: NOW - 1000 }),
      g({ id: 'exp', expiresAt: NOW - 1000 }),
    ],
    generation: NEW,
    now: NOW,
  });
  assert.equal(plan.restamp.length, 0);
  assert.equal(plan.keep.length, 0);
});

test('已经是本代的不动（幂等）', () => {
  const plan = restampPlan({ grants: [g({ id: 'same', generation: NEW })], generation: NEW, now: NOW });
  assert.equal(plan.restamp.length, 0);
});

test('没有世代号就什么都不做（不猜）', () => {
  const plan = restampPlan({ grants: [g()], generation: '', now: NOW });
  assert.equal(plan.restamp.length, 0);
});

test('脏数据不炸', () => {
  const plan = restampPlan({ grants: [null, {}, g({ id: 'ok' })], generation: NEW, now: NOW });
  assert.deepEqual(plan.restamp.map((r) => r.id), ['ok']);
});

// ---------------------------------------------------------------- 落盘
test('★ 续期后网关真的放行（端到端：这就是用户看到的"权限回来了"）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gen-'));
  Object.assign(process.env, {
    PI_BOT_HOME: root, PI_BOT_WORKSPACE: path.join(root, 'ws'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_BOT_PROBE: '0',
  });
  for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const { store } = await import(src('store.js'));
  const { createGrantGate } = await import(src('grant-gate.js'));
  const { ACTION, MODE } = await import(src('grants.js'));

  const bot = store.createBot({ name: '主控', role: 'main' });
  store.state.grants = [{
    id: 'g_user', source: 'user', sourceRef: '测试',
    subject: { botId: bot.id, role: 'main' },
    actions: [ACTION.netFetch, ACTION.fileRead], resources: [], constraints: {},
    risk: 'medium', mode: MODE.host, canDelegate: false,
    maxUses: null, createdAt: NOW, expiresAt: null, revokedAt: null,
    generation: OLD, policyRevision: null,
  }];

  const gate = createGrantGate({
    store,
    currentPolicyRevision: () => store.policyVersion(),
    currentGeneration: () => NEW,
  });

  // 清理前：被世代判死（用户看到的那句话）
  const before = gate.check({ subject: { botId: bot.id }, action: ACTION.netFetch });
  assert.equal(before.ok, false);
  assert.equal(before.code, 'generation_stale');

  // 清理后：放行（世代被抹掉，不再参与比较）
  const r = applyRestamp({ store, generation: NEW, now: NOW });
  assert.equal(r.restamped, 1);
  assert.equal(store.state.grants[0].generation, null, '长期授权不该再绑世代');
  const after = gate.check({ subject: { botId: bot.id }, action: ACTION.netFetch });
  assert.equal(after.ok, true, '用户批过的长期授权，重启之后仍然有效');

  clearTimeout(store.saveTimer);
  fs.rmSync(root, { recursive: true, force: true });
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
