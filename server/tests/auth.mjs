/**
 * 鉴权回归测试：配对码 / 设备列表不能落到局域网上。
 *   node tests/auth.mjs
 *
 * 验的是（2026-10-17 体检里第 1 条的那个洞）：
 *   ① 远程（非回环）拿不到配对码 —— /api/pairing 401，/pair 页面里也不许出现码；
 *   ② 远程读不到也删不掉设备列表；
 *   ③ 本机（回环）照旧能看能管 —— PC 端 App 就是本机，不能把它关在门外；
 *   ④ 一个码只能换一次 token（换完立刻作废）。
 *
 * 为什么要真的从局域网地址打进来：回环请求本来就是"主人"，
 * 洞只在**非回环**时才存在 —— 光用 127.0.0.1 测是测不出这个 bug 的。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_auth');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { createHttpServer } = await import('../src/http.js');
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
function call(host, pathname, { method = 'GET', body = null, token = '' } = {}) {
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

await test('本机（回环）能拿到配对码 —— PC 端 App 要用', async () => {
  const r = await call('127.0.0.1', '/api/pairing');
  assert.equal(r.status, 200);
  assert.equal(r.body.code, pairing.code, '本机要看到真码');
});

await test('本机能看设备列表，也能撤销设备', async () => {
  const { token } = store.addDevice('测试手机');
  const list = await call('127.0.0.1', '/api/devices');
  assert.equal(list.status, 200);
  assert.ok(list.body.devices.some((d) => d.name === '测试手机'));
  assert.ok(!('token' in list.body.devices[0]), '设备列表不能把 token 原文发出去');
  const del = await call('127.0.0.1', `/api/devices/${token}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.body.revoked, true);
});

await test('本机打开 /pair 页面能看到码', async () => {
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
} else {
  console.log('（本机没有局域网地址，跳过远程用例）');
}

await test('错码不放行', async () => {
  const r = await call('127.0.0.1', '/api/pair', { method: 'POST', body: { code: '000000' } });
  assert.equal(r.status, 401);
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
