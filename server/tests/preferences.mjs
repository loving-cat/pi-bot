/**
 * 用户习惯（preferences）—— 规格 `docs/spec-intent-and-habits-v1.md` §3。
 *   node tests/preferences.mjs
 *
 * ## 守什么
 *
 * 偏好是**直接生效**的（不像经验要用户手工启用），所以它的错误方向都很贵：
 *
 *   · 记太松（把"这次用 Firefox"当习惯）→ 下次它自作主张；
 *   · 覆盖错（不同 topic 被当成同一件事）→ 旧偏好被悄悄删掉；
 *   · 注入太多 → 提示词变肥，而且真重要的那几条被淹掉；
 *   · weak 也进提示词 → 只观察到三次的猜测被当成"用户明说过"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  STRENGTH, ORIGIN, STATUS, PROMPT_MAX,
  normalizePreference, mergePreference, pickPromptPreferences,
  preferencesPromptLines, preferencesFromReflect,
} = await import(src('preferences.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const NOW = 1_700_000_000_000;
const pref = (over = {}) => normalizePreference({
  topic: 'browser-choice',
  text: '看视频时用 ego 打开并放在前台，不要全屏',
  strength: 'strong',
  origin: 'correction',
  ...over,
}, NOW).preference;

// ---------------------------------------------------------------- 规范化
test('没有 topic 或内容就拒（topic 决定"新的覆盖谁"）', () => {
  assert.equal(normalizePreference({ text: 'x' }, NOW).code, 'no_topic');
  assert.equal(normalizePreference({ topic: 't' }, NOW).code, 'no_text');
});

test('topic 归一化；文本压成一行并截断', () => {
  const p = normalizePreference({ topic: 'Browser Choice!', text: 'a\n\n b   c', strength: 'strong' }, NOW).preference;
  assert.equal(p.topic, 'browser-choice');
  assert.equal(p.text, 'a b c');
});

test('强度只认 strong，其余一律 weak（宁可少进提示词）', () => {
  assert.equal(normalizePreference({ topic: 't', text: 'x', strength: 'strong' }).preference.strength, STRENGTH.strong);
  assert.equal(normalizePreference({ topic: 't', text: 'x', strength: 'STRONG!' }).preference.strength, STRENGTH.weak);
  assert.equal(normalizePreference({ topic: 't', text: 'x' }).preference.strength, STRENGTH.weak);
});

test('来源只认三种判据；来源空/错就按"明确表达"算', () => {
  assert.equal(normalizePreference({ topic: 't', text: 'x', origin: 'correction' }).preference.origin, ORIGIN.correction);
  assert.equal(normalizePreference({ topic: 't', text: 'x', origin: 'whatever' }).preference.origin, ORIGIN.explicit);
});

// ---------------------------------------------------------------- 合并
test('★ 同 topic 的新偏好覆盖旧的（旧的标 superseded，不删）', () => {
  const old = pref({ text: '看视频用 Chrome' });
  const r = mergePreference([old], pref({ text: '看视频用 ego' }), NOW + 1000);
  assert.equal(r.list.length, 2, '旧的留着（审计），只是状态变了');
  const oldNow = r.list.find((p) => p.id === old.id);
  assert.equal(oldNow.status, STATUS.superseded);
  assert.equal(r.list.find((p) => p.status === STATUS.active).text, '看视频用 ego');
  assert.deepEqual(r.superseded, [old.id]);
});

test('★ 不同 topic 各留各的（不能互相覆盖）', () => {
  const a = pref({ topic: 'browser-choice', text: 'A' });
  const b = pref({ topic: 'report-format', text: 'B' });
  const r = mergePreference([a], b, NOW + 1000);
  assert.equal(r.superseded.length, 0);
  assert.equal(r.list.filter((p) => p.status === STATUS.active).length, 2);
});

test('★ 完全相同的偏好只加次数；重复三次把 weak 升成 strong', () => {
  const base = pref({ text: '打开网页给我看', strength: 'weak' });
  const r1 = mergePreference([base], pref({ text: '打开网页给我看', strength: 'weak' }), NOW + 1000);
  assert.equal(r1.list.length, 1, '不该新增一条');
  assert.equal(r1.added.seenCount, 2);
  assert.equal(r1.promoted, false);
  const r2 = mergePreference(r1.list, pref({ text: '打开网页给我看', strength: 'weak' }), NOW + 2000);
  assert.equal(r2.added.seenCount, 3);
  assert.equal(r2.promoted, true);
  assert.equal(r2.added.strength, STRENGTH.strong);
});

test('坏的候选不炸、也不进列表', () => {
  const r = mergePreference([], { topic: '', text: '' });
  assert.equal(r.list.length, 0);
  assert.equal(r.added, null);
});

// ---------------------------------------------------------------- 注入
test('★ 只有 strong + active 进提示词；weak 一条都不进', () => {
  const list = [
    pref({ topic: 'a', text: '明确的', strength: 'strong' }),
    pref({ topic: 'b', text: '猜的', strength: 'weak' }),
  ];
  const picked = pickPromptPreferences(list);
  assert.deepEqual(picked.map((p) => p.text), ['明确的']);
});

test('★ 最多 5 条，按最近出现的优先（防止提示词变肥）', () => {
  const list = Array.from({ length: 9 }, (_, i) => ({
    ...pref({ topic: `t${i}`, text: `第${i}条`, strength: 'strong' }),
    lastSeenAt: NOW + i,
  }));
  const picked = pickPromptPreferences(list);
  assert.equal(picked.length, PROMPT_MAX);
  assert.equal(picked[0].text, '第8条', '最近的排最前');
});

test('没有偏好时一个字都不加（不占 token）', () => {
  assert.deepEqual(preferencesPromptLines([]), []);
  assert.deepEqual(preferencesPromptLines([pref({ strength: 'weak' })]), []);
});

test('有偏好时给一段能被模型照做的话', () => {
  const lines = preferencesPromptLines([pref()]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /【用户的习惯】/);
  assert.match(lines[1], /不要全屏/);
});

test('superseded / retired 的不进提示词', () => {
  const a = { ...pref({ topic: 'a' }), status: STATUS.superseded };
  const b = { ...pref({ topic: 'b' }), status: STATUS.retired };
  assert.equal(pickPromptPreferences([a, b]).length, 0);
});

// ---------------------------------------------------------------- 从复盘里取
test('★ 复盘输出里的 preferences 能取出来；没证据的推断丢掉', () => {
  const parsed = {
    preferences: [
      { topic: 'browser-choice', text: '看视频用 ego 放前台', strength: 'strong', origin: 'correction', evidence: '别用我的浏览器' },
      { topic: 'report-format', text: '结论放最前面', strength: 'strong', origin: 'explicit', evidence: '' },
    ],
  };
  const out = preferencesFromReflect(parsed, NOW);
  assert.equal(out.length, 1, 'evidence 为空的丢掉');
  assert.equal(out[0].topic, 'browser-choice');
});

test('复盘输出没有 preferences 字段 → 空数组，不报错', () => {
  assert.deepEqual(preferencesFromReflect({ lessons: [] }, NOW), []);
  assert.deepEqual(preferencesFromReflect(null, NOW), []);
});

// ---------------------------------------------------------------- store 接线
test('★ store.addPreference 生效并能被提示词读到', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-prefs-'));
  Object.assign(process.env, {
    PI_BOT_HOME: root, PI_BOT_WORKSPACE: path.join(root, 'ws'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_BOT_PROBE: '0',
  });
  for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const { store } = await import(src('store.js'));
  assert.deepEqual(store.preferences(), []);

  const r = store.addPreference(pref());
  assert.ok(r.added, '应当新增一条');
  assert.equal(store.preferences().length, 1);

  // 同 topic 再来一条 → 旧的 superseded
  const r2 = store.addPreference(pref({ text: '看视频用岛，不要动我的浏览器' }));
  assert.equal(r2.superseded.length, 1, '旧的要被覆盖');
  const active = store.preferences().filter((p) => p.status === 'active');
  assert.equal(active.length, 1);
  assert.match(active[0].text, /不要动我的浏览器/);

  // 提示词读得到
  const lines = preferencesPromptLines(store.preferences());
  assert.equal(lines.length, 2);

  // 软删
  store.retirePreference(active[0].id);
  assert.equal(preferencesPromptLines(store.preferences()).length, 0, '删掉之后不该再进提示词');
  assert.equal(store.preferences().length, 2, '记录还在（审计）');

  clearTimeout(store.saveTimer);
  fs.rmSync(root, { recursive: true, force: true });
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
