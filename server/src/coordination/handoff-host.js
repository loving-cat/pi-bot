/**
 * 部门交接的**宿主适配**：真实 Store I/O、按操作找回、持久确认。
 *
 * ## 职责边界
 *
 * 服务决定「做什么、按什么顺序、从哪一步恢复」；这里只负责真实读写：
 * 建 Bot/群、写 TaskRun 字段、落盘待派、通知负责人。
 * 不替调用方挑目标，也不决定模式。
 *
 * ## 事务内授权
 *
 * 所有写 TaskRun 的 `mutate` 都接收调用方给的 `guard`，并用**当前快照**
 * 再判一次 —— 与服务入口是同一份判定，不是另一套更宽松的规则。
 *
 * ## 持久化诚实性
 *
 * `scheduleSave` 延迟、`saveNow` 失败只记日志，都不能回答
 * 「这次改动持久成功了吗」。组织资源用 `flushNow` 同步确认，
 * 失败就如实返回，不推进进度。
 */
import { HANDOFF_STEP } from './department-service.js';

/**
 * 建一个交接宿主。
 *
 * @param {object} p
 * @param {object} p.store 应用 store（Bot/群/消息）
 * @param {object} p.taskRuns TaskRunStore
 * @param {object} [p.deps] 可注入依赖（测试用假执行/假队列）
 */
export function createHandoffHost({ store, taskRuns, deps = {} } = {}) {
  const buildDepartment = deps.buildDepartment ?? defaultBuildDepartment(store);
  const enqueue = deps.enqueue ?? defaultEnqueue();
  const notify = deps.notify ?? defaultNotify(store);

  return {
    /** 把交接进度写进 TaskRun（事务内复核）。 */
    async patchHandoff(taskRunId, patch, { guard = null } = {}) {
      const out = await taskRuns.mutate(taskRunId, {
        mutate: (current) => {
          const bad = guard?.(current);
          if (bad) return { __reject: bad };
          return {
            ...current,
            handoff: { ...(current.handoff ?? {}), ...patch },
            updatedAt: patch.at ?? Date.now(),
          };
        },
      });
      if (!out.ok) return { ok: false, code: out.code, text: out.text };
      return { ok: true, taskRun: out.taskRun };
    },

    /**
     * 确保部门就绪：已有就复用；没有才建。
     *
     * 建完同步落盘确认，落不下去就返回失败。
     */
    async ensureDepartment(plan, { operationId } = {}) {
      if (plan?.route === 'existing' && plan.departmentId) {
        const room = store.getRoom(plan.departmentId);
        if (!room) return { ok: false, text: `部门 ${plan.departmentId} 已不存在` };
        const leadBotId = room.leadBotId ?? null;
        if (!leadBotId || !store.getBot(leadBotId)) {
          return { ok: false, text: `部门 ${plan.departmentId} 没有可用负责人` };
        }
        const confirmed = confirmPersisted(store, room, leadBotId);
        if (!confirmed.ok) return { ok: false, text: confirmed.text };
        return { ok: true, departmentId: room.id, leadBotId, reused: true };
      }

      // 按操作 ID 找回：群已写但进度未写时，重试不能再建一个
      const found = findDepartmentByOperation(store, operationId);
      if (found) {
        const leadBotId = found.room.leadBotId ?? null;
        if (leadBotId && store.getBot(leadBotId)) {
          const confirmed = confirmPersisted(store, found.room, leadBotId);
          if (!confirmed.ok) return { ok: false, text: confirmed.text };
          return { ok: true, departmentId: found.room.id, leadBotId, recovered: true };
        }
      }

      const built = buildDepartment(plan, { operationId });
      if (!built?.ok || !built.room) {
        return { ok: false, text: built?.text ?? '部门创建失败' };
      }

      const room = store.getRoom(built.room.id);
      if (!room) return { ok: false, text: '部门创建后读不回来' };
      const leadBotId = room.leadBotId ?? null;
      if (!leadBotId || !store.getBot(leadBotId)) {
        return { ok: false, text: '部门创建后没有可用负责人' };
      }

      const confirmed = confirmPersisted(store, room, leadBotId);
      if (!confirmed.ok) return { ok: false, text: confirmed.text };

      return { ok: true, departmentId: room.id, leadBotId, created: true };
    },

    /** 把任务绑定到部门与负责人（事务内复核）。 */
    async bindTaskToDepartment({
      taskRunId, goal, departmentId, leadBotId, expectRevision, guard = null,
    }) {
      const out = await taskRuns.mutate(taskRunId, {
        mutate: (current) => {
          const bad = guard?.(current) ?? rejectRevision(current, expectRevision);
          if (bad) return { __reject: bad };
          return {
            ...current,
            owner: { ...(current.owner ?? {}), leadBotId, departmentId },
            goal: current.goal ?? goal,
            updatedAt: Date.now(),
          };
        },
      });
      if (!out.ok) return { ok: false, text: out.text, code: out.code };
      return { ok: true };
    },

    /** 落盘待派动作（写进 TaskRun，不依赖内存队列）。 */
    async enqueueDispatch({
      taskRunId, attemptId, departmentId, leadBotId, goal, operationId,
      expectRevision, guard = null,
    }) {
      const queueRef = `dq_${operationId}`;
      const out = await taskRuns.mutate(taskRunId, {
        mutate: (current) => {
          const bad = guard?.(current) ?? rejectRevision(current, expectRevision);
          if (bad) return { __reject: bad };
          const targetRevision = expectRevision ?? current.revision;
          // 旧版本留下的待派一律作废：新版本的目标不该被旧队列消费
          const kept = (current.pendingDispatch ?? [])
            .filter((d) => d.id !== queueRef)
            .map((d) => (d.revision !== undefined && d.revision !== targetRevision
              ? { ...d, status: 'superseded', supersededAt: Date.now() }
              : d));
          kept.push({
            id: queueRef,
            attemptId,
            departmentId,
            leadBotId,
            requirement: goal?.requirement ?? '',
            revision: targetRevision,
            operationId,
            status: 'pending',
            at: Date.now(),
          });
          return { ...current, pendingDispatch: kept, updatedAt: Date.now() };
        },
      });
      if (!out.ok) return { ok: false, text: out.text, code: out.code };

      const sent = await enqueue({ queueRef, departmentId, leadBotId, goal, taskRunId });
      if (!sent?.ok) return { ok: false, text: sent?.text ?? '待派动作未能进入执行队列' };
      return { ok: true, queueRef };
    },

    /** 通知负责人开工（可重入唤醒，接收方按 queueRef 去重）。 */
    async notifyLead({ queueRef, departmentId, leadBotId }) {
      const out = await notify({ queueRef, departmentId, leadBotId });
      return out?.ok ? { ok: true } : { ok: false, text: out?.text ?? '通知失败' };
    },

    /**
     * 确认交接引用的组织资源仍在。
     *
     * 只**检查**，不复活：用户主动删掉的部门不能被自动重建。
     */
    async confirmResource({ departmentId, leadBotId }) {
      if (!departmentId) {
        return { ok: false, code: 'resource_missing', text: '交接没有记录部门' };
      }
      const room = store.getRoom(departmentId);
      if (!room || room.kind !== 'group') {
        return { ok: false, code: 'resource_missing', text: '交接引用的部门已不存在' };
      }
      const leadId = leadBotId ?? room.leadBotId ?? null;
      if (!leadId || !store.getBot(leadId)) {
        return { ok: false, code: 'resource_missing', text: '交接引用的负责人已不存在' };
      }
      return { ok: true, departmentId, leadBotId: leadId };
    },

    /** 目标版本变化后作废旧操作留下的待派（保留记录便于复盘）。 */
    async voidStaleOperation({ taskRunId, previousOperationId, revision, guard = null }) {
      const out = await taskRuns.mutate(taskRunId, {
        mutate: (current) => {
          const bad = guard?.(current);
          if (bad) return { __reject: bad };
          const list = (current.pendingDispatch ?? []).map((d) =>
            (d.operationId === previousOperationId && d.status === 'pending'
              ? { ...d, status: 'superseded', supersededAt: Date.now(), supersededByRevision: revision }
              : d));
          return { ...current, pendingDispatch: list, updatedAt: Date.now() };
        },
      });
      return out.ok ? { ok: true } : { ok: false, text: out.text };
    },
  };
}

/** 没有注入 guard 时的最小版本校验（不替代统一 guard）。 */
function rejectRevision(current, expectRevision) {
  if (!current) return { ok: false, code: 'not_found', text: '任务不存在' };
  if (expectRevision !== null && expectRevision !== undefined && current.revision !== expectRevision) {
    return {
      ok: false,
      code: 'revision_changed',
      text: `目标已变更（revision ${current.revision} ≠ ${expectRevision}）`,
    };
  }
  return null;
}

/**
 * 确认组织资源真的在盘上。
 *
 * 每次「本操作要用这个部门」之前都要确认一次，而不是只在新建末尾确认。
 */
function confirmPersisted(store, room, leadBotId) {
  if (!room) return { ok: false, text: '部门不存在' };
  if (!store.getBot(leadBotId)) return { ok: false, text: '负责人不存在' };
  if (typeof store.flushNow !== 'function') return { ok: true };
  const flushed = store.flushNow();
  if (!flushed.ok) {
    return { ok: false, text: '部门未能落盘：' + (flushed.text ?? '未知原因') };
  }
  const again = store.getRoom(room.id);
  if (!again) return { ok: false, text: '部门落盘后读不回来' };
  return { ok: true };
}

/**
 * 按操作 ID 找回已创建的部门。
 *
 * 创建时把操作标记写进部门元数据；这是恢复定位点，不依赖名称猜测。
 */
function findDepartmentByOperation(store, operationId) {
  if (!operationId) return null;
  for (const room of store.listRooms?.() ?? []) {
    if (room.kind !== 'group') continue;
    if (room.createdByOperation === operationId) return { room };
  }
  return null;
}

/** 默认建部门：复用 store 的既有能力。 */
function defaultBuildDepartment(store) {
  return (plan, { operationId } = {}) => {
    const spec = plan.departmentSpec;
    if (!spec) return { ok: false, text: '缺少部门规格' };
    try {
      const result = store.createDepartment({
        name: spec.name,
        topic: spec.topic ?? '',
        members: spec.members ?? [],
        // createDepartment 按 name 字符串匹配负责人
        lead: spec.lead || null,
        createdBy: 'chief',
      });
      // 操作标记存专用元数据（不放用户可见的话题里）
      if (operationId && result.room) result.room.createdByOperation = operationId;
      return { ok: true, room: result.room, bots: result.bots ?? [] };
    } catch (err) {
      return { ok: false, text: err?.message || String(err) };
    }
  };
}

/**
 * 默认入队：本批不接真实调度，只做可观察登记。
 *
 * 消费方在批次 05；工具层不 fire-and-forget 调模型。
 */
function defaultEnqueue() {
  return async ({ queueRef }) => ({ ok: true, queueRef, accepted: true, deferred: true });
}

/** 默认通知：可重入唤醒，接收方按 queueRef 去重。 */
function defaultNotify(store) {
  return async ({ departmentId, leadBotId }) => {
    const room = store.getRoom(departmentId);
    if (!room) return { ok: false, text: '部门不存在' };
    const lead = store.getBot(leadBotId);
    if (!lead) return { ok: false, text: '负责人不存在' };
    return { ok: true, deferred: true };
  };
}

export { HANDOFF_STEP };
