/**
 * 只读模式回归：写操作必须在服务端工具入口被拒，不能只靠不把工具塞进提示词。
 *   node tests/readonly-regress.mjs
 *
 * 放行名单只有 role-tools.js 的 READONLY_ALLOW 一份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-readonly-'));
process.env.PI_BOT_HOME = path.join(root, 'data');
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
process.env.PI_BOT_MODEL = '';
process.env.PI_BOT_WATCH_CHANGES = '0';
process.env.PI_BOT_AUTO_ATTACH_IMAGES = '0';
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
for (const dir of [process.env.HOME, process.env.PI_CODING_AGENT_DIR, process.env.PI_BOT_WORKSPACE]) {
  fs.mkdirSync(dir, { recursive: true });
}

const { store } = await import('../src/store.js');
const { createPolicyExtension } = await import('../src/policy-hook.js');
const { createMcpExtension } = await import('../src/mcp-hook.js');
const { buildCommonTools } = await import('../src/tools.js');
const { shells } = await import('../src/shells.js');
const { createSessionBuilder } = await import('../src/session-factory.js');
const {
  toolsForPolicy,
  customToolsForRole,
  READONLY_ALLOW,
} = await import('../src/role-tools.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.stack || err?.message || String(err) });
  }
}

let shellStarts = 0;
let shellWrites = 0;
shells.start = () => {
  shellStarts += 1;
  return { id: 'sh_should_not', pid: 1 };
};
shells.write = () => {
  shellWrites += 1;
  return { ok: true };
};
shells.kill = () => {
  shellStarts += 1;
  return { ok: true };
};
shells.remove = () => {
  shellStarts += 1;
  return { ok: true };
};

const member = { id: 'b_member', name: '成员', role: 'member' };
const tools = buildCommonTools({ runner: {}, roomId: 'room1', botId: member.id, isMain: false });
const tool = (name) => tools.find((item) => item.name === name);

function handlerFor(bot, roomId = 'room1') {
  let handler = null;
  createPolicyExtension({ roomId, bot }).factory({
    on(event, fn) {
      if (event === 'tool_call') handler = fn;
    },
  });
  return handler;
}

const call = (handler, toolName, input = {}) => handler({ toolName, input });

function mcpNames(botId, roomId) {
  const names = [];
  createMcpExtension({ botId, roomId })({
    registerMcpServer: (name) => names.push(name),
    on() {},
  });
  return names;
}

store.updatePolicy({ dangerous: 'deny', denyCommands: [], allowCommands: [] });

await test('run_background：只读时工具入口拒绝，且不会启动进程', async () => {
  const verdict = call(handlerFor(member), 'run_background', { command: 'touch escaped.txt' });
  assert.equal(verdict?.block, true, 'tool_call 必须 block');
  assert.match(verdict.reason, /只读/);
  const result = await tool('run_background').execute('c1', { command: 'touch escaped.txt' });
  assert.equal(result.isError, true);
  assert.equal(shellStarts, 0, 'shells.start 不应被调用');
});

await test('write_stdin：只读时工具入口拒绝，且不会往进程写', async () => {
  const verdict = call(handlerFor(member), 'write_stdin', { shell_id: 'sh_old', chars: 'rm -rf .\n' });
  assert.equal(verdict?.block, true);
  assert.match(verdict.reason, /只读/);
  const result = await tool('write_stdin').execute('c2', { shell_id: 'sh_old', chars: 'rm -rf .\n' });
  assert.equal(result.isError, true);
  assert.equal(shellWrites, 0, 'shells.write 不应被调用');
});

await test('MCP 工具调用：只读时默认拒绝（名字不在放行名单）', () => {
  for (const name of ['mcp_fixture_write', 'filesystem_write_file', 'mcp__shell__exec']) {
    const verdict = call(handlerFor(member), name, { path: 'secret.txt', content: 'x' });
    assert.equal(verdict?.block, true, name);
    assert.match(verdict.reason, /只读/);
  }
});

await test('MCP 服务：只读时不注册；允许时仍注册', () => {
  const bot = store.createBot({ name: '只读成员' });
  assert.ok(store.addMcpServer({ name: 'fixture_mcp', command: 'fixture-command', enabled: true }).server);
  store.updateBot(bot.id, { mcpServers: ['fixture_mcp'] });
  const room = store.ensureDm(bot.id);
  assert.deepEqual(mcpNames(bot.id, room.id), [], '只读不应 registerMcpServer');
  store.updatePolicy({ dangerous: 'allow' });
  assert.deepEqual(mcpNames(bot.id, room.id), ['fixture_mcp']);
  store.updatePolicy({ dangerous: 'deny', allowCommands: ['echo *'] });
});

await test('已挂上的内置写工具：bash/write/edit/powershell 仍被入口拒绝', () => {
  const handler = handlerFor(member);
  for (const name of ['bash', 'powershell', 'write', 'edit']) {
    const verdict = call(handler, name, { command: 'echo hi', path: 'a.txt', content: 'x' });
    assert.equal(verdict?.block, true, name);
  }
});

await test('命令白名单和审批放行都不能绕过只读', () => {
  store.grantApproval({ roomId: 'room1', botId: member.id });
  const verdict = call(handlerFor(member), 'bash', { command: 'echo hi' });
  assert.equal(verdict?.block, true);
  assert.match(verdict.reason, /只读/);
  const bg = call(handlerFor(member), 'run_background', { command: 'echo hi' });
  assert.equal(bg?.block, true);
});

await test('kill_shell / update_bot / send_image：只读时拒绝', () => {
  const handler = handlerFor({ id: 'chief', name: '主控', role: 'main' });
  for (const name of ['kill_shell', 'update_bot', 'send_image', 'add_mcp_server', 'stage_site']) {
    assert.equal(call(handler, name, { shell_id: 'sh', botId: 'b', model: 'x' })?.block, true, name);
  }
  assert.equal(shellStarts, 0);
});

await test('只读仍允许读和查看', () => {
  const handler = handlerFor(member);
  for (const name of ['read', 'ls', 'grep', 'find', 'list_bots', 'web_fetch', 'read_shell']) {
    assert.equal(call(handler, name, { path: 'a.txt', url: 'https://example.com' }), undefined, name);
  }
});

await test('放行名单是唯一来源：过滤自定义工具和内置工具都走它', () => {
  const policy = { dangerous: 'deny' };
  const builtin = toolsForPolicy(
    ['read', 'write', 'edit', 'bash', 'powershell', 'run_background', 'write_stdin', 'ls'],
    policy,
  );
  assert.deepEqual(builtin, ['read', 'ls']);
  const custom = customToolsForRole(tools, {
    room: { kind: 'dm', botIds: [member.id] },
    bot: member,
    policy,
  }).map((item) => item.name);
  assert.equal(custom.includes('run_background'), false);
  assert.equal(custom.includes('write_stdin'), false);
  assert.equal(custom.includes('kill_shell'), false);
  assert.equal(custom.includes('read_shell'), true);
  assert.equal(custom.includes('list_bots'), true);
  const hookSrc = fs.readFileSync(new URL('../src/policy-hook.js', import.meta.url), 'utf8');
  const roleSrc = fs.readFileSync(new URL('../src/role-tools.js', import.meta.url), 'utf8');
  assert.equal(hookSrc.includes('const MUTATING_TOOLS'), false, 'policy-hook 不应再维护一份名单');
  assert.equal(hookSrc.includes('READONLY_ALLOW'), false, '放行名单不应复制到 policy-hook');
  assert.equal((roleSrc.match(/export const READONLY_ALLOW/g) ?? []).length, 1);
  assert.ok(READONLY_ALLOW.includes('read') && !READONLY_ALLOW.includes('run_background'));
  assert.ok(!READONLY_ALLOW.includes('write_stdin'));
});

await test('真实会话工厂：只读会话不注册 run_background、write_stdin 和 MCP', async () => {
  const captures = [];
  const sessionApi = {
    getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
    SessionManager: { create: () => ({}), open: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options) {
        this.options = options;
        this.handlers = new Map();
        this.mcp = [];
      }
      async reload() {
        const pi = {
          on: (name, fn) => this.handlers.set(name, fn),
          registerMcpServer: (name) => this.mcp.push(name),
          unregisterMcpServer() {},
        };
        for (const ext of this.options.extensionFactories) (ext.factory ?? ext)(pi);
      }
    },
    async createAgentSession(options) {
      captures.push(options);
      return { session: { model: null, options, settingsManager: { applyOverrides() {} } } };
    },
  };
  const builder = createSessionBuilder({
    runner: { model: null, modelRuntime: {} },
    health: null,
    resolveModel: () => null,
    modelLabel: () => '',
    sessionApi,
  });
  const bot = store.getBot('b_member') ?? store.listBots().find((item) => item.name === '只读成员');
  store.updateBot(bot.id, { mcpServers: ['fixture_mcp'] });
  const room = store.ensureDm(bot.id);
  store.updatePolicy({ dangerous: 'deny' });
  const built = await builder(room.id, bot.id);
  const options = built.session.options;
  assert.equal(options.tools.includes('bash'), false);
  assert.equal(options.tools.includes('run_background'), false);
  assert.equal(options.tools.includes('write_stdin'), false);
  assert.equal(options.tools.includes('read'), true);
  assert.deepEqual(options.resourceLoader.mcp, []);
  assert.equal(options.resourceLoader.options.noMcp, true);
  assert.equal(options.resourceLoader.options.noExtensions, true);
  const guard = options.resourceLoader.handlers.get('tool_call');
  assert.equal(guard({ toolName: 'run_background', input: { command: 'id' } })?.block, true);
  assert.equal(guard({ toolName: 'write_stdin', input: { chars: 'y\n' } })?.block, true);
  assert.equal(guard({ toolName: 'mcp_fixture_write', input: {} })?.block, true);
  assert.equal(guard({ toolName: 'read', input: { path: 'README.md' } }), undefined);
});

await test('允许模式下 run_background 入口不拦截（只读开关关掉后恢复）', () => {
  store.updatePolicy({ dangerous: 'allow', allowCommands: [], denyCommands: [] });
  assert.equal(call(handlerFor(member), 'run_background', { command: 'echo ok' }), undefined);
  assert.equal(call(handlerFor(member), 'write_stdin', { shell_id: 'sh', chars: 'ok\n' }), undefined);
});

fs.rmSync(root, { recursive: true, force: true });
let failed = 0;
for (const item of results) {
  if (item.ok) console.log(`✓ ${item.name}`);
  else {
    failed += 1;
    console.log(`✗ ${item.name}\n${item.err}`);
  }
}
console.log(failed ? `${failed}/${results.length} 失败` : `全部 ${results.length} 项通过`);
process.exit(failed ? 1 : 0);
