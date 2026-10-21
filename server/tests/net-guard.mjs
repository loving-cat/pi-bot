/**
 * web_fetch 的内网拦截（SSRF 防护）回归测试。
 *   node tests/net-guard.mjs
 *
 * 为什么要有这一组：web_fetch 的输入来自模型。模型只要读了一个被投毒的网页，
 * 就可能被诱导去抓本机 API（loopback 免鉴权，能读到全部聊天记录和配置）
 * 或云元数据地址。这类问题不报错、只是"内容被抓回来了"，事后极难发现。
 *
 * 全程不联网：只做地址判定 + 断言请求在发出前就被拒绝。
 */
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_net_guard');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { assertPublicTarget, webFetch } = await import('../src/web.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

await test('拦截内网 / 环回 / 链路本地 / CGNAT（IPv4 字面量）', async () => {
  const urls = [
    'http://127.0.0.1:18787/api/state',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://224.0.0.1/',
  ];
  for (const url of urls) {
    await assert.rejects(
      () => assertPublicTarget(url),
      /拒绝访问/,
      `必须拦下 ${url}`,
    );
  }
});

await test('拦截 IPv6 环回 / ULA / link-local / IPv4 映射', async () => {
  const urls = [
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
  ];
  for (const url of urls) {
    await assert.rejects(
      () => assertPublicTarget(url),
      /拒绝访问/,
      `必须拦下 ${url}`,
    );
  }
});

await test('放行公网地址', async () => {
  for (const url of ['https://1.1.1.1/', 'http://8.8.8.8/', 'https://example.com/']) {
    await assertPublicTarget(url);
  }
});

await test('★ 放行 TUN 假 IP（198.18.0.0/15）—— 拦了会让开代理的用户断网', async () => {
  for (const url of ['http://198.18.0.207/', 'https://198.19.1.1/']) {
    await assertPublicTarget(url);
  }
});

await test('localhost 域名解析后也要拦', async () => {
  await assert.rejects(() => assertPublicTarget('http://localhost:18787/'), /拒绝访问/);
});

await test('webFetch 对内网地址直接拒绝（错误要说清是拦截，不是网络失败）', async () => {
  await assert.rejects(
    () => webFetch('http://127.0.0.1:18787/api/state'),
    /拒绝访问/,
  );
  await assert.rejects(
    () => webFetch('http://169.254.169.254/latest/meta-data/'),
    /拒绝访问/,
  );
});

await test('非 http/https 仍然拒绝', async () => {
  await assert.rejects(() => webFetch('file:///etc/passwd'), /只支持 http\/https/);
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed++;
    console.log(`  ✗ ${r.name}\n      ${r.err}`);
  }
}
console.log(`\n内网拦截测试：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
