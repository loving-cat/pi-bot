/** 连接目录、真实 HTTP 路由、凭据边界、审批与运行期撤销的隔离回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-connections-'));
const keep = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS']);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
Object.assign(process.env, {
  HOME: path.join(root, 'home'), PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_HOME: path.join(root, 'data'), PI_BOT_WORKSPACE: path.join(root, 'workspace'),
  PI_BOT_TOKEN: 'fixture-secret-connection-token', PI_BOT_TRUST_LOCAL: '0',
});
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { store } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const { createConnections, publicProbeResult, VERIFICATION_TTL } = await import('../src/connections.js');
const { createHttpServer } = await import('../src/http.js');
const { createMcpExtension } = await import('../src/mcp-hook.js');
const { createPolicyExtension, approvalHash } = await import('../src/policy-hook.js');
const { mcpAccessSignature } = await import('../src/mcp-access.js');
store.useSecretsKey(Buffer.alloc(32, 7));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.log(`✗ ${name}: ${error.stack}`); }
}
const changed = [], runner = { reloadSessionForBot: (id) => changed.push(id), applyMcpChange() {}, availableModels: [], modelLabel: () => null };
const fixture = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-secret-value');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const msg = JSON.parse(Buffer.concat(chunks));
  if (!msg.id) { res.writeHead(202); res.end(); return; }
  const result = msg.method === 'initialize'
    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : { tools: [{ name: 'fixture_read', description: 'fixture-secret-value', inputSchema: { type: 'object' } }] };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const server = createHttpServer({ runner, pairing: { snapshot: () => ({}) } });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
async function call(route, method = 'GET', body, authorized = true) {
  const response = await fetch(endpoint + route, {
    method, headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${process.env.PI_BOT_TOKEN}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
let id, member, room;
try {
  await test('目录必须鉴权，GET 不会启动工具', async () => {
    assert.equal((await call('/api/connections', 'GET', undefined, false)).status, 401);
    const result = await call('/api/connections');
    assert.equal(result.status, 200);
    assert.equal(result.body.catalog.length, 3);
    assert.deepEqual(result.body.connections, []);
  });
  await test('创建与列表均不回传凭据，磁盘中为密文', async () => {
    const result = await call('/api/mcp', 'POST', { name: 'fixture_app', type: 'http', enabled: true,
      url: `http://127.0.0.1:${fixture.address().port}`, headers: { Authorization: 'Bearer fixture-secret-value' } });
    assert.equal(result.status, 200);
    id = result.body.server.id;
    assert.equal(result.body.server.hasCredentials, true);
    assert.ok(!JSON.stringify(result.body).includes('fixture-secret-value'));
    store.saveNow();
    assert.ok(!fs.readFileSync(path.join(process.env.PI_BOT_HOME, 'state.json'), 'utf8').includes('fixture-secret-value'));
  });
  await test('已存凭据可用于真实验证，工具描述回显被脱敏', async () => {
    const result = await call(`/api/connections/${id}/verify`, 'POST', {});
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
    assert.equal(result.body.connection.verification.state, 'ready');
    assert.equal(result.body.toolCount, 1);
    assert.ok(!JSON.stringify(result.body).includes('fixture-secret-value'));
  });
  await test('空白编辑保留凭据，草稿验证不修改已存配置', async () => {
    const before = store.mcpLibrary()[0].configurationRevision;
    const result = await call('/api/mcp/test', 'POST', { id, headers: { Authorization: '' } });
    assert.equal(result.body.ok, true);
    assert.equal(store.mcpLibrary()[0].configurationRevision, before);
    assert.equal((await call(`/api/mcp/${id}`, 'PATCH', { headers: {} })).status, 200);
    assert.equal(store.mcpLibrary()[0].configurationRevision, before);
  });
  await test('配置变更后验证标记过期', async () => {
    await call(`/api/mcp/${id}`, 'PATCH', { description: 'modified fixture' });
    const result = await call('/api/connections');
    assert.equal(result.body.connections[0].verification.state, 'stale');
  });
  await test('绑定先完整校验，未知 Bot 不造成部分写入', async () => {
    member = store.createBot({ name: 'fixture member' });
    room = store.ensureDm(member.id);
    const bad = await call(`/api/connections/${id}/bots`, 'PUT', { botIds: [member.id, 'missing'] });
    assert.equal(bad.status, 400);
    assert.deepEqual(store.getBot(member.id).mcpServers, []);
    const good = await call(`/api/connections/${id}/bots`, 'PUT', { botIds: [member.id] });
    assert.equal(good.status, 200);
    assert.deepEqual(good.body.connection.assignedBotIds, [member.id]);
    assert.ok(changed.includes(member.id));
  });
  await test('MCP 动态工具在 ask 下审批，原始输入不进入审批和消息', () => {
    store.updatePolicy({ dangerous: 'ask' });
    const handlers = {};
    createPolicyExtension({ roomId: room.id, bot: member }).factory({ on: (event, fn) => { handlers[event] = fn; } });
    const input = { password: 'fixture-secret-argument', path: 'fixture.txt' };
    const toolName = 'mcp__fixture_app__write';
    assert.equal(handlers.tool_call({ toolName, input }).block, true);
    const capabilityRevision = mcpAccessSignature(store.getBot(member.id), store.mcpLibrary());
    const approval = store.findPendingApproval({ roomId: room.id, botId: member.id,
      hash: approvalHash(toolName, input, { roomId: room.id, botId: member.id, capabilityRevision }) });
    assert.ok(approval);
    assert.equal(approval.input, null);
    assert.ok(!JSON.stringify(approval).includes('fixture-secret-argument'));
    approval.status = 'approved';
    assert.equal(handlers.tool_call({ toolName, input }), undefined);
    assert.equal(approval.status, 'consumed');
    assert.equal(handlers.tool_call({ toolName, input }).block, true);
  });
  await test('跨 Bot 或改连接后不能消费旧的一次批准与本任务授权', () => {
    const other = store.createBot({ name: 'fixture other', mcpServers: ['fixture_app'] });
    const otherRoom = store.ensureDm(other.id);
    const toolName = 'mcp__fixture_app__write', input = { value: 'fixture' };
    const policyFor = (bot, roomId) => {
      const handlers = {};
      createPolicyExtension({ roomId, bot }).factory({ on: (event, fn) => { handlers[event] = fn; } });
      return handlers.tool_call;
    };
    const first = policyFor(member, room.id), second = policyFor(other, otherRoom.id);
    first({ toolName, input });
    const revision = mcpAccessSignature(store.getBot(member.id), store.mcpLibrary());
    const approval = store.findPendingApproval({ roomId: room.id, botId: member.id,
      hash: approvalHash(toolName, input, { roomId: room.id, botId: member.id, capabilityRevision: revision }) });
    approval.status = 'approved';
    assert.equal(second({ toolName, input }).block, true);
    assert.equal(approval.status, 'approved');
    store.grantApproval({ roomId: room.id, botId: member.id, capabilityRevision: revision });
    assert.equal(first({ toolName, input }), undefined);
    store.updateMcpServer(id, { description: 'changed after approval' });
    assert.equal(first({ toolName, input }).block, true);
    assert.equal(approval.status, 'approved');
  });
  await test('Bot 连接达到上限时整批拒绝，其他 Bot 不被部分分配', async () => {
    const full = store.createBot({ name: 'fixture full', mcpServers: Array.from({ length: 20 }, (_, n) => `fixture_${n}`) });
    const empty = store.createBot({ name: 'fixture empty' });
    const result = await call(`/api/connections/${id}/bots`, 'PUT', { botIds: [empty.id, full.id] });
    assert.equal(result.status, 400);
    assert.deepEqual(store.getBot(empty.id).mcpServers, []);
    assert.equal(store.getBot(full.id).mcpServers.length, 20);
  });
  await test('停用应用后旧会话不能继续调用', async () => {
    const handlers = {};
    createMcpExtension({ botId: member.id, roomId: room.id })({ on: (event, fn) => { handlers[event] = fn; }, registerMcpServer() {} });
    assert.equal(handlers.tool_call({ toolName: 'mcp__fixture_app__read' }), undefined);
    store.updateMcpServer(id, { enabled: false });
    assert.equal(handlers.tool_call({ toolName: 'mcp__fixture_app__read' }).block, true);
    assert.equal(handlers.tool_call({ toolName: 'read_mcp_resource' }).block, true);
    store.updateMcpServer(id, { enabled: true });
  });
  await test('取消分配后旧会话不能借原授权继续调用', async () => {
    const handlers = {};
    createMcpExtension({ botId: member.id, roomId: room.id })({ on: (event, fn) => { handlers[event] = fn; }, registerMcpServer() {} });
    await call(`/api/connections/${id}/bots`, 'PUT', { botIds: [] });
    assert.equal(handlers.tool_call({ toolName: 'mcp__fixture_app__read' }).block, true);
  });
  await test('本机导入扫描不把未导入凭据发给客户端', async () => {
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'mcp.json'), JSON.stringify({ mcpServers: {
      local_fixture: { command: 'node', env: { API_KEY: 'fixture-secret-local' } },
    } }));
    const result = await call('/api/local-capabilities');
    assert.ok(!JSON.stringify(result.body).includes('fixture-secret-local'));
    const local = result.body.mcpServers.find((s) => s.name === 'local_fixture');
    assert.ok(local);
    assert.equal(local.hasCredentials, true);
  });
  await test('验证过期按时间判定，服务重启后不沿用在线状态', async () => {
    let clock = Date.now();
    const c = createConnections({ store, runner, now: () => clock, probe: async () => ({ ok: true, checkedAt: clock, tools: [] }) });
    await c.verify(id);
    assert.equal(c.connection(id).verification.state, 'ready');
    clock += VERIFICATION_TTL + 1;
    assert.equal(c.connection(id).verification.state, 'stale');
    assert.equal(createConnections({ store, runner }).connection(id).verification.state, 'unverified');
  });
  await test('并发验证合并，验证期间改配不会覆盖新版本状态', async () => {
    let release, calls = 0;
    const c = createConnections({ store, runner, probe: async () => { calls++; await new Promise((r) => { release = r; }); return { ok: true, tools: [] }; } });
    const first = c.verify(id), second = c.verify(id);
    await new Promise((r) => setImmediate(r));
    assert.equal(c.connection(id).verification.state, 'checking');
    store.updateMcpServer(id, { description: 'changed during verification' });
    release();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(c.connection(id).verification.state, 'stale');
    assert.ok(results.every((result) => result.connection.verification.state === 'stale'));
  });
  await test('草稿探测和已存验证共享并发上限', async () => {
    const releases = [];
    const c = createConnections({ store, runner, probe: async () => {
      await new Promise((r) => releases.push(r)); return { ok: true, tools: [] };
    } });
    const requests = [c.testDraft({ id }), c.testDraft({ id }), c.testDraft({ id })];
    await new Promise((r) => setImmediate(r));
    assert.equal((await c.verify(id)).status, 429);
    assert.equal((await c.testDraft({ id })).ok, false);
    for (const release of releases) release();
    await Promise.all(requests);
    assert.equal(c.connection(id).verification.state, 'unverified');
  });
  await test('探测公开结果限制字段，不带服务端自定义数据', () => {
    const result = publicProbeResult({ ok: true, password: 'fixture-secret', tools: [], detail: 'fixture-secret' }, { env: { API_KEY: 'fixture-secret' } });
    assert.equal(result.password, undefined);
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    const long = 'fixture-secret-' + 'q'.repeat(200);
    const longResult = publicProbeResult({ ok: true, tools: [{ name: 'tool', title: long, description: long }] }, { env: { API_KEY: long } });
    assert.ok(!JSON.stringify(longResult).includes('qqqqqq'));
  });
} finally {
  server.closeAllConnections(); fixture.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => fixture.close(r))]);
  store.saveNow(); bus.removeAllListeners();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed}/${passed + failed} 通过`);
process.exitCode = failed ? 1 : 0;
