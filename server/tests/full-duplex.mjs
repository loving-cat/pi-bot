/**
 * 全双工边干边聊核心链路单测（Mock 模型与工具替身，不连网）：
 *   node tests/full-duplex.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-full-duplex-'));
const wsDir = path.join(root, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_HOME: path.join(root, 'data'),
  PI_BOT_WORKSPACE: wsDir,
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
  PI_BOT_TASK_INTAKE: '0',
  PI_BOT_WATCH_CHANGES: '0',
  PI_BOT_AUTO_ATTACH: '0',
  PI_BOT_AUTO_ATTACH_FILES: '0',
  PI_BOT_FULL_DUPLEX: '1',
});
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => { throw new Error('test forbids network'); };

const { store } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { createSessionBuilder } = await import('../src/session-factory.js');
const { buildCommonTools } = await import('../src/tools.js');
const { openRequest, createRequestLifecycle } = await import('../src/coordination/task-request-gate.js');
const { createRequestReceipts } = await import('../src/tasks/task-request-receipts.js');

const model = { provider: 'fixture', id: 'fixture', contextWindow: 16000, maxTokens: 1000 };
const receipts = createRequestReceipts({ dir: path.join(process.env.PI_BOT_HOME, 'task-requests') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drain = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeRunner() {
  const runner = new PiRunner();
  runner.model = model;
  runner.modelRuntime = { completeSimple: () => assert.fail('test forbids completeSimple') };
  runner.memoryAutoDisabled = true;
  runner.fullDuplexEnabled = true;
  return runner;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.stack || err?.message || String(err) });
  }
}

await test('FD-1 私聊阻塞工具运行期间：side_reply 秒回且不打断 Work，不污染主会话文件，收尾回传 sideContext', async () => {
  const bot = store.createBot({ name: '工匠A', persona: '认真' });
  const dm = store.ensureDm(bot.id);
  const workSessionFile = path.join(root, 'sessions', 'work-a.jsonl');
  store.setSessionFile(dm.id, bot.id, workSessionFile);

  const runner = makeRunner();
  const terminals = [];
  runner.setRequestLifecycle(createRequestLifecycle({
    receipts,
    taskRuns: store.taskRuns,
    onTerminal: (scope, out) => terminals.push({ scope, out }),
  }));

  const workGate = deferred();
  const workStarted = deferred();
  const workPrompts = [];
  const talkPrompts = [];
  let talkDisposed = 0;

  let workListener;
  const workSession = {
    model,
    sessionFile: workSessionFile,
    subscribe(fn) { workListener = fn; return () => {}; },
    dispose() {},
    async abort() { workGate.resolve(); },
    async prompt(text) {
      workPrompts.push(text);
      workListener({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'npm run build-slow' },
      });
      workStarted.resolve();
      await workGate.promise;
      workListener({
        type: 'tool_execution_end',
        toolName: 'bash',
        isError: false,
        durationMs: 120,
      });
      workListener({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '长脚本执行完毕' }] },
      });
    },
  };

  runner.__buildSession = async (_roomId, _botId, opts = {}) => {
    if (opts.talkLane) {
      let talkListener;
      return {
        bot,
        configurationCurrent: () => true,
        session: {
          model,
          subscribe(fn) { talkListener = fn; return () => {}; },
          dispose() { talkDisposed++; },
          async abort() {},
          async prompt(text) {
            talkPrompts.push(text);
            talkListener({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: '正在跑构建脚本' },
            });
            talkListener({
              type: 'message_end',
              message: { role: 'assistant', content: [{ type: 'text', text: '正在跑构建脚本，目前在 npm run build-slow。' }] },
            });
          },
        },
      };
    }
    return { bot, configurationCurrent: () => true, session: workSession };
  };

  const typingEvents = [];
  const onTyping = (ev) => {
    if (ev.t === 'typing' && ev.roomId === dm.id) typingEvents.push(ev);
  };
  bus.on('event', onTyping);

  const o1 = openRequest({ receipts, requesterId: 'dev_1', requestId: 'req_work_001', roomId: dm.id, text: '帮我跑个慢构建' });
  await runner.send(dm.id, '帮我跑个慢构建', { request: { scope: o1.scope } });
  await workStarted.promise;

  // Work 正在阻塞运行，发送问进度消息（带 requestId）
  const o2 = openRequest({ receipts, requesterId: 'dev_1', requestId: 'req_side_002', roomId: dm.id, text: '现在什么进度了？' });
  const r2 = await runner.send(dm.id, '现在什么进度了？', { request: { scope: o2.scope } });
  assert.equal(r2.duplex, 'side_reply');

  // 等 Talk 回复落地，同时确认 Work 还在跑
  for (let i = 0; i < 40; i++) {
    if (terminals.some((t) => t.scope.requestId === 'req_side_002')) break;
    await sleep(20);
  }
  bus.off('event', onTyping);

  assert.equal(runner.isBusy(dm.id, bot.id), true, 'Talk 回复完时 Work 仍在继续执行');
  assert.equal(talkPrompts.length, 1);
  assert.match(talkPrompts[0], /npm run build-slow/, 'Talk 必须看到后台正在执行的实时步骤快照');
  assert.equal(talkDisposed, 1, 'Talk 会话结束必须立即释放内存实例');
  assert.equal(store.sessionFileFor(dm.id, bot.id), workSessionFile, '主会话文件路径绝不能被 Talk 覆盖');

  const sideTerm = terminals.find((t) => t.scope.requestId === 'req_side_002');
  assert.equal(sideTerm?.out?.receipt?.stage, 'answered', 'side_reply 必须正确关闭请求回执');
  assert.ok(typingEvents.some((e) => e.lane === 'talk' && e.active === false));

  // 放行 Work 结束
  workGate.resolve();
  for (let i = 0; i < 40 && runner.isBusy(dm.id, bot.id); i++) await sleep(20);
  assert.equal(runner.isBusy(dm.id, bot.id), false);

  // 开启下一轮普通对话：应注入此前 Talk 问答备忘（防遗忘）
  await runner.send(dm.id, '继续下一步');
  for (let i = 0; i < 40 && workPrompts.length < 2; i++) await sleep(20);
  for (let i = 0; i < 40 && runner.isBusy(dm.id, bot.id); i++) await sleep(20);
  assert.match(workPrompts[1], /此前后台干活期间的旁路沟通备忘/, '下一轮 Work 必须消费旁路备忘');
  assert.match(workPrompts[1], /现在什么进度了/, '备忘应包含刚刚问过的内容');
});

await test('FD-0 非受管态下带 requestId 忙时 amend 不再死进 requestQueues，而是立即 steer 且不重排气泡', async () => {
  const bot = store.createBot({ name: '工匠B', persona: '认真' });
  const dm = store.ensureDm(bot.id);
  const runner = makeRunner();
  const terminals = [];
  runner.setRequestLifecycle(createRequestLifecycle({
    receipts,
    taskRuns: store.taskRuns,
    onTerminal: (scope, out) => terminals.push({ scope, out }),
  }));

  const steered = [];
  const workMsg = store.appendMessage({
    roomId: dm.id,
    authorType: 'bot',
    authorId: bot.id,
    authorName: bot.name,
    text: '正在排查…',
    status: 'streaming',
  });
  runner.sessions.set(`${dm.id}:${bot.id}`, {
    busy: true,
    bot,
    liveMsgId: workMsg.id,
    turnAmends: [],
    session: {
      model,
      steer: async (t) => { steered.push(t); return 'steered'; },
      followUp: async (t) => { steered.push(t); return 'queued'; },
    },
  });

  const o = openRequest({ receipts, requesterId: 'dev_1', requestId: 'req_amend_003', roomId: dm.id, text: '顺便加一行日志' });
  const res = await runner.send(dm.id, '顺便加一行日志', { request: { scope: o.scope } });

  assert.equal(res.steered, 'steer');
  assert.equal(res.duplex, 'amend');
  assert.equal(runner.requestQueues.get(dm.id), undefined, '非受管态忙时不应死进 requestQueues');
  assert.equal(steered.length, 1);
  assert.match(steered[0], /顺便加一行日志/);

  // 验证没有挪动旧 workMsg 位置（workMsg 仍在 userMessage 前面）
  const ids = store.listMessages(dm.id).map((m) => m.id);
  assert.ok(ids.indexOf(workMsg.id) < ids.indexOf(res.userMessage.id), '不应调用 moveMessageAfter 乱挪旧气泡');
  assert.equal(terminals.find((t) => t.scope.requestId === 'req_amend_003')?.out?.receipt?.stage, 'answered');
});

await test('FD-2 群聊成员忙碌时问进度：只唤醒负责人走 Talk 秒答，在跑成员与 roundQueue 零中断', async () => {
  const lead = store.createBot({ name: '主管C', persona: '统筹' });
  const member = store.createBot({ name: '执行C', persona: '写代码' });
  const group = store.createGroup({ name: '全双工研发组', botIds: [lead.id, member.id], leadBotId: lead.id });
  const runner = makeRunner();

  let memberAborted = 0;
  const memberCtrl = new AbortController();
  runner.sessions.set(`${group.id}:${member.id}`, {
    busy: true,
    bot: member,
    startedAt: Date.now() - 3000,
    goalText: '跑单测',
    liveMsgId: 'm_member_live',
    liveSteps: [{ tool: 'bash', status: 'running', detail: 'node tests/unit.mjs' }],
    turnController: memberCtrl,
    session: { abort: async () => { memberAborted++; } },
  });
  runner.roundLocks.add(group.id);
  runner.roundQueue.set(group.id, { text: '排队后续', files: [] });

  let talkBuiltFor = null;
  runner.__buildSession = async (_rid, bid, opts = {}) => {
    assert.equal(opts.talkLane, true);
    talkBuiltFor = bid;
    let listener;
    return {
      bot: lead,
      session: {
        model,
        subscribe(fn) { listener = fn; return () => {}; },
        dispose() {},
        async abort() {},
        async prompt(text) {
          assert.match(text, /node tests\/unit\.mjs/);
          listener({
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: '执行C正在跑 node tests/unit.mjs。' }] },
          });
        },
      },
    };
  };

  const out = await runner.send(group.id, '大家目前进度如何？');
  assert.equal(out.duplex, 'side_reply');
  await sleep(60);

  assert.equal(talkBuiltFor, lead.id, '应仅唤醒部门负责人');
  assert.equal(memberAborted, 0, '绝不能打断在跑成员');
  assert.equal(memberCtrl.signal.aborted, false);
  assert.equal(runner.roundQueue.has(group.id), true, '原队列应保留');
  assert.ok(store.listMessages(group.id).some((m) => m.authorId === lead.id && m.text.includes('正在跑')));
  runner.roundLocks.delete(group.id);
  runner.roundQueue.delete(group.id);
});

await test('FD-2 dispatch_bot 异步派活立刻返回，后台完成后交付物镜像回来源房间', async () => {
  const chief = store.mainBot();
  const worker = store.createBot({ name: '助理D', persona: '写文档' });
  const dmChief = store.ensureDm(chief.id);
  const runner = makeRunner();
  const workerGate = deferred();
  const originalRunBotOnce = runner.runBotOnce.bind(runner);
  runner.runBotOnce = async ({ roomId, botId }) => {
    await workerGate.promise;
    return { ok: true, text: 'worker async delivered!', ms: 12 };
  };

  const dispatchTool = buildCommonTools({
    runner,
    roomId: dmChief.id,
    botId: chief.id,
    isMain: true,
  }).find((t) => t.name === 'dispatch_bot');
  assert.ok(dispatchTool, '必须注册 dispatch_bot 工具');

  const toolRes = await dispatchTool.execute('call_dsp', { botId: worker.id, task: '整理一份总结' });
  assert.equal(toolRes.details.status, 'dispatched', 'dispatch_bot 必须立即返回不阻塞');
  assert.ok(toolRes.details.dispatchId);
  assert.equal(
    store.listMessages(dmChief.id).some((m) => m.text.includes('worker async delivered!')),
    false,
    '成员尚未跑完前不应提前交付',
  );

  workerGate.resolve();
  for (let i = 0; i < 40; i++) {
    if (store.listMessages(dmChief.id).some((m) => m.text.includes('worker async delivered!'))) break;
    await drain();
    await sleep(10);
  }
  assert.ok(
    store.listMessages(dmChief.id).some((m) => m.authorId === worker.id && m.text.includes('worker async delivered!')),
    '异步完成后应通过 mirrorDelegatedResult 把结果送回来源房间',
  );
  runner.runBotOnce = originalRunBotOnce;
});

await test('FD-1 session-factory 旁路 talkLane 强制纯内存与只读工具裁剪，不写 sessionFile', async () => {
  const bot = store.createBot({ name: '只读检验员', role: 'main' });
  const dm = store.ensureDm(bot.id);
  const runner = makeRunner();

  let inMemoryCalls = 0;
  let diskCalls = 0;
  let capturedOptions = null;
  const builder = createSessionBuilder({
    runner,
    health: null,
    resolveModel: () => null,
    modelLabel: () => '',
    sessionApi: {
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
      SessionManager: {
        inMemory: () => { inMemoryCalls++; return {}; },
        create: () => { diskCalls++; return {}; },
        open: () => { diskCalls++; return {}; },
      },
      DefaultResourceLoader: class {
        constructor(options) { this.options = options; this.handlers = new Map(); }
        async reload() {
          const pi = { on: (n, fn) => this.handlers.set(n, fn), registerMcpServer() {}, unregisterMcpServer() {} };
          for (const ext of this.options.extensionFactories) (ext.factory ?? ext)(pi);
        }
      },
      async createAgentSession(options) {
        capturedOptions = options;
        return {
          session: {
            model,
            sessionFile: path.join(root, 'should-not-save.jsonl'),
            settingsManager: { applyOverrides() {} },
            subscribe() { return () => {}; },
            dispose() {},
          },
        };
      },
    },
  });

  await builder(dm.id, bot.id, { talkLane: true });
  assert.equal(inMemoryCalls, 1, 'Talk 必须走 SessionManager.inMemory');
  assert.equal(diskCalls, 0, 'Talk 绝不能打开/新建磁盘会话');
  assert.equal(capturedOptions.customTools.length, 0, 'Talk 不挂载写/派活自定义工具');
  for (const t of ['bash', 'write', 'edit', 'run_background', 'dispatch_bot']) {
    assert.equal(capturedOptions.tools.includes(t), false, `Talk 禁止出现 ${t}`);
  }
  assert.equal(capturedOptions.resourceLoader.options.noExtensions, true);
  assert.equal(capturedOptions.resourceLoader.options.noMcp, true);
  assert.equal(store.sessionFileFor(dm.id, bot.id), null, 'Talk 不写 store sessionFile');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.err}`}`);
  if (!r.ok) failed++;
}
console.log(`\n全双工测试：${results.length - failed}/${results.length} 通过`);
clearTimeout(store?.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
