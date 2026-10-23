/**
 * 群聊游标与私信边界的回归测试（复审 P1-2 / P1-3）。
 *   node tests/group-cursor.mjs
 *
 * 游标 = 每个 bot 在群里「看到哪条了」。transcriptFor 只把游标之后的消息补进提示词，
 * 所以游标推错了，bot 要么漏看派给它的活，要么把旧消息当新任务重读一遍。
 *
 *   ① 被 @ 了、但被本轮预算挡住没跑成的人：游标不能越过派给它的那条消息；
 *   ② 删掉一条消息（[PASS] 占位）时，指向它的游标要退回上一条，
 *      否则游标悬空，transcriptFor 找不到就从头读；
 *   ③ 群里不能用 message_bot 私信同部门同事派活（用户看不见谁领了什么活），
 *      跨部门找人照常可用。
 *
 * 不依赖网络和模型：PiRunner.prototype.run 换成桩函数。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_group_cursor');
process.env.PI_BOT_GROUP_BUSY_WAIT_MS = '300';
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { transcriptFor } = await import('../src/group-prompt.js');
const { buildCommonTools } = await import('../src/tools.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const ORIGINAL_RUN = PiRunner.prototype.run;

/** 桩：像真的 run() 一样在群里写一条已完成的消息，返回它的 id */
function stubRun(textFor) {
  return async (roomId, botId) => {
    const bot = store.getBot(botId);
    const text = textFor(botId);
    const msg = store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: botId,
      authorName: bot?.name ?? botId,
      text,
      status: 'done',
    });
    return { ok: true, text, messageId: msg.id, ms: 1 };
  };
}

await test('① 被 @ 但被本轮预算挡住的人：游标不越过派给它的活', async () => {
  const lead = store.createBot({ name: '组长甲', persona: '统筹' });
  const a = store.createBot({ name: '成员A', persona: '干活' });
  const b = store.createBot({ name: '成员B', persona: '干活' });
  const room = store.createGroup({ name: '游标部门', botIds: [lead.id, a.id, b.id], leadBotId: lead.id });
  const saved = store.groupLimits();
  // 一条用户消息只许跑 1 次：组长跑完，被 @ 的 A、B 都轮不到
  store.updateGroupLimits({ maxRuns: 1 });
  PiRunner.prototype.run = stubRun((id) => (id === lead.id ? `@${a.name} 你做第一件 @${b.name} 你做第二件` : '收到'));
  try {
    store.appendMessage({ roomId: room.id, authorType: 'user', text: '把这两件事做了' });
    const runner = new PiRunner();
    await runner.runRound(room.id, { openerText: '把这两件事做了', openerBotId: null, openerName: '用户' });
  } finally {
    PiRunner.prototype.run = ORIGINAL_RUN;
    store.updateGroupLimits(saved);
  }
  const assignment = store.listMessages(room.id).find((m) => m.authorId === lead.id);
  assert.ok(assignment, '组长应该发出了派活消息');
  for (const m of [a, b]) {
    const fresh = transcriptFor(room.id, m.id);
    assert.ok(
      fresh.some((x) => x.id === assignment.id),
      `${m.name} 下次被叫时必须还看得到派给它的活（游标被推过去了）`,
    );
  }
});

await test('① 对照：没被 @ 的旁观者照旧推进游标（不倒旧账）', async () => {
  const lead = store.createBot({ name: '组长乙', persona: '统筹' });
  const a = store.createBot({ name: '成员C', persona: '干活' });
  const idle = store.createBot({ name: '旁观者', persona: '闲着' });
  const room = store.createGroup({ name: '旁观部门', botIds: [lead.id, a.id, idle.id], leadBotId: lead.id });
  PiRunner.prototype.run = stubRun((id) => (id === lead.id ? `@${a.name} 这单你来` : '做完了'));
  try {
    store.appendMessage({ roomId: room.id, authorType: 'user', text: '派个活' });
    await new PiRunner().runRound(room.id, { openerText: '派个活', openerBotId: null, openerName: '用户' });
  } finally {
    PiRunner.prototype.run = ORIGINAL_RUN;
  }
  const last = store.listMessages(room.id).at(-1);
  assert.equal(store.seenCursor(room.id, idle.id), last.id, '没参与的人：游标推到最后一条');
});

await test('② 删掉游标指着的那条消息：游标退回上一条，不悬空', () => {
  const x = store.createBot({ name: '看客', persona: '看' });
  const room = store.createGroup({ name: '删除部门', botIds: [x.id] });
  const m1 = store.appendMessage({ roomId: room.id, authorType: 'user', text: '第一条', status: 'done' });
  const m2 = store.appendMessage({ roomId: room.id, authorType: 'user', text: '第二条', status: 'done' });
  const pass = store.appendMessage({ roomId: room.id, authorType: 'bot', authorId: 'other', authorName: '别人', text: '[PASS]', status: 'done' });
  store.setCursor(room.id, x.id, pass.id);
  store.deleteMessage(room.id, pass.id);
  assert.equal(store.seenCursor(room.id, x.id), m2.id, '游标应退回到被删消息的前一条');
  const fresh = transcriptFor(room.id, x.id);
  assert.equal(fresh.length, 0, `不该把已经看过的旧消息重读一遍（实际 ${fresh.length} 条）`);
  void m1;
});

await test('② 删掉的是第一条消息：游标清空（从头读是对的，前面没有别的了）', () => {
  const x = store.createBot({ name: '看客2', persona: '看' });
  const room = store.createGroup({ name: '删除部门2', botIds: [x.id] });
  const only = store.appendMessage({ roomId: room.id, authorType: 'bot', authorId: 'other', authorName: '别人', text: '[PASS]', status: 'done' });
  store.setCursor(room.id, x.id, only.id);
  store.deleteMessage(room.id, only.id);
  assert.equal(store.seenCursor(room.id, x.id), null);
});

await test('② 删别的消息不动游标', () => {
  const x = store.createBot({ name: '看客3', persona: '看' });
  const room = store.createGroup({ name: '删除部门3', botIds: [x.id] });
  const m1 = store.appendMessage({ roomId: room.id, authorType: 'user', text: '一', status: 'done' });
  const m2 = store.appendMessage({ roomId: room.id, authorType: 'user', text: '二', status: 'done' });
  store.setCursor(room.id, x.id, m1.id);
  store.deleteMessage(room.id, m2.id);
  assert.equal(store.seenCursor(room.id, x.id), m1.id);
});

// ---------------------------------------------------------------------------
// ③ message_bot 的边界
// ---------------------------------------------------------------------------
function messageBotTool({ roomId, botId, runner }) {
  return buildCommonTools({ runner, roomId, botId }).find((t) => t.name === 'message_bot');
}

await test('③ 群里私信同部门同事：拒绝，并提示用 @', async () => {
  const lead = store.createBot({ name: '组长丙', persona: '统筹' });
  const mate = store.createBot({ name: '成员D', persona: '干活' });
  const room = store.createGroup({ name: '私信部门', botIds: [lead.id, mate.id], leadBotId: lead.id });
  let ran = 0;
  const runner = { runBotOnce: async () => { ran++; return { ok: true, text: 'ok', ms: 1 }; }, isBusy: () => false };
  const res = await messageBotTool({ roomId: room.id, botId: lead.id, runner }).execute('c1', {
    botId: mate.id,
    task: '做第一件事，交回结果，跑通 node tests/unit.mjs',
  });
  assert.equal(res.isError, true, '同部门私信派活应被拒绝');
  assert.match(res.content.map((c) => c.text).join(''), /@/, '要告诉它改用 @');
  assert.equal(ran, 0, '被拒绝时不能真的去跑对方');
});

await test('③ 群里私信别的部门的人：照常可用（跨部门找人）', async () => {
  const lead = store.createBot({ name: '组长丁', persona: '统筹' });
  const mate = store.createBot({ name: '成员E', persona: '干活' });
  const outsider = store.createBot({ name: '外部门专家', persona: '专家' });
  const room = store.createGroup({ name: '跨部门', botIds: [lead.id, mate.id], leadBotId: lead.id });
  let ran = 0;
  const runner = { runBotOnce: async () => { ran++; return { ok: true, text: '查到了', ms: 1 }; }, isBusy: () => false };
  const res = await messageBotTool({ roomId: room.id, botId: lead.id, runner }).execute('c2', {
    botId: outsider.id,
    task: '帮我查一下接口口径，交回字段说明',
  });
  assert.ok(!res.isError, `跨部门私信不该被拒：${res.content?.map((c) => c.text).join('')}`);
  assert.equal(ran, 1);
});

await test('③ 私聊里私信任何人：照常可用', async () => {
  const me = store.createBot({ name: '私聊者', persona: 'x' });
  const other = store.createBot({ name: '被找的人', persona: 'y' });
  const dm = store.ensureDm(me.id);
  let ran = 0;
  const runner = { runBotOnce: async () => { ran++; return { ok: true, text: '好', ms: 1 }; }, isBusy: () => false };
  const res = await messageBotTool({ roomId: dm.id, botId: me.id, runner }).execute('c3', {
    botId: other.id,
    task: '帮个忙，交回一句话结论',
  });
  assert.ok(!res.isError);
  assert.equal(ran, 1);
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed++;
    console.log(`  ✗ ${r.name}\n      ${r.err}`);
  }
}
console.log(`\n群聊游标与私信边界：${results.length - failed}/${results.length} 通过`);
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
