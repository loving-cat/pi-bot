/**
 * 归约器不变量的测试（W4b 第 3 步）。
 *   node tests/task-reduce.mjs
 *
 * ## 为什么这块必须单独测
 *
 * `task-reduce.js` 1198 行，是 TaskRun 状态机的唯一出口 ——
 * 之前**零测试引用**（见 `docs/taskrun-gaps.md`）。而它文件头自己列了五条不变量，
 * 其中几条正是过去几轮真实出过 bug 的地方（审查编号还写在注释里：H01～H05、G02、G06）。
 *
 * 注释里写着"现在不会了"不算数 —— 那正是这次补测试的原因：**没有断言守着的不变量，
 * 下一轮重构就会破。**
 *
 * ## 守什么（对应注释里的编号）
 *
 * 1. **H01 每个成功结果都合法**：序号/版本/终态守卫对**所有**事件生效，
 *    包括结算路径（历史上结算能绕过校验）。
 * 2. **H04 门槛不会被组合丢掉**：暂停 + 恢复之后，审批门槛必须还在。
 * 3. **第五轮 P2 事件身份绑定**：外层 `attemptId` 与内层结果不一致要拒，
 *    不能"用 a1 校验、用 a2 结算"。
 * 4. **旧版本结果按自己版本归档**：改版之后，旧 attempt 的结果仍然能落地。
 * 5. **G02 未结算的执行还在时不许派新的**（同一任务不能有两个并行执行）。
 * 6. **G06 阻塞有正常解除入口**（不能靠"暂停再继续"绕回去）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reduce-'));
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
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { reduceTaskRun, deriveState, validateTaskRun } = await import(src('tasks/task-reduce.js'));
const { STATE, EVENT } = await import(src('tasks/task-contract.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const T = 1_700_000_000_000;

/** 一份合法的初始任务（每次调用都是新对象，避免用例之间互相污染）。 */
function freshRun(over = {}) {
  const created = createTaskRun({
    id: 'tr_1',
    requestId: 'req_1',
    at: T,
    requesterId: 'dev_a',
    goal: {
      requirement: '做点东西',
      deliverables: ['a.txt'],
      verification: [{ kind: 'artifact', path: 'a.txt', description: 'a.txt 存在' }],
    },
    budget: { maxRuns: 5 },
    ...over,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.taskRun;
}

/** 派发一次执行，返回新的 TaskRun。 */
function dispatched(run = freshRun(), { attemptId = 'at_1', botId = 'bot_a', sequence = 1 } = {}) {
  const r = reduceTaskRun(run, {
    type: EVENT.dispatch, sequence, revision: run.revision, attemptId, botId, at: T,
  });
  assert.equal(r.ok, true, `dispatch 失败：${r.code} ${r.text ?? ''}`);
  return r.taskRun;
}

/** 交一份执行结果（默认 progress 阶段，不会触发完成）。 */
function finished(run, phase = { kind: 'progress' }, {
  attemptId = 'at_1', sequence = run.sequence + 1, revision = null,
  attemptRevision = null, extra = {},
} = {}) {
  return reduceTaskRun(run, {
    type: EVENT.attempt_finished,
    sequence,
    // 事件版本 = 当前任务版本（结算时有用的是 record 自己的版本，这里照实报当前）
    revision: revision ?? run.revision,
    attempt: {
      attemptId,
      taskRunId: run.id,
      // ★ attempt.revision 是**这次执行登记的那一版**，不是任务当前版本。
      //   报成当前版本会被账本判成 attempt_mismatch（那道校验是对的）。
      revision: attemptRevision ?? run.revision,
      botId: 'bot_a',
      at: T + 1000,
      stop: 'returned',
      phase,
      ...extra,
    },
  });
}

// ============================================================ 序号与版本守卫（H01）
test('★ 迟到事件（序号不大于当前）一律拒绝，结算路径也不例外', () => {
  let run = freshRun();
  const stale = reduceTaskRun(run, { type: EVENT.paused, sequence: 0, revision: 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_sequence');
  run = dispatched(run);
  const afterDispatch = run.sequence;
  // 结算事件带一个更小的序号：必须照样被拦（H01 就是"结算能绕过校验"）
  const settle = reduceTaskRun(run, {
    type: EVENT.attempt_finished,
    sequence: afterDispatch,
    revision: 1,
    attempt: {
      attemptId: 'at_1', taskRunId: 'tr_1', revision: 1, botId: 'bot_a', at: T + 1000,
      stop: 'returned', phase: { kind: 'progress' },
    },
  });
  assert.equal(settle.ok, false);
  assert.equal(settle.code, 'stale_sequence', '结算也必须过序号校验');
});

test('★ 事件版本落后 → stale_revision；超前 → future_revision', () => {
  // 版本 0 / 负数先被"必须是正整数"挡住（那是更早的一道门），
  // 所以这里用**升过版本的任务**来验真正的 stale / future。
  const run = dispatched();
  const bumped = reduceTaskRun(run, {
    type: EVENT.revision_bumped,
    sequence: run.sequence + 1,
    revision: 1,
    goal: {
      requirement: '改一下',
      deliverables: ['a.txt'],
      verification: [{ kind: 'artifact', path: 'a.txt', description: 'a.txt 存在' }],
    },
    reason: '用户改主意',
  });
  assert.equal(bumped.ok, true);
  const t = bumped.taskRun; // revision = 2
  const behind = reduceTaskRun(t, { type: EVENT.paused, sequence: t.sequence + 1, revision: 1 });
  assert.equal(behind.ok, false);
  assert.equal(behind.code, 'stale_revision');
  const ahead = reduceTaskRun(t, { type: EVENT.paused, sequence: t.sequence + 1, revision: 9 });
  assert.equal(ahead.ok, false);
  assert.equal(ahead.code, 'future_revision');
  // 非整数版本直接 bad_field
  assert.equal(reduceTaskRun(t, { type: EVENT.paused, sequence: t.sequence + 1, revision: 0 }).code, 'bad_field');
});

test('序号缺 / 不是整数 → 明确拒绝（不默认成 0）', () => {
  const run = freshRun();
  for (const seq of [undefined, null, 1.5, '1']) {
    const r = reduceTaskRun(run, { type: EVENT.paused, sequence: seq, revision: 1 });
    assert.equal(r.ok, false, `sequence=${seq} 该被拒`);
  }
});

// ============================================================ 事件身份绑定（第五轮 P2）
test('★ 外层 attemptId 与内层结果不一致 → 拒绝（不能拿 a1 校验、用 a2 结算）', () => {
  const run = dispatched();
  const r = reduceTaskRun(run, {
    type: EVENT.attempt_finished,
    sequence: run.sequence + 1,
    revision: run.revision,
    attemptId: 'at_1',            // 外层说 at_1
    attempt: {                    // 内层说 at_2
      attemptId: 'at_2', taskRunId: 'tr_1', revision: 1, botId: 'bot_a', at: T + 1000,
      stop: 'returned', phase: { kind: 'progress' },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'attempt_mismatch');
  assert.match(String(r.text), /不能指向两次执行/);
});

test('结算一个没登记过的 attempt → 明确拒绝（不是"就算成功"）', () => {
  const run = dispatched();
  const r = finished(run, { kind: 'progress' }, { attemptId: 'at_999' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_active_attempt');
});

// ============================================================ H04：门槛不被组合丢掉
test('★★ 暂停 + 恢复之后，审批门槛必须还在（H04 的历史 bug）', () => {
  // 先让任务进入 waiting_approval：执行时申请批准
  let run = dispatched();
  const needApproval = finished(run, {
    kind: 'need_approval',
    waitFor: { kind: 'approval', ref: 'ap_1', describe: '要用户批准' },
  });
  assert.equal(needApproval.ok, true, JSON.stringify(needApproval).slice(0, 300));
  run = needApproval.taskRun;
  assert.equal(run.state, STATE.waiting_approval);
  assert.equal((run.openGates ?? []).length, 1);
  // 暂停
  const paused = reduceTaskRun(run, { type: EVENT.paused, sequence: run.sequence + 1, revision: 1, reason: '用户暂停' });
  assert.equal(paused.ok, true);
  assert.equal(paused.taskRun.state, STATE.paused_user);
  assert.equal((paused.taskRun.openGates ?? []).length, 1, '★ 暂停不许擦掉门槛');
  // 恢复
  const resumed = reduceTaskRun(paused.taskRun, { type: EVENT.resumed, sequence: paused.taskRun.sequence + 1, revision: 1 });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.taskRun.state, STATE.waiting_approval, '★ 恢复后要落回"等批准"，而不是直接开跑');
  assert.equal((resumed.taskRun.openGates ?? [])[0]?.ref, 'ap_1');
});

test('阻塞 + 暂停 + 恢复：阻塞原因不许被暂停覆盖掉（G06）', () => {
  let run = freshRun();
  run = reduceTaskRun(run, { type: EVENT.blocked, sequence: 1, revision: 1, reason: '缺凭据' }).taskRun;
  assert.equal(run.state, STATE.blocked);
  assert.equal(run.flags.blockedAt, T);
  run = reduceTaskRun(run, { type: EVENT.paused, sequence: 2, revision: 1, reason: '用户暂停' }).taskRun;
  // 暂停优先显示，但 blockedAt 必须还在 —— 否则"恢复"之后任务会假装没阻塞
  assert.equal(run.state, STATE.paused_user);
  assert.equal(run.flags.blockedAt, T, '★ 暂停不许清掉阻塞标记');
  run = reduceTaskRun(run, { type: EVENT.resumed, sequence: 3, revision: 1 }).taskRun;
  assert.equal(run.state, STATE.blocked, '恢复后要落回阻塞，而不是开跑');
});

test('阻塞有独立解除入口：unblocked 之后回到可执行状态', () => {
  let run = freshRun();
  run = reduceTaskRun(run, { type: EVENT.blocked, sequence: 1, revision: 1, reason: '缺凭据' }).taskRun;
  const un = reduceTaskRun(run, { type: EVENT.unblocked, sequence: 2, revision: 1, reason: '凭据已补' });
  assert.equal(un.ok, true);
  assert.equal(un.taskRun.flags.blockedAt, null);
  assert.equal(un.taskRun.state, STATE.queued, '解除阻塞后该回到排队（能重新派发）');
});

// ============================================================ 旧版本结果归档
test('★★ 改版之后，旧版本的执行结果仍然能落地（但任务版本不变）', () => {
  // 这条守的是注释里那段"为什么结算按记录自己的版本归档"
  let run = dispatched();
  const bumped = reduceTaskRun(run, {
    type: EVENT.revision_bumped,
    sequence: run.sequence + 1,
    revision: run.revision,
    goal: {
      requirement: '改成 y',
      deliverables: ['a.txt'],
      verification: [{ kind: 'artifact', path: 'a.txt', description: 'a.txt 存在' }],
    },
    reason: '用户改主意',
  });
  assert.equal(bumped.ok, true, JSON.stringify(bumped).slice(0, 300));
  assert.equal(bumped.taskRun.revision, 2);
  // 旧 attempt 属于第 1 版；交它的结果必须能落地。
  // ★ 这里有个容易写错的地方：`attempt.revision` 必须报**执行自己的版本**（1），
  //   报成任务当前版本（2）会被账本判成"登记在第 1 版却报第 2 版"并拒绝 ——
  //   那是正确的校验（防止拿新版本的结果冒充旧执行）。
  // attempt.revision 报的是"这次执行属于哪一版目标"，账本里记录的是 1
  const settleOld = finished(bumped.taskRun, { kind: 'progress' }, { revision: 1, attemptRevision: 1 });
  assert.equal(settleOld.ok, true, `旧版本结果该能落地：${settleOld.code} ${settleOld.text ?? ''}`);
  assert.equal(settleOld.taskRun.revision, 2, '任务版本不该被旧结果改回去');
  assert.equal(settleOld.taskRun.state, STATE.queued, '旧结果落地后回到排队（等新版本重新派发）');
  // 新版本可以立刻派新执行
  const next = reduceTaskRun(settleOld.taskRun, {
    type: EVENT.dispatch, sequence: settleOld.taskRun.sequence + 1, revision: 2,
    attemptId: 'at_2', botId: 'bot_a', at: T,
  });
  assert.equal(next.ok, true, `旧结果结清之后该能派新的：${next.code} ${next.text ?? ''}`);
});

// ============================================================ G02：不许两个并行执行
test('★ 还有未结算的执行时，不许派新的（G02：两道门都必须拦住）', () => {
  // 运行中派发会被更早的一道门拦住：allowedFrom 说「执行中不接受 dispatch」。
  // 但 G02 那道门（"还有未结算的执行"）是给**另一条路径**用的 ——
  // 状态已经回到 queued（比如暂停后恢复让 attempt 变成 abandoned 之外的情况）
  // 但账本里还有 in-flight 记录时。两道门都要能拦，所以分别验。
  const run = dispatched();
  const inRunning = reduceTaskRun(run, {
    type: EVENT.dispatch, sequence: run.sequence + 1, revision: run.revision,
    attemptId: 'at_2', botId: 'bot_a', at: T,
  });
  assert.equal(inRunning.ok, false);
  assert.equal(inRunning.code, 'illegal_source', '执行中派发先被状态门拦住');

  // "状态说 queued、账本里还有在途执行"这种不一致，会被更早的一道门拦住：
  // 出口校验说「排队中不允许有在途执行」。那比 G02 更硬 —— 它连记录都不认。
  const inconsistent = {
    ...run,
    state: STATE.queued,
    attempts: (run.attempts ?? []).map((a) => ({ ...a, state: 'registered' })),
  };
  const rejected = reduceTaskRun(inconsistent, {
    type: EVENT.dispatch, sequence: inconsistent.sequence + 1, revision: inconsistent.revision,
    attemptId: 'at_2', botId: 'bot_a', at: T,
  });
  assert.equal(rejected.ok, false, '★ 状态与账本不一致的记录不能被接受');
  assert.equal(rejected.code, 'bad_field');
  assert.match(String(rejected.text), /不允许有在途执行/, '要说清是状态与账本打架');
});

test('确认执行已停止（attempt_closed）之后才能派新的', () => {
  let run = dispatched();
  const closed = reduceTaskRun(run, {
    type: EVENT.attempt_closed,
    sequence: run.sequence + 1,
    revision: run.revision,
    attemptId: 'at_1',
    reason: '执行已停止但没有结果',
  });
  assert.equal(closed.ok, true, JSON.stringify(closed).slice(0, 300));
  run = closed.taskRun;
  const next = reduceTaskRun(run, {
    type: EVENT.dispatch, sequence: run.sequence + 1, revision: run.revision,
    attemptId: 'at_2', botId: 'bot_a', at: T,
  });
  assert.equal(next.ok, true, `关掉旧执行之后该能派新的：${next.code} ${next.text ?? ''}`);
});

// ============================================================ 完成候选只认 returned
test('★ 完成候选只认 returned：failed / yielded / skipped 都不许推进验收', () => {
  for (const stop of ['failed', 'yielded', 'skipped', 'cancelled']) {
    const run = dispatched();
    const r = reduceTaskRun(run, {
      type: EVENT.attempt_finished,
      sequence: run.sequence + 1,
      revision: run.revision,
      attempt: {
        attemptId: 'at_1', taskRunId: 'tr_1', revision: 1, botId: 'bot_a', at: T + 1000,
        stop,
        phase: { kind: 'apply_completion', claimedEvidence: [] },
      },
    });
    // 无论通过与否，都**绝不能**因为"申请完成"就进 verifying/completed
    if (r.ok) {
      assert.notEqual(r.taskRun.state, STATE.verifying, `stop=${stop} 不该进验收`);
      assert.notEqual(r.taskRun.state, STATE.completed, `stop=${stop} 不该完成`);
    } else {
      assert.ok(['completion_not_eligible', 'bad_field', 'missing_field'].includes(r.code), `stop=${stop} 的拒绝码：${r.code}`);
    }
  }
});

// ============================================================ 状态派生
test('派生状态优先级：终态 > 用户暂停 > 预算暂停 > 阻塞 > 等待 > 执行', () => {
  const base = freshRun();
  // 终态压过一切
  assert.equal(deriveState({ ...base, state: STATE.completed, flags: { pausedAt: T, blockedAt: T } }), STATE.completed);
  // 用户暂停压过预算暂停与阻塞
  assert.equal(deriveState({ ...base, flags: { pausedAt: T, budgetPausedAt: T, blockedAt: T } }), STATE.paused_user);
  // 预算暂停压过阻塞
  assert.equal(deriveState({ ...base, flags: { budgetPausedAt: T, blockedAt: T } }), STATE.paused_budget);
  // 阻塞压过等待
  assert.equal(deriveState({ ...base, flags: { blockedAt: T }, openGates: [{ kind: 'approval', ref: 'x' }] }), STATE.blocked);
  // 等待压过执行中
  assert.equal(deriveState({ ...base, openGates: [{ kind: 'input', ref: 'q' }] }), STATE.waiting_input);
});

test('出口校验：任何成功返回的 TaskRun 都能再过一次 validateTaskRun', () => {
  let run = dispatched();
  const r = finished(run, { kind: 'progress' });
  assert.equal(r.ok, true);
  assert.equal(validateTaskRun(r.taskRun).ok, true, '归约输出必须是合法 TaskRun');
});

test('未知事件类型 → 拒绝（不静默忽略）', () => {
  const run = freshRun();
  const r = reduceTaskRun(run, { type: 'self_destruct', sequence: 1, revision: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_field');
});

test('归约器是纯函数：不改入参', () => {
  const run = dispatched();
  const snapshot = JSON.stringify(run);
  finished(run, { kind: 'progress' });
  assert.equal(JSON.stringify(run), snapshot, '★ 归约不许原地改传入的 TaskRun');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
