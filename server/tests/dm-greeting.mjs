/** 新建 bot 之后应当主动来打招呼，而不是等用户点开空白会话。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-greet-'));
process.env.PI_BOT_HOME = dataDir;
process.env.PI_AGENT_DIR = path.join(dataDir, 'agent');
process.env.PI_BOT_WORKSPACE = path.join(dataDir, 'workspace');

const { store } = await import('../src/store.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

await test('★ createBot 会开好私聊会话（开场的前提）', () => {
  const bot = store.createBot({ name: '开场测试员' });
  const dm = store.findDm(bot.id);
  assert.ok(dm, '必须自动建好私聊，否则 greetDm 没有房间可用');
  assert.equal(dm.kind, 'dm');
  assert.equal(store.listMessages(dm.id, { limit: 5 }).length, 0, '刚建时应当为空');
});

await test('★ greetDm 幂等：同一房间只开场一次', async () => {
  // 用户创建后我们主动开场一次；之后用户点开私聊，http 层还会再调一次。
  // 靠 greetedAt + 非空检查挡住，不能重复开场。
  const bot = store.createBot({ name: '幂等测试员' });
  const dm = store.findDm(bot.id);
  assert.ok(dm);

  // 模拟开场已经跑过：打标记 + 写入一条消息
  store.markRoomGreeted(dm.id);
  store.appendMessage({
    roomId: dm.id,
    authorType: 'bot',
    authorId: bot.id,
    authorName: bot.name,
    text: '你好，我是幂等测试员',
    status: 'done',
  });

  const room = store.getRoom(dm.id);
  assert.ok(room.greetedAt, 'greetedAt 必须已置位');
  assert.equal(store.listMessages(dm.id, { limit: 1 }).length, 1, '已经不是空会话');

  // 这两个条件正是 greetDm 里挡重复开场的依据
  const wouldSkip =
    Boolean(room.greetedAt) || store.listMessages(dm.id, { limit: 1 }).length > 0;
  assert.equal(wouldSkip, true, '再次调用必须被挡住');
});

await test('not-empty 与 greetedAt 各自都能挡重复开场', () => {
  const bot = store.createBot({ name: '双保险测试员' });
  const dm = store.findDm(bot.id);

  // 只有 greetedAt，没有消息
  store.markRoomGreeted(dm.id);
  assert.ok(store.getRoom(dm.id).greetedAt);
  assert.equal(store.listMessages(dm.id, { limit: 1 }).length, 0);

  // 另一个：只有消息，没有 greetedAt
  const bot2 = store.createBot({ name: '只有消息的' });
  const dm2 = store.findDm(bot2.id);
  store.appendMessage({
    roomId: dm2.id,
    authorType: 'user',
    authorName: '用户',
    text: '我先说话了',
    status: 'done',
  });
  assert.equal(store.getRoom(dm2.id).greetedAt, undefined);
  assert.equal(store.listMessages(dm2.id, { limit: 1 }).length, 1);
});

console.log(`\n新建 bot 开场：${passed}/${passed + failed} 通过`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
