/**
 * 单元测试（不依赖网络和模型）。
 *   node tests/unit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------------------
// mentions：@提及解析（整个组织架构的调度信号）
// ---------------------------------------------------------------------------
const { parseMentions, rosterLine } = await import('../src/mentions.js');

const MEMBERS = [
  { id: '1', name: 'UI设计师', emoji: '🎨' },
  { id: '2', name: '后端工程师', emoji: '⚙️' },
  { id: '3', name: '前端工程师', emoji: '🖥️' },
  { id: '4', name: '后端' },
  { id: '5', name: '产品经理', emoji: '📋' },
];

await test('mentions: @名字 能被解析', () => {
  const r = parseMentions('@UI设计师 出个规范', MEMBERS);
  assert.deepEqual(r.found, ['1']);
  assert.equal(r.all, false);
});

await test('mentions: @ 和名字之间夹 emoji 也能解析（bot 最爱这么写）', () => {
  const r = parseMentions('**@🎨UI设计师**：出视觉规范', MEMBERS);
  assert.deepEqual(r.found, ['1']);
});

await test('mentions: 长名字优先，@后端工程师 不会被 @后端 抢走', () => {
  const r = parseMentions('@后端工程师 先定数据源', MEMBERS);
  assert.deepEqual(r.found, ['2']);
});

await test('mentions: @all / @全体 触发全员', () => {
  assert.equal(parseMentions('@all 都看一下', MEMBERS).all, true);
  assert.equal(parseMentions('@全体 开会', MEMBERS).all, true);
});

await test('mentions: 不带 @ 的名字不算调用', () => {
  const r = parseMentions('后端工程师之前说过这个', MEMBERS);
  assert.deepEqual(r.found, []);
});

await test('mentions: 一次 @ 多个人', () => {
  const r = parseMentions('@UI设计师 @后端工程师 @前端工程师 都上', MEMBERS);
  assert.deepEqual([...r.found].sort(), ['1', '2', '3']);
});

await test('mentions: selfId 排除自己', () => {
  const r = parseMentions('@UI设计师 和 @后端工程师', MEMBERS, { selfId: '1' });
  assert.deepEqual(r.found, ['2']);
});

await test('mentions: rosterLine 带出老大标记', () => {
  const line = rosterLine({ name: '产品经理', emoji: '📋', persona: '接需求、拆任务' }, { isLead: true });
  assert.match(line, /产品经理/);
  assert.match(line, /部门老大/);
});

// ---------------------------------------------------------------------------
// store：房间 / 消息 / 游标 / 脏标记
// ---------------------------------------------------------------------------
process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });
const { store } = await import('../src/store.js');

await test('store: 初始化有且只有一个总经理 + 一个私聊', () => {
  const bots = store.listBots();
  assert.equal(bots.length, 1);
  assert.equal(bots[0].role, 'main');
  const rooms = store.listRooms();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].kind, 'dm');
});

await test('store: 建 bot 会自动开私聊窗口（像加好友）', () => {
  const bot = store.createBot({ name: '测试专员', persona: '只做测试' });
  const dm = store.listRooms().find((r) => r.kind === 'dm' && r.botIds[0] === bot.id);
  assert.ok(dm, '应该自动创建了私聊');
  assert.equal(dm.name, '测试专员');
});

await test('store: 建部门时 leadBotId 不能是主控', () => {
  const a = store.createBot({ name: '甲' });
  const b = store.createBot({ name: '乙' });
  const room = store.createGroup({ name: '测试部门', botIds: [a.id, b.id] });
  assert.equal(room.botIds.length, 2, '部门不该把主控塞进来');
  assert.equal(room.leadBotId, a.id, '老大默认取第一个成员');
});

await test('store: 可以指定部门老大', () => {
  const a = store.createBot({ name: '丙' });
  const b = store.createBot({ name: '丁' });
  const room = store.createGroup({ name: '测试部门2', botIds: [a.id, b.id], leadBotId: b.id });
  assert.equal(room.leadBotId, b.id);
});

await test('store: roomSummary 带出老大名字和成员名', () => {
  const room = store.listRooms().find((r) => r.name === '测试部门');
  const sum = store.roomSummary(room);
  assert.equal(sum.leadName, '甲');
  assert.deepEqual(sum.botNames, ['甲', '乙']);
});

await test('store: 消息游标（每个 bot 看到哪了）', () => {
  const room = store.listRooms().find((r) => r.name === '测试部门');
  const m1 = store.appendMessage({ roomId: room.id, authorType: 'user', text: '第一条' });
  const m2 = store.appendMessage({ roomId: room.id, authorType: 'user', text: '第二条' });
  assert.equal(store.seenCursor(room.id, room.botIds[0]), null);
  store.setCursor(room.id, room.botIds[0], m1.id);
  assert.equal(store.seenCursor(room.id, room.botIds[0]), m1.id);
  const list = store.listMessages(room.id);
  assert.equal(list[list.length - 1].id, m2.id);
});

await test('store: 删除消息（[PASS] 占位要用）', () => {
  const room = store.listRooms().find((r) => r.name === '测试部门');
  const before = store.listMessages(room.id).length;
  const m = store.appendMessage({ roomId: room.id, authorType: 'bot', text: '[PASS]' });
  assert.equal(store.listMessages(room.id).length, before + 1);
  store.deleteMessage(room.id, m.id);
  assert.equal(store.listMessages(room.id).length, before);
});

await test('store: 删 bot 会把它从部门里摘掉并改老大', () => {
  const room = store.listRooms().find((r) => r.name === '测试部门2');
  const lead = room.leadBotId;
  const other = room.botIds.find((id) => id !== lead);
  store.deleteBot(lead);
  const after = store.getRoom(room.id);
  assert.ok(!after.botIds.includes(lead));
  assert.equal(after.leadBotId, other, '老大被删后要顺位给下一个');
});

await test('store: 消息上限裁剪', () => {
  const room = store.listRooms().find((r) => r.name === '测试部门');
  for (let i = 0; i < 600; i++) {
    store.appendMessage({ roomId: room.id, authorType: 'user', text: `灌水${i}` });
  }
  assert.ok(store.listMessages(room.id, { limit: 9999 }).length <= 500, '不该无限增长');
});

await test('store: 脏房间追踪（避免全量重写）', () => {
  assert.ok(store.dirtyRooms.size > 0, '有改动就该有脏标记');
  store.saveNow();
  assert.equal(store.dirtyRooms.size, 0, '落盘后应清空');
});

// ---------------------------------------------------------------------------
// model-menu：模型白名单
// ---------------------------------------------------------------------------
const { resolveMenu, defaultMenuSlug, menuSlugs, MODEL_MENU } = await import('../src/model-menu.js');

await test('model-menu: 别名能解析成 slug', () => {
  const r = resolveMenu('ds-4.1-flash', null);
  assert.ok(r.slug.includes('deepseek-v4.1-flash'));
});

await test('model-menu: 完整 slug 也能解析', () => {
  const r = resolveMenu('cline/cline-pass/deepseek-v4.1-flash', null);
  assert.equal(r.entry.alias, 'ds-4.1-flash');
});

await test('model-menu: 白名单外的模型一律拒绝', () => {
  assert.equal(resolveMenu('kimi-k2.5', null), null);
  assert.equal(resolveMenu('opencode/glm-5.3', null), null);
  assert.equal(resolveMenu('ctyun/deepseek-v4-pro-0813-oc', null), null);
});

await test('model-menu: 只有 4 个别名', () => {
  assert.equal(MODEL_MENU.length, 4);
  assert.deepEqual(
    MODEL_MENU.map((m) => m.alias),
    ['kimi-k3', 'glm-5.3', 'glm-5.3-flash', 'ds-4.1-flash'],
  );
});

await test('model-menu: 默认模型优先 ds-4.1-flash', () => {
  const fakeHealth = { isKnownGood: (s) => s.includes('deepseek-v4.1-flash'), get: () => ({ ok: true }) };
  assert.ok(defaultMenuSlug(fakeHealth).includes('deepseek-v4.1-flash'));
});

await test('model-menu: 所有 slug 都唯一', () => {
  const slugs = menuSlugs();
  assert.equal(slugs.length, new Set(slugs).size);
});

// ---------------------------------------------------------------------------
// extract：文件解析
// ---------------------------------------------------------------------------
const { extractText } = await import('../src/extract.js');
const tmp = path.join(process.cwd(), 'data', '_unit_test', 'files');
fs.mkdirSync(tmp, { recursive: true });

await test('extract: markdown 原样返回', async () => {
  const f = path.join(tmp, 'a.md');
  fs.writeFileSync(f, '# 标题\n\n- 一\n- 二\n');
  const r = await extractText(f);
  assert.equal(r.ok, true);
  assert.match(r.text, /标题/);
});

await test('extract: html 去掉 script/style，保留结构', async () => {
  const f = path.join(tmp, 'a.html');
  fs.writeFileSync(
    f,
    '<html><head><style>body{color:red}</style><script>var x=1</script></head><body><h1>报告</h1><p>第一段</p><ul><li>要点</li></ul></body></html>',
  );
  const r = await extractText(f);
  assert.equal(r.ok, true);
  assert.match(r.text, /报告/);
  assert.match(r.text, /要点/);
  assert.ok(!r.text.includes('color:red'), '不该带 style');
  assert.ok(!r.text.includes('var x=1'), '不该带 script');
});

await test('extract: csv 读取', async () => {
  const f = path.join(tmp, 'a.csv');
  fs.writeFileSync(f, 'a,b\n1,2\n');
  const r = await extractText(f);
  assert.equal(r.ok, true);
  assert.match(r.text, /1,2/);
});

await test('extract: 不存在的文件给出可读错误', async () => {
  const r = await extractText(path.join(tmp, 'nope.pdf'));
  assert.equal(r.ok, false);
  assert.match(r.error, /不存在/);
});

await test('extract: 老式 .doc 明确说不支持', async () => {
  const f = path.join(tmp, 'a.doc');
  fs.writeFileSync(f, 'binary junk');
  const r = await extractText(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /docx|pdf/);
});

await test('extract: 超长文本会截断', async () => {
  const f = path.join(tmp, 'big.txt');
  fs.writeFileSync(f, 'x'.repeat(5000));
  const r = await extractText(f, { maxChars: 100 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < 300);
});

// ---------------------------------------------------------------------------
// attachments：附件存取
// ---------------------------------------------------------------------------
const { saveBuffer, metaFor, pathFor, inboxPath, kindFor } = await import('../src/attachments.js');

await test('attachments: 存 + 取 + 类型判定', () => {
  const meta = saveBuffer(Buffer.from('hello'), { name: 'note.txt', mime: 'text/plain' });
  assert.equal(meta.kind, 'file');
  assert.equal(metaFor(meta.id).name, 'note.txt');
  assert.ok(fs.existsSync(pathFor(meta.id)));
});

await test('attachments: 图片识别', () => {
  assert.equal(kindFor('image/png'), 'image');
  const meta = saveBuffer(Buffer.from([0x89, 0x50]), { name: 'x.png' });
  assert.equal(meta.kind, 'image');
  assert.equal(meta.mime, 'image/png');
});

await test('attachments: 复制进工作目录 _inbox', () => {
  const meta = saveBuffer(Buffer.from('data'), { name: '报表.csv', mime: 'text/csv' });
  const p = inboxPath(meta.id);
  assert.ok(p && fs.existsSync(p));
  assert.match(p, /_inbox/);
});

// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 单元测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
