/**
 * Jarvis Superroot Mode（mainBot 最高权限与全能管家能力）单元测试。
 *   node tests/jarvis-mode.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-jarvis-'));
const dataDir = path.join(root, 'data');
const wsDir = path.join(root, 'workspace');
const externalRepo = path.join(root, 'external-host-repo');
const agentDir = path.join(root, 'agent');
for (const d of [dataDir, wsDir, externalRepo, agentDir, path.join(agentDir, 'skills', 'demo-skill')]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(
  path.join(agentDir, 'skills', 'demo-skill', 'SKILL.md'),
  '---\nname: 本地演示技能\ndescription: 用于验证本地导入\n---\n步骤 1：执行检查。\n',
  'utf8',
);
fs.writeFileSync(
  path.join(agentDir, 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      local_probe_mcp: {
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        description: '本地测试 MCP',
      },
    },
  }),
  'utf8',
);

Object.assign(process.env, {
  PI_BOT_HOME: dataDir,
  PI_BOT_WORKSPACE: wsDir,
  PI_CODING_AGENT_DIR: agentDir,
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
  PI_BOT_TASK_INTAKE: '0',
});
globalThis.fetch = () => {
  throw new Error('jarvis-mode 单元测试禁止真实联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { bus } = await import(src('bus.js'));
const { loadOrCreateKey } = await import(src('secrets.js'));
store.useSecretsKey(loadOrCreateKey(dataDir));

const { buildSandboxedShellTools, setSandboxProbe, setMcpCounter } = await import(src('sandboxed-shell.js'));
const { executionModeOf } = await import(src('exec-mode.js'));
const { createPolicyExtension } = await import(src('policy-hook.js'));
const { createGrantGate } = await import(src('grant-gate.js'));
const { buildCommonTools, buildChiefTools } = await import(src('tools.js'));
const { buildGitTools } = await import(src('git-tools.js'));
const { shells } = await import(src('shells.js'));
const { modelGroups } = await import(src('model-groups.js'));
const { redactChatSecrets, maskSecretValue } = await import(src('chat-redact.js'));
const { MODE, ACTION } = await import(src('grants.js'));
const { locateGit } = await import(src('git-ops.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.stack || err?.message || String(err) });
  }
}

const chief = store.mainBot();
const chiefDm = store.ensureDm(chief.id);
const member = store.createBot({ name: '执行成员', persona: '写代码' });
const memberDm = store.ensureDm(member.id);

// 初始化一个工作区外独立 Git 仓库
let hasGit = false;
{
  const g = locateGit();
  if (g.ok) {
    hasGit = true;
    execFileSync(g.file, ['init', '-q'], { cwd: externalRepo });
    execFileSync(g.file, ['config', 'user.name', 'jarvis-test'], { cwd: externalRepo });
    execFileSync(g.file, ['config', 'user.email', 'jarvis@example.com'], { cwd: externalRepo });
    fs.writeFileSync(path.join(externalRepo, 'README.md'), 'hello host repo\n');
  }
}

// Stub runner for tool calls
const registeredModels = [];
let defaultModelRef = null;
const runner = {
  model: null,
  routerModel: null,
  availableModels: [],
  modelLabel: () => (defaultModelRef ? `${defaultModelRef.provider}/${defaultModelRef.id}` : null),
  resolveModel: (slug) => {
    const clean = String(slug ?? '').trim();
    return registeredModels.find((m) => `${m.provider}/${m.id}` === clean || m.id === clean) ?? null;
  },
  async applyModelGroupChange(groupId) {
    registeredModels.length = 0;
    for (const g of modelGroups.list()) {
      if (!g.enabled) continue;
      for (const m of g.models) {
        registeredModels.push({ provider: g.id, id: m.id, name: m.name });
      }
    }
    this.availableModels = [...registeredModels];
    if (!defaultModelRef && registeredModels.length) {
      defaultModelRef = registeredModels[0];
      this.model = defaultModelRef;
    }
    bus.emit('event', { t: 'models.changed', groupId });
    return this.availableModels.length;
  },
  async setDefaultModel(slug) {
    const found = slug ? this.resolveModel(slug) : null;
    if (slug && !found) return { ok: false, error: `找不到可用模型：${slug}` };
    defaultModelRef = found;
    this.model = found;
    store.setDefaultModel(found ? `${found.provider}/${found.id}` : null);
    return { ok: true, model: this.modelLabel() };
  },
  async applyMcpChange() {
    bus.emit('event', { t: 'mcp.changed' });
  },
  applyPolicyChange() {
    return 0;
  },
  reloadAllSessions() {
    return 1;
  },
  reloadSessionForBot() {
    return 1;
  },
  resetSessionForBot() {
    return 1;
  },
  grantGeneration() {
    return 'gen-jarvis-test';
  },
  async greetDm() {
    return { ok: true };
  },
  currentTaskContext() {
    return null;
  },
};

const chiefCommon = buildCommonTools({ runner, roomId: chiefDm.id, botId: chief.id, isMain: true });
const chiefOnly = buildChiefTools({ runner, health: null, roomId: chiefDm.id, botId: chief.id });
const chiefToolsMap = Object.fromEntries([...chiefCommon, ...chiefOnly].map((t) => [t.name, t]));
const memberCommon = buildCommonTools({ runner, roomId: memberDm.id, botId: member.id, isMain: false });
const memberToolsMap = Object.fromEntries(memberCommon.map((t) => [t.name, t]));

const call = async (map, name, args = {}) => {
  const res = await map[name].execute('tc_1', args);
  return { text: res.content?.[0]?.text ?? '', isError: res.isError === true, details: res.details ?? {} };
};

// ---------------- 1. 宿主特权：挂 MCP 不进沙箱，保持 MODE.host
await test('mainBot 挂 MCP 也不被 sandboxed-shell 降级，executionModeOf 保持 MODE.host', () => {
  setSandboxProbe(() => ({ available: true, kind: 'mock' }));
  setMcpCounter(() => 1);
  const fakePi = {
    createBashTool: () => ({ name: 'bash' }),
    createPowerShellTool: () => ({ name: 'powershell' }),
  };

  const chiefReplaced = buildSandboxedShellTools({
    bot: chief, workDir: wsDir, dataDir, tools: ['bash', 'powershell'], pi: fakePi,
  });
  assert.deepEqual(chiefReplaced, [], 'mainBot 不应被替换成沙箱 shell');
  assert.equal(executionModeOf({ bot: chief, sandboxedToolNames: chiefReplaced.map((t) => t.name) }), MODE.host);

  const memberReplaced = buildSandboxedShellTools({
    bot: member, workDir: wsDir, dataDir, tools: ['bash', 'powershell'], pi: fakePi,
  });
  assert.ok(memberReplaced.length > 0, '普通成员挂 MCP 仍必须走沙箱 shell');
  assert.equal(executionModeOf({ bot: member, sandboxedToolNames: memberReplaced.map((t) => t.name) }), MODE.isolated);
  setMcpCounter(() => 0);
});

// ---------------- 2. policy-hook：ask/allow 零弹窗、Talk/只读继续受控、极高危一键确认
function makeHookHandler({ bot = chief, roomId = chiefDm.id, talkLane = false, gate = null } = {}) {
  let handler = null;
  const pi = { on: (ev, fn) => { if (ev === 'tool_call') handler = fn; return () => {}; } };
  createPolicyExtension({
    roomId,
    bot,
    grantGate: gate,
    mode: executionModeOf({ bot }),
    talkLane,
  }).factory(pi);
  assert.ok(handler);
  return (toolName, input = {}) => handler({ type: 'tool_call', toolName, toolCallId: 'c1', input });
}

await test('mainBot 在 ask 档 + 挂载 MCP + 无手建 grant 下免弹窗直通日常/键鼠/MCP/配置，仅高危弹一次确认卡', () => {
  store.state.grants = [];
  store.state.approvals = [];
  store.state.approvalGrants = [];
  store.addMcpServer({ name: 'demo', type: 'stdio', command: 'node', args: ['x.js'], enabled: true });
  const offMcp = store.addMcpServer({ name: 'disabled_srv', type: 'stdio', command: 'node', args: ['y.js'], enabled: false });
  store.updateBot(chief.id, { mcpServers: ['demo'] });
  store.updatePolicy({ dangerous: 'ask', allowCommands: ['echo *'], denyCommands: [] });

  const gate = createGrantGate({
    store,
    currentPolicyRevision: () => store.policyVersion(),
    currentGeneration: () => 'gen-jarvis',
    log: () => {},
  });

  const runChief = makeHookHandler({ bot: chief, roomId: chiefDm.id, talkLane: false, gate });
  // 无任何 pre-grant、ask 档、已挂 MCP：全部零弹窗直接放行
  assert.equal(runChief('bash', { command: 'git status' }), undefined, 'mainBot 豁免 allowCommands 且不弹窗');
  assert.equal(runChief('run_background', { command: 'node -v' }), undefined);
  assert.equal(runChief('desktop_input', { epoch: 1, action: 'click', x: 1, y: 1 }), undefined, 'desktop_input 默认放行');
  assert.equal(runChief('mcp__demo__query', { q: 'hi' }), undefined, '已启用外部 MCP 免逐次弹窗');
  assert.equal(runChief('manage_model_group', { op: 'list' }), undefined);
  assert.equal(runChief('set_policy', { op: 'get' }), undefined);
  assert.ok(
    store.listAdminActions({ limit: 20 }).some((a) => a.label.includes('主控宿主执行：desktop_input')),
    '宿主放行应落审计',
  );

  // 极高危动作 1：启用未启用 MCP -> 弹一次确认卡，批准后放行
  const mcpBlock = runChief('manage_mcp_server', { op: 'enable', id: offMcp.server.id });
  assert.equal(mcpBlock?.block, true, '首次启用停用状态的 MCP 应弹确认卡');
  const pending = store.listApprovals({ roomId: chiefDm.id, status: 'pending' });
  assert.equal(pending.length, 1);
  store.decideApproval(pending[0].id, { approved: true });
  assert.equal(runChief('manage_mcp_server', { op: 'enable', id: offMcp.server.id }), undefined, '批准后同调用立即放行');

  // 极高危动作 2：git_destructive -> 弹确认卡
  const gitBlock = runChief('git_destructive', { op: 'reset', ref: 'HEAD~1' });
  assert.equal(gitBlock?.block, true, 'git_destructive 仍需确认');

  // 对照：Talk 旁路通道与全局 deny 只读总刹车仍然拦住 mainBot
  const runTalk = makeHookHandler({ bot: chief, roomId: chiefDm.id, talkLane: true, gate });
  assert.equal(runTalk('manage_model_group', { op: 'list' })?.block, true, 'Talk 旁路禁止放开宿主权限');
  store.updatePolicy({ dangerous: 'deny' });
  assert.equal(runChief('bash', { command: 'echo 1' })?.block, true, 'dangerous=deny 总刹车必须仍有效');

  // 对照：成员依然严格受限
  store.updatePolicy({ dangerous: 'ask', allowCommands: ['echo *'], denyCommands: [] });
  const runMember = makeHookHandler({ bot: member, roomId: memberDm.id, talkLane: false, gate });
  assert.equal(runMember('bash', { command: 'git status' })?.block, true);
});

// ---------------- 3. 全盘工作目录：mainBot run_background & git_status 可脱离 workspace
await test('mainBot run_background 与 git_status 支持工作区外目录，成员仍受限', async () => {
  store.updateBot(chief.id, { mcpServers: [] });
  store.updatePolicy({ dangerous: 'allow', allowCommands: [], denyCommands: [] });

  const cmd = `"${process.execPath}" -e "console.log(process.cwd())"`;
  const chiefBg = await call(chiefToolsMap, 'run_background', { command: cmd, cwd: externalRepo });
  assert.equal(chiefBg.isError, false, chiefBg.text);
  assert.ok(chiefBg.details.shellId);
  await new Promise((r) => setTimeout(r, 500));
  const readOut = await call(chiefToolsMap, 'read_shell', { shell_id: chiefBg.details.shellId });
  assert.match(readOut.text.toLowerCase(), new RegExp(path.basename(externalRepo).toLowerCase()));
  shells.remove(chiefBg.details.shellId);

  const memberBg = await call(memberToolsMap, 'run_background', { command: cmd, cwd: externalRepo });
  assert.equal(memberBg.isError, true);
  assert.match(memberBg.text, /工作区/);

  if (hasGit) {
    const chiefGitTools = Object.fromEntries(
      buildGitTools({ runner, store, roomId: chiefDm.id, botId: chief.id }).map((t) => [t.name, t]),
    );
    const memberGitTools = Object.fromEntries(
      buildGitTools({ runner, store, roomId: memberDm.id, botId: member.id }).map((t) => [t.name, t]),
    );
    const cg = await call(chiefGitTools, 'git_status', { repo: externalRepo });
    assert.equal(cg.isError, false, cg.text);
    assert.match(cg.text, /README\.md/);

    const mg = await call(memberGitTools, 'git_status', { repo: externalRepo });
    assert.equal(mg.isError, true);
    assert.match(mg.text, /工作目录/);
  }
});

// ---------------- 4. 对话式系统管家全套 CRUD 闭环
await test('对话式系统管家：定时任务 / 形象形状颜色 / 用户偏好 / 部门预算 / 知识库 / 本机导入 / MCP / 策略', async () => {
  // 定时任务
  const au = await call(chiefToolsMap, 'manage_automation', {
    op: 'create',
    title: '晨间巡检',
    prompt: '检查关键服务日志',
    dailyAt: '08:30',
  });
  assert.equal(au.isError, false, au.text);
  const autoId = au.details.automation.id;
  const listed = await call(chiefToolsMap, 'list_automations');
  assert.match(listed.text, /晨间巡检/);
  const auUpd = await call(chiefToolsMap, 'manage_automation', {
    op: 'update',
    automationId: autoId,
    everyMinutes: 15,
    enabled: false,
  });
  assert.equal(auUpd.details.automation.everyMinutes, 15);
  assert.equal(auUpd.details.automation.enabled, false);
  const auDel = await call(chiefToolsMap, 'manage_automation', { op: 'delete', automationId: autoId });
  assert.equal(auDel.details.deleted, true);

  // Bot 几何形象 0..15 & 颜色 & 专属技能
  const createdBot = await call(chiefToolsMap, 'create_bot', {
    name: '猫耳助手',
    tagline: '专管灵感记录',
    persona: '帮用户整理日常灵感',
    avatarShape: 10,
    avatarColor: '#6c5ce7',
  });
  assert.equal(createdBot.isError, false, createdBot.text);
  const nb = store.getBot(createdBot.details.botId);
  assert.equal(nb.avatarShape, 10);
  assert.equal(nb.avatarColor, '#6C5CE7');
  const updBot = await call(chiefToolsMap, 'update_bot', {
    botId: nb.id,
    avatarShape: 11,
    skills: [{ title: '快速摘要', howto: '三句话总结要点' }],
  });
  assert.equal(updBot.isError, false, updBot.text);
  assert.equal(store.getBot(nb.id).avatarShape, 11);
  assert.equal(store.getBot(nb.id).skills.length, 1);

  // 用户称呼与偏好
  const nameRes = await call(chiefToolsMap, 'manage_user_profile', { op: 'set_name', name: 'Tony' });
  assert.equal(nameRes.isError, false);
  assert.equal(store.userName(), 'Tony');
  const prefRes = await call(chiefToolsMap, 'manage_user_profile', {
    op: 'add_preference',
    topic: 'reply-style',
    text: '汇报先说结论再列细节',
  });
  assert.equal(prefRes.isError, false, prefRes.text);
  const prefId = prefRes.details.added.id;
  const profGet = await call(chiefToolsMap, 'manage_user_profile', { op: 'get' });
  assert.match(profGet.text, /Tony/);
  assert.match(profGet.text, /先说结论/);
  await call(chiefToolsMap, 'manage_user_profile', { op: 'retire_preference', preferenceId: prefId });

  // 部门修改 / 预算 / 模板 / 删除
  const grp = store.createGroup({ name: '临时部门', botIds: [member.id, nb.id] });
  const deptUpd = await call(chiefToolsMap, 'manage_department', {
    op: 'update', groupId: grp.id, name: '研发特战队', topic: '核心攻坚', pinned: true,
  });
  assert.equal(deptUpd.details.room.name, '研发特战队');
  const lim = await call(chiefToolsMap, 'manage_department', { op: 'set_limits', leadTurns: 25, maxRuns: 30 });
  assert.equal(lim.details.limits.leadTurns, 25);
  const tpl = await call(chiefToolsMap, 'manage_department', { op: 'save_template', groupId: grp.id, templateName: '攻坚模板' });
  assert.equal(tpl.details.template.name, '攻坚模板');
  const delCur = await call(chiefToolsMap, 'manage_department', { op: 'delete', groupId: chiefDm.id });
  assert.equal(delCur.isError, true, '不能删除当前对话房间');
  const delGrp = await call(chiefToolsMap, 'manage_department', { op: 'delete', groupId: grp.id });
  assert.equal(delGrp.details.deleted, true);

  // 技能库 + 经验库
  const addSk = await call(chiefToolsMap, 'add_skill', { title: '发布检查', howto: '跑单测' });
  const skId = store.skillLibrary().find((s) => s.title === '发布检查').id;
  await call(chiefToolsMap, 'manage_knowledge', { op: 'update_skill', id: skId, summary: '发版前必查' });
  assert.equal(store.skillLibrary().find((s) => s.id === skId).summary, '发版前必查');
  await call(chiefToolsMap, 'manage_knowledge', { op: 'delete_skill', id: skId });

  const addLs = await call(chiefToolsMap, 'manage_knowledge', {
    op: 'add_lesson',
    cue: '改完配置后',
    lesson: '通知空闲会话重载',
    verdict: 'helped',
    status: 'active',
    evidence: [{ quote: '用户实测生效' }],
  });
  assert.equal(addLs.isError, false, addLs.text);
  const lsList = await call(chiefToolsMap, 'manage_knowledge', { op: 'list_lessons' });
  assert.match(lsList.text, /改完配置后/);
  await call(chiefToolsMap, 'manage_knowledge', { op: 'delete_lesson', id: addLs.details.lesson.id });

  // 本机导入（skill + mcp）
  const impSk = await call(chiefToolsMap, 'import_local_capabilities', { kind: 'skill', all: true });
  assert.ok(impSk.details.imported.includes('本地演示技能'));
  const impMcp = await call(chiefToolsMap, 'import_local_capabilities', { kind: 'mcp', all: true, enable: false });
  assert.ok(impMcp.details.imported.includes('local_probe_mcp'));

  // MCP 启停删
  const mcpEn = await call(chiefToolsMap, 'manage_mcp_server', { op: 'enable', name: 'local_probe_mcp' });
  assert.equal(mcpEn.details.server.enabled, true);
  const mcpDis = await call(chiefToolsMap, 'manage_mcp_server', { op: 'disable', name: 'local_probe_mcp' });
  assert.equal(mcpDis.details.server.enabled, false);
  const mcpDel = await call(chiefToolsMap, 'manage_mcp_server', { op: 'delete', name: 'local_probe_mcp' });
  assert.equal(mcpDel.details.deleted, true);

  // 策略与桌面安全开关
  const pol = await call(chiefToolsMap, 'set_policy', {
    op: 'update', dangerous: 'ask', requireProof: false, trustPhantomInput: true,
  });
  assert.equal(pol.details.policy.dangerous, 'ask');
  assert.equal(pol.details.desktop.trustPhantomInput, true);
  await call(chiefToolsMap, 'set_policy', { op: 'update', dangerous: 'allow', requireProof: true });
});

// ---------------- 5. 模型组配置（加密落盘 + 聊天记录明文自动打码）
await test('manage_model_group：Key 加密落盘、绝不回显明文、聊天记录气泡原地打码', async () => {
  const fakeKey = 'sk-' + 'K'.repeat(24);
  const fakeRouterKey = 'nvapi-' + 'N'.repeat(18);
  const userMsg = store.appendMessage({
    roomId: chiefDm.id,
    authorType: 'user',
    authorName: '我',
    text: `帮我配个模型组，地址 https://api.example.com/v1，key=${fakeKey}，路由器用 ${fakeRouterKey}`,
    status: 'done',
  });

  const up = await call(chiefToolsMap, 'manage_model_group', {
    op: 'upsert',
    name: '示例商业组',
    baseUrl: 'https://api.example.com/v1',
    apiKey: fakeKey,
    api: 'openai-completions',
    models: ['gpt-5-demo', 'gpt-5-mini'],
  });
  assert.equal(up.isError, false, up.text);
  assert.ok(!up.text.includes(fakeKey), '工具返回值绝不能包含明文 key');
  assert.ok(up.text.includes(maskSecretValue(fakeKey)));

  // 落盘密文校验
  const savedDisk = fs.readFileSync(path.join(dataDir, 'model-groups.json'), 'utf8');
  assert.ok(!savedDisk.includes(fakeKey), '磁盘上的模型组 Key 必须是密文');
  assert.match(savedDisk, /enc:v1:/);

  // 聊天记录原文已被原地打码
  const afterMsg = store.getMessage(chiefDm.id, userMsg.id);
  assert.ok(!afterMsg.text.includes(fakeKey), '聊天消息里的明文 model key 应被抹掉');
  assert.ok(afterMsg.text.includes(maskSecretValue(fakeKey)));
  assert.equal(afterMsg.meta?.secretRedacted, true);

  // 切默认模型 + 配置决策路由
  const groupId = up.details.group.id;
  const sw = await call(chiefToolsMap, 'manage_model_group', {
    op: 'set_default_model',
    model: `${groupId}/gpt-5-mini`,
  });
  assert.equal(sw.isError, false, sw.text);
  assert.equal(store.defaultModel(), `${groupId}/gpt-5-mini`);

  const rt = await call(chiefToolsMap, 'manage_model_group', {
    op: 'set_decision_router',
    decisionEnabled: true,
    decisionMode: 'custom',
    baseUrl: 'https://router.example.com/v1',
    model: 'fast-router',
    apiKey: fakeRouterKey,
  });
  assert.equal(rt.isError, false, rt.text);
  assert.ok(!rt.text.includes(fakeRouterKey), '路由工具回执不能泄漏明文 key');
  const afterRouterMsg = store.getMessage(chiefDm.id, userMsg.id);
  assert.ok(!afterRouterMsg.text.includes(fakeRouterKey), '聊天消息里的明文路由 key 也应被打码');

  // redactChatSecrets 多形态覆盖
  const gh = 'ghp_' + 'G'.repeat(24);
  const ak = 'AKIA' + 'A1B2C3D4E5F67890';
  const redacted = redactChatSecrets(`token1=${gh} token2=Bearer ${'B'.repeat(24)} aws=${ak}`);
  assert.ok(!redacted.includes(gh));
  assert.ok(!redacted.includes('B'.repeat(24)));
  assert.ok(!redacted.includes(ak));
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

shells.stopAll();
clearTimeout(store.saveTimer);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
