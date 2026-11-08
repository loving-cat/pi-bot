/**
 * 受管桥接：把生产审批/升级/执行结束事件接回原 TaskRun。
 *
 * 非受管路径保持旧逻辑；只有确实关联到 TaskRun 的事件才走这里。
 * 这些函数本身不登记审批、不改任务状态，只做“找到归属”→ 交给推进器。
 */

/**
 * 找一条审批真正归属的任务。
 *
 * 优先用审批记录上的 taskRunId；老记录没有时，用等待门槛的引用反查。
 *
 * @returns {null|{taskRunId:string, revision:number}}
 */
export function resolveApprovalRoute({ approval, taskRuns }) {
  if (!approval) return null;
  // 审批创建时就绑定了任务身份：这是权威来源，即使门槛还没落盘也算受管
  if (approval.taskRunId) {
    return {
      managed: true,
      taskRunId: approval.taskRunId,
      revision: approval.taskRevision ?? null,
      attemptId: approval.attemptId ?? null,
    };
  }
  const scan = taskRuns.listAll?.();
  const all = scan?.taskRuns ?? scan ?? [];
  for (const run of all) {
    if (run.state === 'completed' || run.state === 'cancelled') continue;
    const gate = (run.openGates ?? []).find((g) => g.kind === 'approval' && g.ref === approval.id);
    if (gate) return { managed: true, taskRunId: run.id, revision: run.revision, attemptId: null };
  }
  return null;
}

/**
 * 找房间里正在推进的受管任务（升级用）。
 *
 * @returns {null|{taskRunId:string, revision:number}}
 */
export function findManagedTaskInRoom({ taskRuns, roomId, botId = null }) {
  const scan = taskRuns.listAll?.();
  const all = scan?.taskRuns ?? scan ?? [];
  const live = all.filter((run) => run.state !== 'completed'
    && run.state !== 'cancelled'
    && (run.owner?.departmentId === roomId || run.origin?.roomId === roomId)
    && (!botId || run.owner?.leadBotId === botId));
  if (!live.length) return null;
  live.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { taskRunId: live[0].id, revision: live[0].revision };
}

/**
 * 建一组可装配的桥。
 *
 * @param {object} p
 * @param {object} p.runtime createTaskRuntime 的返回值
 * @param {object} p.taskRuns
 */
export function createManagedBridges({ runtime, taskRuns }) {
  return {
    /** 审批决定：受管回原任务，非受管返回 false 交给旧逻辑。 */
    async onApprovalDecided(approval) {
      const route = resolveApprovalRoute({ approval, taskRuns });
      if (!route) return { routed: false };
      // 决定原样交给控制层归一化；不做「非 denied 即 granted」
      // 桥输入必须是明确的真实决定；缺字段属于损坏输入，同样拒绝
      const decision = String(approval.status ?? '').trim();
      if (!decision) {
        return {
          routed: true,
          result: { ok: false, code: 'unknown_decision', text: '审批缺少明确决定，已拒绝（不会当作批准）' },
        };
      }
      const result = await runtime.onApprovalDecided({
        taskRunId: route.taskRunId,
        approvalId: approval.id,
        decision,
        revision: route.revision ?? undefined,
        attemptId: route.attemptId ?? null,
      });
      return { routed: true, result };
    },

    /** 失败升级：找回原任务负责人继续，而不是另起无任务执行。 */
    async onEscalation({ taskRunId, revision = null, attemptId = null, botId = null, reason = '' }) {
      // 只认失败执行携带的真实任务身份；没有就不猜房间最新任务
      if (!taskRunId) return { routed: false };
      const result = await runtime.onEscalation({ taskRunId, revision, attemptId, botId, reason });
      return { routed: true, result };
    },
  };
}
