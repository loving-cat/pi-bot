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

test('★ 不再往摘要 prompt 里加自己的话', () => {
  // pi 自带的摘要 prompt 已经明确要求保留精确路径/函数名/错误信息，
  // 还额外保留 <read-files> / <modified-files>。
  //
  // 我们原来加了一句「尽量短」，实测（同一段 19 万字符对话）：
  //   · 长度只少 107 字符（3145 → 3038），等于没省；
  //   · 但关键数字丢了一个（BE 32,960）。
  // 收益约等于零、风险是实的 —— 所以默认不传。
  assert.equal(PiRunner.COMPACT_PROMPT, null);
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

// ---------------------------------------------------------------- 压缩期间不算"忙"

/**
 * ⑥ 群聊压缩期间 entry.busy=true，用户一说话就 #interruptRoundForUser 把全群 abort。
 *
 * 修法：压缩期间打 compactingOnly 标记，isRoomBusy 与 #interruptRoundForUser
 * 都跳过这种条目。这里用最小桩验证判定语义 —— 不启动真的 PiRunner
 * （构造函数会去读配置和模型清单）。
 */
function makeRoomBusy(entries, roomId = 'r1') {
  // 直接复用原型方法，把 this.sessions 换成受控的 Map
  return PiRunner.prototype.isRoomBusy.call({ sessions: entries }, roomId);
}

test('只有压缩中的会话 → 房间不算忙（用户插话不打断全群）', () => {
  const entries = new Map([
    ['r1:b1', { busy: true, compactingOnly: true }],
    ['r1:b2', { busy: true, compactingOnly: true }],
  ]);
  assert.equal(makeRoomBusy(entries), false);
});

test('压缩中有、但也有真在跑的 → 房间忙（原有语义不变）', () => {
  const entries = new Map([
    ['r1:b1', { busy: true, compactingOnly: true }],
    ['r1:b2', { busy: true, compactingOnly: false }],
  ]);
  assert.equal(makeRoomBusy(entries), true);
});

test('空闲的会话不影响判定', () => {
  const entries = new Map([
    ['r1:b1', { busy: false, compactingOnly: false }],
    ['r1:b2', { busy: false }],
  ]);
  assert.equal(makeRoomBusy(entries), false);
});

test('别的房间的忙不算这个房间的', () => {
  const entries = new Map([
    ['r1:b1', { busy: false }],
    ['r2:b9', { busy: true, compactingOnly: false }],
  ]);
  assert.equal(makeRoomBusy(entries), false);
});

test('没有会话时是空闲', () => {
  assert.equal(makeRoomBusy(new Map()), false);
});

test('★ 回归：压缩结束（compactingOnly=false）后必须恢复"忙"', () => {
  const entries = new Map([['r1:b1', { busy: true, compactingOnly: false }]]);
  assert.equal(makeRoomBusy(entries), true,
    '压缩后忘了清标记会让用户在整轮过程中都插不了话');
});
