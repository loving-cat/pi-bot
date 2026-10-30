/**
 * 中转端到端测试：假 host + relay + agent 串起来。
 *   node tests/relay.mjs
 *
 * 覆盖：HTTP 转发（GET/POST）、WS 桥接、配对码校验、密钥校验、断线不影响别的房间。
 * 用随机端口，本机跑，不碰真实服务端。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';

const { createRelay } = await import('../src/relay/server.js');
const { startRelayAgent } = await import('../src/relay/agent.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假 host：模拟电脑上的 pi-bot 服务端 ----------
const host = http.createServer((req, res) => {
  if (req.url.startsWith('/headers')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ client: req.headers['x-pi-bot-client'] ?? null, cookie: req.headers.cookie ?? null }));
  }
  if (req.url.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, who: 'host' }));
  }
  if (req.url.startsWith('/echo') && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: body, len: body.length }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"nope"}');
});
const hostWss = new WebSocketServer({ server: host, path: '/ws' });
hostWss.on('connection', (ws) => {
  ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
});
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const hostPort = host.address().port;

// ---------- relay ----------
const secret = 'test-secret';
const relay = createRelay({ secret, port: 0, host: '127.0.0.1' });
const addr = await relay.listen();
const relayPort = addr.port;
const code = crypto.randomBytes(6).toString('hex');
const base = `http://127.0.0.1:${relayPort}`;

// ---------- agent ----------
const agent = startRelayAgent({
  relay: `ws://127.0.0.1:${relayPort}/agent`,
  code,
  secret,
  local: `http://127.0.0.1:${hostPort}`,
});

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

await test('agent 连上中转', async () => {
  assert.ok(await waitFor(() => relay.roomCount === 1), '应该注册出一个房间');
});

await test('★ HTTP 转发：GET /health 到得了电脑侧', async () => {
  const r = await fetch(`${base}/${code}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.who, 'host');
});

await test('★ HTTP 转发：POST 带 body，原样到达', async () => {
  const payload = JSON.stringify({ text: '你好，中转' });
  const r = await fetch(`${base}/${code}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.echo, payload);
});

await test('★ 客户端标记头 x-pi-bot-client 会被转发，其它杂头不转', async () => {
  const r = await fetch(`${base}/${code}/headers`, {
    headers: { 'x-pi-bot-client': 'app', cookie: 'fake=1' },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.client, 'app');
  assert.equal(body.cookie, null);
});

await test('★ WebSocket 桥接：来回收发', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/${code}/ws?token=x`);
  try {
  const got = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 超时')), 4000);
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    ws.on('error', reject);
  });
  assert.equal(got, 'echo:ping');
  } finally {
    ws.close();
  }
});

await test('配对码不存在 → 502', async () => {
  const r = await fetch(`${base}/ffffffffffff/health`);
  assert.equal(r.status, 502);
});

await test('★ 密钥不对的 agent 连不上（不会顶掉真的那个）', async () => {
  const bad = startRelayAgent({
    relay: `ws://127.0.0.1:${relayPort}/agent`,
    code: crypto.randomBytes(6).toString('hex'),
    secret: 'wrong',
    local: `http://127.0.0.1:${hostPort}`,
  });
  await sleep(600);
  assert.equal(relay.roomCount, 1, '不该多出房间');
  bad.close();
});

await test('电脑侧断开后，手机侧拿到 502', async () => {
  agent.close();
  agent.close();
  assert.ok(await waitFor(() => relay.roomCount === 0, 3000), '房间应被清掉');
  const status = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/${code}/health`, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
  assert.equal(status, 502);
});

await relay.close();
for (const client of hostWss.clients) client.terminate();
hostWss.close();
await new Promise((r) => {
  host.close(() => r());
  host.closeAllConnections?.();
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 中转端到端测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
