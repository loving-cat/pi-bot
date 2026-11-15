/**
 * 执行模式（规格 §8）的测试。
 *   node tests/exec-mode.mjs
 *
 * ## 为什么这块必须测
 *
 * 这是本轮补的第一个「规格写了、代码里其实没生效」的洞：
 *
 *   `grants.js` 有完整的三档模式（host / project / isolated），授权记录带
 *   `mode`、`deriveGrant` 会拒绝"子授权模式比父宽"、`grantGate.check()`
 *   支持按 mode 过滤 —— 但**唯一的调用方不传它**。
 *   于是 `candidatesFor` 里那道 `.filter((g) => !mode || g.mode === mode)`
 *   永远短路，§8 整节在运行时一条都没生效。
 *
 * 这个文件守两半：
 *
 *   前半：`executionModeOf()` 判得对（纯逻辑，可穷举）
 *   后半：`policy-hook` **真的把 mode 传进去了**（这一步最容易漏，
 *         而且漏了不会有任何报错 —— 只是那道过滤静默失效）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-execmode-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { executionModeOf, describeExecutionMode } = await import(src('exec-mode.js'));
const { MODE, ACTION } = await import(src('grants.js'));
const { store } = await import(src('store.js'));
const { createPolicyExtension } = await import(src('policy-hook.js'));
const { createGrantGate } = await import(src('grant-gate.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------- 判定
test('主 Bot 没挂沙箱 → host（规格 §8.1 可信宿主模式）', () => {
  assert.equal(executionModeOf({ bot: { role: 'main' } }), MODE.host);
  assert.equal(executionModeOf({ bot: { role: 'main' }, sandboxedToolNames: [] }), MODE.host);
});

test('★ 主 Bot 挂了 MCP（命令被换成沙箱版）→ isolated，不是 host', () => {
  // 它那一刻的命令确实跑在沙箱里，实际能力更接近 project。
  // 判成 host 会让一条 host 授权在"其实被沙箱限制着"的会话里通过 —— 那是放宽。
  assert.equal(executionModeOf({ bot: { role: 'main' }, sandboxedToolNames: ['powershell'] }), MODE.isolated);
  assert.equal(executionModeOf({ bot: { role: 'main' }, sandboxedToolNames: ['bash'] }), MODE.isolated);
});

test('★ 普通 bot 默认 project，不是 host（保守方向）', () => {
  // 规格 §8.2：严格范围任务不可直接获得任意宿主 shell。
  // 默认给 host 等于把"没配置"当成"全机信任"。
  assert.equal(executionModeOf({ bot: { role: 'member' } }), MODE.project);
  assert.equal(executionModeOf({ bot: { role: 'lead' } }), MODE.project);
  assert.equal(executionModeOf({}), MODE.project, '连 bot 都没有时更要保守');
});

test('普通 bot 挂沙箱 → isolated', () => {
  assert.equal(executionModeOf({ bot: { role: 'member' }, sandboxedToolNames: ['bash', 'powershell'] }), MODE.isolated);
});

test('沙箱化只认命令工具：别的工具被替换不算"隔离"', () => {
  // read / write 不是命令工具。它们走了别的实现不改变"命令跑在哪"这件事。
  assert.equal(executionModeOf({ bot: { role: 'member' }, sandboxedToolNames: ['read'] }), MODE.project);
  assert.equal(executionModeOf({ bot: { role: 'main' }, sandboxedToolNames: ['write'] }), MODE.host);
});

test('describeExecutionMode 对三档都说人话', () => {
  assert.match(describeExecutionMode(MODE.host), /宿主/);
  assert.match(describeExecutionMode(MODE.project), /项目/);
  assert.match(describeExecutionMode(MODE.isolated), /隔离|沙箱/);
  assert.match(describeExecutionMode('weird'), /未知/);
});

// ---------------------------------------------------------------- 接线
/**
 * 装一个假扩展，捕获 tool_call 处理器。
 *
 * @param {object} p
 * @param {object} [p.gate] 假网关（记录收到的参数）
 * @param {string|null} [p.mode]
 */
function installHook({ gate = null, mode = null, bot = { id: 'b1', name: '测试员', role: 'member' } } = {}) {
  let handler = null;
  const pi = { on: (event, fn) => { if (event === 'tool_call') handler = fn; return () => {}; } };
  const ext = createPolicyExtension({
    roomId: 'r_exec', bot, grantGate: gate, mode,
  });
  ext.factory(pi);
  assert.ok(handler, '扩展应注册 tool_call 处理器');
  return handler;
}

/** 假网关：记录 check() 收到的参数，一律放行。 */
function makeRecordingGate() {
  const calls = [];
  return {
    calls,
    actionForTool: (tool) => (tool === 'bash' ? { action: ACTION.cmdExec } : null),
    targetsForTool: () => [],
    check: (args) => { calls.push(args); return { ok: true }; },
    consume: () => 1,
    list: () => [],
    recentAudit: () => [],
    ensureForBots: () => ({ created: [], existing: [], revoked: [] }),
  };
}

test('★★ policy-hook 真的把 mode 传给网关了（不传就是静默失效）', () => {
  // 这条是本轮的核心：漏了不报错，只是 candidatesFor 里那道过滤永远短路。
  for (const mode of [MODE.host, MODE.project, MODE.isolated]) {
    const gate = makeRecordingGate();
    const h = installHook({ gate, mode });
    h({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } });
    assert.equal(gate.calls.length, 1, `mode=${mode} 时应当调了一次 check`);
    assert.equal(gate.calls[0].mode, mode, `★ 传给网关的 mode 应当是 ${mode}`);
  }
});

test('没给 mode 时传 null（与改造前行为一致，不改变测试环境）', () => {
  const gate = makeRecordingGate();
  const h = installHook({ gate, mode: null });
  h({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } });
  assert.equal(gate.calls[0].mode, null);
});

test('不会把 undefined 传成"某个模式"（undefined 会让过滤短路，看着像放行）', () => {
  const gate = makeRecordingGate();
  // 完全不传 mode 这个参数（老调用方的写法）
  let handler = null;
  const pi = { on: (event, fn) => { if (event === 'tool_call') handler = fn; return () => {}; } };
  createPolicyExtension({
    roomId: 'r_exec', bot: { id: 'b1', name: '测试员', role: 'member' }, grantGate: gate,
  }).factory(pi);
  handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } });
  // 默认值是 null（不是 undefined）—— 两者对 candidatesFor 效果相同，
  // 但 null 在日志里能看出"这里确实没给"，undefined 会让人以为是漏传
  assert.equal(gate.calls[0].mode, null);
});

// ---------------------------------------------------------------- 端到端：真的拒
test('★★ 端到端：host 授权在 project 模式下被拦（这才是 §8 要的效果）', () => {
  // 造一条 mode=host 的授权，然后按 project 模式去检查 —— 必须被拒。
  // 这条用例在改造前**一定失败**，因为 mode 根本没传进网关。
  const bot = store.createBot({ name: '执行员', persona: 'x' });
  const policyRevision = store.policyVersion();
  const gate = createGrantGate({
    store,
    currentPolicyRevision: () => policyRevision,
    currentGeneration: () => 'gen-exec-mode',
    log: () => {},
  });
  const added = gate.add({
    source: 'user',
    subject: { botId: bot.id, role: '' },
    actions: [ACTION.fileWrite],
    resources: [],
    mode: MODE.host,
    generation: 'gen-exec-mode',
  });
  assert.equal(added.ok, true, JSON.stringify(added).slice(0, 200));

  // host 模式：放行
  const asHost = gate.check({ subject: { botId: bot.id }, action: ACTION.fileWrite, mode: MODE.host });
  assert.equal(asHost.ok, true, 'host 授权在 host 模式下该放行');

  // project 模式：必须被拒 —— 一条 host 授权不该在受限会话里生效
  const asProject = gate.check({ subject: { botId: bot.id }, action: ACTION.fileWrite, mode: MODE.project });
  assert.equal(asProject.ok, false, '★ host 授权不该在 project 模式下生效');
  assert.equal(asProject.code, 'no_grant', `实际拒绝码：${asProject.code}`);

  // isolated 同理
  const asIsolated = gate.check({ subject: { botId: bot.id }, action: ACTION.fileWrite, mode: MODE.isolated });
  assert.equal(asIsolated.ok, false);

  // 不传 mode（老行为）：仍然放行 —— 这是兼容，不是漏洞
  const noMode = gate.check({ subject: { botId: bot.id }, action: ACTION.fileWrite });
  assert.equal(noMode.ok, true, '不按模式过滤时应当放行（兼容旧调用方）');
});

test('★ 反方向：project 授权在 host 模式下也被拦（不会因为"host 更宽"就放行）', () => {
  // 这条守的是"精确匹配"而不是"host 能覆盖一切"。
  // 规格里 host 是"更宽的能力"，但**授权**是按模式签发的：
  // 一条 project 授权不描述 host 会话里的行为。放行它等于假设
  // "受限会话里做过的事，在全机会话里也一定安全"，那不成立。
  const bot = store.createBot({ name: '限制员', persona: 'x' });
  const policyRevision = store.policyVersion();
  const gate = createGrantGate({
    store,
    currentPolicyRevision: () => policyRevision,
    currentGeneration: () => 'gen-exec-mode2',
    log: () => {},
  });
  gate.add({
    source: 'user',
    subject: { botId: bot.id, role: '' },
    actions: [ACTION.fileRead],
    resources: [],
    mode: MODE.project,
    generation: 'gen-exec-mode2',
  });
  assert.equal(
    gate.check({ subject: { botId: bot.id }, action: ACTION.fileRead, mode: MODE.project }).ok,
    true,
  );
  assert.equal(
    gate.check({ subject: { botId: bot.id }, action: ACTION.fileRead, mode: MODE.host }).ok,
    false,
    '★ project 授权不该在 host 会话里生效',
  );
});

clearTimeout(store.saveTimer);
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
