/**
 * Agent Foundation SDK 与多实例隔离端到端单测（无真实联网，使用 Mock sessionApi）：
 *   node tests/sdk-runtime.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sdk-runtime-'));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const urlStr = typeof input === 'string' ? input : input?.url ?? String(input);
  const parsed = new URL(urlStr);
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`sdk-runtime 禁止非回环联网请求：${urlStr}`);
  }
  return realFetch(input, init);
};

function makeDirs(tag) {
  const base = path.join(root, tag);
  const dataDir = path.join(base, 'data');
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { base, dataDir, workspace };
}

function makeMockModelRuntimeFactory() {
  const providers = new Map([
    ['mock', { models: [{ id: 'fast-1', contextWindow: 128000, reasoning: false }] }],
  ]);
  const listModels = () => {
    const out = [];
    for (const [provider, cfg] of providers.entries()) {
      for (const m of cfg?.models ?? []) {
        if (!m?.id) continue;
        out.push({
          provider,
          id: m.id,
          contextWindow: m.contextWindow ?? 128000,
          reasoning: Boolean(m.reasoning),
        });
      }
    }
    return out;
  };
  return async () => ({
    registerProvider(id, cfg) {
      providers.set(id, { ...(cfg ?? {}), models: cfg?.models ?? [] });
    },
    unregisterProvider(id) {
      providers.delete(id);
    },
    getModels: listModels,
    getModel(provider, id) {
      return listModels().find((m) => m.provider === provider && m.id === id) ?? null;
    },
    async getAvailable() {
      return listModels();
    },
    async completeSimple() {
      return { content: [{ type: 'text', text: '{}' }] };
    },
  });
}

function makeMockSessionApi(replyFn, agentDir) {
  fs.mkdirSync(agentDir, { recursive: true });
  class MockResourceLoader {
    constructor(opts) {
      this.opts = opts;
    }
    async reload() {}
  }
  return {
    DefaultResourceLoader: MockResourceLoader,
    SessionManager: {
      inMemory: () => ({}),
      open: () => ({}),
      create: () => ({}),
    },
    createBashTool: () => ({
      name: 'bash',
      description: 'mock bash',
      parameters: {},
      async execute() { return { content: [{ type: 'text', text: '' }] }; },
    }),
    createPowerShellTool: () => ({
      name: 'powershell',
      description: 'mock powershell',
      parameters: {},
      async execute() { return { content: [{ type: 'text', text: '' }] }; },
    }),
    getAgentDir: () => agentDir,
    async createAgentSession(options = {}) {
      const listeners = new Set();
      const messages = [];
      const emit = (ev) => {
        for (const fn of [...listeners]) {
          try { fn(ev); } catch {}
        }
      };
      const session = {
        model: options.model ?? { provider: 'mock', id: 'fast-1', contextWindow: 128000 },
        messages,
        state: { messages },
        systemPrompt: options.resourceLoader?.opts?.appendSystemPrompt ?? '',
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        dispose() {
          listeners.clear();
        },
        async abort() {},
        async followUp(text) {
          return this.prompt(text);
        },
        async steer(text) {
          return this.prompt(text);
        },
        getContextUsage() {
          return { tokens: 120, contextWindow: 128000, percent: 0.1 };
        },
        async prompt(text) {
          const outText = String(await replyFn({ text, options }));
          const assistantMsg = {
            role: 'assistant',
            content: [{ type: 'text', text: outText }],
            usage: { input: 12, output: 8, totalTokens: 20 },
          };
          messages.push(assistantMsg);
          emit({ type: 'message_start', message: { role: 'assistant' } });
          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: outText },
          });
          emit({ type: 'message_end', message: assistantMsg });
          emit({ type: 'turn_end' });
          emit({ type: 'agent_end' });
        },
      };
      return { session };
    },
  };
}

function waitForCondition(checkFn, { timeoutMs = 4000, intervalMs = 20, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const val = checkFn();
      if (val) {
        resolve(val);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`等待超时：${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`✗ ${name}\n  ${err?.stack || err}`);
  }
}

let rtA = null;
let rtB = null;
let sdkMod = null;
let clientMod = null;

await test('SDK-1 package.json exports 自引用可用且 import 阶段零全局落盘副作用', async () => {
  const { hasDefaultStore } = await import('../src/store.js');
  assert.equal(hasDefaultStore(), false, '测试起步时不应实例化默认全局 store');

  const rootPkg = await import('orbis-agent');
  sdkMod = await import('orbis-agent/sdk');
  clientMod = await import('orbis-agent/client');
  const capsMod = await import('orbis-agent/capabilities');

  assert.equal(typeof rootPkg.createOrbisRuntime, 'function');
  assert.equal(typeof sdkMod.createOrbisRuntime, 'function');
  assert.equal(sdkMod.createPiBotRuntime, sdkMod.createOrbisRuntime);
  assert.equal(typeof sdkMod.createOrbisClient, 'function');
  assert.equal(sdkMod.createPiBotClient, sdkMod.createOrbisClient);
  assert.equal(sdkMod.BRAND_NAME, 'Orbis');
  assert.equal(sdkMod.createConfig({ ensureDirs: false, env: { ORBIS_NAME: 'MyOrbis' } }).serverName, 'MyOrbis');
  assert.equal(typeof sdkMod.defineTool, 'function');
  assert.equal(typeof clientMod.createOrbisClient, 'function');
  assert.equal(typeof capsMod.auditCapabilities, 'function');
  assert.deepEqual(capsMod.auditCapabilities(), []);

  assert.equal(hasDefaultStore(), false, '仅 import SDK/capabilities 不得实例化默认全局 store');
});

await test('SDK-2 单进程双实例并行隔离 + 群聊 @mention 接力扇出不串台', async () => {
  const dirA = makeDirs('rt-a');
  const dirB = makeDirs('rt-b');

  rtA = await sdkMod.createOrbisRuntime({
    dataDir: dirA.dataDir,
    workspace: dirA.workspace,
    userName: 'Alice',
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(
      ({ text, options }) => `[A:${options.cwd}] 收到：${String(text).slice(0, 60)}`,
      path.join(dirA.base, 'agent'),
    ),
  });
  assert.equal(rtA.store.mainBot()?.name, 'Orbis');

  rtB = await sdkMod.createOrbisRuntime({
    dataDir: dirB.dataDir,
    workspace: dirB.workspace,
    userName: 'Bob',
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(({ text, options }) => {
      const sys = options.resourceLoader?.opts?.appendSystemPrompt ?? '';
      if (sys.includes('ROLE_LEAD_B')) return '@组员B 请核查指标';
      if (sys.includes('ROLE_MEMBER_B')) return '组员B已完成核查';
      return `[B:${options.cwd}] 收到：${String(text).slice(0, 60)}`;
    }, path.join(dirB.base, 'agent')),
  });

  const eventsA = [];
  const eventsB = [];
  const offA = rtA.onEvent((ev) => eventsA.push(ev));
  const offB = rtB.onEvent((ev) => eventsB.push(ev));

  try {
    const resA = await rtA.askMain('检查构建');
    assert.ok(resA.replyText.includes(`[A:${dirA.workspace}]`), `rtA 应返回专属工作区回执，实际=${resA.replyText}`);
    assert.equal(rtA.store.userName(), 'Alice');
    assert.equal(rtB.store.userName(), 'Bob');
    assert.equal(eventsB.length, 0, 'rtA 对话绝不能向 rtB 事件总线泄漏任何事件');

    const leadRes = rtB.bots.create({ name: '组长B', persona: 'ROLE_LEAD_B' }, { greet: false });
    const memberRes = rtB.bots.create({ name: '组员B', persona: 'ROLE_MEMBER_B' }, { greet: false });
    assert.equal(leadRes.ok, true);
    assert.equal(memberRes.ok, true);
    const lead = leadRes.bot;
    const member = memberRes.bot;

    const grpRes = rtB.rooms.createGroup({
      name: '研发组',
      botIds: [lead.id, member.id],
      leadBotId: lead.id,
    });
    assert.equal(grpRes.ok, true);
    const grpId = grpRes.room.id;

    const msgsABefore = rtA.store.listMessages('dm_chief').length;
    await rtB.send(grpId, '开始巡检');

    await waitForCondition(
      () =>
        eventsB.some((e) => e.t === 'msg.done' && (e.roomId ?? e.msg?.roomId) === grpId && e.msg?.authorId === lead.id) &&
        eventsB.some((e) => e.t === 'msg.done' && (e.roomId ?? e.msg?.roomId) === grpId && e.msg?.authorId === member.id),
      { timeoutMs: 5000, label: 'rtB 群内组长 -> @组员B 接力完成' },
    );

    const grpMsgs = rtB.store.listMessages(grpId);
    assert.ok(grpMsgs.some((m) => m.authorId === lead.id && m.text.includes('@组员B')));
    assert.ok(grpMsgs.some((m) => m.authorId === member.id && m.text.includes('组员B已完成核查')));
    assert.equal(rtA.store.listMessages('dm_chief').length, msgsABefore, 'rtB 群聊不应影响 rtA 消息记录');
  } finally {
    offA();
    offB();
  }
});

await test('SDK-3 统一领域服务复用、policyChange 活跃任务通知回归及模型组落盘加密', async () => {
  // 1) policyChange 活跃任务通知回归（修复先写 store 再比对导致的 change.isChange=false）
  const activeTask = rtA.store.createTask({
    roomId: 'dm_chief',
    title: '重构网关',
    status: 'doing',
    policyVersion: rtA.store.policyVersion(),
  });
  assert.ok(activeTask?.id);

  const polRes = rtA.policy.updatePolicy({ dangerous: 'deny' });
  assert.equal(polRes.ok, true);
  assert.equal(polRes.policyChange.isChange, true, '策略从默认变为 deny 必须触发 isChange=true');
  assert.equal(polRes.notified, 1, '策略变更后必须给进行中任务补发 1 条规矩变更系统提示');

  // 2) automations CRUD + 互斥排期切换
  const autoCreate = rtA.automations.create({
    roomId: 'dm_chief',
    title: '巡检报告',
    prompt: '汇总构建状态',
    everyMinutes: 15,
  });
  assert.equal(autoCreate.ok, true);
  const autoUpd = rtA.automations.update(autoCreate.automation.id, { dailyAt: '09:30' });
  assert.equal(autoUpd.ok, true, 'everyMinutes 切换为 dailyAt 不应被旧字段冲突校验拦截');
  assert.equal(autoUpd.automation.dailyAt, '09:30');
  assert.equal(autoUpd.automation.everyMinutes, null);
  const autoDel = rtA.automations.remove(autoCreate.automation.id);
  assert.equal(autoDel.ok, true);

  // 3) capabilities CRUD（skill + mcp 默认 disabled=false）
  const skAdd = rtA.capabilities.addSkill({ title: 'SDK规范', howto: '优先走 services/*' });
  assert.equal(skAdd.ok, true);
  const skUpd = rtA.capabilities.updateSkill(skAdd.skill.id, { howto: '统一通过 services/* 复用逻辑' });
  assert.equal(skUpd.ok, true);
  assert.equal(rtA.capabilities.removeSkill(skAdd.skill.id).ok, true);

  const mcpAdd = await rtA.capabilities.addMcp({ name: 'demo-mcp', command: 'node', args: ['-v'] });
  assert.equal(mcpAdd.ok, true);
  assert.equal(mcpAdd.server.enabled, false, '新增 MCP 必须默认 disabled');
  const mcpUpd = await rtA.capabilities.updateMcp('demo-mcp', { enabled: true });
  assert.equal(mcpUpd.ok, true);
  assert.equal(mcpUpd.server.enabled, true);
  assert.equal((await rtA.capabilities.removeMcp('demo-mcp')).ok, true);

  // 4) models.upsertGroup 落盘加密 + 对外列表脱敏（新增时不传 id）
  const dynamicKey = 'sk-' + 'S'.repeat(24);
  const mgUpsert = await rtA.models.upsertGroup({
    name: 'SDK组',
    api: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    apiKey: dynamicKey,
    models: [{ id: 'm-1', name: 'M1' }],
  });
  assert.equal(mgUpsert.ok, true);

  const list = rtA.models.list();
  const sdkGroup = list.modelGroups.find((g) => g.id === mgUpsert.group.id);
  assert.ok(sdkGroup, 'modelGroups.list() 应包含刚新增的 SDK组');
  assert.equal(sdkGroup.apiKey, undefined, '公开列表不能包含明文 apiKey 字段');
  assert.ok(sdkGroup.keyMasked && !sdkGroup.keyMasked.includes(dynamicKey), 'keyMasked 必须脱敏');

  const rawDisk = fs.readFileSync(path.join(rtA.config.dataDir, 'model-groups.json'), 'utf8');
  assert.equal(rawDisk.includes(dynamicKey), false, '磁盘 model-groups.json 不得出现明文 apiKey');
  assert.ok(rawDisk.includes('enc:v1:'), '磁盘 model-groups.json 应使用 enc:v1 密文存储');
});

await test('SDK-3b runtime.lessons 门面：propose 只产 candidate、activate 走证据门禁、preview 与否决同一条路', async () => {
  const lf = rtA.lessons;
  assert.deepEqual(lf.list(), [], '新库是空的');

  // 1) 即使调用方传 active，也只会落 candidate（审批门禁是"人点按钮"）
  const weak = lf.propose({ cue: '评审前先跑一遍单测', lesson: '先跑再发', status: 'active' });
  assert.equal(weak.error, undefined, weak.error);
  assert.equal(weak.lesson.status, 'candidate', 'SDK 不得有绕过审批的口子');

  // 2) 没证据的启用被拒（与 HTTP / 界面同一条门禁）
  const nope = lf.activate(weak.lesson.id);
  assert.match(String(nope.error), /证据/);

  // 3) 带证据的能启用，preview 用同一套打分挑得到
  const good = lf.propose({
    cue: '发布前核对版本号',
    lesson: '服务端 / App / 启动器三处版本必须一致',
    evidence: [{ msgId: 'm1', quote: '三处版本必须一致' }],
  });
  assert.equal(good.error, undefined, good.error);
  assert.equal(lf.activate(good.lesson.id).lesson.status, 'active');
  const pv = lf.preview('发布前核对版本号', {});
  assert.ok(pv.picked.some((l) => l.id === good.lesson.id), 'active 且词面命中就该被挑中');
  assert.ok(pv.chars <= 600, `注入预算仍是 600 字，实际 ${pv.chars}`);

  // 4) 否决：写 user 边 + 归档 → 预览立刻为空（可关可清，I5）
  assert.equal(lf.reject(good.lesson.id).ok, true);
  assert.ok(!lf.preview('发布前核对版本号', {}).picked.some((l) => l.id === good.lesson.id));
  assert.ok(lf.edges().some((e) => e.from === 'user' && e.to === good.lesson.id && e.type === 'contradicts'));

  // 5) remove 真的删掉（不留下悬空边）
  assert.equal(lf.remove(weak.lesson.id).ok, true);
  assert.ok(!lf.list().some((l) => l.id === weak.lesson.id));
});

await test('SDK-4 createPiBotClient 远程 HTTP + WebSocket 控制（自动 local-token 与一次性 nonce）', async () => {
  const { issueLocalToken } = await import('../src/local-token.js');
  const { createHttpServer } = await import('../src/http.js');
  const { attachWs } = await import('../src/ws.js');
  const { Pairing } = await import('../src/pairing.js');

  issueLocalToken(rtA.config.dataDir);
  const pairing = new Pairing();
  const httpServer = createHttpServer({ runner: rtA.runner, pairing });
  const wss = attachWs(httpServer, { runner: rtA.runner });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const client = clientMod.createOrbisClient({
    baseUrl,
    dataDir: rtA.config.dataDir,
    fetchImpl: realFetch,
  });

  const wsEvents = [];
  let wsConn = null;
  try {
    const health = await client.health();
    assert.equal(health.ok, true);

    const state = await client.state();
    assert.equal(state.user?.name, 'Alice');

    wsConn = await client.connectEvents((ev) => wsEvents.push(ev));
    assert.ok(wsEvents.some((e) => e.t === 'hello'), 'WS 连接后应收到 hello 事件');

    // PATCH /api/policy 需要管理员一次性 nonce，由 client 自动申请携带
    const pol = await client.updatePolicy({ dangerous: 'allow' });
    assert.equal(pol.policy?.dangerous, 'allow');
    assert.equal(pol.policyChange?.isChange, true);

    await client.send('dm_chief', '通过远程SDK问好');
    const doneEv = await waitForCondition(
      () => wsEvents.find((e) => e.t === 'msg.done' && (e.roomId ?? e.msg?.roomId) === 'dm_chief' && e.msg?.authorType === 'bot' && e.msg?.text?.includes('通过远程SDK问好')),
      { timeoutMs: 5000, label: 'WS 收到远程 SDK 回复 msg.done' },
    );
    assert.ok(doneEv.msg.text.includes('通过远程SDK问好'));
  } finally {
    clearInterval(pairing.timer);
    if (wsConn) await wsConn.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    await rtA?.dispose?.();
    await rtB?.dispose?.();
    rtA = null;
    rtB = null;
  }
});

await test('SDK-5 runtime.dispose() 后子进程事件循环干净自然退出（不调用 process.exit）', async () => {
  const childDir = makeDirs('clean-exit');
  const childScript = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { createOrbisRuntime } from 'orbis-agent/sdk';

    const dataDir = ${JSON.stringify(childDir.dataDir)};
    const workspace = ${JSON.stringify(childDir.workspace)};
    const agentDir = ${JSON.stringify(path.join(childDir.base, 'agent'))};
    fs.mkdirSync(agentDir, { recursive: true });

    const modelRuntimeFactory = async () => ({
      registerProvider() {},
      unregisterProvider() {},
      getModels: () => [{ provider: 'mock', id: 'fast-1', contextWindow: 128000, reasoning: false }],
      getModel: (p, id) => (p === 'mock' && id === 'fast-1' ? { provider: 'mock', id: 'fast-1', contextWindow: 128000, reasoning: false } : null),
      async getAvailable() { return [{ provider: 'mock', id: 'fast-1', contextWindow: 128000, reasoning: false }]; },
      async completeSimple() { return { content: [{ type: 'text', text: '{}' }] }; },
    });

    class MockLoader { constructor(o) { this.opts = o; } async reload() {} }
    const sessionApi = {
      DefaultResourceLoader: MockLoader,
      SessionManager: { inMemory: () => ({}), open: () => ({}), create: () => ({}) },
      createBashTool: () => ({ name: 'bash', description: 'b', parameters: {}, async execute() { return { content: [{ type: 'text', text: '' }] }; } }),
      createPowerShellTool: () => ({ name: 'powershell', description: 'p', parameters: {}, async execute() { return { content: [{ type: 'text', text: '' }] }; } }),
      getAgentDir: () => agentDir,
      async createAgentSession(options) {
        const listeners = new Set();
        const messages = [];
        return {
          session: {
            model: options.model ?? { provider: 'mock', id: 'fast-1', contextWindow: 128000 },
            messages,
            state: { messages },
            subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            dispose() { listeners.clear(); },
            async abort() {},
            async followUp() {},
            async steer() {},
            getContextUsage() { return { tokens: 10, contextWindow: 128000, percent: 0.01 }; },
            async prompt(text) {
              const out = 'pong:' + String(text);
              const msg = { role: 'assistant', content: [{ type: 'text', text: out }], usage: { input: 5, output: 3, totalTokens: 8 } };
              messages.push(msg);
              for (const fn of [...listeners]) fn({ type: 'message_start', message: { role: 'assistant' } });
              for (const fn of [...listeners]) fn({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: out } });
              for (const fn of [...listeners]) fn({ type: 'message_end', message: msg });
              for (const fn of [...listeners]) fn({ type: 'turn_end' });
              for (const fn of [...listeners]) fn({ type: 'agent_end' });
            },
          },
        };
      },
    };

    const rt = await createOrbisRuntime({ dataDir, workspace, defaultModel: 'mock/fast-1', modelRuntimeFactory, sessionApi });
    const res = await rt.askMain('ping');
    if (!res.replyText.includes('pong:ping')) throw new Error('unexpected reply: ' + res.replyText);
    await rt.dispose();
    console.log('CLEAN_EXIT_OK');
  `;

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: path.join(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 8000,
  });

  assert.equal(child.status, 0, `子进程退出异常 status=${child.status} signal=${child.signal}\nstdout=${child.stdout}\nstderr=${child.stderr}`);
  assert.ok(child.stdout.includes('CLEAN_EXIT_OK'), `子进程应打印 CLEAN_EXIT_OK，实际 stdout=${child.stdout}`);
});

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {}

const failed = results.filter((r) => !r.ok);
console.log(`\nsdk-runtime: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  process.exit(1);
}
