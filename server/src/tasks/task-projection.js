/**
 * TaskRun 用户投影：客户端只看这个形状，不暴露内部字段与模型路由参数。
 *
 * 明确区分：
 *   · 结果已准备（服务端验收通过、有交付摘要）≠ 用户设备已收到；
 *   · revision（目标版本）／sequence（领域事件序号）／storeVersion（持久变化版本）
 *     各司其职，客户端不能只靠 sequence 过滤更新。
 */
import {
  STATE_TEXT,
  STATE,
  WAIT_KIND_OF_STATE,
  isTerminal,
  isWaiting,
} from './task-contract.js';
const WAIT_TEXT = Object.freeze({
  approval: '等待你批准一个操作',
  input: '等待你补充信息',
  dependency: '等待子任务完成',
});

import { activeAttemptOf, pendingAttemptsOf, registeredCount, settledCount } from './attempt-ledger.js';

/**
 * 任务状态卡要显示的最小信息。
 * @returns {object|null}
 */
export function projectForUser(run) {
  if (!run) return null;
  const waitingKind = WAIT_KIND_OF_STATE[run.state] ?? null;
  return {
    id: run.id,
    state: run.state,
    stateText: STATE_TEXT[run.state] ?? run.state,
    title: run.goal?.requirement ?? '',
    progressText: run.progress?.checkpoint || '',
    unmet: Array.isArray(run.progress?.unmet) ? [...run.progress.unmet] : [],
    // 等什么要用人话说，不说内部引用
    waitingForText: waitingKind ? (WAIT_TEXT[waitingKind] ?? '等待中') : '',
    reason: run.reason ?? '',
    terminal: isTerminal(run.state),
    canResume: run.state === STATE.paused_user || run.state === STATE.paused_budget,
    canCancel: !isTerminal(run.state),
    needsUserAttention: isWaiting(run.state) || run.state === STATE.blocked,
    updatedAt: run.updatedAt ?? 0,
  };
}

/**
 * 诊断视图：给排查用的，可以暴露内部字段。
 * 只在诊断入口返回，不进普通界面。
 *
 * ★ 全部从当前事实派生，不读已废弃字段。
 */
export function projectForDiagnostics(run) {
  if (!run) return null;
  const active = activeAttemptOf(run);
  const pending = pendingAttemptsOf(run);
  const flags = run.flags ?? {};

  return {
    id: run.id,
    rootTaskId: run.rootTaskId,
    parentTaskId: run.parentTaskId,
    revision: run.revision,
    sequence: run.sequence,
    state: run.state,
    reason: run.reason,

    // ---- 当前执行（从账本派生）
    activeAttempt: active
      ? {
          attemptId: active.attemptId,
          botId: active.botId,
          revision: active.revision,
          startedAt: active.startedAt,
        }
      : null,
    pendingAttempts: pending.map((a) => ({
      attemptId: a.attemptId,
      state: a.state,
      revision: a.revision,
    })),

    // ---- 未解除的门槛（唯一事实来源）
    openGates: (run.openGates ?? []).map((g) => ({
      kind: g.kind,
      ref: g.ref,
      describe: g.describe ?? '',
    })),

    // ---- 约束标记
    flags: {
      pausedAt: flags.pausedAt ?? null,
      budgetPausedAt: flags.budgetPausedAt ?? null,
      blockedAt: flags.blockedAt ?? null,
      blockedReason: flags.blockedReason ?? '',
      verifyingAt: flags.verifyingAt ?? null,
    },

    // ---- 预算
    //
    // ★ B05：这里同时给出两处事实，并明确哪个是权威。
    //
    //   · usedRuns        —— 持久扣额记录（预留时就扣，代表「额度已被占用」）
    //   · ledgerAttempts  —— 批次 01 账本里的执行登记数（代表「尝试过几次」）
    //
    // 正常情况下两者相等。不相等时说明中间状态：额度已扣但执行尚未登记，
    // 或者执行已登记但扣额没走预留入口。把它们**分开显示**，
    // 排查时才能一眼看出是哪边缺了 —— 而不是用一个数字掩盖分歧。
    budget: run.budget
      ? {
          maxRuns: run.budget.maxRuns ?? null,
          extraRuns: run.budget.extraRuns ?? 0,
          deadlineAt: run.budget.deadlineAt ?? null,
          // 权威：额度占用以持久扣额为准
          usedRuns: run.budget.usedRuns ?? 0,
          // 对照：账本登记数（正常应与 usedRuns 相等）
          ledgerAttempts: registeredCount(run),
          settledRuns: settledCount(run),
          // 两处事实是否一致 —— 不一致要在诊断里看得出来
          consistent: (run.budget.usedRuns ?? 0) === registeredCount(run),
        }
      : null,

    evidenceCount: run.progress?.evidence?.length ?? 0,
    unmetCount: run.progress?.unmet?.length ?? 0,
    // 文件占用声明：撞车的活会被调度器排开。诊断里必须看得见，
    // 否则用户遇到「任务迟迟不动」时无法判断是不是在等别人的文件。
    fileClaims: Array.isArray(run.fileClaims) ? [...run.fileClaims] : [],
    lastEffectiveAt: run.lastEffectiveAt,
    updatedAt: run.updatedAt,
  };
}

export { projectTaskRun, projectTaskRunList, userStateOf } from './task-transport.js';
