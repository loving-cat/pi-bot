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
import {
  buildChiefSummaryPrompt,
  createChiefSummaryRunner,
  isMainChatBusy,
} from '../src/runner/chief-summary-runner.js';
import { createBotService } from '../src/services/bot-service.js';

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
  // Stage 2b：回调打标 + ≤3 句限长 + 不复述长明细
  assert.match(prompt, /内部交付回调唤醒，不是用户的新提问/, '必须先说清这是回调，不是新问题');
  assert.match(prompt, /不超过 3 句/, '核心结论限长');
  assert.match(prompt, /绝不复述各部门已经写在群里的长明细/, '过程细节交给 refs');
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

// ---------------------------------------------------------------------------
// 6. Stage 2b：登记 / 回传 / 封口
// ---------------------------------------------------------------------------
await test('★ 同一轮的多次派活落在同一个批次里（同轮聚合键）', () => {
  const store = makeStore('register');
  const roomId = mainDm(store);
  const a = store.ensureChiefSummaryBatch({
    turnKey: 'msg:m1',
    originRoomId: roomId,
    taskTitle: '重构行情抓取并发调度',
    target: { key: 'group:room_a', departmentId: 'room_a', departmentName: '研发组', status: 'running' },
  });
  assert.ok(a.batch, a.error);
  assert.equal(a.created, true);

  const b = store.ensureChiefSummaryBatch({
    turnKey: 'msg:m1',
    originRoomId: roomId,
    taskTitle: '重构行情抓取并发调度',
    target: { key: 'group:room_b', departmentId: 'room_b', departmentName: '测试组', status: 'running' },
  });
  assert.equal(b.created, false, '同一轮必须复用批次');
  assert.equal(b.batch.id, a.batch.id);
  assert.equal(b.batch.targets.length, 2, '两个部门都在这一批里');

  // 另一轮 → 新批次
  const c = store.ensureChiefSummaryBatch({
    turnKey: 'msg:m2',
    originRoomId: roomId,
    target: { key: 'group:room_c', departmentId: 'room_c', status: 'running' },
  });
  assert.notEqual(c.batch.id, a.batch.id);
});

await test('★ 回传 + 封口：两个部门都回填后批次就绪；撞忙则 ready_blocked', () => {
  const store = makeStore('report');
  const roomId = mainDm(store);
  const reg = store.ensureChiefSummaryBatch({
    turnKey: 'msg:turn1',
    originRoomId: roomId,
    taskTitle: '任务',
    target: { key: 'group:a', departmentId: 'room_a', departmentName: '研发组', status: 'running' },
  });
  const batchId = reg.batch.id;
  store.ensureChiefSummaryBatch({
    turnKey: 'msg:turn1',
    originRoomId: roomId,
    target: { key: 'group:b', departmentId: 'room_b', departmentName: '测试组', status: 'running' },
  });

  // 部门 A 交卷（此时派活轮还没封口 → 不该就绪）
  store.noteChiefSummaryTarget(batchId, {
    key: 'group:a',
    departmentId: 'room_a',
    departmentName: '研发组',
    status: 'done',
    leadSummary: '并发改成队列',
    sourceMsgId: 'msg_a_done',
  });
  assert.equal(store.chiefSummary(batchId).state, 'collecting', '还没封口');

  // 部门 B 失败 → 封口后立刻就该绪（不等别的部门）
  store.noteChiefSummaryTarget(batchId, {
    key: 'group:b',
    departmentId: 'room_b',
    departmentName: '测试组',
    status: 'failed',
    error: '额度用尽',
  });
  store.sealChiefSummariesForTurn('msg:turn1', { mainBusy: true });
  const after = store.chiefSummary(batchId);
  assert.equal(after.dispatchOpen, false);
  assert.equal(after.state, 'ready_blocked', '主控忙 → 浮窗等用户三选一');
  assert.equal(after.targets.find((t) => t.key === 'group:a').leadSummary, '并发改成队列');
});

await test('★ 直接 summarize 成功后会把期间新排队的批次也排空', async () => {
  const store = makeStore('post-drain');
  const a = blockedBatch(store, { id: 'sum_first' });
  const b = blockedBatch(store, { id: 'sum_second' });
  // a 直接进入 sending（用户点了「是」），b 排队
  store.resolveChiefSummary(a.id, 'send', { mainBusy: false });
  store.resolveChiefSummary(b.id, 'send', { mainBusy: true });
  assert.equal(store.chiefSummary(b.id).state, 'queued_send');

  const sent = [];
  const runner = makeFakeRunner((opts) => {
    sent.push(opts.meta.batchId);
    return { ok: true, messageId: `m_${opts.meta.batchId}` };
  });
  const ctl = createChiefSummaryRunner({ runner, store });
  await ctl.summarize(a.id);
  // summarize 内部用 setTimeout 触发排空，等一拍
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, ['sum_first', 'sum_second'], '直接发送后也要把排队的那条带走');
  assert.equal(store.chiefSummary(b.id).state, 'sent');
});

await test('忙态：mergeQueue 有待合并消息也算忙（不许插汇总打断用户）', () => {
  const busyOnlyMerge = { isBusy: () => false, mergeQueue: { hasPending: () => true } };
  const busyOnlyRunner = { isBusy: () => true, mergeQueue: { hasPending: () => false } };
  const idle = { isBusy: () => false, mergeQueue: { hasPending: () => false } };
  assert.equal(isMainChatBusy(busyOnlyMerge, 'r', 'b'), true);
  assert.equal(isMainChatBusy(busyOnlyRunner, 'r', 'b'), true);
  assert.equal(isMainChatBusy(idle, 'r', 'b'), false);
  assert.equal(isMainChatBusy({ isBusy: () => { throw new Error('boom'); } }, 'r', 'b'), true, '判忙失败就当忙');
});

await test('★ 在跑成员禁止删除（避免孤儿任务 / 汇总永远等不到）', () => {
  const store = makeStore('bot-guard');
  const busy = store.createBot({ name: '在跑成员' });
  const idle = store.createBot({ name: '闲着的成员' });
  const fakeRunner = { isBusy: (roomId, botId) => botId === busy.id };
  const service = createBotService({ store, runner: fakeRunner });

  const blocked = service.bots.remove(busy.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.match(blocked.error, /正在|执行任务/);

  const ok = service.bots.remove(idle.id);
  assert.equal(ok.ok, true, ok.error);
});

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 上可能还有句柄
}

console.log(`\nchief-summary-flow: ${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
