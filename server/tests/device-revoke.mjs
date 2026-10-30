/**
 * 移除设备要"真的断开"：
 *   node tests/device-revoke.mjs
 *
 * 覆盖：
 *   ① 设备列表不下发 token（只给 id）—— 客户端靠 id 撤销；
 *   ② 撤销后，那台设备已经建立的 WebSocket 立刻被服务端关掉（4401），
 *      不能靠长连接继续收消息；
 *   ③ 别的设备不受影响。
 */
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_device_revoke');
const fs = await import('node:fs');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { createHttpServer } = await import('../src/http.js');
const { attachWs } = await import('../src/ws.js');
const { Pairing } = await import('../src/pairing.js');
const { store } = await import('../src/store.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const runner = { availableModels: [], modelLabel: () => null, initNote: null, send: async () => ({}) };
const server = createHttpServer({ runner, pairing: new Pairing() });
attachWs(server, { runner });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.closeInfo = null;
    ws.on('close', (code, reason) => {
      ws.closeInfo = { code, reason: String(reason ?? '') };
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws 连接超时')), 3000);
  });
}

async function call(pathname, { method = 'GET' } = {}) {
  const headers = method !== 'GET' ? { 'x-pi-bot-client': 'test' } : {};
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

await test('设备列表不给 token，只给 id', async () => {
  const { token, device } = store.addDevice('被移除的手机');
  const r = await call('/api/devices');
  const row = r.body.devices.find((d) => d.id === device.id);
  assert.ok(row, '列表里要有它');
  assert.ok(!('token' in row), '不能把 token 发出去');
  assert.equal(row.id, device.id);
  void token;
});

await test('撤销后那台设备的 ws 立刻断开（4401）', async () => {
  const { token, device } = store.addDevice('在线手机');
  const ws = await openWs(token);
  assert.equal(ws.readyState, WebSocket.OPEN);

  const del = await call(`/api/devices/${device.id}`, { method: 'DELETE' });
  assert.equal(del.body.revoked, true);

  for (let i = 0; i < 40 && !ws.closeInfo; i++) await sleep(50);
  assert.ok(ws.closeInfo, 'ws 应该被服务端关掉');
  assert.equal(ws.closeInfo.code, 4401, `关闭码应为 4401（实际 ${ws.closeInfo.code}）`);
});

await test('撤销一台设备不影响另一台', async () => {
  const a = store.addDevice('手机A');
  const b = store.addDevice('手机B');
  const wsB = await openWs(b.token);

  await call(`/api/devices/${a.device.id}`, { method: 'DELETE' });
  await sleep(300);

  assert.equal(wsB.readyState, WebSocket.OPEN, 'B 的连接应该还活着');
  assert.ok(store.findDeviceByToken(b.token), 'B 应该还在');
  wsB.close();
});

server.close();
await new Promise((r) => setTimeout(r, 100));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.err}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
