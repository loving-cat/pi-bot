/**
 * 上下文压缩：校准路径必须和 applyCompactionBudget 一样扣固定开销。
 *
 * 背景：applyCompactionBudget 调用 capRecentTokens 时传了
 * fixedOverheadTokens: fixedOverheadOf(session)（system prompt + 工具定义）。
 * 但 #calibrateKeepRecent 里那次"只取窗口上限"的调用没传 ——
 * 于是它以为窗口里全是可用余量，算出的保留量贴到触发线，
 * 小窗口压完立刻又触线，反复压缩。
 *
 * 这里测纯函数层面：有开销时保留量必须更小；以及校准路径确实把开销传进去了。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const { capRecentTokens, fixedOverheadOf } = await import('../src/context-budget.js');

const BASE = {
  contextWindow: 200_000,
  keepRecentTokens: Number.MAX_SAFE_INTEGER,
  reserveTokens: 16_384,
  threshold: 0.6,
};

test('相同的窗口/keep，有固定开销时保留量更小', () => {
  const noOverhead = capRecentTokens({ ...BASE, fixedOverheadTokens: 0 });
  const withOverhead = capRecentTokens({ ...BASE, fixedOverheadTokens: 20_000 });
  assert.ok(
    withOverhead < noOverhead,
    `有开销时应更小：${withOverhead} 应 < ${noOverhead}`,
  );
});

test('开销越大，保留量越小（单调）', () => {
  const a = capRecentTokens({ ...BASE, fixedOverheadTokens: 10_000 });
  const b = capRecentTokens({ ...BASE, fixedOverheadTokens: 30_000 });
  const c = capRecentTokens({ ...BASE, fixedOverheadTokens: 60_000 });
  assert.ok(a > b && b > c, `应单调递减：${a} > ${b} > ${c}`);
});

test('开销吃光余量时仍至少留 1 token，不返回负数', () => {
  const r = capRecentTokens({ ...BASE, fixedOverheadTokens: 10_000_000 });
  assert.equal(r, 1, '余量被吃光时应夹到 1');
});

test('小窗口场景：不扣开销会贴到触发线，扣了才留出余量', () => {
  // 128k 窗口，触发线 0.6 = 76800，摘要预算 = min(16384, 38400) = 16384
  const cw = 128_000;
  const noOverhead = capRecentTokens({
    contextWindow: cw, keepRecentTokens: Number.MAX_SAFE_INTEGER,
    reserveTokens: 16_384, threshold: 0.6, fixedOverheadTokens: 0,
  });
  const overhead = 25_000;
  const withOverhead = capRecentTokens({
    contextWindow: cw, keepRecentTokens: Number.MAX_SAFE_INTEGER,
    reserveTokens: 16_384, threshold: 0.6, fixedOverheadTokens: overhead,
  });
  // 触发线 - 摘要预算 = 76800 - 16384 = 60416
  assert.equal(noOverhead, 60_416, '不扣开销应正好是「触发线 - 摘要预算」');
  assert.equal(withOverhead, 60_416 - overhead, '扣开销后应再减掉开销');
});

test('fixedOverheadOf：拿不到 session 返回 0，不猜', () => {
  assert.equal(fixedOverheadOf(null), 0);
  assert.equal(fixedOverheadOf(undefined), 0);
  assert.equal(fixedOverheadOf({}), 0);
});

test('fixedOverheadOf：有 system prompt 时返回正数', () => {
  const session = {
    systemPrompt: '你是一个乐于助人的助手。'.repeat(50),
  };
  const r = fixedOverheadOf(session);
  assert.ok(r > 0, `应估出正数，实际 ${r}`);
  assert.ok(Number.isFinite(r), '应是有限数');
});

test('★ 校准路径确实把 fixedOverheadTokens 传给了 capRecentTokens', () => {
  // 源码级断言：不起真模型，直接确认那条调用带了开销参数
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'pi-runner.js'),
    'utf8',
  );
  const i = src.indexOf('#calibrateKeepRecent');
  assert.ok(i > 0, '找不到 #calibrateKeepRecent');
  // 取该方法之后的一段，确认里面那次 capRecentTokens 调用含 fixedOverheadTokens
  const chunk = src.slice(i, i + 6000);
  const callIdx = chunk.indexOf('capRecentTokens({');
  assert.ok(callIdx > 0, '校准方法里找不到 capRecentTokens 调用');
  const callChunk = chunk.slice(callIdx, callIdx + 800);
  assert.ok(
    callChunk.includes('fixedOverheadTokens'),
    '校准路径的 capRecentTokens 调用没传 fixedOverheadTokens',
  );
  assert.ok(
    callChunk.includes('fixedOverheadOf(session)'),
    '应使用 fixedOverheadOf(session) 保持口径一致',
  );
});

test('两条路径用的是同一个 fixedOverheadOf 函数', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'context-budget.js'),
    'utf8',
  );
  assert.ok(
    /export function fixedOverheadOf/.test(src),
    'fixedOverheadOf 必须导出，否则 calibrate 用不到同一口径',
  );
});

test('校准路径不覆盖用户显式设置的 keepRecentTokens', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'pi-runner.js'),
    'utf8',
  );
  const i = src.indexOf('#calibrateKeepRecent');
  const chunk = src.slice(i, i + 1200);
  assert.ok(
    chunk.includes('bot?.keepRecentTokens != null') && chunk.includes('return'),
    '用户显式设置时应直接 return，不覆盖',
  );
});

console.log(`\n上下文压缩固定开销：${passed}/${passed} 通过`);
