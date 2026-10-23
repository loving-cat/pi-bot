/**
 * 群聊游标与私信边界的回归测试（复审 P1-1 / P1-2 / P1-3）。
 *   node tests/group-cursor.mjs
 *
 * 游标 = 每个 bot 在群里「看到哪条了」。transcriptFor 只把游标之后的消息补进提示词，
 * 所以游标推错了，bot 要么漏看派给它的活，要么把旧消息当新任务重读一遍。
 *
 *   ① 被 @ 了、但被本轮预算挡住没跑成的人：游标不能越过派给它的那条消息；
 *   ② 删掉一条消息（[PASS] 占位）时，指向它的游标要退回上一条，
 *      否则游标悬空，transcriptFor 找不到就从头读；
 *   ③ 群里不能用 message_bot 私信同部门同事派活（用户看不见谁领了什么活），
 *      跨部门找人照常可用；
 *   ④ 补给成员的记录里，派给它的活、用户和上级的话不截断、不被后来的讨论挤掉；
 *      同事之间的长结论仍保头尾截断。
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

await test('★ ③ 群里私信同部门同事：拒绝，并提示用 @', async () => {
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

// ---------------------------------------------------------------------------
// ④ 复审 P1-1：补给成员的群记录里，派给它的活不能被截断、不能被挤掉
// ---------------------------------------------------------------------------
const { composeGroupPrompt } = await import('../src/group-prompt.js');

function dept(tag) {
  const lead = store.createBot({ name: `老大${tag}`, persona: '统筹' });
  const a = store.createBot({ name: `算法${tag}`, persona: '干活' });
  const b = store.createBot({ name: `前端${tag}`, persona: '干活' });
  const room = store.createGroup({ name: `记录部门${tag}`, botIds: [lead.id, a.id, b.id], leadBotId: lead.id });
  const say = (bot, text) => store.appendMessage({
    roomId: room.id, authorType: 'bot', authorId: bot.id, authorName: bot.name, text, status: 'done',
  });
  return { room, lead, a, b, say, members: [lead, a, b] };
}

await test('④ 2500 字的派活原文照给，@ 在第 2000 字之后也不丢', () => {
  const { room, lead, a, b, say, members } = dept('A');
  // 复审实测的形态：长派活，要叫的人的 @ 落在 1600 字之后
  const head = '第一部分需求说明。'.repeat(200).slice(0, 2000);
  const order = `${head}\n@${a.name} 你负责模型：做什么 / 交回什么 / 验收标准写在这里。约束：不许改公共接口。`;
  const m = say(lead, order);
  const fresh = transcriptFor(room.id, a.id);
  const got = fresh.find((x) => x.id === m.id);
  assert.ok(got, '派活必须在记录里');
  const prompt = composeGroupPrompt(room, a, fresh, { isLead: false, members, leadId: lead.id });
  assert.ok(prompt.includes('约束：不许改公共接口'), '派活的约束在最后，不能被截掉');
  assert.ok(prompt.includes(head), '派活正文要完整，一个字都不能少');
  assert.ok(!/此处省略/.test(prompt), '派给它的活不该出现「此处省略」');
  void b;
});

await test('④ 同事之间的长结论仍然保头尾截断（不撑爆上下文）', () => {
  const { room, lead, a, b, say, members } = dept('B');
  say(b, `前端的调研报告开头${'中间细节'.repeat(800)}结论：用方案 B`);
  const fresh = transcriptFor(room.id, a.id);
  const prompt = composeGroupPrompt(room, a, fresh, { isLead: false, members, leadId: lead.id });
  assert.match(prompt, /此处省略 \d+ 字/, '同事的长报告要截');
  assert.ok(prompt.includes('结论：用方案 B'), '截的时候结尾必须留着');
  assert.ok(prompt.length < 6000, `同事 4000 字的报告不该原样塞进来（实际 ${prompt.length}）`);
});

await test('④ 派活之后同事们刷了一大堆，派活和用户的话仍然都在', () => {
  const { room, lead, a, b, say, members } = dept('C');
  const userMsg = store.appendMessage({ roomId: room.id, authorType: 'user', text: '用户：本周五前交，预算不超过两万', status: 'done' });
  const order = say(lead, `@${a.name} 你负责模型部分，交回评估报告`);
  // 之后前端刷了 12 条长消息：按展示长度也有 12 × 1600 字，远超 12000 字的预算
  for (let i = 0; i < 12; i++) say(b, `前端自语${i}：${'一些实现细节'.repeat(400)}`);
  const fresh = transcriptFor(room.id, a.id);
  assert.ok(fresh.some((x) => x.id === order.id), '派给它的活被后来的讨论挤掉了');
  assert.ok(fresh.some((x) => x.id === userMsg.id), '用户的要求被后来的讨论挤掉了');
  assert.ok(fresh.droppedCount > 0, '确实超预算了，应该丢掉一些同事的旧消息');
  const prompt = composeGroupPrompt(room, a, fresh, { isLead: false, members, leadId: lead.id });
  assert.match(prompt, /中间省略 \d+ 条/, '中间跳过的要说出来，别让模型以为记录是连续的');
  assert.ok(prompt.length < 24000, `整体仍要收口（实际 ${prompt.length}）`);
});

await test('④ 别人被 @ 的活不算「派给我的」：照常可以截', () => {
  const { room, a, b, say, members, lead } = dept('D');
  // 成员 A 叫前端干活（同级，不是老大），前端以外的人读它时可以截
  const longToB = `@${b.name} ${'细节'.repeat(1500)}结尾`;
  say(a, longToB);
  const forLead = transcriptFor(room.id, lead.id);
  const prompt = composeGroupPrompt(room, lead, forLead, { isLead: true, members, leadId: lead.id });
  assert.match(prompt, /此处省略/, '不是给老大的，老大读到的可以截');
  const forB = transcriptFor(room.id, b.id);
  const promptB = composeGroupPrompt(room, b, forB, { isLead: false, members, leadId: lead.id });
  assert.ok(promptB.includes(longToB), '被 @ 的那个人必须看到原文');
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
