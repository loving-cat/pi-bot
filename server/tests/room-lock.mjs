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
  delete PiRunner.prototype.runRound;
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
  delete PiRunner.prototype.runRound;
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
  delete PiRunner.prototype.runRound;
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
  delete PiRunner.prototype.run;
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
