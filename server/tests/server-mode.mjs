/**
 * 服务器部署模式（设了 PI_BOT_TOKEN）的鉴权回归。
 *   node tests/server-mode.mjs
 *
 * 背景：反向代理和服务端在同一台机器上时，公网请求经代理转发后在服务端看来来自回环地址。
 * 「本机免 token」在这种部署下等于谁都能进。这里验：
 *   ① 本机部署（没设 PI_BOT_TOKEN）：行为不变，本机免 token；
 *   ② 服务器部署（设了 PI_BOT_TOKEN）：本机不带 token 也拒，带 token 放行（HTTP 和 WS 都是）；
 *   ③ PI_BOT_TRUST_LOCAL 可以显式覆盖默认；
 *   ④ PI_BOT_ALLOWED_HOSTS：反向代理保留原始域名时不再被 Host 校验拒掉。
 *
 * config 只在进程启动时读一次环境变量，所以每种配置起一个独立子进程。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const TOKEN = 'server-mode-test-token';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-server-mode-'));

/** 子进程：用给定环境起一个只带 HTTP + WS 的服务端，打印端口后常驻 */
const CHILD = `
  const { createHttpServer } = await import('./src/http.js');
  const { attachWs } = await import('./src/ws.js');
  const { Pairing } = await import('./src/pairing.js');
  const runner = { availableModels: [], modelLabel: () => null, initNote: null, contextUsage: () => ({}) };
  const pairing = new Pairing();
  const server = createHttpServer({ runner, pairing });
  attachWs(server, { runner });
  server.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + server.address().port + '\\n'));
`;

async function startServer(env, tag) {
  const home = path.join(root, tag);
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: process.cwd(),
    env: { ...process.env, PI_BOT_TOKEN: '', PI_BOT_TRUST_LOCAL: '', PI_BOT_ALLOWED_HOSTS: '', ...env, PI_BOT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`服务端没起来：${out}`)), 15_000);
    child.stdout.on('data', (b) => {
      out += b;
      const m = /PORT (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (code) => reject(new Error(`服务端提前退出 code=${code}：${out}`)));
  });
  return { port, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

function call(port, pathname, { method = 'GET', token = '', host = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          host: host ?? `127.0.0.1:${port}`,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'x-pi-bot-client': 'test' } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** WS 握手：第一帧是 hello → 'open'；服务端发 unauthorized 或拒绝握手 → 'unauthorized' / 'rejected' */
function wsProbe(port, { token = '' } = {}) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const ws = new WebSocket(url);
    const done = (v) => {
      try { ws.terminate(); } catch { /* 已经断开 */ }
      resolve(v);
    };
    ws.on('message', (raw) => {
      const t = JSON.parse(String(raw));
      done(t.t === 'hello' ? 'open' : t.error === 'unauthorized' ? 'unauthorized' : `other:${t.t}`);
    });
    ws.on('unexpected-response', () => done('rejected'));
    ws.on('error', () => done('rejected'));
    ws.on('close', (code) => done(code === 4401 ? 'unauthorized' : 'rejected'));
    setTimeout(() => done('timeout'), 3000);
  });
}

await test('① 本机部署（没设 PI_BOT_TOKEN）：本机不带 token 照常放行', async () => {
  const s = await startServer({}, 'local');
  try {
    assert.equal(await call(s.port, '/api/state'), 200);
    assert.equal(await call(s.port, '/api/policy', { method: 'PATCH', body: { dangerous: 'allow' } }), 200);
    assert.equal(await wsProbe(s.port), 'open', '本机 WS 不带 token 应能连上');
  } finally {
    await s.stop();
  }
});

await test('② 服务器部署（设了 PI_BOT_TOKEN）：本机不带 token 也拒（模拟反向代理转发）', async () => {
  const s = await startServer({ PI_BOT_TOKEN: TOKEN }, 'server');
  try {
    assert.equal(await call(s.port, '/api/state'), 401, '经代理转发、不带 token 的读请求必须拒');
    assert.equal(
      await call(s.port, '/api/policy', { method: 'PATCH', body: { dangerous: 'allow' } }),
      401,
      '经代理转发、不带 token 的改配置请求必须拒',
    );
    assert.equal(await wsProbe(s.port), 'unauthorized', 'WS 不带 token 必须拒');
  } finally {
    await s.stop();
  }
});

await test('② 服务器部署：带正确 token 放行，带错 token 拒', async () => {
  const s = await startServer({ PI_BOT_TOKEN: TOKEN }, 'server-ok');
  try {
    assert.equal(await call(s.port, '/api/state', { token: TOKEN }), 200);
    assert.equal(await call(s.port, '/api/state', { token: 'wrong-token' }), 401);
    assert.equal(await wsProbe(s.port, { token: TOKEN }), 'open');
    assert.equal(await call(s.port, '/health'), 200, '/health 仍然公开（桌面端和负载均衡探活要用）');
  } finally {
    await s.stop();
  }
});

async function health(port) {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  return r.json();
}

await test('② 服务器部署：/health 只报身份和 auth=token，不暴露房间数、模型名', async () => {
  const s = await startServer({ PI_BOT_TOKEN: TOKEN }, 'health-server');
  try {
    const h = await health(s.port);
    assert.equal(h.ok, true);
    assert.equal(h.auth, 'token');
    assert.equal(h.stats, undefined, '公网上的 /health 不该带 stats');
    assert.equal(h.model, undefined, '公网上的 /health 不该带模型名');
  } finally {
    await s.stop();
  }
});

await test('① 本机部署：/health 报 auth=local，照旧带 stats（桌面端启动页要用）', async () => {
  const s = await startServer({}, 'health-local');
  try {
    const h = await health(s.port);
    assert.equal(h.auth, 'local');
    assert.equal(typeof h.stats?.rooms, 'number');
  } finally {
    await s.stop();
  }
});

await test('③ PI_BOT_TRUST_LOCAL=1：设了 token 也保留本机免 token（显式选择）', async () => {
  const s = await startServer({ PI_BOT_TOKEN: TOKEN, PI_BOT_TRUST_LOCAL: '1' }, 'trust-on');
  try {
    assert.equal(await call(s.port, '/api/state'), 200);
  } finally {
    await s.stop();
  }
});

await test('③ PI_BOT_TRUST_LOCAL=0：没设 token 也不信任本机（本机也要配对）', async () => {
  const s = await startServer({ PI_BOT_TRUST_LOCAL: '0' }, 'trust-off');
  try {
    assert.equal(await call(s.port, '/api/state'), 401);
  } finally {
    await s.stop();
  }
});

await test('④ 反向代理保留原始域名：不在白名单 → 403；加进 PI_BOT_ALLOWED_HOSTS → 带 token 可进', async () => {
  const before = await startServer({ PI_BOT_TOKEN: TOKEN }, 'host-default');
  try {
    assert.equal(await call(before.port, '/api/state', { token: TOKEN, host: 'pi.example.com' }), 403);
  } finally {
    await before.stop();
  }
  const after = await startServer({ PI_BOT_TOKEN: TOKEN, PI_BOT_ALLOWED_HOSTS: 'PI.example.com, other.example.org' }, 'host-allowed');
  try {
    assert.equal(await call(after.port, '/api/state', { token: TOKEN, host: 'pi.example.com' }), 200, '大小写不敏感');
    assert.equal(await call(after.port, '/api/state', { token: TOKEN, host: 'pi.example.com:443' }), 200, '带端口也认');
    assert.equal(await call(after.port, '/api/state', { host: 'pi.example.com' }), 401, '域名放行不等于免 token');
    assert.equal(await call(after.port, '/api/state', { token: TOKEN, host: 'evil.example.net' }), 403, '不在名单的域名照样拒');
  } finally {
    await after.stop();
  }
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed++;
    console.log(`  ✗ ${r.name}\n      ${r.err}`);
  }
}
console.log(`\n服务器部署模式：${results.length - failed}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
