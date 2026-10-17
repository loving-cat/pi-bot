/**
 * 群聊收尾轮（closing turn）测试。
 *
 * 背景：同一波成员是并发跑完的，"谁的回复落地得晚"取决于模型速度，
 * 于是老大的结论经常夹在中间，后面还挂着几份作业；maxRuns 一用完更没人收口。
 * 修法是跑完主循环后判断一次：老大之后还有没有成员说话，有就叫它回来收尾。
 */
import assert from 'node:assert/strict';
import { planClosing, shouldStopRound } from '../src/group-round.js';

const LEAD = 'b_lead';
const A = 'b_a';
const B = 'b_b';
const USER = { authorType: 'user', authorId: 'u1' };
const bot = (id) => ({ authorType: 'bot', authorId: id });
const members = [LEAD, A, B];

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

test('老大最后说话 → 不用收尾', () => {
  const r = planClosing({ messages: [USER, bot(A), bot(LEAD)], leadId: LEAD, members });
  assert.equal(r.needed, false);
  assert.match(r.why, /收口/);
});

test('老大说完之后还有成员交作业 → 需要收尾', () => {
  const r = planClosing({
    messages: [USER, bot(LEAD), bot(A), bot(B)],
    leadId: LEAD,
    members,
  });
  assert.equal(r.needed, true);
  assert.match(r.why, /2 个人/);
});

test('用户消息排在老大后面不算需要收尾', () => {
  const r = planClosing({
    messages: [bot(LEAD), USER],
    leadId: LEAD,
    members,
  });
  assert.equal(r.needed, false, '用户发言不该触发收尾轮');
});

test('老大还没发过言 → 不触发收尾', () => {
  const r = planClosing({ messages: [USER, bot(A)], leadId: LEAD, members });
  assert.equal(r.needed, false);
  assert.match(r.why, /还没发过言/);
});

test('没有老大 → 不触发', () => {
  const r = planClosing({ messages: [USER, bot(A)], leadId: null, members });
  assert.equal(r.needed, false);
});

test('老大隔了几轮又说话，以最后一次为准', () => {
  // 老大说 → A 说 → 老大又说（总结）→ 没人了
  const messages = [bot(LEAD), bot(A), bot(LEAD)];
  assert.equal(planClosing({ messages, leadId: LEAD, members }).needed, false);

  // 老大的总结之后 B 又交了作业
  assert.equal(
    planClosing({ messages: [...messages, bot(B)], leadId: LEAD, members }).needed,
    true,
  );
});

test('非部门成员发言不算数', () => {
  const r = planClosing({
    messages: [bot(LEAD), bot('b_outsider')],
    leadId: LEAD,
    members,
  });
  assert.equal(r.needed, false, '陌生 bot 不该触发收尾');
});

test('收尾轮不受 maxRuns 截断', () => {
  const capped = shouldStopRound({ queueLen: 2, pendingLen: 0, runs: 10, maxRuns: 10 });
  assert.equal(capped.stop, true, '普通情况到上限要停');

  const closing = shouldStopRound({
    queueLen: 1,
    pendingLen: 0,
    runs: 10,
    maxRuns: 10,
    closing: true,
  });
  assert.equal(closing.stop, false, '收尾轮要放行');
});

test('用户中止时收尾轮也不放行', () => {
  const r = shouldStopRound({ queueLen: 1, runs: 10, maxRuns: 10, closing: true, aborting: true });
  assert.equal(r.stop, true);
  assert.equal(r.why, '已终止');
});

console.log(`\n收尾轮测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
