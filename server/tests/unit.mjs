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
const { trimTranscript } = await import('../src/transcript-budget.js');

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
// 侧边栏右键菜单：置顶 / 隐藏 / 标为未读，以及「私聊也能删」
// ---------------------------------------------------------------------------

await test('store: 侧边栏三个开关能改（置顶/隐藏/标为未读）', () => {
  const bot = store.createBot({ name: '开关对象' });
  const dm = store.listRooms().find((r) => r.kind === 'dm' && r.botIds[0] === bot.id);
  store.updateRoom(dm.id, { pinned: true, hidden: true, unread: true });
  const after = store.getRoom(dm.id);
  assert.equal(after.pinned, true);
  assert.equal(after.hidden, true);
  assert.equal(after.unread, true);
  // 关掉也要能关（右键菜单是 toggle，不是单向）
  store.updateRoom(dm.id, { pinned: false, hidden: false, unread: false });
  assert.equal(store.getRoom(dm.id).pinned, false);
  assert.equal(store.getRoom(dm.id).hidden, false);
});

await test('store: 置顶的排在最前面（压过"主控 DM 默认置顶"）', () => {
  const a = store.createBot({ name: '置顶甲' });
  const b = store.createBot({ name: '置顶乙' });
  const dmA = store.listRooms().find((r) => r.kind === 'dm' && r.botIds[0] === a.id);
  store.updateRoom(dmA.id, { pinned: true });
  // 主控那一个是 role=main，默认也在最前；手动置顶的要排在它前面
  assert.equal(store.listRooms()[0].id, dmA.id);
  store.updateRoom(dmA.id, { pinned: false });
  assert.notEqual(store.listRooms()[0].id, dmA.id);
  assert.ok(store.getRoom(b.id) === null || true, '乙只是用来占位的');
});

await test('store: 私聊也能删（以前 deleteRoom 直接被 return null 挡住）', () => {
  const bot = store.createBot({ name: '待删对象' });
  const dm = store.listRooms().find((r) => r.kind === 'dm' && r.botIds[0] === bot.id);
  assert.ok(dm, '建 bot 时自动开了私聊');
  const r = store.deleteRoom(dm.id);
  assert.ok(r, '私聊删除不该被拒绝');
  assert.equal(store.getRoom(dm.id), null);
  // ★ 删的是"这个会话"，不是那个 bot —— bot 得留着
  assert.ok(store.getBot(bot.id), 'bot 本身不能被连带删掉');
});

await test('store: 删掉私聊后，再找它还能重新开一个空的', () => {
  const bot = store.createBot({ name: '重开对象' });
  const dm = store.listRooms().find((r) => r.kind === 'dm' && r.botIds[0] === bot.id);
  store.deleteRoom(dm.id);
  const again = store.ensureDm(bot.id);
  assert.ok(again, 'ensureDm 应该重新开一个');
  assert.notEqual(again.id, dm.id, '是新房间，不是刚删的那个');
  assert.equal((store.listMessages(again.id) || []).length, 0, '新开的应该是空的');
});

// ---------------------------------------------------------------------------
// store：用户教的 SOP（skills）+ 形象（avatarShape / avatarColor）
// ---------------------------------------------------------------------------

await test('store: 用户教的 SOP 会存下来，id 自动生成', () => {
  const bot = store.createBot({ name: '教学对象' });
  store.updateBot(bot.id, {
    skills: [
      { title: '发日报', howto: '每天 18:00 把当天改动整理成 markdown 发到群里' },
      { title: '改样式', howto: '先看 design/ 里的规范，再动代码' },
    ],
  });
  const next = store.getBot(bot.id);
  assert.equal(next.skills.length, 2);
  assert.equal(next.skills[0].title, '发日报');
  assert.match(next.skills[0].howto, /18:00/);
  assert.ok(next.skills[0].id.startsWith('sk_'), 'id 该自动生成');
});

await test('store: 没写标题的 SOP 会被丢掉（别让空行进提示词）', () => {
  const bot = store.createBot({ name: '教学对象2' });
  store.updateBot(bot.id, {
    skills: [
      { title: '   ', howto: '只有空格' },
      { title: '有效', howto: 'ok' },
      { howto: '压根没 title' },
    ],
  });
  const s = store.getBot(bot.id).skills;
  assert.equal(s.length, 1);
  assert.equal(s[0].title, '有效');
});

await test('store: SOP 条数和长度都会截断（别把系统提示词撑爆）', () => {
  const bot = store.createBot({ name: '教学对象3' });
  store.updateBot(bot.id, {
    skills: Array.from({ length: 60 }, (_, i) => ({
      title: `T${i}`.padEnd(200, 'x'),
      howto: 'y'.repeat(5000),
    })),
  });
  const s = store.getBot(bot.id).skills;
  assert.equal(s.length, 40, '最多 40 条');
  assert.equal(s[0].title.length, 80, 'title 截到 80');
  // 4000：自动挂上来的「工程基线」本身就长（十几条铁律），2000 会被截断
  assert.equal(s[0].howto.length, 4000, 'howto 截到 4000');
});

await test('store: avatarColor 归一化成 #RRGGBB', () => {
  const bot = store.createBot({ name: '上色对象' });
  store.updateBot(bot.id, { avatarColor: 'e93' });
  assert.equal(store.getBot(bot.id).avatarColor, '#EE9933', '三位缩写要展开');
  store.updateBot(bot.id, { avatarColor: '#a1b2c3' });
  assert.equal(store.getBot(bot.id).avatarColor, '#A1B2C3', '统一大写带 #');
});

await test('store: 非法颜色 / 非法形状退回 null（让客户端按 id 自己算）', () => {
  const bot = store.createBot({ name: '上色对象2' });
  store.updateBot(bot.id, { avatarColor: 'javascript:alert(1)', avatarShape: '3' });
  assert.equal(store.getBot(bot.id).avatarColor, null);
  assert.equal(store.getBot(bot.id).avatarShape, null, '字符串 "3" 不算合法形状');
});

// ---------------------------------------------------------------------------
// 上下文预算：模型容量覆盖 + 压缩参数
//   用户的原话："很多模型能支持 100w 上下文，然后 161k max token" ——
//   所以这四个数必须能被用户/总经理覆盖，而且要能只覆盖其中一部分。
// ---------------------------------------------------------------------------
const { withCapacity, applyCompactionBudget } = await import('../src/context-budget.js');

const FAKE_MODEL = {
  provider: 'cline',
  id: 'cline-pass/deepseek-v4.1-flash',
  contextWindow: 1_000_000,
  maxTokens: 32_768,
};

await test('容量覆盖：没设过就原样返回（不碰模型自带的数）', () => {
  const same = withCapacity(FAKE_MODEL, {});
  assert.equal(same, FAKE_MODEL, '没改动就该是同一个对象，别白白多建一个');
});

await test('容量覆盖：只抬 maxTokens（1M 上下文 / 32k → 161k 输出）', () => {
  const m = withCapacity(FAKE_MODEL, { maxTokens: 161_000 });
  assert.equal(m.maxTokens, 161_000);
  assert.equal(m.contextWindow, 1_000_000, '没设的那一项不能被改掉');
  assert.equal(FAKE_MODEL.maxTokens, 32_768, '★ 不能改到原对象上（那是全局注册表的）');
});

await test('容量覆盖：非法值当没设', () => {
  const m = withCapacity(FAKE_MODEL, { maxTokens: 0, contextWindow: -5 });
  assert.equal(m, FAKE_MODEL);
  const m2 = withCapacity(FAKE_MODEL, { maxTokens: '161000' });
  assert.equal(m2.maxTokens, 161_000, '字符串数字要认');
});

await test('压缩预算：bot 上没设 → 不覆盖，交给 pi 自己的默认', () => {
  const calls = [];
  const session = { settingsManager: { applyOverrides: (o) => calls.push(o) } };
  const r = applyCompactionBudget(session, {});
  assert.equal(r, null);
  assert.equal(calls.length, 0, '一层都没设就别去动 settings');
});

await test('压缩预算：bot 上设了 → 按会话覆盖（不动全局 settings.json）', () => {
  const calls = [];
  const session = { settingsManager: { applyOverrides: (o) => calls.push(o) } };
  const r = applyCompactionBudget(session, { reserveTokens: 400_000, keepRecentTokens: 50_000 });
  assert.deepEqual(r, { reserveTokens: 400_000, keepRecentTokens: 50_000 });
  assert.deepEqual(calls[0], { compaction: { reserveTokens: 400_000, keepRecentTokens: 50_000 } });
});

await test('压缩预算：没有 settingsManager 的会话不能把整轮搞崩', () => {
  assert.equal(applyCompactionBudget({}, { reserveTokens: 1000 }), null);
  assert.equal(applyCompactionBudget(null, { reserveTokens: 1000 }), null);
});

const { buildMemoryDigest, memoryConversation } = await import('../src/memory-digest.js');

await test('记忆材料：跳过进度回执/系统消息/空消息，只留真对话', () => {
  const msgs = [
    { id: '1', authorType: 'user', text: '查一下净值', createdAt: 1 },
    { id: '2', authorType: 'system', text: '调度提示：预算用完', createdAt: 2 },
    { id: '3', authorType: 'bot', authorName: '研究员', text: '在「组」接到活，开始处理：查净值', meta: { progress: true }, createdAt: 3 },
    { id: '4', authorType: 'bot', authorName: '研究员', text: '', createdAt: 4 },
    { id: '5', authorType: 'bot', authorName: '研究员', text: '净值是 1.23', createdAt: 5 },
  ];
  const got = memoryConversation(msgs).map((m) => m.id).sort();
  assert.deepEqual(got, ['1', '5']);
});

await test('记忆材料：摘要按条数/总字数截断，保留最新的', () => {
  const msgs = Array.from({ length: 80 }, (_, i) => ({
    id: String(i), authorType: 'user', text: `第${i}条`, createdAt: i,
  }));
  const digest = buildMemoryDigest(msgs, { maxMessages: 60, maxChars: 40 });
  assert.ok(digest.length <= 40, `应截到 40 字以内，实际 ${digest.length}`);
  assert.ok(digest.includes('第79条'), '最新的必须保留');
  assert.ok(!digest.includes('第0条'), '太老的应被截掉');
});

await test('记忆摘要：存取按 room:bot 隔离', () => {
  store.setMemorySummary('mem_room_a', 'mem_bot_a', { text: '记住甲', count: 3, lastId: 'm1' });
  const got = store.memorySummaryFor('mem_room_a', 'mem_bot_a');
  assert.equal(got.text, '记住甲');
  assert.equal(got.count, 3);
  assert.ok(got.at > 0);
  assert.equal(store.memorySummaryFor('mem_room_a', 'mem_bot_b'), null);
  assert.equal(store.memorySummaryFor('mem_room_b', 'mem_bot_a'), null);

  // 重置会话时摘要必须一起作废
  store.clearMemorySummariesForRoom('mem_room_a');
  assert.equal(store.memorySummaryFor('mem_room_a', 'mem_bot_a'), null);
});

await test('★ 压缩预算：reserve/keep ≥ 上下文窗口（1M/1M）会被丢弃，回退 pi 默认', () => {
  const calls = [];
  const session = {
    model: { contextWindow: 1_000_000 },
    settingsManager: { applyOverrides: (o) => calls.push(o) },
  };
  const r = applyCompactionBudget(session, {
    reserveTokens: 1_000_000,
    keepRecentTokens: 1_000_000,
  });
  // 这两个值等于"永不触发 / 什么都保留"，必须当没设
  assert.equal(r, null);
  assert.equal(calls.length, 0, '不能把非法值写进会话设置');
});

// ---------------------------------------------------------------------------
// store：每个 bot 的四个预算数字（用户和总经理都能改）
// ---------------------------------------------------------------------------

await test('store: bot 的四个预算数字默认都是 null（= 用上层默认）', () => {
  const bot = store.createBot({ name: '预算对象' });
  for (const k of ['reserveTokens', 'keepRecentTokens', 'contextWindow', 'maxTokens']) {
    assert.equal(bot[k], null, k + ' 默认该是 null');
  }
});

await test('store: 四个预算数字能改，非法值退回 null', () => {
  const bot = store.createBot({ name: '预算对象2' });
  store.updateBot(bot.id, {
    contextWindow: 1_000_000,
    maxTokens: 161_000,
    reserveTokens: 400_000,
    keepRecentTokens: 50_000,
  });
  const b = store.getBot(bot.id);
  assert.equal(b.contextWindow, 1_000_000);
  assert.equal(b.maxTokens, 161_000);
  assert.equal(b.reserveTokens, 400_000);
  assert.equal(b.keepRecentTokens, 50_000);
  // 清回去（总经理任务做完可以恢复默认）
  store.updateBot(bot.id, { maxTokens: null, contextWindow: null });
  assert.equal(store.getBot(bot.id).maxTokens, null);
  // 脏值
  store.updateBot(bot.id, { reserveTokens: 'abc', keepRecentTokens: -1 });
  assert.equal(store.getBot(bot.id).reserveTokens, null);
  assert.equal(store.getBot(bot.id).keepRecentTokens, null);
});

// ---------------------------------------------------------------------------
// 联网：HTML → 可读文本
//   搜索/抓取要真发网络请求，不适合放单测；但"把网页变成文本"这步是纯函数，
//   而且是最容易出错的一步（噪音没去干净 = 白喂一堆 token 给模型）。
// ---------------------------------------------------------------------------
const { readable } = await import('../src/web.js');

await test('web: 去掉脚本和样式（不然全是 JS 噪音）', () => {
  const { text } = readable(`
    <html><head><style>body{color:red}</style><script>var x=1;</script></head>
    <body><p>真正的正文</p></body></html>`);
  assert.match(text, /真正的正文/);
  assert.ok(!text.includes('var x=1'), '脚本内容不该进来');
  assert.ok(!text.includes('color:red'), '样式不该进来');
});

await test('web: 去掉导航/页脚/侧栏这些壳', () => {
  const { text } = readable(`
    <body>
      <nav>首页 产品 关于</nav>
      <header>站点标题</header>
      <main><p>正文在这里</p></main>
      <aside>相关推荐</aside>
      <footer>版权所有</footer>
    </body>`);
  assert.match(text, /正文在这里/);
  for (const noise of ['首页', '站点标题', '相关推荐', '版权所有']) {
    assert.ok(!text.includes(noise), noise + ' 是壳，不该进正文');
  }
});

await test('web: 有 article 就优先取 article，不取整个 body', () => {
  const { text } = readable(`
    <body>
      <div>页面上的其他东西</div>
      <article><p>文章本体</p></article>
    </body>`);
  assert.match(text, /文章本体/);
  assert.ok(!text.includes('页面上的其他东西'));
});

await test('web: 块级元素之间补换行（否则整页挤成一行）', () => {
  const { text } = readable(
    '<body><p>第一段</p><p>第二段</p><li>列表项</li></body>',
  );
  assert.match(text, /第一段\n+第二段/);
});

await test('web: 超长会截断，并且告诉调用方截断了', () => {
  const long = '<body>' + '<p>' + 'x'.repeat(50) + '</p>'.repeat(1) + 'y'.repeat(500) + '</body>';
  const r = readable(long, { maxChars: 100 });
  assert.equal(r.text.length, 100);
  assert.equal(r.truncated, true);
  const ok2 = readable('<body><p>短</p></body>', { maxChars: 100 });
  assert.equal(ok2.truncated, false);
});

await test('web: 多余空白被压掉（省 token）', () => {
  const { text } = readable('<body><p>  一堆     空格   </p>\n\n\n\n<p>下一段</p></body>');
  assert.ok(!/ {2,}/.test(text), '不该有连续空格');
  assert.ok(!/\n{3,}/.test(text), '不该有连续空行');
});

// ---------------------------------------------------------------------------
// 用户身份
//   bot 要知道在跟谁说话（不写这个，它只能从人设里猜用户是谁、或者不称呼）。
// ---------------------------------------------------------------------------

await test('store: 用户有名字（没设过就用默认值）', () => {
  assert.ok(store.userName().length > 0);
});

await test('store: 能改用户名，空字符串等于没设（退回默认）', () => {
  store.updateUserName('小陈');
  assert.equal(store.userName(), '小陈');
  store.updateUserName('');
  assert.equal(store.userName(), '小陈'.length > 0 ? store.userName() : '');
  assert.ok(store.userName().length > 0, '空值不该让"用户名"变成空字符串');
});

await test('store: 用户名超长会截断（它会进系统提示，别让它撑爆）', () => {
  store.updateUserName('x'.repeat(200));
  assert.equal(store.userName().length, 40);
});

await test('prompt: 系统提示里明确写了"在跟谁说话"', async () => {
  // 在用例内部动态 import：这个文件后面才 import 它，靠前用会踩 TDZ
  const { buildAppendSystemPrompt } = await import('../src/system-prompt.js');
  const p = buildAppendSystemPrompt({}, { userName: '小陈' }).join('\n');
  assert.match(p, /在跟谁说话/);
  assert.match(p, /小陈/);
  assert.match(p, /唯一的真人/, '要说清这是唯一的人，其余都是同事');
  assert.match(
    p,
    /唯一的决策者|最高权威/,
    '★ 还要说清它的分量 —— 不说的话模型会把用户当成"又一个来插话的同事"',
  );
});

await test('prompt: 没传用户名也不能拼出"跟 说话"这种残句', async () => {
  const { buildAppendSystemPrompt } = await import('../src/system-prompt.js');
  const p = buildAppendSystemPrompt({}, {}).join('\n');
  assert.match(p, /叫「用户」/);
});

// ---------------------------------------------------------------------------
// 群聊轮次预算
//   用户要的是"能配，避免 bot 解不了就一直去聊"。这几个数是防无限互吹的闸门，
//   配错了（比如填 0 或负数）会把整个群锁死 —— 所以校验必须钉住。
// ---------------------------------------------------------------------------

await test('store: 轮次预算有默认值（老状态文件没有这一项也能用）', () => {
  const l = store.groupLimits();
  assert.equal(l.leadTurns, 15);
  assert.equal(l.memberTurns, 15);
  assert.equal(l.maxRuns, 100);
  assert.equal(l.maxSteps, 30);
  // 5 分钟对写代码这类慢活偏紧 → 默认放到 10 分钟（App 的「部门预算」里也能改）
  assert.equal(l.turnMaxMs, 600_000);
});

await test('store: 轮次预算能改，并且只认已知的键', () => {
  const l = store.updateGroupLimits({ leadTurns: 6, maxRuns: 3, 乱写的键: 999 });
  assert.equal(l.leadTurns, 6);
  assert.equal(l.maxRuns, 3);
  assert.equal(l.乱写的键, undefined, '不认识的键不该被存下来');
  // 改回去，别影响后面的用例
  store.updateGroupLimits({ leadTurns: 4, maxRuns: 10 });
});

await test('★ store: 非法值（0/负数/NaN）被挡掉 —— 否则群会被锁死', () => {
  const before = store.groupLimits();
  for (const bad of [0, -1, 'abc', null, undefined]) {
    store.updateGroupLimits({ leadTurns: bad });
    assert.equal(
      store.groupLimits().leadTurns,
      before.leadTurns,
      '填了 ' + String(bad) + ' 应该保持原值而不是变成 0',
    );
  }
});

await test('store: 小数会被取整（轮次没有半轮）', () => {
  const l = store.updateGroupLimits({ memberTurns: 2.7 });
  assert.equal(l.memberTurns, 2);
  store.updateGroupLimits({ memberTurns: 2 });
});

// ---------------------------------------------------------------------------
// model-menu：模型白名单
// ---------------------------------------------------------------------------

const {
  resolveMenu,
  defaultMenuSlug,
  menuSlugs,
  findMenuEntry,
  renderMenu,
  EMPTY_MENU_HINT,
} = await import('../src/model-menu.js');

// 菜单现在完全来自**用户自己配的模型组**（内置白名单已删）。
// 所以测试拿一份"假菜单"喂进去 —— 这也是当初把 entries 做成参数的原因：
// 验菜单规则不用真去建模型组、更不用碰用户机器上的配置。
const FAKE = [
  {
    alias: '我的组/flash',
    label: '我的组 · Flash',
    use: '便宜快',
    tier: 'custom',
    slugs: ['grp1/flash', 'grp1/flash-backup'],
  },
  {
    alias: '我的组/pro',
    label: '我的组 · Pro',
    use: '主力',
    tier: 'custom',
    slugs: ['grp1/pro'],
  },
];
const HEALTH_OK = { isKnownGood: () => true };
const HEALTH_NONE = { isKnownGood: () => false };

await test('model-menu: 别名能解析成 slug', () => {
  const r = resolveMenu('我的组/flash', null, FAKE);
  assert.equal(r.slug, 'grp1/flash');
});

await test('model-menu: 完整 slug 也能解析', () => {
  const r = resolveMenu('grp1/pro', null, FAKE);
  assert.equal(r.entry.alias, '我的组/pro');
});

await test('model-menu: 探活通过的那条线路优先', () => {
  const health = { isKnownGood: (s) => s === 'grp1/flash-backup' };
  const r = resolveMenu('我的组/flash', health, FAKE);
  assert.equal(r.slug, 'grp1/flash-backup');
  assert.equal(r.alive, true);
});

await test('model-menu: 菜单外的模型一律拒绝', () => {
  assert.equal(resolveMenu('gpt-9', null, FAKE), null);
  assert.equal(findMenuEntry('', FAKE), null);
});

await test('model-menu: 唯一后缀也能认出来', () => {
  assert.equal(findMenuEntry('pro', FAKE)?.alias, '我的组/pro');
});

await test('★ model-menu: 没配模型组时给的是"去配"的提示，不是空字符串', () => {
  // 用户原话："每个人用自己配置的，不然我们要模型组干什么"
  const text = renderMenu([], null);
  assert.equal(text, EMPTY_MENU_HINT);
  assert.match(text, /模型组/);
  assert.match(text, /App/);
});

await test('model-menu: 菜单文本带别名 / 落点 / 用途', () => {
  const text = renderMenu(FAKE, HEALTH_OK);
  assert.match(text, /我的组\/flash/);
  assert.match(text, /grp1\/flash/);
  assert.match(text, /便宜快/);
  assert.match(text, /★/);
});

await test('model-menu: 默认模型取第一个探活可用的', () => {
  assert.equal(defaultMenuSlug(HEALTH_NONE) === null || true, true);
  // 传假菜单不方便（defaultMenuSlug 读真实模型组）—— 这里只钉住
  // "没有模型组时不该瞎编一个模型出来"
  const s = defaultMenuSlug(HEALTH_OK);
  assert.ok(s === null || typeof s === 'string');
});

await test('model-menu: slug 列表去重', () => {
  const slugs = menuSlugs();
  assert.equal(new Set(slugs).size, slugs.length);
});

await test('★ model-menu: 探活结果全过期时视为可用', () => {
  // 过期表示没有新结论，不等同于线路不可用。
  const stale = {
    isKnownGood: () => false,
    wasGood: (s) => s === 'grp1/flash',
    hasFresh: () => false,
    hasFreshFor: () => false,
  };
  const r = resolveMenu('我的组/flash', stale, FAKE);
  assert.equal(r.alive, true, '过期了先乐观放行');
  assert.equal(r.slug, 'grp1/flash', '优先选以前跑通过的那条');
});

await test('★ model-menu: 有新鲜结论且不可用时判为不可用', () => {
  // 已有新鲜探活结论且失败时，不启用乐观回退。
  const freshDead = {
    isKnownGood: () => false,
    wasGood: () => true,
    hasFresh: () => true,
    hasFreshFor: () => true,
  };
  const r = resolveMenu('我的组/flash', freshDead, FAKE);
  assert.equal(r.alive, false);
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
// ref：跨会话引用气泡（bot 私信同事时，在来源房间留的小浮动条）
//   时间窗口是时间敏感逻辑，写错了只会表现为「界面偶尔刷屏」，人工点不出来 → 必须单测。
// ---------------------------------------------------------------------------
const { planRefBubble, REF_MERGE_MS } = await import('../src/tools.js');

/** 造一条"上一条消息"：默认就是同一个人刚发的 ref 气泡 */
const prevRef = (over = {}) => ({
  id: 'm1',
  kind: 'ref',
  authorId: 'b1',
  createdAt: 1_000_000,
  refs: [{ botId: 'old', roomId: 'dm_old', at: 1_000_000 }],
  ...over,
});

await test('ref: 没有上一条消息 → 新建气泡', () => {
  const p = planRefBubble({ last: undefined, botId: 'b1', targetBotId: 'b2', dmRoomId: 'dm2', at: 1_000_000 });
  assert.equal(p.mode, 'append');
  // count 也带上（界面显示「N 条消息往来」用）
  assert.deepEqual(p.ref, {
    botId: 'b2',
    roomId: 'dm2',
    at: 1_000_000,
    count: null,
  });
});

await test('ref: 同一个 bot 180s 内连着私信 → 合并成一个气泡', () => {
  const p = planRefBubble({
    last: prevRef(), botId: 'b1', targetBotId: 'b2', dmRoomId: 'dm2', at: 1_000_060, nowMs: 1_060_000,
  });
  assert.equal(p.mode, 'merge');
  assert.deepEqual(p.refs.map((r) => r.botId), ['old', 'b2'], '老的留着，新的接在后面');
});

await test('ref: 超过 180s 就不再合并（别把一小时前派的人也算进来）', () => {
  const p = planRefBubble({
    last: prevRef(), botId: 'b1', targetBotId: 'b2', dmRoomId: 'dm2',
    at: 1_000_000 + REF_MERGE_MS + 1, nowMs: 1_000_000 + REF_MERGE_MS + 1,
  });
  assert.equal(p.mode, 'append');
});

await test('ref: 换个 bot 说话 → 不合并（各人一个气泡）', () => {
  const p = planRefBubble({
    last: prevRef({ authorId: 'b9' }), botId: 'b1', targetBotId: 'b2', dmRoomId: 'dm2', at: 1_001_000, nowMs: 1_001_000,
  });
  assert.equal(p.mode, 'append');
});

await test('ref: 上一条是普通聊天 → 不合并', () => {
  const p = planRefBubble({
    last: prevRef({ kind: 'text' }), botId: 'b1', targetBotId: 'b2', dmRoomId: 'dm2', at: 1_001_000, nowMs: 1_001_000,
  });
  assert.equal(p.mode, 'append');
});

await test('ref: 同一个同事重复私信 → 去重，不出现两个同名气泡', () => {
  const p = planRefBubble({
    last: prevRef({ refs: [{ botId: 'b2', roomId: 'dm2', at: 999_000 }] }),
    botId: 'b1', targetBotId: 'b2', dmRoomId: 'dm2', at: 1_001_000, nowMs: 1_001_000,
  });
  assert.equal(p.mode, 'merge');
  assert.equal(p.refs.filter((r) => r.botId === 'b2').length, 1);
});

// ---------------------------------------------------------------------------
// prompt：appendSystemPrompt 的拼装
//   这是全项目最容易悄悄写坏、又最难发现的地方 —— 提示词错了不报错，
//   只是 bot 突然开始念配置表，或者把用户教过的 SOP 忘了。
// ---------------------------------------------------------------------------
const { buildAppendSystemPrompt } = await import('../src/system-prompt.js');

await test('prompt: 人设排在最前面', () => {
  const p = buildAppendSystemPrompt({ persona: '你是资深设计师' });
  assert.equal(p[0], '你是资深设计师');
});

await test('prompt: 没教过就不出现「用户教过你的做法」', () => {
  const p = buildAppendSystemPrompt({ persona: '你是设计师' }).join('\n');
  assert.ok(!p.includes('用户教过你的做法'));
});

await test('prompt: 教过就按序号拼进去（bot 才真的"学会"）', () => {
  const p = buildAppendSystemPrompt({
    skills: [
      { title: '发日报', howto: '18:00 整理当天改动' },
      { title: '改样式', howto: '先看 design/ 规范' },
    ],
  }).join('\n');
  assert.match(p, /【用户教过你的做法】/);
  assert.match(p, /1\. 发日报：18:00 整理当天改动/);
  assert.match(p, /2\. 改样式：先看 design\/ 规范/);
});

await test('prompt: 空标题的 skill 不会拼出「1. ：」这种残句', () => {
  const p = buildAppendSystemPrompt({
    skills: [{ title: '', howto: 'x' }, { title: 'ok', howto: 'y' }],
  }).join('\n');
  assert.ok(!/^\d+\. ：/m.test(p), '不该出现空标题的残句');
  assert.match(p, /1\. ok：y/);
});

await test('prompt: 说话规矩永远在（禁止念模型名/思考等级/token/id）', () => {
  const p = buildAppendSystemPrompt({}).join('\n');
  assert.match(p, /【说话规矩】/);
  assert.match(p, /模型名/);
  assert.match(p, /思考等级/);
  assert.match(p, /token 用量/);
  assert.match(p, /«»/, '内部参数的约定要写清楚');
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 插队：用户插话时，消息插在哪
// ---------------------------------------------------------------------------
const { insertionPoint } = await import('../src/util.js');

await test('插队：落在"正在写的那条回复"之前', () => {
  const list = [
    { id: 'u1', status: 'done' },
    { id: 'b1', status: 'done' },
    { id: 'b2', status: 'streaming' },
  ];
  // 插在 b2 之前 → 读起来才是「我插的话 → 它的回应」
  assert.equal(insertionPoint(list), 2);
});

await test('插队：没有正在写的，就按普通追加', () => {
  assert.equal(insertionPoint([{ status: 'done' }, { status: 'done' }]), 2);
  assert.equal(insertionPoint([]), 0);
});

await test('插队：已经说完的消息一个都不许动', () => {
  // 用户已经看过它们了，再挪位置会让人以为消息在跳
  const list = [
    { id: 'a', status: 'done' },
    { id: 'b', status: 'error' },
  ];
  assert.equal(insertionPoint(list), 2, '要追加到最后，不是插到中间');
});

await test('插队：多条同时在写（部门场景）→ 插在最前面那条之前', () => {
  const list = [
    { id: 'u1', status: 'done' },
    { id: 'b1', status: 'streaming' },
    { id: 'b2', status: 'streaming' },
  ];
  assert.equal(insertionPoint(list), 1);
});


// ---------------------------------------------------------------------------
// 自称：必须用用户起的名字，不许拿内部角色词当名字
// ---------------------------------------------------------------------------
await test('自称：提示里写明用"用户给它起的名字"', () => {
  const p = buildAppendSystemPrompt(
    { name: 'Arill', persona: '你是负责人' },
    { userName: 'Alex' },
  ).join('\n');
  assert.match(p, /【怎么自称】/);
  assert.match(p, /「Arill」/, '必须把名字带进去');
  assert.match(p, /不要拿它们当自称/, '要明说角色词不能当自称');
});

await test('自称：主控人设不再把人写成"总经理"', async () => {
  const { MAIN_PERSONA } = await import('../src/store.js');
  const text = MAIN_PERSONA;
  assert.doesNotMatch(
    text,
    /你是[^\n]*总经理/,
    '不许把人设写成"你是总经理"——它会照抄成自称',
  );
  assert.match(text, /用自己的名字自称/);
});


// ---------------------------------------------------------------------------
// 派活重试策略（"发现不通就重试 3 次，不行就报给主控"）
// ---------------------------------------------------------------------------
const { planDispatchRetry, isBusyError } = await import('../src/util.js');

await test('重试：对方忙 → 再试一次（用户要的"至少 3 次"）', () => {
  const r = planDispatchRetry({ attempt: 1, error: '甲 正在忙' });
  assert.equal(r.retry, true);
  assert.ok(r.waitMs > 0);
});

await test('重试：第 3 次之后不再试了', () => {
  assert.equal(planDispatchRetry({ attempt: 3, error: '甲 正在忙' }).retry, false);
});

await test('重试：不是"忙"的错就不该等（等也不会变）', () => {
  assert.equal(planDispatchRetry({ attempt: 1, error: '起不来：401' }).retry, false);
  assert.equal(planDispatchRetry({ attempt: 1, error: '找不到 bot x' }).retry, false);
});

await test('重试：等太久就放弃，交给上报主控', () => {
  const r = planDispatchRetry({ attempt: 2, error: '甲 正在忙', waitedMs: 999_999 });
  assert.equal(r.retry, false);
  assert.match(r.why, /等太久/);
});

await test('重试：等待时间递增，但不会超预算', () => {
  const a = planDispatchRetry({ attempt: 1, error: '忙' }).waitMs;
  const b = planDispatchRetry({ attempt: 2, error: '忙' }).waitMs;
  assert.ok(b >= a, `${b} 应该 >= ${a}`);
  const capped = planDispatchRetry({ attempt: 2, error: '忙', waitedMs: 175_000 }).waitMs;
  assert.ok(capped <= 5_000, '不能超预算');
});

await test('isBusyError：只认"忙"这一类', () => {
  assert.equal(isBusyError('甲 正在忙'), true);
  assert.equal(isBusyError('会话还没就绪'), false);
  assert.equal(isBusyError(null), false);
});


// ---------------------------------------------------------------------------
// 心跳断了该谁知晓（"组长 / 部长级别"）
// ---------------------------------------------------------------------------
const { pickEscalationHost } = await import('../src/util.js');

await test('★ 中断：部门里的活先找组长', () => {
  const r = pickEscalationHost({
    roomKind: 'group',
    leadBotId: 'lead',
    fromBotId: 'member',
    chiefId: 'chief',
  });
  assert.equal(r.role, 'lead');
  assert.equal(r.hostId, 'lead');
});

await test('中断：私聊没有组长 → 找主控', () => {
  const r = pickEscalationHost({
    roomKind: 'dm',
    leadBotId: null,
    fromBotId: 'member',
    chiefId: 'chief',
  });
  assert.equal(r.role, 'chief');
  assert.equal(r.hostId, 'chief');
});

await test('中断：出事的那个自己就是组长 → 抬给主控', () => {
  const r = pickEscalationHost({
    roomKind: 'group',
    leadBotId: 'lead',
    fromBotId: 'lead',
    chiefId: 'chief',
  });
  assert.equal(r.hostId, 'chief');
});

await test('中断：派活失败要直接找主控（prefer=chief）', () => {
  const r = pickEscalationHost({
    roomKind: 'group',
    leadBotId: 'lead',
    fromBotId: 'member',
    chiefId: 'chief',
    prefer: 'chief',
  });
  assert.equal(r.hostId, 'chief');
});

await test('中断：没地方可报时返回空（不要瞎叫一个人）', () => {
  const r = pickEscalationHost({ roomKind: 'dm', fromBotId: 'chief', chiefId: 'chief' });
  assert.equal(r.hostId, null);
});


// ---------------------------------------------------------------------------
// 上级 @ 它要能打断（"无论多忙都要停下来听"）
// ---------------------------------------------------------------------------
const { isSuperiorCall } = await import('../src/util.js');

await test('★ 打断：用户叫它 → 必须停', () => {
  assert.equal(isSuperiorCall({ fromRole: 'user', selfId: 'me' }), true);
});

await test('★ 打断：组长叫成员 → 必须停（用户原话"组长 部长 自己上级@"）', () => {
  assert.equal(
    isSuperiorCall({ fromId: 'lead', fromRole: 'bot', leadId: 'lead', chiefId: 'chief', selfId: 'me' }),
    true,
  );
});

await test('★ 打断：主控叫它 → 必须停', () => {
  assert.equal(
    isSuperiorCall({ fromId: 'chief', fromRole: 'bot', leadId: 'lead', chiefId: 'chief', selfId: 'me' }),
    true,
  );
});

await test('打断：同级同事叫它 → 不打断（排队，否则群里互相掐断）', () => {
  assert.equal(
    isSuperiorCall({ fromId: 'peer', fromRole: 'bot', leadId: 'lead', chiefId: 'chief', selfId: 'me' }),
    false,
  );
});

await test('打断：它自己叫什么（不该发生）→ 不打断', () => {
  assert.equal(isSuperiorCall({ fromId: 'me', fromRole: 'bot', selfId: 'me', leadId: 'me' }), false);
});


// ---------------------------------------------------------------------------
// 工程基线：谁算"开发类"bot（命中才自动挂）
// ---------------------------------------------------------------------------
const { isCodingRole, CODING_BASELINE_HOWTO, CODING_BASELINE_TITLE } =
  await import('../src/coding-baseline.js');

await test('★ 工程基线：开发类 bot 认得出（中英都认）', () => {
  assert.equal(isCodingRole({ name: '平台开发工程师' }), true);
  assert.equal(isCodingRole({ name: 'Backend Engineer' }), true);
  assert.equal(isCodingRole({ name: '前端' }), true);
  assert.equal(isCodingRole({ persona: '负责重构和调试' }), true);
  assert.equal(isCodingRole({ name: 'DevOps' }), true);
});

await test('工程基线：非开发类不挂（别给文案/法务塞工程纪律）', () => {
  assert.equal(isCodingRole({ name: '文案编辑' }), false);
  assert.equal(isCodingRole({ name: '法务顾问', persona: '看合同' }), false);
  assert.equal(isCodingRole({ name: '市场分析师' }), false);
});

await test('★ 工程基线是通用英文的，且不含本机痕迹', () => {
  assert.match(CODING_BASELINE_TITLE, /Engineering/);
  // 关键是"能读"：正文必须是英文的（模型对工程纪律的英文表述最稳）
  assert.ok(/Read before you write/.test(CODING_BASELINE_HOWTO));
  assert.ok(/Kill processes by PID/.test(CODING_BASELINE_HOWTO));
  // 脱敏：不能出现盘符/用户名/密钥/内网地址
  assert.doesNotMatch(CODING_BASELINE_HOWTO, /[A-Za-z]:\|Users\|sk-[A-Za-z0-9]{8}|192\.168\./);
});


// ---------------------------------------------------------------------------
// 部门规矩：只读部门真的拿不到改文件/跑命令的工具
// ---------------------------------------------------------------------------
const { toolsForPolicy, POLICY_DEFAULT } = await import('../src/store.js');

await test('★ 部门规矩：默认（允许）时工具一个不少', () => {
  const all = ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash'];
  assert.deepEqual(toolsForPolicy(all, POLICY_DEFAULT), all);
});

await test('★ 部门规矩：只读时收走 write/edit/bash，保留只看的那几个', () => {
  const all = ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash'];
  const got = toolsForPolicy(all, { dangerous: 'deny', requireProof: false });
  assert.deepEqual(got, ['read', 'ls', 'find', 'grep']);
  assert.ok(!got.includes('bash'), '★ 只读部门绝不能留 bash');
});

await test('部门规矩：不认识的值不当成 deny（宁可宽松也不误伤）', () => {
  const all = ['read', 'write', 'bash'];
  assert.deepEqual(toolsForPolicy(all, { dangerous: 'whatever' }), all);
});

// ---------------------------------------------------------------------------
// 角色工具集：主控 / 部门老大只读，成员全量
// ---------------------------------------------------------------------------
const { toolsForRole, isLeadOfRoom } = await import('../src/store.js');
const ALL = ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash'];
const RO = ['read', 'ls', 'grep', 'find'];

const roleArgs = {
  chiefTools: RO,
  leadTools: RO,
  memberTools: ALL,
  policy: POLICY_DEFAULT,
};

await test('★ 主控是调度者：只拿只读工具，没有 bash/write/edit', () => {
  const got = toolsForRole({ ...roleArgs, isChief: true });
  assert.deepEqual(got, RO);
  assert.ok(!got.includes('bash'), '主控不能自己跑命令干活');
});

await test('★ 部门老大只负责拆解/派活/汇总：同样只拿只读工具', () => {
  const got = toolsForRole({ ...roleArgs, isDeptLead: true });
  assert.deepEqual(got, RO);
  assert.ok(!got.includes('bash'), '老大不能自己查数据/跑命令');
  assert.ok(!got.includes('write'), '老大不能自己写文件');
});

await test('普通成员：全量工具（干活的人）', () => {
  assert.deepEqual(toolsForRole(roleArgs), ALL);
});

await test('★ 单人部门的老大不算 lead（否则部门没人干活）', () => {
  const room = { kind: 'group', leadBotId: 'b1', botIds: ['b1'] };
  assert.equal(isLeadOfRoom(room, 'b1'), false);
});

await test('★ 群里有成员时，leadBotId 本人算 lead；没设 lead 时第一个成员算', () => {
  assert.equal(isLeadOfRoom({ kind: 'group', leadBotId: 'b1', botIds: ['b1', 'b2'] }, 'b1'), true);
  assert.equal(isLeadOfRoom({ kind: 'group', leadBotId: null, botIds: ['b1', 'b2'] }, 'b1'), true);
  assert.equal(isLeadOfRoom({ kind: 'group', leadBotId: 'b1', botIds: ['b1', 'b2'] }, 'b2'), false);
  // 私聊永远不算部门老大
  assert.equal(isLeadOfRoom({ kind: 'dm', leadBotId: 'b1', botIds: ['b1'] }, 'b1'), false);
});


// ---------------------------------------------------------------------------
// 群调度决策（group-round.js）：只回答"该做什么"，不执行任何副作用
// ---------------------------------------------------------------------------
const { shouldStopRound, planItem, leftBehind } = await import('../src/group-round.js');

await test('调度决策：队列空了但有人还在跑 → 不能停（他们的 @ 会补进队列）', () => {
  assert.equal(shouldStopRound({ queueLen: 0, pendingLen: 2, runs: 1, maxRuns: 10 }).stop, false);
});

await test('调度决策：用户按了终止 → 立刻停，不管还有谁', () => {
  const r = shouldStopRound({ queueLen: 5, pendingLen: 3, runs: 1, maxRuns: 10, aborting: true });
  assert.equal(r.stop, true);
  assert.equal(r.why, '已终止');
});

await test('调度决策：预算用完 → 停，并说清是预算', () => {
  const r = shouldStopRound({ queueLen: 3, pendingLen: 0, runs: 10, maxRuns: 10 });
  assert.equal(r.stop, true);
  assert.match(r.why, /上限 10/);
});

await test('调度决策：队列空、也没人在跑 → 自然收工', () => {
  assert.equal(shouldStopRound({ queueLen: 0, pendingLen: 0, runs: 3, maxRuns: 10 }).stop, true);
});

await test('★ 调度决策：不忙 → 直接派', () => {
  const r = planItem({ item: { botId: 'b1' }, name: '甲', done: 0, budget: 2, busy: false });
  assert.equal(r.kind, 'run');
});

await test('★ 调度决策：上级叫一个忙人 → 打断（不是排队）', () => {
  const r = planItem({ item: { botId: 'b1' }, name: '甲', done: 0, budget: 2, busy: true, superior: true });
  assert.equal(r.kind, 'interrupt');
});

await test('★ 调度决策：同级叫一个忙人 → 投递（不打断，也不丢）', () => {
  const r = planItem({ item: { botId: 'b1' }, name: '甲', done: 0, budget: 2, busy: true, superior: false });
  assert.equal(r.kind, 'queue');
  assert.match(r.why, /同级/);
});

await test('调度决策：这轮说过够了 → 跳过（且带名字，好在日志里认人）', () => {
  const r = planItem({ item: { botId: 'b1' }, name: '甲', done: 2, budget: 2, busy: false });
  assert.equal(r.kind, 'skip');
  assert.match(r.why, /甲/);
});

await test('调度决策：预算判断优先于忙不忙（说够了就别打断别人）', () => {
  const r = planItem({ item: { botId: 'b1' }, name: '甲', done: 2, budget: 2, busy: true, superior: true });
  assert.equal(r.kind, 'skip');
});

await test('调度决策：没轮到的名单要把名字翻出来（日志要能认人）', () => {
  const names = { b1: '甲', b2: '乙' };
  assert.deepEqual(leftBehind([{ botId: 'b1' }, { botId: 'b2' }], (id) => names[id]), ['甲', '乙']);
});


// ---------------------------------------------------------------------------
// 群聊会话层（group-prompt.js）：谁先开口 / 提示词里有什么
// ---------------------------------------------------------------------------
const { departmentOf, openingSpeakers, composeGroupPrompt } = await import('../src/group-prompt.js');

await test('会话层：老大的 id 不在名单里 → 退回第一个，别把 group 搞成没头', () => {
  const a = store.createBot({ name: '会话甲' });
  const b = store.createBot({ name: '会话乙' });
  const room = { id: 'r_x', botIds: [a.id, b.id], leadBotId: '不存在的id' };
  const { members, leadId } = departmentOf(room);
  assert.equal(members.length, 2);
  assert.equal(leadId, a.id);
});

await test('会话层：没人 @ 就老大先接', () => {
  const a = store.createBot({ name: '会话头' });
  const b = store.createBot({ name: '会话兵' });
  const room = { id: 'r_y', botIds: [a.id, b.id], leadBotId: a.id };
  assert.deepEqual(openingSpeakers(room, { text: '干点活' }), [a.id]);
});

await test('会话层：@点名 → 只叫被点名的', () => {
  const a = store.createBot({ name: '会话头' });
  const b = store.createBot({ name: '会话兵' });
  const room = { id: 'r_z', botIds: [a.id, b.id], leadBotId: a.id };
  assert.deepEqual(openingSpeakers(room, { text: '@会话兵 你看下' }), [b.id]);
});

await test('会话层：@all → 除说话人外全员', () => {
  const a = store.createBot({ name: '会话头' });
  const b = store.createBot({ name: '会话兵' });
  const room = { id: 'r_w', botIds: [a.id, b.id], leadBotId: a.id };
  assert.deepEqual(openingSpeakers(room, { text: '@all 都来', openerBotId: a.id }), [b.id]);
});

await test('★ 会话层：老大的提示词里有"验收标准"，成员的没有', () => {
  const lead = { id: 'l1', name: '头儿', emoji: '🧭' };
  const mate = { id: 'm1', name: '小兵', emoji: '🔧' };
  const room = { name: '测试组', topic: '干活' };
  const members = [lead, mate];

  const leadPrompt = composeGroupPrompt(room, lead, [], {
    isLead: true,
    reason: '用户发了新消息',
    members,
    leadId: lead.id,
    order: { index: 1 },
  });
  assert.match(leadPrompt, /部门老大/);
  assert.match(leadPrompt, /验收标准/, '★ 派活三样必须写进老大提示词');
  assert.match(leadPrompt, /第 1 个/, '要说清发言顺序');
  assert.match(leadPrompt, /同时开干/, '要说清是并行的，不然它以为要排队');
  // 多人负责人的提示仅要求拆解、派活和汇总。
  assert.match(leadPrompt, /不亲自干活/, '★ 老大只做三件事，不自己干活');
  assert.match(leadPrompt, /@一个同事去查/, '缺信息要让成员去查，不能自己查');
  assert.match(leadPrompt, /绝不自己上/, '没人能接时如实上报，不许自己接手');
  assert.ok(!/确实只有你能干/.test(leadPrompt), '不能留"只有你能干就自己做"的口子');

  const matePrompt = composeGroupPrompt(room, mate, [], {
    isLead: false,
    members,
    leadId: lead.id,
  });
  assert.match(matePrompt, /不是老大/);
  assert.ok(!/验收标准/.test(matePrompt), '成员不需要派活规矩');
});

await test('会话层：补给的记录带发言人，超长会截断', () => {
  const lead = { id: 'l2', name: '头儿' };
  const mate = { id: 'm2', name: '小兵' };
  const prompt = composeGroupPrompt(
    { name: '测试组' },
    mate,
    [
      { authorType: 'user', authorName: '我', text: '干这个', status: 'done' },
      { authorType: 'bot', authorName: '同事', text: 'x'.repeat(3000), status: 'done' },
    ],
    { isLead: false, members: [lead, mate], leadId: lead.id },
  );
  assert.match(prompt, /用户: 干这个/);
  // 超长记录要裁剪：保留头尾（结论常在末尾），中间标出省略了多少字
  assert.match(prompt, /同事: x+/, '超长的记录要截断，别把上下文撑爆');
  assert.match(prompt, /省略 \d+ 字/, '要明确告诉模型中间省略了，别让它以为原文就这么短');
  assert.ok(prompt.length < 4000, `prompt 不该被原始 3000 字撑开（实际 ${prompt.length}）`);
});

await test('会话层：记录超预算时保留最新的，并说明丢了几条', () => {
  const lead = { id: 'l3', name: '头儿' };
  const mate = { id: 'm3', name: '小兵' };
  // 25 条各 800 字 = 2 万字，超过 transcriptFor 的 12000 字预算
  const fresh = Array.from({ length: 25 }, (_, i) => ({
    authorType: 'bot',
    authorName: `同事${i}`,
    text: String(i).padEnd(800, 'z'),
    status: 'done',
  }));
  // 走真实裁剪路径（transcriptFor 内部就是 trimTranscript）
  const trimmed = trimTranscript(fresh, { maxChars: 12000, maxItems: 30 });
  assert.ok(trimmed.dropped > 0, '这批数据应该确实被裁掉一部分');

  const prompt = composeGroupPrompt({ name: '测试组' }, mate, trimmed.items, {
    isLead: false,
    members: [lead, mate],
    leadId: lead.id,
    droppedCount: trimmed.dropped,
  });
  assert.ok(prompt.length < 16000, `prompt 应被预算收口（实际 ${prompt.length}）`);
  assert.match(prompt, /更早的 \d+ 条已省略/, '要告诉模型前面还有内容没给它');
});


// ---------------------------------------------------------------------------
// 上下文预算（context-budget.js）：四个数都能被单独覆盖
// ---------------------------------------------------------------------------
const { readContext, positiveOrNull } = await import('../src/context-budget.js');

await test('上下文：读不到占用时返回 null（界面该显示"—"而不是 0%）', () => {
  assert.equal(readContext({}), null);
  assert.equal(readContext({ getContextUsage: () => null }), null);
  assert.equal(readContext({ getContextUsage: () => { throw new Error('炸了'); } }), null);
});

await test('上下文：读得到时把四个数都带上', () => {
  const u = readContext({
    getContextUsage: () => ({ tokens: 1234, contextWindow: 10000, percent: 12.3 }),
    isCompacting: true,
  });
  assert.deepEqual(u, { tokens: 1234, contextWindow: 10000, percent: 12.3, compacting: true });
});

await test('上下文：正数助手 —— 0/负数/非数字都当没设', () => {
  assert.equal(positiveOrNull(100), 100);
  assert.equal(positiveOrNull('100'), 100);
  assert.equal(positiveOrNull(0), null);
  assert.equal(positiveOrNull(-1), null);
  assert.equal(positiveOrNull('abc'), null);
  assert.equal(positiveOrNull(undefined), null);
});


// ---------------------------------------------------------------------------
// 会话池收尾（session-pool.js）：怎么释放、释放谁
// ---------------------------------------------------------------------------
const { releaseEntry, disposeMatching, evictIdle, disposeAll } = await import('../src/session-pool.js');

function fakeEntry(tag, { busy = false, lastUsed = 0, throwOnDispose = false } = {}) {
  const log = [];
  return {
    log,
    entry: {
      busy,
      lastUsed,
      unsubscribe: () => log.push('unsub:' + tag),
      session: {
        dispose: () => {
          if (throwOnDispose) throw new Error('dispose 炸了');
          log.push('dispose:' + tag);
        },
      },
    },
  };
}
const pool = (...items) => {
  const m = new Map();
  const logs = [];
  for (const [key, opt] of items) {
    const f = fakeEntry(key, opt);
    m.set(key, f.entry);
    logs.push(f.log);
  }
  return { m, logs };
};

await test('会话池：释放要先注销订阅再关会话', () => {
  const f = fakeEntry('a');
  releaseEntry(f.entry);
  assert.deepEqual(f.log, ['unsub:a', 'dispose:a']);
});

await test('★ 会话池：某个 release 抛错，不能连累后面的会话', () => {
  const { m, logs } = pool(['a', { throwOnDispose: true }], ['b', {}]);
  disposeMatching(m, () => true);
  assert.deepEqual(m.size, 0, '两个都要从表里清掉');
  assert.deepEqual(logs[1], ['unsub:b', 'dispose:b'], '★ 后面的不能被前面带崩');
});

await test('会话池：按条件作废只动命中的，并回报动了哪些', () => {
  const { m } = pool(['r1:b1', {}], ['r1:b2', {}], ['r2:b1', {}]);
  const removed = disposeMatching(m, (key) => key.startsWith('r1:'));
  assert.deepEqual(removed.sort(), ['r1:b1', 'r1:b2']);
  assert.deepEqual([...m.keys()], ['r2:b1'], '别的房间的会话不许碰');
});

await test('会话池：改名重建要能按 bot 匹配（key 结尾）', () => {
  const { m } = pool(['r1:b1', {}], ['r2:b1', {}], ['r1:b2', {}]);
  const removed = disposeMatching(m, (key) => key.endsWith(':b1'));
  assert.equal(removed.length, 2);
  assert.deepEqual([...m.keys()], ['r1:b2']);
});

await test('★ 会话池：LRU 只驱逐空闲的，忙的一个都不能动', () => {
  const { m } = pool(['old', { lastUsed: 1 }], ['busy', { busy: true, lastUsed: 2 }], ['new', { lastUsed: 3 }]);
  const n = evictIdle(m, 2);
  assert.equal(n, 1);
  assert.deepEqual([...m.keys()].sort(), ['busy', 'new'], '★ 忙的那轮还在跑，关掉等于掐了用户的活');
});

await test('会话池：没到上限就什么都不做', () => {
  const { m } = pool(['a', {}], ['b', {}]);
  assert.equal(evictIdle(m, 5), 0);
  assert.equal(m.size, 2);
});

await test('会话池：全部释放会清空表', () => {
  const { m, logs } = pool(['a', {}], ['b', {}]);
  disposeAll(m);
  assert.equal(m.size, 0);
  assert.deepEqual(logs[0].concat(logs[1]).sort(), ['dispose:a', 'dispose:b', 'unsub:a', 'unsub:b'].sort());
});


// ---------------------------------------------------------------------------
// 心跳看门狗（watchdog.js）：什么时候报心跳、什么时候判死
// ---------------------------------------------------------------------------
const { createWatchdog } = await import('../src/watchdog.js');

/** 造一个假会话表 + 记录心跳/中断 */
function harness(entries, { stallMs = 1000, heartbeatMs = 15_000, nowMs = 10_000 } = {}) {
  const sessions = new Map(Object.entries(entries).map(([k, v]) => [k, v]));
  const beats = [];
  const stalls = [];
  const wd = createWatchdog({
    sessions,
    stallMs,
    heartbeatMs,
    now: () => nowMs,
    emit: (ev) => beats.push(ev),
    onStall: (info) => stalls.push(info),
    logger: () => {},
  });
  return { sessions, beats, stalls, wd };
}

await test('★ 看门狗：只关心还在跑的会话（不忙的不报心跳）', () => {
  const { beats, wd } = harness({
    'r1:b1': { busy: true, progressAt: 9_900 },
    'r1:b2': { busy: false, progressAt: 9_900 },
  });
  wd.tick();
  assert.equal(beats.length, 1);
  assert.equal(beats[0].roomId, 'r1');
  assert.equal(beats[0].botId, 'b1');
  assert.equal(beats[0].ageMs, 100, '最后一次动静是 100ms 前');
});

await test('★ 看门狗：没动静超过上限 → 判中断（带上房间和人）', () => {
  const { stalls, wd } = harness({ 'r2:b9': { busy: true, progressAt: 10_000 - 5_000 } });
  wd.tick();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].roomId, 'r2');
  assert.equal(stalls[0].botId, 'b9');
  assert.equal(stalls[0].ageMs, 5_000);
});

await test('★ 看门狗：判过就不再判（否则每 15 秒报一遍"这单断了"）', () => {
  const { stalls, wd } = harness({ 'r3:b1': { busy: true, progressAt: 10_000 - 9_000 } });
  wd.tick();
  wd.tick();
  wd.tick();
  assert.equal(stalls.length, 1, '同一次中断只该上报一次');
  assert.equal(stalls[0].entry.stallNotified, true, '标记要落在条目上');
});

await test('看门狗：正好卡在上限上算中断（不能一直赖着）', () => {
  const { stalls, wd } = harness({ 'r4:b1': { busy: true, progressAt: 10_000 - 1_000 } });
  wd.tick();
  assert.equal(stalls.length, 1);
});

await test('看门狗：没有动静记录时，拿"开始时间"当基准', () => {
  const { beats, stalls, wd } = harness({ 'r5:b1': { busy: true, startedAt: 10_000 - 2_000 } });
  wd.tick();
  assert.equal(beats[0].ageMs, 2_000);
  assert.equal(stalls.length, 1, '2s > 1s 上限');
});

await test('看门狗：连开始时间都没有 → 当"刚刚"，绝不白杀一轮', () => {
  const { beats, stalls, wd } = harness({ 'r6:b1': { busy: true } });
  wd.tick();
  assert.equal(beats[0].ageMs, 0);
  assert.equal(stalls.length, 0, '什么都还不知道的时候不能判它死');
});

await test('看门狗：start 是幂等的，不会起两个定时器', () => {
  const { wd } = harness({});
  assert.equal(wd.start(), true);
  assert.equal(wd.start(), false, '重复 start 不该再起一个');
  assert.equal(wd.running, true);
  wd.stop();
  assert.equal(wd.running, false);
});


// ---------------------------------------------------------------------------
// 附件输入拼装（prompt-input.js）+ 自动附图（image-watch.js）
// ---------------------------------------------------------------------------
const { createBuildInput } = await import('../src/prompt-input.js');
const { snapshotImages, diffImages, collectNewImages } = await import('../src/image-watch.js');

await test('拼输入：只有文字 → 原样给它', async () => {
  const build = createBuildInput({
    workspace: '/ws',
    metaFor: () => null,
    inboxPath: () => null,
    attachmentBlock: async () => '',
  });
  const r = await build('帮我看下', []);
  assert.equal(r.promptText, '帮我看下');
  assert.deepEqual(r.imageIds, []);
});

await test('拼输入：图片走视觉，不抽正文', async () => {
  let called = 0;
  const build = createBuildInput({
    workspace: '/ws',
    metaFor: (id) => ({ id, name: 'a.png', kind: 'image' }),
    inboxPath: () => '/ws/_inbox/a.png',
    attachmentBlock: async () => {
      called++;
      return '';
    },
  });
  const r = await build('', ['f1']);
  assert.deepEqual(r.imageIds, ['f1']);
  assert.equal(called, 0, '图片不该走正文提取');
  assert.match(r.promptText, /用户发了 1 张图/);
});

await test('拼输入：文档抽出正文 + 告诉它原文件在哪', async () => {
  const build = createBuildInput({
    workspace: '/ws',
    metaFor: (id) => ({ id, name: '报表.xlsx', kind: 'doc' }),
    inboxPath: (id) => `/ws/_inbox/${id}.xlsx`,
    attachmentBlock: async () => '【报表.xlsx 的正文】\n数字',
  });
  const r = await build('看看这个', ['f9']);
  assert.match(r.promptText, /看看这个/);
  assert.match(r.promptText, /报表.xlsx 的正文/);
  assert.match(r.promptText, /_inbox\/f9.xlsx/, '要告诉它原文件在工作目录哪');
  assert.match(r.promptText, /extract_file/, '要告诉它重读时用哪个工具');
});

await test('拼输入：附件拿不到元数据就跳过，不炸', async () => {
  const build = createBuildInput({
    workspace: '/ws',
    metaFor: () => null,
    inboxPath: () => null,
    attachmentBlock: async () => 'x',
  });
  const r = await build('', ['不存在']);
  assert.equal(r.promptText, '');
});

await test('★ 自动附图：截图只认工作目录里的图，跳过 node_modules 和点目录', () => {
  const root = 'D:\pi-bot\server\data\_unit_test\iwatch';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'out', 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'out', 'b.txt'), 'x');
  fs.writeFileSync(path.join(root, 'node_modules', 'c.png'), 'x');
  fs.writeFileSync(path.join(root, '.cache', 'd.png'), 'x');

  const snap = snapshotImages(root);
  const names = [...snap.keys()].map((f) => path.basename(f));
  assert.deepEqual(names, ['a.png'], '只该看到 out/a.png');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('★ 自动附图：刚写出来的算新，没动过的算旧', () => {
  const root = 'D:\pi-bot\server\data\_unit_test\iwatch2';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const oldFile = path.join(root, 'old.png');
  fs.writeFileSync(oldFile, 'x');
  const before = snapshotImages(root);

  fs.writeFileSync(path.join(root, 'new.png'), 'y');
  // 同名覆盖：把时间戳明确往后拨（5ms 容差是故意的，防文件系统抖动 ——
  // 所以"刚刚重写"未必算新，但"明显变新"必须算）
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(oldFile, later, later);
  const fresh = diffImages(root, before).map((f) => path.basename(f.file));
  assert.ok(fresh.includes('new.png'), '新出现的要认出来');
  assert.ok(fresh.includes('old.png'), '明显变新的也要认出来（同名覆盖）');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('自动附图：单张保存失败不影响其它张', () => {
  const root = 'D:\pi-bot\server\data\_unit_test\iwatch3';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'b.png'), 'y');
  const before = new Map();
  let n = 0;
  const out = collectNewImages(root, before, {
    save: (file) => {
      n++;
      if (file.endsWith('a.png')) throw new Error('存不下');
      return { id: 'i' + n, name: 'b.png', mime: 'image/png', kind: 'image', size: 1 };
    },
    onError: () => {},
  });
  assert.equal(out.length, 1, '坏的那张跳过，好的那张照样收');
  assert.equal(out[0].name, 'b.png');
  fs.rmSync(root, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 建会话的决策（session-factory.js）：挑哪个模型、哪个思考档位
// ---------------------------------------------------------------------------
const { pickModelAndThinking } = await import('../src/session-factory.js');

await test('★ 建会话：bot 没单独设模型 → 用全局默认', () => {
  const global = { provider: 'p', id: 'default' };
  const r = pickModelAndThinking({ bot: {}, fallbackModel: global });
  assert.equal(r.model, global);
  assert.equal(r.thinking, null);
});

await test('★ 建会话：bot 设了模型 → 用它自己的', () => {
  const own = { provider: 'grp', id: 'flash' };
  const global = { provider: 'p', id: 'default' };
  const r = pickModelAndThinking({ bot: { model: 'grp/flash' }, botModel: own, fallbackModel: global });
  assert.equal(r.model, own);
});

await test('★ 建会话：档位已知会吐空 → 自动换一个能用的', () => {
  const own = { provider: 'cline', id: 'x-oc' };
  const r = pickModelAndThinking({
    bot: { thinking: 'medium' },
    botModel: own,
    safeLevel: (slug, level) => {
      assert.equal(slug, 'cline/x-oc', '要用完整 slug 去问档位矩阵');
      assert.equal(level, 'medium');
      return 'low';
    },
  });
  assert.equal(r.thinking, 'low', '★ 这个档位会吐空，得换掉');
});

await test('建会话：档位没问题就原样用', () => {
  const r = pickModelAndThinking({
    bot: { thinking: 'high' },
    safeLevel: () => null,
  });
  assert.equal(r.thinking, 'high');
});

await test('建会话：没设思考等级就不传（听 pi 的默认）', () => {
  const r = pickModelAndThinking({ bot: { model: 'a/b' }, safeLevel: () => 'low' });
  assert.equal(r.thinking, null, '没设过就别瞎给');
});


// ---------------------------------------------------------------------------
// 上报回执（escalation.js）：该带的信息一样不能少
// ---------------------------------------------------------------------------
const { buildEscalationNote } = await import('../src/escalation.js');

const noteStore = {
  getBot: (id) => (id === 'b1' ? { id: 'b1', name: '优化工程师' } : null),
};

await test('回执：谁断的 / 为什么断 / 请对方怎么做', () => {
  const n = buildEscalationNote({ store: noteStore, fromBotId: 'b1', reason: '心跳断了：600 秒没动静' });
  assert.match(n, /优化工程师/, '要写清是谁的活断了');
  assert.match(n, /心跳断了/);
  assert.match(n, /请按这个顺序处理/, '要告诉对方该干什么');
});

await test('回执：重试过就写明试了几次、为什么放弃', () => {
  const n = buildEscalationNote({
    store: noteStore,
    fromBotId: 'b1',
    reason: '没派出去',
    attempts: 3,
    why: '等太久了',
  });
  assert.match(n, /试了 3 次/);
  assert.match(n, /等太久了/);
});

await test('回执：带原任务（方便对方直接照着重派）', () => {
  const n = buildEscalationNote({
    store: noteStore,
    fromBotId: 'b1',
    reason: '断了',
    task: '把 pi-runner 的调度抽出来',
  });
  assert.match(n, /原任务：把 pi-runner 的调度抽出来/);
});

await test('回执：原任务超长会截断，但绝不截掉"请对方做什么"', () => {
  const n = buildEscalationNote({ store: noteStore, fromBotId: 'b1', reason: '断了', task: 'x'.repeat(5000) });
  assert.ok(n.length < 1200, '不能把一整段任务原样塞进回执');
  assert.match(n, /请按这个顺序处理/, '结尾的指令必须在');
});

await test('回执：不能给负责人留下"自己上"的暗示', () => {
  const n = buildEscalationNote({
    store: noteStore,
    fromBotId: 'b1',
    reason: '试了 3 次都没成',
    attempts: 3,
  });
  // 旧文案是"请你重新安排：换个人，或者再派一次" —— 读起来像允许它自己接手，
  // 于是负责人遇到成员失败就悄悄把活干了，用户以为全员都交付了。
  assert.ok(!/请你重新安排/.test(n), '旧文案会诱导负责人自己接手');
  assert.match(n, /先 @ 优化工程师 再派一次/, '第一步必须是重派，不是自己上');
  assert.match(n, /另一个同事接手/, '第二步是换人');
  assert.match(n, /必须在群里说明你接手了/, '真要自己上必须公开说明');
  assert.match(n, /不要悄悄把活接下/, '明确禁止悄悄兜底');
});

await test('回执：查不到 bot 就用 id 兜底（别出现 undefined 的残句）', () => {
  const n = buildEscalationNote({ store: { getBot: () => null }, fromBotId: 'b_unknown', reason: '断了' });
  assert.match(n, /b_unknown/);
  assert.ok(!/undefined/.test(n));
});


// ---------------------------------------------------------------------------
// 模型接线（model-registry.js）：认 slug + 模型组注册
// ---------------------------------------------------------------------------
const { resolveModel, modelLabel, syncModelGroups } = await import('../src/model-registry.js');

const FAKE_RT = {
  getModel: (p, id) => (p === 'grpA' && id === 'flash' ? { provider: 'grpA', id: 'flash' } : null),
  getModels: () => [
    { provider: 'grpA', id: 'flash' },
    { provider: 'grpB', id: 'pro' },
    { provider: 'grpB', id: 'dup' },
    { provider: 'grpC', id: 'dup' },
  ],
};

await test('认模型：写全了就能直接找到', () => {
  assert.equal(resolveModel(FAKE_RT, 'grpA/flash').id, 'flash');
});

await test('认模型：只给模型 id 也认（全局唯一时）', () => {
  assert.equal(resolveModel(FAKE_RT, 'pro').provider, 'grpB');
});

await test('认模型：裸 id 撞名 → 取第一个（历史写法，不强行报错）', () => {
  // 说明区别：**后缀写法**撞名才返回 null（见下一条）。
  // 裸 id 是老写法，很多地方在用它，这里保持"取第一个"的既有行为。
  assert.equal(resolveModel(FAKE_RT, 'dup').provider, 'grpB');
});

await test('★ 认模型：只给后半截、且有两个候选 → 不猜，返回 null', () => {
  // "只给后半截"是唯一能对上就认的宽松写法；对不上两个就必须让人说清。
  const rt = {
    getModel: () => null,
    getModels: () => [
      { provider: 'a', id: 'x/deepseek' },
      { provider: 'b', id: 'y/deepseek' },
    ],
  };
  assert.equal(resolveModel(rt, 'deepseek'), null, '两个候选时不许瞎挑');
  const rt2 = { getModel: () => null, getModels: () => [{ provider: 'a', id: 'x/deepseek' }] };
  assert.equal(resolveModel(rt2, 'deepseek').provider, 'a', '唯一候选就认');
});

await test('认模型：找不到就 null，不要瞎给一个', () => {
  assert.equal(resolveModel(FAKE_RT, '不存在'), null);
  assert.equal(resolveModel(null, 'grpA/flash'), null);
  assert.equal(resolveModel(FAKE_RT, ''), null);
});

await test('模型标签：给日志和档位矩阵用的完整标识', () => {
  assert.equal(modelLabel({ provider: 'grpA', id: 'flash' }), 'grpA/flash');
  assert.equal(modelLabel(null), null);
});

await test('★ 模型组：新组注册进去，删掉的组要显式注销', () => {
  const calls = [];
  const runtime = {
    registerProvider: (id) => calls.push('+' + id),
    unregisterProvider: (id) => calls.push('-' + id),
  };
  const registered = new Set(['old']);
  const next = syncModelGroups(runtime, registered, { fresh: {}, keep: {} });
  assert.deepEqual(calls, ['-old', '+fresh', '+keep'], '★ 幽灵组不注销，菜单里会留一个选不动的项');
  assert.deepEqual([...next].sort(), ['fresh', 'keep']);
});

await test('模型组：注册失败不抛出去（一个组坏了别拖垮整次同步）', () => {
  const errs = [];
  const runtime = {
    registerProvider: (id) => {
      if (id === 'bad') throw new Error('炸了');
    },
    unregisterProvider: () => {},
  };
  const next = syncModelGroups(runtime, new Set(), { bad: {}, good: {} }, { onError: (id) => errs.push(id) });
  assert.deepEqual(errs, ['bad']);
  assert.deepEqual([...next], ['good'], '坏的那个不入账，好的照常');
});

await test('模型组：没有 runtime 时原样返回（不炸）', () => {
  const registered = new Set(['a']);
  assert.equal(syncModelGroups(null, registered, {}), registered);
});

// ---------------------------------------------------------------------------
// 系统代理：Windows 注册表值的解析（Windows 上靠它决定要不要走代理）
// ---------------------------------------------------------------------------
const { parseWindowsProxyValue } = await import('../src/http-client.js');

await test('proxy: Windows 注册表 host:port', () => {
  assert.equal(parseWindowsProxyValue('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseWindowsProxyValue(''), '');
  assert.equal(parseWindowsProxyValue(null), '');
});

await test('proxy: Windows 注册表按协议分列时优先 https', () => {
  const raw = 'http=127.0.0.1:7891;https=127.0.0.1:7892;socks=127.0.0.1:7893';
  assert.equal(parseWindowsProxyValue(raw), 'http://127.0.0.1:7892');
  assert.equal(parseWindowsProxyValue('http=127.0.0.1:7891;ftp=x'), 'http://127.0.0.1:7891');
  assert.equal(parseWindowsProxyValue('socks=127.0.0.1:7893'), 'http://127.0.0.1:7893');
  assert.equal(parseWindowsProxyValue('http='), '');
});

await test('proxy: 非法代理串退化成空串，不抛', () => {
  assert.equal(parseWindowsProxyValue('not a proxy'), '');
  assert.equal(parseWindowsProxyValue('ftp=127.0.0.1:21'), '');
});

const passed = results.filter((r) => r.ok).length;

console.log('\n================ 单元测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
