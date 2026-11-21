/**
 * 经验库测试。
 *
 * 盯的是"上下文不被撑爆"和"没有证据的经验不许进提示词"这两条：
 *   · 只有 active 参与注入；候选只能在界面上看；
 *   · 一次最多 3 条、总字数不超过 600 —— 库再大注入量也是常数；
 *   · 没有证据（哪次任务、原始引文）不能启用；
 *   · 不相关就不给（宁可不给，也别塞）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LESSON_LIMITS,
  lessonRejectReason,
  normalizeLesson,
  normalizeLessonList,
  selectLessonsFor,
  lessonsPromptLines,
} from '../src/lessons.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

const EVIDENCE = [{ taskId: 't1', msgId: 'm1', quote: '他们团队应该每个功能模块都有专人负责给我汇报才对' }];

test('必填：没有情境/做法就拒收', () => {
  assert.match(lessonRejectReason({}), /cue|情境/);
  assert.ok(lessonRejectReason({ cue: '给部门配班子', lesson: '' }));
  assert.equal(lessonRejectReason({ cue: '给部门配班子', lesson: '按模块拆 owner' }), null);
});

test('乱码拒收（编码损坏的文本进库会污染所有后续任务）', () => {
  const reason = lessonRejectReason({ cue: '配班子\uFFFD', lesson: '按模块拆' });
  assert.match(reason, /乱码/);
});

test('没有证据不能启用 —— 而候选用不着证据', () => {
  const noEvidence = { cue: '配班子', lesson: '按模块拆 owner', status: 'active' };
  assert.match(lessonRejectReason(noEvidence), /证据/);

  const withEvidence = { ...noEvidence, evidence: EVIDENCE };
  assert.equal(lessonRejectReason(withEvidence), null);

  assert.equal(lessonRejectReason({ cue: '配班子', lesson: '按模块拆', status: 'candidate' }), null);
});

test('规范化：字段截断、形状稳定、active 无证据会退回候选', () => {
  const lesson = normalizeLesson({
    cue: 'x'.repeat(500),
    lesson: 'y'.repeat(500),
    evidence: EVIDENCE,
    verdict: 'helped',
    status: 'active',
  });
  assert.equal(lesson.cue.length, LESSON_LIMITS.cue);
  assert.equal(lesson.lesson.length, LESSON_LIMITS.lesson);
  assert.equal(lesson.verdict, 'helped');

  const sneaky = normalizeLesson({ cue: '配班子', lesson: '按模块拆', status: 'active' });
  assert.equal(sneaky.status, 'candidate', '没有证据时不能靠 normalize 绕过校验');
});

test('规范化：结论只认四档，乱填退回 confounded', () => {
  assert.equal(normalizeLesson({ cue: 'a', lesson: 'b', verdict: 'helped' }).verdict, 'helped');
  assert.equal(normalizeLesson({ cue: 'a', lesson: 'b', verdict: '听说不错' }).verdict, 'confounded');
});

test('库规范化：同房间 + 同情境去重，并限量', () => {
  const list = normalizeLessonList([
    { cue: '配班子', lesson: 'A' },
    { cue: '配班子', lesson: 'B' },
    { cue: '配班子', roomId: 'r2', lesson: 'C' },
  ]);
  assert.equal(list.length, 2, '同房间同 cue 只留第一条');
  assert.equal(list[0].lesson, 'A');
});

test('挑选：只有 active 参与', () => {
  const lessons = [
    { id: '1', cue: '给部门配班子', lesson: '按模块拆 owner', status: 'candidate' },
    { id: '2', cue: '给部门配班子', lesson: '按模块拆 owner', status: 'active' },
    { id: '3', cue: '给部门配班子', lesson: '按模块拆 owner', status: 'archived' },
  ];
  const picked = selectLessonsFor(lessons, '给部门配班子，每个模块都要有人', {});
  assert.deepEqual(picked.map((l) => l.id), ['2']);
});

test('挑选：不相关就不给', () => {
  const lessons = [{ id: '1', cue: '给部门配班子', lesson: '按模块拆 owner', status: 'active' }];
  assert.deepEqual(selectLessonsFor(lessons, '把这段 markdown 转成表格', {}), []);
  assert.deepEqual(selectLessonsFor(lessons, '', {}), []);
});

test('挑选：最多 3 条（库再大也只注入 3 条）', () => {
  const lessons = Array.from({ length: 10 }, (_, i) => ({
    id: `l${i}`,
    cue: '给部门配班子加人',
    lesson: `做法 ${i}`,
    status: 'active',
  }));
  const picked = selectLessonsFor(lessons, '给部门配班子加人', {});
  assert.equal(picked.length, LESSON_LIMITS.maxInject);
});

test('挑选：同房间加分（同分时优先本部门）', () => {
  const lessons = [
    { id: 'other', cue: '给部门配班子', lesson: '做法', status: 'active', roomId: 'r1' },
    { id: 'mine', cue: '给部门配班子', lesson: '做法', status: 'active', roomId: 'r2' },
  ];
  const picked = selectLessonsFor(lessons, '给部门配班子', { roomId: 'r2' });
  assert.equal(picked[0].id, 'mine');
});

test('渲染：总字数不超过上限，长条被截断', () => {
  const lessons = Array.from({ length: 3 }, (_, i) => ({
    id: `l${i}`,
    cue: '给部门配班子'.repeat(5),
    lesson: '按功能模块拆 owner，收尾按模块汇报'.repeat(4),
    status: 'active',
    createdAt: Date.now(),
    verdict: 'helped',
  }));
  const lines = lessonsPromptLines(lessons, { maxChars: 200 });
  const body = lines.slice(1).join('\n');
  assert.ok(body.length <= 200, `实际 ${body.length}`);
  assert.ok(body.endsWith('…') || body.length <= 200);
});

test('渲染：hurt 用「别：」提醒不要重犯', () => {
  const lines = lessonsPromptLines([
    { cue: '成员失败时', lesson: '让负责人悄悄接手', verdict: 'hurt', createdAt: Date.now() },
  ]);
  assert.match(lines.join('\n'), /别：/);
});

test('渲染：没有命中就返回空数组（不注入任何东西）', () => {
  assert.deepEqual(lessonsPromptLines([]), []);
});

// ---------------------------------------------------------------------------
// store 往返（放在最后：要先设好环境变量再 import 单例）
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-lessons-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_DATA_DIR = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { store } = await import('../src/store.js');

test('store：加一条候选 + 同情境去重', () => {
  const added = store.addLesson({ cue: 'store-case', lesson: '做法 A' });
  assert.ok(!added.error, added.error);
  assert.equal(added.lesson.status, 'candidate');

  const dup = store.addLesson({ cue: 'store-case', lesson: '做法 B' });
  assert.match(dup.error, /同样情境/);
});

test('store：没有证据不能启用（接口层也拦）', () => {
  const lesson = store.lessonLibrary().find((l) => l.cue === 'store-case');
  const r = store.updateLesson(lesson.id, { status: 'active' });
  assert.match(r.error, /证据/);
});

test('store：带证据可以启用，之后能被挑中并记命中', () => {
  const lesson = store.lessonLibrary().find((l) => l.cue === 'store-case');
  const r = store.updateLesson(lesson.id, { status: 'active', evidence: EVIDENCE });
  assert.ok(!r.error, r.error);
  assert.equal(r.lesson.status, 'active');

  const picked = selectLessonsFor(store.lessonLibrary(), 'store-case 这个情境', {});
  assert.equal(picked.length, 1);

  store.touchLessons([lesson.id]);
  const after = store.lessonLibrary().find((l) => l.id === lesson.id);
  assert.equal(after.hits, 1);
  assert.ok(after.lastUsedAt > 0);
});

test('store：删掉之后不再被挑中', () => {
  const lesson = store.lessonLibrary().find((l) => l.cue === 'store-case');
  const r = store.removeLesson(lesson.id);
  assert.ok(!r.error, r.error);
  assert.equal(selectLessonsFor(store.lessonLibrary(), 'store-case 这个情境', {}).length, 0);
});

// ---------------------------------------------------------------------------
// store：效果评估记账（SIM-Lite：win/fail 唯一合法来源）
// ---------------------------------------------------------------------------
test('store 记账：helped → win，hurt → fail，confounded / no_effect 不记', () => {
  const l = store.addLesson({ cue: '记账案', lesson: '做法', evidence: EVIDENCE, status: 'active', modelFamily: 'glm' }).lesson;
  const win = store.recordLessonOutcomes([{ id: l.id, verdict: 'helped', modelFamily: 'glm' }]);
  assert.equal(win.applied, 1);
  assert.deepEqual(store.lessonLibrary().find((x) => x.id === l.id).byFamily.glm, { hit: 0, win: 1, fail: 0 });

  const hurt = store.recordLessonOutcomes([{ id: l.id, verdict: 'hurt', modelFamily: 'glm' }]);
  assert.equal(hurt.applied, 1);
  assert.deepEqual(store.lessonLibrary().find((x) => x.id === l.id).byFamily.glm, { hit: 0, win: 1, fail: 1, streak: 1 });

  for (const verdict of ['confounded', 'no_effect']) {
    const r = store.recordLessonOutcomes([{ id: l.id, verdict, modelFamily: 'glm' }]);
    assert.equal(r.applied, 0, `${verdict} 不该记账`);
    assert.deepEqual(r.ignored, [l.id]);
  }
  assert.deepEqual(store.lessonLibrary().find((x) => x.id === l.id).byFamily.glm, { hit: 0, win: 1, fail: 1, streak: 1 });
});

test('store 记账：不存在的 id 直接忽略，不报错也不建新条目', () => {
  const before = store.lessonLibrary().length;
  const r = store.recordLessonOutcomes([{ id: 'les_ghost', verdict: 'helped', modelFamily: 'glm' }]);
  assert.equal(r.applied, 0);
  assert.deepEqual(r.ignored, ['les_ghost']);
  assert.equal(store.lessonLibrary().length, before);
});

test('store 记账：换族记账互不影响（跨模型去偏的数据源）', () => {
  const l = store.addLesson({ cue: '记账案二', lesson: '做法', evidence: EVIDENCE, status: 'active', modelFamily: 'glm' }).lesson;
  store.recordLessonOutcomes([
    { id: l.id, verdict: 'helped', modelFamily: 'glm' },
    { id: l.id, verdict: 'hurt', modelFamily: 'deepseek' },
  ]);
  const after = store.lessonLibrary().find((x) => x.id === l.id);
  assert.deepEqual(after.byFamily.glm, { hit: 0, win: 1, fail: 0 });
  assert.deepEqual(after.byFamily.deepseek, { hit: 0, win: 0, fail: 1, streak: 1 });
});

// ---------------------------------------------------------------------------
// store：关系边（SIM-Lite Phase 1 第一刀）
// ---------------------------------------------------------------------------
const { selectLessonsFor: pick } = await import('../src/lessons.js');

test('store：蒸馏器带进来的 modelFamily 会落库（老库缺字段仍是 unknown）', () => {
  const withFamily = store.addLesson({ cue: '归因案', lesson: '做法', modelFamily: 'glm' }).lesson;
  assert.equal(withFamily.modelFamily, 'glm');
  const legacy = store.addLesson({ cue: '归因案旧', lesson: '做法' }).lesson;
  assert.equal(legacy.modelFamily, 'unknown', '没有归因的老路径仍然安全');
});

test('store 边：两条真实经验之间可以建边，重复建要拒', () => {
  const a = store.addLesson({ cue: '边案 A', lesson: '做法 A', modelFamily: 'glm' }).lesson;
  const b = store.addLesson({ cue: '边案 B', lesson: '做法 B', modelFamily: 'deepseek' }).lesson;
  const before = store.lessonEdges().length;
  const r = store.addLessonEdge({ from: a.id, to: b.id, type: 'generalizes' });
  assert.ok(r.edge, r.error);
  assert.equal(store.lessonEdges().length, before + 1);

  const dup = store.addLessonEdge({ from: a.id, to: b.id, type: 'generalizes' });
  assert.match(dup.error, /已经存在/);
});

test('store 边：指向不存在的经验 / 未知类型 都拒，且给原因', () => {
  const a = store.addLesson({ cue: '边案 C', lesson: '做法 C' }).lesson;
  const b = store.addLesson({ cue: '边案 C2', lesson: '做法 C2' }).lesson;
  assert.match(store.addLessonEdge({ from: a.id, to: 'les_nope', type: 'requires' }).error, /目标经验不存在/);
  assert.match(store.addLessonEdge({ from: 'les_nope', to: a.id, type: 'requires' }).error, /来源经验不存在/);
  assert.match(store.addLessonEdge({ from: a.id, to: a.id, type: 'requires' }).error, /自己连自己/);
  assert.match(store.addLessonEdge({ from: a.id, to: b.id, type: 'likes' }).error, /边类型只能是/);
});

test('store 边：from 可以用 user 哨兵（用户否决写边）', () => {
  const x = store.addLesson({ cue: '边案否决', lesson: '错的做法' }).lesson;
  const r = store.addLessonEdge({ from: 'user', to: x.id, type: 'contradicts', by: 'user' });
  assert.ok(r.edge, r.error);
  assert.ok(store.lessonEdges().some((e) => e.from === 'user' && e.to === x.id));
});

test('store 边：用户在界面点「记错了」→ 写 user 否决边 + 归档，之后注入不进去', () => {
  const bad = store.addLesson({ cue: '边案否决二', lesson: '把测试改成永远通过', evidence: EVIDENCE }).lesson;
  store.updateLesson(bad.id, { status: 'active' });
  assert.equal(pick(store.lessonLibrary(), '边案否决二 怎么做', {}).length >= 1, true, '启用后本来能被挑中');

  const r = store.rejectLesson(bad.id);
  assert.ok(r.ok, r.error);
  assert.equal(r.lesson.status, 'archived', '否决后归到归档，不再出现在待启用里');
  const after = pick(store.lessonLibrary(), '边案否决二 怎么做', { edges: store.lessonEdges() });
  assert.equal(after.length, 0, '带有 user 否决边的经验不许被注入');
});

test('store 边：删经验会级联删掉它挂的边（不留悬空）', () => {
  const a = store.addLesson({ cue: '边案 D', lesson: '做法 D' }).lesson;
  const b = store.addLesson({ cue: '边案 E', lesson: '做法 E' }).lesson;
  store.addLessonEdge({ from: a.id, to: b.id, type: 'requires' });
  assert.ok(store.lessonEdges().some((e) => e.to === b.id));
  store.removeLesson(b.id);
  assert.ok(!store.lessonEdges().some((e) => e.to === b.id || e.from === b.id), '目标没了，边必须跟着走');
});

test('store 边：lessons.updated 事件同时带 lessons 与 edges（界面不用再拉一次）', () => {
  const seen = [];
  const listener = (ev) => {
    if (ev?.t === 'lessons.updated') seen.push(ev);
  };
  store.bus.on('event', listener);
  const a = store.addLesson({ cue: '边案 F', lesson: '做法 F' }).lesson;
  const b = store.addLesson({ cue: '边案 G', lesson: '做法 G' }).lesson;
  store.addLessonEdge({ from: a.id, to: b.id, type: 'supersedes' });
  store.bus.off('event', listener);
  assert.ok(seen.length >= 3, `至少要发三次（两条经验 + 一条边），实际 ${seen.length}`);
  const last = seen[seen.length - 1];
  assert.ok(Array.isArray(last.lessons));
  assert.ok(Array.isArray(last.edges), '事件必须带 edges');
  assert.ok(last.edges.some((e) => e.type === 'supersedes'));
});

// ---------------------------------------------------------------------------
// store：族内衰减（路线图 §5.4）—— 连败到阈值自动归档 + system 边，人工可恢复
// ---------------------------------------------------------------------------
test('store 衰减：同族连续败两次 → 自动归档 + system contradicts 边，第三次不重复写边', () => {
  const l = store.addLesson({
    cue: '衰减案',
    lesson: '做法',
    evidence: EVIDENCE,
    status: 'active',
    modelFamily: 'glm',
  }).lesson;
  const first = store.recordLessonOutcomes([{ id: l.id, verdict: 'hurt', modelFamily: 'glm' }]);
  assert.deepEqual(first.decayed, [], '败一次不该降级');
  assert.equal(store.lessonLibrary().find((x) => x.id === l.id).status, 'active');

  const second = store.recordLessonOutcomes([{ id: l.id, verdict: 'hurt', modelFamily: 'glm' }]);
  assert.equal(second.decayed.length, 1);
  assert.deepEqual(second.decayed[0], { id: l.id, family: 'glm', streak: 2 });
  const after = store.lessonLibrary().find((x) => x.id === l.id);
  assert.equal(after.status, 'archived', '降到归档档，不再出现在待启用里');
  assert.ok(
    store.lessonEdges().some((e) => e.from === 'system' && e.to === l.id && e.type === 'contradicts'),
    '要写 system 哨兵边：即使被误切回 active，打分也会双向排除',
  );

  const third = store.recordLessonOutcomes([{ id: l.id, verdict: 'hurt', modelFamily: 'glm' }]);
  assert.equal(third.decayed.length, 1, '还在连败，仍然报告降级');
  assert.equal(
    store.lessonEdges().filter((e) => e.from === 'system' && e.to === l.id).length,
    1,
    '边是幂等的，不能越写越多',
  );
});

test('store 衰减：中间赢一次就重新计数（连续 ≠ 历史总数）', () => {
  const l = store.addLesson({
    cue: '衰减案二',
    lesson: '做法',
    evidence: EVIDENCE,
    status: 'active',
    modelFamily: 'glm',
  }).lesson;
  store.recordLessonOutcomes([{ id: l.id, verdict: 'hurt', modelFamily: 'glm' }]);
  store.recordLessonOutcomes([{ id: l.id, verdict: 'helped', modelFamily: 'glm' }]);
  const r = store.recordLessonOutcomes([{ id: l.id, verdict: 'hurt', modelFamily: 'glm' }]);
  assert.deepEqual(r.decayed, [], '赢过就不能算连败');
  assert.equal(store.lessonLibrary().find((x) => x.id === l.id).status, 'active');
});

test('store 衰减：被降级的条不能裸切 active（否则看起来启用了、实际注入不进去）', () => {
  const l = store.addLesson({
    cue: '衰减案三',
    lesson: '做法',
    evidence: EVIDENCE,
    status: 'active',
    modelFamily: 'glm',
  }).lesson;
  store.recordLessonOutcomes([
    { id: l.id, verdict: 'hurt', modelFamily: 'glm' },
    { id: l.id, verdict: 'hurt', modelFamily: 'glm' },
  ]);
  const bad = store.updateLesson(l.id, { status: 'active' });
  assert.match(bad.error, /解除降级/);
  assert.ok(
    !pick(store.lessonLibrary(), '衰减案三 怎么做', { edges: store.lessonEdges() }).some((x) => x.id === l.id),
    'system 边在的时候打分直接排除，手动改成 active 也没用',
  );

  // 解除降级：删 system 边（store 里连败计数同步清零）
  const ok = store.removeLessonEdge({ from: 'system', to: l.id, type: 'contradicts' });
  assert.ok(ok.ok, ok.error);
  assert.equal(store.lessonLibrary().find((x) => x.id === l.id).byFamily.glm.streak, undefined, '人工恢复要清零连败');
  assert.ok(!store.updateLesson(l.id, { status: 'active' }).error, '解除之后可以正常启用');
  const after = pick(store.lessonLibrary(), '衰减案三 怎么做', { edges: store.lessonEdges() });
  assert.ok(after.some((x) => x.id === l.id), '解除后真的能再次注入');

  // 清零后只败一次不该立刻又被打回去
  const r = store.recordLessonOutcomes([{ id: l.id, verdict: 'hurt', modelFamily: 'glm' }]);
  assert.deepEqual(r.decayed, []);
});

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 上可能还有句柄，忽略
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
