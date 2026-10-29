/** 模型目录刷新与新团队分配回归；仅使用隔离配置、假运行时和合成模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-model-dispatch-'));
const inherited = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS']);
for (const name of Object.keys(process.env)) if (!inherited.has(name)) delete process.env[name];
Object.assign(process.env, {
  HOME: path.join(root, 'home'), PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_HOME: path.join(root, 'data'), PI_BOT_WORKSPACE: path.join(root, 'workspace'),
  PI_BOT_PROBE: '0', PI_BOT_WATCH_CHANGES: '0', PI_BOT_AUTO_ATTACH_IMAGES: '0',
});
for (const dir of [process.env.HOME, process.env.PI_CODING_AGENT_DIR, process.env.PI_BOT_WORKSPACE]) fs.mkdirSync(dir, { recursive: true });
const fixtureFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('fixture forbids network'); };

const { modelGroups } = await import('../src/model-groups.js');
const { ModelHealth } = await import('../src/model-health.js');
const { resolveMenu, renderMenu, defaultMenuSlug, matchMenuEntry } = await import('../src/model-menu.js');
const { CHIEF_MODEL_POLICY, effectiveModelPersona, modelCatalogSection, departmentModelConflicts } = await import('../src/model-dispatch.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { store, MAIN_PERSONA } = await import('../src/store.js');
const { retireStaleSession } = await import('../src/session-refresh.js');
const { buildChiefTools } = await import('../src/tools.js');
const { createSessionBuilder } = await import('../src/session-factory.js');
const { bus } = await import('../src/bus.js');
const { createHttpServer } = await import('../src/http.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.log(`✗ ${name}: ${error.stack}`); }
}
const registry = new Map();
const runner = new PiRunner();
runner.modelRuntime = {
  registerProvider(id, config) {
    this.unregisterProvider(id);
    for (const model of config.models) registry.set(`${id}/${model.id}`, { ...model, provider: id });
  },
  unregisterProvider(id) { for (const key of registry.keys()) if (key.startsWith(`${id}/`)) registry.delete(key); },
  getModels: () => [...registry.values()], getModel: (provider, id) => registry.get(`${provider}/${id}`),
  getAvailable: async () => [...registry.values()],
};
runner.health = new ModelHealth(runner, { autoProbe: false });
const health = runner.health;
const group = (name, model) => {
  const result = modelGroups.upsert({ name, baseUrl: 'https://example.test', apiKey: 'fixture-secret-model-group', enabled: true,
    models: [{ id: model, contextWindow: 64000, maxTokens: 4096 }] });
  assert.ok(result.group, result.error);
  return result.group;
};
const first = group('fixture primary', 'old-model');
const oldSlug = `${first.id}/old-model`;
await runner.applyModelGroupChange(first.id);
health.results[oldSlug] = { ok: true, at: Date.now() };
const chief = store.mainBot();
store.updateBot(chief.id, { model: oldSlug });
const tools = () => buildChiefTools({ runner, health, roomId: 'dm_chief', botId: chief.id });
const tool = (name) => tools().find((entry) => entry.name === name);
const cachedMenuTool = tool('list_models');
let newer, newSlug;

try {
  await test('跨组同名裸模型与重复别名拒绝歧义，完整标识优先', () => {
    const entries = [
      { alias: 'same/shared', slugs: ['old-group/shared'], use: 'fixture' },
      { alias: 'same/shared', slugs: ['new-group/shared'], use: 'fixture' },
      { alias: 'new-group/shared', slugs: ['third-group/other'], use: 'fixture' },
    ];
    assert.equal(resolveMenu('shared', null, entries), null);
    assert.equal(matchMenuEntry('shared', entries).reason, 'ambiguous');
    assert.equal(resolveMenu('same/shared', null, entries), null);
    assert.equal(resolveMenu('new-group/shared', null, entries).slug, 'new-group/shared');
    assert.equal(resolveMenu('old-group/shared', null, entries).slug, 'old-group/shared');
    assert.equal(resolveMenu('other', null, entries).slug, 'third-group/other');
    const routes = [{ alias: 'family', slugs: ['one/model', 'two/model'], use: 'fixture' }];
    const healthy = { isKnownGood: (slug) => slug === 'two/model', hasFreshFor: () => false };
    assert.equal(resolveMenu('one/model', healthy, routes).slug, 'one/model');
    assert.equal(resolveMenu('family', healthy, routes).slug, 'two/model');
  });
  await test('默认主控提示不再限制固定型号，旧默认块仅在会话替换', () => {
    assert.ok(MAIN_PERSONA.includes(CHIEF_MODEL_POLICY));
    assert.doesNotMatch(MAIN_PERSONA, /只能从这 4 个里挑/);
    const legacy = fs.readFileSync(new URL('./fixtures/chief-model-policy-legacy.txt', import.meta.url), 'utf8').trimEnd();
    const persona = `用户自定义开头\n${legacy}\n用户自定义结尾`;
    const bot = { role: 'main', persona };
    const effective = effectiveModelPersona(bot);
    assert.ok(effective.includes(CHIEF_MODEL_POLICY));
    assert.ok(effective.startsWith('用户自定义开头\n'));
    assert.ok(effective.endsWith('\n用户自定义结尾'));
    assert.equal(bot.persona, persona);
    assert.equal(effectiveModelPersona({ ...bot, role: 'member' }), persona);
    const custom = persona.replace('只能从这 4 个里挑', '用户指定只从这 4 个里挑');
    assert.equal(effectiveModelPersona({ role: 'main', persona: custom }), custom);
    const changed = persona.replace('写代码/改文件/跑命令的主力', '用户特别指定的范围');
    assert.equal(effectiveModelPersona({ role: 'main', persona: changed }), changed);
  });

  await test('新增未验证模型不会因旧模型有健康记录被判为失败', async () => {
    newer = group('fixture added', 'new-model');
    newSlug = `${newer.id}/new-model`;
    await runner.applyModelGroupChange(newer.id);
    const resolved = resolveMenu(newSlug, health);
    assert.equal(resolved.slug, newSlug);
    assert.equal(resolved.alive, true);
    assert.equal(resolved.status, 'unverified');
    assert.match(renderMenu(modelGroups.menuEntries(), health), /未验证，可选择/);
    assert.equal(defaultMenuSlug(health), oldSlug, '既有健康默认模型不强切到最新模型');
    assert.equal(runner.modelLabel(), oldSlug);
  });

  await test('已知失败拒绝、过期失败变未验证，目录读取不排队探测', () => {
    health.results[newSlug] = { ok: false, at: Date.now() };
    assert.equal(resolveMenu(newSlug, health).status, 'unavailable');
    health.results[newSlug].at = Date.now() - health.ttlMs - 1;
    health.autoProbe = true;
    assert.equal(resolveMenu(newSlug, health).status, 'unverified');
    assert.equal(health.refreshTimer, null);
    assert.equal(health.refreshQueue.size, 0);
    health.autoProbe = false;
  });

  await test('配置更新刷新固定旧模型的主控，忙轮完成前不释放', async () => {
    const oldMember = store.createBot({ name: 'fixture old member', model: oldSlug });
    let disposed = 0;
    const chiefEntry = { bot: store.getBot(chief.id), busy: true, session: { model: runner.resolveModel(oldSlug), dispose: () => disposed++ } };
    const memberEntry = { bot: oldMember, busy: false, session: { model: runner.resolveModel(oldSlug), dispose: () => disposed++ } };
    runner.sessions.set('fixture-chief', chiefEntry);
    runner.sessions.set('fixture-member', memberEntry);
    modelGroups.upsert({ id: newer.id, models: [{ id: 'new-model', contextWindow: 256000, maxTokens: 8192 }] });
    await runner.applyModelGroupChange(newer.id);
    assert.equal(chiefEntry.reloadPending, true);
    assert.equal(memberEntry.reloadPending, undefined);
    assert.equal(retireStaleSession(runner.sessions, 'fixture-chief'), false);
    assert.equal(disposed, 0);
    chiefEntry.busy = false;
    assert.equal(retireStaleSession(runner.sessions, 'fixture-chief'), true);
    assert.equal(disposed, 1);
    assert.equal(store.getBot(chief.id).model, oldSlug);
    assert.equal(store.getBot(oldMember.id).model, oldSlug);
  });

  await test('新主控会话包含最新目录但维持其指定执行模型', async () => {
    let resourceOptions, agentOptions;
    const sessionApi = {
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
      SessionManager: { create: () => ({}), open: () => ({}) },
      DefaultResourceLoader: class { constructor(options) { resourceOptions = options; } async reload() {} },
      createAgentSession: async (options) => {
        agentOptions = options;
        return { session: { model: options.model, settingsManager: { applyOverrides() {} } } };
      },
    };
    const builder = createSessionBuilder({ runner, health, resolveModel: (slug) => runner.resolveModel(slug), modelLabel: () => runner.modelLabel(), sessionApi });
    await builder('dm_chief', chief.id);
    const prompt = resourceOptions.appendSystemPrompt.join('\n');
    assert.ok(prompt.includes(oldSlug));
    assert.ok(prompt.includes(newSlug));
    assert.ok(prompt.includes('256000'));
    assert.equal(`${agentOptions.model.provider}/${agentOptions.model.id}`, oldSlug);
    assert.ok(!prompt.includes('fixture-secret-model-group'));
  });

  await test('list_models动态读取新增目录且不建议固定第一个', async () => {
    const result = await cachedMenuTool.execute('fixture', {});
    const text = result.content.map((part) => part.text).join('');
    assert.ok(text.includes(newSlug));
    assert.ok(text.includes('未验证'));
    assert.ok(!text.includes('没把握就用列表第一个'));
  });

  await test('新Bot可以选择未验证的新模型，已知失败模型不创建', async () => {
    const created = await tool('create_bot').execute('fixture', { name: 'fixture fresh member', persona: '负责合成测试', tagline: '验证模型分配', model: newSlug });
    assert.ok(!created.isError);
    assert.equal(store.getBot(created.details.botId).model, newSlug);
    health.results[newSlug] = { ok: false, at: Date.now() };
    const before = store.listBots().length;
    const rejected = await tool('create_bot').execute('fixture', { name: 'fixture rejected', persona: 'fixture', model: newSlug });
    assert.equal(rejected.isError, true);
    assert.equal(store.listBots().length, before);
    delete health.results[newSlug];
  });

  await test('新团队实际成员保留显式新模型，旧成员指定模型不变', async () => {
    const result = await tool('create_department').execute('fixture', {
      name: 'fixture new team', lead: 'fixture new lead',
      members: [{ name: 'fixture new lead', persona: '协调', tagline: '协调测试', model: newSlug },
        { name: 'fixture new worker', persona: '执行', tagline: '执行测试', model: newSlug }],
    });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(store.listBots().find((bot) => bot.name === 'fixture new lead').model, newSlug);
    assert.equal(store.listBots().find((bot) => bot.name === 'fixture new worker').model, newSlug);
    assert.equal(store.listBots().find((bot) => bot.name === 'fixture old member').model, oldSlug);
  });

  await test('新成员会话实际装配为所选新模型，不回退全局旧模型', async () => {
    let options;
    const member = store.listBots().find((bot) => bot.name === 'fixture new worker');
    const sessionApi = {
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
      SessionManager: { create: () => ({}), open: () => ({}) },
      DefaultResourceLoader: class { async reload() {} },
      createAgentSession: async (value) => {
        options = value;
        return { session: { model: value.model, settingsManager: { applyOverrides() {} } } };
      },
    };
    const builder = createSessionBuilder({ runner, health, resolveModel: (slug) => runner.resolveModel(slug), modelLabel: () => runner.modelLabel(), sessionApi });
    await builder(store.ensureDm(member.id).id, member.id);
    assert.equal(`${options.model.provider}/${options.model.id}`, newSlug);
    assert.equal(runner.modelLabel(), oldSlug);
  });

  await test('同名旧人模型冲突整批拒绝，不创建前面的新成员', async () => {
    const before = { bots: store.listBots().length, rooms: store.listRooms().length };
    const result = await tool('create_department').execute('fixture', {
      name: 'fixture conflict team', lead: 'fixture should not create',
      members: [{ name: 'fixture should not create', persona: 'fixture', model: newSlug },
        { name: 'fixture old member', persona: 'fixture', model: newSlug }],
    });
    assert.equal(result.isError, true);
    assert.equal(store.listBots().length, before.bots);
    assert.equal(store.listRooms().length, before.rooms);
    assert.equal(store.listBots().find((bot) => bot.name === 'fixture old member').model, oldSlug);
    assert.deepEqual(departmentModelConflicts([{ name: 'a', model: newSlug }], [{ name: 'a', model: null }], newSlug), []);
    assert.equal(departmentModelConflicts([{ name: 'a' }, { name: 'a' }]).length, 1);
  });

  await test('Bot PATCH拒绝不存在或停用模型，歧义不写入且旧失效配置可编辑其他字段', async () => {
    const duplicate = group('fixture duplicate', 'old-model');
    await runner.applyModelGroupChange(duplicate.id);
    const duplicateSlug = `${duplicate.id}/old-model`;
    const target = store.createBot({ name: 'fixture http model', model: oldSlug });
    let reloads = 0;
    const httpRunner = { ...runner, resolveModel: (slug) => runner.resolveModel(slug),
      reloadSessionForBot: () => reloads++ };
    const server = createHttpServer({ runner: httpRunner, pairing: {} });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/api/bots/${target.id}`;
    const patch = async (body) => {
      const response = await fixtureFetch(endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    try {
      let result = await patch({ model: 'missing-group/missing-model' });
      assert.equal(result.status, 400);
      assert.equal(store.getBot(target.id).model, oldSlug);
      result = await patch({ model: 'old-model' });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /歧义/);
      assert.equal(reloads, 0);
      result = await patch({ model: duplicateSlug });
      assert.equal(result.status, 200);
      assert.equal(result.body.bot.model, duplicateSlug);
      result = await patch({ model: 'fixture added/new-model' });
      assert.equal(result.status, 200);
      assert.equal(result.body.bot.model, newSlug);
      modelGroups.upsert({ id: duplicate.id, enabled: false });
      // 模拟runtime目录暂未清掉，停用配置本身仍须拦住。
      result = await patch({ model: duplicateSlug });
      assert.equal(result.status, 400);
      assert.equal(store.getBot(target.id).model, newSlug);
      store.updateBot(target.id, { model: 'removed-group/old-model' });
      result = await patch({ tagline: '允许修订其他资料' });
      assert.equal(result.status, 200);
      assert.equal(result.body.bot.model, 'removed-group/old-model');
      result = await patch({ model: null });
      assert.equal(result.status, 200);
      assert.equal(result.body.bot.model, null);
      result = await patch({ model: oldSlug });
      assert.equal(result.status, 200);
      result = await patch({ model: '' });
      assert.equal(result.body.bot.model, null);
      assert.equal((await patch({ model: { id: 'bad' } })).status, 400);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      modelGroups.remove(duplicate.id);
      await runner.applyModelGroupChange(duplicate.id);
    }
  });

  await test('禁用或移除组后目录立即移除，主控缓存再次失效', async () => {
    const entry = { bot: store.getBot(chief.id), session: { model: runner.resolveModel(oldSlug) } };
    runner.sessions.set('chief-updated', entry);
    modelGroups.upsert({ id: newer.id, enabled: false });
    await runner.applyModelGroupChange(newer.id);
    assert.equal(resolveMenu(newSlug, health), null);
    assert.equal(entry.reloadPending, true);
    assert.ok(!modelCatalogSection(modelGroups.menuEntries(), health).includes(newSlug));
    modelGroups.upsert({ id: newer.id, enabled: true });
    await runner.applyModelGroupChange(newer.id);
    assert.ok(resolveMenu(newSlug, health));
    modelGroups.remove(newer.id);
    await runner.applyModelGroupChange(newer.id);
    assert.equal(resolveMenu(newSlug, health), null);
    assert.equal(runner.resolveModel(newSlug), null);
    assert.equal(store.getBot(chief.id).model, oldSlug);
  });
} finally {
  clearTimeout(store.saveTimer);
  store.saveTimer = null;
  store.saveNow();
  clearTimeout(health.refreshTimer); clearInterval(health.autoTimer);
  bus.removeAllListeners();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed}/${passed + failed} 通过`);
process.exitCode = failed ? 1 : 0;
