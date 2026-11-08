/**
 * 子任务：负责人把工作派给成员时创建的持久 TaskRun。
 *
 * 复用既有任务契约（父/根/父版本/预算归属/验收条件），不另建任务系统。
 *
 * 业务身份 = 父任务 + 父目标版本 + 完整派工内容指纹（成员、目标、交付物、
 * 每条验收的 kind/description/spec/required）。因此：
 *   · 完全相同的一份派工重试 → 同一身份，复用；
 *   · 任一验收参数（例如 count 2→3）变化 → 明确的新派工；
 *   · 短 ID 碰撞但内容不同 → 请求指纹冲突，拒绝复用。
 */
import { createTaskRun } from './task-run-factory.js';

/** 稳定序列化：对象键排序，数组保持顺序。 */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

/** 规范化后的完整派工内容。 */
export function dispatchContentOf({ botId, goal }) {
  return {
    botId: String(botId ?? ''),
    requirement: String(goal?.requirement ?? ''),
    scope: String(goal?.scope ?? ''),
    deliverables: (goal?.deliverables ?? []).map((x) => String(x)),
    verification: (goal?.verification ?? []).map((v) => ({
      id: String(v?.id ?? ''),
      kind: String(v?.kind ?? ''),
      description: String(v?.description ?? ''),
      spec: v?.spec === undefined || v?.spec === null ? null : v.spec,
      required: v?.required !== false,
    })),
  };
}

/** 完整内容指纹：冲突判定用这一份，不用短 hash。 */
export function dispatchKeyOf({ botId, goal }) {
  return stableJson(dispatchContentOf({ botId, goal }));
}

/** 短码只用于 ID 后缀。 */
export function dispatchCodeOf({ botId, goal }) {
  const payload = dispatchKeyOf({ botId, goal });
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 建一个子任务。
 *
 * @param {object} p
 * @param {object} p.taskRuns
 * @param {object} p.parentTaskRun 当前父任务快照
 * @param {object} p.goal
 * @param {string} p.botId 成员
 * @param {()=>number} [p.clock]
 */
export async function createChildTask({
  taskRuns, parentTaskRun, goal, botId, clock = () => Date.now(),
  /** 调度优先级：负责人安排谁先做（数字小的先跑）。 */
  priority = 0,
}) {
  if (!parentTaskRun) return { ok: false, code: 'no_parent', text: '缺少父任务' };
  if (!goal || typeof goal !== 'object') return { ok: false, code: 'no_goal', text: '缺少子任务目标' };
  if (!Array.isArray(goal.verification) || goal.verification.length === 0) {
    return { ok: false, code: 'no_verification', text: '子任务必须有验收条件' };
  }

  const parentId = parentTaskRun.id;
  const parentRevision = parentTaskRun.revision;
  const fingerprint = dispatchKeyOf({ botId, goal });
  const code = dispatchCodeOf({ botId, goal });
  const childId = parentId + '_c' + parentRevision + '_' + code;
  const requestId = parentId + '_r' + parentRevision + '_c' + code;

  const built = createTaskRun({
    id: childId,
    requestId,
    requesterId: parentTaskRun.request?.requesterId ?? 'task-parent',
    parentTaskId: parentId,
    rootTaskId: parentTaskRun.rootTaskId ?? parentId,
    origin: parentTaskRun.origin ?? null,
    goal,
    budget: parentTaskRun.budget ?? null,
    at: clock(),
  });
  if (!built.ok) return { ok: false, code: 'bad_child', text: built.text };

  const accepted = await taskRuns.acceptRequest({
    requesterId: parentTaskRun.request?.requesterId ?? 'task-parent',
    requestId,
    fingerprint,
    build: () => ({
      ...built.taskRun,
      parentRevision,
      dispatchFingerprint: fingerprint,
      owner: { leadBotId: botId, departmentId: parentTaskRun.owner?.departmentId ?? null },
      // ★ 负责人安排的先后顺序 → 调度器按它决定谁先跑。
      //   「先交首批、别等全量」这种要求如果只写在正文里，调度是看不见的；
      //   记到账本上才能真的影响执行顺序。
      dispatchPriority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
    }),
    at: clock(),
  });
  if (!accepted.ok) {
    if (accepted.code === 'request_conflict') {
      return { ok: false, code: 'dispatch_conflict', text: '同一派工身份的内容不一致，拒绝复用' };
    }
    if (accepted.code === 'duplicate' || accepted.existing) {
      const existing = accepted.taskRun ?? accepted.existing;
      if (existing?.dispatchFingerprint && existing.dispatchFingerprint !== fingerprint) {
        return { ok: false, code: 'dispatch_conflict', text: '同一派工身份的内容不一致，拒绝复用' };
      }
      return { ok: true, child: existing, reused: true };
    }
    return { ok: false, code: accepted.code ?? 'accept_failed', text: accepted.text };
  }

  const child = accepted.taskRun ?? built.taskRun;
  // 复用已有记录时，内容指纹必须与这次完全一致；短码相同但内容不同要明确冲突
  if (accepted.created === false) {
    if (child?.dispatchFingerprint && child.dispatchFingerprint !== fingerprint) {
      return { ok: false, code: 'dispatch_conflict', text: '同一派工身份的内容不一致，拒绝复用' };
    }
    return { ok: true, child, reused: true };
  }
  await taskRuns.mutate(child.id, {
    mutate: (cur) => (cur ? { ...cur, parentRevision, dispatchFingerprint: fingerprint, updatedAt: clock() } : null),
  });
  return { ok: true, child, reused: false };
}

/** 父任务当前那版目标下的子任务（按持久 parentRevision 判定）。 */
export function childrenOf(taskRuns, parentTaskRun) {
  const scan = taskRuns.listAll?.();
  const all = scan?.taskRuns ?? scan ?? [];
  return all.filter((run) => run.parentTaskId === parentTaskRun.id
    && (run.parentRevision ?? run.revision) === parentTaskRun.revision);
}

/** 任意版本（用于取消传播/诊断）。 */
export function allChildrenOf(taskRuns, parentTaskRun) {
  const scan = taskRuns.listAll?.();
  const all = scan?.taskRuns ?? scan ?? [];
  return all.filter((run) => run.parentTaskId === parentTaskRun.id);
}
