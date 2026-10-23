/**
 * 安全回归：WS 握手 Host/Origin 校验、/api/files 不内联危险 MIME。
 *   node tests/security-regress.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_security');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { createHttpServer } = await import('../src/http.js');
const { attachWs } = await import('../src/ws.js');
const { Pairing } = await import('../src/pairing.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err?.message || String(err) }); }
}

const runner = { availableModels: [], modelLabel: () => null, initNote: null };
const server = createHttpServer({ runner, pairing: new Pairing() });
attachWs(server, { runner });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/** 返回首帧类型，或 'rejected' */
function wsFirst(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const done = (v) => { try { ws.terminate(); } catch {} resolve(v); };
    ws.on('message', (raw) => { const t = JSON.parse(String(raw)).t; done(t === 'hello' ? 'hello' : 'rejected'); });
    ws.on('unexpected-response', () => done('rejected'));
    ws.on('error', () => done('rejected'));
    ws.on('close', () => done('rejected'));
    setTimeout(() => done('timeout'), 3000);
  });
}

function call(pathname, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

await test('WS：本机无 Origin 仍可连（原生 App）', async () => {
  assert.equal(await wsFirst({}), 'hello');
});
await test('WS：恶意 Origin 被拒', async () => {
  assert.equal(await wsFirst({ origin: 'https://evil.example' }), 'rejected');
});
await test('WS：恶意 Host（DNS rebinding）被拒', async () => {
  assert.equal(await wsFirst({ host: `evil.example:${port}` }), 'rejected');
});

async function upload(mime, content, name) {
  const r = await call(`/api/uploads?name=${name}`, { method: 'POST', body: content, headers: { 'content-type': mime } });
  assert.equal(r.status, 200, `上传失败 ${r.status} ${r.text}`);
  return JSON.parse(r.text).attachment.url;
}

for (const [mime, name] of [['text/html', 'x.html'], ['image/svg+xml', 'x.svg'], ['application/xml', 'x.xml'], ['text/javascript', 'x.js']]) {
  await test(`/api/files：${mime} 不内联且带 CSP sandbox`, async () => {
    const url = await upload(mime, '<script>alert(1)</script>', name);
    const r = await call(url);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'] || '', /^attachment/i, '缺 Content-Disposition: attachment');
    assert.match(r.headers['content-security-policy'] || '', /sandbox/, '缺 CSP sandbox');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
}

await test('/api/files：image/png 允许内联预览，但带 nosniff 与 CSP sandbox', async () => {
  const url = await upload('image/png', Buffer.from('89504e470d0a1a0a', 'hex'), 'x.png');
  const r = await call(url);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.headers['content-disposition'] || '', /^attachment/i, '图片不应强制下载');
  assert.match(r.headers['content-security-policy'] || '', /sandbox/, '缺 CSP sandbox');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

await test('relay：带 x-pi-relay 不带 token 的 HTTP 请求返回 401', async () => {
  const r = await call('/api/rooms', { headers: { 'x-pi-relay': '1' } });
  assert.equal(r.status, 401, `实际 ${r.status}`);
});
await test('relay：带 x-pi-relay 不带 token 的 WS 被拒', async () => {
  assert.equal(await wsFirst({ 'x-pi-relay': '1' }), 'rejected');
});
await test('relay：带 x-pi-relay 和伪造 Bearer 的 WS 被拒', async () => {
  assert.equal(await wsFirst({ 'x-pi-relay': '1', authorization: 'Bearer nope' }), 'rejected');
});

server.close();
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });
let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}`); else { failed++; console.log(`✗ ${r.name}：${r.err}`); }
}
console.log(failed ? `${failed}/${results.length} 失败` : `全部 ${results.length} 项通过`);
process.exit(failed ? 1 : 0);
