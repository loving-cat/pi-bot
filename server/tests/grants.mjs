/**
 * 授权模型与网关的纯逻辑测试。
 *   node tests/grants.mjs
 *
 * 守的是规格 v1.0.1 里三条不可放宽的规则：
 *   1. 授权根只能来自用户交互 / 已保存规则（模型、群消息、角色提示词都不算）
 *   2. 子授权不能比父授权更宽（动作/资源/期限/次数/模式）
 *   3. 父链任何一环撤销，下游立刻失效
 *
 * 以及网关的判定顺序：有效性 → 父链 → 覆盖 → 审计。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-grants-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
});

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const G = await import(src('grants.js'));
const { createGrantGate, ensureLegacyGrant, TOOL_ACTIONS } = await import(src('grant-gate.js'));
const { store } = await import(src('store.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const {
  ACTION, DENY, MODE, SOURCE, RISK,
  normalizeResource, resourceCovers, normalizeGrant,
  checkGrantValidity, grantCovers, deriveGrant, checkChain, describeGrant,
} = G;

const chief = store.mainBot();
const worker = store.createBot({ name: '执行者', persona: '测试' });

/** 造一条合法根授权（不落 store，纯对象）。 */
const rootGrant = (over = {}) => ({
  id: 'gr_root',
  source: SOURCE.user,
  sourceRef: '用户在某次对话里点了批准',
  subject: { botId: chief.id, role: 'main' },
  actions: [ACTION.fileRead, ACTION.fileWrite, ACTION.cmdExec],
  resources: [{ kind: 'path', ref: '/proj/alpha' }],
  mode: MODE.project,
  canDelegate: true,
  maxUses: null,
  createdAt: Date.now() - 1000,
  expiresAt: null,
  ...over,
});

// ---------------------------------------------------------------- 资源
await test('资源规范化：路径归一、非路径不折叠', () => {
  const p = normalizeResource({ kind: 'path', ref: 'D:\\proj\\alpha\\' });
  assert.ok(p);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(p.ref, 'd:/proj/alpha');
  } else {
    assert.equal(p.ref, 'D:/proj/alpha');
  }
  assert.equal(normalizeResource({ kind: 'path', ref: '///' }), null);
  assert.equal(normalizeResource({ kind: 'bogus', ref: 'x' }), null);
  assert.equal(normalizeResource(null), null);
});

await test('资源覆盖：路径祖先覆盖子项，其它种类必须精确相等', () => {
  const parent = normalizeResource({ kind: 'path', ref: '/proj/alpha' });
  const child = normalizeResource({ kind: 'path', ref: '/proj/alpha/src/a.js' });
  const sibling = normalizeResource({ kind: 'path', ref: '/proj/beta/x.js' });
  assert.ok(resourceCovers(parent, child));
  assert.ok(!resourceCovers(parent, sibling));
  assert.ok(!resourceCovers(child, parent), '子项不覆盖祖先');

  const hostA = normalizeResource({ kind: 'host', ref: 'api.example.com' });
  assert.ok(resourceCovers(hostA, hostA));
  assert.ok(!resourceCovers(hostA, normalizeResource({ kind: 'host', ref: 'evil.example.com' })));
});

// ---------------------------------------------------------------- 记录校验
await test('来源必须合法：模型/群消息不能建授权', () => {
  for (const bad of ['model', 'group-message', 'webpage', 'self-approved', '']) {
    const r = normalizeGrant(rootGrant({ source: bad }));
    assert.equal(r.ok, false, `来源「${bad}」必须被拒`);
    assert.equal(r.code, DENY.badSource);
  }
});

await test('未知动作与非法动作列表被拒', () => {
  assert.equal(normalizeGrant(rootGrant({ actions: ['file.everything'] })).ok, false);
  assert.equal(normalizeGrant(rootGrant({ actions: [] })).ok, false);
  assert.equal(normalizeGrant(rootGrant({ actions: undefined })).ok, false);
});

await test('合法记录被规范化且冻结（改不动）', () => {
  const r = normalizeGrant(rootGrant());
  assert.equal(r.ok, true);
  assert.throws(() => { r.grant.actions.push('x'); }, /object is not extensible|Cannot add/);
});

// ---------------------------------------------------------------- 有效性
await test('过期 / 撤销 / 次数用尽 都拒绝', () => {
  const now = Date.now();
  const exp = normalizeGrant(rootGrant({ expiresAt: now - 1 })).grant;
  assert.equal(checkGrantValidity({ grant: exp, now }).code, DENY.expired);

  const rev = normalizeGrant(rootGrant({ revokedAt: now - 10, revokedReason: '用户收回' })).grant;
  assert.equal(checkGrantValidity({ grant: rev, now }).code, DENY.revoked);

  const used = normalizeGrant(rootGrant({ maxUses: 2 })).grant;
  assert.equal(checkGrantValidity({ grant: used, now, usedUses: 2 }).code, DENY.exhausted);
  assert.equal(checkGrantValidity({ grant: used, now, usedUses: 1 }).ok, true);
});

await test('策略版本变化让旧授权失效', () => {
  const g = normalizeGrant(rootGrant({ policyRevision: 'p1' })).grant;
  assert.equal(checkGrantValidity({ grant: g, now: Date.now(), policyRevision: 'p2' }).code, DENY.policyChanged);
  assert.equal(checkGrantValidity({ grant: g, now: Date.now(), policyRevision: 'p1' }).ok, true);
});

await test('实例世代变化让旧授权失效', () => {
  const g = normalizeGrant(rootGrant({ generation: 'i1' })).grant;
  assert.equal(checkGrantValidity({ grant: g, now: Date.now(), generation: 'i2' }).code, DENY.generationStale);
});

// ---------------------------------------------------------------- 覆盖
await test('动作不覆盖就拒，资源不覆盖就拒', () => {
  const g = normalizeGrant(rootGrant()).grant;
  assert.equal(grantCovers({ grant: g, action: ACTION.gitPush }).code, DENY.actionNotCovered);
  assert.equal(
    grantCovers({ grant: g, action: ACTION.fileWrite, targets: [{ kind: 'path', ref: '/proj/beta/x' }] }).code,
    DENY.resourceNotCovered,
  );
  assert.ok(grantCovers({ grant: g, action: ACTION.fileWrite, targets: [{ kind: 'path', ref: '/proj/alpha/a.js' }] }).ok);
});

await test('参数约束：deny / allow / maxBytes', () => {
  const g = normalizeGrant(rootGrant({
    constraints: { [ACTION.cmdExec]: { deny: ['rm -rf', 'curl | sh'], maxBytes: 200 } },
  })).grant;
  assert.equal(
    grantCovers({ grant: g, action: ACTION.cmdExec, params: { command: 'rm -rf /' } }).code,
    DENY.constraintFailed,
  );
  assert.ok(grantCovers({ grant: g, action: ACTION.cmdExec, params: { command: 'npm test' } }).ok);
  assert.equal(
    grantCovers({ grant: g, action: ACTION.cmdExec, params: { command: 'x'.repeat(300) } }).code,
    DENY.constraintFailed,
  );
});

// ---------------------------------------------------------------- 派生
await test('子授权不能加动作 / 扩资源 / 延长期限 / 增加次数', () => {
  const parent = normalizeGrant(rootGrant({ expiresAt: Date.now() + 60_000, maxUses: 5 })).grant;

  assert.equal(deriveGrant({
    parent,
    child: { id: 'gr_c1', subject: { botId: worker.id }, actions: [ACTION.gitPush], resources: [] },
  }).code, DENY.tooWide, '加动作应被拒');

  assert.equal(deriveGrant({
    parent,
    child: { id: 'gr_c2', subject: { botId: worker.id }, actions: [ACTION.fileRead], resources: [{ kind: 'path', ref: '/proj/other' }] },
  }).code, DENY.tooWide, '扩资源应被拒');

  assert.equal(deriveGrant({
    parent,
    child: {
      id: 'gr_c3', subject: { botId: worker.id }, actions: [ACTION.fileRead],
      resources: [{ kind: 'path', ref: '/proj/alpha' }], expiresAt: Date.now() + 600_000,
    },
  }).code, DENY.tooWide, '延长期限应被拒');

  assert.equal(deriveGrant({
    parent,
    child: {
      id: 'gr_c4', subject: { botId: worker.id }, actions: [ACTION.fileRead],
      resources: [], maxUses: 99,
    },
  }).code, DENY.tooWide, '增加次数应被拒');
});

await test('合法子授权：收窄后成功，且默认不能再转授', () => {
  const parent = normalizeGrant(rootGrant({ expiresAt: Date.now() + 60_000, maxUses: 5 })).grant;
  const out = deriveGrant({
    parent,
    child: {
      id: 'gr_ok', subject: { botId: worker.id }, actions: [ACTION.fileRead],
      resources: [{ kind: 'path', ref: '/proj/alpha/src' }],
      expiresAt: Date.now() + 30_000, maxUses: 2, mode: MODE.project,
    },
  });
  assert.equal(out.ok, true, out.text ?? '');
  assert.equal(out.grant.canDelegate, false, '子授权默认不能再转授');
  assert.equal(out.grant.source, 'delegated');
  assert.equal(out.grant.parentId, 'gr_root');
});

await test('父授权不可转授时直接拒绝', () => {
  const parent = normalizeGrant(rootGrant({ canDelegate: false })).grant;
  assert.equal(deriveGrant({
    parent,
    child: { id: 'gr_x', subject: { botId: worker.id }, actions: [ACTION.fileRead], resources: [] },
  }).code, DENY.cannotDelegate);
});

await test('模式不能比父更宽：isolated < project < host', () => {
  const parent = normalizeGrant(rootGrant({ mode: MODE.project })).grant;
  assert.equal(deriveGrant({
    parent,
    child: { id: 'gr_m', subject: { botId: worker.id }, actions: [ACTION.fileRead], resources: [], mode: MODE.host },
  }).code, DENY.tooWide);
  assert.equal(deriveGrant({
    parent,
    child: { id: 'gr_m2', subject: { botId: worker.id }, actions: [ACTION.fileRead], resources: [], mode: MODE.isolated },
  }).ok, true);
});

// ---------------------------------------------------------------- 父链
await test('父链：上游撤销 → 下游立刻失效', () => {
  const parent = normalizeGrant(rootGrant({ revokedAt: Date.now() - 1 })).grant;
  const child = normalizeGrant({
    ...rootGrant({
      id: 'gr_child', source: 'delegated', parentId: 'gr_root',
      subject: { botId: worker.id }, actions: [ACTION.fileRead], resources: [],
    }),
  }).grant;
  const map = new Map([['gr_root', parent], ['gr_child', child]]);
  const out = checkChain({ grant: child, lookup: (id) => map.get(id) ?? null, now: Date.now() });
  assert.equal(out.ok, false);
  assert.equal(out.code, DENY.parentInvalid);
});

await test('父链：找不到父 / 出现环 都拒绝', () => {
  const orphan = normalizeGrant({
    ...rootGrant({ id: 'gr_orphan', source: 'delegated', parentId: 'gr_missing' }),
  }).grant;
  assert.equal(checkChain({ grant: orphan, lookup: () => null, now: Date.now() }).code, DENY.parentInvalid);

  const a = normalizeGrant({ ...rootGrant({ id: 'gr_a', source: 'delegated', parentId: 'gr_b' }) }).grant;
  const b = normalizeGrant({ ...rootGrant({ id: 'gr_b', source: 'delegated', parentId: 'gr_a' }) }).grant;
  const map = new Map([['gr_a', a], ['gr_b', b]]);
  assert.equal(checkChain({ grant: a, lookup: (id) => map.get(id) ?? null, now: Date.now() }).code, DENY.parentInvalid);
});

await test('父链：完整链路通过', () => {
  const parent = normalizeGrant(rootGrant()).grant;
  const child = normalizeGrant({
    ...rootGrant({ id: 'gr_ok2', source: 'delegated', parentId: 'gr_root', actions: [ACTION.fileRead], resources: [] }),
  }).grant;
  const map = new Map([['gr_root', parent], ['gr_ok2', child]]);
  assert.equal(checkChain({ grant: child, lookup: (id) => map.get(id) ?? null, now: Date.now() }).ok, true);
});

// ---------------------------------------------------------------- 网关
/** 造一个干净网关（每个用例独立，避免授权串味）。 */
function makeGate({ policyRevision = 'p1', generation = null } = {}) {
  store.state.grants = [];
  store.state.grantAudit = [];
  return createGrantGate({
    store,
    currentPolicyRevision: () => policyRevision,
    currentGeneration: () => generation,
    log: () => {},
  });
}

await test('网关：没有授权 → no_grant，并留一条审计', () => {
  const gate = makeGate();
  const out = gate.check({ subject: { botId: worker.id }, action: ACTION.fileWrite, targets: [{ kind: 'path', ref: '/proj/alpha/a.js' }] });
  assert.equal(out.ok, false);
  assert.equal(out.code, DENY.noGrant);
  assert.equal(out.audit.result, 'deny');
  assert.equal(gate.recentAudit({ onlyDenied: true }).length, 1);
});

await test('网关：有授权且覆盖 → 放行 + 审计 allow', () => {
  const gate = makeGate();
  gate.add(rootGrant({ subject: { botId: worker.id } }));
  const out = gate.check({
    subject: { botId: worker.id },
    action: ACTION.fileWrite,
    targets: [{ kind: 'path', ref: '/proj/alpha/a.js' }],
  });
  assert.equal(out.ok, true, out.text ?? '');
  assert.equal(out.audit.result, 'allow');
  assert.equal(gate.recentAudit().length, 1);
});

await test('网关：别人的授权不能给这个 bot 用', () => {
  const gate = makeGate();
  gate.add(rootGrant({ subject: { botId: chief.id } }));
  const out = gate.check({ subject: { botId: worker.id }, action: ACTION.fileRead, targets: [] });
  assert.equal(out.code, DENY.noGrant);
});

await test('网关：指定 grantId 时只看那一条，且必须属于本人', () => {
  const gate = makeGate();
  const mine = gate.add(rootGrant({ id: 'gr_mine', subject: { botId: worker.id }, actions: [ACTION.fileRead] }));
  assert.equal(mine.ok, true);
  const others = gate.add(rootGrant({ id: 'gr_other', subject: { botId: chief.id }, actions: [ACTION.fileRead] }));
  assert.equal(others.ok, true);

  const ok = gate.check({ subject: { botId: worker.id }, action: ACTION.fileRead, grantId: 'gr_mine' });
  assert.equal(ok.ok, true);

  const stolen = gate.check({ subject: { botId: worker.id }, action: ACTION.fileRead, grantId: 'gr_other' });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.code, DENY.resourceNotCovered);
});

await test('网关：策略版本对不上 → policy_changed，不放行', () => {
  const gate = makeGate({ policyRevision: 'p1' });
  gate.add(rootGrant({ subject: { botId: worker.id }, policyRevision: 'p1' }));
  // 换成 p2 后同一条授权不再有效
  const gate2 = createGrantGate({
    store,
    currentPolicyRevision: () => 'p2',
    log: () => {},
  });
  const out = gate2.check({ subject: { botId: worker.id }, action: ACTION.fileRead });
  assert.equal(out.ok, false);
  assert.equal(out.code, DENY.policyChanged);
});

await test('网关：撤销父授权后，下游立刻失效（不靠子授权自己过期）', () => {
  const gate = makeGate();
  const parent = gate.add(rootGrant({ id: 'gr_p', subject: { botId: chief.id }, actions: [ACTION.fileRead, ACTION.fileWrite] }));
  assert.equal(parent.ok, true);
  const childBuilt = deriveGrant({
    parent: gate.lookup('gr_p'),
    child: {
      id: 'gr_c', subject: { botId: worker.id }, actions: [ACTION.fileRead],
      resources: [], mode: MODE.project,
    },
  });
  assert.equal(childBuilt.ok, true, childBuilt.text ?? '');
  gate.add({ ...childBuilt.grant, createdAt: Date.now() });

  assert.equal(gate.check({ subject: { botId: worker.id }, action: ACTION.fileRead }).ok, true);

  const rev = gate.revoke('gr_p', '用户收回');
  assert.equal(rev.ok, true);
  assert.deepEqual(rev.downstream, ['gr_c'], '撤销父授权应连带标记下游');

  const after = gate.check({ subject: { botId: worker.id }, action: ACTION.fileRead });
  assert.equal(after.ok, false);
  assert.equal(after.code, DENY.revoked);
});

await test('网关：consume 记次数，用满后 exhausted', () => {
  const gate = makeGate();
  gate.add(rootGrant({ id: 'gr_use', subject: { botId: worker.id }, maxUses: 1 }));
  assert.equal(gate.check({ subject: { botId: worker.id }, action: ACTION.fileRead, grantId: 'gr_use' }).ok, true);
  assert.equal(gate.consume('gr_use'), 1);
  const after = gate.check({ subject: { botId: worker.id }, action: ACTION.fileRead, grantId: 'gr_use' });
  assert.equal(after.ok, false);
  assert.equal(after.code, DENY.exhausted);
});

await test('网关：审计不落原始参数（可能含密码）', () => {
  const gate = makeGate();
  gate.add(rootGrant({ subject: { botId: worker.id }, actions: [ACTION.cmdExec] }));
  gate.check({
    subject: { botId: worker.id },
    action: ACTION.cmdExec,
    params: { command: 'mysql -p SuperSecret123' },
  });
  const raw = JSON.stringify(store.state.grantAudit);
  assert.ok(!raw.includes('SuperSecret123'), '原始参数不该进审计');
});

// ---------------------------------------------------------------- 迁移兼容
await test('迁移兼容：legacy grant 幂等、每个 bot 一条、范围等于当前 policy', () => {
  store.state.grants = [];
  const ids = [chief.id, worker.id];
  const a = ensureLegacyGrant({ store, policy: { dangerous: 'allow' }, policyRevision: 'p1', botIds: ids, chiefBotId: chief.id });
  assert.equal(a.created.length, 2, '每个 bot 各一条');
  const b = ensureLegacyGrant({ store, policy: { dangerous: 'allow' }, policyRevision: 'p1', botIds: ids, chiefBotId: chief.id });
  assert.equal(b.created.length, 0, '第二次不该再建');
  assert.equal(b.existing.length, 2);
  assert.equal(store.state.grants.length, 2);

  const chiefGrant = store.state.grants.find((g) => g.subject.botId === chief.id);
  assert.equal(chiefGrant.source, SOURCE.legacyPolicy);
  assert.equal(chiefGrant.mode, MODE.host, '主 Bot 是 host 模式');
  assert.ok(chiefGrant.actions.includes(ACTION.cmdExec));
  assert.equal(chiefGrant.canDelegate, false, '迁移来的授权不能再转授');

  const workerGrant = store.state.grants.find((g) => g.subject.botId === worker.id);
  assert.equal(workerGrant.mode, MODE.project, '其他 bot 是 project 模式');
});

await test('迁移兼容：只读 policy 只给 fileRead', () => {
  store.state.grants = [];
  ensureLegacyGrant({ store, policy: { dangerous: 'deny' }, policyRevision: 'p1', botIds: [chief.id], chiefBotId: chief.id });
  const g = store.state.grants[0];
  assert.deepEqual([...g.actions], [ACTION.fileRead]);
});

// ---------------------------------------------------------------- 工具映射
await test('工具→动作映射覆盖全部动手工具', () => {
  for (const tool of ['bash', 'powershell', 'write', 'edit', 'run_background', 'write_stdin']) {
    assert.ok(TOOL_ACTIONS[tool], `${tool} 必须在网关上登记，否则就是"网关看不见的执行入口"`);
  }
});

await test('targetsForTool：从 path/url 推断目标', () => {
  const gate = makeGate();
  assert.deepEqual(
    gate.targetsForTool('write', { path: '/proj/alpha/a.js' }).map((t) => t.ref),
    ['/proj/alpha/a.js'],
  );
  assert.deepEqual(
    gate.targetsForTool('web_fetch', { url: 'https://api.example.com/v1/x' }).map((t) => t.ref),
    ['api.example.com'],
  );
  assert.deepEqual(gate.targetsForTool('bash', { command: 'ls' }), [], '命令的路径无法静态推断，不硬猜');
});

await test('describeGrant 不含凭据，只给可读摘要', () => {
  const g = normalizeGrant(rootGrant()).grant;
  const text = describeGrant(g);
  assert.match(text, /gr_root/);
  assert.match(text, /file\.read/);
  assert.ok(!text.includes('password'), text);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
