/**
 * 经验库测试。
 *
 * 盯的是"上下文不被撑爆"和"没有证据的经验不许进提示词"这两条：
 *   · 只有 active 参与注入；候选只能在界面上看；
 *   · 一次最多 3 条、总字数不超过 600 —— 库再大注入量也是常数；
 *   · 没有证据（哪次任务、用户原话）不能启用；
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

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 上可能还有句柄，忽略
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
