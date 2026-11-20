/**
 * SIM-Lite（2.0）契约测试：模型族 / 关系边 / 置信度 / 去重 / 淘汰。
 *   node tests/lessons-sim-lite.mjs
 *
 * ## 这个文件守什么
 *
 * Phase 0 只做「定稿」：把 SIM-Lite 的字段与关系边写成常量 + 纯函数，
 * **不接线**（不写盘、不改注入、不动蒸馏）。所以这里的重点不是"功能好用"，
 * 而是四条契约：
 *
 *   1. **老库直接可读**：1.x 沉淀的经验没有 `modelFamily` / `byFamily`，
 *      规范化后必须有安全默认值，不需要迁移脚本；
 *   2. **新参数不传 = 旧行为**：`selectLessonsFor` 不传 `modelFamily` / `edges`
 *      时结果必须与 1.x 完全一致（回归由 `tests/lessons.mjs` 那 17 条兜着）；
 *   3. **相关性闸门**：词面 0 分的经验不许靠"同房间 + 同族"凑够门槛
 *      —— 那会把同房间所有无关历史经验全塞进提示词；
 *   4. **矛盾与取代必须能排除**：`contradicts` 双向排除、被 `supersedes` 的旧条
 *      不进候选。宁可不给经验，也不能给一条自相矛盾或被推翻的经验。
 *
 * 文件末尾专门有一组「契约反例」，每个都对应一次真实的 review 结论（S1–S6）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LESSON_LIMITS,
  LESSON_SCORING,
  LESSON_EDGE_TYPES,
  LESSON_EDGE_SENTINELS,
  MODEL_FAMILIES,
  UNKNOWN_MODEL_FAMILY,
  resolveModelFamily,
  normalizeModelFamily,
  resolveModelFamilyForModel,
  normalizeFamilyStats,
  normalizeLesson,
  normalizeLessonList,
  lessonConfidence,
  lessonContentHash,
  lessonLexicalScore,
  lessonEdgeRejectReason,
  normalizeLessonEdge,
  normalizeLessonEdgeList,
  lessonEdgeIndex,
  lessonScore,
  selectLessonsFor,
  selectEvictions,
  countedLessonVerdict,
  applyLessonOutcome,
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
// 1. 模型族：封闭词表 + 猜测规则（先具体后宽泛）
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

test('★ 具体模型名优先于宽泛 provider（openai-compat + deepseek-chat → deepseek）', () => {
  assert.equal(resolveModelFamily('openai-compat', 'deepseek-chat'), 'deepseek');
  assert.equal(resolveModelFamily('azure', 'claude-3'), 'claude');
});

test('★ 托管平台不算族：nvidia / sensenova → other（宁可少归因，也不归错因）', () => {
  assert.equal(resolveModelFamily('nvidia'), 'other');
  assert.equal(resolveModelFamily('sensenova'), 'other');
  assert.equal(resolveModelFamily('nvidia', 'llama-3.1'), 'other');
});

test('★ OpenAI 推理系列 o1 / o3 / o4-mini 归 gpt', () => {
  assert.equal(resolveModelFamily('o1'), 'gpt');
  assert.equal(resolveModelFamily('o3-mini'), 'gpt');
  assert.equal(resolveModelFamily('o4-mini-high'), 'gpt');
  assert.equal(resolveModelFamily('chatgpt-4o-latest'), 'gpt');
});

test('从模型对象推族（复盘器带归因的入口）：provider/model 都看，认不出给 other', () => {
  assert.equal(resolveModelFamilyForModel({ provider: 'sensenova', id: 'glm-5.2' }), 'glm');
  assert.equal(resolveModelFamilyForModel({ provider: 'openai-compat', id: 'deepseek-chat' }), 'deepseek');
  assert.equal(resolveModelFamilyForModel({ provider: 'nvidia', id: 'llama-3.1' }), 'other');
  assert.equal(resolveModelFamilyForModel(null), UNKNOWN_MODEL_FAMILY);
});

test('没给提示 → unknown；都没命中 → other；族名归一按封闭词表', () => {
  assert.equal(resolveModelFamily(), 'unknown');
  assert.equal(resolveModelFamily('', '   '), 'unknown');
  assert.equal(resolveModelFamily('my-local-llm'), 'other');
  assert.equal(normalizeModelFamily('GLM'), 'glm');
  assert.equal(normalizeModelFamily('deepseek-v3'), 'deepseek', '模型名也要能归一（否则 byFamily 查不到）');
  assert.equal(normalizeModelFamily('my-custom-scheduler'), 'other');
  assert.equal(normalizeModelFamily(''), UNKNOWN_MODEL_FAMILY);
});

// ---------------------------------------------------------------------------
// 2. byFamily 规范化 + 老库兼容
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
    other: { hit: 0, win: 0, fail: 0 },
  });

  // 20 个认不出的键全部并到 other 一个桶里（不会再出现十几个"族"）
  const many = {};
  for (let i = 0; i < 20; i++) many[`f${i}`] = { hit: 1, win: 1, fail: 0 };
  const merged = normalizeFamilyStats(many);
  assert.deepEqual(Object.keys(merged), ['other']);
  assert.equal(merged.other.hit, 20);
});

test('规范化老库：没有 modelFamily / byFamily 也能读，给 unknown 与空表', () => {
  const legacy = normalizeLesson({ cue: '老经验', lesson: '留着' });
  assert.equal(legacy.modelFamily, UNKNOWN_MODEL_FAMILY);
  assert.deepEqual(legacy.byFamily, {});
  assert.match(legacy.contentHash, /^sha256:[0-9a-f]{32}$/);
});

test('规范化带上新字段：modelFamily 走封闭词表、byFamily 规整、contentHash 稳定', () => {
  const l = active({ modelFamily: 'GLM', byFamily: { glm: { hit: 3, win: 2, fail: 1 } } });
  assert.equal(l.modelFamily, 'glm');
  assert.deepEqual(l.byFamily, { glm: { hit: 3, win: 2, fail: 1 } });
  const again = normalizeLesson({ cue: '配班子', lesson: '按模块拆' });
  assert.equal(again.contentHash, l.contentHash, '同样内容必须同哈希');
  assert.equal(active({ modelFamily: 'my-custom' }).modelFamily, 'other', '封闭词表外的族名归一成 other');
});

// ---------------------------------------------------------------------------
// 3. 置信度（纯派生）—— 门槛必须够得着
// ---------------------------------------------------------------------------
test('★ 路线图门槛可达：跨 2 族 + 样本 ≥5 + win:fail ≥ 3:1 → confidence ≥ 0.8', () => {
  // 6 胜 2 负、两个族各打一半：正是路线图 §5.4 的晋升条件
  const l = active({
    verdict: 'helped',
    byFamily: { glm: { hit: 4, win: 3, fail: 1 }, deepseek: { hit: 4, win: 3, fail: 1 } },
  });
  const conf = lessonConfidence(l);
  assert.ok(conf >= 0.8, `门槛必须可达，实际 ${conf}`);
});

test('★ 单族同条件够不着门槛（单族不许升稳定经验）', () => {
  const single = active({
    verdict: 'helped',
    byFamily: { glm: { hit: 8, win: 6, fail: 2 } },
  });
  assert.ok(lessonConfidence(single) < 0.8, `单族不该过 0.8，实际 ${lessonConfidence(single)}`);
});

test('★ 全胜且跨两族接近上界，但永远 ≤ 0.95（不给"绝对确定"）', () => {
  const perfect = active({
    verdict: 'helped',
    byFamily: { glm: { hit: 5, win: 5, fail: 0 }, deepseek: { hit: 5, win: 5, fail: 0 } },
  });
  const conf = lessonConfidence(perfect);
  assert.ok(conf >= 0.9, `全胜应接近上界，实际 ${conf}`);
  assert.ok(conf <= 0.95);
});

test('置信度单调：跨两族 > 单族 > 没打过；hurt（避坑）验证后同样能升', () => {
  const none = active();
  const one = active({ verdict: 'helped', byFamily: { glm: { hit: 3, win: 3, fail: 0 } } });
  const two = active({
    verdict: 'helped',
    byFamily: { glm: { hit: 3, win: 3, fail: 0 }, deepseek: { hit: 3, win: 3, fail: 0 } },
  });
  assert.ok(lessonConfidence(none) < lessonConfidence(one));
  assert.ok(lessonConfidence(one) < lessonConfidence(two));

  const hurt = active({
    verdict: 'hurt',
    byFamily: { glm: { hit: 4, win: 3, fail: 1 }, deepseek: { hit: 4, win: 3, fail: 1 } },
  });
  assert.ok(lessonConfidence(hurt) >= 0.8, '「别这么做」是高价值经验，验证达标后也该能升');
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

test('★ 规范化整个库：同房间同内容去重，不同房间各留一条（D4 房间隔离）', () => {
  const same = normalizeLessonList([
    { cue: '配班子', lesson: '按模块拆', roomId: 'r1' },
    { cue: '配班子', lesson: '按模块拆', roomId: 'r1' },
  ]);
  assert.equal(same.length, 1, '同房间同内容只留一条');

  const crossRoom = normalizeLessonList([
    { cue: '配班子', lesson: '按模块拆', roomId: 'r1' },
    { cue: '配班子', lesson: '按模块拆', roomId: 'r2' },
  ]);
  assert.equal(crossRoom.length, 2, '不同科室的两条经验不能互相吞掉');
});

// ---------------------------------------------------------------------------
// 5. 关系边：类型、校验、方向、索引
// ---------------------------------------------------------------------------
test('边类型只有 4 种，哨兵是 user / system', () => {
  assert.deepEqual([...LESSON_EDGE_TYPES], ['supersedes', 'requires', 'contradicts', 'generalizes']);
  assert.deepEqual([...LESSON_EDGE_SENTINELS], ['user', 'system']);
});

test('边校验：缺端点 / 自环 / 未知类型都拒绝，且给出哨兵出路', () => {
  assert.match(lessonEdgeRejectReason({}), /from \/ to/);
  assert.match(lessonEdgeRejectReason({ from: 'a', to: 'a', type: 'requires' }), /自己连自己/);
  assert.match(lessonEdgeRejectReason({ from: 'a', to: 'a', type: 'requires' }), /user/);
  assert.match(lessonEdgeRejectReason({ from: 'a', to: 'b', type: 'likes' }), /边类型只能是/);
  assert.equal(lessonEdgeRejectReason({ from: 'a', to: 'b', type: 'requires' }), null);
  assert.equal(normalizeLessonEdge({ from: 'a', to: 'b', type: 'likes' }), null);
});

test('边规范化：形状固定、by 缺省 distiller、at 缺省 now', () => {
  const edge = normalizeLessonEdge({ from: 'a', to: 'b', type: 'contradicts' }, 1234);
  assert.deepEqual(edge, { from: 'a', to: 'b', type: 'contradicts', at: 1234, by: 'distiller' });
});

test('★ 用户单条否决写得进边表：from 用哨兵 user 时不算悬空', () => {
  const edges = normalizeLessonEdgeList(
    [
      { from: 'user', to: 'les_x', type: 'contradicts' },
      { from: 'system', to: 'les_x', type: 'contradicts' },
      { from: 'ghost', to: 'les_x', type: 'contradicts' }, // 真悬空，仍要丢
    ],
    { knownIds: ['les_x'] },
  );
  assert.deepEqual(edges.map((e) => e.from), ['user', 'system']);
});

test('边集合：去重、丢悬空、超上限保留最新', () => {
  const edges = normalizeLessonEdgeList(
    [
      { from: 'a', to: 'b', type: 'requires' },
      { from: 'a', to: 'b', type: 'requires' },
      { from: 'ghost', to: 'b', type: 'requires' },
      { from: 'b', to: 'a', type: 'generalizes' },
    ],
    { knownIds: ['a', 'b'] },
  );
  assert.equal(edges.length, 2, '重复去重 + 悬空丢弃');
  assert.deepEqual(edges.map((e) => e.type), ['requires', 'generalizes']);
});

test('★ 边索引双向可查：id → { incoming, outgoing }', () => {
  const index = lessonEdgeIndex([
    { from: 'new', to: 'old', type: 'supersedes' },
    { from: 'a', to: 'c', type: 'contradicts' },
  ]);
  assert.equal(index.get('new').outgoing.length, 1);
  assert.equal(index.get('new').incoming.length, 0);
  assert.equal(index.get('old').incoming.length, 1, '被取代的旧条必须能查到入边');
  assert.equal(index.get('old').outgoing.length, 0);
  assert.equal(index.get('c').incoming[0].type, 'contradicts');
});

// ---------------------------------------------------------------------------
// 6. 打分：相关性闸门 + 跨模型去偏 + 边权重
// ---------------------------------------------------------------------------
test('不传新参数时，打分与 1.x 完全一致（同房间只加 1 分，候选不参与）', () => {
  const l = active({ roomId: 'r1' });
  const withRoom = lessonScore(l, '帮我配班子', { roomId: 'r1' });
  const withoutRoom = lessonScore(l, '帮我配班子', {});
  assert.equal(withRoom - withoutRoom, LESSON_SCORING.sameRoom);
  assert.ok(withRoom >= LESSON_SCORING.minScore);
  assert.equal(lessonScore(l, '完全无关的话', {}), null, '零相关性 = 不参与候选（null，而不是 0 分）');
  assert.deepEqual(selectLessonsFor([l], '完全无关的话', {}), []);
  assert.equal(lessonScore({ ...l, status: 'candidate' }, '配班子', {}), null, '候选不参与');
});

test('★【S1】零相关性不许靠「同房间 + 同族」凑够门槛', () => {
  const unrelated = active({
    cue: 'pytest 权限报错',
    lesson: '用仓内 basetemp 目录',
    roomId: 'r1',
    modelFamily: 'deepseek',
    byFamily: { deepseek: { hit: 3, win: 3, fail: 0 } },
  });
  // 任务与这条经验毫无词面交集：同房间(+1) + 同族(+2) 本来刚好凑到门槛 3
  assert.equal(
    lessonScore(unrelated, '今天天气怎么样', { roomId: 'r1', modelFamily: 'deepseek' }),
    null,
    '词面 0 分就是不相干，房间分与族分不许无中生有',
  );
  assert.deepEqual(
    selectLessonsFor([unrelated], '今天天气怎么样', { roomId: 'r1', modelFamily: 'deepseek' }),
    [],
  );
});

test('同族验证过 +2：能把一条经验拉到更前面', () => {
  const l = active({ modelFamily: 'glm', byFamily: { glm: { hit: 2, win: 2, fail: 0 } } });
  const base = lessonScore(l, '按模块拆', {});
  const withFamily = lessonScore(l, '按模块拆', { modelFamily: 'glm' });
  assert.equal(withFamily - base, LESSON_SCORING.sameFamily);
});

test('★【S2】0 胜 3 负不许拿同族加分，反而要扣分', () => {
  const loser = active({ modelFamily: 'deepseek', byFamily: { deepseek: { hit: 3, win: 0, fail: 3 } } });
  const neutral = active();
  const loserScore = lessonScore(loser, '配班子', { modelFamily: 'deepseek' });
  const neutralScore = lessonScore(neutral, '配班子', { modelFamily: 'deepseek' });
  assert.ok(
    loserScore < neutralScore,
    `打输过的经验必须比无数据的老经验更靠后：loser=${loserScore} neutral=${neutralScore}`,
  );
  assert.equal(
    lessonScore(loser, '配班子', { modelFamily: 'deepseek' }) - lessonScore(loser, '配班子', {}),
    LESSON_SCORING.lostOnFamily,
  );
});

test('有归因但本族没战果 → 扣 1 分（不排除，只是往后排）', () => {
  const l = active({ modelFamily: 'glm', byFamily: { glm: { hit: 2, win: 2, fail: 0 } } });
  const tested = lessonScore(l, '配班子', { modelFamily: 'glm' });
  const untested = lessonScore(l, '配班子', { modelFamily: 'kimi' });
  assert.equal(tested - untested, LESSON_SCORING.sameFamily - LESSON_SCORING.untestedFamily);
});

test('老经验（无归因）不享受加成，也不背扣分 —— 免得升级后旧经验全被埋掉', () => {
  const legacy = active();
  assert.equal(lessonScore(legacy, '配班子', { modelFamily: 'glm' }), lessonScore(legacy, '配班子', {}));
});

test('★【S4.1】被 supersedes 取代的旧条不进候选（按入边判）', () => {
  const newer = active({ id: 'les_new', cue: '配班子', lesson: '按模块拆' });
  const older = active({ id: 'les_old', cue: '配班子', lesson: '按部门拆' });
  const edges = [{ from: 'les_new', to: 'les_old', type: 'supersedes' }];
  const picked = selectLessonsFor([newer, older], '配班子', { edges });
  assert.deepEqual(picked.map((l) => l.id), ['les_new'], '旧做法被新做法取代后不该再被注入');
});

test('★【S4.2】contradicts 双向排除（写在 from 或 to 上都要拦住）', () => {
  const a = active({ id: 'les_a' });
  const b = active({ id: 'les_b' });
  const forward = [{ from: 'les_a', to: 'les_b', type: 'contradicts' }];
  const backward = [{ from: 'les_b', to: 'les_a', type: 'contradicts' }];
  for (const edges of [forward, backward]) {
    assert.deepEqual(selectLessonsFor([a, b], '配班子', { edges }), [], '冲突的两条都必须排除');
  }
  // 用户哨兵否决同样生效
  const userVeto = [{ from: 'user', to: 'les_a', type: 'contradicts' }];
  assert.deepEqual(selectLessonsFor([a, b], '配班子', { edges: userVeto }).map((l) => l.id), ['les_b']);
});

test('★【S4.3】generalizes 只在「特化条命中任务」时 +1，且不随边数叠加', () => {
  const special = normalizeLesson({ id: 'les_spec', cue: 'pytest 权限报错', lesson: '用仓内 basetemp', evidence: EVIDENCE, status: 'active' });
  const general = normalizeLesson({ id: 'les_gen', cue: '跑测试报错', lesson: '先看临时目录权限', evidence: EVIDENCE, status: 'active' });
  const edges = [{ from: 'les_spec', to: 'les_gen', type: 'generalizes' }];

  // 特化条命中任务 → 泛化条拿到 +1
  const hit = lessonScore(general, 'pytest 权限报错 怎么办', { edgeIndex: lessonEdgeIndex(edges), relatedIds: new Set(['les_spec']) });
  const plain = lessonScore(general, 'pytest 权限报错 怎么办', {});
  assert.equal(hit - plain, LESSON_SCORING.generalizesHop);

  // 特化条没命中任务 → 泛化条不许加分（也不许靠它挤过门槛）
  const miss = lessonScore(general, '今天天气怎么样', { edgeIndex: lessonEdgeIndex(edges), relatedIds: new Set() });
  assert.equal(miss, null);

  // 挂 3 条边也只 +1
  const many = [
    { from: 'les_spec', to: 'les_gen', type: 'generalizes' },
    { from: 'les_spec2', to: 'les_gen', type: 'generalizes' },
    { from: 'les_spec3', to: 'les_gen', type: 'generalizes' },
  ];
  const stacked = lessonScore(general, 'pytest 权限报错 怎么办', {
    edgeIndex: lessonEdgeIndex(many),
    relatedIds: new Set(['les_spec', 'les_spec2', 'les_spec3']),
  });
  assert.equal(stacked - plain, LESSON_SCORING.generalizesHop, '单条经验最多 +1，不随边数叠加');
});

test('requires 边不影响排序（只作附带上下文）', () => {
  const a = active({ id: 'les_a' });
  const b = active({ id: 'les_b', cue: '另外一个情境', lesson: '另外的做法' });
  const edges = [{ from: 'les_a', to: 'les_b', type: 'requires' }];
  assert.equal(
    lessonScore(a, '配班子', { edgeIndex: lessonEdgeIndex(edges) }),
    lessonScore(a, '配班子', {}),
  );
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
const mkLesson = (id, extra = {}) =>
  normalizeLesson({ id, cue: `情境${id}`, lesson: '做法', evidence: EVIDENCE, status: 'active', ...extra });

test('淘汰：不超限不丢；超限丢最久没命中的', () => {
  const list = [mkLesson('old', { lastUsedAt: 0 }), mkLesson('mid', { lastUsedAt: 100 }), mkLesson('new', { lastUsedAt: 200 })];
  assert.deepEqual(selectEvictions(list, { max: 3 }), []);
  const dropped = selectEvictions(list, { max: 2 });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'old');
});

test('★【S6】淘汰分档：archived → candidate → active（绝不先丢 active）', () => {
  const list = [
    mkLesson('active_old', { status: 'active', lastUsedAt: 0 }),
    mkLesson('candidate_new', { status: 'candidate', lastUsedAt: 999 }),
    mkLesson('archived_new', { status: 'archived', lastUsedAt: 999 }),
  ];
  const dropped = selectEvictions(list, { max: 1 });
  const ids = dropped.map((l) => l.id);
  assert.equal(ids[0], 'archived_new', '归档的先丢');
  assert.equal(ids[1], 'candidate_new', '然后是候选');
  assert.ok(!ids.includes('active_old'), 'active 是唯一会注入的档，最后才轮到它');
});

test('淘汰：带 contradicts 边的两条都受保护（留给人工裁决）', () => {
  const list = [mkLesson('disputed', { lastUsedAt: 5 }), mkLesson('stale', { lastUsedAt: 1 })];
  const edges = [{ from: 'stale', to: 'disputed', type: 'contradicts' }];
  const dropped = selectEvictions(list, { max: 1, edges });
  // 两条都在冲突里 → 都受保护；数量超了仍要丢一条，此时按 lastUsedAt 决定，且只丢一条
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'stale', '两条都受保护时退回 lastUsedAt：最久没命中的先走');
});

test('淘汰：非冲突经验先于冲突经验被丢', () => {
  const list = [mkLesson('disputed', { lastUsedAt: 100 }), mkLesson('stale', { lastUsedAt: 999 })];
  const edges = [{ from: 'user', to: 'disputed', type: 'contradicts' }];
  const dropped = selectEvictions(list, { max: 1, edges });
  assert.equal(dropped[0].id, 'stale', '没有冲突标记的先丢，哪怕它更近被用过');
});

// ---------------------------------------------------------------------------
// R1–R3：review 查出的三个尾巴
// ---------------------------------------------------------------------------
const { createStore } = await import('../src/store.js');
const { createBus } = await import('../src/bus.js');
const { createConfig } = await import('../src/config.js');

function freshStore(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orbis-lesson-${tag}-`));
  const config = createConfig({ dataDir: dir, workspace: path.join(dir, 'w'), ensureDirs: true, serverBoot: false, autoProbe: false });
  const store = createStore({ config, bus: createBus(), dataDir: dir, secretsKey: null });
  return { store, dir };
}

test('★【R1】改文案后 contentHash 必须跟着变（派生值不许信任传入值）', () => {
  const { store, dir } = freshStore('r1');
  const { lesson } = store.addLesson({ cue: '配班子', lesson: '按模块拆', roomId: 'r1' });
  const before = lesson.contentHash;
  const r = store.updateLesson(lesson.id, { lesson: '按部门拆' });
  assert.ok(r.lesson, r.error);
  assert.notEqual(r.lesson.contentHash, before, '改了正文哈希还停在旧值，去重会一直撞旧记录');
  assert.equal(r.lesson.contentHash, lessonContentHash({ cue: r.lesson.cue, lesson: r.lesson.lesson }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★【R1】同房间同内容（空白不同）必须报错，不能静默丢新条', () => {
  const { store, dir } = freshStore('r1b');
  store.addLesson({ cue: '配班子', lesson: '按模块拆', roomId: 'r1' });
  const dup = store.addLesson({ cue: '配班子 ', lesson: '按模块   拆', roomId: 'r1' });
  assert.match(dup.error ?? '', /同样情境/, '要么明确报错，要么真的写进去 —— 不许假成功');
  assert.equal(store.lessonLibrary().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★【R2】未启用的特化条不许给泛化条送分（否则绕过相关性闸门）', () => {
  const spec = normalizeLesson({ id: 'les_spec', cue: 'pytest 权限报错', lesson: '用仓内 basetemp', status: 'candidate' });
  const gen = normalizeLesson({ id: 'les_gen', cue: '跑测试', lesson: '先看临时目录', roomId: 'r1', modelFamily: 'glm', byFamily: { glm: { hit: 2, win: 2, fail: 0 } }, evidence: EVIDENCE, status: 'active' });
  const edges = [{ from: 'les_spec', to: 'les_gen', type: 'generalizes' }];
  // 任务与泛化条只有 1 分词面（"跑测试" 里的 "跑" 不算，这里构造零相关 + 房间/族加成）
  const picked = selectLessonsFor([spec, gen], 'pytest 权限报错', { roomId: 'r1', modelFamily: 'glm', edges });
  assert.deepEqual(picked.map((l) => l.id), [], '候选（未启用）不配当"特化邻居"');
});

test('★【R2】被否决的特化条也不许送分', () => {
  const spec = normalizeLesson({ id: 'les_spec2', cue: 'pytest 权限报错', lesson: '用仓内 basetemp', status: 'active', evidence: EVIDENCE });
  const gen = normalizeLesson({ id: 'les_gen2', cue: '跑测试', lesson: '先看临时目录', roomId: 'r1', status: 'active', evidence: EVIDENCE, modelFamily: 'glm', byFamily: { glm: { hit: 2, win: 2, fail: 0 } } });
  const edges = [
    { from: 'les_spec2', to: 'les_gen2', type: 'generalizes' },
    { from: 'user', to: 'les_spec2', type: 'contradicts' },
  ];
  assert.deepEqual(
    selectLessonsFor([spec, gen], 'pytest 权限报错', { roomId: 'r1', modelFamily: 'glm', edges }),
    [],
  );
});

test('★【R3】byFamily 的键走封闭词表并合并：deepseek-v3 + deepseek-chat ≠ 两个族', () => {
  const merged = normalizeFamilyStats({
    'deepseek-v3': { hit: 1, win: 1, fail: 0 },
    'deepseek-chat': { hit: 2, win: 1, fail: 1 },
  });
  assert.deepEqual(Object.keys(merged), ['deepseek']);
  assert.deepEqual(merged.deepseek, { hit: 3, win: 2, fail: 1 });

  // 合并后 coverage 仍是 1 个族 → 置信度不该被虚算成"跨两族"
  const l = active({ verdict: 'helped', byFamily: { 'deepseek-v3': { hit: 4, win: 3, fail: 1 }, 'deepseek-chat': { hit: 4, win: 3, fail: 1 } } });
  assert.ok(lessonConfidence(l) < 0.8, `同一个族不该被算成两个，实际 ${lessonConfidence(l)}`);
});

// ---------------------------------------------------------------------------
// 8. 效果评估记账（win/fail 的唯一合法来源）
// ---------------------------------------------------------------------------
test('countedLessonVerdict：只有 helped/hurt 记账，no_effect 与 confounded 一律不记', () => {
  assert.equal(countedLessonVerdict('helped'), 'win');
  assert.equal(countedLessonVerdict('hurt'), 'fail');
  assert.equal(countedLessonVerdict('no_effect'), null, '这次用不上 ≠ 失败');
  assert.equal(countedLessonVerdict('confounded'), null, '说不清就不记');
  assert.equal(countedLessonVerdict('胡说'), null);
});

test('applyLessonOutcome：按当时执行的模型族记 win / fail', () => {
  const l = active({ id: 'les_o', modelFamily: 'glm' });
  const win = applyLessonOutcome(l, { verdict: 'helped', modelFamily: 'glm' });
  assert.deepEqual(win.byFamily.glm, { hit: 0, win: 1, fail: 0 });
  const fail = applyLessonOutcome(win, { verdict: 'hurt', modelFamily: 'glm' });
  assert.deepEqual(fail.byFamily.glm, { hit: 0, win: 1, fail: 1 });
});

test('applyLessonOutcome：不可计数时原样返回同一个引用（调用方据此判"没记账"）', () => {
  const l = active({ id: 'les_o2', modelFamily: 'glm' });
  assert.equal(applyLessonOutcome(l, { verdict: 'confounded', modelFamily: 'glm' }), l);
  assert.equal(applyLessonOutcome(l, {}, {}), l);
});

test('applyLessonOutcome：没有归因（unknown）就没地方记，不改数据', () => {
  const legacy = normalizeLesson({ id: 'les_legacy', cue: 'a', lesson: 'b', evidence: EVIDENCE, status: 'active' });
  assert.equal(applyLessonOutcome(legacy, { verdict: 'helped' }), legacy, 'unknown 族不许偷偷建条目');
});

test('applyLessonOutcome：换族记账互不影响（这正是跨模型去偏要的数据）', () => {
  const l = active({ id: 'les_o3', modelFamily: 'glm' });
  const a = applyLessonOutcome(l, { verdict: 'helped', modelFamily: 'glm' });
  const b = applyLessonOutcome(a, { verdict: 'hurt', modelFamily: 'deepseek' });
  assert.deepEqual(b.byFamily.glm, { hit: 0, win: 1, fail: 0 });
  assert.deepEqual(b.byFamily.deepseek, { hit: 0, win: 0, fail: 1 });
});

// ---------------------------------------------------------------------------
// 8. 词面相关性单测（闸门输入）
// ---------------------------------------------------------------------------
test('lessonLexicalScore：cue 命中 3 分/词，lesson 命中 1 分/词，无交集为 0', () => {
  const l = active();
  assert.ok(lessonLexicalScore(l, '配班子') >= LESSON_SCORING.cueHit);
  assert.equal(lessonLexicalScore(l, '今天天气怎么样'), 0);
  assert.equal(lessonLexicalScore(l, ''), 0);
});

console.log(`\nlessons-sim-lite: ${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
