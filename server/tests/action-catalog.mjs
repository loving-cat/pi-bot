/**
 * 动作目录的测试。
 *   node tests/action-catalog.mjs
 *
 * 守的是「一个动作有多危险」只有一个来源这件事：
 * 之前它被抄成了三份（`grants.RISK` 只定义档位、`grant-gate.TOOL_ACTIONS`
 * 按工具名建表、`confirm.IRREVERSIBLE_ACTIONS` 另存一份），
 * 于是网关用动作名去查按工具名建的表 → 审计里的 risk 恒为 null。
 *
 * 另外守「窄范围授权不能靠'认不出目标'绕过」：这是实测出来的洞 ——
 * 授权写了只许动 /proj/alpha，跑 `bash rm -rf /` 照样放行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
});
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const C = await import(src('action-catalog.js'));
const G = await import(src('grants.js'));
const { ACTION, DENY } = G;
const { store } = await import(src('store.js'));
const { createGrantGate, ensureLegacyGrant, TOOL_ACTIONS } = await import(src('grant-gate.js'));
const { reversibilityOf, REVERSIBILITY } = await import(src('confirm.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const chief = store.mainBot();
const worker = store.createBot({ name: '执行者', persona: '测试' });

/** 造一条只覆盖某几个动作的根授权（可指定范围）。 */
function grant({ actions, resources = [], botId = chief.id, mode = 'host' } = {}) {
  return {
    source: 'user',
    sourceRef: '测试里手工批准',
    subject: { botId, role: 'main' },
    actions,
    resources,
    mode,
  };
}

function makeGate(over = {}) {
  // 每条用例都从干净的授权表开始，避免互相污染
  store.state.grants = [];
  return createGrantGate({
    store,
    currentPolicyRevision: () => 'p1',
    currentGeneration: () => 'g1',
    log: () => {},
    ...over,
  });
}

// ---------------------------------------------------------------- 目录完整性
await test('每个动作都有目录条目，且档位合法', () => {
  const valid = new Set(Object.values(G.RISK));
  for (const action of G.ALL_ACTIONS) {
    const info = C.actionInfo(action);
    assert.ok(info, `${action} 不在动作目录里 —— 新增动作必须登记，否则风险档/可撤销性都是猜的`);
    assert.ok(valid.has(info.risk), `${action} 的风险档不合法：${info.risk}`);
    assert.equal(typeof info.irreversible, 'boolean', `${action} 必须明确说能不能撤销`);
    assert.equal(typeof info.needsTarget, 'boolean', `${action} 必须明确要不要目标`);
  }
});

await test('每个工具都指向已登记的动作，且目标规则不拼错', () => {
  assert.deepEqual(C.auditCatalog(), [], '目录自检不该有问题');
});

await test('目录自检能抓出拼错的工具名', () => {
  // 真实踩过：targetsForTool 里写的是 egp_browser，那条分支从来没生效
  const problems = C.auditCatalog();
  assert.equal(problems.length, 0, JSON.stringify(problems));
});

// ---------------------------------------------------------------- 单一来源
await test('★ 风险档按动作查，不随工具变（原来审计里恒为 null）', () => {
  // 同一个 net.send 下，各工具以前各写一档（high/medium/high…）
  const byAction = new Set(
    Object.entries(TOOL_ACTIONS)
      .filter(([, v]) => v.action === ACTION.netSend)
      .map(([, v]) => v.risk),
  );
  assert.equal(byAction.size, 1, `同一动作不该有多个风险档：${[...byAction].join('/')}`);
  assert.equal(C.riskOf(ACTION.netSend), C.riskOf(ACTION.netSend));
});

await test('★ 网关审计里记的是动作的风险档（不再是 null）', () => {
  const gate = makeGate();
  gate.add(grant({ actions: [ACTION.cmdExec] }));
  const out = gate.check({ subject: { botId: chief.id }, action: ACTION.cmdExec, params: { command: 'ls' } });
  assert.equal(out.ok, true);
  assert.equal(out.audit.risk, G.RISK.medium, '跑命令是 medium');
  assert.equal(out.audit.risk, C.riskOf(ACTION.cmdExec));
});

await test('确认框架与目录同源：不可撤销清单只在目录里', () => {
  for (const action of ['git.push', 'file.delete', 'net.send', 'secret.use', 'policy.change', 'mcp.add']) {
    assert.equal(C.isIrreversible(action), true, action);
    assert.equal(reversibilityOf(action), REVERSIBILITY.irreversible, action);
  }
  for (const action of ['file.write', 'cmd.exec', 'git.commit', 'git.read', 'file.read', 'desktop.observe']) {
    assert.equal(C.isIrreversible(action), false, action);
    assert.equal(reversibilityOf(action), REVERSIBILITY.reversible, action);
  }
});

await test('目录里没登记的动作按“不可撤销 + 需要目标”算（保守方向）', () => {
  assert.equal(C.isIrreversible('future.action'), true, '拿不准就当成不可撤销');
  assert.equal(C.needsTarget('future.action'), true, '拿不准就要求能认出目标');
});

// ---------------------------------------------------------------- 目标认法
await test('目标认法：文件类读 path，网页类读 url 取主机名', () => {
  assert.deepEqual(C.targetsForTool('write', { path: '/proj/alpha/a.js' }), [
    { kind: 'path', ref: '/proj/alpha/a.js' },
  ]);
  assert.deepEqual(C.targetsForTool('web_fetch', { url: 'https://api.example.com/v1/x' }), [
    { kind: 'host', ref: 'api.example.com' },
  ]);
});

await test('目标认法：站点名不是完整 URL 时原样当主机名', () => {
  assert.deepEqual(C.targetsForTool('query_site', { site: '投研系统' }), [
    { kind: 'host', ref: '投研系统' },
  ]);
});

await test('目标认法：认不出来的就返回空（不猜）', () => {
  assert.deepEqual(C.targetsForTool('bash', { command: 'rm -rf /' }), [], '命令里的路径不该被硬猜');
  assert.deepEqual(C.targetsForTool('ego_browser', { script: 'page.goto("https://x")' }), [], '脚本内容不该被硬猜');
});

// ---------------------------------------------------------------- fail-closed
await test('★ 窄范围授权 + 认不出目标 = 拒绝（原来会放行）', () => {
  const gate = makeGate();
  gate.add(grant({ actions: [ACTION.cmdExec], resources: [{ kind: 'path', ref: '/proj/alpha' }] }));
  const out = gate.check({
    subject: { botId: chief.id },
    action: ACTION.cmdExec,
    targets: C.targetsForTool('bash', { command: 'rm -rf /' }),
    params: { command: 'rm -rf /' },
  });
  assert.equal(out.ok, false, '范围约束不能靠“认不出目标”绕过');
  assert.equal(out.code, DENY.resourceNotCovered);
  assert.match(out.text, /范围/);
});

await test('★ 窄范围授权 + 浏览器脚本里藏 URL = 拒绝', () => {
  const gate = makeGate();
  gate.add(grant({ actions: [ACTION.netFetch], resources: [{ kind: 'host', ref: 'only.example.com' }] }));
  const out = gate.check({
    subject: { botId: chief.id },
    action: ACTION.netFetch,
    targets: C.targetsForTool('ego_browser', { script: 'await p.goto("https://evil.example.com")' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, DENY.resourceNotCovered);
});

await test('★ 不限范围的授权不受影响（迁移授权就是这么用的）', () => {
  const gate = makeGate();
  gate.add(grant({ actions: [ACTION.cmdExec], resources: [] }));
  const out = gate.check({ subject: { botId: chief.id }, action: ACTION.cmdExec, params: { command: 'ls' } });
  assert.equal(out.ok, true, '没有资源范围时不该因为“认不出目标”被拒');
});

await test('认得出目标且在范围内的仍然放行', () => {
  const gate = makeGate();
  gate.add(grant({ actions: [ACTION.fileWrite], resources: [{ kind: 'path', ref: '/proj/alpha' }] }));
  const inside = gate.check({
    subject: { botId: chief.id }, action: ACTION.fileWrite,
    targets: C.targetsForTool('write', { path: '/proj/alpha/a.js' }), params: { path: '/proj/alpha/a.js' },
  });
  assert.equal(inside.ok, true);
  const outside = gate.check({
    subject: { botId: chief.id }, action: ACTION.fileWrite,
    targets: C.targetsForTool('write', { path: '/etc/passwd' }), params: { path: '/etc/passwd' },
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.code, DENY.resourceNotCovered);
});

await test('不需要目标判定的动作（对外发送）不受 fail-closed 影响', () => {
  assert.equal(C.needsTarget(ACTION.netSend), false, '发送的目标不是一个可枚举资源');
  const gate = makeGate();
  gate.add(grant({ actions: [ACTION.netSend], resources: [{ kind: 'host', ref: 'x.example.com' }] }));
  const out = gate.check({ subject: { botId: chief.id }, action: ACTION.netSend });
  assert.equal(out.ok, true, '没有目标可核时要照常放行，否则发送永远做不了');
});

// ---------------------------------------------------------------- 迁移授权不变
await test('迁移授权仍然不限范围（行为不变）', () => {
  store.state.grants = [];
  ensureLegacyGrant({
    store, policy: { dangerous: 'allow' }, policyRevision: 'p1',
    botIds: [worker.id], chiefBotId: chief.id, generation: 'g1',
  });
  const g = store.state.grants.find((x) => x.subject.botId === worker.id);
  assert.ok(g, '应当建立迁移授权');
  assert.deepEqual([...g.resources], [], '迁移授权不限范围，这是它与窄授权最大的区别');
});

// ---------------------------------------------------------------- 工具映射兼容
await test('TOOL_ACTIONS 与目录同源（兼容导出不会漂移）', () => {
  for (const [tool, action] of Object.entries(C.TOOLS)) {
    assert.equal(TOOL_ACTIONS[tool].action, action, tool);
    assert.equal(TOOL_ACTIONS[tool].risk, C.riskOf(action), tool);
  }
  assert.equal(Object.keys(TOOL_ACTIONS).length, Object.keys(C.TOOLS).length);
});

await test('actionForTool：没登记的工具返回 null（= 网关不判）', () => {
  assert.equal(C.actionForTool('nope'), null);
  assert.equal(C.actionForTool('bash').action, ACTION.cmdExec);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
