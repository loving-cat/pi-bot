/**
 * MCP 凭据只跟着原来的连接目标走：改了类型、地址 origin、命令、参数、工作目录就不再沿用。
 *   node tests/mcp-credential-target.mjs
 *
 * 全部是假值，目录用 os.tmpdir()。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.PI_BOT_SECRET_KEY;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-mcp-target-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_DATA_DIR = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { loadOrCreateKey } = await import('../src/secrets.js');
const { mcpTargetChanged } = await import('../src/mcp-credentials.js');
const { store } = await import('../src/store.js');
store.useSecretsKey(loadOrCreateKey(root));

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

let seq = 0;
const uniq = (prefix) => `${prefix}-${++seq}`;

function addHttp(headers = { 'X-Api-Key': 'fake-value-a' }) {
  const r = store.addMcpServer({ name: uniq('web'), type: 'http', url: 'https://mcp.example.com/sse', headers });
  assert.ok(!r.error, r.error);
  return r.server.id;
}

function addStdio(env = { FAKE_TOKEN: 'fake-value-a' }) {
  const r = store.addMcpServer({ name: uniq('cli'), command: 'node', args: ['server.js'], cwd: 'work-a', env });
  assert.ok(!r.error, r.error);
  return r.server.id;
}

const headersOf = (id) => store.mcpRuntimeServer(id)?.headers ?? {};
const envOf = (id) => store.mcpRuntimeServer(id)?.env ?? {};

await test('mcpTargetChanged：只看类型 / origin / 命令 / 参数 / 工作目录', () => {
  const http = { type: 'http', url: 'https://a.example.com/x' };
  assert.equal(mcpTargetChanged(http, { type: 'http', url: 'https://a.example.com/y?z=1' }), false);
  assert.equal(mcpTargetChanged(http, { type: 'http', url: 'https://b.example.com/x' }), true);
  assert.equal(mcpTargetChanged(http, { type: 'http', url: 'http://a.example.com/x' }), true);
  assert.equal(mcpTargetChanged(http, { type: 'http', url: 'https://a.example.com:8443/x' }), true);
  assert.equal(mcpTargetChanged(http, { type: 'stdio', command: 'node' }), true);
  const cli = { type: 'stdio', command: 'node', args: ['a.js'], cwd: 'w' };
  assert.equal(mcpTargetChanged(cli, { ...cli }), false);
  assert.equal(mcpTargetChanged(cli, { ...cli, command: 'python' }), true);
  assert.equal(mcpTargetChanged(cli, { ...cli, args: ['b.js'] }), true);
  assert.equal(mcpTargetChanged(cli, { ...cli, args: ['a.js', '--x'] }), true);
  assert.equal(mcpTargetChanged(cli, { ...cli, cwd: 'v' }), true);
  assert.equal(mcpTargetChanged(null, cli), false);
});

await test('★ http：地址换到别的主机，旧请求头凭据不跟过去', () => {
  const id = addHttp();
  assert.equal(headersOf(id)['X-Api-Key'], 'fake-value-a');
  const r = store.updateMcpServer(id, { url: 'https://evil.example.net/sse' });
  assert.ok(!r.error, r.error);
  assert.deepEqual(headersOf(id), {});
  assert.deepEqual(r.server.credentialKeys ?? [], []);
});

await test('★ http：只换协议或端口也算换目标', () => {
  const a = addHttp();
  const r = store.updateMcpServer(a, { url: 'http://mcp.example.com/sse' });
  // 有的环境不允许明文 http 地址：被拒时原记录不变，也不算泄露
  if (r.error) assert.equal(headersOf(a)['X-Api-Key'], 'fake-value-a');
  else assert.deepEqual(headersOf(a), {});
  const b = addHttp();
  const rb = store.updateMcpServer(b, { url: 'https://mcp.example.com:8443/sse' });
  assert.ok(!rb.error, rb.error);
  assert.deepEqual(headersOf(b), {});
});

await test('http：同 origin 只改路径 / 改名 / 开关，凭据保留', () => {
  const id = addHttp();
  store.updateMcpServer(id, { url: 'https://mcp.example.com/v2/sse' });
  assert.equal(headersOf(id)['X-Api-Key'], 'fake-value-a');
  store.updateMcpServer(id, { enabled: true, description: 'fake' });
  assert.equal(headersOf(id)['X-Api-Key'], 'fake-value-a');
});

await test('★ 换目标时一起填的新凭据会留下，旧的一个都不留', () => {
  const id = addHttp({ 'X-Api-Key': 'fake-value-a', 'X-Other': 'fake-value-o' });
  store.updateMcpServer(id, { url: 'https://new.example.com/sse', headers: { 'X-Api-Key': 'fake-value-b' } });
  assert.deepEqual(headersOf(id), { 'X-Api-Key': 'fake-value-b' });
});

await test('★ stdio：命令、参数、工作目录任一改动都丢旧 env 凭据', () => {
  for (const patch of [{ command: 'python' }, { args: ['other.js'] }, { cwd: 'work-b' }]) {
    const id = addStdio();
    assert.equal(envOf(id).FAKE_TOKEN, 'fake-value-a');
    const r = store.updateMcpServer(id, patch);
    assert.ok(!r.error, r.error);
    assert.deepEqual(envOf(id), {}, JSON.stringify(patch));
  }
});

await test('stdio：目标不变（只改描述），env 凭据保留', () => {
  const id = addStdio();
  store.updateMcpServer(id, { description: 'fake', command: 'node', args: ['server.js'] });
  assert.equal(envOf(id).FAKE_TOKEN, 'fake-value-a');
});

await test('★ 类型从 http 改成 stdio：旧凭据丢弃', () => {
  const id = addHttp();
  store.updateMcpServer(id, { type: 'stdio', command: 'node' });
  const runtime = store.mcpRuntimeServer(id);
  assert.equal(runtime.type, 'stdio');
  assert.deepEqual(runtime.env ?? {}, {});
  assert.deepEqual(runtime.headers ?? {}, {});
});

await test('★ 连接测试（不落盘）：带 id 换地址也拿不到已存凭据', () => {
  const id = addHttp();
  const moved = store.mcpProbeDraft({ id, type: 'http', url: 'https://evil.example.net/sse' });
  assert.ok(!moved.error, moved.error);
  assert.deepEqual(moved.server.headers ?? {}, {});
  const same = store.mcpProbeDraft({ id, type: 'http', url: 'https://mcp.example.com/sse' });
  assert.ok(!same.error, same.error);
  assert.equal(same.server.headers?.['X-Api-Key'], 'fake-value-a');
  // 测试不改已保存记录
  assert.equal(headersOf(id)['X-Api-Key'], 'fake-value-a');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);