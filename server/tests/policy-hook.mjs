/**
 * 命令策略拦截点测试。
 *   node tests/policy-hook.mjs
 *
 * 用一个假的 pi 扩展 API 捕获 `tool_call` 处理器，验证：
 *   · 命中规则 → block + 原因，并写入审计；
 *   · 未命中 / 未配置规则 → 放行（返回 undefined）；
 *   · 只干预执行命令的工具。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_policy_hook');
const HOME = process.env.PI_BOT_HOME;
fs.rmSync(HOME, { recursive: true, force: true });

const { store } = await import('../src/store.js');
const { createPolicyExtension } = await import('../src/policy-hook.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

/** 捕获扩展注册的 tool_call 处理器 */
function install() {
  let handler = null;
  const pi = { on: (event, fn) => { if (event === 'tool_call') handler = fn; return () => {}; } };
  const ext = createPolicyExtension({ roomId: 'r_test', bot: { id: 'b1', name: '测试员' } });
  ext.factory(pi);
  assert.ok(handler, '扩展应注册 tool_call 处理器');
  return handler;
}

const call = (handler, toolName, command) =>
  handler({ type: 'tool_call', toolName, toolCallId: 'c1', input: { command } });

await test('未配置规则时不干预', () => {
  store.updatePolicy({ denyCommands: [], allowCommands: [] });
  const h = install();
  assert.equal(call(h, 'bash', 'rm -rf /'), undefined);
});

await test('★ 命中禁用规则：阻止执行并写审计', () => {
  store.updatePolicy({ denyCommands: ['rm -rf *'] });
  const h = install();
  const verdict = call(h, 'bash', 'rm -rf /tmp/x');
  assert.equal(verdict?.block, true);
  assert.match(verdict.reason, /部门规矩/);

  const denials = store.listDenials({ limit: 5 });
  assert.equal(denials.length, 1);
  assert.equal(denials[0].command, 'rm -rf /tmp/x');
  assert.equal(denials[0].roomId, 'r_test');
  assert.equal(denials[0].botName, '测试员');
});

await test('★ powershell 同样受约束', () => {
  store.updatePolicy({ denyCommands: ['rm -rf *'] });
  const h = install();
  assert.equal(call(h, 'powershell', 'rm -rf /').block, true);
});

await test('不执行命令的工具不干预', () => {
  store.updatePolicy({ denyCommands: ['*'] });
  const h = install();
  assert.equal(call(h, 'read', 'rm -rf /'), undefined);
});

await test('allowlist 生效', () => {
  store.updatePolicy({ denyCommands: [], allowCommands: ['git status'] });
  const h = install();
  assert.equal(call(h, 'bash', 'git status'), undefined);
  assert.equal(call(h, 'bash', 'git push').block, true);
});

await test('非法规则在写入时被丢弃', () => {
  const p = store.updatePolicy({ denyCommands: ['*', 'rm -rf *', 'rm -rf *'] });
  assert.deepEqual(p.denyCommands, ['rm -rf *']);
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 命令拦截测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
