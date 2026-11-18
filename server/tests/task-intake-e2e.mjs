/**
 * TaskRun 接单默认开启与全双工 / Jarvis / SDK 协同端到端测试（W4c）。
 *   node tests/task-intake-e2e.mjs
 *
 * ## 守住的五件事
 *
 *   1. `intakeEnabled()` 默认开启，`ORBIS_TASK_INTAKE=0`（及兼容 `PI_BOT_TASK_INTAKE=0`）可关；
 *   2. 日常私聊与 Jarvis 即时控制零额外轮次延迟：不强跑第二次模型追问，直接按 `answer` 收口；
 *   3. `accept_task` 准入落盘后由 `taskHost` 真正派发执行，账本留下执行记录；
 *   4. 全双工三路协同：`side_reply` 独立旁路、`amend` 直通 `steer` 不进 `requestQueues`、
 *      `abort_replace` 取消在途受管 `TaskRun` 再启动新轮；
 *   5. `createOrbisRuntime` 默认轻量关闭 `taskIntake`，显式传 `taskIntake: true` 才装配任务宿主。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-intake-e2e-'));
const wsDir = path.join(root, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_HOME: path.join(root, 'data'),
  PI_BOT_WORKSPACE: wsDir,
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
  PI_BOT_WATCH_CHANGES: '0',
  PI_BOT_AUTO_ATTACH: '0',
  PI_BOT_AUTO_ATTACH_FILES: '0',
});
delete process.env.ORBIS_TASK_INTAKE;
delete process.env.PI_BOT_TASK_INTAKE;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => { throw new Error('test forbids network'); };

const { PiRunner } = await import('../src/pi-runner.js');
const { createStore } = await import('../src/store.js');
const { createBus } = await import('../src/bus.js');
const { createConfig } = await import('../src/config.js');
const { buildIntakeTools, intakeEnabled } = await import('../src/coordination/intake-tool.js');
const { openRequest, createRequestLifecycle } = await import('../src/coordination/task-request-gate.js');
const { createRequestReceipts } = await import('../src/tasks/task-request-receipts.js');
const { createTaskHost } = await import('../src/bootstrap/task-host.js');
const { createOrbisRuntime } = await import('../src/sdk/index.js');

const model = { provider: 'fixture', id: 'fixture', contextWindow: 16000, maxTokens: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeModelRuntimeFactory = async () => ({
  getAvailable: async () => [{ ...model, reasoning: false }],
  registerProvider() {},
  unregisterProvider() {},
  completeSimple: async () => ({ content: [{ type: 'text', text: '' }] }),
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

let caseSeq = 0;
function makeIsolatedHarness({ taskIntake = true } = {}) {
  const dir = path.join(root, `case-${++caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = createConfig({
    dataDir: dir,
    workspace: wsDir,
    autoProbe: false,
    lessonReflect: false,
    serverBoot: false,
  });
  const store = createStore({ config: cfg, dataDir: dir });
  const bus = createBus();
  const receipts = createRequestReceipts({ dir: path.join(dir, 'task-requests') });
  const runner = new PiRunner({ config: cfg, store, bus, taskIntake });
  runner.model = model;
  runner.memoryAutoDisabled = true;
  runner.fullDuplexEnabled = true;

  const terminals = [];
  runner.setRequestLifecycle(createRequestLifecycle({
    receipts,
    taskRuns: store.taskRuns,
    onTerminal: (scope, out) => terminals.push({ scope, out }),
  }));

  return { dir, cfg, store, bus, receipts, runner, terminals };
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

await test('1. ★ intakeEnabled() 默认开启，ORBIS_TASK_INTAKE 优先于 PI_BOT_TASK_INTAKE 可显式关闭', () => {
  assert.equal(intakeEnabled({}), true);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '0' }), false);
  assert.equal(intakeEnabled({ PI_BOT_TASK_INTAKE: '0' }), false);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '1', PI_BOT_TASK_INTAKE: '0' }), true);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '0', PI_BOT_TASK_INTAKE: '1' }), false);
});

await test('2. ★ 日常私聊与 Jarvis 即时控制零额外轮次延迟：不强跑二次追问，直接 answer 收口', async () => {
  const { store, receipts, runner, terminals } = makeIsolatedHarness({ taskIntake: true });
  try {
    const chief = store.mainBot();
    const dm = store.ensureDm(chief.id);
    const prompts = [];
    let listener;
    runner.__buildSession = async () => ({
      bot: chief,
      configurationCurrent: () => true,
      session: {
        model,
        subscribe(fn) { listener = fn; return () => {}; },
        dispose() {},
        async abort() {},
        async prompt(text) {
          prompts.push(text);
          listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '已为你切换到轻量配置。' }] } });
        },
      },
    });

    const opened = openRequest({ receipts, taskRuns: store.taskRuns, requesterId: 'u1', requestId: 'req_chat_1', roomId: dm.id, text: '帮我确认当前配置' });
    await runner.send(dm.id, '帮我确认当前配置', { request: { scope: opened.scope } });

    for (let i = 0; i < 60 && terminals.length === 0; i++) await sleep(20);
    assert.equal(prompts.length, 1, '绝不能因为没调 accept_task 而强跑第二次追问');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].out.receipt.stage, 'answered');
    assert.equal(terminals[0].out.receipt.kind, 'answer');
    assert.equal(store.taskRuns.listAll().taskRuns.length, 0);
  } finally {
    runner.disposeAll();
    store.dispose();
  }
});

await test('3. ★ accept_task 准入落盘后由 taskHost 派发并执行受管任务', async () => {
  const { store, receipts, runner, terminals } = makeIsolatedHarness({ taskIntake: true });
  const taskHost = createTaskHost({ store, runner });
  try {
    const chief = store.mainBot();
    const dm = store.ensureDm(chief.id);
    const intakeTools = buildIntakeTools({
      runner,
      store,
      roomId: dm.id,
      botId: chief.id,
      receipts,
      requestScopeOf: () => runner.currentRequestScope(dm.id, chief.id),
    });
    const acceptTool = intakeTools.find((t) => t.name === 'accept_task');
    assert.ok(acceptTool);

    const outArtifact = path.join(wsDir, 'w4c-deliverable.txt');
    fs.writeFileSync(outArtifact, 'ok\n');

    const prompts = [];
    const managedDone = deferred();
    let listener;
    let turnNo = 0;
    runner.__buildSession = async () => ({
      bot: chief,
      configurationCurrent: () => true,
      session: {
        model,
        subscribe(fn) { listener = fn; return () => {}; },
        dispose() {},
        async abort() {},
        async prompt(text) {
          turnNo++;
          prompts.push(text);
          if (turnNo === 1) {
            // 第一轮理解：调用真实的 accept_task 建单（direct）
            await acceptTool.execute('call_accept', {
              kind: 'accept_task',
              goal: {
                requirement: '生成结构化测试报告',
                verification: [{ id: 'v1', kind: 'artifact', description: '存在产物文件', required: true }],
              },
              routing: { type: 'direct' },
            });
            listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '收到，已登记任务并开始执行。' }] } });
          } else {
            // 第二轮受管执行：产出报告并收尾
            await runner.collectReport?.(dm.id, chief.id, {
              phase: 'completed',
              summary: '报告已生成',
              artifacts: [outArtifact],
            });
            listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '报告已生成。' }] } });
            managedDone.resolve();
          }
        },
      },
    });

    const opened = openRequest({ receipts, taskRuns: store.taskRuns, requesterId: 'u1', requestId: 'req_do_1', roomId: dm.id, text: '帮我生成一份测试报告' });
    await runner.send(dm.id, '帮我生成一份测试报告', { request: { scope: opened.scope } });

    await Promise.race([
      managedDone.promise,
      sleep(3000).then(() => { throw new Error('等待受管任务执行超时'); }),
    ]);
    for (let i = 0; i < 60 && runner.isBusy(dm.id, chief.id); i++) await sleep(20);

    const term = terminals.find((t) => t.scope.requestId === 'req_do_1');
    assert.equal(term?.out?.receipt?.stage, 'accepted');
    const runs = store.taskRuns.listAll().taskRuns;
    assert.equal(runs.length, 1);
    assert.ok(runs[0].attempts.length >= 1, 'taskHost 必须真正派发过一次受管执行');
    assert.equal(prompts.length, 2);
  } finally {
    taskHost.dispose();
    runner.disposeAll();
    store.dispose();
  }
});

await test('4. ★ 全双工三路与受管 TaskRun 协同：side_reply / amend(直通 steer) / abort_replace(取消 TaskRun)', async () => {
  const { store, receipts, runner, terminals } = makeIsolatedHarness({ taskIntake: true });
  const taskHost = createTaskHost({ store, runner });
  try {
    const chief = store.mainBot();
    const dm = store.ensureDm(chief.id);
    const workStarted = deferred();
    const workGate = deferred();
    const replacementDone = deferred();
    const steeredTexts = [];
    let listener;
    let promptSeq = 0;

    runner.__buildSession = async (_r, _b, opts = {}) => {
      if (opts.talkLane) {
        let talkListener;
        return {
          bot: chief,
          configurationCurrent: () => true,
          session: {
            model,
            subscribe(fn) { talkListener = fn; return () => {}; },
            dispose() {},
            async abort() {},
            async prompt() {
              talkListener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '正在执行受管任务，后台稳步推进中。' }] } });
            },
          },
        };
      }
      return {
        bot: chief,
        configurationCurrent: () => true,
        session: {
          model,
          subscribe(fn) { listener = fn; return () => {}; },
          dispose() {},
          async abort() { workGate.resolve(); },
          async steer(text) { steeredTexts.push(text); },
          async prompt() {
            promptSeq++;
            if (promptSeq === 1) {
              workStarted.resolve();
              await workGate.promise;
              listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '已中断旧任务' }] } });
            } else {
              listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '已改做新任务！' }] } });
              replacementDone.resolve();
            }
          },
        },
      };
    };

    // 先起一个受管 TaskRun（直接走 acceptRequest + taskHost 调度并卡在执行中）
    const intakeTools = buildIntakeTools({
      runner, store, roomId: dm.id, botId: chief.id, receipts,
      requestScopeOf: () => runner.currentRequestScope(dm.id, chief.id),
    });
    const acceptTool = intakeTools.find((t) => t.name === 'accept_task');
    const sFirst = openRequest({ receipts, taskRuns: store.taskRuns, requesterId: 'u1', requestId: 'req_fd_task', roomId: dm.id, text: '先跑长任务' });
    // 手动创建受管 TaskRun 并在第一轮直接让 taskHost.runtime 调度它
    let admittedId = null;
    await runner.withRequestEnvelope({ scope: sFirst.scope }, dm.id, chief.id, async () => {
      const res = await acceptTool.execute('tc_fd', {
        kind: 'accept_task',
        goal: {
          requirement: '执行长任务',
          verification: [{ id: 'v1', kind: 'artifact', description: '产物', required: true }],
        },
        routing: { type: 'direct' },
      });
      admittedId = res.details.taskRunId;
    });
    await workStarted.promise;

    // 确认此时主控正在跑该受管 TaskRun（managedContext 已绑定）
    const liveEntry = runner.sessions.get(`${dm.id}:${chief.id}`);
    assert.equal(liveEntry?.managedContext?.taskRunId, admittedId);

    // (a) 忙碌期发 side_reply（带 requestId）→ 旁路秒答且关闭回执
    const sSide = openRequest({ receipts, taskRuns: store.taskRuns, requesterId: 'u1', requestId: 'req_fd_side', roomId: dm.id, text: '进展如何？' });
    const rSide = await runner.send(dm.id, '进展如何？', { duplexMode: 'side_reply', request: { scope: sSide.scope } });
    assert.equal(rSide.duplex, 'side_reply');
    for (let i = 0; i < 40 && !terminals.some((t) => t.scope.requestId === 'req_fd_side'); i++) await sleep(20);
    assert.equal(terminals.find((t) => t.scope.requestId === 'req_fd_side')?.out?.receipt?.stage, 'answered');

    // (b) 忙碌期发 amend（带 requestId）→ 绝不进 requestQueues，直通 session.steer() 并按 answer 关回执
    const sAmend = openRequest({ receipts, taskRuns: store.taskRuns, requesterId: 'u1', requestId: 'req_fd_amend', roomId: dm.id, text: '顺便过滤空值' });
    const rAmend = await runner.send(dm.id, '顺便过滤空值', { duplexMode: 'amend', request: { scope: sAmend.scope } });
    assert.notEqual(rAmend.queued, true, '全双工下 amend 绝不能被 requestQueues 拦截排队');
    assert.equal(steeredTexts.length, 1);
    assert.match(steeredTexts[0], /顺便过滤空值/);
    assert.equal(terminals.find((t) => t.scope.requestId === 'req_fd_amend')?.out?.receipt?.stage, 'answered');

    // (c) 忙碌期发 abort_replace（带 requestId）→ 必须取消在途受管 TaskRun 并开启新轮
    const sReplace = openRequest({ receipts, taskRuns: store.taskRuns, requesterId: 'u1', requestId: 'req_fd_rep', roomId: dm.id, text: '别做那个了，改做新任务' });
    const rReplace = await runner.send(dm.id, '别做那个了，改做新任务', { duplexMode: 'abort_replace', request: { scope: sReplace.scope } });
    assert.equal(rReplace.duplex, 'abort_replace');

    await Promise.race([
      replacementDone.promise,
      sleep(3000).then(() => { throw new Error('等待替换轮完成超时'); }),
    ]);
    for (let i = 0; i < 60 && !terminals.some((t) => t.scope.requestId === 'req_fd_rep'); i++) await sleep(20);

    const oldRun = store.taskRuns.read(admittedId).taskRun;
    assert.equal(oldRun.state, 'cancelled', 'abort_replace 必须把在途受管 TaskRun 取消，不能继续重试');
    assert.equal(terminals.find((t) => t.scope.requestId === 'req_fd_rep')?.out?.receipt?.stage, 'answered');
  } finally {
    taskHost.dispose();
    runner.disposeAll();
    store.dispose();
  }
});

await test('5. ★ createOrbisRuntime 默认轻量关闭 taskIntake，显式 taskIntake: true 才装配 taskRuntime', async () => {
  const sdkLightDir = path.join(root, 'sdk-light');
  const sdkHeavyDir = path.join(root, 'sdk-heavy');
  const rtLight = await createOrbisRuntime({
    dataDir: sdkLightDir,
    workspace: wsDir,
    modelRuntimeFactory: fakeModelRuntimeFactory,
  });
  const rtHeavy = await createOrbisRuntime({
    dataDir: sdkHeavyDir,
    workspace: wsDir,
    modelRuntimeFactory: fakeModelRuntimeFactory,
    taskIntake: true,
  });
  try {
    assert.equal(rtLight.runner.taskIntakeEnabled, false, 'SDK 轻量模式默认不启用接单作用域');
    assert.equal(rtLight.runner.taskRuntime ?? null, null);

    rtLight.runner.__buildSession = async () => {
      let fn;
      return {
        bot: rtLight.store.mainBot(),
        configurationCurrent: () => true,
        session: {
          model,
          subscribe(cb) { fn = cb; return () => {}; },
          dispose() {},
          async abort() {},
          async prompt() {
            fn({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SDK ok' }] } });
          },
        },
      };
    };
    const res = await rtLight.askMain('检查结构');
    assert.equal(res.replyText, 'SDK ok');

    assert.equal(rtHeavy.runner.taskIntakeEnabled, true);
    assert.ok(rtHeavy.runner.taskRuntime, 'taskIntake=true 时 SDK 应装配好 taskRuntime');
  } finally {
    await rtLight.dispose();
    await rtHeavy.dispose();
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`\ntask-intake-e2e: ${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
