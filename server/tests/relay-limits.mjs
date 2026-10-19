/**
 * 中转的边界与故障测试：
 *   node tests/relay-limits.mjs
 *
 * 覆盖四件事（都是"以前会带崩进程"的地方）：
 *   1. 本地响应 > 16MB：手机应收到 413 + frame_too_large，agent 继续活着；
 *   2. 手机 ws 发 > 16MB：中转不崩，那条桥接被关掉（1013）；
 *   3. 手机 ws 发 > maxPayload：由 ws 层关（1009），中转照常服务；
 *   4. 中转断开：agent 清掉本地的桥接与积压队列，不留泄漏。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';

const { createRelay } = await import('../src/relay/server.js');
const { startRelayAgent } = await import('../src/relay/agent.js');
const { encodeFrame } = await import('../src/relay/frames.js');

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
const BIG = 20 * 1024 * 1024;

// ---------- 假 host ----------
let hostWsClosed = 0;
const host = http.createServer((req, res) => {
  if (req.url.startsWith('/big')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(Buffer.alloc(BIG, 0x41));
  }
  if (req.url.startsWith('/ok')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"nope"}');
});
const hostWss = new WebSocketServer({ server: host, path: '/ws' });
hostWss.on('connection', (ws) => {
  ws.on('message', (d) => ws.send(`echo:${d.toString()}`));
  ws.on('close', () => {
    hostWsClosed++;
  });
});
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const hostPort = host.address().port;

// ---------- relay + agent ----------
const secret = 'fixture-secret';
const relay = createRelay({ secret, port: 0, host: '127.0.0.1' });
const addr = await relay.listen();
const relayPort = addr.port;
const code = crypto.randomBytes(6).toString('hex');
const base = `http://127.0.0.1:${relayPort}`;
const wsBase = `ws://127.0.0.1:${relayPort}`;

const agent = startRelayAgent({
  relay: `${wsBase}/agent`,
  code,
  secret,
  local: `http://127.0.0.1:${hostPort}`,
});

await (async () => {
  for (let i = 0; i < 60 && !agent.connected; i++) await sleep(50);
  assert.ok(agent.connected, 'agent 没连上中转');
})();

// ---------- 1. 响应超限 ----------
await test('本地响应 20MB → 手机收 413 且 agent 存活', async () => {
  const res = await fetch(`${base}/${code}/big`);
  const body = await res.json();
  assert.equal(res.status, 413);
  assert.equal(body.code, 'frame_too_large');
  // 进程还活着：紧接着的正常请求仍然通
  const ok = await fetch(`${base}/${code}/ok`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

// ---------- 2. 手机上行的 ws 消息超限 ----------
// 用单独的配对码开一个替身房间，避免把主 agent 挤掉（会触发重连，干扰别的用例）
const roomCode = crypto.randomBytes(6).toString('hex');

await test('手机 ws 发 20MB → 中转不崩、桥接被关闭', async () => {
  const agentSocket = new WebSocket(`${wsBase}/agent?code=${roomCode}&secret=${secret}`);
  const client = new WebSocket(`${wsBase}/${roomCode}/ws`);
  await Promise.all([
    new Promise((r) => agentSocket.on('open', r)),
    new Promise((r) => client.on('open', r)),
  ]);

  let closeCode = null;
  client.on('close', (c) => {
    closeCode = c;
  });
  client.send(Buffer.alloc(BIG, 0x42));
  await sleep(600);
  assert.equal(closeCode, 1013, '客户端应以 1013（消息过大）被关闭');
  // 中转还活着
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  agentSocket.close();
});

// ---------- 3. 超过 ws maxPayload ----------
await test('手机 ws 发 40MB → ws 层关闭，中转继续服务', async () => {
  const agentSocket = new WebSocket(`${wsBase}/agent?code=${roomCode}&secret=${secret}`);
  await new Promise((r) => agentSocket.on('open', r));
  const client = new WebSocket(`${wsBase}/${roomCode}/ws`);
  await new Promise((r) => client.on('open', r));
  let closeCode = null;
  client.on('close', (c) => {
    closeCode = c;
  });
  client.send(Buffer.alloc(40 * 1024 * 1024, 0x43));
  await sleep(800);
  assert.ok(closeCode === 1009 || closeCode === 1013, `应以 1009/1013 关闭（实际 ${closeCode}）`);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  agentSocket.close();
});

// ---------- 4. 中转断开时清理本地桥接 ----------
await test('中转断开 → agent 清空 streams/queues 并关掉本地 ws', async () => {
  // 用一个小假中转：它发一个 ws-open，再主动断开
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => fake.once('listening', r));
  const fakePort = fake.address().port;
  let fakeSocket = null;
  fake.on('connection', (ws) => {
    fakeSocket = ws;
    ws.send(encodeFrame({ t: 'ws-open', id: 'leak-1', path: '/ws', headers: {} }));
  });

  const before = hostWsClosed;
  const probe = startRelayAgent({
    relay: `ws://127.0.0.1:${fakePort}/agent`,
    code,
    local: `http://127.0.0.1:${hostPort}`,
  });
  for (let i = 0; i < 60 && probe.stats.streams === 0; i++) await sleep(50);
  assert.equal(probe.stats.streams, 1, '桥接应该先建立起来');

  fakeSocket.close();
  await sleep(400);

  assert.equal(probe.stats.streams, 0, '断开后 streams 应清空');
  assert.equal(probe.stats.queues, 0, '断开后 queues 应清空');
  assert.ok(hostWsClosed > before, '本地 ws 应该被关掉（否则泄漏）');

  probe.close();
  await new Promise((r) => fake.close(r));
});

agent.close();
await relay.close();
hostWss.close();
await new Promise((r) => host.close(r));

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.err}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
