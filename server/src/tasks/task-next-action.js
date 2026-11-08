/**
 * 下一步判定（纯函数，无 IO、无时钟、无随机）。
 *
 * ## 判定顺序（唯一一份，所有调用共用）
 *
 *   1 取消 / 已完成 → 结束或交付
 *   2 暂停（本人）→ 等待；祖先暂停/取消/改版由推进器先判，任何下游不启动
 *   3 等待门槛（审批/输入/依赖）→ 等待（优先于重试、预算、继续执行）
 *   4 结果未知（已启动未结算）→ 先核验
 *   5 验收中 → 纯代码验收（不耗模型）
 *   6 在途执行 → 等待事件
 *   7 根预算耗尽 → 预算暂停（走既有扩额恢复）
 *   8 到期重试 → 未到期等待，到期后继续（只在没有门槛/暂停时生效）
 *   9 明确失败且无重试 → 阻塞
 *  10 停滞超限 → 阻塞
 *  11 默认 → 负责人继续推进
 */
import { STATE, STOP } from './task-contract.js';
import { ATTEMPT_STATE } from './attempt-ledger.js';

/** 下一步动作种类。 */
export const NEXT = Object.freeze({
  executeLead: 'execute_lead',
  executeMember: 'execute_member',
  verify: 'verify',
  deliver: 'deliver',
  wait: 'wait',
  restore: 'restore',
  blocked: 'blocked',
  pausedBudget: 'paused_budget',
  done: 'done',
});

/**
 * @param {object} taskRun
 * @param {object} [ctx]
 * @param {number} [ctx.now]
 * @param {number} [ctx.remainingRuns]
 * @param {number} [ctx.maxStallRounds]
 * @returns {{kind:string, why:string, gate?:object, attemptId?:string, retry?:boolean}}
 */
export function planNextAction(taskRun, {
  now = Date.now(),
  remainingRuns = Number.POSITIVE_INFINITY,
  maxStallRounds = 2,
  /** 可选：判断这个任务的 registered 尝试是否真的还在本进程里跑。 */
  isInflight = null,
} = {}) {
  if (!taskRun) return { kind: NEXT.blocked, why: '任务不存在' };

  // 1) 终态
  if (taskRun.state === STATE.cancelled) return { kind: NEXT.done, why: '任务已取消' };
  if (taskRun.state === STATE.completed) {
    return taskRun.delivery
      ? { kind: NEXT.done, why: '已完成并交付' }
      : { kind: NEXT.deliver, why: '验收通过，待交付' };
  }

  // 2) 暂停：直接等待，不做任何下游启动
  if (taskRun.state === STATE.paused_user) return { kind: NEXT.wait, why: '任务已暂停，等待继续' };
  if (taskRun.state === STATE.paused_budget) return { kind: NEXT.wait, why: '根预算已用尽，等待扩额' };

  // 3) 等待门槛：优先于重试/预算/继续执行
  const gates = Array.isArray(taskRun.openGates) ? taskRun.openGates : [];
  if (gates.length) {
    const gate = gates[0];
    return { kind: NEXT.wait, gate, why: '等待' + gate.kind + '（' + gate.ref + '）' };
  }

  // 4) 结果未知
  const unknown = unknownAttempts(taskRun);
  if (unknown.length) {
    return { kind: NEXT.restore, attemptId: unknown[0].attemptId, why: '执行结果未知，先核验或明确阻塞' };
  }

  // 5) 验收中
  if (taskRun.state === STATE.verifying) return { kind: NEXT.verify, why: '验收当前成果' };

  // 6) 在途执行
  //
  //   ★ 「有 registered 尝试」不等于「它真的在跑」。
  //
  //     进程崩溃/重启后账本会留下未结算的 registered 记录，但本进程
  //     根本没有在执行它。这种情况必须走核验（restore），否则任务会
  //     被永久判为「有执行在途」——谁也不会再来结算它，任务静死。
  //     调用方通过 isInflight 告诉这里「谁是真在跑」。
  const active = (taskRun.attempts ?? []).filter((a) => a.state === ATTEMPT_STATE.registered);
  if (active.length) {
    const liveId = typeof isInflight === 'function' ? isInflight(taskRun) : true;
    if (liveId === false) {
      return { kind: NEXT.restore, attemptId: active[0].attemptId, why: '有未结算的执行，但它已不在运行（重启/崩溃残留）' };
    }
    return { kind: NEXT.wait, attemptId: active[0].attemptId, why: '有执行在途' };
  }

  // 7) 根预算
  if (remainingRuns <= 0) return { kind: NEXT.pausedBudget, why: '根预算已用尽' };

  // 8) 到期重试（前面已排除暂停/门槛/未知/在途/预算）
  if (Number.isFinite(taskRun.retryAt)) {
    if (now < taskRun.retryAt) return { kind: NEXT.wait, why: '等待重试到期' };
    if ((taskRun.retry?.count ?? 0) > 10) {
      return { kind: NEXT.blocked, why: '重试次数已达上限' };
    }
    return { kind: NEXT.executeLead, why: '重试到期，继续执行', retry: true };
  }

  if (taskRun.state === STATE.blocked) {
    return { kind: NEXT.blocked, why: taskRun.flags?.blockedReason || '任务已阻塞' };
  }

  // 9) 明确失败且没有排重试
  if (taskRun.flags?.blockedAt) {
    return { kind: NEXT.blocked, why: taskRun.flags?.blockedReason || '上一次执行失败' };
  }

  // 10) 有限停滞
  const sig = progressSignature(taskRun);
  const stall = taskRun.stall ?? { rounds: 0, lastSignature: null };
  if (stall.lastSignature === sig && (stall.rounds ?? 0) >= maxStallRounds) {
    return { kind: NEXT.blocked, why: '连续 ' + stall.rounds + ' 轮没有新进展，有限重规划已用尽' };
  }

  // 11) 继续推进
  return { kind: NEXT.executeLead, why: '继续由负责人推进' };
}

/**
 * 进展签名：只算**账本里去重后的真实产物** + 缺项 + 门槛 + 版本。
 * 模型反复声明同一件事不会改变签名。
 */
export function progressSignature(taskRun) {
  // ★ 只统计"目标是否更接近完成"，不统计"又产出了多少文件"。
  //
  //   原来把每条新产物都算进签名：模型每轮丢一个新文件，签名就变一次，
  //   停滞计数永远清零，于是一个做不完的任务会无限跑下去
  //   （实测 8 秒内同一任务执行 71 次、验收 70 次仍在跑，
  //   而默认额度是不限额，没有任何东西能拦住它）。
  //
  //   真正有意义的进展只有两件：
  //     · 目标改版（revision 变）；
  //     · 还缺什么变少了（unmet 收敛）；
  //     · 门槛有变化（gates）。
  //   产物数量不在此列 —— 交 100 个没用的文件不算进展。
  const unmet = [...(taskRun.progress?.unmet ?? [])].sort();
  const gates = (taskRun.openGates ?? []).map((g) => g.kind + ':' + g.ref).sort();
  // 证据只取"是否为空"，不取具体内容：从 0 份变成有交付算进展，
  // 从 3 份变成 4 份不算。
  const hasEvidence = (taskRun.progress?.evidence ?? []).some((e) => e.kind === 'artifact');
  return JSON.stringify([taskRun.revision, hasEvidence, unmet, gates]);
}

/** 占位已开始但未结算的尝试（结果未知）。 */
export function unknownAttempts(taskRun) {
  // 结果已经落盘（尝试已结算）的只是预算待补，不再算“结果未知”
  const settledIds = new Set((taskRun?.attempts ?? [])
    .filter((a) => a.state === 'settled')
    .map((a) => a.attemptId));
  const slots = Object.values(taskRun?.attemptSlots ?? {});
  return slots
    .filter((s) => s.phase !== 'settled' && s.phase !== 'refunded' && s.startedAt)
    .filter((s) => !settledIds.has(s.attemptId))
    .map((s) => ({ attemptId: s.attemptId, taskRunId: s.taskRunId, botId: s.botId ?? null }));
}

/** 这次尝试是否算「有结果」。 */
export function attemptHasOutcome(attempt) {
  return Boolean(attempt) && attempt.stop !== STOP.skipped;
}

export { STATE, STOP, ATTEMPT_STATE };
