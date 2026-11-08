/**
 * 恢复决策（纯函数）：把一次重启/异常后的任务归入且仅归入一种恢复阶段。
 *
 * ## 三个阶段（互斥优先级从高到低）
 *
 *   1. unknown        结果未知：占位已启动、结果没有落盘 → 只读核验一次
 *   2. budgetPending  结果已知：尝试已结算、根预算占位未结算 → 只补根结算
 *   3. clearBlocked   结算已完成：只清对应可恢复阻塞/未知标记并唤醒
 *
 * 另有两个无副作用的收尾阶段：
 *
 *   · releaseReserved 预留后从未启动 → 释放占位（并保留恢复意图）
 *   · resume          有待执行动作/到期重试 → 重新入队
 *
 * 关键规则：结果已知就不再 inspect/执行；根写入未成功绝不解阻。
 */

export const RECOVERY_STAGE = Object.freeze({
  releaseReserved: 'release_reserved',
  inspectUnknown: 'inspect_unknown',
  settleBudget: 'settle_budget',
  clearBlocked: 'clear_blocked',
  resume: 'resume',
  firstDispatch: 'first_dispatch',
});

/**
 * @param {object} run 当前任务快照
 * @param {object} p
 * @param {object} p.root 根任务快照（run 自己是根时传 run）
 * @param {(id:string)=>object|null} p.load 读取真实任务
 * @returns {{stages:Array<{stage:string, attemptId?:string, slot?:object, ownerRunId?:string}>, pending:boolean}}
 */
export function decideRecovery(run, { root, load }) {
  const stages = [];
  const rootRun = root ?? run;
  const slots = Object.values(rootRun?.attemptSlots ?? {})
    .filter((slot) => !slot.taskRunId || slot.taskRunId === run.id)
    .filter((slot) => slot.taskRunId === run.id);

  let pending = false;
  for (const slot of slots) {
    if (slot.phase === 'settled' || slot.phase === 'refunded') continue;
    const ownerId = slot.taskRunId ?? run.id;
    const owner = load(ownerId) ?? (ownerId === run.id ? run : null);
    const attempt = (owner?.attempts ?? []).find((a) => a.attemptId === slot.attemptId);
    const settled = attempt?.state === 'settled';

    if (settled && slot.startedAt) {
      // 结果已知、根预算未结算
      stages.push({ stage: RECOVERY_STAGE.settleBudget, attemptId: slot.attemptId, slot, ownerRunId: ownerId });
      pending = true;
      continue;
    }
    if (!settled && slot.startedAt) {
      // 结果未知
      stages.push({ stage: RECOVERY_STAGE.inspectUnknown, attemptId: slot.attemptId, slot, ownerRunId: ownerId });
      pending = true;
      continue;
    }
    if (!settled && !slot.startedAt) {
      stages.push({ stage: RECOVERY_STAGE.releaseReserved, attemptId: slot.attemptId, slot, ownerRunId: ownerId });
      pending = true;
    }
  }

  // 结算全部完成（或本来就没有占位）才允许清阻塞与唤醒
  if (!pending) {
    if (run.state === 'blocked' && (run.recoverableBlock || run.unknownBlock)) {
      stages.push({ stage: RECOVERY_STAGE.clearBlocked });
    }
    // 初次交接完成、owner 已落盘但任务仍 queued：持久 next.action=dispatch 是执行意图。
    // 只认交接 done 的本版本首派；createOnly/暂停/取消/门槛/未知占位一律不在这里复活。
    const firstDispatch = run.state === 'queued'
      && run.next?.action === 'dispatch'
      && (run.attempts ?? []).length === 0
      && !(run.openGates ?? []).length
      && run.owner?.departmentId
      && run.owner?.leadBotId
      && run.admission?.status === 'done'
      && run.admission?.createOnly !== true
      && run.admission?.execute !== false
      && !run.flags?.pausedAt
      && !run.flags?.budgetPausedAt
      && !run.flags?.blockedAt;
    if (firstDispatch) stages.push({ stage: RECOVERY_STAGE.firstDispatch });
    else if (run.nextAction || Number.isFinite(run.retryAt) || run.resumeIntent) {
      stages.push({ stage: RECOVERY_STAGE.resume });
    }
  }

  return { stages, pending };
}
