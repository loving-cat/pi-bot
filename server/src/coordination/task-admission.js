/**
 * 首次接单准入：同一次理解轮提出，宿主完成首次持久接单与组织交接。
 *
 * 事实顺序：请求 lease → 理解轮 proposal → 一次落盘完整事实（Goal/预算/路由规格/模式/版本/operationId）
 *          → 04 同一组织服务交接（0 次模型）→ 交接完成才算真正接单。
 * 边界：模型只给 proposal；requester/requestId/预算/任务 ID 来自宿主；
 *      理解轮不是受管 attempt；恢复只消费持久事实，不重跑理解。
 */
import { createHash } from 'node:crypto';
import { detectAutonomy } from '../tasks/task-autonomy.js';
import { newId } from '../util.js';
import { createTaskRun, parseIntake } from '../tasks/task-run-factory.js';
import { planIntakeRoute, ROUTE } from './department-policy.js';
import { ensureDepartmentAndAssign } from './department-service.js';
import { createHandoffHost } from './handoff-host.js';

export function admissionFingerprint({ roomId, messageId = null, text = '', attachments = [], mode = 'auto' }) {
  const payload = JSON.stringify({
    roomId: String(roomId ?? ''),
    messageId: messageId ? String(messageId) : null,
    text: String(text ?? ''),
    attachments: (attachments ?? []).map((a) => (typeof a === 'string' ? a : a?.id ?? '')).filter(Boolean).sort(),
    mode: String(mode ?? 'auto'),
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function createRequestScope({
  requesterId, requestId, roomId, messageId = null, text = '', attachments = [], mode = 'auto', at, leaseId = null,
}) {
  if (!requesterId || !requestId || !roomId) return null;
  return Object.freeze({
    requesterId: String(requesterId), requestId: String(requestId), roomId: String(roomId),
    messageId: messageId ? String(messageId) : null,
    fingerprint: admissionFingerprint({ roomId, messageId, text, attachments, mode }),
    text: String(text ?? ''), attachments: Object.freeze((attachments ?? []).slice()),
    mode: String(mode ?? 'auto'), at, leaseId: leaseId ?? null,
  });
}

/**
 * 新任务的根额度。
 *
 * ## 默认**不限额**
 *
 * 用户给一个任务，期望的是「做完为止」，不是「跑 12 次就停」。
 * 之前默认 12 次会让正常任务在半路被判预算暂停 —— 用户看到「额度 11/12」
 * 却不知道这是干什么的，也不知道该不该加。
 *
 * 所以默认 maxRuns=null（不限额）。仍然保留**两道真实的安全网**：
 *   · `concurrencyLimit`：同一个根同时只跑一个执行，防并发；
 *   · 停滞与重复检测：连续多轮没有新进展会明确停下并说明原因。
 *
 * 需要硬上限时由用户显式配置：
 *   · `PI_BOT_TASK_MAX_RUNS`（正整数）→ 所有新任务的根上限；
 *   · 部门预算里的 `maxRuns` → 该部门的根上限（只收紧不放大）。
 */
export function admissionBudget(env = process.env, groupLimits = null) {
  const raw = Number(env.PI_BOT_TASK_MAX_RUNS);
  const envMax = Number.isInteger(raw) && raw > 0 ? raw : null;
  const userMax = Number(groupLimits?.maxRuns);
  const userCap = Number.isInteger(userMax) && userMax > 0 ? userMax : null;
  // 两者都有时取更紧的那个；都没有就是不限额。
  let maxRuns = null;
  if (envMax !== null && userCap !== null) maxRuns = Math.min(envMax, userCap);
  else if (envMax !== null) maxRuns = envMax;
  else if (userCap !== null) maxRuns = userCap;
  return { maxRuns, concurrencyLimit: 1 };
}

export function admissionAuthorize({ taskRunId, revision, requesterId, requestId, fingerprint }) {
  return (snapshot) => {
    if (!snapshot || snapshot.id !== taskRunId) return { ok: false, code: 'admission_invalid', text: '准入任务不存在' };
    if (snapshot.state === 'cancelled') return { ok: false, code: 'admission_terminal', text: '任务已取消，不能继续首次交接' };
    const req = snapshot.request ?? {};
    if (req.requesterId !== requesterId || req.requestId !== requestId) {
      return { ok: false, code: 'admission_invalid', text: '任务请求身份与准入请求不一致' };
    }
    if (req.fingerprint !== fingerprint) return { ok: false, code: 'admission_invalid', text: '任务请求内容指纹与准入请求不一致' };
    if (typeof revision === 'number' && snapshot.revision !== revision) {
      return { ok: false, code: 'admission_stale', text: '准入之后目标版本已变化，不能继续旧交接' };
    }
    return null;
  };
}

function submissionOf(taskRun, admission) {
  return {
    kind: 'admission', source: 'admission', taskRunId: taskRun.id, attemptId: null, botId: null,
    revision: admission.revision, requesterId: admission.requesterId,
    requestId: admission.requestId, fingerprint: admission.fingerprint, acceptedGoal: taskRun.goal,
  };
}

/** 从已持久事实恢复交接：只消费 Goal/路由/版本/operationId，不重新理解。 */
export async function resumeAdmission({ store, taskRuns, taskRun, prepareSpec = null, clock = () => Date.now() }) {
  const admission = taskRun?.admission;
  if (!admission) {
    return { ok: false, accepted: false, taskRunId: taskRun?.id ?? null, code: 'admission_intent_missing', text: '任务没有持久准入意图，不能凭猜测继续' };
  }
  if (admission.status === 'done') {
    return {
      ok: true, accepted: true, duplicate: true, taskRunId: taskRun.id,
      outcome: admission.outcome ?? 'created', departmentId: admission.departmentId ?? null,
      leadBotId: admission.leadBotId ?? null, resumed: false,
    };
  }
  if (admission.status !== 'pending_handoff' && admission.status !== 'handoff_failed') {
    return { ok: false, accepted: false, taskRunId: taskRun.id, code: 'admission_unknown_status', text: '准入意图状态不确定' };
  }
  const routeSpec = admission.routeSpec ?? null;
  if (!routeSpec) {
    return { ok: false, accepted: false, taskRunId: taskRun.id, code: 'admission_route_missing', text: '准入路由规格未持久化' };
  }
  if (routeSpec.route === ROUTE.new && typeof prepareSpec !== 'function') {
    return { ok: false, accepted: false, taskRunId: taskRun.id, code: 'no_spec_preparer', text: '缺少规格准备器' };
  }
  // direct：不建部门，绑定主控为合法执行者，由 05 在用户房间启动
  if (routeSpec.route === ROUTE.direct) {
    const main = store.mainBot();
    if (!main) return { ok: false, accepted: false, taskRunId: taskRun.id, code: 'no_main_bot', text: '找不到主控，不能直接执行' };
    const authorizeDirect = admissionAuthorize({
      taskRunId: taskRun.id, revision: admission.revision,
      requesterId: admission.requesterId, requestId: admission.requestId, fingerprint: admission.fingerprint,
    });
    const written = await taskRuns.mutate(taskRun.id, {
      mutate: (c) => {
        const rejected = c ? authorizeDirect(c) : { ok: false, code: 'task_not_found', text: '任务不存在' };
        if (rejected) return { __reject: rejected };
        return {
          ...c,
          owner: { departmentId: c.origin?.roomId ?? null, roomKind: 'dm', leadBotId: main.id, reportToBotId: null },
          admission: { ...(c.admission ?? {}), status: 'done', outcome: 'direct', leadBotId: main.id, finishedAt: clock() },
          updatedAt: clock(),
        };
      },
    });
    if (!written?.ok) {
      return { ok: false, accepted: false, taskRunId: taskRun.id, code: written?.code ?? 'admission_persist_failed', text: written?.text ?? '直接执行归属未落盘' };
    }
    return { ok: true, accepted: true, taskRunId: taskRun.id, outcome: 'direct', leadBotId: main.id, resumed: true };
  }

  const host = createHandoffHost({ store, taskRuns, deps: {} });
  const authorize = admissionAuthorize({
    taskRunId: taskRun.id, revision: admission.revision,
    requesterId: admission.requesterId, requestId: admission.requestId, fingerprint: admission.fingerprint,
  });
  const out = await ensureDepartmentAndAssign({
    store: taskRuns, submission: submissionOf(taskRun, admission), plan: routeSpec, host,
    at: clock(), createOnly: admission.createOnly === true, authorize,
    operationId: admission.operationId ?? null,
  });
  if (!out.ok) {
    const failed = await taskRuns.mutate(taskRun.id, {
      mutate: (c) => (c ? { ...c, admission: { ...(c.admission ?? {}), status: 'handoff_failed', error: String(out.text ?? out.code ?? '').slice(0, 300) }, updatedAt: clock() } : null),
    });
    return { ok: false, accepted: false, taskRunId: taskRun.id, code: out.code, text: out.text, step: out.step, persisted: failed?.ok === true };
  }
  const outcome = routeSpec.route === ROUTE.new ? 'created' : 'existing';
  const createOnly = admission.createOnly === true;
  const department = out.departmentId ? store.getRoom(out.departmentId) : null;
  const receipt = createOnly
    ? '已按你的要求创建部门「' + (department?.name ?? out.departmentId ?? '') + '」，没有派发执行任务。'
    : null;
  const done = await taskRuns.mutate(taskRun.id, {
    mutate: (c) => {
      if (!c) return { __reject: { ok: false, code: 'task_not_found', text: '任务不存在' } };
      // 旧操作只能完成冻结版本：当前记录必须仍匹配请求身份/版本/操作/模式
      const rejected = authorize(c);
      if (rejected) return { __reject: rejected };
      const frozen = c.admission ?? {};
      if (frozen.revision !== admission.revision
        || (admission.operationId && frozen.operationId !== admission.operationId)
        || (admission.operationId && out.operationId && out.operationId !== admission.operationId)
        || Boolean(frozen.createOnly) !== createOnly) {
        return { __reject: { ok: false, code: 'admission_stale', text: '旧准入操作不能完成已更新的目标' } };
      }
      const base = {
        ...c,
        admission: { ...(c.admission ?? {}), status: 'done', outcome, operationId: out.operationId ?? c.admission?.operationId ?? null, departmentId: out.departmentId ?? null, leadBotId: out.leadBotId ?? null, finishedAt: clock() },
        owner: {
          ...(c.owner ?? {}), roomKind: 'group',
          departmentId: out.departmentId ?? null, leadBotId: out.leadBotId ?? null,
        },
        updatedAt: clock(),
      };
      if (!createOnly) return base;
      // 仅建组：以可验证的主机建组收据终结容器任务，不伪造模型执行/报告
      return {
        ...base,
        state: 'completed',
        flags: { ...(base.flags ?? {}), completedAt: clock() },
        delivery: { summary: receipt, at: clock(), revision: admission.revision, source: 'host_department_receipt' },
        progress: { ...(base.progress ?? {}), checkpoint: '部门已创建', unmet: [] },
      };
    },
  });
  if (!done?.ok) {
    if (done?.code === 'admission_stale') {
      // 旧操作成果（已建部门）保留，但明确标记为过期，不覆盖新目标
      await taskRuns.mutate(taskRun.id, {
        mutate: (c) => (c ? {
          ...c,
          admission: { ...(c.admission ?? {}), status: 'stale', staleAt: clock() },
          updatedAt: clock(),
        } : null),
      });
    }
    return {
      ok: false, accepted: false, taskRunId: taskRun.id, outcome,
      code: done?.code ?? 'admission_persist_failed',
      text: done?.text ?? '准入完成提交失败',
      departmentId: out.departmentId ?? null, leadBotId: out.leadBotId ?? null,
      createOnly, persisted: false,
    };
  }
  return {
    ok: true, accepted: true, taskRunId: taskRun.id, outcome,
    departmentId: out.departmentId ?? null, leadBotId: out.leadBotId ?? null,
    queueRef: out.queueRef ?? null, createOnly,
    resumed: true, intentPersisted: true,
  };
}

export function findAdmittedTask({ taskRuns, requesterId, requestId }) {
  const found = taskRuns?.findByRequest?.(requesterId, requestId);
  if (found?.status === 'found') return { status: 'found', taskRun: found.taskRun };
  if (found?.status === 'indeterminate') return { status: 'indeterminate' };
  return { status: 'absent' };
}

/** 首次接单：proposal → 一次落盘完整事实 → 组织交接。 */
export async function admitFirstTask({
  store, taskRuns, receipts, scope, proposal, prepareSpec = null, clock = () => Date.now(),
}) {
  if (!scope) return { ok: false, code: 'no_request_scope', text: '没有可信的请求作用域' };
  if (!taskRuns || !receipts) return { ok: false, code: 'bad_host', text: '缺少存储' };

  const existingTask = findAdmittedTask({ taskRuns, requesterId: scope.requesterId, requestId: scope.requestId });
  if (existingTask.status === 'indeterminate') return { ok: false, code: 'lookup_indeterminate', text: '无法确认请求是否已受理，拒绝继续' };
  if (existingTask.status === 'found') {
    const run = existingTask.taskRun;
    if (run.request?.fingerprint !== scope.fingerprint) return { ok: false, code: 'request_conflict', text: '任务记录的内容指纹与请求不一致' };
    return resumeAdmission({ store, taskRuns, taskRun: run, prepareSpec, clock });
  }

  const recovered = receipts.recover({ requesterId: scope.requesterId, requestId: scope.requestId, fingerprint: scope.fingerprint, taskRuns: null });
  if (recovered.status === 'corrupt') return { ok: false, code: recovered.code, text: recovered.text };
  if (recovered.status === 'conflict') return { ok: false, code: recovered.code, text: recovered.text };
  if (recovered.status === 'done' && (recovered.receipt.stage === 'answered' || recovered.receipt.stage === 'failed')) {
    return { ok: true, duplicate: true, accepted: false, kind: recovered.receipt.kind ?? null, stage: recovered.receipt.stage };
  }
  if (recovered.status === 'inflight') {
    if (!scope.leaseId || recovered.receipt?.leaseId !== scope.leaseId) {
      return { ok: true, duplicate: true, accepted: false, kind: 'inflight', taskRunId: null, stage: 'running' };
    }
  }

  // 只建部门但没有业务目标：由宿主补一个“不执行”的容器目标，语义仍是 createOnly
  let effectiveProposal = proposal ?? {};
  if (effectiveProposal.kind === 'accept_task' && effectiveProposal.routing?.departmentOnly === true && !effectiveProposal.goal) {
    effectiveProposal = {
      ...effectiveProposal,
      goal: { requirement: '仅创建部门（不执行任务）', verification: [{ kind: 'expert', description: '部门创建完成' }] },
    };
  }

  const parsed = parseIntake(effectiveProposal);
  if (!parsed.ok) return { ok: false, code: 'bad_proposal', text: parsed.text };
  const { intake } = parsed;
  let acceptedTaskId = null;
  const finishReceipt = ({ stage, kind = intake.kind, error = null }) => receipts.finish({
    requesterId: scope.requesterId, requestId: scope.requestId, fingerprint: scope.fingerprint,
    stage, kind, error, taskRunId: acceptedTaskId,
  });

  // 用户明确只讨论：宿主可信模式优先于模型提案，不建任务不建组不派执行
  if (scope.mode === 'discussion') {
    const written = finishReceipt({ stage: 'answered', kind: 'discussion' });
    if (!written.ok) return { ok: false, code: written.code, text: written.text };
    return { ok: true, accepted: false, kind: 'discussion', text: '用户明确只讨论，未创建任务。', outcome: 'discussion' };
  }

  if (intake.kind !== 'accept_task') {
    const written = finishReceipt({ stage: 'answered' });
    if (!written.ok) return { ok: false, code: written.code, text: written.text };
    return { ok: true, accepted: false, kind: intake.kind, text: intake.text ?? '', outcome: intake.kind };
  }

  const candidate = intake.routing?.type === 'existing'
    ? [describeDepartment(store, intake.routing.departmentId)].filter(Boolean) : [];
  const plan = planIntakeRoute({ intake, candidateDepartments: candidate, explicitRoute: null, userWantsDiscussion: scope.mode === 'discussion' });
  if (!plan.ok) return { ok: false, code: plan.code, text: plan.text };
  let effectivePlan = plan;
  if (plan.route === ROUTE.new) {
    if (typeof prepareSpec !== 'function') return { ok: false, code: 'no_spec_preparer', text: '缺少规格准备器，不能创建部门' };
    const prepared = prepareSpec(plan.departmentSpec ?? {});
    if (!prepared.ok) return { ok: false, code: prepared.code, text: prepared.text };
    effectivePlan = { ...plan, departmentSpec: prepared.spec };
  }

  // 专业验收能力边界：支持真实部门负责人（含单成员部门），不支持 DM direct。
  // 在接单阶段明确拒绝并终结回执，不能接受后靠 expert needsReview 空转烧预算。
  const expertConditions = (intake.goal?.verification ?? []).filter((c) => c?.kind === 'expert' && c?.required !== false);
  if (expertConditions.length && plan.execute === true && plan.createOnly !== true) {
    let why = null;
    if (effectivePlan.route === ROUTE.direct) {
      why = '私聊 direct 暂不支持 expert 专业验收条件；请交给部门负责人，或删除 expert 条件。';
    } else if (effectivePlan.route === ROUTE.existing) {
      const dept = store.getRoom(effectivePlan.departmentId);
      if (!dept?.leadBotId) why = '目标部门没有真实负责人，不能承担 expert 专业验收。';
    }
    if (why) {
      finishReceipt({ stage: 'failed', error: 'EXPERT_ROUTE_UNSUPPORTED' });
      return { ok: false, code: 'expert_route_unsupported', text: why };
    }
  }

  if (plan.execute !== true && plan.createOnly !== true) {
    const written = finishReceipt({ stage: 'answered' });
    if (!written.ok) return { ok: false, code: written.code, text: written.text };
    return { ok: true, accepted: false, kind: 'answer', text: plan.text ?? '这次不需要执行。', outcome: plan.reason ?? 'skipped' };
  }

  const at = clock();
  const id = newId('tr_');
  // 用户说「一直干到有结果 / 不用问我」→ 这个任务自己推进，不因等确认停下。
  const autonomy = detectAutonomy(scope.text ?? '');
  const built = createTaskRun({
    id, requestId: scope.requestId, requesterId: scope.requesterId,
    goal: intake.goal ?? {},
    origin: { roomId: scope.roomId, messageId: scope.messageId, requesterId: scope.requesterId },
    budget: admissionBudget(process.env, store.groupLimits?.() ?? null), at,
    autonomous: autonomy.autonomous,
    autonomyReason: autonomy.reason,
  });
  if (!built.ok) return { ok: false, code: 'bad_goal', text: built.text };

  const admissionIntent = {
    status: 'pending_handoff', requesterId: scope.requesterId, requestId: scope.requestId,
    fingerprint: scope.fingerprint, roomId: scope.roomId, revision: 1,
    operationId: newId('hop_'), route: effectivePlan.route ?? null, routeSpec: effectivePlan,
    createOnly: effectivePlan.createOnly === true, execute: effectivePlan.execute === true,
    mode: scope.mode, at,
  };
  const taskWithIntent = { ...built.taskRun, admission: admissionIntent };
  const accepted = await taskRuns.acceptRequest({
    requesterId: scope.requesterId, requestId: scope.requestId, fingerprint: scope.fingerprint,
    build: () => taskWithIntent, at,
  });
  if (!accepted.ok) return accepted;
  const taskRun = accepted.taskRun;
  acceptedTaskId = taskRun.id;
  if (accepted.created !== true) {
    const fresh = taskRuns.read(taskRun.id)?.taskRun ?? taskRun;
    if (!fresh.admission) return { ok: false, accepted: false, taskRunId: fresh.id, code: 'admission_intent_missing', text: '同一请求的任务缺少持久准入意图' };
    return resumeAdmission({ store, taskRuns, taskRun: fresh, prepareSpec, clock });
  }

  const receiptPersisted = finishReceipt({ stage: 'accepted' }).ok === true;

  const fresh = taskRuns.read(taskRun.id)?.taskRun ?? taskWithIntent;
  const out = await resumeAdmission({ store, taskRuns, taskRun: fresh, prepareSpec, clock });
  return { ...out, duplicate: false, receiptPersisted };
}

export const ADMISSION = Object.freeze({
  status: Object.freeze({ pending: 'pending_handoff', done: 'done', failed: 'handoff_failed' }),
});

function describeDepartment(store, id) {
  const room = id ? store.getRoom(id) : null;
  if (!room || room.kind !== 'group') return null;
  return { id: room.id, name: room.name ?? '', topic: room.topic ?? '', leadBotId: room.leadBotId ?? null };
}
