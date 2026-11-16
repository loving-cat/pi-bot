/**
 * 「Bot 申请 → 用户在手机批准 → 系统建授权」的测试（规格 §6.1）。
 *   node tests/grant-request.mjs
 *
 * ## 守什么
 *
 * 这条路是把"用户说一句就行"和"模型不能给自己扩权"接上的地方。
 * 三个方向错了都很严重：
 *
 *   1. **能申请的东西太宽**（比如能申请 `policy.change`）→ 一张卡就能把防线改掉；
 *   2. **不用手机就能批**（本机桌面批准）→ 主 Bot 能操作桌面，等于自己批自己；
 *   3. **批准后建出来的授权和 bot 的实际模式不匹配** → 是张废纸，
 *      用户以为给了权限，实际一直用不了。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  REQUESTABLE_ACTIONS, MAX_BOTS_PER_REQUEST, MAX_TTL_MS, NEEDS_DEVICE_CHANNEL,
  planGrantRequest, planGrantsFromRequest, describeGrantRequest, minChannelForRequest,
} = await import(src('grant-request.js'));
const { channelSufficesFor } = await import(src('confirm.js'));
const { ACTION, MODE } = await import(src('grants.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const NOW = 1_700_000_000_000;
const BOTS = [
  { id: 'b_main', name: '主控', role: 'main' },
  { id: 'b_coder', name: '编码手', role: 'member' },
];

// ---------------------------------------------------------------- 申请
test('申请能整理成一张可批准的请求', () => {
  const r = planGrantRequest({
    actions: [ACTION.desktopObserve, ACTION.desktopInput],
    bots: BOTS,
    ttlMs: 3600_000,
    reason: '要在这个部门跑一个网页工具',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.request.actions, [ACTION.desktopObserve, ACTION.desktopInput]);
  assert.equal(r.request.bots.length, 2);
  assert.match(r.request.reason, /网页工具/);
});

test('★ 危险动作不能从这条路申请（一张卡改防线是不行的）', () => {
  for (const bad of [ACTION.policyChange, ACTION.secretUse, ACTION.netSend, ACTION.gitDestructive, ACTION.fileDelete]) {
    const r = planGrantRequest({ actions: [bad], bots: BOTS });
    assert.equal(r.ok, false, `${bad} 不该能这样申请`);
    assert.equal(r.code, 'action_not_requestable');
    // 错误里要列出"能申请什么"，否则模型会反复试
    assert.match(r.text, /能申请的是/);
  }
});

test('可申请清单里不含改规矩 / 用凭据 / 对外发送 / 破坏性 Git', () => {
  for (const bad of [ACTION.policyChange, ACTION.secretUse, ACTION.netSend, ACTION.gitDestructive, ACTION.mcpAdd]) {
    assert.ok(!REQUESTABLE_ACTIONS.includes(bad), `${bad} 不该在可申请清单里`);
  }
});

test('重复动作去重；空动作拒', () => {
  const r = planGrantRequest({ actions: [ACTION.desktopInput, ACTION.desktopInput], bots: BOTS });
  assert.deepEqual(r.request.actions, [ACTION.desktopInput]);
  assert.equal(planGrantRequest({ actions: [], bots: BOTS }).ok, false);
});

test('一次申请太多 bot 会拒（卡片上要能数清）', () => {
  const many = Array.from({ length: MAX_BOTS_PER_REQUEST + 1 }, (_, i) => ({ id: `b${i}`, name: `b${i}` }));
  const r = planGrantRequest({ actions: [ACTION.desktopInput], bots: many });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_many_bots');
});

test('★ 期限夹在 5 分钟 ~ 24 小时之间（"永久授权"不存在）', () => {
  const short = planGrantRequest({ actions: [ACTION.desktopInput], bots: BOTS, ttlMs: 1000 });
  assert.equal(short.request.ttlMs, 5 * 60_000);
  const forever = planGrantRequest({ actions: [ACTION.desktopInput], bots: BOTS, ttlMs: 365 * 24 * 3600_000 });
  assert.equal(forever.request.ttlMs, MAX_TTL_MS);
});

// ---------------------------------------------------------------- 批准后建什么
test('★ 一条 bot 一条授权（好撤销、好审计、到期逐条失效）', () => {
  const req = planGrantRequest({ actions: [ACTION.desktopInput], bots: BOTS, ttlMs: 3600_000 }).request;
  const grants = planGrantsFromRequest({ request: req, approvedBy: { deviceName: 'iPhone' }, now: NOW });
  assert.equal(grants.length, 2);
  for (const g of grants) {
    assert.equal(g.source, 'user', '来源必须是"用户"，不能是模型');
    assert.match(g.sourceRef, /用户在批准卡片上同意/);
    assert.match(g.sourceRef, /iPhone/, '审计要看得出是哪台设备批的');
    assert.equal(g.expiresAt, NOW + 3600_000);
    assert.equal(g.canDelegate, false, '不能转授');
  }
});

test('★ mode 必须和那个 bot 的实际执行模式一致（否则是张废纸）', () => {
  const req = planGrantRequest({ actions: [ACTION.desktopInput], bots: BOTS }).request;
  const [main, member] = planGrantsFromRequest({ request: req, now: NOW });
  assert.equal(main.mode, MODE.host, '主 Bot 实际跑 host，发 project 模式它永远匹配不上');
  assert.equal(member.mode, MODE.project);
  assert.equal(main.subject.role, 'main');
});

test('动鼠标的授权风险档更高（审计按它分）', () => {
  const input = planGrantsFromRequest({
    request: planGrantRequest({ actions: [ACTION.desktopInput], bots: [BOTS[1]] }).request, now: NOW,
  })[0];
  const observe = planGrantsFromRequest({
    request: planGrantRequest({ actions: [ACTION.desktopObserve], bots: [BOTS[1]] }).request, now: NOW,
  })[0];
  assert.equal(input.risk, 'high');
  assert.equal(observe.risk, 'medium');
});

test('不带资源限制（目标是"整台机器/整张桌面"，写个路径是假的）', () => {
  const g = planGrantsFromRequest({
    request: planGrantRequest({ actions: [ACTION.desktopInput], bots: [BOTS[1]] }).request, now: NOW,
  })[0];
  assert.deepEqual(g.resources, []);
});

test('绑当前规矩版本（规矩变了要重新核对）', () => {
  const g = planGrantsFromRequest({
    request: planGrantRequest({ actions: [ACTION.desktopInput], bots: [BOTS[1]] }).request,
    now: NOW,
    policyRevision: 'rev-7',
  })[0];
  assert.equal(g.policyRevision, 'rev-7');
});

// ---------------------------------------------------------------- 卡片文案
test('卡片文案一眼能读懂（谁、能干什么、多久）', () => {
  const req = planGrantRequest({
    actions: [ACTION.desktopObserve, ACTION.desktopInput],
    bots: [BOTS[1]],
    ttlMs: 2 * 3600_000,
  }).request;
  const text = describeGrantRequest({ request: req });
  assert.match(text, /编码手/);
  assert.match(text, /看屏幕/);
  assert.match(text, /操作鼠标键盘/);
  assert.match(text, /小时/);
});

// ---------------------------------------------------------------- 端到端：批准之后真的能用
//
// 这一段是"接线"证明：走一遍 store → confirm → 批准 → 建 grant → 网关放行。
// 少了任何一环，用户点了批准而权限没出来 —— 那是最难查的那种"点了没用"。
test('★ 走完一遍：申请 → 手机批准 → 授权生效 → 网关放行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-grantreq-'));
  Object.assign(process.env, {
    PI_BOT_HOME: root, PI_BOT_WORKSPACE: path.join(root, 'ws'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_BOT_PROBE: '0',
  });
  for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const { store } = await import(src('store.js'));
  const { createGrantGate } = await import(src('grant-gate.js'));
  const { buildConfirmation } = await import(src('confirm.js'));

  const bot = store.createBot({ name: '编码手', role: 'member' });
  const gate = createGrantGate({
    store,
    currentPolicyRevision: () => store.policyVersion(),
    currentGeneration: () => 'g1',
  });

  // 申请前：网关拒绝
  assert.equal(gate.check({ subject: { botId: bot.id }, action: ACTION.desktopInput }).ok, false);

  const req = planGrantRequest({ actions: [ACTION.desktopInput], bots: [store.getBot(bot.id)] }).request;
  const confirmation = {
    ...buildConfirmation({
      id: 'cf_req_1', action: 'grant.request',
      target: { actions: req.actions, botIds: req.bots.map((b) => b.id), ttlMs: req.ttlMs },
      summary: 'test', requestedBy: 'b_main', roomId: 'r1',
      policyRevision: store.policyVersion(),
    }),
    targetJson: JSON.stringify(req),
  };
  store.requestConfirmation(confirmation);

  // ① 本机通道批准 → 不许（主 Bot 能点桌面，等于自己批自己）
  const local = store.decideConfirmation('cf_req_1', { approved: true, channel: 'local' });
  assert.equal(local.rejected, true, '本机桌面的批准不算数');

  // ② 手机通道批准 → 通过
  const ok2 = store.decideConfirmation('cf_req_1', {
    approved: true, channel: 'device', device: { id: 'd1', name: 'iPhone' },
  });
  assert.equal(ok2.decision, 'approved');

  // ③ 建授权（和 http 路由里那段同样的逻辑）
  const specs = planGrantsFromRequest({ request: req, approvedBy: { deviceName: 'iPhone' }, policyRevision: store.policyVersion() });
  for (const spec of specs) {
    const r = gate.add(spec);
    assert.equal(r.ok, true, r.text);
  }

  // ④ 现在网关放行
  const after = gate.check({ subject: { botId: bot.id }, action: ACTION.desktopInput });
  assert.equal(after.ok, true, '用户点了批准之后就该真的能用');
  clearTimeout(store.saveTimer);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 哪条要手机、哪条桌面就行
//
// 用户可能根本不用手机端。所以"一律要手机"是不可用的；"一律桌面"又等于
// 让能跑命令的 bot 自己点批准。判据是**这条申请批的是什么**：
// 批"能动手"的权限 → 手机；批"只能看"的 → 桌面。

test('★ 申请"动鼠标 / 跑命令 / 写文件 / 提交" → 要手机', () => {
  for (const a of NEEDS_DEVICE_CHANNEL) {
    assert.equal(minChannelForRequest({ actions: [a] }), 'device', `${a} 应当要手机`);
  }
  assert.equal(minChannelForRequest({ actions: [ACTION.desktopObserve, ACTION.desktopInput] }), 'device',
    '混着的时候按最严的算');
});

test('★ 申请只读（看屏幕 / 读文件 / 读仓库）→ 桌面点一下就行', () => {
  assert.equal(minChannelForRequest({ actions: [ACTION.desktopObserve] }), 'local');
  assert.equal(minChannelForRequest({ actions: [ACTION.fileRead, ACTION.gitRead] }), 'local');
});

test('★ 本机批准：默认拒（说明代价），开了设置才放行并标记 weakened', () => {
  // 默认：要手机
  const strict = channelSufficesFor({ channel: 'local', action: 'grant.request', minChannel: 'device' });
  assert.equal(strict.ok, false);
  assert.match(strict.reason, /手机上/);
  assert.match(strict.reason, /允许在本机批准/, '要告诉用户"不用手机端"时该怎么办');

  // 用户显式开了这个设置
  const weak = channelSufficesFor({
    channel: 'local', action: 'grant.request', minChannel: 'device', allowLocal: true,
  });
  assert.equal(weak.ok, true);
  assert.equal(weak.weakened, true, '要能被审计记下来"这条是按放宽设置批的"');
});

test('只读那条：桌面直接放行，不需要放宽设置', () => {
  const r = channelSufficesFor({ channel: 'local', action: 'grant.request', minChannel: 'local' });
  assert.equal(r.ok, true);
  assert.equal(r.weakened, undefined);
});

test('手机通道永远够格（不管门槛是哪个）', () => {
  for (const minChannel of ['local', 'device']) {
    const r = channelSufficesFor({ channel: 'device', action: 'grant.request', minChannel });
    assert.equal(r.ok, true);
  }
});

test('没有 minChannel 时按动作名推（不可撤销 → 手机）', () => {
  assert.equal(channelSufficesFor({ channel: 'local', action: 'git.push' }).ok, false);
  assert.equal(channelSufficesFor({ channel: 'device', action: 'git.push' }).ok, true);
});

// ---------------------------------------------------------------- 路由接线
//
// 上面那段证明"纯逻辑 + store"通；这一段证明**真的走 HTTP 批准**也会建授权。
// 少了这条，"用户点了批准、权限没出来"这种错只在生产里出现。
test('★ 走 HTTP 路由批准 → 真的多出授权（接线）', async () => {
  const http = await import('node:http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-grantreq-route-'));
  Object.assign(process.env, {
    PI_BOT_HOME: root, PI_BOT_WORKSPACE: path.join(root, 'ws'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_BOT_PROBE: '0',
  });
  for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // 换一套全新的 store/http 实例（前一个测试已经用掉了模块缓存）
  const storeMod = await import(`${src('store.js').href}?route=1`);
  const httpMod = await import(`${src('http.js').href}?route=1`);
  const grantMod = await import(`${src('grant-gate.js').href}?route=1`);
  const pairMod = await import(`${src('pairing.js').href}?route=1`);
  const reqMod = await import(`${src('grant-request.js').href}?route=1`);
  const confirmMod = await import(`${src('confirm.js').href}?route=1`);
  const gMod = await import(`${src('grants.js').href}?route=1`);

  const store = storeMod.store;
  const gate = grantMod.createGrantGate({
    store,
    currentPolicyRevision: () => store.policyVersion(),
    currentGeneration: () => 'g-route',
  });
  const server = httpMod.createHttpServer({
    runner: { grantGate: gate, modelLabel: () => 't', sessions: new Map(), isBusy: () => false, stats: null, health: null, model: 't', escalate: async () => {}, abortManagedTask: () => {}, contextUsage: () => ({}) },
    pairing: new pairMod.Pairing(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const TOKEN = 'tok_grantreq';
  store.state.devices[TOKEN] = { id: 'd_mobile', name: 'iPhone', createdAt: Date.now(), lastSeenAt: Date.now() };

  const bot = store.createBot({ name: '编码手', role: 'member' });
  const req = reqMod.planGrantRequest({ actions: [gMod.ACTION.desktopInput], bots: [store.getBot(bot.id)] }).request;
  const confirmation = {
    ...confirmMod.buildConfirmation({
      id: 'cf_route_1', action: 'grant.request',
      target: { actions: req.actions, botIds: req.bots.map((b) => b.id), ttlMs: req.ttlMs },
      summary: 'route test', requestedBy: 'b_main', roomId: 'r1',
      policyRevision: store.policyVersion(),
    }),
    targetJson: JSON.stringify(req),
  };
  store.requestConfirmation(confirmation);
  const before = (store.state.grants ?? []).length;

  const decide = (channel) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ approve: true });
    const r = http.request({
      host: '127.0.0.1', port, path: '/api/confirmations/cf_route_1/decide', method: 'POST',
      headers: {
        authorization: 'Bearer ' + TOKEN, 'x-pi-bot-client': 'app',
        'x-pi-bot-channel': channel,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(t); } catch { /* noop */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });

  // 本机通道：403（主 Bot 能点桌面，等于自己批自己）
  const weak = await decide('local');
  assert.equal(weak.status, 403);
  assert.equal((store.state.grants ?? []).length, before, '被拒时不能已经建了授权');

  // 手机通道：批准后真的多出一条
  const ok3 = await decide('device');
  assert.equal(ok3.status, 200, JSON.stringify(ok3.json));
  assert.ok(Array.isArray(ok3.json.granted) && ok3.json.granted.length === 1, '路由要回执建了哪几条');
  const after = (store.state.grants ?? []).filter((g) => g && !g.revokedAt);
  assert.ok(after.some((g) => (g.actions ?? []).includes(gMod.ACTION.desktopInput)), '批准后授权要真的落地');
  // 一次一用
  assert.ok(store.getConfirmation('cf_route_1').consumedAt, '批准过的票据要标成已用');

  // ---- 只读的申请：**桌面**就能批（用户不用手机端时的正常路径）----
  const readReq = reqMod.planGrantRequest({ actions: [gMod.ACTION.desktopObserve], bots: [store.getBot(bot.id)] }).request;
  store.requestConfirmation({
    ...confirmMod.buildConfirmation({
      id: 'cf_route_read', action: 'grant.request',
      target: { actions: readReq.actions, botIds: readReq.bots.map((b) => b.id), ttlMs: readReq.ttlMs },
      summary: 'read only', requestedBy: 'b_main', roomId: 'r1',
      policyRevision: store.policyVersion(),
      minChannel: reqMod.minChannelForRequest({ actions: readReq.actions }),
    }),
    targetJson: JSON.stringify(readReq),
  });
  const local = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ approve: true });
    const r = http.request({
      host: '127.0.0.1', port, path: '/api/confirmations/cf_route_read/decide', method: 'POST',
      headers: {
        authorization: 'Bearer ' + TOKEN, 'x-pi-bot-client': 'app',
        'x-pi-bot-channel': 'local',   // ← 桌面端
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(t); } catch { /* noop */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
  assert.equal(local.status, 200, `只读申请在桌面就能批：${JSON.stringify(local.json)}`);
  assert.ok((local.json.granted ?? []).length === 1);

  // ---- 开了「允许在本机批准」之后，连"动鼠标"那条也能在桌面上批 ----
  store.state.desktop = { ...(store.state.desktop ?? {}), allowLocalApproval: true };
  const inputReq2 = reqMod.planGrantRequest({ actions: [gMod.ACTION.cmdExec], bots: [store.getBot(bot.id)] }).request;
  store.requestConfirmation({
    ...confirmMod.buildConfirmation({
      id: 'cf_route_cmd', action: 'grant.request',
      target: { actions: inputReq2.actions, botIds: inputReq2.bots.map((b) => b.id), ttlMs: inputReq2.ttlMs },
      summary: 'cmd', requestedBy: 'b_main', roomId: 'r1',
      policyRevision: store.policyVersion(),
      minChannel: reqMod.minChannelForRequest({ actions: inputReq2.actions }),
    }),
    targetJson: JSON.stringify(inputReq2),
  });
  const weakened = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ approve: true });
    const r = http.request({
      host: '127.0.0.1', port, path: '/api/confirmations/cf_route_cmd/decide', method: 'POST',
      headers: {
        authorization: 'Bearer ' + TOKEN, 'x-pi-bot-client': 'app',
        'x-pi-bot-channel': 'local',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(t); } catch { /* noop */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
  assert.equal(weakened.status, 200, '开了设置之后桌面也能批');
  assert.equal(weakened.json.confirmation.channelWeakened, true, '要能被审计看出来"这条是按放宽设置批的"');

  server.close();
  clearTimeout(store.saveTimer);
  fs.rmSync(root, { recursive: true, force: true });
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
