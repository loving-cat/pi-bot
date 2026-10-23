/**
 * 站点接入测试：配置规范化、登录探测、运行时（token 缓存 / 401 重登）。
 *
 * 全部用注入的假 fetch，不打真实网络。重点是那些"出错才发现"的路径：
 *   · 探测要能认出不同的字段名组合；
 *   · 探测失败的原因要能区分"口令错"和"路径不对"；
 *   · 运行时要能在 token 过期后自动重登，而且只重登一次。
 */
import assert from 'node:assert/strict';
import {
  normalizeSite,
  pickToken,
  isTokenExpired,
  decodeJwtPayload,
  publicSite,
  hostOf,
} from '../src/sites.js';
import { probeLogin, loginSite, assertSafeUrl } from '../src/site-probe.js';
import { createSiteRuntime } from '../src/site-runtime.js';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

/** 造一个假 JWT（exp 秒） */
function fakeJwt(expSecondsFromNow = 3600, extra = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, ...extra }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

/** 造一个按「路径+字段」响应的假 fetch */
function fakeFetch(handler) {
  let calls = 0;
  const impl = async (url, init) => {
    calls++;
    return handler(url, init);
  };
  impl.calls = () => calls;
  return impl;
}

const jsonResponse = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(obj),
  body: null,
});

// ---------------------------------------------------------------- 配置

await test('规范化：只接受 http(s) 地址，且必须有账号', () => {
  assert.equal(normalizeSite({ baseUrl: 'ftp://x', account: 'a' }), null);
  assert.equal(normalizeSite({ baseUrl: 'https://x.com' }), null, '没账号不行');
  const s = normalizeSite({ baseUrl: 'https://x.com/', account: 'a' });
  assert.equal(s.baseUrl, 'https://x.com', '末尾斜杠要去掉');
  assert.equal(s.name, 'x.com', '没给名字就用域名');
});

await test('规范化：默认登录配置合理', () => {
  const s = normalizeSite({ baseUrl: 'https://x.com', account: 'a', password: 'p' });
  assert.equal(s.auth.kind, 'json');
  assert.equal(s.auth.loginPath, '/api/auth/login');
  assert.equal(s.auth.accountField, 'account');
  assert.equal(s.auth.passwordField, 'password');
  assert.equal(s.auth.tokenPath, 'accessToken');
  assert.equal(s.auth.scheme, 'Bearer');
});

await test('对外摘要不含口令明文', () => {
  const s = normalizeSite({ baseUrl: 'https://x.com', account: 'a', password: 'secret123' });
  const pub = publicSite(s, { connected: true });
  assert.equal(pub.hasPassword, true);
  assert.ok(!JSON.stringify(pub).includes('secret123'), '口令不能出现在摘要里');
});

await test('取主机名', () => {
  assert.equal(hostOf('https://www.example.com/x'), 'example.com');
  assert.equal(hostOf('bad url'), 'bad url');
});

// ---------------------------------------------------------------- token

await test('按点号路径取 token', () => {
  assert.equal(pickToken({ accessToken: 'A' }, 'accessToken'), 'A');
  assert.equal(pickToken({ data: { token: 'B' } }, 'data.token'), 'B');
  assert.equal(pickToken({ data: null }, 'data.token'), '');
  assert.equal(pickToken(null, 'token'), '');
});

await test('JWT 过期判断', () => {
  const fresh = fakeJwt(3600);
  const stale = fakeJwt(-60);
  assert.equal(isTokenExpired(fresh), false);
  assert.equal(isTokenExpired(stale), true);
  assert.equal(isTokenExpired('not-a-jwt'), false, '不是 JWT 就当没过期');
});

await test('解 JWT payload', () => {
  const p = decodeJwtPayload(fakeJwt(100, { sub: '42' }));
  assert.equal(p.sub, '42');
  assert.equal(decodeJwtPayload('abc'), null);
});

// ---------------------------------------------------------------- 探测

await test('探测：认出 account+password 组合', async () => {
  const token = fakeJwt();
  const f = fakeFetch(async (url, init) => {
    if (url.endsWith('/api/auth/login')) {
      const body = JSON.parse(init.body);
      if (body.account && body.password) return jsonResponse({ accessToken: token });
      return jsonResponse({ error: 'bad' }, 400);
    }
    return jsonResponse({}, 404);
  });
  const r = await probeLogin({ baseUrl: 'https://x.com', account: 'u', password: 'p', fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.auth.accountField, 'account');
  assert.equal(r.auth.loginPath, '/api/auth/login');
  assert.equal(r.token, token);
});

await test('探测：字段名是冷门组合时，靠用户手动指定也能成', async () => {
  const token = fakeJwt();
  const f = fakeFetch(async (url, init) => {
    if (url.endsWith('/api/user/login')) {
      const body = JSON.parse(init.body);
      if (body.email && body.passwd) return jsonResponse({ data: { token } });
      return jsonResponse({ error: 'bad' }, 400);
    }
    return jsonResponse({}, 404);
  });
  // 自动探测有次数上限，冷门组合（email+passwd）排不进预算 ——
  // 这正是"失败时让用户手填字段名"那条路存在的理由。
  const auto = await probeLogin({ baseUrl: 'https://x.com', account: 'u', password: 'p', fetchImpl: f });
  assert.equal(auto.ok, false, '自动探测不该无限试下去');
  assert.match(auto.reason, /试了 \d+ 种组合/);

  // 用户指定字段名后，只试这一种组合，立刻成功
  const manual = await probeLogin({
    baseUrl: 'https://x.com',
    account: 'u',
    password: 'p',
    fetchImpl: f,
    accountField: 'email',
    passwordField: 'passwd',
  });
  assert.equal(manual.ok, true);
  assert.equal(manual.auth.accountField, 'email');
  assert.equal(manual.auth.passwordField, 'passwd');
  assert.equal(manual.auth.tokenPath, 'data.token');
});

await test('探测：口令错时说明是凭证问题', async () => {
  const f = fakeFetch(async () => jsonResponse({ error: 'unauthorized' }, 401));
  const r = await probeLogin({ baseUrl: 'https://x.com', account: 'u', password: 'wrong', fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /账号或口令不对/);
});

await test('探测：路径都不对时说清是找不到接口', async () => {
  const f = fakeFetch(async () => jsonResponse({}, 404));
  const r = await probeLogin({ baseUrl: 'https://x.com', account: 'u', password: 'p', fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没找到登录接口/);
});

await test('探测：登录成功但没 token 也要报失败', async () => {
  const f = fakeFetch(async () => jsonResponse({ ok: true }));
  const r = await probeLogin({ baseUrl: 'https://x.com', account: 'u', password: 'p', fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有 token/);
});

await test('探测：尝试次数有上限（不打爆对方）', async () => {
  const f = fakeFetch(async () => jsonResponse({}, 404));
  const r = await probeLogin({
    baseUrl: 'https://x.com',
    account: 'u',
    password: 'p',
    fetchImpl: f,
    maxAttempts: 3,
  });
  assert.equal(r.ok, false);
  assert.ok(f.calls() <= 3, `最多 3 次，实际 ${f.calls()}`);
});

await test('探测：地址不合法直接拒', async () => {
  const r = await probeLogin({ baseUrl: 'ftp://x', account: 'u', password: 'p', fetchImpl: fakeFetch(async () => jsonResponse({})) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /http/);
});

await test('登录（非探测）：用站点保存的配置', async () => {
  const token = fakeJwt();
  const site = normalizeSite({
    baseUrl: 'https://x.com',
    account: 'u',
    password: 'p',
    auth: { loginPath: '/api/token', accountField: 'email', passwordField: 'pwd', tokenPath: 'token' },
  });
  const f = fakeFetch(async (url, init) => {
    if (!url.endsWith('/api/token')) return jsonResponse({}, 404);
    const body = JSON.parse(init.body);
    assert.equal(body.email, 'u');
    assert.equal(body.pwd, 'p');
    return jsonResponse({ token });
  });
  const r = await loginSite(site, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.token, token);
});

// ---------------------------------------------------------------- 安全

await test('拒绝内网地址', async () => {
  assert.equal((await assertSafeUrl('http://127.0.0.1:8080')).ok, false);
  assert.equal((await assertSafeUrl('http://192.168.1.1')).ok, false);
  assert.equal((await assertSafeUrl('http://10.0.0.1')).ok, false);
  assert.equal((await assertSafeUrl('http://172.16.0.1')).ok, false);
  assert.equal((await assertSafeUrl('https://example.com')).ok, true);
  assert.equal((await assertSafeUrl('file:///etc/passwd')).ok, false);
});

// ---------------------------------------------------------------- 运行时

await test('运行时：首次请求会登录，之后复用 token', async () => {
  const token = fakeJwt();
  let logins = 0;
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'p' });
  const f = fakeFetch(async (url) => {
    if (url.endsWith('/api/auth/login')) {
      logins++;
      return jsonResponse({ accessToken: token });
    }
    return jsonResponse({ data: [1, 2, 3] });
  });
  const rt = createSiteRuntime({ fetchImpl: f });

  const r1 = await rt.request({ site, path: '/api/items' });
  assert.equal(r1.ok, true);
  const r2 = await rt.request({ site, path: '/api/items' });
  assert.equal(r2.ok, true);
  assert.equal(logins, 1, '第二次应该复用 token，不该再登');
});

await test('运行时：401 时自动重登一次并重试', async () => {
  let logins = 0;
  let apiCalls = 0;
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'p' });
  const f = fakeFetch(async (url, init) => {
    if (url.endsWith('/api/auth/login')) {
      logins++;
      return jsonResponse({ accessToken: fakeJwt(3600, { n: logins }) });
    }
    apiCalls++;
    // 第一次业务请求返回 401（token 失效），之后正常
    if (apiCalls === 1) return jsonResponse({ error: 'expired' }, 401);
    return jsonResponse({ ok: true });
  });
  const rt = createSiteRuntime({ fetchImpl: f });
  const r = await rt.request({ site, path: '/api/items' });
  assert.equal(r.ok, true);
  assert.equal(logins, 2, '应该在 401 后重登一次');
  assert.equal(apiCalls, 2, '业务请求重试一次');
});

await test('运行时：404 不重登（重登没用）', async () => {
  let logins = 0;
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'p' });
  const f = fakeFetch(async (url) => {
    if (url.endsWith('/api/auth/login')) {
      logins++;
      return jsonResponse({ accessToken: fakeJwt() });
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
  const rt = createSiteRuntime({ fetchImpl: f });
  const r = await rt.request({ site, path: '/api/nope' });
  assert.equal(r.ok, false);
  assert.equal(logins, 1, '404 不该触发重登');
});

await test('运行时：登录失败把原因带出来', async () => {
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'bad' });
  const f = fakeFetch(async () => jsonResponse({ error: 'unauthorized' }, 401));
  const rt = createSiteRuntime({ fetchImpl: f });
  const r = await rt.request({ site, path: '/api/items' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /登录失败/);
});

await test('运行时：返回 HTML 时提示可能要重新登录', async () => {
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'p' });
  const f = fakeFetch(async (url) => {
    if (url.endsWith('/api/auth/login')) return jsonResponse({ accessToken: fakeJwt() });
    return { ok: true, status: 200, text: async () => '<!doctype html><html>login</html>', body: null };
  });
  const rt = createSiteRuntime({ fetchImpl: f });
  const r = await rt.request({ site, path: '/api/items' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /网页而不是数据/);
});

await test('运行时：路径必须以 / 开头', async () => {
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'p' });
  const rt = createSiteRuntime({ fetchImpl: fakeFetch(async () => jsonResponse({})) });
  const r = await rt.request({ site, path: 'api/items' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /以 \/ 开头/);
});

await test('运行时：query 参数会拼进 URL，数组用逗号连', async () => {
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'p' });
  let seenUrl = '';
  const f = fakeFetch(async (url) => {
    if (url.endsWith('/api/auth/login')) return jsonResponse({ accessToken: fakeJwt() });
    seenUrl = url;
    return jsonResponse({ ok: true });
  });
  const rt = createSiteRuntime({ fetchImpl: f });
  await rt.request({
    site,
    path: '/api/rankings',
    query: { page: 1, strategy: ['a', 'b'], empty: '', nothing: null },
  });
  assert.match(seenUrl, /page=1/);
  assert.match(seenUrl, /strategy=a%2Cb/, '数组要拼成逗号');
  assert.ok(!seenUrl.includes('empty='), '空值不该出现');
  assert.ok(!seenUrl.includes('nothing='), 'null 不该出现');
});

await test('运行时：改口令后 forget 能强制重登', async () => {
  let logins = 0;
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'p' });
  const f = fakeFetch(async (url) => {
    if (url.endsWith('/api/auth/login')) {
      logins++;
      return jsonResponse({ accessToken: fakeJwt() });
    }
    return jsonResponse({ ok: true });
  });
  const rt = createSiteRuntime({ fetchImpl: f });
  await rt.request({ site, path: '/api/a' });
  assert.equal(logins, 1);
  rt.forget(site.id);
  await rt.request({ site, path: '/api/a' });
  assert.equal(logins, 2, 'forget 之后应该重新登录');
});

await test('运行时：statusOf 反映连接状态', async () => {
  const site = normalizeSite({ baseUrl: 'https://x.com', account: 'u', password: 'p' });
  const f = fakeFetch(async (url) => {
    if (url.endsWith('/api/auth/login')) return jsonResponse({ accessToken: fakeJwt() });
    return jsonResponse({ ok: true });
  });
  const rt = createSiteRuntime({ fetchImpl: f });
  assert.equal(rt.statusOf(site.id).connected, false, '还没登录');
  await rt.request({ site, path: '/api/a' });
  assert.equal(rt.statusOf(site.id).connected, true, '登录后应显示已连接');
});

console.log(`\n站点接入测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
