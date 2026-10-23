/**
 * SSRF 统一拦截回归。
 *   node tests/ssrf-regress.mjs
 *
 * 每个会发出用户/模型可控请求的入口至少一条，
 * 十进制 / 八进制 / IPv6 映射 / 重定向到内网 / DNS rebinding 各至少一条。
 * 不依赖外网：字面量直接判，rebinding 只连本机回环上的探针对手。
 */
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_ssrf');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { assertPublicTarget, webFetch } = await import('../src/web.js');
const { probeLogin } = await import('../src/site-probe.js');
const { createSiteRuntime } = await import('../src/site-runtime.js');
const { normalizeSite } = await import('../src/sites.js');
const { testMcpServer } = await import('../src/mcp.js');
const { checkForUpdate, clearUpdateCache } = await import('../src/update-checker.js');
const { testModelGroup } = await import('../src/model-groups.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

function countFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    // redirect:follow 时假 fetch 自己把跳转走完，用来抓住「没改成 manual」
    if (init?.redirect !== 'manual') {
      calls.push('http://127.0.0.1/secret');
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'secret',
        arrayBuffer: async () => Buffer.from('secret'),
        json: async () => ({ accessToken: 'secret' }),
      };
    }
    if (calls.length === 1) {
      return {
        status: 302,
        ok: false,
        headers: new Headers({ location: 'http://2130706433/secret' }),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'secret',
      arrayBuffer: async () => Buffer.from('secret'),
      json: async () => ({ accessToken: 'secret' }),
    };
  };
  impl.calls = calls;
  return impl;
}

await test('十进制 IP：站点探测在发出请求前拒绝', async () => {
  let called = false;
  const r = await probeLogin({
    baseUrl: 'http://2130706433',
    account: 'a',
    password: 'b',
    paths: ['/login'],
    accountField: 'account',
    passwordField: 'password',
    fetchImpl: async () => {
      called = true;
      throw new Error('不应该发出请求');
    },
  });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.match(r.reason, /拒绝访问/);
});

await test('八进制 IP：MCP 测试连接拒绝（https 绕得过明文回环白名单）', async () => {
  const r = await testMcpServer({
    type: 'http',
    url: 'https://0177.0.0.1:9/mcp',
    timeout: 2,
  });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /拒绝访问/);
});

await test('IPv6 映射：站点查询拒绝，且不发请求', async () => {
  let called = false;
  const site = normalizeSite({
    baseUrl: 'http://[::ffff:10.0.0.1]',
    account: 'u',
    password: 'p',
  });
  const rt = createSiteRuntime({
    fetchImpl: async () => {
      called = true;
      throw new Error('不应该发出请求');
    },
  });
  const r = await rt.request({ site, path: '/api/items' });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.match(r.reason, /拒绝访问/);
});

await test('IPv6 映射 / NAT64 / 6to4 嵌内网要拦，公网十进制与 6to4 放行', async () => {
  for (const url of [
    'http://[::ffff:127.0.0.1]/',
    'http://[64:ff9b::127.0.0.1]/',
    'http://[2002:7f00:1::]/',
  ]) {
    await assert.rejects(() => assertPublicTarget(url), /拒绝访问/, url);
  }
  await assertPublicTarget('http://134744072/'); // 8.8.8.8
  await assertPublicTarget('http://[2002:0808:0808::]/');
});

await test('重定向到内网：站点探测每一跳都重新校验', async () => {
  const fetchImpl = countFetch();
  const r = await probeLogin({
    baseUrl: 'http://1.1.1.1',
    account: 'a',
    password: 'b',
    paths: ['/login'],
    accountField: 'account',
    passwordField: 'password',
    fetchImpl,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /拒绝访问/);
  assert.deepEqual(fetchImpl.calls, ['http://1.1.1.1/login']);
});

await test('重定向到内网：web_fetch 不能把跳转后的正文读回来', async () => {
  const fetchImpl = countFetch();
  await assert.rejects(
    () => webFetch('http://1.1.1.1/start', { fetchImpl, timeoutMs: 1000 }),
    /拒绝访问/,
  );
  assert.deepEqual(fetchImpl.calls, ['http://1.1.1.1/start']);
});

await test('云元数据：更新检查拒绝，且不发请求', async () => {
  clearUpdateCache();
  let called = false;
  const info = await checkForUpdate({
    force: true,
    env: { PI_BOT_UPDATE_URL: 'http://169.254.169.254/latest/meta-data/' },
    fetchImpl: async () => {
      called = true;
      throw new Error('不应该发出请求');
    },
  });
  assert.equal(called, false);
  assert.equal(info.ok, false);
  assert.match(info.reason, /拒绝访问/);
});

await test('0.0.0.0：模型组测试连接拒绝，且不发请求', async () => {
  let called = false;
  const r = await testModelGroup({
    baseUrl: 'http://0.0.0.0:9',
    fetchImpl: async () => {
      called = true;
      throw new Error('不应该发出请求');
    },
  });
  assert.equal(called, false);
  assert.match(r.error || '', /拒绝访问/);
});

await test('DNS rebinding：第二次解析出的回环地址不能连上', async () => {
  const hits = { n: 0 };
  const server = http.createServer((req, res) => {
    hits.n += 1;
    res.end('secret');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    if (lookups === 1) return [{ address: '203.0.113.10', family: 4 }];
    return [{ address: '127.0.0.1', family: 4 }];
  };
  let text = '';
  try {
    const raced = await Promise.race([
      webFetch(`http://localhost:${port}/secret`, { lookup, timeoutMs: 700 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('测试超时')), 2500)),
    ]);
    text = raced.text || '';
  } catch (err) {
    text = String(err?.message || err);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(hits.n, 0, '连到了回环上的探针，说明没用校验时的公网地址');
  assert.equal(text.includes('secret'), false);
  assert.doesNotMatch(text, /拒绝访问/);
  assert.equal(lookups, 1, '连接阶段不能再解析一次');
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed++;
    console.log(`  ✗ ${r.name}\n      ${r.err}`);
  }
}
console.log(`\nSSRF 回归：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
