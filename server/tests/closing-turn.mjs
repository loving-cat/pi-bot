/**
 * 群聊收尾轮（closing turn）测试。
 *
 * 背景：同一波成员是并发跑完的，"谁的回复落地得晚"取决于模型速度，
 * 于是老大的结论经常夹在中间，后面还挂着几份作业；maxRuns 一用完更没人收口。
 * 修法是跑完主循环后判断一次：老大之后还有没有成员说话，有就叫它回来收尾。
 *
 * 判定用的是**消息位置**（序号）而不是"取最近 N 条"——
 * 窗口型判定在长回合里会漏判（超过窗口条数）或误判（带进上一轮的消息），
 * 下面专门有用例守着这两种情况。
 */
import assert from 'node:assert/strict';
import { planClosing, shouldStopRound } from '../src/group-round.js';

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
  // 0 用户、1 成员、2 老大
  const r = planClosing({ roundStartIndex: 0, lastLeadIndex: 2, lastMemberIndex: 2 });
  assert.equal(r.needed, false);
  assert.match(r.why, /收口/);
});

test('老大说完之后还有成员交作业 → 需要收尾', () => {
  const r = planClosing({ roundStartIndex: 0, lastLeadIndex: 1, lastMemberIndex: 5 });
  assert.equal(r.needed, true);
  assert.match(r.why, /汇总收口/);
});

test('老大这一轮没发过言 → 不触发收尾', () => {
  const r = planClosing({ roundStartIndex: 3, lastLeadIndex: 2, lastMemberIndex: 5 });
  assert.equal(r.needed, false);
  assert.match(r.why, /还没发过言/);
});

test('老大从没发过言（-1）→ 不触发', () => {
  const r = planClosing({ roundStartIndex: 0, lastLeadIndex: -1, lastMemberIndex: 5 });
  assert.equal(r.needed, false);
});

test('一轮产出很多条（超过旧的 50 条窗口）也不能漏判', () => {
  // 老大在第 10 条说的，成员一路说到第 80 条 —— 用窗口取最近 50 条会看不到老大
  const r = planClosing({ roundStartIndex: 0, lastLeadIndex: 10, lastMemberIndex: 80 });
  assert.equal(r.needed, true, '长回合必须仍能判定出要收尾');
});

test('上一轮老大说过、本轮只有成员说话 → 不误判', () => {
  // 上一轮老大在位置 5 收口；本轮从位置 6 开始，只有成员说到 9
  const r = planClosing({ roundStartIndex: 6, lastLeadIndex: 5, lastMemberIndex: 9 });
  assert.equal(r.needed, false, '上一轮的老大发言不该触发本轮的收尾');
});

test('空房间（位置都是 -1）→ 不触发', () => {
  const r = planClosing({ roundStartIndex: -1, lastLeadIndex: -1, lastMemberIndex: -1 });
  assert.equal(r.needed, false);
});

test('老大和成员都没说话 → 不触发', () => {
  const r = planClosing({ roundStartIndex: 0, lastLeadIndex: -1, lastMemberIndex: -1 });
  assert.equal(r.needed, false);
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
  const r = shouldStopRound({
    queueLen: 1,
    runs: 10,
    maxRuns: 10,
    closing: true,
    aborting: true,
  });
  assert.equal(r.stop, true);
  assert.equal(r.why, '已终止');
});

console.log(`\n收尾轮测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
