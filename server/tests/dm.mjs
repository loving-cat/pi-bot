/**
 * 私聊行为测试：开场文案、进度回执、是否需要回执。
 *   node tests/dm.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_dm');
const HOME = process.env.PI_BOT_HOME;
fs.rmSync(HOME, { recursive: true, force: true });

const {
  excerpt,
  dmOpeningPrompt,
  progressStartText,
  progressDoneText,
  shouldMirrorProgress,
  mirrorProgress,
} = await import('../src/dm.js');
const { store } = await import('../src/store.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

await test('excerpt：去 markdown / 压一行 / 超长截断', () => {
  assert.equal(excerpt('# 标题\n\n**加粗**  内容', 40), '标题 加粗 内容');
  assert.equal(excerpt('```js\ncode\n```\n结论', 40), '结论');
  const long = excerpt('a'.repeat(100), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('…'));
});

await test('开场指令：报名字、要求用询问卡片、不许提模型与工具', () => {
  const p = dmOpeningPrompt({ name: '阿瑞尔' });
  assert.match(p, /阿瑞尔/);
  assert.match(p, /ask_user/);
  assert.match(p, /不要提模型/);
  assert.match(p, /不要复述这段说明/);
});

await test('进度回执：带部门名与任务摘要', () => {
  const start = progressStartText({ roomName: '量化算法组', task: '把日线拉全并算因子' });
  assert.match(start, /量化算法组/);
  assert.match(start, /日线/);

  const done = progressDoneText({ roomName: '量化算法组', text: '做完了，输出在 data/x.csv', ok: true });
  assert.match(done, /做完了/);

  const failed = progressDoneText({ roomName: '量化算法组', text: '报错：端口占用', ok: false });
  assert.match(failed, /没跑通/);
});

await test('★ 只在部门里、且是别人派给它的时候回执', () => {
  assert.equal(shouldMirrorProgress({ roomKind: 'group', fromId: 'b_lead', botId: 'b1' }), true);
  assert.equal(shouldMirrorProgress({ roomKind: 'dm', fromId: 'b_lead', botId: 'b1' }), false);
  assert.equal(shouldMirrorProgress({ roomKind: 'group', fromId: null, botId: 'b1' }), false, '用户直接派的不回执');
  assert.equal(shouldMirrorProgress({ roomKind: 'group', fromId: 'b1', botId: 'b1' }), false, '自己派给自己不回执');
});

await test('store.findDm：只查不建；markRoomGreeted 落标记', () => {
  const bot = store.createBot({ name: '私聊测试员', persona: '测试' });
  // 建 bot 时会顺手把它的私聊建好，findDm 应该查到同一个
  const dm = store.findDm(bot.id);
  assert.ok(dm, '建 bot 时已建好私聊');
  assert.equal(dm.kind, 'dm');

  const before = Object.keys(store.state.rooms).length;
  assert.equal(store.findDm('不存在的 bot'), null);
  assert.equal(Object.keys(store.state.rooms).length, before, '查不到时不能新建房间');

  assert.equal(dm.greetedAt, undefined);
  store.markRoomGreeted(dm.id);
  assert.ok(store.getRoom(dm.id).greetedAt > 0);
});

await test('★ mirrorProgress：写进私聊并带上来源，自己房间不写', () => {
  const bot = store.createBot({ name: '回执测试员', persona: '测试' });
  const room = store.createGroup({ name: '回执测试组', botIds: [bot.id] });
  const dm = store.findDm(bot.id);
  const before = store.listMessages(dm.id, { limit: 100 }).length;

  const wrote = mirrorProgress({
    store,
    room,
    bot,
    phase: 'start',
    text: '把日线拉全',
  });
  assert.equal(wrote, true);
  const list = store.listMessages(dm.id, { limit: 100 });
  assert.equal(list.length, before + 1);
  const last = list[list.length - 1];
  assert.equal(last.authorId, bot.id);
  assert.equal(last.meta?.progress, true);
  assert.equal(last.meta?.fromRoomId, room.id);
  assert.match(last.text, /回执测试组/);

  // 同一个房间自己给自己发 → 不写（避免在私聊里自说自话）
  const again = mirrorProgress({ store, room: dm, bot, phase: 'done', text: 'x', ok: true });
  assert.equal(again, false);
});

await test('★ 插话重排：moveMessageAfter 把正在写的回复挪到用户消息后面', () => {
  const room2 = store.createGroup({ name: '重排测试组' });
  const bot2 = store.createBot({ name: '重排员', persona: 'x' });
  // 模拟真实时序：bot 先开始写（streaming），用户后插话
  const botMsg = store.appendMessage({
    roomId: room2.id, authorType: 'bot', authorId: bot2.id,
    authorName: bot2.name, text: '正在回答旧问题…', status: 'streaming',
  });
  const userMsg = store.appendMessage({
    roomId: room2.id, authorType: 'user', authorName: '我',
    text: '等等，改成 Y', status: 'done',
  });
  const before = store.listMessages(room2.id).map((m) => m.id);
  assert.deepEqual(before, [botMsg.id, userMsg.id], '初始顺序：bot 在上、用户在下');

  const moved = store.moveMessageAfter(room2.id, botMsg.id, userMsg.id, { touch: true });
  assert.ok(moved, '要返回挪完的消息');
  const after = store.listMessages(room2.id).map((m) => m.id);
  assert.deepEqual(after, [userMsg.id, botMsg.id], '挪完：用户在上、bot 的回复在下');
  assert.ok(
    moved.createdAt >= userMsg.createdAt,
    `touch 后时间戳不能早于用户消息（bot=${moved.createdAt} user=${userMsg.createdAt}）`,
  );
});

await test('moveMessageAfter：消息不存在 / 房间不存在都安全返回', () => {
  assert.equal(store.moveMessageAfter('no-room', 'x', 'y'), null);
  const room3 = store.createGroup({ name: '重排边界组' });
  assert.equal(store.moveMessageAfter(room3.id, '不存在', null), null);
  // afterId 找不到 → 放到最后（不炸）
  const m1 = store.appendMessage({ roomId: room3.id, authorType: 'user', text: 'a' });
  const m2 = store.appendMessage({ roomId: room3.id, authorType: 'user', text: 'b' });
  const r = store.moveMessageAfter(room3.id, m1.id, '不存在的after');
  assert.ok(r);
  assert.deepEqual(store.listMessages(room3.id).map((m) => m.id), [m2.id, m1.id]);
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 私聊行为测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
