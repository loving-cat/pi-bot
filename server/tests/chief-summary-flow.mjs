/**
 * 主控总汇总 Stage 2：硬防循环护栏 + 汇总轮执行薄层。
 *   node tests/chief-summary-flow.mjs
 *
 * 规格：`docs/SPEC-CHIEF-SUMMARY.md` §3.3 / §5 Stage 2。
 *
 * 这一层最危险的两件事：
 *   1. **汇总轮自己再派活** → 无限套娃。所以三个入口工具在 `summaryTurn` 时硬拦，
 *      且拦下来的话必须能指导模型"下一步该干什么"（只说不允许等于让它乱猜）。
 *   2. **发送失败卡在 `sending`** → 幽灵态：用户看不到浮窗，也永远等不到结果。
 *      失败必须退回 `ready_blocked`，让用户还能重试或忽略。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-chief-flow-'));
process.env.ORBIS_HOME = root;
process.env.ORBIS_WORKSPACE = path.join(root, 'w');
process.env.ORBIS_PROBE = '0';
process.env.ORBIS_LESSON_REFLECT = '0';
fs.mkdirSync(process.env.ORBIS_HOME, { recursive: true });

import {
  SUMMARY_TURN_BLOCKED_TOOLS,
  SUMMARY_TURN_BLOCK_MESSAGE,
  isToolBlockedInSummaryTurn,
  markSummarySent,
  normalizeSummaryBatch,
} from '../src/chief-summary.js';
import { buildChiefSummaryPrompt, createChiefSummaryRunner } from '../src/runner/chief-summary-runner.js';

const { createStore } = await import('../src/store.js');
const { createBus } = await import('../src/bus.js');
const { createConfig } = await import('../src/config.js');
const { PiRunner } = await import('../src/pi-runner.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err?.stack || err}`);
    fail++;
  }
}

function makeStore(tag) {
  const dir = path.join(root, tag);
  fs.mkdirSync(dir, { recursive: true });
  const config = createConfig({
    dataDir: dir,
    workspace: path.join(dir, 'w'),
    ensureDirs: true,
    serverBoot: false,
    autoProbe: false,
    lessonReflect: false,
  });
  return createStore({ config, bus: createBus(), dataDir: dir, secretsKey: null });
}

const mainId = (store) => store.mainBot().id;
const mainDm = (store) => store.ensureDm(mainId(store)).id;

/** 造一个 ready_blocked 的批次（撞忙落下的那种） */
function blockedBatch(store, { id = 'sum_1', title = '重构行情抓取并发调度' } = {}) {
  const roomId = mainDm(store);
  const r = store.putChiefSummary({
    id,
    originTurnKey: 'msg:m1',
    originRoomId: roomId,
    taskTitle: title,
    dispatchOpen: false,
    state: 'ready_blocked',
    targets: [
      {
        key: 'group:room_dev:d1',
        departmentId: 'room_dev',
        departmentName: '研发组',
        status: 'done',
        leadSummary: '抓取并发改成队列，QPS 提升 3 倍',
        artifacts: ['server/src/fetch-queue.js'],
        sourceMsgId: 'msg_dev_done',
      },
      {
        key: 'group:room_qa:d2',
        departmentId: 'room_qa',
        departmentName: '测试组',
        status: 'failed',
        error: '额度用尽',
      },
    ],
  });
  return r.batch;
}

// ---------------------------------------------------------------------------
// 1. 硬防循环护栏
// ---------------------------------------------------------------------------
await test('汇总轮里三个入口工具被硬拦，其它工具不受影响', () => {
  assert.deepEqual([...SUMMARY_TURN_BLOCKED_TOOLS], [
    'dispatch_to_department',
    'create_department',
    'accept_task',
  ]);
  for (const tool of SUMMARY_TURN_BLOCKED_TOOLS) {
    assert.equal(isToolBlockedInSummaryTurn(tool, { summaryTurn: true }), true, `${tool} 必须被拦`);
    assert.equal(isToolBlockedInSummaryTurn(tool, { summaryTurn: false }), false, '普通轮不该拦');
  }
  assert.equal(isToolBlockedInSummaryTurn('send_message', { summaryTurn: true }), false);
  assert.equal(isToolBlockedInSummaryTurn('dispatch_to_department', {}), false, '缺省不是汇总轮');
});

await test('拦截语要能指导下一步，不能只说"不行"', () => {
  assert.match(SUMMARY_TURN_BLOCK_MESSAGE, /汇总交卷轮/);
  assert.match(SUMMARY_TURN_BLOCK_MESSAGE, /汇报/);
  assert.match(SUMMARY_TURN_BLOCK_MESSAGE, /返工/);
  assert.match(SUMMARY_TURN_BLOCK_MESSAGE, /禁止/);
});

await test('PiRunner.isSummaryTurn 读的是这一轮 entry 上的标记', () => {
  const store = makeStore('runner-flag');
  const runner = new PiRunner();
  runner.model = { provider: 'fixture', id: 'fixture' };
  runner.modelRuntime = { completeSimple: () => assert.fail('不许调模型') };
  runner.memoryAutoDisabled = true;
  const roomId = mainDm(store);
  const bid = mainId(store);
  assert.equal(runner.isSummaryTurn(roomId, bid), false, '没有 entry 就是 false');

  runner.sessions.set(`${roomId}:${bid}`, { summaryTurn: true });
  assert.equal(runner.isSummaryTurn(roomId, bid), true);

  runner.sessions.set(`${roomId}:${bid}`, { summaryTurn: false });
  assert.equal(runner.isSummaryTurn(roomId, bid), false, '轮次结束必须清掉，别污染下一轮');
});

// ---------------------------------------------------------------------------
// 2. 汇总提示词
// ---------------------------------------------------------------------------
await test('提示词带部门结论 / 状态 / 产物，并明确"别再派活"', () => {
  const store = makeStore('prompt');
  const batch = blockedBatch(store);
  const prompt = buildChiefSummaryPrompt(batch);

  assert.match(prompt, /主控汇总轮/);
  assert.match(prompt, /重构行情抓取并发调度/);
  assert.match(prompt, /研发组 —— 已完成/);
  assert.match(prompt, /队列，QPS 提升 3 倍/);
  assert.match(prompt, /server\/src\/fetch-queue\.js/);
  assert.match(prompt, /测试组 —— 受阻\/失败（额度用尽）/, '失败要如实标出来');
  assert.match(prompt, /不要再建组、再派活或接新任务/);
});

// ---------------------------------------------------------------------------
// 3. 汇总轮执行：成功 / 失败 / 异常
// ---------------------------------------------------------------------------
function makeFakeRunner(behavior) {
  const calls = [];
  return {
    calls,
    isBusy: () => false,
    async runBotOnce(opts) {
      calls.push(opts);
      return behavior(opts);
    },
  };
}

await test('★ 发送成功：唤醒主控（summaryTurn=true + meta.via），批次进 sent', async () => {
  const store = makeStore('send-ok');
  const batch = blockedBatch(store);
  // 先让用户点「是」
  store.resolveChiefSummary(batch.id, 'send', { mainBusy: false });
  assert.equal(store.chiefSummary(batch.id).state, 'sending');

  const runner = makeFakeRunner(() => ({ ok: true, messageId: 'msg_summary_1', text: '汇总正文' }));
  const ctl = createChiefSummaryRunner({ runner, store });
  const out = await ctl.summarize(batch.id);
  assert.equal(out.ok, true);

  const call = runner.calls[0];
  assert.equal(call.summaryTurn, true, '必须贯穿 summaryTurn，否则护栏失效');
  assert.equal(call.meta.via, 'chief_summary');
  assert.equal(call.meta.batchId, batch.id);
  assert.ok(Array.isArray(call.meta.refs), 'refs 要带回去给界面直达部门群');

  const after = store.chiefSummary(batch.id);
  assert.equal(after.state, 'sent');
  assert.equal(after.summaryMessageId, 'msg_summary_1');
});

await test('★ 发送失败（429/超时）：退回 ready_blocked，不卡死在 sending', async () => {
  const store = makeStore('send-fail');
  const batch = blockedBatch(store);
  store.resolveChiefSummary(batch.id, 'send', { mainBusy: false });

  const runner = makeFakeRunner(() => ({ ok: false, error: '429 too many requests' }));
  const ctl = createChiefSummaryRunner({ runner, store });
  const out = await ctl.summarize(batch.id);
  assert.equal(out.ok, false);

  const after = store.chiefSummary(batch.id);
  assert.equal(after.state, 'ready_blocked', '用户还要能再点「是」或「忽略」');
  assert.equal(after.lastError, '429 too many requests');
});

await test('发送抛异常：同样退回 ready_blocked（异常不许把批次挂住）', async () => {
  const store = makeStore('send-throw');
  const batch = blockedBatch(store);
  store.resolveChiefSummary(batch.id, 'send', { mainBusy: false });

  const runner = makeFakeRunner(() => {
    throw new Error('boom');
  });
  const ctl = createChiefSummaryRunner({ runner, store });
  const out = await ctl.summarize(batch.id);
  assert.equal(out.ok, false);
  const after = store.chiefSummary(batch.id);
  assert.equal(after.state, 'ready_blocked');
  assert.match(after.lastError, /boom/);
});

await test('非 sending 状态的批次不会被发送（幂等保护）', async () => {
  const store = makeStore('send-guard');
  const batch = blockedBatch(store); // ready_blocked，用户还没点「是」
  const runner = makeFakeRunner(() => ({ ok: true, messageId: 'm' }));
  const ctl = createChiefSummaryRunner({ runner, store });
  const out = await ctl.summarize(batch.id);
  assert.equal(out.skipped, 'state:ready_blocked');
  assert.equal(runner.calls.length, 0, '没点「是」就绝不调模型（零 token）');
});

await test('已 sent 的批次再 summarize 不会重复发', async () => {
  const store = makeStore('send-sent');
  const batch = blockedBatch(store);
  store.resolveChiefSummary(batch.id, 'send', { mainBusy: false });
  const sent = markSummarySent(store.chiefSummary(batch.id), { messageId: 'm1', now: Date.now() });
  store.putChiefSummary(sent);

  const runner = makeFakeRunner(() => ({ ok: true, messageId: 'm2' }));
  const ctl = createChiefSummaryRunner({ runner, store });
  const out = await ctl.summarize(batch.id);
  assert.equal(out.skipped, 'state:sent');
  assert.equal(runner.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 4. drain：串行排空，失败即停
// ---------------------------------------------------------------------------
await test('★ drain：两条排队按就绪顺序依次发送', async () => {
  const store = makeStore('drain-two');
  const a = blockedBatch(store, { id: 'sum_a', title: '任务 A' });
  const b = blockedBatch(store, { id: 'sum_b', title: '任务 B' });
  for (const batch of [a, b]) {
    store.resolveChiefSummary(batch.id, 'send', { mainBusy: true }); // 撞忙 → queued_send
    assert.equal(store.chiefSummary(batch.id).state, 'queued_send');
  }

  const order = [];
  const runner = makeFakeRunner((opts) => {
    order.push(opts.meta.batchId);
    return { ok: true, messageId: `msg_${opts.meta.batchId}` };
  });
  const ctl = createChiefSummaryRunner({ runner, store });
  const out = await ctl.drain();
  assert.equal(out.sent, 2);
  assert.equal(order.length, 2);
  for (const id of ['sum_a', 'sum_b']) {
    assert.equal(store.chiefSummary(id).state, 'sent');
  }
});

await test('drain：主控正忙时一条都不发（绝不打断对话）', async () => {
  const store = makeStore('drain-busy');
  const batch = blockedBatch(store);
  store.resolveChiefSummary(batch.id, 'send', { mainBusy: true });

  const runner = { calls: [], isBusy: () => true, runBotOnce: async (o) => { runner.calls.push(o); return { ok: true }; } };
  const ctl = createChiefSummaryRunner({ runner, store });
  const out = await ctl.drain();
  assert.equal(out.sent, 0);
  assert.equal(runner.calls.length, 0);
  assert.equal(store.chiefSummary(batch.id).state, 'queued_send', '还在排队，等下一轮');
});

await test('drain：第一条失败就停（不连环烧钱）', async () => {
  const store = makeStore('drain-stop');
  const a = blockedBatch(store, { id: 'sum_x' });
  const b = blockedBatch(store, { id: 'sum_y' });
  for (const batch of [a, b]) store.resolveChiefSummary(batch.id, 'send', { mainBusy: true });

  let n = 0;
  const runner = makeFakeRunner(() => {
    n += 1;
    return { ok: false, error: '额度用尽' };
  });
  const ctl = createChiefSummaryRunner({ runner, store });
  const out = await ctl.drain();
  assert.equal(out.sent, 0);
  assert.equal(n, 1, '失败一次就该停，剩下的留给用户处理');
  assert.equal(store.chiefSummary('sum_x').state, 'ready_blocked');
  assert.equal(store.chiefSummary('sum_y').state, 'queued_send', '没被牵连');
});

// ---------------------------------------------------------------------------
// 5. 封口：发起轮结束后才就绪
// ---------------------------------------------------------------------------
await test('store：sealChiefSummariesForTurn 只封这一轮的批次', () => {
  const store = makeStore('seal');
  const roomId = mainDm(store);
  const mine = store.putChiefSummary({
    id: 'sum_mine',
    originTurnKey: 'msg:turn1',
    originRoomId: roomId,
    dispatchOpen: true,
    targets: [{ departmentId: 'room_dev', departmentName: '研发组', status: 'done', leadSummary: '好了' }],
  }).batch;
  assert.equal(mine.state, 'collecting', '派活轮还开着');

  const other = store.putChiefSummary({
    id: 'sum_other',
    originTurnKey: 'msg:turn2',
    originRoomId: roomId,
    dispatchOpen: true,
    targets: [{ departmentId: 'room_qa', status: 'running' }],
  }).batch;
  assert.equal(other.state, 'collecting');

  const sealed = store.sealChiefSummariesForTurn('msg:turn1', { mainBusy: false });
  assert.equal(sealed.length, 1);
  assert.equal(store.chiefSummary('sum_mine').state, 'sending', '就绪且主控空闲 → 准备发');
  assert.equal(store.chiefSummary('sum_other').state, 'collecting', '别的轮次不受影响');
});

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 上可能还有句柄
}

console.log(`\nchief-summary-flow: ${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
