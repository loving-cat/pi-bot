/**
 * 连接请求的 HTTP 层：手机怎么发起、电脑怎么批、token 怎么交付。
 *   node tests/pair-request-http.mjs
 *
 * 模块规则在 tests/pair-request.mjs 里钉过了，这里只验**接线**：
 *   ① 手机（未鉴权）能发请求，但拿不到 token；
 *   ② 电脑（本机 token）能看到待批列表并批准；
 *   ③ 批准后手机轮询拿到一次 token，第二次拿不到；
 *   ④ 这个 token 真的能用来调已鉴权接口（不是个摆设）；
 *   ⑤ 不存在的 id → 410；
 *   ⑥ 手机自己不能批准自己的请求（未鉴权调 decide → 401）。
 */
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_pair_request');
import fs from 'node:fs';
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { createHttpServer } = await import('../src/http.js');
import { installLocalToken } from './_local-token.mjs';
const { Pairing } = await import('../src/pairing.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`✗ ${name}\n    ${err?.message || err}`);
  }
}

const runner = { availableModels: [], modelLabel: () => null, initNote: null };
const server = createHttpServer({ runner, pairing: new Pairing() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const LOCAL_TOKEN = installLocalToken();

function call(pathname, { method = 'GET', body = null, token = '', anonymous = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'x-pi-bot-client': 'test' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed, text });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let requestId = null;
let deviceToken = null;

await test('手机（未鉴权）发起连接请求：拿到 id，没有 token', async () => {
  const r = await call('/api/pair/request', { method: 'POST', body: { device: '我的手机', platform: 'android' } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.id, /^[a-f0-9]{32}$/);
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.token, undefined, '还没人批准就给 token 就白做了');
  requestId = r.body.id;
});

await test('手机轮询：pending，没有 token', async () => {
  const r = await call(`/api/pair/request/${requestId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.token, undefined);
});

await test('手机自己不能批准自己（未鉴权 → 401）', async () => {
  const r = await call(`/api/pair/request/${requestId}`, { method: 'POST', body: { approve: true }, anonymous: true });
  assert.equal(r.status, 401);
});

await test('电脑端（本机 token）能看到待批列表', async () => {
  const r = await call('/api/pair/requests', { token: LOCAL_TOKEN });
  assert.equal(r.status, 200);
  assert.ok(r.body.requests.some((x) => x.id === requestId), '待批列表里要有这台手机');
  assert.equal(r.body.requests[0].token, undefined, '待批列表不下发 token');
});

await test('电脑端点允许 → 手机轮询拿到 token，且只有一次', async () => {
  const decide = await call(`/api/pair/request/${requestId}`, { method: 'POST', body: { approve: true }, token: LOCAL_TOKEN });
  assert.equal(decide.status, 200, decide.text);
  assert.equal(decide.body.status, 'approved');

  const first = await call(`/api/pair/request/${requestId}`);
  assert.equal(first.body.status, 'approved');
  assert.ok(first.body.token, '批准之后必须交付 token');
  deviceToken = first.body.token;

  const second = await call(`/api/pair/request/${requestId}`);
  assert.equal(second.body.token, undefined, 'token 只交付一次');
});

await test('这台手机拿到的 token 真的能调已鉴权接口', async () => {
  const r = await call('/api/devices', { token: deviceToken });
  assert.equal(r.status, 200, r.text);
});

await test('不存在的请求 id → 410', async () => {
  const r = await call(`/api/pair/request/${'0'.repeat(32)}`);
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'PAIR_REQUEST_GONE');
});

await test('已经批过的请求再批一次 → 409（不会重复发设备）', async () => {
  const r = await call(`/api/pair/request/${requestId}`, { method: 'POST', body: { approve: true }, token: LOCAL_TOKEN });
  assert.equal(r.status, 409);
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} 通过 / ${failed} 失败`);
server.close();
process.exit(failed ? 1 : 0);
