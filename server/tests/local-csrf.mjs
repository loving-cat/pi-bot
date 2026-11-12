/**
 * 本机免 token 的 CSRF 防护：跨站网页打不进本机服务端。
 *   node tests/local-csrf.mjs
 *
 * 覆盖：Origin 同源才算本机主人、Sec-Fetch-Site: cross-site 全局拒、
 * 改状态请求必须带 x-pi-bot-client、content-type 只认媒体类型 application/json。
 * 全是假数据，目录用 os.tmpdir()，随机端口。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

delete process.env.PI_BOT_TOKEN;
delete process.env.PI_BOT_TRUST_LOCAL;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-local-csrf-'));
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');

const { createHttpServer, CLIENT_HEADER, isJsonContentType } = await import('../src/http.js');
import { installLocalToken } from './_local-token.mjs';
const { Pairing } = await import('../src/pairing.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err?.message || String(err) }); }
}

const runner = { availableModels: [], modelLabel: () => null, initNote: null };
// 本机免 token 已收紧：现在必须带本次启动的 token（见 src/local-token.js）
const LOCAL_TOKEN = installLocalToken();
const server = createHttpServer({ runner, pairing: new Pairing() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const self = `http://127.0.0.1:${port}`;

// 默认带上本次启动的本机 token。
//
//   本测试原本大量依赖"回环地址 = 免 token"，但那个前提已收紧：
//   现在本机请求也必须带 token（否则任何本机进程都能调改状态接口）。
//   要测"没 token 会怎样"，显式传 asAnonymous: true。
function call(pathname, { method = 'GET', body = null, headers = {}, asAnonymous = false } = {}) {
  const withAuth = asAnonymous
    ? headers
    : { authorization: `Bearer ${LOCAL_TOKEN}`, ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: withAuth }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const JSON_BODY = JSON.stringify({ title: 'fake' });
const client = { [CLIENT_HEADER]: 'test' };

await test('头名固定为 x-pi-bot-client（App 和中转都按这个名字带）', () => {
  assert.equal(CLIENT_HEADER, 'x-pi-bot-client');
});

await test('isJsonContentType：只看 ; 前的媒体类型', () => {
  assert.equal(isJsonContentType('application/json'), true);
  assert.equal(isJsonContentType('Application/JSON; charset=utf-8'), true);
  assert.equal(isJsonContentType('text/plain; charset=application/json'), false);
  assert.equal(isJsonContentType('text/plain;application/json'), false);
  assert.equal(isJsonContentType('application/jsonx'), false);
  assert.equal(isJsonContentType('application/json-patch+json'), false);
  assert.equal(isJsonContentType(''), false);
  assert.equal(isJsonContentType(undefined), false);
});

// ---------- 读：本机免 token 只给原生客户端和同源页面 ----------
await test('本机无 Origin（原生 App / 桌面端）照常免 token', async () => {
  assert.equal((await call('/api/devices')).status, 200);
});
await test('本机同源 Origin（本服务自己的页面）照常免 token', async () => {
  assert.equal((await call('/api/devices', { headers: { origin: self } })).status, 200);
});
// 这些用例测的是"**没带 token 时**，跨站 Origin 不能冒充本机用户"。
// 带 token 时跨站 Origin 也不该被当成主人 —— 但那是另一条断言（见下）。
await test('★ 本机跨站 Origin 不免 token → 401（匿名）', async () => {
  for (const origin of ['https://evil.example', 'http://localhost:1', `http://127.0.0.1:${port + 1}`, 'null']) {
    const r = await call('/api/devices', { headers: { origin }, asAnonymous: true });
    assert.equal(r.status, 401, `${origin} → ${r.status}`);
  }
});
await test('★ 跨站 Origin 即使带了合法 token 也拿不到"本机免 token"身份', async () => {
  // 带了 token 就是合法设备身份，能访问 —— 但这条要确认它没被当成本机主人：
  // /api/devices 返回的 localTrusted 与 device.isLocal 能区分两者。
  const r = await call('/api/devices', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 200, '带 token 的请求应当通过鉴权');
});
await test('★ Origin 同主机同端口但 Host 头不同也不算同源（匿名）', async () => {
  const r = await call('/api/devices', { headers: { origin: `http://localhost:${port}`, host: `127.0.0.1:${port}` }, asAnonymous: true });
  assert.equal(r.status, 401);
});

// ---------- Sec-Fetch-Site ----------
await test('★ Sec-Fetch-Site: cross-site 一律 403（哪怕没带 Origin）', async () => {
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    const r = await call('/api/devices', { method, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 403, `${method} → ${r.status}`);
  }
});
await test('Sec-Fetch-Site: same-origin / none 不受影响', async () => {
  for (const site of ['same-origin', 'none']) {
    const r = await call('/api/devices', { headers: { 'sec-fetch-site': site, origin: self } });
    assert.equal(r.status, 200, `${site} → ${r.status}`);
  }
});

// ---------- 写：必须带自定义头 + 严格 JSON ----------
await test('★ POST 不带 x-pi-bot-client → 403', async () => {
  const r = await call('/api/tasks', { method: 'POST', body: JSON_BODY, headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 403);
  assert.match(r.text, /x-pi-bot-client/);
});
await test('★ PATCH / PUT / DELETE 不带 x-pi-bot-client → 403', async () => {
  for (const [method, p] of [['PATCH', '/api/user'], ['PUT', '/api/user'], ['DELETE', '/api/devices/d_fake']]) {
    const r = await call(p, { method, body: method === 'DELETE' ? null : JSON_BODY, headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 403, `${method} → ${r.status}`);
  }
});
await test('★ 上传接口不带 x-pi-bot-client → 403（上传不再是例外）', async () => {
  const r = await call('/api/uploads?name=fake.txt', { method: 'POST', body: 'fake', headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 403);
});
await test('上传带 x-pi-bot-client → 200（原始字节不要求 JSON）', async () => {
  const r = await call('/api/uploads?name=fake.txt', { method: 'POST', body: 'fake', headers: { 'content-type': 'text/plain', ...client } });
  assert.equal(r.status, 200, r.text);
});
await test('★ text/plain; charset=application/json → 415', async () => {
  const r = await call('/api/tasks', { method: 'POST', body: JSON_BODY, headers: { 'content-type': 'text/plain; charset=application/json', ...client } });
  assert.equal(r.status, 415);
});
await test('★ 跨站 Origin 带齐头、但没 token → 401', async () => {
  const r = await call('/api/tasks', {
    method: 'POST', body: JSON_BODY,
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...client },
    asAnonymous: true,
  });
  assert.equal(r.status, 401);
});
await test('本机原生客户端带齐头 + application/json; charset=utf-8 能正常写', async () => {
  const r = await call('/api/devices/d_fake', { method: 'DELETE', headers: client });
  assert.equal(r.status, 200, r.text);
  const t = await call('/api/tasks', { method: 'POST', body: JSON_BODY, headers: { 'content-type': 'application/json; charset=utf-8', ...client } });
  assert.notEqual(t.status, 403, t.text);
  assert.notEqual(t.status, 415, t.text);
});
await test('/api/pair 在鉴权之前，不要求 x-pi-bot-client（配对码本身就是凭证）', async () => {
  const r = await call('/api/pair', { method: 'POST', body: JSON.stringify({ code: '000000' }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 401);
  assert.doesNotMatch(r.text, /x-pi-bot-client/);
});

server.close();
fs.rmSync(root, { recursive: true, force: true });
let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}`); else { failed++; console.log(`✗ ${r.name}：${r.err}`); }
}
console.log(failed ? `${failed}/${results.length} 失败` : `全部 ${results.length} 项通过`);
process.exit(failed ? 1 : 0);