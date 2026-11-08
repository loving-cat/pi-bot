/**
 * 受管提交上下文：从**实际执行作用域**取可信身份，并复用统一授权判定。
 *
 * ## 为什么要单独一层
 *
 * 工具层只应该知道「这次是受管还是 legacy」；真正的核对（任务、尝试、
 * Bot、版本、根授权）已经有 `resolveManagedContext` 一份实现。
 * 这里把它接成两个用途相同的东西：
 *
 *   · `readManagedSubmission`：入口取身份 + 已接受目标；
 *   · `revalidateManaged`：在异步边界与写事务内用**当前快照**再判一次。
 *
 * 两者共用同一判定，避免服务层和宿主各自写一套宽松检查。
 *
 * ## 三态
 *
 *   · `legacy`  —— 真的没有受管上下文，调用方走既有旧路径；
 *   · `managed` —— 核对通过，含可信版本与已接受目标；
 *   · `invalid` —— 提供了但过期/残缺/已取消，**必须拒绝**，不能回退 legacy。
 */
import { resolveManagedContext, MANAGED } from '../tasks/task-progress.js';

/** 提交上下文三态。 */
export const SUBMISSION = Object.freeze({
  legacy: 'legacy',
  managed: 'managed',
  invalid: 'invalid',
});

/**
 * 读一次受管提交事实。
 *
 * @param {object} p
 * @param {object} p.runner PiRunner（提供 currentTaskContext）
 * @param {object} p.taskRuns TaskRunStore
 * @param {string} p.roomId
 * @param {string} p.botId
 * @returns {{kind:string, code?:string, text?:string, taskRunId?:string, attemptId?:string,
 *   revision?:number, rootTaskId?:string, botId?:string, acceptedGoal?:object|null,
 *   candidateDepartmentIds?:string[]}}
 */
export function readManagedSubmission({ runner, taskRuns, roomId, botId,
  /**
   * 可选：调用方明确要求的任务/尝试。
   *
   * ★ 不传就只能拿到「这个 (room,bot) 当前挂着的那个上下文」——
   *   调用方无法断言「我要的是不是这一条」。带 @ 的写计划/派活工具
   *   因此可能作用到别的任务上。传了就严格核对。
   */
  expectedTaskRunId = null,
  expectedAttemptId = null,
} = {}) {
  const raw = runner.currentTaskContext?.(roomId, botId) ?? null;
  if (raw === null || raw === undefined) return { kind: SUBMISSION.legacy };

  // 调用方点名要哪条：对不上就是失效，不能"凑合着用当前这条"
  if (expectedTaskRunId && raw.taskRunId !== expectedTaskRunId) {
    return {
      kind: SUBMISSION.invalid,
      code: 'task_context_mismatch',
      text: '当前执行上下文属于任务 ' + raw.taskRunId + '，不是 ' + expectedTaskRunId,
    };
  }
  if (expectedAttemptId && raw.attemptId !== expectedAttemptId) {
    return {
      kind: SUBMISSION.invalid,
      code: 'attempt_context_mismatch',
      text: '当前执行上下文属于尝试 ' + raw.attemptId + '，不是 ' + expectedAttemptId,
    };
  }

  const verdict = resolveManagedContext(
    {
      taskRunId: raw.taskRunId,
      revision: raw.revision,
      attemptId: raw.attemptId,
      botId: raw.botId ?? botId,
    },
    {
      ...loaders(taskRuns, botId),
      // ★ 把房间带上：受管上下文必须绑定任务所属部门，
      //   否则部门 B 的会话能给部门 A 的任务写计划。
      actualRoomId: roomId ?? null,
    },
  );
  if (verdict.kind !== MANAGED.managed) {
    return {
      kind: SUBMISSION.invalid,
      code: verdict.code ?? 'managed_invalid',
      text: verdict.text ?? '这次执行没有有效的受管授权',
    };
  }

  const ctx = verdict.context;
  const loaded = taskRuns.read(ctx.taskRunId);
  const taskRun = loaded?.status === 'found' ? loaded.taskRun : null;
  if (!taskRun) {
    return { kind: SUBMISSION.invalid, code: 'task_not_found', text: '存储里没有这个任务' };
  }
  if (!taskRun.goal) {
    return { kind: SUBMISSION.invalid, code: 'no_accepted_goal', text: '任务没有已接受的目标' };
  }

  return {
    kind: SUBMISSION.managed,
    taskRunId: ctx.taskRunId,
    attemptId: ctx.attemptId,
    revision: ctx.revision,
    rootTaskId: ctx.rootTaskId,
    botId: ctx.botId,
    acceptedGoal: taskRun.goal,
    candidateDepartmentIds: Array.isArray(raw.candidateDepartmentIds)
      ? raw.candidateDepartmentIds
      : [],
  };
}

/**
 * 用**当前快照**复核一次受管授权。
 *
 * 入口、每个异步边界、以及宿主写事务内都用它 —— 判定只有一份，
 * 不各自维护「哪些状态算在途」的数组。
 *
 * @returns {null|{ok:false, code:string, text:string}} null 表示仍然有效
 */
export function revalidateManaged(taskRunSnapshot, {
  taskRuns, expectRevision, attemptId, botId, roomId = null,
} = {}) {
  if (!taskRunSnapshot) {
    return { ok: false, code: 'task_not_found', text: '任务不存在' };
  }
  const id = taskRunSnapshot.id;
  // 当前 Task 与「根就是它自己」的情况用调用方给的快照；其他根仍读真实记录
  const asRecord = (wantId) => (wantId === id
    ? { status: 'found', taskRun: taskRunSnapshot }
    : taskRuns.read(wantId));
  const verdict = resolveManagedContext(
    {
      taskRunId: id,
      revision: expectRevision,
      attemptId,
      botId,
    },
    {
      loadTaskRun: asRecord,
      loadRootTaskRun: asRecord,
      actualBotId: botId,
      actualRoomId: roomId,
    },
  );
  if (verdict.kind !== MANAGED.managed) {
    return {
      ok: false,
      code: verdict.code ?? 'managed_invalid',
      text: verdict.text ?? '这次执行的授权已失效',
    };
  }
  return null;
}

function loaders(taskRuns, botId) {
  return {
    loadTaskRun: (id) => taskRuns.read(id),
    loadRootTaskRun: (id) => taskRuns.read(id),
    actualBotId: botId,
  };
}
