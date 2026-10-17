/**
 * 检查更新（网络层）测试：注入假 fetch，不真的打网络。
 *
 * 重点验证失败路径——检查更新失败绝不能影响主功能：
 *   · 网络报错 / 超时 / HTTP 非 200 → ok:false，但不抛异常；
 *   · 只有查成功才进缓存（失败后重试要能立刻重查）；
 *   · 缓存命中时不重复请求。
 */
import assert from 'node:assert/strict';
import {
  checkForUpdate,
  clearUpdateCache,
  updateEndpoint,
  fromGithubRelease,
} from '../src/update-checker.js';

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

/** 造一个假的 fetch，记录调用次数 */
function fakeFetch(response, { throws = null } = {}) {
  let calls = 0;
  const impl = async () => {
    calls++;
    if (throws) throw throws;
    return response;
  };
  impl.calls = () => calls;
  return impl;
}

const okRelease = {
  tag_name: 'v9.9.9',
  body: '新版本说明',
  html_url: 'https://example.com/release',
  published_at: '2026-10-17T00:00:00Z',
  assets: [
    { name: 'pi-bot-windows.exe', browser_download_url: 'https://x/win.exe', size: 12345 },
    { name: 'pi-bot.dmg', browser_download_url: 'https://x/mac.dmg', size: 999 },
  ],
};

await test('默认地址指向 GitHub 最新发布', () => {
  const { url } = updateEndpoint({});
  assert.match(url, /api\.github\.com\/repos\/loving-cat\/pi-bot\/releases\/latest/);
});

await test('可用环境变量覆盖地址', () => {
  assert.equal(updateEndpoint({ PI_BOT_UPDATE_URL: 'https://mirror/x' }).url, 'https://mirror/x');
  assert.match(
    updateEndpoint({ PI_BOT_UPDATE_REPO: 'a/b' }).url,
    /repos\/a\/b\/releases\/latest/,
  );
});

await test('GitHub 响应能转成统一结构', () => {
  const r = fromGithubRelease(okRelease);
  assert.equal(r.latest, 'v9.9.9');
  assert.equal(r.assets.length, 2);
  assert.equal(r.assets[0].url, 'https://x/win.exe');
});

await test('查到新版本 → update:true 并推荐对应平台包', async () => {
  clearUpdateCache();
  const info = await checkForUpdate({ platform: 'win32', fetchImpl: fakeFetch({ ok: true, json: async () => okRelease }) });
  assert.equal(info.ok, true);
  assert.equal(info.update, true);
  assert.equal(info.latest, 'v9.9.9');
  assert.match(info.recommended.url, /win\.exe/);
  assert.equal(info.cached, false);
});

await test('缓存命中时不重复请求', async () => {
  clearUpdateCache();
  const f = fakeFetch({ ok: true, json: async () => okRelease });
  await checkForUpdate({ platform: 'win32', fetchImpl: f });
  const second = await checkForUpdate({ platform: 'win32', fetchImpl: f });
  assert.equal(f.calls(), 1, '第二次应该走缓存');
  assert.equal(second.cached, true);
});

await test('force 跳过缓存', async () => {
  clearUpdateCache();
  const f = fakeFetch({ ok: true, json: async () => okRelease });
  await checkForUpdate({ platform: 'win32', fetchImpl: f });
  await checkForUpdate({ platform: 'win32', fetchImpl: f, force: true });
  assert.equal(f.calls(), 2);
});

await test('HTTP 非 200 → ok:false 且说明状态码', async () => {
  clearUpdateCache();
  const info = await checkForUpdate({
    fetchImpl: fakeFetch({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(info.ok, false);
  assert.equal(info.update, false);
  assert.match(info.reason, /404/);
});

await test('网络异常 → ok:false 不抛错', async () => {
  clearUpdateCache();
  const info = await checkForUpdate({
    fetchImpl: fakeFetch(null, { throws: new Error('ECONNREFUSED') }),
  });
  assert.equal(info.ok, false);
  assert.match(info.reason, /ECONNREFUSED/);
});

await test('超时 → 提示超时（abort）', async () => {
  clearUpdateCache();
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const info = await checkForUpdate({ fetchImpl: fakeFetch(null, { throws: abortErr }) });
  assert.equal(info.ok, false);
  assert.match(info.reason, /超时/);
});

await test('失败不进缓存，下次能立刻重试', async () => {
  clearUpdateCache();
  const bad = fakeFetch(null, { throws: new Error('boom') });
  await checkForUpdate({ fetchImpl: bad });
  const good = fakeFetch({ ok: true, json: async () => okRelease });
  const retry = await checkForUpdate({ platform: 'win32', fetchImpl: good });
  assert.equal(retry.ok, true, '失败后重试应该真的再请求一次');
  assert.equal(good.calls(), 1);
});

await test('没有 fetch 时给出明确原因而不是崩', async () => {
  clearUpdateCache();
  // 传 null（而不是 undefined）：undefined 会走默认参数落到 Node 自带的 fetch 上
  const info = await checkForUpdate({ fetchImpl: null });
  assert.equal(info.ok, false);
  assert.match(info.reason, /fetch/);
});

await test('远端比当前旧 → 不提示更新', async () => {
  clearUpdateCache();
  const oldRelease = { ...okRelease, tag_name: 'v0.0.1' };
  const info = await checkForUpdate({
    platform: 'win32',
    fetchImpl: fakeFetch({ ok: true, json: async () => oldRelease }),
  });
  assert.equal(info.ok, true);
  assert.equal(info.update, false);
});

console.log(`\n检查更新测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
