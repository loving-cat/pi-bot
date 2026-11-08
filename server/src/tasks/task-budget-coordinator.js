/**
 * 根任务额度协调（B01 / B05：执行身份与生命周期）。
 *
 * ## 一次预留是一条「授权」，不是「一个数字」
 *
 * 根额度里的每一份预留都写清：
 *
 * ```js
 * { attemptId, taskRunId, botId, revision, phase, reservedAt, startedAt, settledAt }
 * ```
 *
 * `taskRunId` 是关键 —— 它说明**这次额度授权给了哪个任务的一次执行**。
 * 子任务的执行凭这份授权开始，根据此知道「有人正在用我的额度」。
 *
 * ## 为什么必须绑 taskRunId（审查第三轮 B05 实测）
 *
 * 原来根预留只记 `attemptId`，于是：
 *
 *   · 子任务 started 了，根占位仍是 `reserved` —— 根不知道子已经在跑；
 *   · 此时根退款成功，`usedRuns` 退到 0，子任务还在跑 —— 额度凭空消失；
 *   · 并发计数 2 —— 根按根 ID 记一次、子账本按子 ID 再记一次。
 *
 * 现在用同一份 `taskRunId + attemptId` 贯穿根预留、子占位、子账本，
 * 三处指同一次执行，计数与退款都能对上。
 *
 * ## 生命周期规则统一在 `task-attempt-lifecycle.js`
 *
 * 本模块不再自己判断「这个阶段能不能 start / refund」，
 * 一律调用 `planReserve` / `planStart` / `planRefund` / `planSettle`。
 */
import {
  BUDGET_REJECT,
  checkCanRun,
  chargeRun,
  refundRun,
  extendBudget,
  describeBudget,
  remainingRuns,
  validateBudget,
} from './task-budget.js';
import {
  PHASE,
  planReserve,
  planStart,
  planRefund,
  planSettle,
  classify,
  runningCount,
  occupiesQuota,
  checkIdentity,
} from './task-attempt-lifecycle.js';

const isAnyId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);

function fail(code, text) {
  return { ok: false, code, text };
}

/** 根任务下的全部预留。 */
function slotsOf(taskRun) {
  return { ...(taskRun?.attemptSlots ?? {}) };
}

/**
 * **原子申请一次执行授权**。
 *
 * 一次调用完成：读根最新 → 核验根身份/状态/预算 → 生命周期判能否预留
 * → 检查额度与并发 → 扣额 + 登记**带 taskRunId 的**预留 → 落盘。
 *
 * @param {object} p
 * @param {import('./task-run-store.js').TaskRunStore} p.store
 * @param {string} p.rootTaskId 根任务
 * @param {string} p.taskRunId  **这次授权给哪个任务执行**（子任务传自己的 ID）
 * @param {string} p.attemptId  该任务内的尝试 ID
 * @param {string} [p.botId]
 * @param {number} [p.revision]
 * @param {number} p.at
 */
export async function reserveRootBudget({
  store,
  rootTaskId,
  taskRunId = null,
  attemptId,
  botId = null,
  revision = null,
  at,
}) {
  if (!store) return fail('bad_store', '缺少存储');
  if (!isAnyId(rootTaskId)) return fail('bad_root', '根任务 ID 不合法');
  if (!isAnyId(attemptId)) return fail('bad_attempt', '必须给出稳定的 attemptId（用于幂等）');

  // 没显式给 taskRunId 时，默认就是根任务自己在执行
  const owner = isAnyId(taskRunId) ? taskRunId : rootTaskId;

  const out = await store.mutate(rootTaskId, {
    mutate: (current) => {
      if (!current) return { __reject: fail('root_missing', `找不到根任务 ${rootTaskId}`) };

      // ---- 必须是真根
      const actualRoot = current.rootTaskId ?? current.id;
      if (actualRoot !== current.id) {
        return {
          __reject: fail('not_a_root', `任务 ${rootTaskId} 属于根 ${actualRoot}，额度要向其根申请`),
        };
      }

      // ---- 状态可执行
      if (current.state === 'cancelled' || current.state === 'completed') {
        return { __reject: fail('terminal', `根任务已是「${current.state}」，不能再申请额度`) };
      }

      // ---- 预算结构合法
      const budgetCheck = validateBudget(current.budget);
      if (!budgetCheck.ok) return { __reject: fail('bad_budget', budgetCheck.text) };

      const slots = slotsOf(current);
      const key = reservationKey(owner, attemptId);
      const existing = slots[key];

      // ---- 生命周期判能否预留（refunded / settled 一律拒绝）
      const plan = planReserve(existing, { attemptId });
      if (!plan.ok) return { __reject: plan };

      // 身份核对：同一预留必须对应同一任务/执行者/版本
      if (existing) {
        const mismatch = checkIdentity(existing, { taskRunId: owner, botId, revision });
        if (mismatch) return { __reject: mismatch };
        // 复用：不重复扣额
        return null;
      }

      // ---- 额度与并发（按根统计，同身份去重）
      const gate = checkCanRun(current.budget, {
        at,
        runningCount: runningCount(Object.values(slots)) + registeredCountOf(current, owner),
      });
      if (!gate.ok) return { __reject: fail(gate.code, gate.text) };

      const charged = chargeRun(current.budget);
      if (!charged.ok) return { __reject: fail(charged.code, charged.text) };

      // ---- 扣额与预留同一次写；预留带上完整授权身份
      slots[key] = {
        attemptId,
        taskRunId: owner,
        botId,
        revision,
        phase: PHASE.reserved,
        reservedAt: at,
        startedAt: null,
        settledAt: null,
      };

      return { ...current, budget: charged.budget, attemptSlots: slots, updatedAt: at };
    },
  });

  if (!out.ok) return out;
  return {
    ok: true,
    taskRun: out.taskRun,
    reused: !out.changed,
    budget: out.taskRun?.budget ?? null,
    reservationId: reservationKey(owner, attemptId),
  };
}

/** 预留的键：任务 + 尝试。同一任务是同一次执行身份。 */
export function reservationKey(taskRunId, attemptId) {
  return `${taskRunId}::${attemptId}`;
}

/** 根账本里属于某个任务的已登记执行数（尚未进入预留表的那部分）。 */
function registeredCountOf(rootTaskRun, taskRunId) {
  if (!rootTaskRun || taskRunId !== rootTaskRun.id) return 0;
  return (rootTaskRun.attempts ?? []).filter((a) => a.state === 'registered').length;
}

/**
 * **开始执行**：把根预留推进到 started。
 *
 * ★ 审查第三轮：子任务 started 时，**根必须知道**。
 *   原来根占位一直停在 reserved，于是还能被退款。
 */
export async function startRootBudget({ store, rootTaskId, taskRunId = null, attemptId, botId = null, revision = null, at }) {
  if (!isAnyId(attemptId)) return fail('bad_attempt', '必须给出 attemptId');
  const owner = isAnyId(taskRunId) ? taskRunId : rootTaskId;
  const key = reservationKey(owner, attemptId);

  const out = await store.mutate(rootTaskId, {
    mutate: (current) => {
      if (!current) return { __reject: fail('root_missing', `找不到根任务 ${rootTaskId}`) };
      const slots = slotsOf(current);
      const existing = slots[key];

      const plan = planStart(existing, { taskRunId: owner, botId, revision });
      if (!plan.ok) return { __reject: plan };
      if (plan.action === 'reuse') return null;

      slots[key] = { ...existing, phase: PHASE.started, startedAt: at };
      return { ...current, attemptSlots: slots, updatedAt: at };
    },
  });

  if (!out.ok) return out;
  return { ok: true, taskRun: out.taskRun, budget: out.taskRun?.budget ?? null };
}

/**
 * **结算**：把根预留推进到 settled。
 */
export async function settleRootBudget({ store, rootTaskId, taskRunId = null, attemptId, botId = null, revision = null, at }) {
  if (!isAnyId(attemptId)) return fail('bad_attempt', '必须给出 attemptId');
  const owner = isAnyId(taskRunId) ? taskRunId : rootTaskId;
  const key = reservationKey(owner, attemptId);

  const out = await store.mutate(rootTaskId, {
    mutate: (current) => {
      if (!current) return { __reject: fail('root_missing', `找不到根任务 ${rootTaskId}`) };
      const slots = slotsOf(current);
      const existing = slots[key];
      if (!existing) return null; // 没有预留就不用结算（可能没走预留入口）

      const plan = planSettle(existing, { taskRunId: owner, botId, revision });
      if (!plan.ok) return { __reject: plan };
      if (plan.action === 'reuse') return null;

      slots[key] = {
        ...existing,
        phase: PHASE.settled,
        startedAt: existing.startedAt ?? at,
        settledAt: at,
      };
      return { ...current, attemptSlots: slots, updatedAt: at };
    },
  });

  if (!out.ok) return out;
  return { ok: true, taskRun: out.taskRun, budget: out.taskRun?.budget ?? null };
}

/**
 * **退款**：把根预留推进到 refunded 并退回额度。
 *
 * ★ 已开始 / 结果未知的执行**不能退**（`planRefund` 判）。
 */
export async function refundRootBudget({ store, rootTaskId, taskRunId = null, attemptId, botId = null, revision = null, at }) {
  if (!isAnyId(attemptId)) {
    return fail('bad_attempt', '退额必须给出 attemptId —— 没有身份的退款无从核对');
  }
  const owner = isAnyId(taskRunId) ? taskRunId : rootTaskId;
  const key = reservationKey(owner, attemptId);

  const out = await store.mutate(rootTaskId, {
    mutate: (current) => {
      if (!current) return { __reject: fail('root_missing', `找不到根任务 ${rootTaskId}`) };
      const slots = slotsOf(current);
      const existing = slots[key];

      // 完全没有预留：可能已经退款并清理过 —— 交给 lifecycle 判
      const plan = planRefund(existing, { taskRunId: owner, botId, revision });
      if (!plan.ok) return { __reject: plan };
      if (plan.action === 'reuse') return null; // 已经退过，幂等

      const refunded = refundRun(current.budget);
      if (!refunded.ok) return { __reject: fail(refunded.code, refunded.text) };

      slots[key] = { ...existing, phase: PHASE.refunded, refundedAt: at };
      return { ...current, budget: refunded.budget, attemptSlots: slots, updatedAt: at };
    },
  });

  if (!out.ok) return out;
  return {
    ok: true,
    taskRun: out.taskRun,
    budget: out.taskRun?.budget ?? null,
    refunded: out.changed,
    alreadyRefunded: !out.changed,
  };
}

/**
 * 追加根额度。
 */
export async function extendRootBudget({ store, rootTaskId, extraRuns, at }) {
  if (!Number.isInteger(extraRuns) || extraRuns <= 0) {
    return fail('bad_extra', '追加额度必须是正整数');
  }
  const out = await store.mutate(rootTaskId, {
    mutate: (current) => {
      if (!current) return { __reject: fail('root_missing', `找不到根任务 ${rootTaskId}`) };
      const actualRoot = current.rootTaskId ?? current.id;
      if (actualRoot !== current.id) {
        return { __reject: fail('not_a_root', `只有根任务能追加额度（${rootTaskId} 属于 ${actualRoot}）`) };
      }
      const extended = extendBudget(current.budget, extraRuns);
      if (!extended.ok) return { __reject: fail(extended.code, extended.text) };
      return { ...current, budget: extended.budget, updatedAt: at };
    },
  });
  if (!out.ok) return out;
  return { ok: true, taskRun: out.taskRun, budget: out.taskRun?.budget ?? null };
}

// ---------------------------------------------------------------------------
// 查询助手（不改状态）
// ---------------------------------------------------------------------------

/** 一个 TaskRun 应该向哪个任务申请额度。 */
export function budgetOwnerOf(taskRun) {
  if (!taskRun) return null;
  return taskRun.rootTaskId ?? taskRun.id;
}

/**
 * 根任务下当前有多少执行在跑。
 *
 * ★ 审查第三轮 B05：用**同一执行身份**去重。
 *
 *   根预留记为 `${taskRunId}::${attemptId}`，子账本 / 子占位也用同一 key，
 *   于是同一次执行在三处出现也只算一个。
 */
export function runningCountUnderRoot(allTaskRuns, rootTaskId) {
  const seen = new Set();

  for (const taskRun of allTaskRuns ?? []) {
    if ((taskRun.rootTaskId ?? taskRun.id) !== rootTaskId) continue;

    // 持久占位（根上的授权记录）
    for (const slot of Object.values(taskRun.attemptSlots ?? {})) {
      if (!slot || !occupiesQuota(slot.phase)) continue;
      // 只有真正在跑的算；reserved 也算「占用中」但不等于 running
      if (slot.phase === PHASE.started) {
        seen.add(reservationKey(slot.taskRunId ?? taskRun.id, slot.attemptId));
      }
    }

    // 批次 01 账本里的在途执行
    for (const attempt of taskRun.attempts ?? []) {
      if (attempt.state === 'registered') {
        seen.add(reservationKey(taskRun.id, attempt.attemptId));
      }
    }
  }
  return seen.size;
}

/**
 * 把根预算投影成「这个任务现在还能跑几次」。
 */
export function budgetViewFor(taskRun, root) {
  const owner = budgetOwnerOf(taskRun);
  const budget = owner === taskRun?.id ? taskRun?.budget : root?.budget ?? taskRun?.budget;
  const view = describeBudget(budget);
  return {
    ...view,
    ownerTaskId: owner,
    isRoot: owner === taskRun?.id,
    remaining: remainingRuns(budget),
  };
}

/**
 * 重启时对根预留分类（转发生命周期模块的统一规则）。
 */
export function classifyReservations(root) {
  return classify(root?.attemptSlots);
}

export { BUDGET_REJECT, PHASE };