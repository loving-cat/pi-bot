/** MCP 凭据持久化、编辑保留、迁移与公共投影的隔离回归。 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-mcp-credentials-'));
const keep = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']);
for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_DATA_DIR = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
for (const name of ['HOME', 'PI_CODING_AGENT_DIR', 'PI_BOT_WORKSPACE']) fs.mkdirSync(process.env[name], { recursive: true });

const { Store, store: singleton } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const { normalizeMcpServer } = await import('../src/mcp.js');
const { publicMcpCredentials, assertMcpCredentialsSealed } = await import('../src/mcp-credentials.js');
const key = crypto.randomBytes(32);
const stores = [singleton];
const stateFile = path.join(root, 'state.json');
let passed = 0;
let failed = 0;

function fresh(withKey = true) {
  const store = new Store();
  store.state.mcpServers = [];
  stores.push(store);
  if (withKey) store.useSecretsKey(key);
  return store;
}
function http(name = 'remote', patch = {}) {
  return { name, type: 'http', url: 'https://mcp.example.test/api', enabled: true, ...patch };
}
function add(store, patch) {
  const result = store.addMcpServer(patch);
  assert.ok(!result.error, result.error);
  return result.server;
}
function privateRecord(store, id) {
  return store.state.mcpServers.find((item) => item.id === id);
}
function noValue(value, secret) {
  assert.ok(!JSON.stringify(value).includes(secret), '公共输出中出现凭据值');
}
function noPayload(value) {
  assert.equal(value.env, undefined);
  assert.equal(value.headers, undefined);
  assert.equal(value.credentialSecret, undefined);
}
function corrupt(record) {
  const parts = record.credentialSecret.split(':');
  const tag = parts[3];
  parts[3] = tag.slice(0, 4) + (tag[4] === 'A' ? 'B' : 'A') + tag.slice(5);
  record.credentialSecret = parts.join(':');
}
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.log(`✗ ${name}: ${error.message}`); }
}

await test('新增 HTTP 凭据加密落盘，执行时还原，公共响应与事件不携秘密', () => {
  const store = fresh();
  const events = [];
  const listen = (event) => { if (event.t === 'mcp.updated') events.push(event); };
  bus.on('event', listen);
  try {
    const server = add(store, http('remote', { headers: { Authorization: 'Bearer fixture-secret-alpha' } }));
    assert.deepEqual(server.credentialKeys, ['Authorization']);
    assert.equal(server.hasCredentials, true);
    noPayload(server);
    noValue(server, 'fixture-secret-alpha');
    noValue(events, 'fixture-secret-alpha');
    assert.equal(events.length, 1);
    assert.match(privateRecord(store, server.id).credentialSecret, /^enc:v1:/);
    assert.equal(privateRecord(store, server.id).headers, undefined);
    assert.equal(store.mcpRuntimeServer(server.id).headers.Authorization, 'Bearer fixture-secret-alpha');
    store.saveNow();
    assert.ok(!fs.readFileSync(stateFile, 'utf8').includes('fixture-secret-alpha'));
  } finally { bus.off('event', listen); }
});

await test('本地环境变量也加密，Bot 执行配置可用', () => {
  const store = fresh();
  const server = add(store, { name: 'local', type: 'stdio', command: 'node', enabled: true, env: { API_KEY: 'fixture-secret-env' } });
  const bot = store.createBot({ name: '测试成员', persona: '测试', mcpServers: ['local'] });
  assert.equal(store.mcpServersFor(bot.id)[0].env.API_KEY, 'fixture-secret-env');
  noPayload(store.mcpLibrary()[0]);
  noValue(store.state, 'fixture-secret-env');
  assert.equal(server.hasCredentials, true);
});

await test('没有密钥时拒绝新增凭据，不改变内存与磁盘', () => {
  const store = fresh(false);
  store.saveNow();
  const before = fs.readFileSync(stateFile);
  const result = store.addMcpServer(http('blocked', { headers: { Authorization: 'fixture-secret-no-key' } }));
  assert.match(result.error, /加密未就绪/);
  assert.deepEqual(store.mcpLibrary(), []);
  assert.deepEqual(fs.readFileSync(stateFile), before);
});

await test('无凭据的连接不需要加密密钥', () => {
  const store = fresh(false);
  const server = add(store, http());
  assert.equal(server.hasCredentials, false);
  assert.deepEqual(server.credentialKeys, []);
  assert.equal(store.mcpRuntimeServer(server.id).url, 'https://mcp.example.test/api');
});

await test('省略或留空凭据保留原值，原样保存不改变配置修订', () => {
  const store = fresh();
  const server = add(store, http('keep', { headers: { Authorization: 'fixture-secret-keep' } }));
  const cipher = privateRecord(store, server.id).credentialSecret;
  assert.equal(store.mcpLibrary()[0].configurationRevision, server.configurationRevision);
  for (const patch of [{}, { headers: {} }, { headers: { Authorization: '' } }, { headers: { Authorization: '   ' } }]) {
    const result = store.updateMcpServer(server.id, patch);
    assert.ok(!result.error, result.error);
    assert.equal(result.server.configurationRevision, server.configurationRevision);
    assert.equal(privateRecord(store, server.id).credentialSecret, cipher);
    assert.equal(store.mcpRuntimeServer(server.id).headers.Authorization, 'fixture-secret-keep');
  }
});

await test('非空键值只更新对应凭据，HTTP 键名大小写不会留下双份', () => {
  const store = fresh();
  const server = add(store, http('partial', { headers: { Authorization: 'fixture-secret-old', 'X-Region': 'fixture-secret-region' } }));
  const result = store.updateMcpServer(server.id, { headers: { authorization: 'fixture-secret-new' } });
  assert.ok(!result.error, result.error);
  assert.deepEqual(store.mcpRuntimeServer(server.id).headers, { 'X-Region': 'fixture-secret-region', authorization: 'fixture-secret-new' });
  assert.notEqual(result.server.configurationRevision, server.configurationRevision);
});

await test('显式清除可移除全部凭据，也可以用新凭据替换', () => {
  const store = fresh();
  const server = add(store, http('clear', { headers: { Authorization: 'fixture-secret-old' } }));
  const result = store.updateMcpServer(server.id, { clearCredentials: true });
  assert.ok(!result.error, result.error);
  assert.equal(result.server.hasCredentials, false);
  assert.equal(store.mcpRuntimeServer(server.id).headers, undefined);
  assert.equal(privateRecord(store, server.id).credentialSecret, undefined);
  const replace = store.updateMcpServer(server.id, { clearCredentials: true, headers: { Token: 'fixture-secret-replacement' } });
  assert.ok(!replace.error, replace.error);
  assert.deepEqual(store.mcpRuntimeServer(server.id).headers, { Token: 'fixture-secret-replacement' });
});

await test('切换连接类型不复用另一种传输的凭据', () => {
  const store = fresh();
  const server = add(store, http('switch', { headers: { Authorization: 'fixture-secret-http' } }));
  const result = store.updateMcpServer(server.id, { type: 'stdio', command: 'node', env: { API_KEY: 'fixture-secret-stdio' } });
  assert.ok(!result.error, result.error);
  const runtime = store.mcpRuntimeServer(server.id);
  assert.equal(runtime.headers, undefined);
  assert.deepEqual(runtime.env, { API_KEY: 'fixture-secret-stdio' });
  noValue(store.state, 'fixture-secret-http');
  noValue(store.state, 'fixture-secret-stdio');
});

await test('测试草稿可使用保存的凭据，但不会修改存储', () => {
  const store = fresh();
  const server = add(store, http('draft', { headers: { Authorization: 'fixture-secret-saved' } }));
  const before = JSON.stringify(store.state);
  const draft = store.mcpProbeDraft({ id: server.id, url: 'https://mcp.example.test/changed', headers: { Authorization: '' } });
  assert.equal(draft.server.headers.Authorization, 'fixture-secret-saved');
  assert.equal(draft.server.url, 'https://mcp.example.test/changed');
  assert.equal(JSON.stringify(store.state), before);
});

await test('新连接测试无需落盘或已有密钥', () => {
  const store = fresh(false);
  const draft = store.mcpProbeDraft(http('new-draft', { headers: { Authorization: 'fixture-secret-draft' } }));
  assert.ok(!draft.error, draft.error);
  assert.equal(draft.server.headers.Authorization, 'fixture-secret-draft');
  assert.deepEqual(store.mcpLibrary(), []);
  assert.match(store.mcpProbeDraft({ id: 'missing' }).error, /不存在/);
});

await test('读取公共摘要不解密且不泄漏损坏密文', () => {
  const store = fresh();
  const server = add(store, http('broken', { headers: { Authorization: 'fixture-secret-broken' } }));
  corrupt(privateRecord(store, server.id));
  const safe = store.mcpLibrary()[0];
  assert.equal(safe.hasCredentials, true);
  noPayload(safe);
  assert.throws(() => store.mcpRuntimeServer(server.id), /无法解密/);
});

await test('损坏密文时普通编辑与测试拒绝且不改内存、文件', () => {
  const store = fresh();
  const server = add(store, http('broken-edit', { headers: { Authorization: 'fixture-secret-broken-edit' } }));
  corrupt(privateRecord(store, server.id));
  store.saveNow();
  const before = JSON.stringify(store.state);
  const disk = fs.readFileSync(stateFile);
  assert.match(store.updateMcpServer(server.id, { description: '新说明' }).error, /无法解密/);
  assert.match(store.mcpProbeDraft({ id: server.id }).error, /无法解密/);
  assert.equal(JSON.stringify(store.state), before);
  assert.deepEqual(fs.readFileSync(stateFile), disk);
});

await test('损坏密文可通过明确清除并重新填写恢复', () => {
  const store = fresh();
  const server = add(store, http('recover', { headers: { Authorization: 'fixture-secret-broken' } }));
  corrupt(privateRecord(store, server.id));
  const result = store.updateMcpServer(server.id, { clearCredentials: true, headers: { Authorization: 'fixture-secret-recovered' } });
  assert.ok(!result.error, result.error);
  assert.equal(store.mcpRuntimeServer(server.id).headers.Authorization, 'fixture-secret-recovered');
});

await test('密文绑定记录身份，不能交换到另一条连接', () => {
  const store = fresh();
  const a = add(store, http('first', { headers: { Authorization: 'fixture-secret-first' } }));
  const b = add(store, http('second', { headers: { Authorization: 'fixture-secret-second' } }));
  privateRecord(store, b.id).credentialSecret = privateRecord(store, a.id).credentialSecret;
  assert.throws(() => store.mcpRuntimeServer(b.id), /无法解密/);
});

await test('旧明文一次性迁移，重复注入密钥保持密文不变', () => {
  const store = fresh(false);
  store.state.mcpServers = [normalizeMcpServer(http('legacy', { headers: { Authorization: 'fixture-secret-legacy' } }))];
  const id = store.state.mcpServers[0].id;
  noValue(store.mcpLibrary(), 'fixture-secret-legacy');
  store.useSecretsKey(key);
  const first = JSON.stringify(store.state.mcpServers);
  store.useSecretsKey(key);
  assert.equal(JSON.stringify(store.state.mcpServers), first);
  assert.equal(store.mcpRuntimeServer(id).headers.Authorization, 'fixture-secret-legacy');
  store.saveNow();
  assert.ok(!fs.readFileSync(stateFile, 'utf8').includes('fixture-secret-legacy'));
});

await test('迁移全有或全无，错误密钥不部分重写记录', () => {
  const store = fresh();
  add(store, http('encrypted', { headers: { Authorization: 'fixture-secret-encrypted' } }));
  store.state.mcpServers.unshift(normalizeMcpServer(http('legacy-first', { headers: { Authorization: 'fixture-secret-migration' } })));
  const before = JSON.stringify(store.state);
  assert.throws(() => store.useSecretsKey(crypto.randomBytes(32)), /无法解密/);
  assert.equal(JSON.stringify(store.state), before);
  store.useSecretsKey(key);
});

await test('迁移不可用时 saveNow 不把明文再次落盘', () => {
  const store = fresh(false);
  store.saveNow();
  const disk = fs.readFileSync(stateFile);
  store.state.mcpServers = [normalizeMcpServer(http('unmigrated', { headers: { Authorization: 'fixture-secret-unmigrated' } }))];
  assert.throws(() => store.useSecretsKey(null), /加密未就绪/);
  store.saveNow();
  assert.deepEqual(fs.readFileSync(stateFile), disk);
  assert.throws(() => assertMcpCredentialsSealed(store.state.mcpServers), /加密迁移/);
  store.useSecretsKey(key);
});

await test('无效或超长凭据失败时不截断、不改变旧值', () => {
  const store = fresh();
  const server = add(store, http('validation', { headers: { Authorization: 'fixture-secret-valid' } }));
  const before = JSON.stringify(store.state);
  for (const headers of [{ Authorization: 'x'.repeat(2001) }, { 'Bad\nKey': 'x' }, { Authorization: 'x\r\ny' }, JSON.parse('{"__proto__":"x"}')]) {
    assert.ok(store.updateMcpServer(server.id, { headers }).error);
    assert.equal(JSON.stringify(store.state), before);
  }
});

await test('上限长度凭据可完整往返，密文不经过明文字段截断', () => {
  const store = fresh();
  const value = 'v'.repeat(2000);
  const server = add(store, http('maximum', { headers: { Authorization: value } }));
  assert.ok(privateRecord(store, server.id).credentialSecret.length > 2000);
  assert.equal(store.mcpRuntimeServer(server.id).headers.Authorization, value);
  const saved = store.updateMcpServer(server.id, { description: '完整保留' });
  assert.ok(!saved.error, saved.error);
  assert.equal(store.mcpRuntimeServer(server.id).headers.Authorization, value);
});

await test('不启用的坏凭据不会阻止同 Bot 的有效连接解析', () => {
  const store = fresh();
  const good = add(store, http('healthy'));
  const disabled = add(store, http('disabled', { enabled: false, headers: { Authorization: 'fixture-secret-disabled' } }));
  corrupt(privateRecord(store, disabled.id));
  const bot = store.createBot({ name: '测试成员', persona: '测试', mcpServers: [good.name, disabled.name] });
  const resolved = store.mcpServersFor(bot.id);
  assert.equal(resolved.length, 2);
  assert.ok(resolved.some((item) => item.name === good.name && item.enabled));
});

await test('配置与密钥更改会改变修订，读取不改变修订', () => {
  const store = fresh();
  const server = add(store, http('revision', { headers: { Authorization: 'fixture-secret-before' } }));
  const first = server.configurationRevision;
  assert.equal(store.mcpLibrary()[0].configurationRevision, first);
  const second = store.updateMcpServer(server.id, { headers: { Authorization: 'fixture-secret-after' } }).server.configurationRevision;
  assert.notEqual(second, first);
  const third = store.updateMcpServer(server.id, { enabled: false }).server.configurationRevision;
  assert.notEqual(third, second);
  assert.equal(store.mcpLibrary()[0].configurationRevision, third);
});

await test('公共历史地址与显式凭据参数展示会隐藏值', () => {
  const target = publicMcpCredentials({ type: 'http', url: 'https://fixture:fixture-secret-url@example.test/mcp?token=fixture-secret-query&mode=read', args: ['--api-key', 'fixture-secret-argument', '--password=fixture-secret-inline'] });
  for (const secret of ['fixture-secret-url', 'fixture-secret-query', 'fixture-secret-argument', 'fixture-secret-inline']) noValue(target, secret);
  assert.match(target.url, /mode=read/);
});

await test('删除连接会清除对应密文并广播安全列表', () => {
  const store = fresh();
  const server = add(store, http('remove', { headers: { Authorization: 'fixture-secret-remove' } }));
  assert.deepEqual(store.removeMcpServer(server.id), { ok: true });
  assert.equal(store.mcpRuntimeServer(server.id), null);
  assert.deepEqual(store.mcpLibrary(), []);
  assert.deepEqual(store.state.mcpServers, []);
});

for (const store of stores) if (store.saveTimer) clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} 通过`);
process.exitCode = failed ? 1 : 0;
