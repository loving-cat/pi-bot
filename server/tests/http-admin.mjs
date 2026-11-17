/**
 * HTTP 管理动作的分级与 nonce 强制测试。
 *   node tests/http-admin.mjs
 *
 * 守两件事：
 *   1. 能改防线/删数据的路由**必须**在表里（漏一条就是免检入口）；
 *   2. 缺 nonce 直接 403，且 nonce 真的被消费掉（不能复用）。
 *
 * 第 2 条要真起服务端 —— 判定表的单测证明不了中间件接上了。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-admin-'));
const ws = path.join(fixture, 'workspace');
fs.mkdirSync(ws, { recursive: true });
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: ws,
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
  PI_BOT_TASK_INTAKE: '0',
});
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { planAdminRoute, listAdminRoutes, ADMIN_ROUTE_TABLE } = await import(src('http-admin.js'));
const { ensureLegacyGrant } = await import(src('migration-grants.js'));
const { store } = await import(src('store.js'));
const { createHttpServer } = await import(src('http.js'));
const { Pairing } = await import(src('pairing.js'));
const { issueNonce } = await import(src('local-nonce.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------- 判定表
await test('改防线的路由全部在表里', () => {
  const must = [
    ['PATCH', '/api/policy'],
    ['PUT', '/api/hooks'],
    ['POST', '/api/mcp'],
    ['PATCH', '/api/mcp/x'],
    ['DELETE', '/api/mcp/x'],
    ['POST', '/api/local-capabilities/import'],
    ['POST', '/api/skills'],
    ['POST', '/api/skills/import'],
    ['DELETE', '/api/skills/x'],
    ['POST', '/api/model-groups'],
    ['PATCH', '/api/model-groups/x'],
    ['PATCH', '/api/decision'],
  ];
  for (const [method, pathname] of must) {
    const plan = planAdminRoute({ method, pathname });
    assert.ok(plan, `${method} ${pathname} 必须在管理表里（否则就是免检入口）`);
    assert.ok(plan.nonce, `${method} ${pathname} 必须要求 nonce`);
  }
});

await test('删数据的路由要求 nonce', () => {
  for (const [method, pathname] of [
    ['POST', '/api/files/delete'],
    ['DELETE', '/api/files/x'],
    ['DELETE', '/api/bots/b_1'],
    ['DELETE', '/api/rooms/r_1'],
  ]) {
    const plan = planAdminRoute({ method, pathname });
    assert.ok(plan, `${method} ${pathname} 应当在表里`);
    assert.equal(plan.level, 'data');
    assert.ok(plan.nonce);
  }
  // 撤销设备是"降低权限"的动作，不该被防冒充的门槛挡住（但要有审计）
  const revoke = planAdminRoute({ method: 'DELETE', pathname: '/api/devices/d_1' });
  assert.ok(revoke, '撤销设备应当记审计');
  assert.equal(revoke.nonce, null, '撤销设备不要 nonce');
});

await test('只读与试连不要求 nonce', () => {
  assert.equal(planAdminRoute({ method: 'GET', pathname: '/api/policy' }), null);
  assert.equal(planAdminRoute({ method: 'GET', pathname: '/api/skills' }), null);
  for (const [method, pathname] of [
    ['POST', '/api/mcp/test'],
    ['POST', '/api/sites/probe'],
    ['POST', '/api/model-groups/test'],
    ['POST', '/api/decision/probe'],
  ]) {
    const plan = planAdminRoute({ method, pathname });
    assert.ok(plan, `${method} ${pathname} 应被记为 probe`);
    assert.equal(plan.level, 'probe');
    assert.equal(plan.nonce, null, '试连不该额外要 nonce（它不改状态）');
  }
});

await test('PATCH /api/bots/:id 只在带 mcpServers 时才要 nonce', () => {
  assert.equal(planAdminRoute({ method: 'PATCH', pathname: '/api/bots/b_1', body: { name: 'x' } }), null,
    '改名字不该要 nonce');
  const withMcp = planAdminRoute({ method: 'PATCH', pathname: '/api/bots/b_1', body: { mcpServers: ['s1'] } });
  assert.ok(withMcp, '改能力要 nonce');
  assert.equal(withMcp.nonce, 'policy');
});

await test('★ skills 改写、connections 分配与 verify 路由都在判定表里', () => {
  const skillPatch = planAdminRoute({ method: 'PATCH', pathname: '/api/skills/x' });
  assert.ok(skillPatch, 'PATCH /api/skills/:id 应在表里');
  assert.equal(skillPatch.nonce, 'policy');

  const connBots = planAdminRoute({ method: 'PUT', pathname: '/api/connections/c_1/bots' });
  assert.ok(connBots, 'PUT /api/connections/:id/bots 应在表里');
  assert.equal(connBots.nonce, 'policy');

  const connVerify = planAdminRoute({ method: 'POST', pathname: '/api/connections/c_1/verify' });
  assert.ok(connVerify, 'POST /api/connections/:id/verify 应在表里');
  assert.equal(connVerify.level, 'probe');
  assert.equal(connVerify.nonce, null);
});

await test('路径占位只吃单段（/api/mcp/a/b 不该被 :id 命中）', () => {
  assert.equal(planAdminRoute({ method: 'PATCH', pathname: '/api/mcp/a/b' }), null);
});

await test('表里每条都有 level / action / label（诊断可读）', () => {
  for (const rule of ADMIN_ROUTE_TABLE) {
    assert.ok(['defense', 'data', 'probe'].includes(rule.level), `${rule.path} 的 level 不合法`);
    assert.ok(rule.action, `${rule.path} 缺 action`);
    assert.ok(rule.label, `${rule.path} 缺 label`);
  }
  assert.ok(listAdminRoutes().length >= 20);
});

// ---------------------------------------------------------------- 真起服务端
const runner = {
  modelLabel: () => 'test-model',
  initNote: '',
  contextUsage: () => ({}),
  sessions: new Map(),
  isBusy: () => false,
  stats: null,
  health: null,
  model: 'test',
  escalate: async () => {},
  abortManagedTask: () => {},
  reloadSessionForBot: () => {},
};
const server = createHttpServer({ runner, pairing: new Pairing() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const TOKEN = 'test-token-for-admin';

// 让服务端认这个 token：塞进 devices
store.state.devices[TOKEN] = { id: 'd_test', name: '测试设备', createdAt: Date.now(), lastSeenAt: Date.now() };

function request(pathname, { method = 'GET', body = null, nonce = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      authorization: 'Bearer ' + TOKEN,
      'x-pi-bot-client': 'test',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(nonce ? { 'x-pi-bot-nonce': nonce } : {}),
    };
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text); } catch { /* 可能不是 JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

await test('改策略不带 nonce → 403 nonce_required', async () => {
  const r = await request('/api/policy', { method: 'PATCH', body: { dangerous: 'allow' } });
  assert.equal(r.status, 403);
  // fail() 把 code 放在 json.code，error 是人话
  assert.equal(r.json.code, 'nonce_required');
});

await test('带 nonce 改策略 → 200，且 nonce 用一次就作废', async () => {
  const { nonce } = issueNonce('policy');
  const ok = await request('/api/policy', { method: 'PATCH', nonce, body: { dangerous: 'allow' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  // 同一枚再用一次：必须被拒
  const again = await request('/api/policy', { method: 'PATCH', nonce, body: { dangerous: 'allow' } });
  assert.equal(again.status, 403);
  assert.equal(again.json.code, 'nonce_required');
});

await test('nonce 绑用途：拿 policy 的 nonce 去改 hooks → 403', async () => {
  const { nonce } = issueNonce('policy');
  const r = await request('/api/hooks', { method: 'PUT', nonce, body: { hooks: [] } });
  assert.equal(r.status, 403);
});

await test('改 hooks 要 nonce（原来不要）', async () => {
  const noNonce = await request('/api/hooks', { method: 'PUT', body: { hooks: [] } });
  assert.equal(noNonce.status, 403);
  const { nonce } = issueNonce('hooks');
  const ok = await request('/api/hooks', { method: 'PUT', nonce, body: { hooks: [] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

await test('删附件要 nonce', async () => {
  const noNonce = await request('/api/files/delete', { method: 'POST', body: { ids: ['x'] } });
  assert.equal(noNonce.status, 403);
});

await test('试连 MCP 不要 nonce（只是 probe，不改状态）', async () => {
  const r = await request('/api/mcp/test', { method: 'POST', body: { name: 'probe', command: '' } });
  assert.notEqual(r.status, 403, '试连不该被 nonce 挡：' + JSON.stringify(r.json));
});

await test('管理动作留下审计记录（不含请求体）', async () => {
  const before = store.listAdminActions({ limit: 300 }).length;
  const { nonce } = issueNonce('policy');
  await request('/api/policy', { method: 'PATCH', nonce, body: { dangerous: 'allow', requireProof: true } });
  const after = store.listAdminActions({ limit: 300 });
  assert.ok(after.length > before, '应新增一条审计');
  const latest = after[0];
  assert.equal(latest.path, '/api/policy');
  assert.equal(latest.action, 'policy.change');
  assert.equal(latest.level, 'defense');
  const raw = JSON.stringify(after);
  assert.ok(!raw.includes('requireProof'), '审计不该记请求体：' + raw.slice(0, 300));
});

await test('审计里能看出是哪个设备改的', async () => {
  const latest = store.listAdminActions({ limit: 1 })[0];
  assert.equal(latest.deviceId, 'd_test');
  assert.equal(latest.deviceName, '测试设备');
});

await test('改策略后迁移授权自动重发（否则只读会连读都拒）', async () => {
  // 回到 allow 再收紧，模拟用户操作
  const a = issueNonce('policy');
  await request('/api/policy', { method: 'PATCH', nonce: a.nonce, body: { dangerous: 'allow' } });
  const b = issueNonce('policy');
  await request('/api/policy', { method: 'PATCH', nonce: b.nonce, body: { dangerous: 'deny' } });

  const chief = store.mainBot();
  const legacy = store.state.grants.filter(
    (g) => g.source === 'legacy-policy' && g.subject?.botId === chief.id && !g.revokedAt,
  );
  assert.ok(legacy.length >= 1, '应当有一条当前规矩下的迁移授权');
  const fresh = legacy.at(-1);
  const actions = [...fresh.actions];
  // 只读规矩下只剩“不动手”的动作。清单不是手写的：它由 role-tools 的
  // READONLY_ALLOW 推导（查资料、找同事、看仓库、看屏幕都在里面）——
  // 策略层放行而网关没发授权的组合，会让用户切成只读之后连查资料都做不了。
  assert.ok(actions.includes('file.read'));
  assert.ok(actions.includes('desktop.observe'));
  for (const unsafe of ['file.write', 'file.delete', 'cmd.exec', 'cmd.background', 'git.commit', 'git.push']) {
    assert.ok(!actions.includes(unsafe), `只读模式不该有 ${unsafe}`);
  }
});

await test('★ PATCH /api/bots/:id 实测：改名免 nonce，改 mcpServers 缺 nonce 403、带 nonce 200', async () => {
  const chief = store.mainBot();
  assert.ok(chief?.id);

  const renameRes = await request(`/api/bots/${chief.id}`, {
    method: 'PATCH',
    body: { name: '主控新名' },
  });
  assert.equal(renameRes.status, 200, JSON.stringify(renameRes.json));

  const noNonceMcp = await request(`/api/bots/${chief.id}`, {
    method: 'PATCH',
    body: { mcpServers: ['s1'] },
  });
  assert.equal(noNonceMcp.status, 403, JSON.stringify(noNonceMcp.json));
  assert.equal(noNonceMcp.json.code, 'nonce_required');

  const { nonce } = issueNonce('policy');
  const okMcp = await request(`/api/bots/${chief.id}`, {
    method: 'PATCH',
    nonce,
    body: { mcpServers: [] },
  });
  assert.equal(okMcp.status, 200, JSON.stringify(okMcp.json));
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

await new Promise((r) => server.close(r));
clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
