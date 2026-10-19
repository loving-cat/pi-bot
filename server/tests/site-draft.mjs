/**
 * 主控接入 Web 系统：抓 → 草稿 → 用户确认 → 入库 → 建团队。
 *
 * 盯的是这条流程里最容易崩的两处：
 *   · 没确认就直接入库（用户没点头的东西不该落盘）
 *   · 草稿分批提交时把已有模块冲掉（主控抓完一页先记一笔，再继续抓）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-sitedraft-'));
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

const { siteDrafts, describeDraftForConfirm, draftConfirmOptions } = await import('../src/site-draft.js');
const { store } = await import('../src/store.js');
const { buildChiefTools } = await import('../src/tools.js');

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

const ROOM = 'room-main';
const BOT = 'bot-main';
const tool = (name) =>
  buildChiefTools({ runner: {}, health: null, roomId: ROOM, botId: BOT })
    .find((t) => t.name === name);

await test('stage_site 记下草稿，但不入库', async () => {
  const res = await tool('stage_site').execute('c1', {
    name: '投研系统',
    baseUrl: 'https://demo.example.com',
    account: 'alice',
    password: 'pw123456',
    modules: [
      { path: '/api/assets', name: '资产' },
      { path: '/api/trades', name: '交易' },
    ],
    summary: '有资产和交易两块',
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  // 关键：还没入库
  assert.equal(store.siteList().length, 0, '没确认就不该入库');
  const draft = siteDrafts.get(ROOM, BOT);
  assert.equal(draft.modules.length, 2);
  assert.equal(draft.account, 'alice');
});

await test('分批提交会合并而不是覆盖', async () => {
  await tool('stage_site').execute('c2', {
    modules: [{ path: '/api/reports', name: '报表' }],
  });
  const draft = siteDrafts.get(ROOM, BOT);
  assert.equal(draft.modules.length, 3, '三批合起来应有 3 个模块');
  assert.ok(draft.modules.some((m) => m.path === '/api/assets'), '旧模块不能被冲掉');
});

await test('同一路径重复提交只留一条', async () => {
  await tool('stage_site').execute('c3', {
    modules: [{ path: '/api/assets', name: '资产（改过名字）' }],
  });
  const draft = siteDrafts.get(ROOM, BOT);
  const assets = draft.modules.filter((m) => m.path === '/api/assets');
  assert.equal(assets.length, 1);
  assert.equal(assets[0].name, '资产（改过名字）', '后来的名字应生效');
});

await test('没有模块时拒绝建草稿（全新房间）', async () => {
  const t = buildChiefTools({ runner: {}, health: null, roomId: 'room-empty-mod', botId: BOT })
    .find((x) => x.name === 'stage_site');
  const res = await t.execute('c4', {
    name: '空系统',
    baseUrl: 'https://empty.example.com',
    modules: [],
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /模块/);
});

await test('换系统时旧模块会被清掉（不串到新站点）', async () => {
  // 先给 A 记两个模块
  const room = 'room-switch';
  const t = (n) => buildChiefTools({ runner: {}, health: null, roomId: room, botId: BOT })
    .find((x) => x.name === n);
  await t('stage_site').execute('cs1', {
    name: 'A系统', baseUrl: 'https://a.example.com',
    modules: [{ path: '/api/a1' }, { path: '/api/a2' }],
  });
  // 然后换成 B —— A 的模块不能留
  const r = await t('stage_site').execute('cs2', {
    name: 'B系统', baseUrl: 'https://b.example.com',
    modules: [{ path: '/api/b1' }],
  });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const draft = siteDrafts.get(room, BOT);
  assert.equal(draft.modules.length, 1, 'A 的模块应该被清掉');
  assert.equal(draft.modules[0].path, '/api/b1');
});

await test('地址不合法时拒绝', async () => {
  const t = buildChiefTools({ runner: {}, health: null, roomId: 'room-badurl', botId: BOT })
    .find((x) => x.name === 'stage_site');
  const res = await t.execute('c5', {
    name: 'x',
    baseUrl: 'demo.example.com',
    modules: [{ path: '/api/a' }],
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /http/);
});

await test('describeDraftForConfirm 不回显口令', () => {
  const draft = siteDrafts.get(ROOM, BOT);
  const text = describeDraftForConfirm(draft);
  assert.ok(!text.includes('pw123456'), '口令绝不能出现在给用户看的文本里');
  assert.match(text, /口令已收到/);
  assert.match(text, /投研系统/);
  assert.match(text, /\/api\/assets/);
});

await test('确认卡片有两个选项：接 / 不接', () => {
  const draft = siteDrafts.get(ROOM, BOT);
  const opts = draftConfirmOptions(draft);
  assert.equal(opts.length, 2);
  assert.match(opts[0].label, /确认/);
  assert.match(opts[1].label, /算了/);
});

await test('confirm_site 发出 ask 卡片（主控唯一允许发卡片的场景）', async () => {
  const res = await tool('confirm_site').execute('c6', {});
  assert.ok(!res.isError, res.content?.[0]?.text);
  const list = store.listMessages(ROOM, { limit: 10 });
  const card = list.find((m) => m.kind === 'ask');
  assert.ok(card, '应该写出一条确认卡片');
  assert.equal(card.meta.options.length, 2);
  // 还没入库
  assert.equal(store.siteList().length, 0);
});

await test('没有草稿时 confirm_site 报错而不是建空卡片', async () => {
  const res = await tool('confirm_site').execute('c7', {});
  // 上面那个用例已经发过卡片，但草稿还在，所以这里仍应成功
  // 用另一个房间验证"没草稿"的情况
  const otherTool = buildChiefTools({ runner: {}, health: null, roomId: 'room-empty', botId: BOT })
    .find((t) => t.name === 'confirm_site');
  const empty = await otherTool.execute('c8', {});
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /草稿/);
});

await test('★ commit_site 才真正入库并建团队', async () => {
  const before = store.siteList().length;
  const res = await tool('commit_site').execute('c9', {});
  assert.ok(!res.isError, res.content?.[0]?.text);

  const sites = store.siteList();
  assert.equal(sites.length, before + 1, '应该多了一个系统');
  const site = sites.find((s) => s.name === '投研系统');
  assert.ok(site, '系统应该被加进去');
  assert.equal(site.baseUrl, 'https://demo.example.com');
  assert.equal(site.account, 'alice');

  // 团队也建好了
  assert.ok(site.teamRoomId, '应该绑定团队房间');
  const room = store.getRoom(site.teamRoomId);
  assert.ok(room, '团队房间应该存在');
  assert.match(room.name, /投研系统/);
  // 团队里有人
  assert.ok(room.botIds.length >= 1, '团队至少要有一个人');
  const member = store.getBot(room.botIds[0]);
  assert.match(member.persona, /query_site/, '成员应该会用 query_site 查数据');
  // 成员带着摸到的模块清单
  assert.ok(
    member.skills.some((s) => s.howto.includes('/api/assets')),
    '成员应知道摸到的模块路径',
  );
});

await test('提交后草稿被清掉，不能重复提交', async () => {
  assert.equal(siteDrafts.get(ROOM, BOT), null, '草稿应该被消费掉');
  const res = await tool('commit_site').execute('c10', {});
  assert.equal(res.isError, true);
});

await test('discard_site 丢弃草稿', async () => {
  const room = 'room-discard';
  const t = (n) => buildChiefTools({ runner: {}, health: null, roomId: room, botId: BOT })
    .find((x) => x.name === n);
  await t('stage_site').execute('c11', {
    name: 'X系统', baseUrl: 'https://x.example.com', account: 'bob',
    modules: [{ path: '/api/x' }],
  });
  assert.ok(siteDrafts.get(room, BOT));
  const res = await t('discard_site').execute('c12', {});
  assert.ok(!res.isError);
  assert.equal(siteDrafts.get(room, BOT), null);
});

await test('没账号时 commit 被拦（不能建一个登不上去的系统）', async () => {
  const room = 'room-noaccount';
  const t = (n) => buildChiefTools({ runner: {}, health: null, roomId: room, botId: BOT })
    .find((x) => x.name === n);
  await t('stage_site').execute('c13', {
    name: '没账号系统', baseUrl: 'https://na.example.com',
    modules: [{ path: '/api/y' }],
  });
  const res = await t('commit_site').execute('c14', {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /账号/);
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} 通过，${failed} 失败`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
