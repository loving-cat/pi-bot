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

/** 用指定 bot（含角色）装一个处理器，测执行边界的角色判定。 */
function installWithBot(bot) {
  let handler = null;
  const pi = { on: (event, fn) => { if (event === 'tool_call') handler = fn; return () => {}; } };
  const ext = createPolicyExtension({ roomId: 'r_test', bot });
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

// ---------------------------------------------------------------- A2：二级强确认
/** 造一个主控 bot + 房间，返回装了处理器的主控。 */
function chiefSetup() {
  store.state.rooms ??= {};
  store.state.rooms.r_test = {
    id: 'r_test', name: 'A2 验收房', kind: 'dm', botIds: ['b_main'], createdAt: Date.now(),
  };
  const bot = { id: 'b_main', name: '主控', role: 'main', emoji: '🤖', persona: '' };
  store.state.bots ??= {};
  store.state.bots.b_main = bot;
  return installWithBot(bot);
}

await test('★ A2：主控删 Bot 必须走手机强确认（本机批准不算）', async () => {
  const handler = chiefSetup();
  const input = { name: '临时Bot' };
  const first = handler({ type: 'tool_call', toolName: 'delete_bot', toolCallId: 'c1', input });
  assert.equal(first?.block, true, '删 Bot 必须先拦下');
  assert.match(String(first.reason ?? ''), /手机/);

  const cards = () => (store.state.confirmations ?? []).filter((c) => c.action === 'delete_bot');
  assert.equal(cards().length, 1, '应当建了一条二级强确认');
  assert.equal(cards()[0].minChannel, 'device', '这条确认必须要求设备通道');

  // 同目标再来一次：不许堆卡
  const again = handler({ type: 'tool_call', toolName: 'delete_bot', toolCallId: 'c2', input });
  assert.equal(again?.block, true);
  assert.equal(cards().length, 1, '同一目标不该重复建卡');

  // 本机批准：必须被拒（规格 §9：主 Bot 能自己点本机卡片）
  const local = store.decideConfirmation(cards()[0].id, { approved: true, channel: 'local' });
  assert.equal(local.rejected, true, '本机批准不可撤销动作应被拒');

  // 手机批准：通过
  const phone = store.decideConfirmation(cards()[0].id, {
    approved: true, channel: 'device', device: { id: 'd_phone', name: '我的手机' },
  });
  assert.ok(!phone.rejected, '设备通道应当批准成功');

  // 再调用一次：放行，并且这条确认要被消费（一次一用）
  const allowed = handler({ type: 'tool_call', toolName: 'delete_bot', toolCallId: 'c3', input });
  assert.notEqual(allowed?.block, true, '手机批准后这一次应当放行');
  assert.ok(store.getConfirmation(cards()[0].id).consumedAt, '确认必须被消费');

  // 第三次：又得重新确认（不能拿旧批准反复用）
  const third = handler({ type: 'tool_call', toolName: 'delete_bot', toolCallId: 'c4', input });
  assert.equal(third?.block, true, '一次一用：旧批准不能复用');
});

await test('★ A2：改策略 / 删技能 走强确认，而列表类操作不拦', async () => {
  const handler = chiefSetup();
  const policyUpdate = handler({
    type: 'tool_call', toolName: 'set_policy', toolCallId: 'p1', input: { op: 'update', dangerous: 'allow' },
  });
  assert.equal(policyUpdate?.block, true, '改全局策略必须强确认');
  assert.match(String(policyUpdate.reason ?? ''), /手机/);

  const policyGet = handler({ type: 'tool_call', toolName: 'set_policy', toolCallId: 'p2', input: { op: 'get' } });
  assert.notEqual(policyGet?.block, true, '读策略不该被这道门拦');

  const delSkill = handler({
    type: 'tool_call', toolName: 'manage_knowledge', toolCallId: 'k1', input: { op: 'delete_skill', id: 's1' },
  });
  assert.equal(delSkill?.block, true, '删技能必须强确认');

  const listLessons = handler({
    type: 'tool_call', toolName: 'manage_knowledge', toolCallId: 'k2', input: { op: 'list_lessons' },
  });
  assert.notEqual(listLessons?.block, true, '看经验列表不该被这道门拦');
});

await test('★ A2：破坏性 git 不在这一层重复弹卡（git-tools 自己会弹）', async () => {
  const handler = chiefSetup();
  const r = handler({
    type: 'tool_call', toolName: 'git_destructive', toolCallId: 'g1', input: { operation: 'reset', repo: '.' },
  });
  // 这一层放行；真正弹卡的是 git-tools 里的 requestConfirmation
  assert.notEqual(r?.block, true, 'git_destructive 不该在这里被拦（会双卡）');
});

await test('★ 成员用 T2 桌面工具必须在执行边界被拒（CHIEF_ONLY_TOOLS 兜底）', () => {
  // 为什么需要这一道：desktop.observe 这个动作 migration 是 'all'（T1 共用），
  // 成员在网关那层拿得到授权；T2 的边界在工具级 chiefOnly。而会话是缓存复用的，
  // 旧句柄可能绕过“造工具”那一道，所以真调用时必须再判。
  const member = installWithBot({ id: 'b_member', name: '成员', role: 'member' });
  for (const tool of ['desktop_observe', 'desktop_screenshot', 'desktop_input', 'desktop_lease']) {
    const r = member({ type: 'tool_call', toolName: tool, toolCallId: 'c1', input: {} });
    assert.equal(r?.block, true, `${tool} 应被拦`);
    assert.match(String(r?.reason ?? ''), /只给主控/);
  }

  // 主控用同一个工具不放行也不该“被这道门”拦（后面还有网关/审批各管一段）
  const chief = installWithBot({ id: 'b_main', name: '主控', role: 'main' });
  const ok = chief({ type: 'tool_call', toolName: 'desktop_observe', toolCallId: 'c2', input: {} });
  assert.notEqual(ok?.block, true, '主控不该被这道门拦住');
});

await test('★ T1 独立桌面工具不属于 chiefOnly：成员调用不会被这道门拦', () => {
  const member = installWithBot({ id: 'b_member', name: '成员', role: 'member' });
  for (const tool of ['desktop_island_observe', 'desktop_island_input', 'desktop_island_launch']) {
    const r = member({ type: 'tool_call', toolName: tool, toolCallId: 'c3', input: {} });
    assert.notEqual(r?.block, true, `${tool} 是 T1 工具，不该被 chiefOnly 这道门拦`);
  }
});


await test('★ B1：批了 A 不能拿这张票去删 B（目标调包必须拒）', async () => {
  const handler = chiefSetup();
  const a = handler({
    type: 'tool_call', toolName: 'manage_department', toolCallId: 'd1', input: { op: 'delete', groupId: 'grp_test' },
  });
  assert.equal(a?.block, true);
  const card = (store.state.confirmations ?? []).find((c) => c.action === 'manage_department');
  assert.ok(card, '应当建了确认');
  store.decideConfirmation(card.id, { approved: true, channel: 'device', device: { id: 'd1', name: '手机' } });

  // 换一个部门：摘要对不上，必须重新确认
  const other = handler({
    type: 'tool_call', toolName: 'manage_department', toolCallId: 'd2', input: { op: 'delete', groupId: 'grp_prod' },
  });
  assert.equal(other?.block, true, '批了 A 却拿去删 B —— 必须被拒');

  // 原目标：放行（并且消费掉）
  const same = handler({
    type: 'tool_call', toolName: 'manage_department', toolCallId: 'd3', input: { op: 'delete', groupId: 'grp_test' },
  });
  assert.notEqual(same?.block, true, '原目标应当放行');
});

await test('★ B1：批的是「requireProof」就不能拿去改 dangerous', async () => {
  const handler = chiefSetup();
  handler({
    type: 'tool_call', toolName: 'set_policy', toolCallId: 'p1',
    input: { op: 'update', requireProof: true },
  });
  const card = (store.state.confirmations ?? []).find((c) => c.action === 'set_policy');
  assert.ok(card);
  store.decideConfirmation(card.id, { approved: true, channel: 'device', device: { id: 'd1', name: '手机' } });

  const swapped = handler({
    type: 'tool_call', toolName: 'set_policy', toolCallId: 'p2',
    input: { op: 'update', dangerous: 'allow', allowLocalApproval: true },
  });
  assert.equal(swapped?.block, true, '参数调包必须重新确认（不能拿一张票改整个策略）');
});

await test('★ B2：卡片过期后同一目标能重新发卡（不死锁）', async () => {
  const handler = chiefSetup();
  const input = { name: '临时Bot-过期用例' };
  handler({ type: 'tool_call', toolName: 'delete_bot', toolCallId: 'x1', input });
  const mine = () => (store.state.confirmations ?? [])
    .filter((c) => c.action === 'delete_bot' && String(c.summary ?? '').includes('临时Bot-过期用例'));
  assert.equal(mine().length, 1);

  // 人为把它变过期
  mine()[0].expiresAt = Date.now() - 1;

  const again = handler({ type: 'tool_call', toolName: 'delete_bot', toolCallId: 'x2', input });
  assert.equal(again?.block, true);
  assert.equal(mine().length, 2, '过期后必须能发新卡（否则这个目标永久死锁）');
  assert.equal(mine()[1].decision, null, '新卡应当是待确认');
});


await test('★ C1：SECOND_FACTOR_TOOLS 与 needsSecondFactor 同口径（漏一个卡片就灰不掉）', async () => {
  const { SECOND_FACTOR_TOOLS, needsSecondFactor } = await import('../src/capabilities.js');
  const cases = [
    ['git_destructive', {}],
    ['delete_bot', {}],
    ['manage_department', { op: 'delete' }],
    ['manage_knowledge', { op: 'delete_skill' }],
    ['set_policy', { op: 'update' }],
    ['manage_model_group', { op: 'delete' }],
    ['manage_mcp_server', { op: 'enable' }],
    ['import_local_capabilities', { kind: 'mcp', enable: true }],
  ];
  for (const [tool, input] of cases) {
    assert.equal(needsSecondFactor(tool, input), true, `${tool} 应判为二级强确认`);
    // http.js 拿这份名单决定「写回 meta.decision + 自动续跑」；名单漏了就永远灰不掉
    assert.ok(SECOND_FACTOR_TOOLS.includes(tool), `${tool} 必须出现在 SECOND_FACTOR_TOOLS`);
  }
});

await test('★ C2：导入本地能力绑 names/all —— 批 A 不能拿去导入 B', async () => {
  store.state.confirmations = [];
  const handler = chiefSetup();
  const a = handler({
    type: 'tool_call', toolName: 'import_local_capabilities', toolCallId: 'i1',
    input: { kind: 'mcp', names: ['a_server'], enable: true },
  });
  assert.equal(a?.block, true);
  const card = (store.state.confirmations ?? []).find((c) => c.action === 'import_local_capabilities');
  assert.ok(card, '应当建了确认');
  store.decideConfirmation(card.id, { approved: true, channel: 'device', device: { id: 'd1', name: '手机' } });

  const other = handler({
    type: 'tool_call', toolName: 'import_local_capabilities', toolCallId: 'i2',
    input: { kind: 'mcp', names: ['b_server'], enable: true },
  });
  assert.equal(other?.block, true, '换了要导入的名字必须重新确认');

  const same = handler({
    type: 'tool_call', toolName: 'import_local_capabilities', toolCallId: 'i3',
    input: { kind: 'mcp', names: ['a_server'], enable: true },
  });
  assert.notEqual(same?.block, true, '原目标应当放行');
});

await test('★ C3：awayAfterMs 0 与「没传这个字段」是两个目标', async () => {
  store.state.confirmations = [];
  const handler = chiefSetup();
  handler({
    type: 'tool_call', toolName: 'set_policy', toolCallId: 's1',
    input: { op: 'update', awayAfterMs: 0 },
  });
  const card = (store.state.confirmations ?? []).find((c) => c.action === 'set_policy');
  assert.ok(card);
  store.decideConfirmation(card.id, { approved: true, channel: 'device', device: { id: 'd1', name: '手机' } });

  const other = handler({
    type: 'tool_call', toolName: 'set_policy', toolCallId: 's2',
    input: { op: 'update', requireProof: true },
  });
  assert.equal(other?.block, true, '批了 awayAfterMs:0 不等于批了别的策略改动');
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 命令拦截测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
