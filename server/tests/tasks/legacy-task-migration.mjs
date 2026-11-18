/**
 * 旧 TaskItem → 历史打标（W5c）测试。
 *   node tests/legacy-task-migration.mjs
 *
 * ## 守什么
 *
 * 历史里堆着「我是**跨境运营负责人**…」「收到。先看基线…」这类对话片段。
 * 处理方式只能是**打标 + 折叠**，不能删、不能改正文：
 *   1. 只标已完成、无交付物、标题像寒暄或一段话的；
 *   2. 真交付（有 deliverables）、未完成任务一个字都不动；
 *   3. 幂等：跑两次结果一样，已标记的不再改（连时间戳都不动）；
 *   4. 不丢条目：输出条数与输入一致。
 */
import assert from 'node:assert/strict';

const { looksLikeChatFragment, planLegacyNotes, withLegacyNotes } =
  await import('../../src/tasks/legacy-task-migration.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

const tasks = [
  { id: 't1', status: 'done', title: '我是**跨境运营负责人**，这个季度我盯三个市场。' },
  { id: 't2', status: 'done', title: '收到。先看基线和色板…' },
  { id: 't3', status: 'done', title: '把日线数据补齐到最近一个月' },
  { id: 't4', status: 'done', title: '我是谁不重要', deliverables: ['report.md'] },
  { id: 't5', status: 'doing', title: '我是流水线里的自我介绍' },
  { id: 't6', status: 'done', title: '这是一段特别长的说明'.repeat(4) },
];

test('★ 寒暄/自我介绍的已完成条目算对话片段', () => {
  assert.equal(looksLikeChatFragment(tasks[0]), true);
  assert.equal(looksLikeChatFragment(tasks[1]), true);
});

test('★ 真任务、有交付物、未完成：都不算', () => {
  assert.equal(looksLikeChatFragment(tasks[2]), false, '正常任务标题');
  assert.equal(looksLikeChatFragment(tasks[3]), false, '有交付物就不算片段');
  assert.equal(looksLikeChatFragment(tasks[4]), false, '未完成的不动');
});

test('过长标题按“一段话”算片段', () => {
  assert.equal(looksLikeChatFragment(tasks[5]), true);
});

test('★ 打标只覆盖该覆盖的，且不丢条目', () => {
  const ids = planLegacyNotes(tasks);
  assert.deepEqual(ids.sort(), ['t1', 't2', 't6']);
  const out = withLegacyNotes(tasks, ids, { at: 123 });
  assert.equal(out.length, tasks.length, '条数不能变');
  assert.equal(out.find((t) => t.id === 't1').meta.legacyNote, true);
  assert.equal(out.find((t) => t.id === 't3').meta, undefined, '真任务不能被打标');
});

test('★ 幂等：第二次跑不再挑人，已有标记不变', () => {
  const first = withLegacyNotes(tasks, planLegacyNotes(tasks), { at: 100 });
  const ids2 = planLegacyNotes(first);
  assert.deepEqual(ids2, [], '第二次不该再挑出任何条目');
  const second = withLegacyNotes(first, ids2, { at: 999 });
  assert.equal(second.find((t) => t.id === 't1').meta.legacyNotedAt, 100, '已标记的不该被改写');
});

test('不修改入参（纯函数）', () => {
  const input = [{ id: 'x', status: 'done', title: '我是，测试' }];
  const out = withLegacyNotes(input, planLegacyNotes(input), { at: 1 });
  assert.equal(input[0].meta, undefined, '入参不能被改');
  assert.equal(out[0].meta.legacyNote, true);
});

test('空输入安全', () => {
  assert.deepEqual(planLegacyNotes([]), []);
  assert.deepEqual(withLegacyNotes([], ['a']), []);
  assert.equal(looksLikeChatFragment(null), false);
});

console.log(`\n旧任务打标：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
