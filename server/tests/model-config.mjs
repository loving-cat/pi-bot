/** 模型配置与错误传播回归；仅使用临时目录、假运行时和本机假 HTTP 服务。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-model-config-'));
const inherited = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']);
for (const name of Object.keys(process.env)) {
  if (!inherited.has(name)) delete process.env[name];
}
process.env.HOME = path.join(root, 'fixture-home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'fixture-agent');
process.env.PI_BOT_DATA_DIR = root;
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const localFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('fixture forbids external network');
  }
  return localFetch(input, options);
};
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
process.env.PI_BOT_MODEL = 'group-test/model-a';
process.env.PI_BOT_WATCH_CHANGES = '0';
process.env.PI_BOT_AUTO_ATTACH_IMAGES = '0';
const { mergeGroupModels, capacityError } = await import('../src/model-capacity.js');
const { ModelGroup, modelGroups } = await import('../src/model-groups.js');
const { modelFailure, assistantFailure, fallbackModels, recoverModelReply } = await import('../src/model-reply.js');
const { invalidateSessions, retireStaleSession } = await import('../src/session-refresh.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { store } = await import('../src/store.js');
const { createHttpServer } = await import('../src/http.js');
const { bus } = await import('../src/bus.js');
const { saveBuffer } = await import('../src/attachments.js');
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.log(`✗ ${name}: ${error.message}`); }
}
const original = { id: 'model-a', name: 'Model A', contextWindow: 240_000,
  maxTokens: 24_000, input: ['text', 'image'], reasoning: true };
const model = { ...original, provider: 'group-test' };
function isolatedRunner() {
  const runner = new PiRunner();
  runner.__buildSession = async () => assert.fail('fixture must not construct a real SDK session');
  return runner;
}
await test('字符串编辑保留同 id 容量与全部已知元数据', () => {
  assert.deepEqual(mergeGroupModels(['model-a'], {}, [original]).models, [original]);
});
await test('对象只改容量时保留名称、输入与推理声明', () => {
  const result = mergeGroupModels([{ id: 'model-a', maxTokens: 32_000 }], {}, [original]);
  assert.deepEqual(result.models[0], { ...original, maxTokens: 32_000 });
});
await test('显式模型覆盖优先于显式组级覆盖，其次已保存值', () => {
  const result = mergeGroupModels([{ id: 'model-a', maxTokens: 32_000 }],
    { contextWindow: 300_000, maxTokens: 48_000 }, [original]);
  assert.equal(result.models[0].contextWindow, 300_000);
  assert.equal(result.models[0].maxTokens, 32_000);
});
await test('显式 false 与 text 输入覆盖旧声明', () => {
  const result = mergeGroupModels([{ id: 'model-a', reasoning: false, input: ['text'] }], {}, [original]);
  assert.equal(result.models[0].reasoning, false);
  assert.deepEqual(result.models[0].input, ['text']);
});
await test('容量拒绝零、负数、小数、字符串、空值和非安全整数', () => {
  for (const value of [0, -1, 2.5, '4096', '', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(mergeGroupModels([{ id: 'model-a', contextWindow: value }]).error);
    assert.ok(mergeGroupModels(['model-a'], { maxTokens: value }).error);
  }
});
await test('合并后输出容量不能超上下文，新模型默认也参与验证', () => {
  assert.ok(mergeGroupModels([{ id: 'model-a', contextWindow: 1000 }]).error);
  assert.ok(mergeGroupModels([{ id: 'model-a', maxTokens: 300_000 }], {}, [original]).error);
  assert.equal(capacityError({ contextWindow: 8192, maxTokens: 8192 }), null);
});
await test('bot 清空覆盖回到模型容量，预算必须正整数', () => {
  assert.equal(capacityError({ contextWindow: null, maxTokens: null }, model, { allowNull: true }), null);
  assert.ok(capacityError({ contextWindow: 1000, maxTokens: null }, model, { allowNull: true }));
  assert.ok(capacityError({ reserveTokens: 1.5 }, {}, { allowNull: true }));
});
await test('模型组部分更新保留连接与元数据，Provider 配置使用新容量', () => {
  const previous = ModelGroup.fromInput({ id: 'group-test', baseUrl: 'https://example.test', models: [original] }).group;
  const edited = ModelGroup.fromInput({ models: ['model-a'] }, { existing: previous }).group;
  assert.deepEqual(edited.models, [original]);
  assert.equal(edited.toProviderConfig().models[0].contextWindow, 240_000);
});
await test('任意敏感错误原文只输出认证类别与状态', () => {
  const failure = modelFailure('HTTP 401 unauthorized https://example.test/private?token=fixture-credential fixture@example.test password=fixture-secret');
  assert.equal(failure.auth, true);
  assert.match(failure.error, /401/);
  assert.doesNotMatch(failure.error, /example|credential|secret|password|thinking/i);
  assert.match(modelFailure({ status: 403 }).error, /403/);
  assert.doesNotMatch(modelFailure('https://example.test fixture-secret').error, /example|secret/);
});
await test('SDK assistant message_end 错误与 stopReason 被识别', () => {
  assert.equal(assistantFailure({ role: 'user', errorMessage: '401' }), null);
  assert.equal(assistantFailure({ role: 'assistant', errorMessage: '401 unauthorized' }).status, 401);
  assert.ok(assistantFailure({ role: 'assistant', stopReason: 'error' }));
  assert.equal(assistantFailure({ role: 'assistant', stopReason: 'stop' }), null);
});
await test('兜底只在当前与默认模型中去重', () => {
  assert.deepEqual(fallbackModels(model, { ...model }), [model]);
  assert.equal(fallbackModels(model, { ...model, id: 'model-b' }).length, 2);
  assert.deepEqual(fallbackModels(null, null), []);
});
await test('已有 401 错误不催促、不调用备用模型', async () => {
  const result = await recoverModelReply({ failure: modelFailure('401 unauthorized'),
    nudge: () => assert.fail('不能催促'), complete: () => assert.fail('不能切模型') });
  assert.equal(result.failure.status, 401);
});
await test('催促返回 403 时立即停止，真实空回复才走文本补答', async () => {
  let calls = 0;
  const refused = await recoverModelReply({ nudge: async () => {}, readText: () => '',
    readFailure: () => modelFailure('403 forbidden'), models: [model], complete: () => calls++ });
  assert.equal(refused.failure.status, 403);
  assert.equal(calls, 0);
  const recovered = await recoverModelReply({ nudge: async () => {}, readText: () => '',
    readFailure: () => null, models: [model], complete: async () => ({ role: 'assistant', content: [{ type: 'text', text: 'done' }] }) });
  assert.equal(recovered.text, 'done');
});
await test('备用模型鉴权失败不继续下一条线路', async () => {
  let calls = 0;
  const result = await recoverModelReply({ nudge: async () => {}, readText: () => '', readFailure: () => null,
    models: [model, { ...model, id: 'model-b' }], complete: async () => { calls++; return { role: 'assistant', errorMessage: '401 unauthorized' }; } });
  assert.equal(result.failure.status, 401);
  assert.equal(calls, 1);
});
await test('SDK aborted 与 AbortError 均识别为终止', () => {
  assert.equal(assistantFailure({ role: 'assistant', stopReason: 'aborted' }).aborted, true);
  assert.equal(modelFailure(Object.assign(new Error('fixture'), { name: 'AbortError' })).aborted, true);
});
await test('催促抛 AbortError 时绝不调用备用模型', async () => {
  let calls = 0;
  const result = await recoverModelReply({ nudge: async () => { throw Object.assign(new Error('fixture'), { name: 'AbortError' }); },
    readText: () => '', readFailure: () => null, models: [model], complete: async () => { calls++; } });
  assert.equal(result.failure.aborted, true);
  assert.equal(result.recovered, false);
  assert.equal(calls, 0);
});
await test('催促期间取消后不开始备用请求', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await recoverModelReply({ signal: controller.signal, nudge: async () => controller.abort(),
    readText: () => 'late', readFailure: () => null, models: [model], complete: async () => { calls++; } });
  assert.equal(result.failure.aborted, true);
  assert.equal(result.text, '');
  assert.equal(calls, 0);
});
await test('备用请求传取消信号，取消后忽略迟到内容且不再请求', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await recoverModelReply({ signal: controller.signal, nudge: async () => {},
    readText: () => '', readFailure: () => null, models: [model, { ...model, id: 'model-b' }],
    complete: async (_model, signal) => { calls++; assert.equal(signal, controller.signal); controller.abort('fixture');
      return { role: 'assistant', content: [{ type: 'text', text: 'late' }] }; } });
  assert.equal(result.failure.aborted, true);
  assert.equal(result.recovered, false);
  assert.equal(result.text, '');
  assert.equal(calls, 1);
});
await test('忙碌及建会话期间仅标记刷新，空闲后释放', () => {
  let disposed = 0;
  const session = { dispose: () => disposed++ };
  const sessions = new Map([['room-a:bot-a', { session, busy: true }],
    ['room-b:bot-a', { session, pending: Promise.resolve() }]]);
  assert.equal(invalidateSessions(sessions, () => true), 2);
  assert.equal(disposed, 0);
  assert.equal(retireStaleSession(sessions, 'room-a:bot-a'), false);
  sessions.get('room-a:bot-a').busy = false;
  assert.equal(retireStaleSession(sessions, 'room-a:bot-a'), true);
  assert.equal(disposed, 1);
});

function fakeSession({ error = null, text = 'done', stopReason = null, events = [], onPrompt = () => {} } = {}) {
  let listener;
  return { model, subscribe(fn) { listener = fn; return () => {}; }, dispose() {}, async abort() {},
    async prompt() { onPrompt(); for (const event of events) listener(event);
      listener({ type: 'message_end', message: error || stopReason
      ? { role: 'assistant', stopReason: stopReason ?? 'error', errorMessage: error }
      : { role: 'assistant', content: [{ type: 'text', text }] } }); } };
}
await test('真实 runner 把 SDK 401 作为 msg.error 返回且只请求一次', async () => {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  let calls = 0;
  runner.model = model;
  runner.modelRuntime = { completeSimple: () => assert.fail('401 不能调用备用模型') };
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false,
    session: fakeSession({ error: '401 unauthorized https://example.test fixture-credential', onPrompt: () => calls++ }) });
  const result = await runner.run(room.id, bot.id, 'fixture');
  assert.equal(result.ok, false);
  assert.match(result.error, /401/);
  assert.doesNotMatch(result.error, /example|credential|thinking/i);
  assert.equal(calls, 1);
  assert.equal(store.listMessages(room.id).at(-1).status, 'error');
});
await test('runner 收到 SDK aborted 后保留终止状态，不催促不补答', async () => {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  let calls = 0;
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false,
    session: fakeSession({ stopReason: 'aborted', onPrompt: () => calls++ }) });
  runner.modelRuntime = { completeSimple: () => assert.fail('不能补答') };
  const result = await runner.run(room.id, bot.id, 'fixture');
  assert.equal(result.ok, false);
  assert.equal(result.error, '已终止');
  assert.equal(calls, 1);
});
await test('runner 在补答期间终止会传信号并保留用户终止状态', async () => {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  let calls = 0;
  runner.model = model;
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false, session: fakeSession({ text: '' }) });
  runner.modelRuntime = { completeSimple: async (_model, _context, options) => {
    calls++;
    assert.equal(options.signal.aborted, false);
    await runner.abort(room.id);
    assert.equal(options.signal.aborted, true);
    return { role: 'assistant', content: [{ type: 'text', text: 'late' }] };
  } };
  const result = await runner.run(room.id, bot.id, 'fixture');
  assert.equal(result.ok, false);
  assert.equal(result.error, '已按你的要求终止');
  assert.equal(result.text, '');
  assert.equal(calls, 1);
  assert.equal(store.listMessages(room.id).at(-1).error, '已按你的要求终止');
});
await test('压缩结束事件只广播脱敏错误，不含接口原文', async () => {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  const received = [];
  const onEvent = (event) => { if (event.t === 'bot.compacting') received.push(event); };
  bus.on('event', onEvent);
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false, session: fakeSession({ events: [
    { type: 'compaction_end', reason: 'fixture', errorMessage: 'HTTP 401 https://example.test?token=fixture-credential fixture@example.test password=fixture-secret' },
  ] }) });
  try { assert.equal((await runner.run(room.id, bot.id, 'fixture')).ok, true); }
  finally { bus.off('event', onEvent); }
  assert.equal(received.length, 1);
  assert.match(received[0].error, /401/);
  assert.doesNotMatch(JSON.stringify(received), /example|credential|secret|password/);
});
await test('忙碌配置刷新在下一轮生效且保留会话历史路径', async () => {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const history = path.join(root, 'history.jsonl');
  fs.writeFileSync(history, 'fixture history');
  store.setSessionFile(room.id, bot.id, history);
  const runner = isolatedRunner();
  let disposed = 0;
  const old = { bot, busy: true, session: { dispose: () => disposed++ } };
  runner.sessions.set(`${room.id}:${bot.id}`, old);
  runner.reloadSessionForBot(bot.id);
  assert.equal(disposed, 0);
  store.updateBot(bot.id, { contextWindow: 300_000, reserveTokens: 16000 });
  old.busy = false;
  let built = 0;
  runner.__buildSession = async () => { built++; return { bot: store.getBot(bot.id), session: fakeSession() }; };
  assert.equal((await runner.run(room.id, bot.id, 'fixture')).ok, true);
  assert.equal(built, 1);
  assert.equal(disposed, 1);
  assert.equal(runner.sessions.get(`${room.id}:${bot.id}`).bot.contextWindow, 300_000);
  assert.equal(store.sessionFileFor(room.id, bot.id), history);
  assert.equal(fs.readFileSync(history, 'utf8'), 'fixture history');
});
await test('轮次刚发出即修改配置不会销毁已取用的会话', async () => {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  let disposed = 0;
  const session = fakeSession();
  session.dispose = () => disposed++;
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false, session });
  const turn = runner.run(room.id, bot.id, 'fixture');
  runner.reloadSessionForBot(bot.id);
  assert.equal((await turn).ok, true);
  assert.equal(disposed, 0);
});
await test('双 run 取用窗口内刷新不销毁首轮，第二轮明确返回忙碌', async () => {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  let disposed = 0;
  const session = fakeSession({ onPrompt: () => assert.equal(disposed, 0) });
  session.dispose = () => disposed++;
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false, session });
  const first = runner.run(room.id, bot.id, 'fixture');
  runner.reloadSessionForBot(bot.id);
  const second = runner.run(room.id, bot.id, 'fixture');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.match(b.error, /正在忙/);
  assert.equal(disposed, 0);
  let built = 0;
  runner.__buildSession = async () => { built++; return { bot, session: fakeSession() }; };
  assert.equal((await runner.run(room.id, bot.id, 'fixture')).ok, true);
  assert.equal(built, 1);
  assert.equal(disposed, 1);
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const drain = () => new Promise((resolve) => setImmediate(resolve));
async function waitIdle(entry) {
  for (let i = 0; i < 100; i++) {
    if (!entry.busy) return;
    await drain();
  }
  assert.fail('fixture turn did not finish');
}
function directFixture({ queueError = false, prepareGate = null } = {}) {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  const gate = deferred();
  runner.__buildSession = async () => assert.fail('fixture must not construct a real SDK session');
  const prompts = [];
  const queues = [];
  let disposed = 0;
  let listener;
  const session = { model, subscribe(fn) { listener = fn; return () => {}; }, async abort() {},
    dispose() { disposed++; },
    async prompt(text) {
      assert.equal(disposed, 0);
      prompts.push(text);
      await gate.promise;
      listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
    },
  };
  for (const mode of ['steer', 'followUp']) {
    session[mode] = async (text, images) => {
      if (queueError) throw new Error('401 unauthorized https://example.test fixture-credential');
      queues.push({ mode, text, images });
      return 'queued';
    };
  }
  const entry = { bot, busy: false, session };
  runner.sessions.set(`${room.id}:${bot.id}`, entry);
  runner.__buildInput = async (text, files) => {
    if (prepareGate) await prepareGate.promise;
    return { promptText: files.length ? `${text}\nfixture attachment context` : text };
  };
  return { runner, bot, room, entry, gate, prompts, queues, disposed: () => disposed };
}
await test('public send 同时接受的私聊按原模式投递且保留附件，不重复用户消息', async () => {
  const image = saveBuffer(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { name: 'fixture.png', mime: 'image/png' });
  for (const mode of ['steer', 'followUp']) {
    const f = directFixture();
    try {
      const accepted = await Promise.all([
        f.runner.send(f.room.id, 'fixture-first'),
        f.runner.send(f.room.id, 'fixture-second', { mode, attachments: [image.id] }),
      ]);
      await drain();
      assert.equal(accepted.length, 2);
      assert.deepEqual(f.prompts, ['fixture-first']);
      assert.equal(f.queues.length, 1);
      assert.equal(f.queues[0].mode, mode);
      assert.equal(f.queues[0].text, 'fixture-second\nfixture attachment context');
      assert.equal(f.queues[0].images.length, 1);
      assert.equal(f.queues[0].images[0].mimeType, 'image/png');
      const users = store.listMessages(f.room.id).filter((message) => message.authorType === 'user');
      assert.equal(users.length, 2);
      assert.equal(users[1].attachments[0].id, image.id);
      assert.equal(users[1].meta.queued, mode);
    } finally { f.gate.resolve(); await waitIdle(f.entry); }
  }
});
await test('public send 并发投递期间重载不销毁首轮，后续空闲轮才重建', async () => {
  const f = directFixture();
  try {
    const first = f.runner.send(f.room.id, 'fixture-first');
    const second = f.runner.send(f.room.id, 'fixture-second', { mode: 'followUp' });
    await Promise.all([first, second]);
    await drain();
    f.runner.reloadSessionForBot(f.bot.id);
    assert.equal(f.disposed(), 0);
    assert.deepEqual(f.prompts, ['fixture-first']);
    assert.equal(f.queues[0].text, 'fixture-second');
  } finally { f.gate.resolve(); await waitIdle(f.entry); }
  let built = 0;
  f.runner.__buildSession = async () => { built++; return { bot: f.bot, session: fakeSession() }; };
  await f.runner.send(f.room.id, 'fixture-third');
  await drain();
  assert.equal(built, 1);
  assert.equal(f.disposed(), 1);
});
await test('public send 取消待投递消息后新消息不会使旧请求复活', async () => {
  const prepareGate = deferred();
  const f = directFixture({ prepareGate });
  try {
    await Promise.all([f.runner.send(f.room.id, 'fixture-first'), f.runner.send(f.room.id, 'fixture-second')]);
    await f.runner.abort(f.room.id);
    await f.runner.send(f.room.id, 'fixture-third');
    prepareGate.resolve();
    await drain();
    assert.deepEqual(f.prompts, ['fixture-third']);
    assert.equal(f.queues.length, 0);
    const users = store.listMessages(f.room.id).filter((message) => message.authorType === 'user');
    assert.equal(users.length, 3);
    for (const message of users.slice(0, 2)) {
      assert.equal(message.status, 'error');
      assert.equal(message.error, '已终止');
    }
  } finally { prepareGate.resolve(); f.gate.resolve(); await waitIdle(f.entry); }
});
await test('public send 排队失败更新原用户消息为可见脱敏错误', async () => {
  const f = directFixture({ queueError: true });
  try {
    await Promise.all([f.runner.send(f.room.id, 'fixture-first'), f.runner.send(f.room.id, 'fixture-second')]);
    await drain();
    const users = store.listMessages(f.room.id).filter((message) => message.authorType === 'user');
    assert.equal(users.length, 2);
    assert.equal(users[1].status, 'error');
    assert.match(users[1].error, /401/);
    assert.doesNotMatch(users[1].error, /example|credential/);
  } finally { f.gate.resolve(); await waitIdle(f.entry); }
});
await test('建会话期间配置变化在运行前重建，不遗留旧容量', async () => {
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let built = 0;
  let disposed = 0;
  runner.__buildSession = async () => {
    built++;
    const current = store.getBot(bot.id);
    if (built === 1) await gate;
    const session = fakeSession();
    session.dispose = () => disposed++;
    return { bot: current, session };
  };
  const turn = runner.run(room.id, bot.id, 'fixture');
  store.updateBot(bot.id, { contextWindow: 300_000 });
  runner.reloadSessionForBot(bot.id);
  release();
  assert.equal((await turn).ok, true);
  assert.equal(built, 2);
  assert.equal(disposed, 1);
  assert.equal(runner.sessions.get(`${room.id}:${bot.id}`).bot.contextWindow, 300_000);
});
await test('模型组注册后刷新空默认模型与 initNote，并采用新容量', async () => {
  const runner = isolatedRunner();
  const registry = new Map();
  runner.modelRuntime = { registerProvider(id, config) { for (const m of config.models) registry.set(`${id}/${m.id}`, { ...m, provider: id }); },
    unregisterProvider(id) { for (const key of registry.keys()) if (key.startsWith(`${id}/`)) registry.delete(key); },
    getModels: () => [...registry.values()], getModel: (provider, id) => registry.get(`${provider}/${id}`),
    getAvailable: async () => [...registry.values()] };
  runner.initNote = 'fixture';
  modelGroups.upsert({ id: undefined, name: 'group-test', baseUrl: 'https://example.test', models: [original] });
  const group = modelGroups.list()[0];
  await runner.applyModelGroupChange(group.id);
  assert.equal(runner.initNote, null);
  assert.equal(runner.model.id, 'model-a');
  modelGroups.upsert({ id: group.id, models: [{ id: 'model-a', contextWindow: 300_000 }] });
  await runner.applyModelGroupChange(group.id);
  assert.equal(runner.model.contextWindow, 300_000);
});
await test('假 HTTP 校验 bot 容量并只刷新历史会话', async () => {
  let reloads = 0;
  const runner = { model, availableModels: [], modelLabel: () => null, resolveModel: () => model,
    reloadSessionForBot: () => reloads++, resetSessionForBot: () => assert.fail('不能清历史') };
  const bot = store.createBot({ name: 'model-a', persona: 'fixture' });
  const server = createHttpServer({ runner, pairing: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/bots/${bot.id}`;
  try {
    const invalid = await fetch(endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contextWindow: 100 }) });
    assert.equal(invalid.status, 400);
    const valid = await fetch(endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contextWindow: 300_000, maxTokens: 32_000, reserveTokens: 16000 }) });
    assert.equal(valid.status, 200);
    assert.equal(reloads, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
store.saveNow();
fs.rmSync(root, { recursive: true, force: true });
console.log(`模型配置与错误回归：${passed}/${passed + failed} 通过`);
process.exitCode = failed ? 1 : 0;
