/**
 * 探活缓存测试：过期判定与自动重探。
 *   node tests/model-health.mjs
 *
 * 覆盖：
 *   ① 过期后 get() 返回 null，wasGood() 保留历史结论；
 *   ② 过期触发一次合并后的后台重探；
 *   ③ startAutoRefresh 会补齐过期结果，stop() 后停止；
 *   ④ 无记录时 hasFresh() 为 false。
 *
 * TTL 通过构造参数注入，测试无需等待默认的 24 小时。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_health');
const HOME = process.env.PI_BOT_HOME;
fs.rmSync(HOME, { recursive: true, force: true });

const { ModelHealth } = await import('../src/model-health.js');

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

/** 探活要 runner，这里只用到 availableModels（重探时枚举）和 resolveModel */
function fakeRunner(models = []) {
  return {
    availableModels: models.map((slug) => {
      const [provider, ...rest] = slug.split('/');
      return { provider, id: rest.join('/') };
    }),
    resolveModel: () => null,
    modelRuntime: { completeSimple: async () => ({ content: [] }) },
  };
}

function fresh(health, slug, ok = true) {
  health.results[slug] = { ok, ms: 10, error: ok ? null : '空回复', at: Date.now() };
}

await test('新鲜结果：get() 拿得到', () => {
  const h = new ModelHealth(fakeRunner(), { ttlMs: 10_000 });
  fresh(h, 'a/ok');
  assert.equal(h.get('a/ok').ok, true);
  assert.equal(h.hasFresh(), true);
  assert.equal(h.hasFreshFor(['a/ok']), true);
  assert.equal(h.anyExpired(), false);
});

await test('★ 过期结果：get() 拿不到，但不算"挂了"', async () => {
  const h = new ModelHealth(fakeRunner(), { ttlMs: 30 });
  fresh(h, 'a/slow');
  await sleep(60);
  assert.equal(h.get('a/slow'), null, '过期就不该再当结论用');
  assert.equal(h.wasGood('a/slow'), true, '但要记得它以前是好的');
  assert.equal(h.hasFreshFor(['a/slow']), false);
  assert.equal(h.anyExpired(), true);
  h.stop();
});

await test('★ 过期会自己排队重探（攒一批，不是一人一个请求）', async () => {
  const h = new ModelHealth(fakeRunner(), { ttlMs: 20 });
  let calls = 0;
  h.runAll = async () => {
    calls++;
    return { skipped: true };
  };
  fresh(h, 'a/x');
  fresh(h, 'a/y');
  fresh(h, 'a/z');
  await sleep(40);
  // 菜单渲染会连着问很多次 —— 三次 get() 只该换来一次重探
  h.get('a/x');
  h.get('a/y');
  h.get('a/z');
  await sleep(1000);
  assert.equal(calls, 1, `应该只重探一次，实际 ${calls} 次`);
  h.stop();
});

await test('★ 定时巡检：没人问也会把过期的补上', async () => {
  const h = new ModelHealth(fakeRunner(), { ttlMs: 20 });
  let calls = 0;
  h.runAll = async () => {
    calls++;
    return { skipped: true };
  };
  fresh(h, 'a/tick');
  await sleep(40);
  h.startAutoRefresh(50);
  await sleep(260);
  h.stop();
  assert.ok(calls >= 1, '定时器应该至少补探一次');
  const after = calls;
  await sleep(160);
  assert.equal(calls, after, 'stop() 之后不许再探');
});

await test('没有任何记录时 hasFresh() 是 false（全新安装）', () => {
  const h = new ModelHealth(fakeRunner(), { ttlMs: 10_000 });
  assert.equal(h.hasFresh(), false);
  assert.equal(h.hasFreshFor(['a/none']), false);
  h.stop();
});

await test('停过的健康检查不会留下定时器（进程能退出）', () => {
  const h = new ModelHealth(fakeRunner(), { ttlMs: 10_000 });
  h.startAutoRefresh(10);
  h.stop();
  assert.equal(h.autoTimer, null);
  assert.equal(h.refreshTimer, null);
});

await test('★ PI_BOT_PROBE=0（autoProbe:false）：结果过期也不自己发请求', async () => {
  const h = new ModelHealth(fakeRunner(), { ttlMs: 20, autoProbe: false });
  let calls = 0;
  h.runAll = async () => {
    calls++;
    return { skipped: true };
  };
  fresh(h, 'a/off');
  await sleep(40);
  assert.equal(h.get('a/off'), null, '过期仍然报「暂无结论」');
  await sleep(1000);
  assert.equal(calls, 0, `关了自动探活就不该重探，实际 ${calls} 次`);
  assert.equal(h.refreshTimer, null);
  h.stop();
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 探活缓存测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
