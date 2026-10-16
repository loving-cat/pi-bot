/**
 * 房间级锁（群聊轮次串行）回归测试。
 *   node tests/room-lock.mjs
 *
 * 验的是：同一部门里用户快速连发两条消息时，
 *   ① 绝不同时跑两个 runRound（并发 = 1）；
 *   ② 第二条不丢 —— 它排在当前这轮之后，作为下一轮的首发提示跑掉，
 *      用户消息两条都在库里。
 * 不依赖网络和模型：runRound / run 被替换成计数桩函数。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_room_lock');
// 等忙成员的时长压到 300ms（不然这条测试要等两分钟）
process.env.PI_BOT_GROUP_BUSY_WAIT_MS = '300';
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★ 用例会临时替换 PiRunner 的方法来打桩。以前用 `delete` 收尾 ——
//   那是把**类原型上的方法整个删掉**，后面的用例就再也调不到了
//   （表现为 "runner.runRound is not a function"）。留一份原件，用完还原。
const ORIGINAL_RUN_ROUND = PiRunner.prototype.runRound;
const ORIGINAL_RUN = PiRunner.prototype.run;

function makeDept(tag) {
  const lead = store.createBot({ name: `组长${tag}`, persona: '统筹' });
  const member = store.createBot({ name: `成员${tag}`, persona: '干活' });
  const room = store.createGroup({ name: `部门${tag}`, botIds: [lead.id, member.id], leadBotId: lead.id });
  return { room, lead, member };
}

await test('群聊：连发两条 → 串行两轮，不并发、不丢消息', async () => {
  const { room } = makeDept('A');
  const runner = new PiRunner();

  let active = 0;
  let maxActive = 0;
  const openers = [];
  PiRunner.prototype.runRound = async (_roomId, opts = {}) => {
    active++;
    maxActive = Math.max(maxActive, active);
    openers.push(opts.openerText);
    await sleep(250); // 假装在跑模型
    active--;
  };

  await runner.send(room.id, '第一件事');
  await sleep(60);
  await runner.send(room.id, '第二件事');
  await sleep(900);

  const users = store.listMessages(room.id).filter((m) => m.authorType === 'user');
  assert.equal(users.length, 2, `两条用户消息都应落库，实际 ${users.length}`);
  assert.equal(maxActive, 1, `同一房间不能并发跑 runRound，实际并发 ${maxActive}`);
  assert.equal(openers.length, 2, `应有第二轮把排队的那条跑掉，实际 ${openers.length} 轮`);
  assert.ok(openers[1].includes('第二件事'), `第二轮的首发提示应带上排队消息，实际：${openers[1]}`);
  PiRunner.prototype.runRound = ORIGINAL_RUN_ROUND;
});

await test('群聊：一轮跑完后锁要释放（第三条消息能正常开新轮）', async () => {
  const { room } = makeDept('B');
  const runner = new PiRunner();

  let rounds = 0;
  PiRunner.prototype.runRound = async () => {
    rounds++;
    await sleep(80);
  };

  await runner.send(room.id, '一');
  await sleep(400);
  await runner.send(room.id, '二');
  await sleep(400);
  assert.equal(rounds, 2, `锁没释放会让后续消息被吞，实际 ${rounds} 轮`);
  assert.equal(runner.roundLocks.size, 0, '锁表应清空');
  PiRunner.prototype.runRound = ORIGINAL_RUN_ROUND;
});

await test('abort：清掉排队中的轮次，不再自己接着跑', async () => {
  const { room } = makeDept('C');
  const runner = new PiRunner();

  const openers = [];
  PiRunner.prototype.runRound = async (_roomId, opts = {}) => {
    openers.push(opts.openerText);
    await sleep(250);
  };

  await runner.send(room.id, '第一件事');
  await sleep(60);
  await runner.send(room.id, '第二件事'); // 进队列
  await runner.abort(room.id); // 用户按了停止
  await sleep(900);

  assert.equal(openers.length, 1, `停止后不该再跑排队的轮次，实际跑了 ${openers.length} 轮`);
  assert.equal(runner.roundQueue.size, 0, '停止时排队表应清空');
  PiRunner.prototype.runRound = ORIGINAL_RUN_ROUND;
});

await test('DM：不进房间锁，行为不变', async () => {
  const bot = store.createBot({ name: '私人助理' });
  const room = store.ensureDm(bot.id);
  const runner = new PiRunner();

  let runs = 0;
  PiRunner.prototype.run = async () => {
    runs++;
    await sleep(50);
    return { ok: true, text: 'ok', ms: 0, messageId: '' };
  };

  await runner.send(room.id, '在吗');
  await sleep(300);
  assert.equal(runs, 1, `DM 应该跑一轮，实际 ${runs}`);
  assert.equal(runner.roundLocks.size, 0, 'DM 不该占用房间锁');
  PiRunner.prototype.run = ORIGINAL_RUN;
});

// ---------------------------------------------------------------------------
// 群调度：成员正忙时怎么办（用户报的"组长 @ 了，却只有一个 bot 动起来"）
// ---------------------------------------------------------------------------
await test('★ 上级 @ 忙碌成员 → 必须打断（steer），不能跳过', async () => {
  const { room, lead, member } = makeDept('D');
  const runner = new PiRunner();

  // 成员正在忙：假 session，记下 steer 收到的内容
  const steered = [];
  runner.sessions.set(`${room.id}:${member.id}`, {
    busy: true,
    bot: member,
    session: { steer: async (t) => { steered.push(t); } },
  });

  PiRunner.prototype.run = async (_roomId, botId) => ({
    ok: true,
    text: botId === lead.id ? `@${member.name} 这单你来做` : '（成员自己跑的）',
    messageId: `stub-${botId}`,
    ms: 1,
  });

  await runner.runRound(room.id, { openerText: '用户派活', openerBotId: null, openerName: '用户' });
  PiRunner.prototype.run = ORIGINAL_RUN;

  assert.equal(steered.length, 1, `★ 上级 @ 它时必须打断它（steer 一次），实际 ${steered.length}`);
  assert.match(steered[0], /叫停/, '打断的话要说清是谁在叫停');
  assert.ok(/报|做到哪/.test(steered[0]), '★ 用户要求：同时上报目前自己的进度');
});

await test('★ 同级 @ 忙碌成员 → 不打断；等不到就上报（不能静默丢掉）', async () => {
  const { room, lead, member } = makeDept('E');
  const mate = store.createBot({ name: '同事E', persona: '干活' });
  store.updateRoom(room.id, { botIds: [lead.id, member.id, mate.id] });
  const runner = new PiRunner();

  const steered = [];
  const followed = [];
  runner.sessions.set(`${room.id}:${member.id}`, {
    busy: true,
    bot: member,
    session: {
      steer: async (t) => { steered.push(t); },
      followUp: async (t) => { followed.push(t); },
    },
  });

  PiRunner.prototype.run = async (_roomId, botId) => ({
    ok: true,
    text: botId === mate.id ? `@${member.name} 帮我看下` : '好',
    messageId: `stub-${botId}`,
    ms: 1,
  });

  const before = store.listMessages(room.id).length;
  // 让**同事**当首发（@ 它就轮到它），再由它去 @ 那个忙着的成员 —— 同级场景
  await runner.runRound(room.id, {
    openerText: `@${mate.name} 你派个活`,
    openerBotId: null,
    openerName: '用户',
  });
  PiRunner.prototype.run = ORIGINAL_RUN;

  assert.equal(steered.length, 0, '同级不该打断（否则群里会互相掐断）');
  // 学 ds-bot：忙就不等，把话投进它的 inbox（说好"忙完再看"）
  assert.equal(followed.length, 1, `★ 忙成员的对话必须被投递，实际 ${followed.length}`);
  assert.match(followed[0], /找你/, '投递的话要说清是谁找它');
  const added = store.listMessages(room.id).slice(before);
  assert.ok(
    added.some((m) => /待办|忙完/.test(String(m.text ?? ''))),
    `★ 必须留痕（让用户看得见这条被投递了）。实际新增：${added.map((m) => (m.text ?? '').slice(0, 16)).join(' | ')}`,
  );
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed++;
    console.log(`  ✗ ${r.name}\n      ${r.err}`);
  }
}
console.log(`\n房间锁测试：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
