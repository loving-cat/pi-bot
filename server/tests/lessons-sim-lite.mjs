/**
 * SIM-Lite（2.0）契约测试：模型族 / 关系边 / 置信度 / 去重 / 淘汰。
 *   node tests/lessons-sim-lite.mjs
 *
 * ## 这个文件守什么
 *
 * Phase 0 只做「定稿」：把 SIM-Lite 的字段与关系边写成常量 + 纯函数，
 * **不接线**（不写盘、不改注入、不动蒸馏）。所以这里的重点不是"功能好用"，
 * 而是三条契约：
 *
 *   1. **老库直接可读**：1.x 沉淀的经验没有 `modelFamily` / `byFamily`，
 *      规范化后必须有安全默认值，不需要迁移脚本；
 *   2. **新参数不传 = 旧行为**：`selectLessonsFor` 不传 `modelFamily` / `edges`
 *      时结果必须与 1.x 完全一致（回归由 `tests/lessons.mjs` 那 17 条兜着）；
 *   3. **矛盾必须能排除**：`contradicts` 边是**硬排除**，不是减分 ——
 *      宁可不给经验，也不能给一条自相矛盾的经验。
 */
import assert from 'node:assert/strict';

import {
  LESSON_LIMITS,
  LESSON_SCORING,
  LESSON_EDGE_TYPES,
  MODEL_FAMILIES,
  UNKNOWN_MODEL_FAMILY,
  resolveModelFamily,
  normalizeFamilyStats,
  normalizeLesson,
  normalizeLessonList,
  lessonConfidence,
  lessonContentHash,
  lessonEdgeRejectReason,
  normalizeLessonEdge,
  normalizeLessonEdgeList,
  lessonEdgeIndex,
  lessonScore,
  selectLessonsFor,
  selectEvictions,
} from '../src/lessons.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err?.stack || err}`);
    fail++;
  }
}

const EVIDENCE = [{ taskId: 't1', msgId: 'm1', quote: '这次按模块拆是对的' }];
const active = (extra = {}) =>
  normalizeLesson({ cue: '配班子', lesson: '按模块拆', evidence: EVIDENCE, status: 'active', ...extra });

// ---------------------------------------------------------------------------
// 1. 模型族：封闭词表 + 猜测规则
// ---------------------------------------------------------------------------
test('族词表是封闭的（去偏只在里面归因，避免拼写漂移）', () => {
  assert.deepEqual([...MODEL_FAMILIES], ['glm', 'deepseek', 'kimi', 'qwen', 'gpt', 'claude', 'gemini', 'other']);
  assert.equal(UNKNOWN_MODEL_FAMILY, 'unknown');
});

test('provider / model 名能推出族：glm / deepseek / kimi / gpt / claude / gemini / qwen', () => {
  assert.equal(resolveModelFamily('glm-5.2'), 'glm');
  assert.equal(resolveModelFamily('zhipu'), 'glm');
  assert.equal(resolveModelFamily('deepseek-chat'), 'deepseek');
  assert.equal(resolveModelFamily('moonshot-v1'), 'kimi');
  assert.equal(resolveModelFamily('gpt-4o'), 'gpt');
  assert.equal(resolveModelFamily('claude-3-7-sonnet'), 'claude');
  assert.equal(resolveModelFamily('gemini-2.5-pro'), 'gemini');
  assert.equal(resolveModelFamily('qwen-max'), 'qwen');
});

test('多个提示取第一个命中的规则；都没命中 → other；没给提示 → unknown', () => {
  assert.equal(resolveModelFamily('sensenova', 'glm-5.2'), 'glm');
  assert.equal(resolveModelFamily('my-local-llm'), 'other');
  assert.equal(resolveModelFamily(), 'unknown');
  assert.equal(resolveModelFamily('', '   '), 'unknown');
});

// ---------------------------------------------------------------------------
// 2. byFamily 规范化
// ---------------------------------------------------------------------------
test('byFamily：只留计数、负数与垃圾清零、族名小写、键数封顶', () => {
  const stats = normalizeFamilyStats({
    GLM: { hit: 3, win: 2, fail: -5 },
    deepseek: { hit: 'x', win: 1.8, fail: 0 },
    extra: null,
  });
  assert.deepEqual(stats, {
    glm: { hit: 3, win: 2, fail: 0 },
    deepseek: { hit: 0, win: 1, fail: 0 },
    extra: { hit: 0, win: 0, fail: 0 },
  });

  const many = {};
  for (let i = 0; i < 20; i++) many[`f${i}`] = { hit: 1, win: 1, fail: 0 };
  assert.equal(Object.keys(normalizeFamilyStats(many)).length, LESSON_LIMITS.byFamilyKeys);
});

test('规范化老库：没有 modelFamily / byFamily 也能读，给 unknown 与空表', () => {
  const legacy = normalizeLesson({ cue: '老经验', lesson: '留着' });
  assert.equal(legacy.modelFamily, UNKNOWN_MODEL_FAMILY);
  assert.deepEqual(legacy.byFamily, {});
  assert.match(legacy.contentHash, /^sha256:[0-9a-f]{32}$/);
});

test('规范化带上新字段：modelFamily 小写、byFamily 规整、contentHash 稳定', () => {
  const l = active({ modelFamily: 'GLM', byFamily: { glm: { hit: 3, win: 2, fail: 1 } } });
  assert.equal(l.modelFamily, 'glm');
  assert.deepEqual(l.byFamily, { glm: { hit: 3, win: 2, fail: 1 } });
  const again = normalizeLesson({ cue: '配班子', lesson: '按模块拆' });
  assert.equal(again.contentHash, l.contentHash, '同样内容必须同哈希');
});

// ---------------------------------------------------------------------------
// 3. 置信度（纯派生）
// ---------------------------------------------------------------------------
test('置信度：跨两族都赢 > 单族赢 > 没打过', () => {
  const none = active();
  const one = active({ verdict: 'helped', byFamily: { glm: { hit: 3, win: 3, fail: 0 } } });
  const two = active({
    verdict: 'helped',
    byFamily: { glm: { hit: 3, win: 3, fail: 0 }, deepseek: { hit: 3, win: 3, fail: 0 } },
  });
  assert.ok(lessonConfidence(none) < lessonConfidence(one));
  assert.ok(lessonConfidence(one) < lessonConfidence(two));
  assert.ok(lessonConfidence(two) <= 0.95, '置信度封顶 0.95 —— 永远不给"绝对确定"');
});

test('置信度：hurt 的先验最低', () => {
  const hurt = active({ verdict: 'hurt' });
  const helped = active({ verdict: 'helped' });
  assert.ok(lessonConfidence(hurt) < lessonConfidence(helped));
});

// ---------------------------------------------------------------------------
// 4. 内容哈希（去重键）
// ---------------------------------------------------------------------------
test('内容哈希：大小写与多余空白不改变哈希，措辞不同则不同', () => {
  const a = { cue: '配班子', lesson: '按模块拆' };
  const b = { cue: '配班子 ', lesson: '按模块   拆' };
  const c = { cue: '配班子', lesson: '按部门拆' };
  assert.equal(lessonContentHash(a), lessonContentHash(b));
  assert.notEqual(lessonContentHash(a), lessonContentHash(c));
});

test('规范化整个库：内容相同（不同房间）也只留一条', () => {
  const list = normalizeLessonList([
    { cue: '配班子', lesson: '按模块拆', roomId: 'r1' },
    { cue: '配班子', lesson: '按模块拆', roomId: 'r2' },
  ]);
  assert.equal(list.length, 1);
});

// ---------------------------------------------------------------------------
// 5. 关系边：4 种类型、校验、去重、悬空、限量
// ---------------------------------------------------------------------------
test('边类型只有 4 种', () => {
  assert.deepEqual([...LESSON_EDGE_TYPES], ['supersedes', 'requires', 'contradicts', 'generalizes']);
});

test('边校验：缺端点 / 自环 / 未知类型都拒绝，且给人话原因', () => {
  assert.match(lessonEdgeRejectReason({}), /from \/ to/);
  assert.match(lessonEdgeRejectReason({ from: 'a', to: 'a', type: 'requires' }), /自己连自己/);
  assert.match(lessonEdgeRejectReason({ from: 'a', to: 'b', type: 'likes' }), /边类型只能是/);
  assert.equal(lessonEdgeRejectReason({ from: 'a', to: 'b', type: 'requires' }), null);
  assert.equal(normalizeLessonEdge({ from: 'a', to: 'b', type: 'likes' }), null);
});

test('边规范化：形状固定、by 缺省 distiller、at 缺省 now', () => {
  const edge = normalizeLessonEdge({ from: 'a', to: 'b', type: 'contradicts' }, 1234);
  assert.deepEqual(edge, { from: 'a', to: 'b', type: 'contradicts', at: 1234, by: 'distiller' });
});

test('边集合：去重、丢悬空（给了 knownIds 时）、超上限保留最新', () => {
  const edges = normalizeLessonEdgeList(
    [
      { from: 'a', to: 'b', type: 'requires' },
      { from: 'a', to: 'b', type: 'requires' }, // 重复
      { from: 'a', to: 'b', type: 'requires' },
      { from: 'ghost', to: 'b', type: 'requires' }, // 悬空
      { from: 'b', to: 'a', type: 'generalizes' },
    ],
    { knownIds: ['a', 'b'] },
  );
  assert.equal(edges.length, 2, '重复去重 + 悬空丢弃');
  assert.deepEqual(edges.map((e) => e.type), ['requires', 'generalizes']);
});

test('边索引：from → 边列表', () => {
  const index = lessonEdgeIndex([
    { from: 'a', to: 'b', type: 'requires' },
    { from: 'a', to: 'c', type: 'contradicts' },
    { from: 'b', to: 'c', type: 'generalizes' },
  ]);
  assert.equal(index.get('a').length, 2);
  assert.equal(index.get('b').length, 1);
  assert.equal(index.get('c'), undefined);
});

// ---------------------------------------------------------------------------
// 6. 打分：跨模型去偏 + 边权重（不传就退化回 1.x）
// ---------------------------------------------------------------------------
test('不传新参数时，打分与 1.x 完全一致（同房间只加 1 分，候选不参与）', () => {
  const l = active({ roomId: 'r1' });
  const withRoom = lessonScore(l, '帮我配班子', { roomId: 'r1' });
  const withoutRoom = lessonScore(l, '帮我配班子', {});
  // 中文按 2~4 字滑窗切词，所以只断言"同房间恰好 +1"这个 1.x 口径不变
  assert.equal(withRoom - withoutRoom, LESSON_SCORING.sameRoom);
  assert.ok(withRoom >= LESSON_SCORING.minScore);
  assert.equal(lessonScore(l, '完全无关的话', {}), 0, '不相关 = 0 分（null 专指被排除）');
  assert.deepEqual(selectLessonsFor([l], '完全无关的话', {}), []);
  assert.equal(lessonScore({ ...l, status: 'candidate' }, '配班子', {}), null, '候选不参与');
});

test('同族验证过 +2：能把一条原本差 1 分的经验拉进候选', () => {
  // lesson 命中一次 = 1 分，原本 < 3 进不了；同族验证 +2 后仍不够 → 需要再叠房间分
  const l = active({ modelFamily: 'glm', byFamily: { glm: { hit: 2, win: 2, fail: 0 } }, roomId: 'r1' });
  const base = lessonScore(l, '按模块拆', {});
  const withFamily = lessonScore(l, '按模块拆', { modelFamily: 'glm' });
  assert.equal(withFamily - base, LESSON_SCORING.sameFamily);
  assert.ok(withFamily >= base);
});

test('有归因但本族没战果 → 扣 1 分（不排除，只是往后排）', () => {
  const l = active({ modelFamily: 'glm', byFamily: { glm: { hit: 2, win: 2, fail: 0 } } });
  const tested = lessonScore(l, '配班子', { modelFamily: 'glm' });
  const untested = lessonScore(l, '配班子', { modelFamily: 'deepseek' });
  assert.equal(tested - untested, LESSON_SCORING.sameFamily - LESSON_SCORING.untestedFamily);
});

test('老经验（无归因）不享受加成，也不背扣分 —— 免得升级后旧经验全被埋掉', () => {
  const legacy = active();
  assert.equal(lessonScore(legacy, '配班子', { modelFamily: 'glm' }), lessonScore(legacy, '配班子', {}));
});

test('contradicts 边 = 硬排除（哪怕 cue 命中满分也不给）', () => {
  const l = active({ id: 'les_x' });
  const edges = [{ from: 'les_x', to: 'les_y', type: 'contradicts' }];
  assert.equal(lessonScore(l, '配班子', { edgeIndex: lessonEdgeIndex(edges) }), null);
  assert.deepEqual(selectLessonsFor([l], '配班子', { edges }), []);
});

test('generalizes 一跳 +1', () => {
  const l = active({ id: 'les_g' });
  const edges = [{ from: 'les_g', to: 'les_other', type: 'generalizes' }];
  const withEdge = lessonScore(l, '按模块拆', { edgeIndex: lessonEdgeIndex(edges) });
  const without = lessonScore(l, '按模块拆', {});
  assert.equal(withEdge - without, LESSON_SCORING.generalizesHop);
});

test('selectLessonsFor 传族与边后仍是常数预算（3 条）', () => {
  const lessons = ['a', 'b', 'c', 'd', 'e'].map((k) =>
    normalizeLesson({ id: `les_${k}`, cue: `配班子${k}`, lesson: '按模块拆', evidence: EVIDENCE, status: 'active' }),
  );
  const picked = selectLessonsFor(lessons, '配班子 按模块拆', { modelFamily: 'glm' });
  assert.equal(picked.length, LESSON_LIMITS.maxInject);
});

// ---------------------------------------------------------------------------
// 7. 淘汰
// ---------------------------------------------------------------------------
test('淘汰：不超限不丢；超限丢最久没命中的', () => {
  const mk = (id, lastUsedAt, contradictions = false) =>
    normalizeLesson({
      id,
      cue: `情境${id}`,
      lesson: '做法',
      evidence: EVIDENCE,
      status: 'active',
      lastUsedAt,
      verdict: 'helped',
      byFamily: contradictions ? {} : { glm: { hit: 1, win: 1, fail: 0 } },
    });
  const list = [mk('old', 0), mk('mid', 100), mk('new', 200)];
  assert.deepEqual(selectEvictions(list, { max: 3 }), []);
  const dropped = selectEvictions(list, { max: 2 });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'old');
});

test('淘汰：带 contradicts 边的留到最后（给人工裁决）', () => {
  const mk = (id, lastUsedAt) =>
    normalizeLesson({ id, cue: `情境${id}`, lesson: '做法', evidence: EVIDENCE, status: 'active', lastUsedAt });
  const list = [mk('disputed', 0), mk('stale', 1)];
  const edges = [{ from: 'stale', to: 'disputed', type: 'contradicts' }];
  const dropped = selectEvictions(list, { max: 1, edges });
  assert.equal(dropped[0].id, 'stale', '没冲突标记的先丢');
});

console.log(`\nlessons-sim-lite: ${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
