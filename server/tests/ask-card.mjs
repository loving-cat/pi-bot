/**
 * 「问你」卡片：用户回话后必须收起，不能留着被点第二次。
 *
 * 盯的是这个 bug：卡片是 bot 停下来等回话的地方，用户已经点了/自己说了一句，
 * 事就往下走了 —— 卡片还挂着能再点，用户会怀疑"我刚才到底点上没有"，
 * 误点还会把进程带偏。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-ask-'));

// 隔离环境：不碰真实数据目录，也不许出网
const inherited = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']);
for (const name of Object.keys(process.env)) {
  if (!inherited.has(name)) delete process.env[name];
}
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_DATA_DIR = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { store } = await import('../src/store.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

const bot = store.createBot({ name: '后端工程师', persona: '测试' });
const dm = store.ensureDm(bot.id);
const ROOM = dm.id;

function askCard(text, options = ['A', 'B']) {
  return store.appendMessage({
    roomId: ROOM,
    authorType: 'bot',
    authorId: 'bot-1',
    authorName: '后端工程师',
    kind: 'ask',
    text,
    status: 'done',
    meta: { options: options.map((label) => ({ label, detail: '' })), allowCustom: true },
  });
}

await test('新卡片还没有回答标记', () => {
  const card = askCard('现在想让我做点什么？');
  assert.equal(card.meta.answer, undefined);
  assert.equal(card.kind, 'ask');
});

await test('用户回话后，卡片被标成已答并记住回答内容', () => {
  const card = askCard('要设计接口还是排查问题？');
  const updated = store.answerPendingAsk(ROOM, '设计一个新接口');
  assert.ok(updated, '应该返回被更新的那张卡');
  assert.equal(updated.id, card.id);
  assert.equal(updated.meta.answer, '设计一个新接口');
  assert.ok(updated.meta.answeredAt > 0);
});

await test('只标最新一张：老的卡片不会被后来者覆盖', () => {
  const first = askCard('第一次问');
  store.answerPendingAsk(ROOM, '第一次答');
  const second = askCard('第二次问');
  store.answerPendingAsk(ROOM, '第二次答');

  assert.equal(store.getMessage(ROOM, first.id).meta.answer, '第一次答');
  assert.equal(store.getMessage(ROOM, second.id).meta.answer, '第二次答');
});

await test('已答的卡片不会被再次标记（回答内容不被覆盖）', () => {
  const card = askCard('只问一次');
  store.answerPendingAsk(ROOM, '答一次');
  store.answerPendingAsk(ROOM, '又答一次');
  // 关键在于这张卡的回答不能被后来的调用改掉
  assert.equal(store.getMessage(ROOM, card.id).meta.answer, '答一次');
});

await test('把所有待答卡片答完后，再调返回 null', () => {
  // 用独立房间，避免被上面的用例影响
  const fresh = store.ensureDm(store.createBot({ name: '独立房间', persona: 'x' }).id);
  assert.equal(store.answerPendingAsk(fresh.id, '这房间本来就没卡片'), null);
});

await test('没有待答卡片时返回 null，不炸', () => {
  assert.equal(store.answerPendingAsk(ROOM, '随便说'), null);
});

await test('普通消息不会被误标成已答', () => {
  const normal = store.appendMessage({
    roomId: ROOM,
    authorType: 'bot',
    authorId: 'bot-1',
    authorName: '后端工程师',
    text: '我先说一句',
    status: 'done',
  });
  store.answerPendingAsk(ROOM, '用户回话');
  assert.equal(store.getMessage(ROOM, normal.id).meta?.answer, undefined);
});

await test('回答太长会被截断，不会把存储撑爆', () => {
  const card = askCard('说一句很长的话试试');
  const huge = 'x'.repeat(2000);
  store.answerPendingAsk(ROOM, huge);
  const saved = store.getMessage(ROOM, card.id).meta.answer;
  assert.equal(saved.length, 500);
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
