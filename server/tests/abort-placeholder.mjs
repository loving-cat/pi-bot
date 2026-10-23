/**
 * 复审 P1-5 复核：终止时不能留下永久转圈的空白消息。
 *   node tests/abort-placeholder.mjs
 *
 * 复审时（1.1.0）的问题：run() 先建 streaming 消息和 typing，之后才判断 aborting 并 return，
 * 而 busy=true 在那之后才设 —— 消息永远转圈，看门狗也够不着。
 * 这里用假 session 在三个时间点按终止，检查之后房间里没有 status='streaming' 的消息、
 * 会话 busy 被释放、typing 收掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_abort_placeholder');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { bus } = await import('../src/bus.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const model = { provider: 'fixture', id: 'model-a', contextWindow: 100_000, reasoning: false, input: ['text'] };

function fakeSession({ onPrompt = async () => {}, usagePercent = 10, onCompact = async () => {} } = {}) {
  let listener = () => {};
  let abortedFlag = false;
  return {
    model,
    isCompacting: false,
    getContextUsage: () => ({ percent: usagePercent, tokens: 1, contextWindow: model.contextWindow }),
    subscribe(fn) { listener = fn; return () => {}; },
    dispose() {},
    async abort() { abortedFlag = true; },
    async compact() { await onCompact(); },
    async prompt() {
      await onPrompt();
      listener({
        type: 'message_end',
        message: abortedFlag
          ? { role: 'assistant', stopReason: 'aborted' }
          : { role: 'assistant', content: [{ type: 'text', text: '正常回答' }] },
      });
    },
  };
}

function isolatedRunner() {
  const runner = new PiRunner();
  runner.__buildSession = async () => assert.fail('fixture must not construct a real SDK session');
  runner.model = model;
  runner.modelRuntime = { completeSimple: async () => ({ role: 'assistant', content: [{ type: 'text', text: '' }] }) };
  return runner;
}

function typingTracker(roomId) {
  const state = new Map();
  const onEvent = (e) => { if (e?.t === 'typing' && e.roomId === roomId) state.set(e.botId, e.active); };
  bus.on('event', onEvent);
  return { stop: () => bus.off('event', onEvent), active: () => [...state.values()].some(Boolean) };
}

function assertClean(room, runner, bot, typing) {
  const spinning = store.listMessages(room.id, { limit: 50 }).filter((m) => m.status === 'streaming');
  assert.equal(spinning.length, 0, `终止后还有 ${spinning.length} 条消息在转圈`);
  const entry = runner.sessions.get(`${room.id}:${bot.id}`);
  assert.equal(entry?.busy ?? false, false, '会话 busy 没释放，后面再也派不动它');
  assert.equal(typing.active(), false, 'typing 没收掉，界面会一直显示正在输入');
}

await test('终止发生在 run() 之前：直接返回，不建占位消息', async () => {
  const bot = store.createBot({ name: '终止前', persona: 'x' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false, session: fakeSession() });
  const typing = typingTracker(room.id);
  runner.aborting.add(room.id);
  const before = store.listMessages(room.id).length;
  const res = await runner.run(room.id, bot.id, '干活');
  typing.stop();
  assert.equal(res.ok, false);
  assert.equal(store.listMessages(room.id).length, before, '不该留下任何占位消息');
  assertClean(room, runner, bot, typing);
});

await test('终止发生在主动压缩期间（占位消息还没建）：不留转圈消息', async () => {
  const bot = store.createBot({ name: '压缩中', persona: 'x' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  const typing = typingTracker(room.id);
  runner.sessions.set(`${room.id}:${bot.id}`, {
    bot,
    busy: false,
    session: fakeSession({ usagePercent: 90, onCompact: async () => { await runner.abort(room.id); } }),
  });
  const res = await runner.run(room.id, bot.id, '干活');
  typing.stop();
  assert.equal(res.ok, false, '已经终止，不该当作成功');
  assertClean(room, runner, bot, typing);
});

await test('终止发生在模型回答期间：占位消息标成 aborted', async () => {
  const bot = store.createBot({ name: '回答中', persona: 'x' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  const typing = typingTracker(room.id);
  runner.sessions.set(`${room.id}:${bot.id}`, {
    bot,
    busy: false,
    session: fakeSession({ onPrompt: async () => { await runner.abort(room.id); } }),
  });
  const res = await runner.run(room.id, bot.id, '干活');
  typing.stop();
  assert.equal(res.ok, false);
  const last = store.listMessages(room.id).at(-1);
  assert.equal(last.status, 'aborted', `应标成 aborted，实际 ${last.status}`);
  assertClean(room, runner, bot, typing);
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed++;
    console.log(`  ✗ ${r.name}\n      ${r.err}`);
  }
}
console.log(`\n终止留白复核：${results.length - failed}/${results.length} 通过`);
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
