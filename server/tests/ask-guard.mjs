/**
 * ask_user 的适用范围测试。
 *   node tests/ask-guard.mjs
 *
 * 私聊里可以弹卡片问用户；群聊里不行 —— 群里是派活现场，卡片会让人停下来等，
 * 任务就卡住了。这里验的就是这条边界。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_ask_guard');
const HOME = process.env.PI_BOT_HOME;
fs.rmSync(HOME, { recursive: true, force: true });

const { store } = await import('../src/store.js');
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

const bot = store.createBot({ name: '测试员', persona: '测试' });
const askTool = (roomId) =>
  buildCommonTools({ runner: {}, roomId, botId: bot.id }).find((t) => t.name === 'ask_user');

await test('私聊：卡片正常发出（kind=ask）', async () => {
  const dm = store.ensureDm(bot.id);
  const tool = askTool(dm.id);
  const res = await tool.execute('c1', {
    question: '想先做哪件事？',
    options: [{ label: 'A' }, { label: 'B' }],
  });
  assert.ok(!res.isError, '私聊里不该报错');
  const list = store.listMessages(dm.id, { limit: 10 });
  const card = list.find((m) => m.kind === 'ask');
  assert.ok(card, '应该写出一条 ask 卡片');
  assert.equal(card.meta.options.length, 2);
});

await test('★ 群聊：拒绝弹卡片，并提示继续执行', async () => {
  const room = store.createGroup({ name: '测试部门', botIds: [bot.id] });
  const tool = askTool(room.id);
  const res = await tool.execute('c2', {
    question: '要不要用方案 B？',
    options: [{ label: '要' }, { label: '不要' }],
  });
  assert.equal(res.isError, true, '群里应该拒绝');
  const text = res.content.map((c) => c.text).join('');
  assert.match(text, /继续/);
  const list = store.listMessages(room.id, { limit: 10 });
  assert.equal(list.filter((m) => m.kind === 'ask').length, 0, '群里不该写出卡片');
});

await test('群聊提示里说清"写进正文"', async () => {
  const room = store.createGroup({ name: '测试部门2', botIds: [bot.id] });
  const res = await askTool(room.id).execute('c3', {
    question: 'q',
    options: [{ label: 'x' }],
  });
  const text = res.content.map((c) => c.text).join('');
  assert.match(text, /正文/);
});

await test('★ 主控（main）根本拿不到 ask_user 工具', async () => {
  // 主控本来就在跟用户直接对话，弹卡片等于把一句话拆成"卡片 + 一次点击"，
  // 反而更远；而且它一轮要推进整件事，停下来等点击会卡住整个流程。
  const main = store.createBot({ name: '主控', persona: 'x' });
  store.updateBot(main.id, { role: 'main' });
  const tools = buildCommonTools({ runner: {}, roomId: 'r-main', botId: main.id, isMain: true });
  assert.equal(
    tools.some((t) => t.name === 'ask_user'),
    false,
    '主控不该有 ask_user',
  );
});

await test('成员仍然拿得到 ask_user', async () => {
  const member = store.createBot({ name: '成员', persona: 'x' });
  const tools = buildCommonTools({ runner: {}, roomId: 'r-member', botId: member.id, isMain: false });
  assert.equal(
    tools.some((t) => t.name === 'ask_user'),
    true,
    '成员应该保留 ask_user',
  );
});

await test('主控少这一个工具，其余工具不受影响', async () => {
  const main = store.createBot({ name: '主控2', persona: 'x' });
  const withMain = buildCommonTools({ runner: {}, roomId: 'r1', botId: main.id, isMain: true })
    .map((t) => t.name);
  const noMain = buildCommonTools({ runner: {}, roomId: 'r1', botId: main.id, isMain: false })
    .map((t) => t.name);
  // 除了 ask_user，两边应当完全一致
  assert.deepEqual(
    withMain.slice().sort(),
    noMain.filter((n) => n !== 'ask_user').sort(),
  );
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 询问卡片范围测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
