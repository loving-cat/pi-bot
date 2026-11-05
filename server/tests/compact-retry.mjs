/**
 * 主动压缩的判定与失败重试。
 *
 * 覆盖两件事：
 *   1. 什么情况下该压、什么情况下不该压（纯函数，无副作用）
 *   2. 压缩失败后的行为 —— 不再"记一行日志就放行"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PiRunner } from '../src/pi-runner.js';
import { transientBackoffMs, isRecoverableFailure } from '../src/retry-policy.js';

const plan = (over) => PiRunner.planCompaction({ threshold: 80, ...over });

// ---------------------------------------------------------------- 判定

test('未到阈值不压', () => {
  const r = plan({ percent: 79.9 });
  assert.equal(r.compact, false);
  assert.match(r.why, /未到阈值/);
});

test('刚好到阈值就压（80% 是包含边界）', () => {
  const r = plan({ percent: 80 });
  assert.equal(r.compact, true);
});

test('超过阈值压', () => {
  const r = plan({ percent: 93 });
  assert.equal(r.compact, true);
  assert.match(r.why, /93%/);
});

test('拿不到占用就不压 —— 不能拿 undefined 猜', () => {
  const r = plan({ percent: null });
  assert.equal(r.compact, false);
  assert.match(r.why, /拿不到上下文占用/);
});

test('已在压缩中不重复触发', () => {
  const r = plan({ percent: 99, compacting: true });
  assert.equal(r.compact, false);
  assert.match(r.why, /已在压缩中/);
});

test('总开关关掉就一律不压', () => {
  const r = plan({ percent: 99, autoCompact: false });
  assert.equal(r.compact, false);
  assert.match(r.why, /自动压缩已关闭/);
});

test('★ 失败冷却期内不再压 —— 这是"不重试"改成"退避重试"的关键', () => {
  const now = 1_000_000;
  const r = plan({ percent: 99, now, retryAfter: now + 60_000 });
  assert.equal(r.compact, false);
  assert.match(r.why, /冷却中/);
  assert.match(r.why, /还剩 60s/);
});

test('冷却期过了就恢复压缩', () => {
  const now = 1_000_000;
  const r = plan({ percent: 99, now, retryAfter: now - 1 });
  assert.equal(r.compact, true);
});

test('冷却判定用 ceil：剩 0.4s 也报 1s，不报 0s', () => {
  const now = 1_000_000;
  const r = plan({ percent: 99, now, retryAfter: now + 400 });
  assert.match(r.why, /还剩 1s/);
});

// ---------------------------------------------------------------- 摘要指令

test('摘要指令要求保留数字与文件路径（否则压完接不上）', () => {
  const p = PiRunner.COMPACT_PROMPT;
  assert.match(p, /关键数据/);
  assert.match(p, /数字与口径/);
  assert.match(p, /关键文件路径/);
  assert.match(p, /待办/);
  // 明确要求删掉过程细节，否则压完还是满的
  assert.match(p, /删掉寒暄/);
});

// ---------------------------------------------------------------- 失败分类

test('限流/5xx 算可恢复 —— 这类要重试', () => {
  for (const e of ['429 rate limit', 'upstream 503', 'bad gateway', '限流']) {
    assert.equal(isRecoverableFailure({ error: e }), true, e);
  }
});

test('鉴权错不算可恢复 —— 重试一百次也一样', () => {
  assert.equal(isRecoverableFailure({ error: 'invalid api key' }), false);
  assert.equal(isRecoverableFailure({ error: '401 unauthorized' }), false);
  assert.equal(isRecoverableFailure({ error: 'x', status: 401 }), false);
});

test('用户终止不算可恢复', () => {
  assert.equal(isRecoverableFailure({ error: '用户已终止' }), false);
  assert.equal(isRecoverableFailure({ error: 'aborted' }), false);
});

test('退避是递增的且封顶 —— 压缩重试不能把用户拖十几分钟', () => {
  const a1 = transientBackoffMs(1);
  const a2 = transientBackoffMs(2);
  const a9 = transientBackoffMs(9);
  const a99 = transientBackoffMs(99);
  assert.ok(a1 > 0);
  assert.ok(a2 > a1, `${a2} 应大于 ${a1}`);
  // 封顶 12s + 600ms 抖动
  assert.ok(a99 <= 12_600, `封顶失效：${a99}`);
  assert.ok(a99 >= 12_000, `封顶下限不对：${a9}`);
});
