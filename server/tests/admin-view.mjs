import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-view-'));
const ws = path.join(fixture, 'workspace');
fs.mkdirSync(ws, { recursive: true });
Object.assign(process.env, {
  PI_BOT_HOME: fixture, PI_BOT_WORKSPACE: ws,
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0', PI_BOT_LESSON_REFLECT: '0', PI_BOT_TASK_INTAKE: '0',
});
globalThis.fetch = () => { throw new Error('no net'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { createGrantGate } = await import(src('grant-gate.js'));
const { ensureLegacyGrant } = await import(src('migration-grants.js'));
const { createHttpServer } = await import(src('http.js'));
const { Pairing } = await import(src('pairing.js'));
const { buildConfirmation } = await import(src('confirm.js'));
const { ACTION } = await import(src('grants.js'));

const chief = store.mainBot();
ensureLegacyGrant({ store, policy: store.policy(), policyRevision: store.policyVersion(), botIds: [chief.id], chiefBotId: chief.id });

const runner = {
  modelLabel: () => 'test', initNote: '', contextUsage: () => ({}),
  sessions: new Map(), isBusy: () => false, stats: null, health: null, model: 'test',
  escalate: async () => {}, abortManagedTask: () => {},
  grantGate: createGrantGate({
    store,
    currentPolicyRevision: () => store.policyVersion(),
    currentGeneration: () => 'gen-test',
  }),
};
const server = createHttpServer({ runner, pairing: new Pairing() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const TOKEN = 'tok-view-test';
store.state.devices[TOKEN] = { id: 'd_view', name: '测试机', createdAt: Date.now(), lastSeenAt: Date.now() };

function req(pathname, { method = 'GET', body = null, channel = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      authorization: 'Bearer ' + TOKEN,
      'x-pi-bot-client': 'test',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(channel ? { 'x-pi-bot-channel': channel } : {}),
    };
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(t); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err?.message || String(err) }); }
}

await test('GET /api/grants 能列出当前授权', async () => {
  const r = await req('/api/grants');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.grants));
  assert.ok(r.json.grants.length >= 1, '至少有迁移授权');
  const g = r.json.grants[0];
  assert.ok(g.id && g.actions && g.mode);
  assert.ok(r.json.policyRevision, '应给出当前规矩版本');
});

await test('GET /api/grants?botId= 能按 bot 过滤', async () => {
  const r = await req(`/api/grants?botId=${chief.id}`);
  assert.equal(r.status, 200);
  for (const g of r.json.grants) assert.equal(g.subject.botId, chief.id);
});

await test('★ POST /api/grants/:id/revoke 能收回授权', async () => {
  const before = (await req('/api/grants')).json.grants;
  const target = before[0];
  const r = await req(`/api/grants/${target.id}/revoke`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.revoked, target.id);

  const after = (await req('/api/grants')).json.grants;
  assert.ok(!after.some((g) => g.id === target.id), '收回后不该再出现在列表里');
});

await test('收回不存在的授权返回 404', async () => {
  const r = await req('/api/grants/gr_nope/revoke', { method: 'POST', body: {} });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'GRANT_NOT_FOUND');
});
// ★ 收权是**降低权限**的动作：不该被 nonce 门槛挡住，也不该写管理审计。
//   理由和「撤销设备」一样 —— 冒充者帮你收权只会让你少了项能力。
//   这两条写死在用例里，以后谁想给它加 nonce 会先看到这里的意图。
await test('收权不要 nonce，且不刷管理审计', async () => {
  // 前面的用例可能已经把仅有的迁移授权收完了，这里现造一条 ——
  // 断言点不是“列表里恰好有”，而是“收一条授权不需要 nonce、不写审计”。
  const gate = runner.grantGate;
  const made = gate.add({
    source: 'user',
    subject: { botId: chief.id, role: 'main' },
    actions: ['file.read'],
    resources: [],
    mode: 'host',
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  const target = made.grant.id;
  const beforeAudit = store.state.adminAudit?.length ?? 0;
  const r = await req(`/api/grants/${target}/revoke`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, `收权不该要 nonce：${JSON.stringify(r.json)}`);
  assert.equal(store.state.adminAudit?.length ?? 0, beforeAudit, '收权不该往“改了什么”里写记录');
});

await test('GET /api/admin-actions 能看到审计', async () => {
  store.addAdminAction({ action: 'policy.change', level: 'defense', label: '改部门规矩', method: 'PATCH', path: '/api/policy' });
  const r = await req('/api/admin-actions');
  assert.equal(r.status, 200);
  assert.ok(r.json.actions.length >= 1);
  assert.equal(r.json.actions[0].action, 'policy.change');
});

await test('★ 只读接口不要 nonce（否则一打开设置页就 403）', async () => {
  for (const p of ['/api/grants', '/api/grant-audit', '/api/admin-actions', '/api/confirmations']) {
    const r = await req(p);
    assert.equal(r.status, 200, p + ' 不该要 nonce：' + JSON.stringify(r.json));
  }
});

await test('★ 只读接口不写管理审计（看≠改）', async () => {
  const before = (await req('/api/admin-actions')).json.actions.length;
  await req('/api/grants');
  await req('/api/grant-audit');
  await req('/api/grants');
  const after = (await req('/api/admin-actions')).json.actions.length;
  assert.equal(after, before, '只看不改的请求不该产生审计');
});

await test('确认列表能列出待办', async () => {
  store.requestConfirmation(buildConfirmation({
    id: 'cf_view_1', action: ACTION.gitPush, target: { remote: 'origin', ref: 'main' },
    summary: '推 3 个提交',
  }));
  const r = await req('/api/confirmations');
  assert.equal(r.status, 200);
  assert.ok(r.json.confirmations.some((c) => c.id === 'cf_view_1'));
});

await test('★ 桌面端(本机)批准不可恢复动作 → 403 WEAK_CHANNEL', async () => {
  const r = await req('/api/confirmations/cf_view_1', { method: 'POST', body: { approve: true } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'WEAK_CHANNEL');
  // 记录不该被改成 approved
  assert.equal(store.getConfirmation('cf_view_1').decision, null);
});

await test('★ 带 device 通道才能批准不可恢复动作', async () => {
  const r = await req('/api/confirmations/cf_view_1', {
    method: 'POST', body: { approve: true }, channel: 'device',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.confirmation.decision, 'approved');
  assert.equal(r.json.confirmation.channel, 'device');
});

await test('已经决过的确认重复提交是幂等的', async () => {
  const r = await req('/api/confirmations/cf_view_1', {
    method: 'POST', body: { approve: false }, channel: 'device',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.replayed, true);
  assert.equal(store.getConfirmation('cf_view_1').decision, 'approved', '不该被改成拒绝');
});

await test('★ GET /api/grant-audit 能读出网关的判定记录', async () => {
  const gate = runner.grantGate;
  gate.add({
    source: 'user',
    subject: { botId: chief.id, role: 'main' },
    actions: ['file.read'], resources: [], mode: 'host',
  });
  gate.check({ subject: { botId: chief.id }, action: 'file.read' });
  const r = await req('/api/grant-audit');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json.audit));
  assert.ok(r.json.audit.length >= 1, '至少能看到刚放行的那一条');
  const hit = r.json.audit[0];
  assert.equal(hit.result, 'allow');
  assert.ok(hit.risk, 'risk 不该是 null（动作目录是唯一来源）');
  assert.equal(typeof hit.action, 'string');
  // 只读接口：不要 nonce、不写管理审计（上面那条用例已经守了）
});

await test('★ 审计能只看被拒的（排查现场用）', async () => {
  const gate = runner.grantGate;
  gate.check({ subject: { botId: chief.id }, action: 'git.push' }); // 没有覆盖它的授权
  const r = await req('/api/grant-audit?denied=1');
  assert.equal(r.status, 200);
  assert.ok(r.json.audit.every((a) => a.result === 'deny'), '带 denied=1 时只返回拒绝记录');
  assert.ok(r.json.audit.length >= 1);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
console.log(`${results.length - failed.length}/${results.length} 通过`);

await new Promise((r) => server.close(r));
clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
