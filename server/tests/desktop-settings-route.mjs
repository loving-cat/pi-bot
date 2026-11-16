/**
 * 桌面设置接口（`/api/desktop-settings`）。
 *   node tests/desktop-settings-route.mjs
 *
 * ## 守什么
 *
 * 这个开关叫「信任合成输入」：打开之后，bot 会在"有人一直在动鼠标"的信号下
 * **继续操作**。它是一次**放宽**，所以：
 *
 *   1. 改它必须过管理门（nonce + 审计）—— 冒充者能改它，等于能悄悄让 bot
 *      无视用户的接管；
 *   2. GET 不该要 nonce（看一眼设置不该点一次确认）；
 *   3. 默认必须是**关**：读一次就得看到 false，不能因为写了脏数据变成 true；
 *   4. 诊断信息要跟着 GET 出去 —— 用户遇到"它不动鼠标"时唯一的解释来源。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-deskset-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { createGrantGate } = await import(src('grant-gate.js'));
const { createHttpServer } = await import(src('http.js'));
const { Pairing } = await import(src('pairing.js'));

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
const TOKEN = 'tok-desktop-settings';
store.state.devices[TOKEN] = { id: 'd_ds', name: '测试机', createdAt: Date.now(), lastSeenAt: Date.now() };

function req(method, pathname, { body = null, nonce = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { authorization: 'Bearer ' + TOKEN, 'x-pi-bot-client': 'test' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (nonce) headers['x-pi-bot-nonce'] = nonce;
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
    if (payload) r.write(payload);
    r.end();
  });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

await test('★ 默认是关的（放宽的事不能默认开）', async () => {
  const r = await req('GET', '/api/desktop-settings');
  assert.equal(r.status, 200);
  assert.equal(r.json.settings.trustPhantomInput, false);
});

await test('GET 不要 nonce，并且把输入环境诊断一起给出去', async () => {
  const r = await req('GET', '/api/desktop-settings');
  assert.equal(r.status, 200);
  assert.ok('environment' in r.json, '用户遇到"它不动鼠标"时唯一的解释来源就是这段');
});

await test('★ 不带 nonce 改不了（这是一次放宽）', async () => {
  const r = await req('PATCH', '/api/desktop-settings', { body: { trustPhantomInput: true } });
  assert.ok(r.status >= 400, `应该被拦，实际 ${r.status}`);
  assert.equal(store.desktopSettings().trustPhantomInput, false);
});

await test('带 nonce 才能开，并且写进审计', async () => {
  const n = await req('POST', '/api/local-nonce', { body: { purpose: 'policy' } });
  const before = store.listAdminActions({ limit: 100 }).length;
  const r = await req('PATCH', '/api/desktop-settings', {
    body: { trustPhantomInput: true },
    nonce: n.json.nonce,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.settings.trustPhantomInput, true);
  assert.equal(store.desktopSettings().trustPhantomInput, true);
  assert.ok(store.listAdminActions({ limit: 100 }).length > before, '放宽类的改动必须留痕');
});

await test('脏数据当关处理（不能因为写了字符串就变成开）', async () => {
  store.setDesktopSettings({ trustPhantomInput: 'yes' });
  assert.equal(store.desktopSettings().trustPhantomInput, false);
  store.setDesktopSettings({ trustPhantomInput: true });
});

await test('可以关回去', async () => {
  const n = await req('POST', '/api/local-nonce', { body: { purpose: 'policy' } });
  const r = await req('PATCH', '/api/desktop-settings', {
    body: { trustPhantomInput: false },
    nonce: n.json.nonce,
  });
  assert.equal(r.status, 200);
  assert.equal(store.desktopSettings().trustPhantomInput, false);
});

server.close();
clearTimeout(store.saveTimer);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
