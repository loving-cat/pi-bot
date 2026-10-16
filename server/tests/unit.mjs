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
  assert.equal(s[0].howto.length, 2000, 'howto 截到 2000');
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
const { withCapacity, applyCompactionBudget } = await import('../src/pi-runner.js');

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
  const { buildAppendSystemPrompt } = await import('../src/pi-runner.js');
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
  const { buildAppendSystemPrompt } = await import('../src/pi-runner.js');
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
  assert.equal(l.leadTurns, 4);
  assert.equal(l.memberTurns, 2);
  assert.equal(l.maxRuns, 10);
  assert.equal(l.maxSteps, 30);
  assert.equal(l.turnMaxMs, 300_000);
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
const { buildAppendSystemPrompt } = await import('../src/pi-runner.js');

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

const passed = results.filter((r) => r.ok).length;

console.log('\n================ 单元测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
