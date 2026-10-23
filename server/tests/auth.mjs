/**
 * 鉴权测试：配对接口与设备接口的可见范围。
 *   node tests/auth.mjs
 *
 * 覆盖：
 *   ① 非回环请求无法获取配对码（/api/pairing 返回 401，/pair 页面不含码）；
 *   ② 非回环请求无法读取或撤销设备；
 *   ③ 回环请求（桌面端）保持可读可管；
 *   ④ 配对码一次性，换发 token 后立即失效。
 *
 * 非回环用例通过本机局域网地址发起，回环地址无法覆盖该路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_auth');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { createHttpServer, hostAllowed } = await import('../src/http.js');
const { Pairing, lanAddresses } = await import('../src/pairing.js');
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

const lan = lanAddresses()[0]?.address ?? null;
/** 上一个已经换过 token 的码（验「一码一用」） */
let spentCode = null;

/** 只打本测试用得到的几条路由，runner 用不到，给个空壳 */
const runner = { availableModels: [], modelLabel: () => null, initNote: null };
const pairing = new Pairing();
const server = createHttpServer({ runner, pairing });
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const port = server.address().port;

/** @returns {Promise<{status:number, body:any, text:string}>} */
function call(host, pathname, { method = 'GET', body = null, token = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: pathname,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
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
          resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

await test('回环请求可获取配对码', async () => {
  const r = await call('127.0.0.1', '/api/pairing');
  assert.equal(r.status, 200);
  assert.equal(r.body.code, pairing.code, '本机要看到真码');
});

await test('本机能看设备列表，也能撤销设备', async () => {
  const { token } = store.addDevice('测试手机');
  const list = await call('127.0.0.1', '/api/devices');
  assert.equal(list.status, 200);
  const row = list.body.devices.find((d) => d.name === '测试手机');
  assert.ok(row, '列表里要有刚加的设备');
  assert.ok(!('token' in row), '设备列表不能把 token 原文发出去');
  assert.ok(row.id, '必须给出 id —— 客户端只能靠它撤销');

  // ★ 撤销走 id（App 用的就是这条；以前 App 拿不到 token，删的是 "null"，所以"移除没反应"）
  const del = await call('127.0.0.1', `/api/devices/${row.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.body.revoked, true);

  const after = await call('127.0.0.1', '/api/devices');
  assert.ok(!after.body.devices.some((d) => d.id === row.id), '撤销后列表里不该再有它');
  assert.equal(store.findDeviceByToken(token), null, 'token 也要一起失效');
});

await test('撤销也认 token（历史调用方式）', async () => {
  const { token } = store.addDevice('老客户端');
  const del = await call('127.0.0.1', `/api/devices/${token}`, { method: 'DELETE' });
  assert.equal(del.body.revoked, true);
});

await test('撤销不存在的设备返回 false', async () => {
  const del = await call('127.0.0.1', '/api/devices/d_nope', { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.body.revoked, false);
});

await test('回环请求打开的 /pair 页面包含配对码', async () => {
  const r = await call('127.0.0.1', '/pair');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(pairing.code), '本机页面应该印出码');
});

if (lan) {
  await test(`远程（${lan}）拿不到配对码`, async () => {
    const r = await call(lan, '/api/pairing');
    assert.equal(r.status, 401, '未鉴权的远程请求必须被挡下来');
    assert.ok(!r.text.includes(pairing.code), '响应里绝不能带码');
  });

  await test(`远程（${lan}）打不开 /pair 里的码`, async () => {
    const r = await call(lan, '/pair');
    assert.equal(r.status, 200, '页面本身可以公开（地址不是秘密）');
    assert.ok(!r.text.includes(pairing.code), '远程页面上不许出现码');
    assert.ok(r.text.includes('服务端控制台'), '要告诉用户码在哪儿看');
  });

  await test(`远程（${lan}）读不到设备列表`, async () => {
    store.addDevice('不该被看到的设备');
    const r = await call(lan, '/api/devices');
    assert.equal(r.status, 401);
    assert.ok(!r.text.includes('不该被看到的设备'));
  });

  await test(`远程（${lan}）删不掉设备（撤销接口要鉴权）`, async () => {
    const { token } = store.addDevice('受害者');
    const r = await call(lan, `/api/devices/${token}`, { method: 'DELETE' });
    assert.equal(r.status, 401);
    assert.equal(store.revokeDevice(token), true, '设备应该还在（撤销要由本机做）');
  });

  await test(`远程（${lan}）仍然可以配对 —— 带码换 token`, async () => {
    const code = pairing.code;
    const r = await call(lan, '/api/pair', { method: 'POST', body: { code, deviceName: '我的手机' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.token, '要发 token');
    assert.notEqual(pairing.code, code, '★ 码必须换掉：一个码只能换一次 token');
    spentCode = code;
  });

  await test('用过的码不能再用', async () => {
    const r = await call(lan, '/api/pair', { method: 'POST', body: { code: spentCode, deviceName: 'x' } });
    assert.equal(r.status, 401);
  });
} else if (process.env.CI) {
  // CI 上没有局域网地址，上面 6 条最关键的远程鉴权用例就一条都没跑 —— 以前汇总照样全绿。
  // 记一条失败，让「没测到」看得见。本地没有网卡只提示、不算失败。
  results.push({ name: '远程鉴权用例（本机没有局域网地址，一条没跑）', ok: false, err: '没有局域网地址可用来模拟远程请求' });
} else {
  console.log('（本机没有局域网地址，跳过 6 条远程用例 —— 它们验的是最关键的那部分鉴权）');
}

await test('错码不放行', async () => {
  const r = await call('127.0.0.1', '/api/pair', { method: 'POST', body: { code: '000000' } });
  assert.equal(r.status, 401);
});

await test('hostAllowed：本机名/局域网 IP 放行，外部域名拒绝', () => {
  assert.equal(hostAllowed('127.0.0.1:8787'), true);
  assert.equal(hostAllowed('localhost:8787'), true);
  assert.equal(hostAllowed('[::1]:8787'), true);
  assert.equal(hostAllowed('evil.example.com:8787'), false);
  assert.equal(hostAllowed(''), false);
});

await test('★ 伪造 Host 的请求一律 403（防 DNS rebinding）', async () => {
  const r = await call('127.0.0.1', '/api/state', {
    headers: { host: 'evil.example.com' },
  });
  assert.equal(r.status, 403);
});

await test('★ 响应不再带 ACAO *（浏览器读不到）', async () => {
  const r = await call('127.0.0.1', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

await test('★ 状态变更请求必须 application/json（跨域 text/plain 打不进来）', async () => {
  const r = await call('127.0.0.1', '/api/tasks', {
    method: 'POST',
    body: { title: 'x' },
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(r.status, 415);
});

await test('请求体超过 1MB：回 413，不是 500', async () => {
  const big = { note: 'x'.repeat(1024 * 1024 + 16) };
  const r = await call('127.0.0.1', '/api/user', { method: 'PATCH', body: big });
  assert.equal(r.status, 413, `超长请求应该是 413（实际 ${r.status}）`);
  assert.equal(r.body?.code, 'BODY_TOO_LARGE');
});

await test('★ 带 token 的请求不再每次重写 state.json（最近在线时间只在内存里更新）', async () => {
  const { token } = store.addDevice('频繁请求的手机');
  await call('127.0.0.1', '/api/state', { token });
  await new Promise((r) => setTimeout(r, 400)); // 等第一次（允许的）落盘跑完
  let saves = 0;
  const orig = store.saveNow.bind(store);
  store.saveNow = () => { saves++; return orig(); };
  try {
    for (let i = 0; i < 5; i++) await call('127.0.0.1', '/api/state', { token });
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    store.saveNow = orig;
  }
  assert.equal(saves, 0, `一分钟内重复请求不该触发落盘，实际 ${saves} 次`);
  const dev = store.listDevicesPublic().find((d) => d.name === '频繁请求的手机');
  assert.ok(Date.now() - dev.lastSeenAt < 5000, '内存里的最近在线时间要是新的');
});

server.close();
pairing.stop();

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 鉴权测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
