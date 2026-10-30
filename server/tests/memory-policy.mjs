/**
 * 记忆摘要自动触发策略。
 *
 * 用户定的规则：
 *   · 首次满 10 轮总结一次
 *   · 之后按"事情重要程度"总结，不是机械每 10 轮
 */
import assert from 'node:assert/strict';
import {
  countTurns, FIRST_SUMMARY_TURNS, importanceOf, importanceScore, shouldAutoSummarize,
} from '../src/memory-policy.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const user = (text) => ({ authorType: 'user', text });
const bot = (text) => ({ authorType: 'bot', text });

test('数轮：用户每发一条算一轮', () => {
  assert.equal(countTurns([user('a'), bot('b'), user('c'), bot('d')]), 2);
  assert.equal(countTurns([]), 0);
});

test('全是 bot 的会话（自动巡检群）也能量出轮数', () => {
  assert.equal(countTurns([bot('a'), bot('b'), bot('c'), bot('d')]), 2);
});

test('★ 首次：没攒够 10 轮不总结', () => {
  const r = shouldAutoSummarize({ summary: null, totalTurns: 9, newMessages: [] });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'first-not-enough');
});

test('★ 首次：满 10 轮就总结', () => {
  const r = shouldAutoSummarize({ summary: null, totalTurns: 10, newMessages: [] });
  assert.equal(r.due, true);
  assert.equal(r.reason, 'first');
});

test('★ 关键内容：命中重要信号立刻总结，不必等满 10 轮', () => {
  const msgs = [
    user('这个口径改成按自然日算，以后都这样'),
    bot('好的，我按新口径重算'),
    user('决定换成 postgres 了'),
  ];
  const { score } = importanceOf(msgs);
  assert.ok(score >= 4, `重要度应够触发，实际 ${score}`);
  const r = shouldAutoSummarize({
    summary: { text: '旧摘要', count: 10, at: 0 },
    totalTurns: 12,
    newMessages: msgs,
    now: 10 * 60 * 1000,
  });
  assert.equal(r.due, true);
  assert.equal(r.reason, 'important');
});

test('★ 琐事：只攒轮数、没有信号，要攒得更久才总结', () => {
  const msgs = [user('好的'), bot('收到'), user('嗯'), bot('好的')];
  const { score } = importanceOf(msgs);
  assert.equal(score, 0, '这些不该算重要内容');

  // 才多了 5 轮：不总结
  const early = shouldAutoSummarize({
    summary: { text: 'x', count: 10, at: 0 },
    totalTurns: 15,
    newMessages: msgs,
    now: 10 * 60 * 1000,
  });
  assert.equal(early.due, false);
});

test('★ 琐事攒太久仍然要总结一次，记忆不能永远停在很久以前', () => {
  const msgs = [user('好的'), bot('收到')];
  const r = shouldAutoSummarize({
    summary: { text: 'x', count: 10, at: 0 },
    totalTurns: 60, // 增量 50 轮，远超 stale 门槛
    newMessages: msgs,
    now: 60 * 60 * 1000,
  });
  assert.equal(r.due, true);
  assert.equal(r.reason, 'stale');
});

test('★ 冷却：刚总结过不重复调用模型', () => {
  const now = 1_000_000;
  const r = shouldAutoSummarize({
    summary: { text: 'x', count: 10, at: now - 30_000 }, // 30 秒前
    totalTurns: 30,
    newMessages: [user('决定换成 redis')],
    now,
    minIntervalMs: 3 * 60 * 1000,
  });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'cooldown');
});

test('重要度：用户说的话权重高于 bot', () => {
  const u = importanceScore(user('决定改成 X'));
  const b = importanceScore(bot('决定改成 X'));
  assert.ok(u > b, `用户 ${u} 应高于 bot ${b}`);
});

test('重要度：纠正/否定算信号（用户纠错最该记住）', () => {
  assert.ok(importanceScore(user('不对，不是这样算的')) > 0);
  assert.ok(importanceScore(user('别这样，不要用那个接口')) > 0);
});

test('重要度：提到具体文件/路径算信号', () => {
  assert.ok(importanceScore(user('看 D:\\data\\report.xlsx')) > 0);
  assert.ok(importanceScore(user('结果在 report.csv 里')) > 0);
});

test('重要度：寒暄和空消息不算', () => {
  assert.equal(importanceScore(user('好的')), 0);
  assert.equal(importanceScore(user('谢谢')), 0);
  assert.equal(importanceScore(user('   ')), 0);
  assert.equal(importanceScore(user('嗯嗯')), 0);
});

test('老记录没有 count 字段时不崩', () => {
  const r = shouldAutoSummarize({
    summary: { text: '旧摘要' },
    totalTurns: 12,
    newMessages: [user('决定换方案')],
    now: Date.now(),
  });
  assert.equal(typeof r.due, 'boolean');
});

test('未完成事项也算信号', () => {
  assert.ok(importanceScore(user('这个还没做完，下一步接着做')) > 0);
});

test('FIRST_SUMMARY_TURNS 是 10（用户明确要求）', () => {
  assert.equal(FIRST_SUMMARY_TURNS, 10);
});

console.log(`\n${passed}/${passed} 通过`);
