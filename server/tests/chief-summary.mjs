/**
 * 主控总汇总（Stage 1：纯逻辑 + 持久化）回归测试。
 *   node tests/chief-summary.mjs
 *
 * 规格：`docs/SPEC-CHIEF-SUMMARY.md` §2 / §5 Stage 1。
 *
 * 盯的是这几条最容易写歪的规则：
 *   · **发起轮没封口就不许就绪** —— 否则部门 A 回得比派活快，汇总会漏掉还没派出去的部门；
 *   · **失败也是终态** —— 一个部门挂了不该让其余部门的成果无限期等下去；
 *   · **撞忙只阻塞、不调模型** —— 批次停在 `ready_blocked`，等用户三选一；
 *   · **三选一幂等** —— 已终态再点不变，用户点两次不会发两条汇总；
 *   · **重启不丢** —— 账本落在 `state.chiefSummaries`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHIEF_SUMMARY_LIMITS,
  SUMMARY_STATES,
  advanceSummary,
  isBatchReady,
  isPendingState,
  isTerminalState,
  markSummarySent,
  markSummarySendFailed,
  normalizeSummaryBatch,
  normalizeSummaryBatchList,
  resolveSummary,
  sealDispatch,
  selectSummaryRetention,
  summarizeProgress,
  turnKeyFor,
  upsertSummaryTarget,
} from '../src/chief-summary.js';

let pass = 0;
let fail = 0;
// async：store 那几段是 async 的，用同步 helper 会把 rejection 漏到测试结束之后
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

function batch(overrides = {}) {
  return normalizeSummaryBatch(
    {
      id: 'sum_1',
      originTurnKey: 'msg:m1',
      originRoomId: 'dm_main',
      taskTitle: '重构行情抓取并发调度',
      targets: [
        { departmentId: 'room_dev', departmentName: '研发组', refId: 'disp_1', status: 'running' },
      ],
      createdAt: 1000,
      ...overrides,
    },
    1000,
  );
}

const done = (key) => ({ key, departmentId: 'room_dev', departmentName: '研发组', status: 'done', leadSummary: '做完了' });
const failed = (key) => ({ key, departmentId: 'room_qa', departmentName: '测试组', status: 'failed', error: '额度用尽' });

// ---------------------------------------------------------------------------
// 1. 就绪判定
// ---------------------------------------------------------------------------
await test('单部门跑完 + 发起轮封口 → 就绪（空闲时直接进 sending）', () => {
  const b = upsertSummaryTarget(batch(), done('group:room_dev:disp_1'));
  assert.equal(isBatchReady(b), false, '发起轮还开着，先不就绪');
  const sealed = sealDispatch(b, { mainBusy: false, now: 2000 });
  assert.equal(isBatchReady(sealed), true);
  assert.equal(sealed.state, 'sending');
  assert.equal(sealed.readyAt, 2000);
});

await test('多部门必须等齐才就绪', () => {
  let b = batch({
    targets: [
      { departmentId: 'room_dev', departmentName: '研发组', refId: 'd1' },
      { departmentId: 'room_qa', departmentName: '测试组', refId: 'd2' },
    ],
  });
  b = upsertSummaryTarget(b, done('group:room_dev:d1'));
  b = sealDispatch(b, { now: 2000 });
  assert.equal(isBatchReady(b), false, '还有一个部门在跑');
  assert.equal(b.state, 'collecting');

  b = upsertSummaryTarget(b, done('group:room_qa:d2'));
  assert.equal(isBatchReady(b), true);
  assert.equal(advanceSummary(b, { mainBusy: false, now: 3000 }).state, 'sending');
});

await test('★ 单部门失败不傻等：失败也算终态，立刻就绪', () => {
  let b = batch({
    targets: [
      { departmentId: 'room_dev', departmentName: '研发组', refId: 'd1' },
      { departmentId: 'room_qa', departmentName: '测试组', refId: 'd2' },
    ],
  });
  b = sealDispatch(b, { now: 2000 });
  b = upsertSummaryTarget(b, done('group:room_dev:d1'));
  assert.equal(isBatchReady(b), false);
  b = upsertSummaryTarget(b, failed('group:room_qa:d2'));
  assert.equal(isBatchReady(b), true, '一个部门挂了不该让别的部门陪着等');

  const progress = summarizeProgress(b);
  assert.equal(progress.done, 1);
  assert.equal(progress.failed, 1);
  assert.deepEqual(progress.failedNames, ['测试组']);
});

await test('★ dispatchOpen=true 时部门秒回先挂着，封口后才就绪', () => {
  let b = batch();
  b = upsertSummaryTarget(b, done('group:room_dev:disp_1'));
  assert.equal(isBatchReady(b), false, '派活轮还没结束');
  assert.equal(b.state, 'collecting');
  b = sealDispatch(b, { mainBusy: false, now: 2000 });
  assert.equal(b.state, 'sending', '封口那一刻就该就绪');
});

await test('没有目标的批次不合法（normalize 直接丢）', () => {
  assert.equal(normalizeSummaryBatch({ id: 'sum_x', targets: [] }), null);
  assert.equal(normalizeSummaryBatch({ targets: [{ departmentId: 'a' }] }), null, '缺 id 也丢');
});

await test('同一部门的回报按 key 覆盖，不会重复占一行', () => {
  let b = batch();
  b = upsertSummaryTarget(b, done('group:room_dev:disp_1'));
  b = upsertSummaryTarget(b, { ...done('group:room_dev:disp_1'), leadSummary: '第二版' });
  assert.equal(b.targets.length, 1);
  assert.equal(b.targets[0].leadSummary, '第二版');
});

// ---------------------------------------------------------------------------
// 2. 撞忙与三选一
// ---------------------------------------------------------------------------
await test('★ 撞忙 → ready_blocked（懒汇总，不调模型）', () => {
  const b = sealDispatch(upsertSummaryTarget(batch(), done('group:room_dev:disp_1')), {
    mainBusy: true,
    now: 2000,
  });
  assert.equal(b.state, 'ready_blocked');
  assert.equal(isPendingState(b.state), true, '界面要显示浮窗');
});

await test('send：主控空闲 → sending；主控仍忙 → queued_send（不打断当前对话）', () => {
  const ready = sealDispatch(upsertSummaryTarget(batch(), done('group:room_dev:disp_1')), {
    mainBusy: true,
    now: 2000,
  });
  assert.equal(resolveSummary(ready, 'send', { mainBusy: false, now: 3000 }).state, 'sending');
  assert.equal(resolveSummary(ready, 'send', { mainBusy: true, now: 3000 }).state, 'queued_send');
});

await test('defer → deferred；ignore → ignored（零模型调用）', () => {
  // defer 只对「撞忙等用户决定」的批次有意义（sending 时再点 defer 会被忽略，见 C2）
  const blocked = sealDispatch(upsertSummaryTarget(batch(), done('group:room_dev:disp_1')), {
    mainBusy: true,
    now: 2000,
  });
  assert.equal(blocked.state, 'ready_blocked');
  assert.equal(resolveSummary(blocked, 'defer', { now: 3000 }).state, 'deferred');
  const ignored = resolveSummary(blocked, 'ignore', { now: 3000 });
  assert.equal(ignored.state, 'ignored');
  assert.equal(ignored.resolvedAt, 3000);
});

await test('★【C2】已在发送 / 已排队时再点 send 必须原样返回（否则会发两条）', () => {
  const ready = sealDispatch(upsertSummaryTarget(batch(), done('group:room_dev:disp_1')), {
    mainBusy: false,
    now: 2000,
  });
  assert.equal(ready.state, 'sending');
  // 双端同点 / 用户双击：主控忙不忙都不许改状态，更不许返回新对象
  assert.equal(resolveSummary(ready, 'send', { mainBusy: false, now: 3000 }), ready);
  assert.equal(resolveSummary(ready, 'send', { mainBusy: true, now: 3000 }), ready, '不许从 sending 倒退回 queued_send');
  // 正在发送也不许被拉回「待看」
  assert.equal(resolveSummary(ready, 'defer', { now: 3000 }), ready);

  const queued = { ...ready, state: 'queued_send' };
  assert.equal(resolveSummary(queued, 'send', { mainBusy: true, now: 3000 }), queued, '不重复入队');
  assert.equal(resolveSummary(queued, 'defer', { now: 3000 }).state, 'deferred', '已排队的还可以改主意');
});

await test('★【C1】一个部门失败、另一个还在跑 → 立刻就地绪（不傻等）', () => {
  let b = batch({
    targets: [
      { departmentId: 'room_dev', departmentName: '研发组', refId: 'd1' },
      { departmentId: 'room_qa', departmentName: '测试组', refId: 'd2' },
    ],
  });
  b = sealDispatch(b, { now: 2000 });
  b = upsertSummaryTarget(b, failed('group:room_qa:d2'));
  assert.equal(b.targets[1].status, 'failed');
  assert.equal(b.targets[0].status, 'running');
  assert.equal(isBatchReady(b), true, 'A 失败不该被 B 的长跑拖住');
  assert.equal(advanceSummary(b, { mainBusy: false, now: 3000 }).state, 'sending');
});

await test('★【C2b】汇总轮失败可从 sending 退回 ready_blocked（不卡死幽灵态）', () => {
  const ready = sealDispatch(upsertSummaryTarget(batch(), done('group:room_dev:disp_1')), {
    mainBusy: false,
    now: 2000,
  });
  assert.equal(ready.state, 'sending');
  const failedSend = markSummarySendFailed(ready, { reason: '429', now: 3000 });
  assert.equal(failedSend.state, 'ready_blocked', '退回后用户还能再点「是」或「忽略」');
  assert.equal(failedSend.lastError, '429');
  // 已终态的不许被"复活"
  const sent = markSummarySent(ready, { messageId: 'm1', now: 4000 });
  assert.equal(markSummarySendFailed(sent, { reason: 'x', now: 5000 }), sent);
});

await test('★ 三选一幂等：已终态再点不变（用户点两次不会发两条）', () => {
  const sent = markSummarySent(
    resolveSummary(sealDispatch(upsertSummaryTarget(batch(), done('group:room_dev:disp_1')), { now: 2000 }), 'send', {
      mainBusy: false,
      now: 3000,
    }),
    { messageId: 'msg_sum_1', now: 4000 },
  );
  assert.equal(sent.state, 'sent');
  assert.equal(sent.summaryMessageId, 'msg_sum_1');
  for (const action of ['send', 'defer', 'ignore']) {
    assert.equal(resolveSummary(sent, action, { now: 5000 }).state, 'sent');
  }
});

await test('还没就绪时 defer / send 不生效（别让用户对半成品做决定）', () => {
  const b = batch(); // dispatchOpen 还开着
  assert.equal(resolveSummary(b, 'send', { mainBusy: false, now: 1 }).state, 'collecting');
  assert.equal(resolveSummary(b, 'defer', { mainBusy: false, now: 1 }).state, 'collecting');
  // ignore 任何时刻都允许（用户有权立刻放弃）
  assert.equal(resolveSummary(b, 'ignore', { now: 1 }).state, 'ignored');
});

await test('未知动作 / 未知状态一律不改', () => {
  const b = batch();
  assert.equal(resolveSummary(b, 'whatever', {}), b);
  const broken = { ...b, state: 'weird' };
  assert.equal(advanceSummary(broken, { mainBusy: false, now: 1 }).state, 'collecting', '未知状态回落到 collecting');
});

await test('deferred / queued_send 不会被自动推进改掉（用户的意思要保留）', () => {
  const ready = sealDispatch(upsertSummaryTarget(batch(), done('group:room_dev:disp_1')), { now: 2000 });
  for (const state of ['deferred', 'queued_send']) {
    const b = { ...ready, state };
    assert.equal(advanceSummary(b, { mainBusy: false, now: 3000 }).state, state);
    assert.equal(advanceSummary(b, { mainBusy: true, now: 3000 }).state, state);
  }
});

await test('★ 晚到刷新：已 sent 后部门再回报，只更新交付包不改状态', () => {
  const sent = { ...sealDispatch(upsertSummaryTarget(batch(), done('group:room_dev:disp_1')), { now: 2000 }), state: 'sent' };
  const late = upsertSummaryTarget(sent, {
    key: 'group:room_qa:d2',
    departmentId: 'room_qa',
    departmentName: '测试组',
    status: 'done',
    leadSummary: '晚到的结论',
  });
  assert.equal(late.state, 'sent');
  assert.equal(late.targets.length, 2);
  assert.equal(late.targets.find((t) => t.key === 'group:room_qa:d2').leadSummary, '晚到的结论');
});

// ---------------------------------------------------------------------------
// 3. 保留策略与规范化
// ---------------------------------------------------------------------------
await test('保留：已终态超过 7 天自动清，未终结的永远留', () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const list = normalizeSummaryBatchList(
    [
      { id: 'old_sent', state: 'sent', resolvedAt: now - 8 * 24 * 60 * 60 * 1000, targets: [{ departmentId: 'a' }] },
      { id: 'new_sent', state: 'sent', resolvedAt: now - 60_000, targets: [{ departmentId: 'b' }] },
      { id: 'blocked', state: 'ready_blocked', createdAt: now - 30 * 24 * 60 * 60 * 1000, targets: [{ departmentId: 'c' }] },
    ],
    now,
  );
  assert.deepEqual(list.map((b) => b.id).sort(), ['blocked', 'new_sent']);
});

await test('保留：超过上限先清终态，再清最老的', () => {
  const now = 1_000_000;
  const many = [];
  for (let i = 0; i < CHIEF_SUMMARY_LIMITS.total + 5; i++) {
    // `sum_0` 最老：resolvedAt / createdAt 都最小 → 应最先被清
    many.push({ id: `sum_${i}`, state: 'sent', resolvedAt: i, createdAt: i, targets: [{ departmentId: 'a' }] });
  }
  const kept = selectSummaryRetention(
    many.map((b) => normalizeSummaryBatch(b, now)).filter(Boolean),
    { now },
  );
  assert.equal(kept.length, CHIEF_SUMMARY_LIMITS.total);
  assert.equal(kept.some((b) => b.id === 'sum_0'), false, '最老的终态先丢');
});

await test('状态集合是封闭的：新增状态必须改这里', () => {
  assert.deepEqual([...SUMMARY_STATES], [
    'collecting', 'ready_blocked', 'deferred', 'queued_send', 'sending', 'sent', 'ignored',
  ]);
  assert.equal(isTerminalState('sent'), true);
  assert.equal(isTerminalState('ignored'), true);
  assert.equal(isTerminalState('sending'), false);
});

await test('turnKeyFor：同轮聚合键（liveMsgId 优先，其次根 taskRunId）', () => {
  assert.equal(turnKeyFor({ liveMsgId: 'm1' }), 'msg:m1');
  assert.equal(turnKeyFor({ taskRunId: 't1' }), 'task:t1');
  assert.equal(turnKeyFor({}), '');
});

// ---------------------------------------------------------------------------
// 4. 持久化（state.chiefSummaries）：重启重载不丢
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-chief-summary-'));
process.env.ORBIS_HOME = root;
process.env.ORBIS_WORKSPACE = path.join(root, 'w');
process.env.ORBIS_PROBE = '0';
process.env.ORBIS_LESSON_REFLECT = '0';
fs.mkdirSync(process.env.ORBIS_HOME, { recursive: true });

const { createStore } = await import('../src/store.js');
const { createBus } = await import('../src/bus.js');
const { createConfig } = await import('../src/config.js');

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
  const bus = createBus();
  const store = createStore({ config, bus, dataDir: dir, secretsKey: null });
  return { store, bus, dir };
}

await test('store：批次落盘，重启（新实例同目录）读回不丢', async () => {
  const { store, dir } = makeStore('persist');
  const b = batch({ id: 'sum_persist' });
  assert.ok(store.putChiefSummary(b).batch);
  store.saveNow();

  const config = createConfig({
    dataDir: dir,
    workspace: path.join(dir, 'w'),
    ensureDirs: true,
    serverBoot: false,
    autoProbe: false,
    lessonReflect: false,
  });
  const reloaded = createStore({ config, bus: createBus(), dataDir: dir, secretsKey: null });
  const found = reloaded.chiefSummaries().find((x) => x.id === 'sum_persist');
  assert.ok(found, '重启后必须还在');
  assert.equal(found.state, 'collecting');
  assert.equal(found.taskTitle, '重构行情抓取并发调度');
});

await test('★【C3】summaries.updated 只推"要用户处理 / 排队中"的，不推 collecting', async () => {
  const { store, bus } = makeStore('emit');
  const events = [];
  bus.on('event', (ev) => {
    if (ev?.t === 'summaries.updated') events.push(ev.items);
  });
  store.putChiefSummary(batch({ id: 'sum_collecting' }));
  assert.equal(events[0].length, 0, '还在派活的批次不该出现在界面上');

  // 直接塞一条 ready_blocked，确认它会被推出去
  store.putChiefSummary({ ...batch({ id: 'sum_blocked' }), state: 'ready_blocked', dispatchOpen: false });
  assert.equal(events[events.length - 1].length, 1);

  store.resolveChiefSummary('sum_blocked', 'ignore');
  assert.equal(events[events.length - 1].length, 0, '忽略之后不该再推它');
});

await test('store：三选一幂等（第二次点返回 unchanged，不再广播）', () => {
  const { store } = makeStore('idempotent');
  store.putChiefSummary(batch({ id: 'sum_b' }));
  const first = store.resolveChiefSummary('sum_b', 'ignore');
  assert.equal(first.batch.state, 'ignored');
  const second = store.resolveChiefSummary('sum_b', 'ignore');
  assert.equal(second.unchanged, true);
  assert.equal(second.batch.state, 'ignored');
});

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 上可能还有句柄
}

console.log(`\nchief-summary: ${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
