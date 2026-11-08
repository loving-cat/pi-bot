/**
 * 部门服务：**唯一的「建组 + 交接」操作服务**。
 *
 * ## 要解决的问题
 *
 * 「建一个部门，然后把活交给负责人」横跨多个文件写入：
 * 建 Bot、建群、写 TaskRun 绑定、落盘待派动作、通知负责人。
 * 这些**不是一个事务**，中途崩溃会留下半成品。
 *
 * ## 做法：操作 ID + 冻结意图 + 同操作串行
 *
 * 操作 ID 在持久意图创建时确定，与执行尝试无关：
 * 普通重试复用同一操作；目标版本变化时新版本认领自己的操作，旧待派作废。
 *
 * 意图一次冻结**完整目标、plan、模式（create_only/assign）、版本、操作 ID**；
 * 恢复只消费冻结值。
 *
 * ## 授权
 *
 * 入口、每个异步边界、以及宿主写事务内都调用同一个
 * `revalidateManaged`（复用 resolveManagedContext 的完整判定），
 * 不各自维护宽松的状态列表。
 */
import { revalidateManaged } from './task-context.js';

/** 交接进度。 */
export const HANDOFF_STEP = Object.freeze({
  intent: 'intent',
  department: 'department',
  bound: 'bound',
  queued: 'queued',
  notified: 'notified',
  done: 'done',
});

/** 交接失败原因。 */
export const HANDOFF_FAIL = Object.freeze({
  noGoal: 'no_goal',
  departmentFailed: 'department_failed',
  bindFailed: 'bind_failed',
  queueFailed: 'queue_failed',
  notifyFailed: 'notify_failed',
  persistFailed: 'persist_failed',
  taskCancelled: 'task_cancelled',
  revisionChanged: 'revision_changed',
  missingSubmission: 'missing_submission',
  resourceMissing: 'resource_missing',
});

const STEP_ORDER = [
  HANDOFF_STEP.intent,
  HANDOFF_STEP.department,
  HANDOFF_STEP.bound,
  HANDOFF_STEP.queued,
  HANDOFF_STEP.notified,
  HANDOFF_STEP.done,
];

/** 同一个操作在本进程内串行。 */
const inFlight = new Map();

/**
 * 生成一个业务操作 ID。
 *
 * 只在**新建交接意图**时调用；重试从已存记录里读，不重算。
 */
export function newOperationId(taskRunId, revision, seq = 0) {
  const safe = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '');
  return `ho_${safe(taskRunId)}_r${safe(revision)}_${safe(seq)}`;
}

/**
 * 读一份交接记录，判断从哪一步继续。
 *
 * @param {object|null} handoff
 * @param {number} revision 这次提交所依据的目标版本
 * @returns {{fresh:boolean, operationId:string|null, step:string|null,
 *   departmentId:string|null, leadBotId:string|null, queueRef:string|null,
 *   staleOperation:boolean, previousOperationId?:string|null, createOnly:boolean|null}}
 */
export function resolveHandoffProgress(handoff, revision) {
  if (!handoff || !handoff.operationId) {
    return {
      fresh: true,
      operationId: null,
      step: null,
      departmentId: null,
      leadBotId: null,
      queueRef: null,
      staleOperation: false,
      createOnly: null,
    };
  }

  // 旧版本留下的操作：不属于这次提交。新版本认领自己的操作，旧待派另行作废。
  if (handoff.revision !== revision) {
    return {
      fresh: true,
      operationId: null,
      step: null,
      departmentId: null,
      leadBotId: null,
      queueRef: null,
      staleOperation: true,
      previousOperationId: handoff.operationId,
      createOnly: null,
    };
  }

  return {
    fresh: false,
    operationId: handoff.operationId,
    step: handoff.step ?? null,
    departmentId: handoff.departmentId ?? null,
    leadBotId: handoff.leadBotId ?? null,
    queueRef: handoff.queueRef ?? null,
    staleOperation: false,
    createOnly: typeof handoff.createOnly === 'boolean' ? handoff.createOnly : null,
  };
}

/** 这一步是否已经做过。 */
export function stepDone(progress, step) {
  if (progress.step === null || progress.step === undefined) return false;
  const at = STEP_ORDER.indexOf(progress.step);
  const want = STEP_ORDER.indexOf(step);
  if (at < 0 || want < 0) return false;
  return at >= want;
}

/**
 * **幂等交接**：确保「部门就绪 + 负责人拿到活」。
 *
 * @param {object} p
 * @param {object} p.store TaskRunStore
 * @param {object} p.submission 已核实的受管提交（taskRunId/attemptId/revision/botId）
 * @param {object} p.plan 路由结果（首次成功时冻结进意图）
 * @param {object} p.host 宿主能力
 * @param {boolean} [p.createOnly] 只建组：不绑定、不入队、不通知（首次成功后冻结）
 * @param {number} [p.at]
 * @returns {Promise<object>}
 */
export async function ensureDepartmentAndAssign({
  store,
  submission,
  plan,
  host,
  at = Date.now(),
  createOnly = false,
  /**
   * 冻结的操作 ID（首次准入在接单事实里一起落盘）。不给则按版本新建。
   */
  operationId = null,
  /**
   * 授权包装（固定来源）。
   *
   * 受管执行传 null（用 revalidateManaged 的 attempt/root grant 完整校验）；
   * 首次准入传 admissionAuthorize（只认持久请求回执 + TaskRun 接受事实）。
   * 两者不互通，模型/客户端不能选择模式。
   */
  authorize = null,
} = {}) {
  const fail = (code, text, extra = {}) => ({ ok: false, code, text, ...extra });

  if (!store?.read) return fail('bad_store', '缺少存储');
  if (!host) return fail('bad_host', '缺少宿主能力');
  if (!isSubmission(submission)) {
    return fail(HANDOFF_FAIL.missingSubmission, '缺少可信的受管提交上下文');
  }

  const revision = submission.revision;
  const first = await store.read(submission.taskRunId);
  if (first.status !== 'found' || !first.taskRun) {
    return fail('task_not_found', `找不到任务 ${submission.taskRunId}`);
  }

  const progress0 = resolveHandoffProgress(first.taskRun.handoff, revision);
  const effectiveOperationId = operationId ?? progress0.operationId ?? newOperationId(submission.taskRunId, revision);
  const key = `${submission.taskRunId}::${effectiveOperationId}`;

  // 同操作串行：并发调用排队，后到者排队后重读进度
  const previous = inFlight.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((r) => (release = r));
  const chained = previous.then(() => gate);
  inFlight.set(key, chained);

  await previous.catch(() => {});
  try {
    return await runHandoff({
      store, submission, plan, host, at, operationId: effectiveOperationId, createOnly, fail, authorize,
    });
  } finally {
    release();
    if (inFlight.get(key) === chained) inFlight.delete(key);
  }
}

/** 真正执行交接（已在同操作串行区内）。 */
async function runHandoff({
  store, submission, plan, host, at, operationId, createOnly, fail, authorize = null,
}) {
  const revision = submission.revision;
  const { taskRunId, attemptId } = submission;

  /** 统一 guard：两条固定来源各自校验，不能互相借用。 */
  const guard = typeof authorize === 'function'
    ? (snapshot) => authorize(snapshot)
    : (snapshot) => revalidateManaged(snapshot, {
        taskRuns: store,
        expectRevision: revision,
        attemptId,
        botId: submission.botId,
        roomId: submission.roomId ?? null,
      });

  /** 重读并复核；返回 null 表示仍然有效。 */
  const recheck = async () => {
    const again = await store.read(taskRunId);
    if (again.status !== 'found' || !again.taskRun) {
      return { ok: false, code: 'task_not_found', text: '任务在交接过程中消失' };
    }
    const bad = guard(again.taskRun);
    return bad ? { ...bad } : null;
  };

  // ---- 串行区内重读
  const read = await store.read(taskRunId);
  if (read.status !== 'found' || !read.taskRun) {
    return fail('task_not_found', `找不到任务 ${taskRunId}`);
  }
  const taskRun = read.taskRun;

  // ---- 入口授权
  const entryBad = guard(taskRun);
  if (entryBad) return { ...entryBad };

  // ---- 目标必须来自**已接受任务**：模型另给的目标不能替换工作内容
  const acceptedGoal = taskRun.goal ?? null;
  if (!acceptedGoal) return fail(HANDOFF_FAIL.noGoal, '任务没有已接受的目标，不能派活');

  const progress = resolveHandoffProgress(taskRun.handoff, revision);
  const resumed = !progress.fresh;
  const frozen = taskRun.handoff ?? null;

  // 版本变化：旧操作作废，这是新版本自己的操作
  if (progress.staleOperation && progress.previousOperationId) {
    const voided = await host.voidStaleOperation?.({
      taskRunId, previousOperationId: progress.previousOperationId, revision, guard,
    });
    if (voided && voided.ok === false) {
      return fail(HANDOFF_FAIL.persistFailed, `旧待派未能作废：${voided.text ?? '未知原因'}`);
    }
  }

  // ---- 冻结值优先：恢复只消费持久意图
  const effectivePlan = resumed && frozen
    ? {
        route: frozen.route ?? plan?.route,
        departmentSpec: frozen.departmentSpec ?? plan?.departmentSpec,
        departmentId: frozen.departmentId ?? plan?.departmentId,
      }
    : plan;
  // 模式在意图创建时冻结；重试换入口不能改变既有操作含义
  const effectiveCreateOnly =
    resumed && progress.createOnly !== null ? progress.createOnly : createOnly === true;

  /** 记录一步进度（失败就停）。 */
  const record = async (step, patch = {}) => {
    const written = await host.patchHandoff(taskRunId, {
      operationId,
      revision,
      taskRunId,
      attemptId,
      step,
      at,
      ...patch,
    }, { guard });
    if (!written?.ok) {
      return fail(HANDOFF_FAIL.persistFailed, `交接进度未落盘：${written?.text ?? '未知原因'}`, { step });
    }
    return null;
  };

  let departmentId = progress.departmentId;
  let leadBotId = progress.leadBotId;
  let queueRef = progress.queueRef;

  // ---- 已经完成过的操作：验证引用资源仍在，不能凭 done 字段宣称成功
  if (stepDone(progress, HANDOFF_STEP.done)) {
    const alive = await host.confirmResource?.({ departmentId, leadBotId });
    if (alive && alive.ok === false) {
      return fail(alive.code ?? HANDOFF_FAIL.resourceMissing, alive.text ?? '交接引用的资源已不存在', {
        step: HANDOFF_STEP.done, departmentId, leadBotId,
      });
    }
    return {
      ok: true, step: HANDOFF_STEP.done, departmentId, leadBotId, queueRef,
      operationId, resumed: true, createOnly: effectiveCreateOnly,
    };
  }

  // ---- 1. 意图（冻结完整 plan、目标、模式、版本）
  if (!stepDone(progress, HANDOFF_STEP.intent)) {
    const err = await record(HANDOFF_STEP.intent, {
      route: effectivePlan?.route ?? null,
      departmentSpec: effectivePlan?.departmentSpec ?? null,
      departmentId: effectivePlan?.departmentId ?? null,
      goalRequirement: acceptedGoal.requirement ?? '',
      acceptedGoal,
      createOnly: effectiveCreateOnly,
    });
    if (err) return err;
  }

  // ---- 2. 部门（副作用前再复核一次）
  if (!stepDone(progress, HANDOFF_STEP.department) || !departmentId) {
    const beforeCreate = await recheck();
    if (beforeCreate) return { ...beforeCreate, departmentId, leadBotId };

    const ensured = await host.ensureDepartment(effectivePlan, { operationId });
    if (!ensured?.ok || !ensured.departmentId || !ensured.leadBotId) {
      return fail(HANDOFF_FAIL.departmentFailed, `部门未能就绪：${ensured?.text ?? '未知原因'}`, {
        step: HANDOFF_STEP.intent,
      });
    }
    departmentId = ensured.departmentId;
    leadBotId = ensured.leadBotId;

    // 建组期间可能被取消或被改目标
    const stale = await recheck();
    if (stale) return { ...stale, departmentId, leadBotId };

    const err = await record(HANDOFF_STEP.department, { departmentId, leadBotId });
    if (err) return err;
  }

  // ---- 只建组：到这里就结束，不绑定不派活
  if (effectiveCreateOnly) {
    const alive = await host.confirmResource?.({ departmentId, leadBotId });
    if (alive && alive.ok === false) {
      return fail(alive.code ?? HANDOFF_FAIL.resourceMissing, alive.text ?? '部门资源不存在', {
        step: HANDOFF_STEP.department, departmentId, leadBotId,
      });
    }
    const doneOnly = await record(HANDOFF_STEP.done, {
      departmentId, leadBotId, createOnly: true, acceptedGoal,
    });
    if (doneOnly) return doneOnly;
    return {
      ok: true, step: HANDOFF_STEP.done, departmentId, leadBotId,
      operationId, resumed, createOnly: true,
    };
  }

  // ---- 3. 绑定（事务内用当前快照复核）
  if (!stepDone(progress, HANDOFF_STEP.bound)) {
    const bound = await host.bindTaskToDepartment({
      taskRunId, goal: acceptedGoal, departmentId, leadBotId, expectRevision: revision, guard,
    });
    if (!bound?.ok) {
      return fail(bound.code ?? HANDOFF_FAIL.bindFailed, `任务未能绑定到部门：${bound?.text ?? '未知原因'}`, {
        step: HANDOFF_STEP.department, departmentId, leadBotId,
      });
    }
    const stale = await recheck();
    if (stale) return { ...stale, departmentId, leadBotId };

    const err = await record(HANDOFF_STEP.bound, { departmentId, leadBotId });
    if (err) return err;
  }

  // ---- 4. 待派动作（事务内用当前快照复核）
  if (!stepDone(progress, HANDOFF_STEP.queued) || !queueRef) {
    const queued = await host.enqueueDispatch({
      taskRunId, attemptId, departmentId, leadBotId, goal: acceptedGoal,
      operationId, expectRevision: revision, guard,
    });
    if (!queued?.ok || !queued.queueRef) {
      return fail(queued?.code ?? HANDOFF_FAIL.queueFailed, `待派动作未能落盘：${queued?.text ?? '未知原因'}`, {
        step: HANDOFF_STEP.bound, departmentId, leadBotId,
      });
    }
    queueRef = queued.queueRef;

    // 待派已写之后被取消：不能继续通知，更不能报成功
    const stale = await recheck();
    if (stale) return { ...stale, departmentId, leadBotId, queueRef };

    const err = await record(HANDOFF_STEP.queued, { departmentId, leadBotId, queueRef });
    if (err) return err;
  }

  // ---- 5. 通知（通知前再复核：取消后不得继续推进）
  if (!stepDone(progress, HANDOFF_STEP.notified)) {
    const stale = await recheck();
    if (stale) return { ...stale, departmentId, leadBotId, queueRef };

    const notified = await host.notifyLead({ queueRef, departmentId, leadBotId });
    if (!notified?.ok) {
      return fail(HANDOFF_FAIL.notifyFailed, `负责人未被通知：${notified?.text ?? '未知原因'}`, {
        step: HANDOFF_STEP.queued, departmentId, leadBotId, queueRef,
      });
    }
    const err = await record(HANDOFF_STEP.notified, { departmentId, leadBotId, queueRef });
    if (err) return err;
  }

  // ---- 6. 完成：先确认资源仍在，再落 done
  const alive = await host.confirmResource?.({ departmentId, leadBotId });
  if (alive && alive.ok === false) {
    return fail(alive.code ?? HANDOFF_FAIL.resourceMissing, alive.text ?? '交接引用的资源已不存在', {
      step: HANDOFF_STEP.queued, departmentId, leadBotId, queueRef,
    });
  }

  const doneErr = await record(HANDOFF_STEP.done, { departmentId, leadBotId, queueRef });
  if (doneErr) return doneErr;

  return {
    ok: true, step: HANDOFF_STEP.done, departmentId, leadBotId, queueRef,
    operationId, resumed, createOnly: false,
  };
}

function isSubmission(submission) {
  if (submission?.source === 'admission' || submission?.kind === 'admission') {
    // 首次准入：没有 attempt / bot，但必须有持久请求身份与版本
    return Boolean(
      submission
      && typeof submission.taskRunId === 'string'
      && Number.isInteger(submission.revision)
      && typeof submission.requesterId === 'string'
      && typeof submission.requestId === 'string'
      && typeof submission.fingerprint === 'string',
    );
  }
  return Boolean(
    submission
    && typeof submission.taskRunId === 'string'
    && typeof submission.attemptId === 'string'
    && typeof submission.botId === 'string'
    && Number.isInteger(submission.revision),
  );
}

