/** 群调度回执接线：验证来源、调度关联与完成结果。
 *
 * 注意："接到活"回执已删除，每个成员每次调度只留一条完成回执。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-progress-flow-'));
process.env.PI_BOT_HOME = dataDir;
process.env.PI_AGENT_DIR = path.join(dataDir, 'agent');
process.env.PI_BOT_WORKSPACE = path.join(dataDir, 'workspace');
const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

function department(tag, count = 1) {
  const lead = store.createBot({ name: `负责人${tag}` });
  const workers = Array.from({ length: count }, (_, i) => store.createBot({ name: `成员${tag}${i}` }));
  const room = store.createGroup({ name: `部门${tag}`, botIds: [lead.id, ...workers.map((b) => b.id)], leadBotId: lead.id });
  return { room, lead, workers };
}

function appendReply(room, bot, text, ok = true) {
  const msg = store.appendMessage({
    roomId: room.id, authorType: 'bot', authorId: bot.id, authorName: bot.name,
    text, status: ok ? 'done' : 'error',
  });
  return { ok, text, messageId: msg.id, error: ok ? undefined : 'fixture unauthorized', ms: 1 };
}

function receipts(bot) {
  const dm = store.findDm(bot.id);
  return store.listMessages(dm.id, { limit: 100 }).filter((m) => m.meta?.progress);
}

await test('并行成员共享正确来源消息，各次调度的start/done稳定配对', async () => {
  const { room, lead, workers } = department('关联', 2);
  const runner = new PiRunner();
  runner.reflect = async () => null;
  let sourceId;
  let leadRuns = 0;
  runner.run = async (_roomId, botId) => {
    const bot = store.getBot(botId);
    if (botId === lead.id && leadRuns++ === 0) {
      const result = appendReply(room, bot, workers.map((b) => `@${b.name}`).join(' ') + ' 分别完成任务');
      sourceId = result.messageId;
      store.appendMessage({ roomId: room.id, authorType: 'system', text: '并发状态通知', status: 'done' });
      return result;
    }
    return appendReply(room, bot, '任务结果已生成');
  };
  await runner.runRound(room.id, { openerText: '分别完成两项任务' });
  const dispatches = [];
  for (const worker of workers) {
    const rows = receipts(worker);
    // ★ 现在只有完成回执："接到活"不再占用一条消息。
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.phase, 'done');
    assert.ok(rows[0].meta.dispatchId);
    assert.equal(rows[0].meta.sourceMessageId, sourceId);
    assert.equal(rows[0].meta.fromId, lead.id);
    assert.equal(rows[0].meta.fromName, lead.name);
    assert.equal(rows[0].meta.outcome, 'success');
    // ★ 正文原样，不套「「X」那件事做完了：」
    assert.equal(rows[0].text, '任务结果已生成');
    dispatches.push(rows[0].meta.dispatchId);
  }
  assert.equal(new Set(dispatches).size, workers.length);
});

await test('成员失败的完成回执明确保存failure，保留调度关联', async () => {
  const { room, lead, workers: [worker] } = department('失败');
  const runner = new PiRunner();
  runner.reflect = async () => null;
  runner.escalate = async () => null;
  let leadRuns = 0;
  runner.run = async (_roomId, botId) => {
    const bot = store.getBot(botId);
    if (botId === lead.id) return appendReply(room, bot, leadRuns++ === 0 ? `@${worker.name} 完成任务` : '本轮已结束');
    return appendReply(room, bot, '未完成', false);
  };
  await runner.runRound(room.id, { openerText: '执行任务' });
  const only = receipts(worker);
  // ★ 只剩一条完成回执（失败），不再有 start
  assert.equal(only.length, 1);
  const done = only[0];
  assert.equal(done.meta.phase, 'done');
  assert.equal(done.meta.outcome, 'failure');
  assert.ok(done.meta.dispatchId);
  // 模型这一轮说了「未完成」，就原样发它自己那句 —— 不再拼「没跑通」模板
  assert.equal(done.text, '未完成');
});

await test('带明确起始消息的跨部门派活保留来源ID', async () => {
  const { room, lead } = department('首发');
  const chief = store.createBot({ name: '调度者首发' });
  const opener = store.appendMessage({ roomId: room.id, authorType: 'bot', authorId: chief.id, authorName: chief.name, text: '核对结果', status: 'done' });
  const runner = new PiRunner();
  runner.reflect = async () => null;
  runner.run = async (_roomId, botId) => appendReply(room, store.getBot(botId), '结果已核对');
  await runner.runRound(room.id, { openerText: opener.text, openerBotId: chief.id, openerName: chief.name, openerMessageId: opener.id });
  const rows = receipts(lead);
  assert.equal(rows.length, 1);
  assert.ok(rows.every((m) => m.meta.sourceMessageId === opener.id && m.meta.fromId === chief.id));
});

await test('dispatchToGroup传递刚保存的消息ID，不依赖房间最后一条消息', async () => {
  const { room, lead } = department('入口');
  const runner = new PiRunner();
  let opener;
  runner.runRound = async (_roomId, options) => { opener = options; };
  const result = await runner.dispatchToGroup({ roomId: room.id, text: '分配任务', fromBotId: lead.id });
  assert.equal(opener.openerMessageId, result.messageId);
  assert.equal(store.getMessage(room.id, result.messageId).authorId, lead.id);
});

await test('★ 回复消息带上 re，指出在回应哪条', async () => {
  const { room, lead, workers: [worker] } = department('引用');
  const runner = new PiRunner();
  runner.reflect = async () => null;
  let sourceId = null;
  let leadRuns = 0;
  runner.run = async (_roomId, botId) => {
    const bot = store.getBot(botId);
    if (botId === lead.id && leadRuns++ === 0) {
      const r = appendReply(room, bot, `@${worker.name} 核对一下口径`);
      sourceId = r.messageId;
      return r;
    }
    return appendReply(room, bot, '口径已核对，没有冲突');
  };
  await runner.runRound(room.id, { openerText: '核对口径' });
  // 成员那条回复应当带 re 指向派活消息
  const msgs = store.listMessages(room.id, { limit: 100 });
  const workerReply = msgs.find((m) => m.authorId === worker.id);
  assert.ok(workerReply, '成员应当有一条回复');
  assert.equal(workerReply.meta?.re, sourceId, 're 必须指向派活那条消息');
  assert.equal(workerReply.meta?.reFrom, lead.id, 'reFrom 必须是派活的人');
});

console.log(`\n群调度回执接线：${passed}/${passed + failed} 通过`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
