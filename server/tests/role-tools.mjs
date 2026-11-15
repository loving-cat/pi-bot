/** 角色能力与缓存回归；使用临时状态、SDK适配器和执行替身，不连接模型或外部服务。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-role-tools-'));
const keep = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']);
for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];
Object.assign(process.env, {
  HOME: path.join(root, 'home'), PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_HOME: path.join(root, 'data'), PI_BOT_WORKSPACE: path.join(root, 'workspace'),
  PI_BOT_MODEL: '', PI_BOT_WATCH_CHANGES: '0', PI_BOT_AUTO_ATTACH_IMAGES: '0',
  PI_BOT_EXTENSIONS: '1', PI_BOT_MCP: '1',
});
for (const dir of [process.env.HOME, process.env.PI_CODING_AGENT_DIR, process.env.PI_BOT_WORKSPACE]) fs.mkdirSync(dir, { recursive: true });
globalThis.fetch = () => { throw new Error('fixture forbids network'); };

const { isLeadOfRoom, roleConfigurationKey, toolsForRole, leadToolAllowed } = await import('../src/role-tools.js');
const { store } = await import('../src/store.js');
const { createSessionBuilder } = await import('../src/session-factory.js');
const { composeGroupPrompt, departmentOf } = await import('../src/group-prompt.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { createEscalator } = await import('../src/escalation.js');
const { shells } = await import('../src/shells.js');
let shellCalls = 0;
shells.start = () => { shellCalls++; assert.fail('fixture forbids real commands'); };
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.log(`✗ ${name}: ${error.stack ?? error}`); }
}
const model = { provider: 'fixture', id: 'fixture', contextWindow: 10000, maxTokens: 1000 };
const runners = [];
function fixture() {
  const captures = [], runner = new PiRunner(), control = { beforeCreate: null };
  runner.model = model;
  runner.modelRuntime = { completeSimple: () => assert.fail('fixture forbids model calls') };
  const sessionApi = {
    getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
    SessionManager: { create: () => ({}), open: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options) { this.options = options; this.handlers = new Map(); this.mcp = []; }
      async reload() {
        const pi = { on: (name, fn) => this.handlers.set(name, fn),
          registerMcpServer: name => this.mcp.push(name), unregisterMcpServer() {} };
        for (const ext of this.options.extensionFactories) (ext.factory ?? ext)(pi);
      }
    },
    async createAgentSession(options) {
      captures.push(options);
      if (control.beforeCreate) await control.beforeCreate(captures.length);
      let listener;
      return { session: {
        model, options, disposed: false, settingsManager: { applyOverrides() {} },
        subscribe(fn) { listener = fn; return () => {}; },
        dispose() { this.disposed = true; }, async abort() {},
        async prompt() { listener({ type: 'message_end', message: {
          role: 'assistant', content: [{ type: 'text', text: 'fixture done' }],
        } }); },
      } };
    },
  };
  const builder = createSessionBuilder({ runner, health: null, resolveModel: () => null, modelLabel: () => '', sessionApi });
  runner.__buildSession = builder;
  runners.push(runner);
  return { runner, builder, captures, control };
}
function department() {
  const lead = store.createBot({ name: 'fixture lead' }), member = store.createBot({ name: 'fixture member' });
  return { lead, member, room: store.createGroup({ name: 'fixture department', botIds: [lead.id, member.id], leadBotId: lead.id }) };
}
const guard = (options, toolName) => options.resourceLoader.handlers.get('tool_call')({ toolName, input: { command: 'fixture-command' } });
async function run(f, room, bot) {
  const result = await f.runner.run(room.id, bot.id, 'fixture task');
  assert.equal(result.ok, true, result.error);
  return f.runner.sessions.get(`${room.id}:${bot.id}`);
}

try {
  await test('单人、重复成员及私聊不降权；隐式负责人变化改变缓存签名', () => {
    assert.equal(isLeadOfRoom({ kind: 'group', botIds: ['a', 'a'] }, 'a'), false);
    assert.equal(isLeadOfRoom({ kind: 'dm', botIds: ['a', 'b'] }, 'a'), false);
    assert.equal(isLeadOfRoom({ kind: 'group', botIds: ['a', 'b'], leadBotId: 'missing' }, 'a'), true);
    assert.notEqual(roleConfigurationKey({ kind: 'group', botIds: ['a', 'b'] }, { id: 'a' }),
      roleConfigurationKey({ kind: 'group', botIds: ['b', 'a'] }, { id: 'a' }));
  });
  await test('负责人配置给了执行工具就给，不给就没有（配置说了算）', () => {
    // ★ 老版本这里是反的：即便把 bash 写进 leadTools 也会被静默过滤掉，
    //   而拦截理由写的是"请把这项操作交给成员执行"，用户根本看不出问题在哪。
    //   现在能力边界只由配置 + 只读策略决定。
    assert.deepEqual(
      toolsForRole({ isDeptLead: true, leadTools: ['read', 'bash', 'write', 'run_background'] }),
      ['read', 'bash', 'write', 'run_background'],
    );
    // 没配置的执行工具不会凭空出现
    assert.deepEqual(toolsForRole({ isDeptLead: true, leadTools: ['read', 'ls'] }), ['read', 'ls']);
    // 组织类工具恒放行（那是负责人的本职通道）
    assert.equal(leadToolAllowed('list_bots', ['read']), true);
    // 没配置 + 不是组织类 → 不给
    assert.equal(leadToolAllowed('mcp_fixture_write', ['read']), false);
  });
  await test('真实会话工厂只注册负责人的只读和调度工具，并禁止外部扩展', async () => {
    const f = fixture(), { room, lead } = department();
    const o = (await f.builder(room.id, lead.id)).session.options;
    // 负责人现在还有 git（用户产品要求：负责人对自己的任务有 git 权限）。
    // 只到本地提交这一层 —— push/merge 在 git-ops 的白名单里根本没有。
    // ★ 负责人现在有手：文件与命令工具都在（用户 2026-11-15 的产品要求）。
    //   「先派后干」是提示词层面的行为规矩，不再靠断能力实现。
    for (const tool of ['read', 'write', 'edit', 'bash']) {
      assert.ok(o.tools.includes(tool), `负责人应当能 ${tool}`);
    }
    for (const tool of ['list_bots', 'read_department', 'message_bot', 'git_commit']) {
      assert.ok(o.tools.includes(tool), `负责人应当能 ${tool}`);
    }
    assert.equal(o.resourceLoader.options.noExtensions, true);
    assert.equal(o.resourceLoader.options.noMcp, true);
    assert.equal(guard(o, 'read'), undefined);
    assert.notEqual((await o.customTools.find(t => t.name === 'list_bots').execute('fixture-call', {})).isError, true);
  });
  await test('负责人不挂载MCP，成员和主控的工具与外部能力保持原样', async () => {
    const f = fixture(), { room, lead, member } = department();
    assert.ok(store.addMcpServer({ name: 'fixture_mcp', command: 'fixture-command', enabled: true }).server);
    const chief = store.getBot('chief');
    for (const bot of [lead, member, chief]) store.updateBot(bot.id, { mcpServers: ['fixture_mcp'] });
    const a = (await f.builder(room.id, lead.id)).session.options;
    const b = (await f.builder(room.id, member.id)).session.options;
    const c = (await f.builder(store.ensureDm(chief.id).id, chief.id)).session.options;
    assert.deepEqual(a.resourceLoader.mcp, []);
    assert.deepEqual(b.resourceLoader.mcp, ['fixture_mcp']);
    assert.deepEqual(c.resourceLoader.mcp, ['fixture_mcp']);
    assert.ok(b.tools.includes('bash') && b.tools.includes('run_background'));
    assert.ok(c.tools.includes('create_bot') && c.tools.includes('run_background'));
    assert.equal(b.resourceLoader.options.noExtensions, false);
    assert.equal(c.resourceLoader.options.noMcp, false);
    assert.equal(guard(b, 'run_background'), undefined);
    assert.equal(guard(c, 'run_background'), undefined);
  });
  await test('晋升后旧会话仍然能执行（能力不再随角色消失），审批也走原有路径', async () => {
    const f = fixture(), { room, member } = department();
    const o = (await f.builder(room.id, member.id)).session.options;
    store.updateRoom(room.id, { leadBotId: member.id });
    store.updatePolicy({ dangerous: 'ask' });
    store.grantApproval({ roomId: room.id, botId: member.id });
    // 负责人不再是“只能派活”的角色，所以晋升不该把能力收走 ——
    // 只读/审批那两道门照旧生效（这里 ask 档会要审批，但不会说“交给成员执行”）。
    store.updatePolicy({ dangerous: 'allow' });
    for (const tool of ['bash', 'write', 'edit', 'run_background']) {
      const v = guard(o, tool);
      assert.ok(!String(v?.reason ?? '').includes('交给成员执行'), `${tool} 不该因为“是负责人”被拦`);
    }
    assert.equal(guard(o, 'list_bots'), undefined);
  });
  await test('单人部门同时拿到执行工具和执行提示，不要求向不存在的同事派活', async () => {
    const f = fixture(), bot = store.createBot({ name: 'fixture solo' });
    const room = store.createGroup({ name: 'fixture solo department', botIds: [bot.id], leadBotId: bot.id });
    const o = (await f.builder(room.id, bot.id)).session.options;
    const prompt = composeGroupPrompt(room, bot, [], { isLead: true, ...departmentOf(room) });
    assert.ok(o.tools.includes('bash'));
    assert.match(prompt, /当前唯一的执行成员/);
    assert.match(prompt, /自行查询、执行并提交结果/);
    assert.doesNotMatch(prompt, /你不亲自干活|绝不自己上|@一个同事去查/);
  });
  await test('实际失败上报：负责人和主控都自己上，只是措辞不同', async () => {
    const { room, lead, member } = department();
    const calls = [];
    const escalate = createEscalator({ store, run: async (...args) => { calls.push(args); } });
    const delegated = await escalate({ roomId: room.id, fromBotId: member.id, reason: 'fixture failure' });
    assert.equal(delegated.hostId, lead.id);
    assert.equal(calls[0][0], room.id);
    assert.equal(calls[0][1], lead.id);
    // ★ 用户 2026-11-15 的要求：活不能因为“没人能接”就停在那里等用户。
    assert.match(calls[0][2], /你自己上/, '负责人没人能接时要自己上');
    assert.match(calls[0][2], /接手了/, '接手要公开说明');
    assert.doesNotMatch(calls[0][2], /等待用户决定，不自行执行/);
    const elevated = await escalate({ roomId: room.id, fromBotId: lead.id, reason: 'fixture failure' });
    assert.equal(elevated.hostId, store.mainBot().id);
    assert.equal(store.getRoom(calls[1][0]).kind, 'dm');
    assert.match(calls[1][2], /你自己上/);
  });
  await test('真实runner在负责人互换后重建双方会话，晋升和降级工具都更新', async () => {
    const f = fixture(), { room, lead, member } = department();
    const a = await run(f, room, lead), b = await run(f, room, member);
    store.updateRoom(room.id, { leadBotId: member.id });
    const newLead = await run(f, room, member), newMember = await run(f, room, lead);
    assert.equal(f.captures.length, 4);
    assert.equal(a.session.disposed, true);
    assert.equal(b.session.disposed, true);
    // 两个角色都有手，区别只在提示词里的行为规矩
    assert.equal(newLead.session.options.tools.includes('bash'), true);
    assert.equal(newMember.session.options.tools.includes('bash'), true);
  });
  await test('忙碌会话延后释放，期间执行守门生效，下一轮使用新能力', async () => {
    const f = fixture(), { room, member } = department();
    const entry = await run(f, room, member);
    entry.busy = true;
    store.updateRoom(room.id, { leadBotId: member.id });
    assert.equal((await f.runner.run(room.id, member.id, 'fixture second')).code, 'SESSION_BUSY');
    assert.equal(entry.session.disposed, false);
    assert.equal(entry.reloadPending, true);
    entry.busy = false;
    assert.equal((await run(f, room, member)).session.options.tools.includes('bash'), true);
    assert.equal(entry.session.disposed, true);
    assert.equal(f.captures.length, 2);
  });
  await test('建会话期间变更角色，过期结果不会用于首轮执行', async () => {
    const f = fixture(), { room, member } = department();
    let ready, release;
    const started = new Promise(resolve => { ready = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    f.control.beforeCreate = async count => { if (count === 1) { ready(); await gate; } };
    const pending = f.runner.run(room.id, member.id, 'fixture pending');
    await started;
    store.updateRoom(room.id, { leadBotId: member.id });
    release();
    assert.equal((await pending).ok, true);
    assert.equal(f.captures.length, 2);
    const current = f.runner.sessions.get(`${room.id}:${member.id}`);
    assert.equal(current.session.options.tools.includes('bash'), true);
    assert.equal(current.configurationCurrent(), true);
  });
  await test('★ 成员增减不再改变执行能力（只改变提示词里的调度规矩）', async () => {
    // 老规则是“有同事就不能自己干”，于是同样一句话在单人部门和多人部门
    // 行为完全不同。现在两种房型都有手，差别只在提示词。
    const f = fixture(), bot = store.createBot({ name: 'fixture changing' }), peer = store.createBot({ name: 'fixture joining' });
    const room = store.createGroup({ name: 'fixture changing room', botIds: [bot.id], leadBotId: bot.id });
    const solo = (await run(f, room, bot)).session.options;
    assert.equal(solo.tools.includes('bash'), true);
    store.updateRoom(room.id, { botIds: [bot.id, peer.id] });
    const multi = (await run(f, room, bot)).session.options;
    assert.equal(multi.tools.includes('bash'), true, '多人部门里负责人也要能动手');
    assert.equal(f.captures.length, 2);
  });
} finally {
  for (const runner of runners) for (const entry of runner.sessions.values()) entry.session?.dispose();
  clearTimeout(store.saveTimer);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n角色能力回归：${passed}/${passed + failed} 通过`);
process.exitCode = failed ? 1 : 0;
