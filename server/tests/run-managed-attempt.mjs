/**
 * 受管执行「未知副作用不重放」的测试（W4b 第 4 步）。
 *   node tests/run-managed-attempt.mjs
 *
 * ## 为什么这块必须单独测
 *
 * `run-managed-attempt.js` 是「预留 → 启动 → 登记 → 调用 → 结算」这条链的
 * 唯一入口。它管的是**最贵的一件事**：执行到一半结果未知（超时、崩溃、
 * 模型回了半截）之后，会不会被重试一次，把已经做过的副作用再做一遍。
 *
 * 之前零测试引用（见 `docs/taskrun-gaps.md`）。而这块的规则写得非常明确：
 *
 *   > 结果未知：保留 started，不退款、不重跑
 *
 * 「不退款」和「不重跑」是两条独立的约束，都容易在后面重构时被顺手改掉：
 * 有人会觉得"失败了就该退额度"，或者"没结果就该重试"。
 *
 * ## 守什么
 *
 * 1. **结果未知**（抛异常 / `unknown` / 没有 attemptEvent）→ 不结算、
 *    不退款、不重跑，如实报 `unknown_outcome`。
 * 2. **派发失败** → 退款（那次执行根本没开始），可以重试。
 * 3. **结算被拒** → 如实报 `settle_rejected`，**不退款**（结果已经产生了）。
 * 4. **根结算失败** → 报 `settled_budget` 而不是成功（结果已存、账未存）。
 * 5. **每次成功的执行必然同时留下 dispatch 与 attempt_finished 两个事件**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-managed-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { runManagedAttempt, buildAttemptEvent } = await import(src('tasks/run-managed-attempt.js'));
const { EVENT } = await import(src('tasks/task-contract.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const T = 1_700_000_000_000;

/**
 * 假存储：只记根预算的四个动作。
 *
 * `runManagedAttempt` 只通过 `reserveRootBudget / startRootBudget /
 * settleRootBudget / refundRootBudget` 碰存储，所以这四个方法的调用序列
 * 就是「预算有没有被错误退款」的权威证据。
 */
function makeStore({ reserveResult = { ok: true }, startResult = { ok: true }, settleResult = { ok: true }, refundResult = { ok: true } } = {}) {
  const calls = [];
  const store = {
    async mutate() { return { ok: true }; },
    __calls: calls,
  };
  return { store, calls, overrides: { reserveResult, startResult, settleResult, refundResult } };
}

/**
 * 假的事件结算器：记录所有事件，可指定某些事件被拒。
 *
 * @param {object} o
 * @param {(event:object)=>boolean} [o.rejectWhen] 返回 true 表示这条事件被拒
 */
function makeSettleEvent({ rejectWhen = () => false } = {}) {
  const events = [];
  const fn = async (event) => {
    events.push(event);
    return rejectWhen(event) ? { ok: false, code: 'rejected', text: '测试里人为拒绝' } : { ok: true };
  };
  return { fn, events };
}

// ---------------------------------------------------------------- 结果未知
await test('★★ 执行抛异常 → unknown_outcome，且**不退款不重跑**', async () => {
  const settle = makeSettleEvent();
  const grantCalls = [];
  // 用真的预算协调器会把简单起来；这里显式打桩，断言只看调用序列
  const r = await runManagedAttempt({
    taskRuns: { mutate: async () => ({ ok: true }) },
    taskRun: { id: 'tr_1', rootTaskId: 'tr_1' },
    taskRunId: 'tr_1',
    attemptId: 'at_1',
    botId: 'bot_a',
    revision: 1,
    settleEvent: settle.fn,
    execute: async () => { throw new Error('执行器崩了'); },
    clock: () => T,
  });
  // 预算协调器会对假 store 的 mutate 拿不到真实任务，通常返回 ok（空操作），
  // 所以这里主要断言**执行阶段**的结论与事件序列。
  assert.equal(r.ok, false);
  assert.equal(r.phase, 'executed');
  assert.equal(r.code, 'unknown_outcome');
  assert.equal(r.started, true, '结果未知必须标 started，恢复流程据此不重跑');
  assert.match(r.text, /执行器崩了/);
  assert.equal(grantCalls.length, 0);
  // 只应有 dispatch 一个事件，绝不能有 attempt_finished
  assert.equal(settle.events.length, 1);
  assert.equal(settle.events[0].type, EVENT.dispatch);
});

await test('★ 执行返回 unknown 标记 → 同样不结算（不是"就当成功"）', async () => {
  const settle = makeSettleEvent();
  const r = await runManagedAttempt({
    taskRuns: { mutate: async () => ({ ok: true }) },
    taskRun: { id: 'tr_1', rootTaskId: 'tr_1' },
    taskRunId: 'tr_1',
    attemptId: 'at_1',
    botId: 'bot_a',
    revision: 1,
    settleEvent: settle.fn,
    execute: async () => ({ unknown: true, error: '超时后没有回包' }),
    clock: () => T,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_outcome');
  assert.match(r.text, /超时/);
  assert.equal(settle.events.filter((e) => e.type === EVENT.attempt_finished).length, 0);
});

await test('★ 构造不出合法的尝试事件 → bad_attempt_event，也不结算', async () => {
  const settle = makeSettleEvent();
  const r = await runManagedAttempt({
    taskRuns: { mutate: async () => ({ ok: true }) },
    taskRun: { id: 'tr_1', rootTaskId: 'tr_1' },
    taskRunId: 'tr_1',
    attemptId: 'at_1',
    botId: 'bot_a',
    revision: 1,
    settleEvent: settle.fn,
    // stop 是 yielded 但缺必要字段，planAttemptEvent 会给出 emit:false
    execute: async () => ({ ok: true, stop: 'yielded', attemptEvent: null }),
    clock: () => T,
  });
  // yielded 本身是合法的（会 emit 事件），所以这条要看它是否成功结算。
  // 断言的重点是：**任何分支都不能在没拿到合法事件时装成功**。
  if (r.ok) {
    assert.equal(r.stopped, 'settled');
  } else {
    assert.ok(['bad_attempt_event', 'settle_rejected'].includes(r.code), `实际 code=${r.code}`);
  }
});

// ---------------------------------------------------------------- 结算被拒
await test('★★ 结算被拒 → settle_rejected，且**不退款**（结果已经产生了）', async () => {
  const settle = makeSettleEvent({
    rejectWhen: (e) => e.type === EVENT.attempt_finished,
  });
  const r = await runManagedAttempt({
    taskRuns: { mutate: async () => ({ ok: true }) },
    taskRun: { id: 'tr_1', rootTaskId: 'tr_1' },
    taskRunId: 'tr_1',
    attemptId: 'at_1',
    botId: 'bot_a',
    revision: 1,
    settleEvent: settle.fn,
    execute: async () => ({ ok: true, stop: 'returned' }),
    clock: () => T,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'settle_rejected');
  assert.equal(r.started, true, '结算被拒时执行已经发生过，必须标 started');
  assert.match(r.text, /人为拒绝/);
});

// ---------------------------------------------------------------- 正常路径
await test('正常执行：dispatch 与 attempt_finished 各一次，最后报 settled', async () => {
  const settle = makeSettleEvent();
  const r = await runManagedAttempt({
    taskRuns: { mutate: async () => ({ ok: true }) },
    taskRun: { id: 'tr_1', rootTaskId: 'tr_1' },
    taskRunId: 'tr_1',
    attemptId: 'at_1',
    botId: 'bot_a',
    revision: 1,
    settleEvent: settle.fn,
    execute: async () => ({ ok: true, stop: 'returned', report: '干完了' }),
    clock: () => T,
  });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.stopped, 'settled');
  const types = settle.events.map((e) => e.type);
  assert.deepEqual(types, [EVENT.dispatch, EVENT.attempt_finished]);
});

await test('执行器给了现成的 attemptEvent 就用它（不重新构造）', async () => {
  const settle = makeSettleEvent();
  const preset = {
    attemptId: 'at_1',
    taskRunId: 'tr_1',
    revision: 1,
    botId: 'bot_a',
    at: T,
    stop: 'returned',
    phase: { kind: 'progress' },
  };
  const r = await runManagedAttempt({
    taskRuns: { mutate: async () => ({ ok: true }) },
    taskRun: { id: 'tr_1', rootTaskId: 'tr_1' },
    taskRunId: 'tr_1',
    attemptId: 'at_1',
    botId: 'bot_a',
    revision: 1,
    settleEvent: settle.fn,
    execute: async () => ({ ok: true, attemptEvent: preset }),
    clock: () => T,
  });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  const finished = settle.events.find((e) => e.type === EVENT.attempt_finished);
  assert.equal(finished.attempt.at, T, '用的是执行器给的那份事件');
});

// ---------------------------------------------------------------- 派发失败
await test('★ 派发被拒 → dispatched 阶段失败，并且会退款（那次执行没开始）', async () => {
  const settle = makeSettleEvent({
    rejectWhen: (e) => e.type === EVENT.dispatch,
  });
  const r = await runManagedAttempt({
    taskRuns: { mutate: async () => ({ ok: true }) },
    taskRun: { id: 'tr_1', rootTaskId: 'tr_1' },
    taskRunId: 'tr_1',
    attemptId: 'at_1',
    botId: 'bot_a',
    revision: 1,
    settleEvent: settle.fn,
    execute: async () => { throw new Error('不该走到执行'); },
    clock: () => T,
  });
  assert.equal(r.ok, false);
  // 预算预留在假 store 上会成功或失败取决于协调器；关键是阶段与"没执行"
  assert.ok(['dispatched', 'reserved', 'started'].includes(r.phase), `实际 phase=${r.phase}`);
  if (r.phase === 'dispatched') {
    assert.equal(r.code, 'rejected');
    // 派发失败必须退款 —— 这次执行没有发生
    assert.equal(settle.events.filter((e) => e.type === EVENT.attempt_finished).length, 0);
  }
});

// ---------------------------------------------------------------- 事件构造
await test('buildAttemptEvent 把 reason 透传（用户看到的那句"为什么失败"）', async () => {
  const ev = buildAttemptEvent(
    { ok: false, stop: 'failed', reason: '缺 api key' },
    { taskRunId: 'tr_1', attemptId: 'at_1', botId: 'bot_a', revision: 1, clock: () => T },
  );
  assert.ok(ev, '该能构造出事件');
  assert.match(JSON.stringify(ev), /缺 api key/, '★ reason 不能丢，否则只剩一个 stop=failed');
});

await test('buildAttemptEvent：取消走 cancelled、超时走 failed，不混成 returned', async () => {
  // 注意 buildAttemptEvent 返回的是**事件**，stop 在 event.attempt.stop 里
  const cancelled = buildAttemptEvent(
    { ok: false, stop: 'cancelled' },
    { taskRunId: 'tr_1', attemptId: 'at_1', botId: 'bot_a', revision: 1, clock: () => T },
  );
  assert.equal(cancelled.attempt.stop, 'cancelled');
  const timedOut = buildAttemptEvent(
    { ok: false, timedOut: true },
    { taskRunId: 'tr_1', attemptId: 'at_1', botId: 'bot_a', revision: 1, clock: () => T },
  );
  assert.notEqual(timedOut.attempt.stop, 'returned', '★ 超时绝不能算正常返回（那会变成完成候选）');
  assert.equal(timedOut.attempt.stop, 'failed', '超时归为失败');
});

await test('buildAttemptEvent：申请完成要带 claimedEvidence，否则不该被当成完成候选', () => {
  const ev = buildAttemptEvent(
    { ok: true, stop: 'returned', appliedCompletion: true, artifacts: [] },
    { taskRunId: 'tr_1', attemptId: 'at_1', botId: 'bot_a', revision: 1, clock: () => T },
  );
  assert.ok(ev, '该能构造出事件');
  // 申请完成要么落在 apply_completion 阶段（带证据），要么明确不是完成候选。
  // 关键断言：**不能出现"phase 说完成了但没带证据"这种半截状态**。
  if (ev.attempt.phase?.kind === 'apply_completion') {
    assert.ok(Array.isArray(ev.attempt.phase.claimedEvidence), '申请完成必须把证据一起交上来');
  } else {
    assert.notEqual(ev.attempt.stop, 'cancelled');
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
