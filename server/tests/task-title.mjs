/**
 * 派活流水 → 任务标题的规范化测试。
 *   node tests/task-title.mjs
 *
 * ## 守什么
 *
 * 任务板上出现过「我是**跨境运营负责人**，这个季度我盯…」这种自我介绍，
 * 和「收到。先看基线和色板…」这种应答 —— 用户说"很多都不像一个任务"。
 * 这里守住两条：
 *   1. 不是派活的话不建任务（自我介绍/招呼/纯应答/短问句）；
 *   2. 真派活时标题压成一句话：去 markdown、只取第一段、截断不切 emoji。
 */
import assert from 'node:assert/strict';

const { isTaskWorthy, normalizeTaskTitle } = await import('../src/task-title.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

test('★ 自我介绍不算任务', () => {
  assert.equal(isTaskWorthy('我是**跨境运营负责人**，这个季度我盯三个市场。'), false);
  assert.equal(isTaskWorthy('你好，我是选品分析师。'), false);
  assert.equal(isTaskWorthy('收到了，我先看基线。'), false);
});

test('★ 纯应答/短问句不算任务', () => {
  assert.equal(isTaskWorthy('收到。'), false);
  assert.equal(isTaskWorthy('好的👌'), false);
  assert.equal(isTaskWorthy('现在进度到多少了？'), false);
});

test('真派活放行（含长文里的问号）', () => {
  assert.equal(isTaskWorthy('把日线数据补齐到最近一个月，产出 data/daily.csv'), true);
  assert.equal(
    isTaskWorthy('核对官方定价页，确认 $0.02 / image 这档是不是简写？顺便记一下页面日期。'),
    true,
  );
});

test('★ 标题去掉 markdown 记号', () => {
  assert.equal(normalizeTaskTitle('**把日线数据补齐**到最近一个月'), '把日线数据补齐到最近一个月');
  assert.equal(normalizeTaskTitle('## 任务：核对定价页'), '任务：核对定价页');
  assert.equal(normalizeTaskTitle('> 引用一句\n真正的内容在第一行'), '引用一句');
});

test('★ 只取第一段/第一行，长文不整段塞进去', () => {
  const text = '把日线数据补齐到最近一个月。\n\n产出 data/daily.csv，字段照旧。';
  assert.equal(normalizeTaskTitle(text), '把日线数据补齐到最近一个月。');
});

test('压掉连续空白与列表符号', () => {
  assert.equal(normalizeTaskTitle('- 跑一遍回归  并把失败用例贴出来'), '跑一遍回归 并把失败用例贴出来');
});

test('超长截断且不切 emoji', () => {
  const long = '补齐数据'.repeat(20);
  const out = normalizeTaskTitle(long, { maxChars: 12 });
  assert.equal([...out].length, 13, `实际 ${[...out].length}`);
  assert.ok(out.endsWith('…'));
  const emoji = '🚀'.repeat(30);
  const out2 = normalizeTaskTitle(emoji, { maxChars: 5 });
  assert.equal([...out2].length, 6);
  assert.equal(out2.includes('\uFFFD'), false);
});

test('空输入返回空串，不抛错', () => {
  assert.equal(normalizeTaskTitle(''), '');
  assert.equal(normalizeTaskTitle(null), '');
  assert.equal(normalizeTaskTitle('   \n\n  '), '');
});

console.log(`\n任务标题规范化：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
