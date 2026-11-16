/**
 * 授权对账（规格 §6.3 / §13.1）。
 *   node tests/grant-reconcile.mjs
 *
 * ## 守什么
 *
 * 对账最容易犯的错是**猜用户想留什么**，然后把他还有用的授权悄悄撤掉。
 * 所以这里的规则必须窄到"只收错配"：
 *
 *   · 非主 Bot 拿着 `host` → 撤（§8.1，没有任何正当用途）；
 *   · 主体不存在 → 撤（孤儿；同名重建会继承它）；
 *   · 资源跑到工作目录外面 → **只报不撤**（多项目、外接盘、worktree 都合法）。
 *
 * 第三条是这篇测试的重点：它必须**不**被自动撤掉。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { reconcileGrants, applyReconcile } = await import(src('grant-reconcile.js'));

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
const WS = path.join(path.sep, 'work', 'proj');
const inside = (...p) => path.join(WS, ...p);
const outside = path.join(path.sep, 'elsewhere', 'other');

const BOTS = [
  { id: 'b_main', role: 'main', name: '主控' },
  { id: 'b_coder', role: 'member', name: '编码手' },
];
const g = (over) => ({
  id: 'g', mode: 'project', actions: ['file.read'], resources: [], subject: { botId: 'b_coder' }, ...over,
});

// ---------------------------------------------------------------- 错配：撤
test('★ 非主 Bot 拿着 host 模式 → 撤（§8.1 只属于主 Bot）', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'g_host', mode: 'host', subject: { botId: 'b_coder' } })],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.deepEqual(r.revoke.map((x) => x.id), ['g_host']);
  assert.match(r.revoke[0].why, /只属于主 Bot/);
});

test('主 Bot 拿 host 是正常的，不撤', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'g_ok', mode: 'host', subject: { botId: 'b_main' } })],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.equal(r.revoke.length, 0);
});

test('★ 主体已经不存在 → 撤（孤儿授权，同名重建会继承它）', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'g_orphan', subject: { botId: 'b_gone' } })],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.deepEqual(r.revoke.map((x) => x.id), ['g_orphan']);
  assert.match(r.revoke[0].why, /孤儿/);
});

// ---------------------------------------------------------------- 只报：不撤
test('★ 资源在工作目录外面 → **只报不撤**（多项目/外接盘/worktree 都合法）', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'g_out', resources: [{ kind: 'path', ref: path.join(outside, 'repo') }] })],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.equal(r.revoke.length, 0, '不能替用户做决定');
  assert.deepEqual(r.stale.map((x) => x.id), ['g_out']);
  assert.match(r.stale[0].why, /不在当前工作目录/);
});

test('资源在里面的不报', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'g_in', resources: [{ kind: 'path', ref: inside('repo') }] })],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.equal(r.stale.length, 0);
});

test('工作目录本身就是资源（不是子目录）也算在里面', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'g_root', resources: [{ kind: 'path', ref: WS }] })],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.equal(r.stale.length, 0);
});

test('★ 前缀相似但不同目录不算在里面（/work/proj2 不是 /work/proj 的子目录）', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'g_sib', resources: [{ kind: 'path', ref: `${WS}2` }] })],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.equal(r.stale.length, 1, '`proj2` 以 `proj` 开头但不是它里面');
});

test('没给 workspace 时跳过路径检查（不猜）', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'g_any', resources: [{ kind: 'path', ref: outside }] })],
    bots: BOTS, workspace: '', now: NOW,
  });
  assert.equal(r.stale.length, 0);
});

// ---------------------------------------------------------------- 不该动的
test('已撤销 / 已过期的授权不进任何一栏（它们是审计材料）', () => {
  const r = reconcileGrants({
    grants: [
      g({ id: 'g_dead', revokedAt: NOW - 1000 }),
      g({ id: 'g_exp', expiresAt: NOW - 1000, mode: 'host', subject: { botId: 'b_gone' } }),
    ],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.equal(r.revoke.length, 0);
  assert.equal(r.stale.length, 0);
});

test('干净的一组授权：什么都不动', () => {
  const r = reconcileGrants({
    grants: [g({ id: 'a' }), g({ id: 'b', subject: { botId: 'b_main' }, mode: 'host' })],
    bots: BOTS, workspace: WS, now: NOW,
  });
  assert.deepEqual(r, { revoke: [], stale: [] });
});

test('脏数据不炸', () => {
  const r = reconcileGrants({ grants: [null, {}, { id: 'x' }], bots: [], workspace: WS, now: NOW });
  assert.ok(Array.isArray(r.revoke));
});

// ---------------------------------------------------------------- 落盘
test('★ 回收标记 revokedBy=system（和"用户收回""规矩变了"分开）', () => {
  const grants = [{ id: 'g_host', mode: 'host', subject: { botId: 'b_coder' }, revokedAt: null }];
  let saved = false;
  const store = {
    state: { grants },
    listBots: () => BOTS,
    scheduleSave: () => { saved = true; },
  };
  const r = applyReconcile({ store, workspace: WS, log: () => {} });
  assert.deepEqual(r.revoked, ['g_host']);
  assert.equal(grants[0].revokedBy, 'system');
  assert.match(grants[0].revokedReason, /对账回收/);
  assert.equal(saved, true);
});

test('没有可收的时候不落盘', () => {
  let saved = false;
  const r = applyReconcile({
    store: { state: { grants: [] }, listBots: () => [], scheduleSave: () => { saved = true; } },
    workspace: WS, log: () => {},
  });
  assert.deepEqual(r.revoked, []);
  assert.equal(saved, false);
});

// ---------------------------------------------------------------- 角色变更（store 层）
test('★ 主 Bot 被降成普通成员 → host 授权当场回收', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reconcile-'));
  Object.assign(process.env, {
    PI_BOT_HOME: root, PI_BOT_WORKSPACE: path.join(root, 'ws'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_BOT_PROBE: '0',
  });
  for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const { store } = await import(src('store.js'));
  const chief = store.mainBot();
  store.state.grants = [{
    id: 'g_host_chief', source: 'user', subject: { botId: chief.id, role: 'main' },
    actions: ['file.read'], resources: [], mode: 'host', createdAt: NOW, revokedAt: null,
  }];

  // 改个名字不该触发回收
  store.updateBot(chief.id, { name: '改个名' });
  assert.equal(store.state.grants[0].revokedAt, null, '改名字不该动权限');

  // 降级才触发
  store.updateBot(chief.id, { role: 'member' });
  assert.notEqual(store.state.grants[0].revokedAt, null, '不再是主 Bot，host 授权必须作废');
  assert.equal(store.state.grants[0].revokedBy, 'system');
  clearTimeout(store.saveTimer);
  fs.rmSync(root, { recursive: true, force: true });
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
