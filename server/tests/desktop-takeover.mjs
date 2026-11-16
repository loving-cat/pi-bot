/**
 * 用户接管检测的测试（规格 P0-3b / §5.2）。
 *   node tests/desktop-takeover.mjs
 *
 * 守的是这一句：「用户显式接管立即吊销租约、丢弃尚未执行输入；
 * 检测到用户真实输入时暂停（检测可靠性与平台机制待核实）」。
 *
 * ## 最难的一处
 *
 * 我们自己发的输入平台也会记成"用户输入"。如果只看"最近有输入"，
 * 我们刚点完鼠标就会把自己判成"用户接管"，然后永远干不下去。
 *
 * 所以核心是**比对时间戳**：平台报的最后输入时间 vs 我们最后注入时间。
 * 这个文件的大部分用例都在钉这件事。
 *
 * ## 第二难的一处
 *
 * 探针不可用时不能猜"没人动" —— 那等于把"检测失败"变成"检测通过"。
 * 所有 null / 垃圾输入都必须走 fail-closed，让上层交还用户。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-takeover-'));
Object.assign(process.env, {
  PI_BOT_HOME: path.join(root, 'data'),
  PI_BOT_WORKSPACE: path.join(root, 'ws'),
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_PROBE: '0',
});
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const T = await import(new URL('../src/desktop-takeover.js', import.meta.url));
const {
  TAKEOVER, ACTION, createWatchState, noteInjection, classify, watch, normalizeProbe, describeWatch,
  DEFAULT_TOLERANCE_MS, DEFAULT_ACTIVE_WINDOW_MS, DEFAULT_AWAY_AFTER_MS,
} = T;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------- 探针不可用
test('★ 探针不可用（null）→ 判 unknown 且交还用户，绝不假设"没人动"', () => {
  const s = createWatchState();
  const r = classify({ state: s, lastInputAt: null, now: T0 });
  assert.equal(r.verdict, TAKEOVER.unknown);
  assert.equal(r.action, ACTION.yieldToUser);
  assert.match(r.reason, /探针|取不到/);
});

test('探针返回垃圾（NaN / 负数 / 字符串）也走 unknown', () => {
  for (const bad of [undefined, NaN, -1, 'abc', {}]) {
    const r = classify({ state: createWatchState(), lastInputAt: bad, now: T0 });
    assert.equal(r.verdict, TAKEOVER.unknown, `${String(bad)} 应当判 unknown`);
    assert.equal(r.action, ACTION.yieldToUser);
  }
});

test('★ 探针不可用不做抖动抑制（那是确定性失败，不是抖动）', () => {
  const s = createWatchState();
  const r = watch({ state: s, lastInputAt: null, now: T0, strikesToYield: 3 });
  assert.equal(r.action, ACTION.yieldToUser, '一次就该让开，不能等三次');
  assert.equal(s.consecutiveUserActive, 0, 'unknown 不该累积"用户在动"的计数');
});

// ---------------------------------------------------------------- 自己 vs 用户
test('★ 刚注入了输入、平台报的时间和自己一致 → 是我们自己，继续', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({ state: s, lastInputAt: T0 + 200, now: T0 + 300 });
  assert.equal(r.verdict, TAKEOVER.selfRecent);
  assert.equal(r.action, ACTION.proceed);
});

test('★ 平台报的输入明显晚于我们最后一次注入 → 用户动过，让开', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({ state: s, lastInputAt: T0 + 5_000, now: T0 + 5_100 });
  assert.equal(r.verdict, TAKEOVER.userActive);
  assert.equal(r.action, ACTION.yieldToUser);
  assert.match(r.reason, /用户/);
});

test('容差内的差值算同一次动作（注入到系统记账有延迟）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  // 正好落在容差边界上 —— 不该判成用户
  const r = classify({ state: s, lastInputAt: T0 + DEFAULT_TOLERANCE_MS, now: T0 + DEFAULT_TOLERANCE_MS + 10 });
  assert.equal(r.verdict, TAKEOVER.selfRecent);
});

test('刚好超出容差就判用户（边界要严，不能靠"应该不会"）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({ state: s, lastInputAt: T0 + DEFAULT_TOLERANCE_MS + 1, now: T0 + DEFAULT_TOLERANCE_MS + 100 });
  assert.equal(r.verdict, TAKEOVER.userActive);
});

test('安静够久 → quiet，可以继续（默认不要求"用户离开"）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({ state: s, lastInputAt: T0, now: T0 + DEFAULT_ACTIVE_WINDOW_MS + 1 });
  const q = classify({ state: s, lastInputAt: T0 - 60_000, now: T0 });
  assert.equal(q.verdict, TAKEOVER.quiet);
  assert.equal(q.action, ACTION.proceed);
  assert.ok(r);
  // ★ 默认值是 0：全双工产品不能默认"等用户离开"
  assert.equal(DEFAULT_AWAY_AFTER_MS, 0);
});

// ---------------------------------------------------------------- 用户无感（§5.2）
//
// 需求原话："用户无感，bot 们在后面操作"。所以同桌面输入只在**用户真的离开**
// 之后才动手；他还在看东西（只是没碰鼠标）时必须等。

test('★ 开了"只在用户离开时动"的门槛：他停手但没走 → still_here + wait', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({ state: s, lastInputAt: T0 - 5_000, now: T0, awayAfterMs: 90_000 });
  assert.equal(r.verdict, TAKEOVER.stillHere);
  assert.equal(r.action, ACTION.wait);
  assert.match(r.reason, /离开门槛/);
});

test('★ 同一个场景、门槛关掉（默认）→ 直接干（全双工不等人）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({ state: s, lastInputAt: T0 - 5_000, now: T0 });
  assert.equal(r.verdict, TAKEOVER.quiet);
  assert.equal(r.action, ACTION.proceed);
});

test('★ 开了门槛之后："还在看"不会累计成接管（连试三次也不吊销租约）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  for (let i = 0; i < 3; i += 1) {
    const r = watch({ state: s, lastInputAt: T0 - 5_000, now: T0, awayAfterMs: 90_000 });
    assert.equal(r.action, ACTION.wait, '应当是"等一下"，不是"让开"');
  }
  assert.equal(s.consecutiveUserActive, 0, '不能在"用户在看书"上计数');
});

test('离开门槛配成很大的值 → 一直等（"我不在时才动"的极端配置）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({ state: s, lastInputAt: T0 - 60_000, now: T0, awayAfterMs: 3600_000 });
  assert.equal(r.verdict, TAKEOVER.stillHere);
  assert.equal(r.action, ACTION.wait);
});

test('★ 合成输入源不需要"等离开"（远程控制软件常驻时永远等不到）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({
    state: s, lastInputAt: T0 - 5_000, now: T0,
    cursorStill: true, syntheticSource: true,
  });
  assert.equal(r.verdict, TAKEOVER.phantom);
  assert.equal(r.action, ACTION.proceed);
});

test('★ 从没注入过也能判（lastInputAt 很旧 → quiet）', () => {
  const s = createWatchState();
  const r = classify({ state: s, lastInputAt: T0 - 120_000, now: T0 });
  assert.equal(r.verdict, TAKEOVER.quiet);
  assert.equal(r.action, ACTION.proceed);
});

test('★ 时间戳对不上（平台报的比我们注入还早，但又不旧）→ 不冒险，先等', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const r = classify({ state: s, lastInputAt: T0 - 500, now: T0 + 100 });
  assert.equal(r.verdict, TAKEOVER.unknown);
  assert.equal(r.action, ACTION.wait);
  assert.match(r.reason, /对不上|漂移/);
});

// ---------------------------------------------------------------- 抖动抑制
test('★ 单次命中不立刻让开（系统抖动会让长动作永远跑不完）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  const first = watch({ state: s, lastInputAt: T0 + 5_000, now: T0 + 5_100, strikesToYield: 2 });
  assert.equal(first.action, ACTION.wait);
  assert.equal(first.strikes, 1);
  const second = watch({ state: s, lastInputAt: T0 + 5_200, now: T0 + 5_300, strikesToYield: 2 });
  assert.equal(second.action, ACTION.yieldToUser);
  assert.equal(second.strikes, 2);
  assert.equal(s.lastTakeoverAt, T0 + 5_300, '真接管要记时间，审计用');
});

test('中间夹一次正常判定就把计数清零（抖动不累积成接管）', () => {
  const s = createWatchState();
  noteInjection(s, { now: T0 });
  watch({ state: s, lastInputAt: T0 + 5_000, now: T0 + 5_100, strikesToYield: 2 });
  assert.equal(s.consecutiveUserActive, 1);
  // 我们再次注入了 → 平台记成"刚刚有一次输入"，且时间落在容差内 = 是我们
  noteInjection(s, { now: T0 + 5_200 });
  watch({ state: s, lastInputAt: T0 + 5_250, now: T0 + 5_300, strikesToYield: 2 });
  assert.equal(s.consecutiveUserActive, 0, '正常一次就该清零');
  const again = watch({ state: s, lastInputAt: T0 + 9_000, now: T0 + 9_100, strikesToYield: 2 });
  assert.equal(again.action, ACTION.wait, '又变成第 1 次，不该直接让开');
});

// ---------------------------------------------------------------- 平台值换算
test('★ Windows tick 必须给 bootTime，否则返回 null（不能瞎猜）', () => {
  // 这是一个真踩过的坑：Number(null) === 0 是有限值，
  // 于是"没给 bootTime"会被当成 bootTime = 0，tick 值直接被当成 epoch。
  assert.equal(normalizeProbe({ value: 12_345, unit: 'tick', now: T0 }), null);
  assert.equal(normalizeProbe({ value: 12_345, unit: 'tick', now: T0, bootTime: null }), null);
  const ok = normalizeProbe({ value: 12_345, unit: 'tick', now: T0, bootTime: T0 - 100_000 });
  assert.equal(ok, T0 - 100_000 + 12_345);
});

test('macOS「多少秒前」反推成 epoch', () => {
  const at = normalizeProbe({ value: 3, unit: 'agoSeconds', now: T0 });
  assert.equal(at, T0 - 3_000);
});

test('明显晚于现在的时间戳视为坏值（时钟漂移 / tick 溢出）', () => {
  const at = normalizeProbe({ value: 9e9, unit: 'tick', now: T0, bootTime: T0 });
  assert.equal(at, null);
});

test('垃圾输入统一返回 null', () => {
  for (const bad of [null, undefined, -1, NaN, 'x']) {
    assert.equal(normalizeProbe({ value: bad, unit: 'agoSeconds', now: T0 }), null, String(bad));
  }
  assert.equal(normalizeProbe({ value: 1, unit: 'unknown-unit', now: T0 }), null);
});

// ---------------------------------------------------------------- 记账
test('noteInjection 会清掉抖动计数（新的注入说明我们在动）', () => {
  const s = createWatchState();
  s.consecutiveUserActive = 3;
  noteInjection(s, { now: T0 });
  assert.equal(s.consecutiveUserActive, 0);
  assert.equal(s.lastInjectionAt, T0);
});

// ---------------------------------------------------------------- 描述
test('describeWatch 说清当前状态（界面/审计用）', () => {
  const s = createWatchState();
  assert.match(describeWatch(s, { now: T0 }), /待命/);
  noteInjection(s, { now: T0 });
  classify({ state: s, lastInputAt: T0, now: T0 + 100 });
  assert.match(describeWatch(s, { now: T0 + 1000 }), /正常/);
  s.lastVerdict = TAKEOVER.unknown;
  assert.match(describeWatch(s, { now: T0 }), /探针不可用/);
  s.lastVerdict = null;
  s.lastTakeoverAt = T0 - 5_000;
  assert.match(describeWatch(s, { now: T0 }), /用户接管/);
  assert.equal(describeWatch(null), '接管检测未启用');
});

test('默认阈值合理：容差远小于"算安静"的窗口', () => {
  assert.ok(DEFAULT_TOLERANCE_MS > 0 && DEFAULT_TOLERANCE_MS <= 5_000, `容差=${DEFAULT_TOLERANCE_MS}`);
  assert.ok(DEFAULT_ACTIVE_WINDOW_MS >= DEFAULT_TOLERANCE_MS, '安静窗口不该比容差还短');
});

test('★ 探针抖动不该把"连续三次"的计数偷走', () => {
  // 场景：userActive → unknown → userActive。
  // 中间那次 unknown（探针报了个对不上的时间戳）如果清零，
  // "连续两次才让开"就永远攒不满 —— 而 unknown 本身是**保守让开**，
  // 也就是说用户在两轮之间偷到了"再来一次"的机会。
  const s = { ...createWatchState() };
  noteInjection(s, { now: T0 });
  const first = watch({ state: s, lastInputAt: T0 + 4_000, now: T0 + 4_100 });
  assert.equal(first.verdict, TAKEOVER.userActive);
  assert.equal(first.action, ACTION.wait);
  assert.equal(first.strikes, 1);
  // 探针抖一下：报的时间比我们的注入早一点、又不够旧（对不上）。
  // 这一支才是 `unknown`；报得太早会被判成"很久没人动"的 quiet。
  const mid = watch({ state: s, lastInputAt: T0 - 500, now: T0 + 1_000 });
  assert.equal(mid.verdict, TAKEOVER.unknown);
  // 时间戳对不上这一支给的是 `wait`（先停一次）；拿不到值才是 `yieldToUser`。
  // 两支都不许清零计数。
  assert.equal(mid.action, ACTION.wait, '时间戳可疑：先停下，不直接吊销');
  assert.equal(mid.strikes, 1, 'unknown 不该清零，也不该累加');
  // 再命中一次：这仍然是"连续第二次"，应当让开
  // 用 4s 而不是 1.4s：1.4s 落在 1.5s 容差内，会被正确地判成"我们自己那次动作"
  const third = watch({ state: s, lastInputAt: T0 + 4_000, now: T0 + 4_100 });
  assert.equal(third.verdict, TAKEOVER.userActive);
  assert.equal(third.strikes, 2);
  assert.equal(third.action, ACTION.yieldToUser);
});

test('真正安静下来才清零（quiet 之后重新从 1 数）', () => {
  const s = { ...createWatchState() };
  noteInjection(s, { now: T0 });
  assert.equal(watch({ state: s, lastInputAt: T0 + 4_000, now: T0 + 4_100 }).strikes, 1);
  // 一分钟后没人动（最后一次输入早于我们那次注入）：安静，清零
  const quiet = watch({ state: s, lastInputAt: T0 - 60_000, now: T0 + 70_000 });
  assert.equal(quiet.verdict, TAKEOVER.quiet);
  assert.equal(quiet.strikes, 0);
  assert.equal(s.consecutiveUserActive, 0);
});

// ---------------------------------------------------------------- 合成输入源（§5.2）
//
// 实测：远程控制软件会不停刷新"最后输入时间"，但从不移动光标。
// 只看时间 → "用户一直在动" → bot 永远动不了鼠标。
// 所以要多一个"光标动过没有"，**而且要有采样证明这台桌面真有合成输入源**。

test('★ 有输入信号 + 光标没动 + 已判定有合成输入源 → phantom，可以继续', () => {
  const state = createWatchState();
  const r = watch({
    state,
    lastInputAt: T0 - 5, // 永远"刚刚"
    now: T0,
    cursorStill: true,
    syntheticSource: true,
  });
  assert.equal(r.verdict, TAKEOVER.phantom);
  assert.equal(r.action, ACTION.proceed);
});

test('★ 知道是合成输入源，但光标在动 → 那是真人，必须让开', () => {
  const state = createWatchState();
  const a = watch({ state, lastInputAt: T0 - 5, now: T0, cursorStill: false, syntheticSource: true });
  const b = watch({ state, lastInputAt: T0 - 5, now: T0, cursorStill: false, syntheticSource: true });
  assert.equal(b.verdict, TAKEOVER.userActive);
  assert.equal(b.action, ACTION.yieldToUser);
  assert.notEqual(a.verdict, TAKEOVER.phantom);
});

test('★ 没判定"有合成输入源"时，光凭"光标没动"不许放行', () => {
  const state = createWatchState();
  const r = watch({ state, lastInputAt: T0 - 5, now: T0, cursorStill: true, syntheticSource: false });
  assert.notEqual(r.verdict, TAKEOVER.phantom, '样本没证明之前只能保守');
});

test('★ 不知道光标动没动（没采样）→ 不许猜成合成输入', () => {
  const state = createWatchState();
  const r = watch({ state, lastInputAt: T0 - 5, now: T0, cursorStill: null, syntheticSource: true });
  assert.notEqual(r.verdict, TAKEOVER.phantom);
});

test('phantom 不计入抖动抑制的 strike（它是"可以继续"，不是"用户在动"）', () => {
  const state = createWatchState();
  watch({ state, lastInputAt: T0 - 5, now: T0, cursorStill: true, syntheticSource: true });
  assert.equal(state.consecutiveUserActive, 0);
  assert.equal(state.lastVerdict, TAKEOVER.phantom);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
