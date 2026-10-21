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
  await test('负责人配置不能增加执行工具，未知工具默认拒绝', () => {
    assert.deepEqual(toolsForRole({ isDeptLead: true, leadTools: ['read', 'bash', 'write', 'run_background'] }), ['read']);
    for (const tool of ['bash', 'run_background', 'mcp_fixture_write', 'unexpected']) assert.equal(leadToolAllowed(tool, ['read', tool]), false);
  });
  await test('真实会话工厂只注册负责人的只读和调度工具，并禁止外部扩展', async () => {
    const f = fixture(), { room, lead } = department();
    const o = (await f.builder(room.id, lead.id)).session.options;
    assert.deepEqual([...o.tools].sort(), ['read', 'ls', 'grep', 'find', 'list_bots', 'list_departments', 'read_department', 'message_bot'].sort());
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
  await test('晋升后旧会话的执行工具立即被拒绝，已有审批不能覆盖角色限制', async () => {
    const f = fixture(), { room, member } = department();
    const o = (await f.builder(room.id, member.id)).session.options;
    store.updateRoom(room.id, { leadBotId: member.id });
    store.updatePolicy({ dangerous: 'ask' });
    store.grantApproval({ roomId: room.id, botId: member.id });
    for (const tool of ['bash', 'write', 'edit', 'run_background', 'write_stdin', 'kill_shell', 'mcp_fixture_write']) assert.equal(guard(o, tool)?.block, true, tool);
    const verdict = guard(o, 'run_background');
    if (!verdict?.block) await o.customTools.find(t => t.name === 'run_background').execute('fixture-call', { command: 'fixture-command' });
    assert.equal(shellCalls, 0);
    store.updatePolicy({ dangerous: 'allow' });
    assert.equal(guard(o, 'list_bots'), undefined);
    assert.equal(guard(o, 'run_background')?.block, true);
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
  await test('实际失败上报按接收方角色生成提示，负责人不自行执行、主控保持原行为', async () => {
    const { room, lead, member } = department();
    const calls = [];
    const escalate = createEscalator({ store, run: async (...args) => { calls.push(args); } });
    const delegated = await escalate({ roomId: room.id, fromBotId: member.id, reason: 'fixture failure' });
    assert.equal(delegated.hostId, lead.id);
    assert.equal(calls[0][0], room.id);
    assert.equal(calls[0][1], lead.id);
    assert.match(calls[0][2], /等待用户决定，不自行执行/);
    assert.doesNotMatch(calls[0][2], /你自己上|说明你接手了/);
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
    assert.equal(newLead.session.options.tools.includes('bash'), false);
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
    assert.equal(guard(entry.session.options, 'run_background')?.block, true);
    entry.busy = false;
    assert.equal((await run(f, room, member)).session.options.tools.includes('bash'), false);
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
    assert.equal(current.session.options.tools.includes('bash'), false);
    assert.equal(current.configurationCurrent(), true);
  });
  await test('成员增减可在单人执行和多人调度之间切换', async () => {
    const f = fixture(), bot = store.createBot({ name: 'fixture changing' }), peer = store.createBot({ name: 'fixture joining' });
    const room = store.createGroup({ name: 'fixture changing room', botIds: [bot.id], leadBotId: bot.id });
    assert.equal((await run(f, room, bot)).session.options.tools.includes('bash'), true);
    store.updateRoom(room.id, { botIds: [bot.id, peer.id] });
    assert.equal((await run(f, room, bot)).session.options.tools.includes('bash'), false);
    store.updateRoom(room.id, { botIds: [bot.id] });
    assert.equal((await run(f, room, bot)).session.options.tools.includes('bash'), true);
    assert.equal(f.captures.length, 3);
  });
} finally {
  for (const runner of runners) for (const entry of runner.sessions.values()) entry.session?.dispose();
  clearTimeout(store.saveTimer);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n角色能力回归：${passed}/${passed + failed} 通过`);
process.exitCode = failed ? 1 : 0;
