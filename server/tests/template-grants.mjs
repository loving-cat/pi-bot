/**
 * 模板与授权的测试（规格 §13.1「模板不得签发 grant」）。
 *
 *   node tests/template-grants.mjs
 *
 * 规格原话：模板只是「可申请能力」，不是有效授权；导入创建新实例/角色，
 * **必须重新授权**；升级保留自定义覆盖，**字段迁移不复制旧 grant**。
 *
 * 落到这个产品上就是三件事，每件都容易被"顺手"破掉：
 *   1. 模板里不能带授权记录（哪怕只有一条，也会跟着模板到处复制）；
 *   2. 用模板开出来的 bot，授权只能是**当前**政策推导出来的那条，
 *      不能是"模板创建时那套规矩"的；
 *   3. 克隆出来的 bot 必须有授权可用 —— 没有的话它在网关上就是
 *      "存在但什么都干不了"，用户只能重启服务端。
 *
 * 第 3 条曾经真的坏过：运行期新建的 bot 没人补登记。修法是网关挂
 * `bot.updated` 补一条 + 判前兜底（`migration-grants.js`）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tpl-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
  PI_BOT_TASK_INTAKE: '0',
});
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { bus } = await import(src('bus.js'));
const { createGrantGate } = await import(src('grant-gate.js'));
const { ensureLegacyGrant } = await import(src('migration-grants.js'));
const { ACTION, DENY } = await import(src('grants.js'));

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

/** 和生产同构的装配：补登记 + 事件订阅 + 网关。 */
function wire() {
  const sync = ({ botIds }) => ensureLegacyGrant({
    store,
    policy: store.policy(),
    policyRevision: store.policyVersion(),
    botIds,
    chiefBotId: chief.id,
    generation: 'gen-tpl',
  });
  sync({ botIds: store.listBots().map((b) => b.id) });
  const gate = createGrantGate({
    store,
    currentPolicyRevision: () => store.policyVersion(),
    currentGeneration: () => 'gen-tpl',
    syncGrants: sync,
    bus,
    log: () => {},
  });
  gate.start();
  return gate;
}

/** 造一个部门并存成模板，返回模板 id。 */
function makeTemplate(name = '测试模板') {
  const { room } = store.createDepartment({
    name: `${name}的来源组`,
    members: [{ name: `${name}成员甲`, persona: '甲' }, { name: `${name}成员乙`, persona: '乙' }],
    lead: `${name}成员甲`,
    createdBy: 'user',
  });
  const saved = store.saveTemplateFromRoom(room.id, { name });
  assert.ok(saved?.template || saved?.id, JSON.stringify(saved));
  return saved.template?.id ?? saved.id ?? name;
}

// ---------------------------------------------------------------- 模板不带授权
await test('★ 模板里不携带任何授权记录（规格 §13.1「模板不得签发 grant」）', () => {
  store.state.grants = [];
  const gate = wire();
  gate.add({
    source: 'user',
    subject: { botId: chief.id, role: 'main' },
    actions: [ACTION.cmdExec],
    resources: [],
    mode: 'host',
  });
  // 让授权表里确实有东西，再看模板会不会抄走
  assert.ok(store.state.grants.length >= 1);
  const id = makeTemplate('不带授权');
  const tpl = store.templates().find((t) => t.id === id || t.name === id);
  assert.ok(tpl, '模板应当存在');
  const keys = Object.keys(tpl);
  for (const forbidden of ['grants', 'grant', 'grantAudit', 'permissions', 'policyRevision']) {
    assert.ok(!keys.includes(forbidden), `模板不该带 ${forbidden}：${keys.join(',')}`);
  }
  // 序列化后再查一遍：嵌套字段也逃不掉
  const raw = JSON.stringify(tpl);
  assert.ok(!raw.includes('legacy-policy'), '模板里不该出现迁移授权');
  assert.ok(!raw.includes('sourceRef'), '模板里不该出现授权来源');
});

await test('★ 用模板开出来的 bot 拿到的是**当前**规矩下的授权', () => {
  store.state.grants = [];
  store.updatePolicy({ dangerous: 'allow' });
  const gate = wire();
  const tplId = makeTemplate('克隆用');
  const applied = store.applyTemplate(tplId, { name: '克隆组' });
  assert.ok(applied?.bots?.length, JSON.stringify(applied));
  const bot = applied.bots[0];

  const grants = store.state.grants.filter((g) => g.subject?.botId === bot.id && !g.revokedAt);
  assert.ok(grants.length >= 1, '克隆出来的 bot 必须有授权，否则它什么都干不了');
  const g = grants.at(-1);
  assert.equal(g.source, 'legacy-policy', '来源是“按当前政策发的”，不是从模板抄的');
  assert.equal(g.policyRevision, store.policyVersion(), '必须绑当前规矩版本');
  assert.equal(g.mode, 'project', '克隆出来的是普通成员（project 模式）');
  assert.equal(g.canDelegate, false);

  // 能真的干活
  const verdict = gate.check({ subject: { botId: bot.id }, action: ACTION.fileWrite });
  assert.equal(verdict.ok, true, `克隆出来的 bot 应当能写文件：${verdict.text}`);
});

await test('★ 模板克隆不吃旧规矩：切成只读后新克隆的 bot 也只剩只读', () => {
  store.state.grants = [];
  const gate = wire();
  const tplId = makeTemplate('只读克隆');
  // 模板在“允许”档下建的，但克隆发生在“只读”档。
  //
  // ★ 规矩变更后必须重发迁移授权 —— 生产在 `PATCH /api/policy` 里做
  //   （http.js 的 refreshLegacyGrantsForPolicy）。不重发的话旧授权还带着
  //   旧 revision，网关会一律报 policy_changed；那个现象已经有用例守了
  //   （grants.mjs 的“规矩变了要重发”），这里走生产路径。
  store.updatePolicy({ dangerous: 'deny' });
  ensureLegacyGrant({
    store,
    policy: store.policy(),
    policyRevision: store.policyVersion(),
    botIds: store.listBots().map((b) => b.id),
    chiefBotId: chief.id,
    generation: 'gen-tpl',
  });

  const applied = store.applyTemplate(tplId, { name: '只读克隆组' });
  const bot = applied.bots[0];
  const verdict = gate.check({ subject: { botId: bot.id }, action: ACTION.fileWrite });
  assert.equal(verdict.ok, false, '只读档下克隆出来的 bot 不该能写文件');
  assert.equal(
    verdict.code,
    DENY.actionNotCovered,
    `拒绝原因应该是“这条授权不包含这个动作”，而不是“规矩换了”（后者说明没重发），实际：${verdict.code}`,
  );
  const readonlyOk = gate.check({ subject: { botId: bot.id }, action: ACTION.fileRead });
  assert.equal(readonlyOk.ok, true, '读应当是允许的');

  // 复位
  store.updatePolicy({ dangerous: 'allow' });
});

await test('模板里的成员不带 mcpServers（否则等于把外部能力一并传下去）', () => {
  const id = makeTemplate('查能力');
  const tpl = store.templates().find((t) => t.id === id || t.name === id);
  const members = tpl.members ?? [];
  assert.ok(members.length >= 1);
  for (const m of members) {
    assert.equal(m.mcpServers, undefined, `模板成员不该带 mcpServers：${JSON.stringify(m)}`);
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
