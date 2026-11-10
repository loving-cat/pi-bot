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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 需要一个真实 store 来验证「按 id 比较先后」那段 ——
// planClosing 本身是纯函数，但 isStrictlyAfter 要读房间消息。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-closing-'));
process.env.PI_BOT_HOME = dataDir;
process.env.PI_AGENT_DIR = path.join(dataDir, 'agent');
process.env.PI_BOT_WORKSPACE = path.join(dataDir, 'workspace');
const { store } = await import('../src/store.js');
const { planClosing, shouldStopRound } = await import('../src/group-round.js');
const { isStrictlyAfter, lastDoneIdOf, lastMessageId } =
  await import('../src/group-prompt.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

test('老大最后说话 → 不用收尾', () => {
  // 0 用户、1 成员、2 老大
  const r = planClosing({ leadSpokeThisRound: true, memberSpokeAfterLead: false });
  assert.equal(r.needed, false);
  assert.match(r.why, /收口/);
});

test('老大说完之后还有成员交作业 → 需要收尾', () => {
  const r = planClosing({ leadSpokeThisRound: true, memberSpokeAfterLead: true });
  assert.equal(r.needed, true);
  assert.match(r.why, /汇总收口/);
});

test('老大这一轮没发过言 → 不触发收尾', () => {
  const r = planClosing({ leadSpokeThisRound: false, memberSpokeAfterLead: true });
  assert.equal(r.needed, false);
  assert.match(r.why, /还没发过言/);
});

test('老大从没发过言（-1）→ 不触发', () => {
  const r = planClosing({ leadSpokeThisRound: false, memberSpokeAfterLead: true });
  assert.equal(r.needed, false);
});

test('一轮产出很多条（超过旧的 50 条窗口）也不能漏判', () => {
  // 老大在第 10 条说的，成员一路说到第 80 条 —— 用窗口取最近 50 条会看不到老大
  const r = planClosing({ leadSpokeThisRound: true, memberSpokeAfterLead: true });
  assert.equal(r.needed, true, '长回合必须仍能判定出要收尾');
});

test('上一轮老大说过、本轮只有成员说话 → 不误判', () => {
  // 上一轮老大在位置 5 收口；本轮从位置 6 开始，只有成员说到 9
  const r = planClosing({ leadSpokeThisRound: false, memberSpokeAfterLead: true });
  assert.equal(r.needed, false, '上一轮的老大发言不该触发本轮的收尾');
});

test('空房间（位置都是 -1）→ 不触发', () => {
  const r = planClosing({ leadSpokeThisRound: false, memberSpokeAfterLead: false });
  assert.equal(r.needed, false);
});

test('老大和成员都没说话 → 不触发', () => {
  const r = planClosing({ leadSpokeThisRound: false, memberSpokeAfterLead: false });
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

// ───────────────────────── 按消息 id 比较先后 ─────────────────────────
//
// 这一段守着 L10 真正修的那个 bug：房间满 maxMessagesPerRoom 后
// store.appendMessage 会从头部裁剪，**数组下标整体前移**，
// 而"本轮起点"是 runRound 的局部变量，不会跟着改 ——
// 满 500 后起点卡在 499，收尾永不触发。
// 改成按消息 id 比较后，裁剪不影响判定。

const room = store.createGroup({ name: '收尾测试群', botIds: [] });
const leadBot = store.createBot({ name: '收尾测试组长' });
const memberA = store.createBot({ name: '收尾测试成员A' });
const memberB = store.createBot({ name: '收尾测试成员B' });

function say(bot, text) {
  return store.appendMessage({
    roomId: room.id, authorType: 'bot', authorId: bot.id,
    authorName: bot.name, text, status: 'done',
  }, { silent: true });
}

await test('★ 老大最后发言：成员集合含老大，不能判成"成员在之后说过话"', () => {
  // 这是评审组抓到的那个 bug：participants 含老大，
  // 老大最后发言时 lastDoneIdOf([lead]) 与 lastDoneIdOf(participants) 是同一条，
  // 用 >= 会返回 true → 已经收口还要再收一轮，白烧一次调用。
  //
  // ★ 用**独立房间**：各测试共享房间会互相污染
  //   （上一个测试刚落下的成员消息会被算进"参与者最后一条"）。
  const isolate = store.createGroup({ name: '老大最后发言', botIds: [] });
  const inRoom = (bot, text) => store.appendMessage({
    roomId: isolate.id, authorType: 'bot', authorId: bot.id,
    authorName: bot.name, text, status: 'done',
  }, { silent: true });

  inRoom(memberA, '我先交');
  const leadMsg = inRoom(leadBot, '我的结论');

  const leadId = lastDoneIdOf(isolate.id, [leadBot.id]);
  const participantsId = lastDoneIdOf(isolate.id, [leadBot.id, memberA.id, memberB.id]);
  assert.equal(leadId, leadMsg.id, '老大最后一条发言应就是刚说的这条');
  assert.equal(participantsId, leadMsg.id, '成员集合的最后一条也应是老大这条');
  assert.equal(
    isStrictlyAfter(isolate.id, leadId, participantsId),
    false,
    '同一条消息不算"之后" → 已经收口，不该再收尾',
  );
});

await test('★ 成员真的在老大之后发言 → 需要收尾', () => {
  say(leadBot, '老大说完');
  const leadId = lastDoneIdOf(room.id, [leadBot.id]);
  say(memberB, '我又补了一条');
  const participantsId = lastDoneIdOf(room.id, [leadBot.id, memberA.id, memberB.id]);
  assert.equal(isStrictlyAfter(room.id, leadId, participantsId), true);
});

await test('★ 老大本轮没发言（发言都在开轮之前）→ 不该触发', () => {
  const startId = lastMessageId(room.id);
  const leadId = lastDoneIdOf(room.id, [leadBot.id]);
  assert.equal(
    isStrictlyAfter(room.id, startId, leadId),
    false,
    '老大的发言在开轮之前，本轮没说过话',
  );
});

await test('★ 裁剪之后判定仍然正确（下标会错位，id 不会）', () => {
  const smallRoom = store.createGroup({ name: '裁剪测试群', botIds: [] });
  const cap = 500;
  for (let i = 0; i < cap + 40; i++) {
    store.appendMessage({
      roomId: smallRoom.id, authorType: 'bot', authorId: leadBot.id,
      authorName: leadBot.name, text: '填充' + i, status: 'done',
    }, { silent: true });
  }
  const after = store.messages.get(smallRoom.id).length;
  assert.ok(after <= cap, '房间应被裁剪到上限内，实际 ' + after);

  const leadMsg = store.appendMessage({
    roomId: smallRoom.id, authorType: 'bot', authorId: leadBot.id,
    authorName: leadBot.name, text: '结论', status: 'done',
  }, { silent: true });
  const startId = leadMsg.id;
  store.appendMessage({
    roomId: smallRoom.id, authorType: 'bot', authorId: memberA.id,
    authorName: memberA.name, text: '补充', status: 'done',
  }, { silent: true });

  // ★ 开轮时最后一条就是老大这条结论 → 严格比较应为 false（相等不算本轮发言）。
  //   这正是上一处 bug 的形态：>= 会判成"本轮已发言"。
  assert.equal(
    isStrictlyAfter(smallRoom.id, startId, lastDoneIdOf(smallRoom.id, [leadBot.id])),
    false,
    '开轮时最后一条就是老大说的 → 相等不算本轮发言',
  );
  // 成员在老大之后发过言（此刻成员那条是最新的）
  assert.equal(
    isStrictlyAfter(
      smallRoom.id,
      lastDoneIdOf(smallRoom.id, [leadBot.id]),
      lastDoneIdOf(smallRoom.id, [leadBot.id, memberA.id]),
    ),
    true,
    '成员在老大之后发过言 —— 裁剪不该影响这个判定',
  );

  // 老大在开轮之后又说了一条 → leadSpokeThisRound 应为 true
  const laterLead = store.appendMessage({
    roomId: smallRoom.id, authorType: 'bot', authorId: leadBot.id,
    authorName: leadBot.name, text: '补充结论', status: 'done',
  }, { silent: true });
  assert.equal(
    isStrictlyAfter(smallRoom.id, startId, laterLead.id),
    true,
    '老大在开轮之后又说了 → 本轮已发言',
  );
});

await test('找不到消息时按"不确定"处理，不瞎判', () => {
  assert.equal(isStrictlyAfter(room.id, 'msg_not_exist', 'msg_nope'), false);
  assert.equal(isStrictlyAfter(room.id, lastDoneIdOf(room.id, [leadBot.id]), 'msg_nope'), false);
});

await test('★ 开轮时最后一条正好是老大上次收口 → leadSpokeThisRound 必须为 false', () => {
  // 这是评审组抓的第二处：roundStartMsgId 取的是开轮时的最后一条，
  // 如果那条正好是老大上次收口说的，两个 id **相同**。
  // 用 >=（isAfterOrSame）会判成"老大本轮已发言"，
  // 于是 memberSpokeAfterLead 一旦成立，它就被叫回来做一次
  // 没有新内容的收尾 —— 白烧一轮调用。
  //
  // 原来 planClosing 的口径是 lastLeadIndex > roundStartIndex：相等不算。
  const isolate = store.createGroup({ name: '开轮即老大收口', botIds: [] });
  const inRoom = (bot, text) => store.appendMessage({
    roomId: isolate.id, authorType: 'bot', authorId: bot.id,
    authorName: bot.name, text, status: 'done',
  }, { silent: true });

  inRoom(memberA, '我先交');
  const leadSaid = inRoom(leadBot, '上次的收口结论');
  // 开轮：此刻最后一条就是老大这条
  const roundStartMsgId = lastMessageId(isolate.id);
  assert.equal(roundStartMsgId, leadSaid.id, '开轮时最后一条应是老大那条');

  // 老大本轮的发言位置 = 同一条 → 严格比较为 false
  assert.equal(
    isStrictlyAfter(isolate.id, roundStartMsgId, lastDoneIdOf(isolate.id, [leadBot.id])),
    false,
    '相等不算本轮发言',
  );

  // 成员也没再加话 → 整条链上都不该收尾
  const closing = planClosing({
    leadSpokeThisRound: isStrictlyAfter(
      isolate.id, roundStartMsgId, lastDoneIdOf(isolate.id, [leadBot.id]),
    ),
    memberSpokeAfterLead: isStrictlyAfter(
      isolate.id,
      lastDoneIdOf(isolate.id, [leadBot.id]),
      lastDoneIdOf(isolate.id, [leadBot.id, memberA.id, memberB.id]),
    ),
  });
  assert.equal(closing.needed, false, '老大上次收口后没人说话，不该再收一轮');
});

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n收尾轮测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
