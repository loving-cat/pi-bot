/**
 * 审批第三档测试：ask 模式下会动手的调用要被拦住、发卡片、批准后只放行一次。
 *   node tests/approvals.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_approvals');
const HOME = process.env.PI_BOT_HOME;
fs.rmSync(HOME, { recursive: true, force: true });

const { store } = await import('../src/store.js');
const { createPolicyExtension, approvalHash, summarizeToolCall } = await import('../src/policy-hook.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const bot = store.createBot({ name: '审批员', persona: '测试' });
const room = store.createGroup({ name: '审批测试组', botIds: [bot.id] });

function install(roomId = room.id) {
  let handler = null;
  const pi = { on: (ev, fn) => { if (ev === 'tool_call') handler = fn; return () => {}; } };
  createPolicyExtension({ roomId, bot }).factory(pi);
  assert.ok(handler);
  return handler;
}
const call = (h, toolName, input) =>
  h({ type: 'tool_call', toolName, toolCallId: 'c1', input });

await test('summary：命令/写入压成一句人话', () => {
  assert.match(summarizeToolCall('bash', { command: 'rm -rf x' }), /rm -rf x/);
  assert.match(summarizeToolCall('write', { path: 'a.txt', content: 'hello' }), /a\.txt/);
});

await test('★ ask 档：会动手的调用被拦，并发出审批卡片', () => {
  store.updatePolicy({ dangerous: 'ask' });
  const h = install();
  const verdict = call(h, 'bash', { command: 'rm -rf /tmp/x' });
  assert.equal(verdict?.block, true);
  assert.match(verdict.reason, /批准/);

  const pending = store.listApprovals({ roomId: room.id, status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, 'bash');

  const card = store
    .listMessages(room.id, { limit: 50 })
    .find((m) => m.kind === 'approval');
  assert.ok(card, '应该写出一条审批卡片');
  assert.equal(card.meta.approvalId, pending[0].id);
});

await test('★ 同一次调用重复触发：不重复建，也不重复发卡片', () => {
  const h = install();
  const before = store.listApprovals({ roomId: room.id }).length;
  const verdict = call(h, 'bash', { command: 'rm -rf /tmp/x' });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /还在等/);
  assert.equal(store.listApprovals({ roomId: room.id }).length, before);
});

await test('不动的工具（read）不受影响', () => {
  const h = install();
  assert.equal(call(h, 'read', { path: 'a.txt' }), undefined);
});

await test('★ 批准后同一次调用放行一次，再来一次又要批', () => {
  const pending = store.listApprovals({ roomId: room.id, status: 'pending' })[0];
  store.decideApproval(pending.id, { approved: true });
  const h = install();

  assert.equal(call(h, 'bash', { command: 'rm -rf /tmp/x' }), undefined, '批准过的那次应该放行');

  const again = call(h, 'bash', { command: 'rm -rf /tmp/x' });
  assert.equal(again?.block, true, '放行只能用一次');
  assert.equal(store.listApprovals({ roomId: room.id, status: 'pending' }).length, 1);
});

await test('★ 开了"本次任务"窗口后，不再逐条弹卡片', () => {
  store.updatePolicy({ dangerous: 'ask' });
  const h = install();
  // 先造一条待批准并批准成"本次任务"窗口
  const verdict = call(h, 'write', { path: 'x.txt', content: 'hi' });
  assert.equal(verdict?.block, true);
  const pending = store
    .listApprovals({ roomId: room.id, status: 'pending' })
    .find((a) => a.tool === 'write');
  assert.ok(pending, '应该有一条 write 的待批准');
  store.decideApproval(pending.id, { approved: true });
  store.grantApproval({ roomId: room.id, botId: bot.id, minutes: 10 });

  assert.equal(call(h, 'bash', { command: 'ls' }), undefined, '窗口内直接放行');
  assert.equal(store.hasApprovalGrant({ roomId: room.id, botId: bot.id }), true);
  store.clearApprovalGrants({ roomId: room.id });
});

await test('拒绝后不会放行', () => {
  const pending = store
    .listApprovals({ roomId: room.id, status: 'pending' })
    .find((a) => a.tool === 'bash');
  assert.ok(pending, '应该有一条 bash 的待批准');
  store.decideApproval(pending.id, { approved: false });
  const h = install();
  assert.equal(call(h, 'bash', { command: 'rm -rf /tmp/x' })?.block, true);
});

await test('allow 档回到原行为：不拦', () => {
  store.updatePolicy({ dangerous: 'allow' });
  const h = install();
  assert.equal(call(h, 'bash', { command: 'echo hi' }), undefined);
});

await test('hash：同样的工具+入参指纹一致，不同入参不同', () => {
  const a = approvalHash('bash', { command: 'a' });
  assert.equal(a, approvalHash('bash', { command: 'a' }));
  assert.notEqual(a, approvalHash('bash', { command: 'b' }));
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 审批测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
