/**
 * relay agent 外连防护回归测试：
 *   node tests/relay-openstream.mjs
 *
 * 用小假中转直接给 agent 发帧：
 *   1. ws-open path 为绝对 URL → agent 回 ws-close 1008，"外部目标"收不到连接；
 *   2. ws-open path 为协议相对路径 → 同上；
 *   3. ws-open path='/ws' → 正常桥接到本地；
 *   4. req 帧 path 为绝对 URL → 仍只打到本地服务端（http.request 固定了 hostname/port）。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const { startRelayAgent } = await import('../src/relay/agent.js');
const { encodeFrame, decodeFrame, packBody, unpackBody } = await import('../src/relay/frames.js');

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
const listen = (srv, host) => new Promise((r) => srv.listen(0, host, r));

// ---------- 本地服务端（agent 的 local） ----------
const localHits = [];
const local = http.createServer((req, res) => {
  localHits.push(req.url);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"local":true}');
});
const localWss = new WebSocketServer({ server: local, path: '/ws' });
localWss.on('connection', (ws) => ws.on('message', (d) => ws.send(`echo:${d}`)));
await listen(local, '127.0.0.1');
const localPort = local.address().port;

// ---------- "外部目标"：另一个 host（127.0.0.2），HTTP + WS 都计数 ----------
let externalHits = 0;
const external = http.createServer((req, res) => {
  externalHits++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"external":true}');
});
const externalWss = new WebSocketServer({ server: external });
externalWss.on('connection', () => externalHits++);
external.on('upgrade', () => externalHits++);
await listen(external, '127.0.0.2');
const extPort = external.address().port;

// ---------- 假中转 ----------
const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((r) => fake.once('listening', r));
let agentSock = null;
const frames = [];
fake.on('connection', (ws) => {
  agentSock = ws;
  ws.on('message', (raw) => frames.push(decodeFrame(raw.toString())));
});
const agent = startRelayAgent({
  relay: `ws://127.0.0.1:${fake.address().port}/agent`,
  code: crypto.randomBytes(6).toString('hex'),
  local: `http://127.0.0.1:${localPort}`,
});
for (let i = 0; i < 60 && !agentSock; i++) await sleep(50);
assert.ok(agentSock, 'agent 没连上假中转');

const waitFrame = async (pred, ms = 2000) => {
  for (let i = 0; i < ms / 25; i++) {
    const f = frames.find(pred);
    if (f) return f;
    await sleep(25);
  }
  return null;
};

async function expectRejected(id, path) {
  const before = externalHits;
  agentSock.send(encodeFrame({ t: 'ws-open', id, path, headers: {} }));
  const close = await waitFrame((f) => f?.t === 'ws-close' && f.id === id);
  assert.ok(close, `应收到 ws-close（path=${path}）`);
  assert.equal(close.code, 1008, `应以 1008 关闭（实际 ${close.code}）`);
  await sleep(300);
  assert.equal(externalHits, before, '外部目标不应收到任何连接');
  assert.equal(agent.stats.streams, 0, '不应留下桥接');
}

await test('ws-open path=ws://evil.example/ws → 1008', () => expectRejected('abs-1', 'ws://evil.example/ws'));
await test('ws-open path=ws://127.0.0.2:<port>/ws → 1008 且外部目标无连接', () =>
  expectRejected('abs-2', `ws://127.0.0.2:${extPort}/ws`));
await test('ws-open path=//evil.example/ws（协议相对）→ 1008', () => expectRejected('rel-1', '//evil.example/ws'));
await test('ws-open path=//127.0.0.2:<port>/ws（协议相对）→ 1008 且外部目标无连接', () =>
  expectRejected('rel-2', `//127.0.0.2:${extPort}/ws`));

await test('ws-open path=/ws → 正常桥接到本地', async () => {
  agentSock.send(encodeFrame({ t: 'ws-open', id: 'ok-1', path: '/ws', headers: {} }));
  agentSock.send(encodeFrame({ t: 'ws-msg', id: 'ok-1', dir: 'c2s', ...packBody(Buffer.from('hi')) }));
  const msg = await waitFrame((f) => f?.t === 'ws-msg' && f.id === 'ok-1');
  assert.ok(msg, '应收到本地回显');
  assert.equal(unpackBody(msg).toString(), 'echo:hi');
  assert.ok(!frames.some((f) => f?.t === 'ws-close' && f.id === 'ok-1'), '不应被关闭');
  agentSock.send(encodeFrame({ t: 'ws-close', id: 'ok-1', code: 1000 }));
});

await test('req path=http://127.0.0.2:<port>/x（绝对 URL）→ 只打到本地，不外连', async () => {
  const before = externalHits;
  const url = `http://127.0.0.2:${extPort}/x`;
  agentSock.send(encodeFrame({ t: 'req', id: 'http-1', method: 'GET', path: url, headers: {} }));
  const res = await waitFrame((f) => f?.t === 'res' && f.id === 'http-1');
  assert.ok(res, '应收到 res');
  assert.deepEqual(JSON.parse(unpackBody(res).toString()), { local: true });
  assert.equal(externalHits, before, '外部目标不应收到请求');
  assert.ok(localHits.includes(url), '请求应落在本地服务端');
});

agent.close();
await new Promise((r) => fake.close(r));
localWss.close();
externalWss.close();
await new Promise((r) => local.close(r));
await new Promise((r) => external.close(r));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.err}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
