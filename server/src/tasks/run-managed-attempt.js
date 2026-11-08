/**
 * 受管执行一步：预留 → 启动 → 登记 → 调用 → 结算。
 *
 * ## 复用的既有规则
 *
 *   · 根预算：`reserveRootBudget/startRootBudget/settleRootBudget/refundRootBudget`；
 *   · 尝试结果：`createAttemptResult` / `planAttemptEvent`（不另拼字段）；
 *   · 归约：调用方传入的 `settleEvent` 在**任务事务内**分配 sequence。
 *
 * ## 返回
 *
 *   · `{ok:true, stopped:'settled'}` 已登记并结算；
 *   · `{ok:false, phase:'reserved'|'started'|'dispatched'|'executed', code, text}`
 *     每一步失败都如实报告，调用方据此决定阻塞或恢复。
 */
import { EVENT } from './task-contract.js';
import { adaptRunOutcome, planAttemptEvent } from './task-progress.js';
import {
  reserveRootBudget,
  startRootBudget,
  settleRootBudget,
  refundRootBudget,
} from './task-budget-coordinator.js';

/**
 * 跑一次受管尝试。
 *
 * @param {object} p
 * @param {object} p.taskRuns TaskRunStore
 * @param {object} p.taskRun 当前任务（快照）
 * @param {string} p.taskRunId
 * @param {string} p.attemptId
 * @param {string} p.botId
 * @param {number} p.revision
 * @param {Function} p.settleEvent 在事务内归约事件的函数（返回 {ok} 或 {ok:false}）
 * @param {Function} p.execute 真正调用执行器
 * @param {()=>number} [p.clock]
 * @returns {Promise<object>}
 */
export async function runManagedAttempt({
  taskRuns,
  taskRun,
  taskRunId,
  attemptId,
  botId,
  revision,
  settleEvent,
  execute,
  clock = () => Date.now(),
  restoreOnly = false,
}) {
  const rootTaskId = taskRun?.rootTaskId ?? taskRunId;
  const grant = { store: taskRuns, rootTaskId, taskRunId, attemptId, botId, revision, at: clock() };

  const reserved = await reserveRootBudget(grant);
  if (!reserved.ok) {
    return { ok: false, phase: 'reserved', code: reserved.code, text: reserved.text };
  }

  const started = await startRootBudget(grant);
  if (!started.ok) {
    return { ok: false, phase: 'started', code: started.code, text: started.text };
  }

  const dispatched = await settleEvent({
    type: EVENT.dispatch,
    attemptId,
    botId,
    revision,
    at: clock(),
  });
  if (!dispatched.ok) {
    await refundRootBudget(grant);
    return { ok: false, phase: 'dispatched', code: dispatched.code, text: dispatched.text };
  }

  let raw = null;
  try {
    raw = await execute({ taskRun, attemptId, botId, revision, restoreOnly });
  } catch (err) {
    return { ok: false, phase: 'executed', code: 'unknown_outcome', text: err?.message || String(err), started: true };
  }

  if (!raw || raw.unknown) {
    // 结果未知：保留 started，不退款、不重跑
    return { ok: false, phase: 'executed', code: 'unknown_outcome', text: raw?.error ?? '执行结果未知', started: true };
  }

  const event = raw.attemptEvent ?? buildAttemptEvent(raw, { taskRunId, attemptId, botId, revision, clock });
  if (!event) {
    return { ok: false, phase: 'executed', code: 'bad_attempt_event', text: '无法构造合法的尝试结果', started: true };
  }

  const finished = await settleEvent({
    type: EVENT.attempt_finished,
    revision,
    at: clock(),
    attempt: event.attempt ?? event,
  });
  if (!finished.ok) {
    return { ok: false, phase: 'executed', code: 'settle_rejected', text: finished.text ?? finished.code, started: true };
  }

  const settled = await settleRootBudget(grant);
  if (!settled.ok) {
    // 结果已存、根结算未存：如实报告，交给恢复补齐（幂等）
    return {
      ok: false,
      phase: 'settled_budget',
      code: settled.code ?? 'budget_settle_failed',
      text: settled.text ?? '根结算未落盘',
      started: true,
      attemptEvent: event,
    };
  }

  return { ok: true, stopped: 'settled', attemptEvent: event };
}

/** 由执行器原始结果构造尝试事件（执行器没给现成事件时）。 */
export function buildAttemptEvent(raw, { taskRunId, attemptId, botId, revision, clock = () => Date.now() }) {
  const adapted = adaptRunOutcome({
    ok: raw.ok !== false,
    cancelled: raw.stop === 'cancelled',
    timedOut: raw.timedOut === true,
    stepCapHit: raw.stop === 'yielded',
    empty: raw.stop === 'skipped',
    usage: raw.usage ?? null,
    artifacts: raw.artifacts ?? [],
    appliedCompletion: raw.appliedCompletion === true,
    needsApproval: raw.needsApproval ?? null,
    needsInput: raw.needsInput ?? null,
    waitingDependency: raw.waitingDependency ?? null,
    report: raw.report ?? null,
  });
  const planned = planAttemptEvent({
    stop: adapted.stop,
    context: { taskRunId },
    revision,
    attemptId,
    botId,
    at: clock(),
    usage: raw.usage ?? null,
    artifacts: raw.artifacts ?? [],
    phase: adapted.phase,
    waiting: adapted.waiting,
  });
  return planned.emit ? planned.event : null;
}
