/**
 * SDK 错误契约（路线图 §4 T2.5）：`OrbisError` + `code` 枚举。
 *   node tests/sdk-errors.mjs
 *
 * ## 这个文件守什么
 *
 * 1. **每条 code 都有至少一个测试** —— 最后一条断言会把 `ORBIS_ERROR_CODES` 的键
 *    和本文件的文本对一遍，新增 code 却不写测例会直接红；
 * 2. **`server/src/sdk/` 里不再有裸字符串抛错**（`throw new Error(` / `throw '`），
 *    宿主拿到的失败一定是带 `code` 的类型化错误；
 * 3. **忙时不替人猜**：bot 正忙而调用方没给分流意图 → `E_BUSY_NEEDS_ROUTE`，
 *    给了 `duplexMode` 才放行（群聊走排队，本来就不需要分流）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-sdk-errors-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.ORBIS_HOME = root;
process.env.ORBIS_WORKSPACE = path.join(root, 'workspace');
process.env.ORBIS_PROBE = '0';
process.env.ORBIS_LESSON_REFLECT = '0';
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网（需要 fetch 的地方自己注入 fetchImpl）');
};

const sdk = await import('../src/sdk/index.js');
const clientMod = await import('../src/sdk/client.js');
const { OrbisError, ORBIS_ERROR_CODES: CODE, orbisError, isOrbisError, asOrbisError } = sdk;

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

// ---------------------------------------------------------------------------
// 1. 纯错误层
// ---------------------------------------------------------------------------
await test('OrbisError：name / code / details / toJSON 稳定，且是真正的 Error 子类', () => {
  const err = orbisError(CODE.E_NO_MAIN_BOT, '没有主控', { roomId: 'dm_chief' });
  assert.ok(err instanceof Error);
  assert.ok(err instanceof OrbisError);
  assert.equal(err.name, 'OrbisError');
  assert.equal(err.code, 'E_NO_MAIN_BOT');
  assert.equal(err.message, '没有主控');
  assert.deepEqual(err.details, { roomId: 'dm_chief' });
  assert.deepEqual(err.toJSON(), {
    name: 'OrbisError',
    code: 'E_NO_MAIN_BOT',
    message: '没有主控',
    details: { roomId: 'dm_chief' },
  });
  assert.equal(isOrbisError(err), true);
  assert.equal(isOrbisError(new Error('x')), false);
  assert.equal(isOrbisError(null), false);
});

await test('OrbisError：词表外的 code 降级成 E_INTERNAL，原值留在 requestedCode', () => {
  const err = new OrbisError('E_我瞎写的', 'x');
  assert.equal(err.code, 'E_INTERNAL');
  assert.equal(err.requestedCode, 'E_我瞎写的');
});

await test('asOrbisError：老内部码翻译成契约码（NO_ROOM / EMPTY / 授权）', () => {
  const noRoom = asOrbisError(Object.assign(new Error('会话不存在'), { code: 'NO_ROOM' }));
  assert.equal(noRoom.code, 'E_NOT_FOUND');
  assert.equal(noRoom.details.legacyCode, 'NO_ROOM');

  assert.equal(asOrbisError(Object.assign(new Error('消息为空'), { code: 'EMPTY' })).code, 'E_INVALID_ARGUMENT');
  assert.equal(
    asOrbisError(Object.assign(new Error('群聊不支持'), { code: 'REQUEST_GROUP_UNSUPPORTED' })).code,
    'E_INVALID_ARGUMENT',
  );
  assert.equal(asOrbisError(Object.assign(new Error('没授权'), { code: 'GRANT_DENIED' })).code, 'E_GRANT_DENIED');
  assert.equal(asOrbisError(Object.assign(new Error('没授权'), { code: 'no_grant' })).code, 'E_GRANT_DENIED');

  // 已经是契约码就原样保留；带 status/payload 的一并收进 details
  const already = new OrbisError(CODE.E_TIMEOUT, '超时');
  assert.equal(asOrbisError(already), already, '本模块的错误不重新包装');
  const http = asOrbisError(
    Object.assign(new Error('HTTP 409'), { code: 'SOMETHING', status: 409, payload: { error: 'x' } }),
  );
  assert.equal(http.code, 'E_INTERNAL');
  assert.equal(http.details.status, 409);
  assert.deepEqual(http.details.payload, { error: 'x' });

  // 字符串 / 空值 / 普通 Error 都不能漏出非契约形状
  assert.equal(asOrbisError('炸了').code, 'E_INTERNAL');
  assert.equal(asOrbisError('炸了').message, '炸了');
  assert.equal(asOrbisError(undefined, CODE.E_TURN_FAILED).code, 'E_TURN_FAILED');
  assert.equal(asOrbisError(new Error('普通错误')).code, 'E_INTERNAL');
  // details 会与调用方给的合并，且调用方优先
  const merged = asOrbisError(Object.assign(new Error('x'), { code: 'NO_ROOM' }), CODE.E_INTERNAL, {
    roomId: 'r1',
  });
  assert.equal(merged.code, 'E_NOT_FOUND');
  assert.equal(merged.details.roomId, 'r1');
});

// ---------------------------------------------------------------------------
// 2. 远程客户端（HTTP / WS）
// ---------------------------------------------------------------------------
const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

await test('E_HTTP：非 2xx 包成 E_HTTP，status / serverCode / payload 都在 details 里', async () => {
  const client = clientMod.createOrbisClient({
    baseUrl: 'http://127.0.0.1:9',
    token: 't',
    fetchImpl: async () => jsonResponse(403, { error: '缺 nonce', code: 'NONCE_REQUIRED' }),
  });
  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.equal(err.code, 'E_HTTP');
      assert.equal(err.details.status, 403);
      assert.equal(err.details.serverCode, 'NONCE_REQUIRED');
      assert.deepEqual(err.details.payload, { error: '缺 nonce', code: 'NONCE_REQUIRED' });
      assert.match(err.message, /缺 nonce/);
      return true;
    },
  );
});

await test('E_HTTP：网络层失败（fetch 直接抛）也翻译成 E_HTTP，带 method/path', async () => {
  const client = clientMod.createOrbisClient({
    baseUrl: 'http://127.0.0.1:9',
    token: 't',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    () => client.state(),
    (err) => {
      assert.equal(err.code, 'E_HTTP');
      assert.equal(err.details.method, 'GET');
      assert.equal(err.details.path, '/api/state');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 3. 运行中的 runtime
// ---------------------------------------------------------------------------
function makeDirs(tag) {
  const base = path.join(root, tag);
  const dataDir = path.join(base, 'data');
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { base, dataDir, workspace };
}

function makeMockModelRuntimeFactory() {
  const providers = new Map([['mock', { models: [{ id: 'fast-1', contextWindow: 128000, reasoning: false }] }]]);
  const listModels = () => {
    const out = [];
    for (const [provider, cfg] of providers.entries()) {
      for (const m of cfg?.models ?? []) {
        if (!m?.id) continue;
        out.push({ provider, id: m.id, contextWindow: m.contextWindow ?? 128000, reasoning: Boolean(m.reasoning) });
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

/** prompt 的行为由 `state.behavior` 控制：reply / throw / hang */
function makeMockSessionApi(state, agentDir) {
  fs.mkdirSync(agentDir, { recursive: true });
  class MockResourceLoader {
    constructor(opts) {
      this.opts = opts;
    }
    async reload() {}
  }
  return {
    DefaultResourceLoader: MockResourceLoader,
    SessionManager: { inMemory: () => ({}), open: () => ({}), create: () => ({}) },
    createBashTool: () => ({ name: 'bash', description: 'b', parameters: {}, async execute() { return { content: [] }; } }),
    createPowerShellTool: () => ({ name: 'powershell', description: 'p', parameters: {}, async execute() { return { content: [] }; } }),
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
          return { tokens: 1, contextWindow: 128000, percent: 0.1 };
        },
        async prompt() {
          if (state.behavior === 'throw') throw new Error('模型炸了：mock');
          if (state.behavior === 'hang') {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          const assistantMsg = {
            role: 'assistant',
            content: [{ type: 'text', text: '好的' }],
            usage: { input: 1, output: 1, totalTokens: 2 },
          };
          messages.push(assistantMsg);
          emit({ type: 'message_start', message: { role: 'assistant' } });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好的' } });
          emit({ type: 'message_end', message: assistantMsg });
          emit({ type: 'turn_end' });
          emit({ type: 'agent_end' });
        },
      };
      return { session };
    },
  };
}

async function makeRuntime(tag, options = {}) {
  const dirs = makeDirs(tag);
  const state = { behavior: 'reply' };
  const runtime = await sdk.createOrbisRuntime({
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    userName: 'Tester',
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(state, path.join(dirs.base, 'agent')),
    ...options,
  });
  return { runtime, state, dirs };
}

await test('E_CONFIG_INVALID：模型组配置不合法时构造就抛类型化错误', async () => {
  const dirs = makeDirs('cfg');
  await assert.rejects(
    () =>
      sdk.createOrbisRuntime({
        dataDir: dirs.dataDir,
        workspace: dirs.workspace,
        modelGroups: [{ id: 'no-such-group' }],
        modelRuntimeFactory: makeMockModelRuntimeFactory(),
        sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
      }),
    (err) => {
      assert.equal(err.code, 'E_CONFIG_INVALID');
      assert.equal(err.details.groupId, 'no-such-group');
      return true;
    },
  );
});

await test('E_MODEL_UNAVAILABLE：默认模型写错时构造抛 E_MODEL_UNAVAILABLE', async () => {
  const dirs = makeDirs('model');
  await assert.rejects(
    () =>
      sdk.createOrbisRuntime({
        dataDir: dirs.dataDir,
        workspace: dirs.workspace,
        defaultModel: 'nope/nope',
        modelRuntimeFactory: makeMockModelRuntimeFactory(),
        sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
      }),
    (err) => {
      assert.equal(err.code, 'E_MODEL_UNAVAILABLE');
      assert.equal(err.details.requested, 'nope/nope');
      return true;
    },
  );
});

const { runtime: rt, state: rtState } = await makeRuntime('main');
const mainBot = rt.store.mainBot();
const dm = rt.store.ensureDm(mainBot.id);

await test('E_NOT_FOUND / E_INVALID_ARGUMENT：send 的参数错误翻译成契约码', async () => {
  await assert.rejects(() => rt.send('room_nope', 'hi'), (err) => {
    assert.equal(err.code, 'E_NOT_FOUND');
    assert.equal(err.details.legacyCode, 'NO_ROOM');
    return true;
  });
  await assert.rejects(() => rt.send(dm.id, '   '), (err) => {
    assert.equal(err.code, 'E_INVALID_ARGUMENT');
    return true;
  });
});

await test('E_NO_MAIN_BOT：库里没有主控时 askMain 报 E_NO_MAIN_BOT', async () => {
  const original = rt.store.mainBot;
  rt.store.mainBot = () => null;
  try {
    await assert.rejects(() => rt.askMain('随便说句话'), (err) => {
      assert.equal(err.code, 'E_NO_MAIN_BOT');
      return true;
    });
  } finally {
    rt.store.mainBot = original;
  }
});

await test('E_BUSY_NEEDS_ROUTE：忙时不给分流意图就拒绝；给了 duplexMode 才放行', async () => {
  // 先跑一轮，确保 session entry 存在
  await rt.askMain('先来一轮');
  const key = `${dm.id}:${mainBot.id}`;
  const entry = rt.runner.sessions.get(key);
  assert.ok(entry, '跑过一轮之后应该有 session entry');
  entry.busy = true;
  try {
    await assert.rejects(
      () => rt.send(dm.id, '顺便再看看日志'),
      (err) => {
        assert.equal(err.code, 'E_BUSY_NEEDS_ROUTE');
        assert.equal(err.details.roomId, dm.id);
        assert.equal(err.details.botId, mainBot.id);
        assert.deepEqual(err.details.options, ['side_reply', 'amend', 'abort_replace']);
        assert.match(err.message, /duplexMode/);
        return true;
      },
    );
    // 显式意图不该再被"没给意图"拦住
    const explicit = await rt.send(dm.id, '顺便再看看日志', { duplexMode: 'amend' }).then(
      () => null,
      (err) => err,
    );
    assert.notEqual(explicit?.code, 'E_BUSY_NEEDS_ROUTE', '显式 duplexMode 必须放行');
  } finally {
    entry.busy = false;
  }
});

await test('E_TURN_FAILED：这一轮执行失败（模型抛错）带 code 回给宿主', async () => {
  rtState.behavior = 'throw';
  try {
    await assert.rejects(() => rt.askMain('这一轮会炸'), (err) => {
      assert.equal(err.code, 'E_TURN_FAILED', `实际：${err.code} / ${err.message}`);
      return true;
    });
  } finally {
    rtState.behavior = 'reply';
  }
});

await test('E_TIMEOUT：等回复超时给 E_TIMEOUT（带 timeoutMs / roomId）', async () => {
  rtState.behavior = 'hang';
  try {
    await assert.rejects(() => rt.askMain('这一轮很慢', { timeoutMs: 40 }), (err) => {
      assert.equal(err.code, 'E_TIMEOUT');
      assert.equal(err.details.timeoutMs, 40);
      assert.equal(err.details.roomId, dm.id);
      return true;
    });
  } finally {
    rtState.behavior = 'reply';
  }
});

/** 同步门面（如 lessons.list）直接抛错，异步入口返回 rejected promise —— 两者都要带 code */
async function rejectsWith(call, predicate, label = 'call') {
  let caught = null;
  try {
    await call();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `${label} 应该失败，实际成功了`);
  assert.ok(predicate(caught), `${label} 的错误不符合预期：${caught?.code} / ${caught?.message}`);
}

await test('E_DISPOSED：dispose 之后的入口全部拒绝；dispose 自己幂等', async () => {
  await rt.dispose();
  await rt.dispose(); // 再来一次不能抛
  for (const [label, call] of [
    ['send', () => rt.send(dm.id, 'hi')],
    ['askMain', () => rt.askMain('hi')],
    ['runBotOnce', () => rt.runBotOnce({ roomId: dm.id, botId: mainBot.id })],
    ['abort', () => rt.abort(dm.id)],
    ['reset', () => rt.reset(dm.id)],
    ['lessons.list', () => rt.lessons.list()],
  ]) {
    await rejectsWith(
      call,
      (err) => {
        assert.equal(err.code, 'E_DISPOSED', `${label} 应该是 E_DISPOSED，实际 ${err.code}`);
        return true;
      },
      label,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. 静态守卫：sdk 目录里不再有裸抛，且每条 code 都有测例
// ---------------------------------------------------------------------------
const SDK_DIR = path.resolve(import.meta.dirname, '..', 'src', 'sdk');

function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf('//');
      return at < 0 ? line : line.slice(0, at);
    })
    .join('\n');
}

await test('静态：server/src/sdk/ 里没有裸字符串抛错（throw new Error / throw \'…\'）', () => {
  const offenders = [];
  for (const file of fs.readdirSync(SDK_DIR).filter((f) => f.endsWith('.js'))) {
    const code = stripComments(fs.readFileSync(path.join(SDK_DIR, file), 'utf8'));
    for (const m of code.matchAll(/throw\s+(new\s+)?Error\s*\(/g)) offenders.push(`${file}: ${m[0]}`);
    for (const m of code.matchAll(/throw\s+['"`]/g)) offenders.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `这些地方还在裸抛，宿主拿不到 code：\n${offenders.join('\n')}`);
});

await test('静态：ORBIS_ERROR_CODES 的每个 code 在本文件里都有断言', () => {
  const self = fs.readFileSync(import.meta.filename, 'utf8');
  // 认两种写法：`CODE.E_XXX` 与字面量 `'E_XXX'`（断言里常用后者）
  const missing = Object.values(CODE).filter(
    (value) => !self.includes(`CODE.${value}`) && !self.includes(`'${value}'`),
  );
  assert.deepEqual(missing, [], `这些 code 没有测例：${missing.join(', ')}`);
});

console.log(`\nsdk-errors: ${pass} 通过 / ${fail} 失败`);
// T2.4 之后构造失败会回收句柄（见 sdk-lifecycle.mjs 的子进程用例），
// 这里不再强制 process.exit：进程能不能自己退出也是一条回归信号。
process.exitCode = fail ? 1 : 0;
