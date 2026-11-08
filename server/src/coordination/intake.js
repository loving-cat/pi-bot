/**
 * 接单应用入口：工具层唯一的业务入口。
 *
 * ## 职责
 *
 * 把「一次可信提交 + 一个动作」翻成路由判定和部门服务调用：
 *
 *   · `accept`            —— 主控提交的接单结构（direct / existing / new / 只建组）；
 *   · `create_department` —— 建组（正常或模板已展开成规格）；
 *   · `dispatch_existing` —— 派给已有部门。
 *
 * 三个动作共用同一个操作服务，因此认领、幂等、取消复核、持久确认、
 * 冻结目标与模式都只有一份实现。
 *
 * ## 不做什么
 *
 *   · 不读用户原话、不判断意图（那是这一轮模型调用的事）；
 *   · 不自己建 Bot/群（副作用只在服务里）；
 *   · 不接受模型自报的 requester、预算、taskRunId 或目标。
 */
import { planIntakeRoute, ROUTE, NO_EXECUTION } from './department-policy.js';
import { ensureDepartmentAndAssign } from './department-service.js';
import { createHandoffHost } from './handoff-host.js';
import { SUBMISSION } from './task-context.js';

/** 工具可以提交的动作。 */
export const ACTION = Object.freeze({
  accept: 'accept',
  createDepartment: 'create_department',
  dispatchExisting: 'dispatch_existing',
});

/** 接单结果类型。 */
export const INTAKE_OUTCOME = Object.freeze({
  skipped: 'skipped',
  direct: 'direct',
  existing: 'existing',
  created: 'created',
});

/**
 * 处理一次已核实的提交。
 *
 * @param {object} p
 * @param {object} p.action 动作（见 ACTION）
 * @param {object} p.submission readManagedSubmission 的结果（必须是 managed）
 * @param {object} p.store 应用 store
 * @param {object} p.taskRuns TaskRunStore
 * @param {object|null} [p.host] 交接宿主（不传就按 store 建一个）
 * @param {object} [p.deps] 注入依赖（测试用假执行/假队列）
 * @returns {Promise<{ok:boolean, outcome:string, ...}>}
 */
export async function handleIntake({
  action,
  submission,
  store,
  taskRuns,
  host = null,
  deps = {},
  /**
   * 只读规格准备器（宿主注入）。
   *
   * 所有需要创建部门的动作都先过它：模型可分配性、同名冲突、能力字段
   * 只在这一处判定，入口不再各写一套校验。缺它就拒绝创建，不放行。
   */
  prepareSpec = null,
} = {}) {
  if (!submission || submission.kind !== SUBMISSION.managed) {
    return {
      ok: false,
      outcome: INTAKE_OUTCOME.skipped,
      code: submission?.code ?? 'not_managed',
      text: submission?.text ?? '这次执行没有可信的受管提交上下文',
    };
  }
  if (!action || typeof action !== 'object') {
    return { ok: false, outcome: INTAKE_OUTCOME.skipped, code: 'no_action', text: '缺少要做的动作' };
  }

  const hostImpl = host ?? createHandoffHost({ store, taskRuns, deps });
  // 服务只认已核实的提交：身份、版本、目标都从它取
  const base = { store: taskRuns, submission, host: hostImpl };

  const run = (plan, createOnly = false) =>
    ensureDepartmentAndAssign({ ...base, plan, createOnly });

  /** 统一规格准备：任何创建动作都必须先过这里。 */
  const prepare = (rawSpec) => {
    if (typeof prepareSpec !== 'function') {
      return { ok: false, code: 'no_spec_preparer', text: '缺少规格准备器，不能创建部门' };
    }
    return prepareSpec(rawSpec ?? {});
  };

  const toResult = (out, route, createOnly) => {
    if (!out.ok) {
      return {
        ok: false,
        outcome: route === ROUTE.new ? INTAKE_OUTCOME.created : INTAKE_OUTCOME.existing,
        code: out.code,
        text: out.text,
        step: out.step,
      };
    }
    return {
      ok: true,
      outcome: route === ROUTE.new ? INTAKE_OUTCOME.created : INTAKE_OUTCOME.existing,
      departmentId: out.departmentId,
      leadBotId: out.leadBotId,
      queueRef: out.queueRef,
      resumed: out.resumed === true,
      operationId: out.operationId,
      createOnly: out.createOnly === true,
      handoffLevel: 'department',
      text: createOnly ? '部门已建好，没有派发研究任务' : '部门级目标已交给负责人',
    };
  };

  // ---- 建组：模板展开与模型预检统一在这里做（工具只传原始请求）
  if (action.type === ACTION.createDepartment) {
    const prepared = prepare(action.request ?? action.spec ?? {});
    if (!prepared.ok) {
      return { ok: false, outcome: INTAKE_OUTCOME.skipped, code: prepared.code, text: prepared.text };
    }
    const plan = { route: ROUTE.new, departmentSpec: prepared.spec };
    const out = await run(plan, action.createOnly === true);
    return toResult(out, ROUTE.new, action.createOnly === true);
  }

  // ---- 派给已有部门
  if (action.type === ACTION.dispatchExisting) {
    const plan = {
      route: ROUTE.existing,
      departmentId: action.departmentId,
      leadBotId: action.leadBotId ?? null,
    };
    const out = await run(plan, false);
    return toResult(out, ROUTE.existing, false);
  }

  // ---- 接单结构：路由判定交给纯规则
  if (action.type === ACTION.accept) {
    const candidateDepartments = (submission.candidateDepartmentIds ?? [])
      .map((id) => describeDepartment(store, id))
      .filter(Boolean);

    const plan = planIntakeRoute({
      intake: action.intake,
      candidateDepartments,
      explicitRoute: action.explicitRoute ?? null,
      userWantsDiscussion: action.userWantsDiscussion === true,
    });

    if (!plan.ok) {
      return { ok: false, outcome: INTAKE_OUTCOME.skipped, code: plan.code, text: plan.text };
    }

    // 只建组：要建，但建成即结束 —— 同样先过统一准备
    if (plan.createOnly === true) {
      const prepared = prepare(plan.departmentSpec ?? {});
      if (!prepared.ok) {
        return { ok: false, outcome: INTAKE_OUTCOME.skipped, code: prepared.code, text: prepared.text };
      }
      const out = await run({ route: ROUTE.new, departmentSpec: prepared.spec }, true);
      return toResult(out, ROUTE.new, true);
    }

    // 不进执行
    if (plan.execute !== true) {
      return { ok: true, outcome: INTAKE_OUTCOME.skipped, reason: plan.reason, text: plan.text };
    }

    // 主控直接做：不建部门、不派活
    if (plan.route === ROUTE.direct) {
      return {
        ok: true,
        outcome: INTAKE_OUTCOME.direct,
        // 返回可信的已接受目标，不用模型这一轮另写的 goal
        goal: submission.acceptedGoal,
        text: '由主控直接用已授权工具完成',
      };
    }

    // 已有部门 / 新建部门
    let effectivePlan = plan;
    if (plan.route === ROUTE.new) {
      const prepared = prepare(plan.departmentSpec ?? {});
      if (!prepared.ok) {
        return { ok: false, outcome: INTAKE_OUTCOME.skipped, code: prepared.code, text: prepared.text };
      }
      effectivePlan = { ...plan, departmentSpec: prepared.spec };
    }
    const out = await run(effectivePlan, false);
    return toResult(out, effectivePlan.route, false);
  }

  return { ok: false, outcome: INTAKE_OUTCOME.skipped, code: 'unknown_action', text: '未知动作' };
}

/** 读一个部门的最小描述（供路由匹配）。 */
function describeDepartment(store, id) {
  const room = store.getRoom(id);
  if (!room || room.kind !== 'group') return null;
  return {
    id: room.id,
    name: room.name ?? '',
    topic: room.topic ?? '',
    leadBotId: room.leadBotId ?? null,
  };
}

export { ROUTE, NO_EXECUTION };
