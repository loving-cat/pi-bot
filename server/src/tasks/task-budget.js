/**
 * 根任务预算（纯逻辑：无 IO、无时钟、无随机）。
 *
 * ## 一条原则
 *
 * **额度只记在根任务上。** 子任务、重新入队、改目标后重跑，都申请同一份根额度。
 *
 * ## 三种限制（清单第 6 条）
 *
 * | 限制 | 字段 | 口径 |
 * |---|---|---|
 * | 次数 | `maxRuns` / `usedRuns` | **准确可数** |
 * | 并发 | `concurrencyLimit` | **准确可数** |
 * | 时间 | `deadlineAt` | 墙钟截止，等待不延长 |
 *
 * ## 字段与批次 01 归约器统一（审查 B05）
 *
 * 批次 01 的 `task-reduce.js` 认 `maxRuns` / `usedRuns` / `extraRuns`。
 * 本模块原先另立 `runsUsed` / `extendedRuns`，导致「扩额成功但归约器仍说没扩」。
 * 现在**只保留批次 01 的字段名**，一个事实一个名字：
 *
 *   · `usedRuns`   —— 已用次数（归约器与诊断都读它）
 *   · `extraRuns`  —— 累计追加次数（归约器 `resumed` 用它判断能不能解禁）
 *
 * `usedRuns` 的权威值是**账本长度**（`attempts.length`），由持久层在写回时校准；
 * 这里的纯函数只负责算术，不负责权威性。
 *
 * ## 口径诚实（清单第 6 条后半）
 *
 * 我们**只能**准确数「执行了几次」。tokens 与金额取决于模型 SDK 内部行为，
 * 数不到真实值，所以标为 `unmeasured`，界面不得说成真实消耗。
 */

/** 预算拒绝原因。 */
export const BUDGET_REJECT = Object.freeze({
  exhausted: 'budget_exhausted',
  concurrency: 'concurrency_limit',
  deadline: 'deadline_passed',
  badBudget: 'bad_budget',
  nothingToRefund: 'nothing_to_refund',
});

/** 我们**无法**准确计量的指标。 */
export const UNMEASURED_METRICS = Object.freeze(['apiRequests', 'tokens', 'cost']);

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isTime = (v) => Number.isFinite(v) && v > 0;

function reject(code, field, text) {
  return { ok: false, code, field, text };
}

/**
 * 造一份新预算。
 *
 * 参数省略表示该维度不限制；「不限额」必须由 `null` 明确表达，
 * 不能由非法值兜底（批次 01 F04 的教训）。
 */
export function createBudget({ maxRuns = null, concurrencyLimit = 1, deadlineAt = null } = {}) {
  if (maxRuns !== null && !isPositiveInt(maxRuns)) {
    return reject(BUDGET_REJECT.badBudget, 'budget.maxRuns', 'maxRuns 必须是正整数或 null（不限额）');
  }
  if (concurrencyLimit !== null && !isPositiveInt(concurrencyLimit)) {
    return reject(BUDGET_REJECT.badBudget, 'budget.concurrencyLimit', 'concurrencyLimit 必须是正整数或 null');
  }
  if (deadlineAt !== null && !isTime(deadlineAt)) {
    return reject(BUDGET_REJECT.badBudget, 'budget.deadlineAt', 'deadlineAt 必须是毫秒时间戳或 null');
  }
  return {
    ok: true,
    budget: {
      maxRuns,
      concurrencyLimit,
      deadlineAt,
      usedRuns: 0,
      extraRuns: 0,
    },
  };
}

/**
 * 校验一份既有预算（加载时用）。
 *
 * 坏数据**明确拒绝**，不能当成「没设上限」放行。
 */
export function validateBudget(budget) {
  if (budget === null || budget === undefined) return { ok: true };
  if (typeof budget !== 'object' || Array.isArray(budget)) {
    return reject(BUDGET_REJECT.badBudget, 'budget', '预算必须是对象或 null');
  }
  const { maxRuns, concurrencyLimit, deadlineAt, usedRuns, extraRuns } = budget;
  if (maxRuns !== null && maxRuns !== undefined && !isPositiveInt(maxRuns)) {
    return reject(BUDGET_REJECT.badBudget, 'budget.maxRuns', 'maxRuns 必须是正整数或 null');
  }
  if (concurrencyLimit !== null && concurrencyLimit !== undefined && !isPositiveInt(concurrencyLimit)) {
    return reject(BUDGET_REJECT.badBudget, 'budget.concurrencyLimit', 'concurrencyLimit 必须是正整数或 null');
  }
  if (deadlineAt !== null && deadlineAt !== undefined && !isTime(deadlineAt)) {
    return reject(BUDGET_REJECT.badBudget, 'budget.deadlineAt', 'deadlineAt 必须是毫秒时间戳或 null');
  }
  if (usedRuns !== undefined && !isNonNegInt(usedRuns)) {
    return reject(BUDGET_REJECT.badBudget, 'budget.usedRuns', 'usedRuns 必须是非负整数');
  }
  if (extraRuns !== undefined && !isNonNegInt(extraRuns)) {
    return reject(BUDGET_REJECT.badBudget, 'budget.extraRuns', 'extraRuns 必须是非负整数');
  }
  if (isPositiveInt(maxRuns) && isNonNegInt(usedRuns) && usedRuns > maxRuns) {
    return reject(
      BUDGET_REJECT.badBudget,
      'budget.usedRuns',
      `已用 ${usedRuns} 次超过上限 ${maxRuns}，预算数据不一致`,
    );
  }
  return { ok: true };
}

/**
 * 还能跑几次。不限额返回 null。
 *
 * @param {object} budget
 * @param {number} [usedFromLedger] 账本里已登记的执行数（权威来源）
 *
 * ★ 为什么必须有第二个参数：
 *
 *   工厂已经不再写 budget.usedRuns（累计量从账本派生，存一份必然不同步），
 *   但这里原来只读 usedRuns —— 于是账本已经跑了 2 次，面板仍显示
 *   「0/2，剩余 2 次」，checkCanRun 也一直放行，与归约器的判定相反。
 *   传了账本数就以账本为准；没传时退回旧行为（兼容既有调用方）。
 */
export function remainingRuns(budget, usedFromLedger) {
  if (!budget || budget.maxRuns === null || budget.maxRuns === undefined) return null;
  const used = Number.isFinite(Number(usedFromLedger))
    ? Number(usedFromLedger)
    : (budget.usedRuns ?? 0);
  return Math.max(0, budget.maxRuns - used);
}

/**
 * 现在能不能再起一次执行。
 *
 * 顺序即用户可理解的解释顺序：先看是不是过点了，再看有没有名额，最后看槽位。
 */
export function checkCanRun(budget, { at, runningCount = 0, usedFromLedger } = {}) {
  if (!budget) return { ok: true };

  if (isTime(budget.deadlineAt) && Number.isFinite(at) && at > budget.deadlineAt) {
    return reject(
      BUDGET_REJECT.deadline,
      'budget.deadlineAt',
      `已过截止时间（${new Date(budget.deadlineAt).toLocaleString('zh-CN')}）`,
    );
  }

  const used = Number.isFinite(Number(usedFromLedger))
    ? Number(usedFromLedger)
    : (budget.usedRuns ?? 0);
  const left = remainingRuns(budget, used);
  if (left !== null && left <= 0) {
    return reject(
      BUDGET_REJECT.exhausted,
      'budget.maxRuns',
      `执行次数已用尽（${used}/${budget.maxRuns}）`,
    );
  }

  const limit = budget.concurrencyLimit;
  if (isPositiveInt(limit) && runningCount >= limit) {
    return reject(
      BUDGET_REJECT.concurrency,
      'budget.concurrencyLimit',
      `同时执行数已达上限（${runningCount}/${limit}）`,
    );
  }

  return { ok: true };
}

/**
 * 占用一次额度。
 *
 * ★ 在**派发之前**调用并落盘：先记账再执行。
 */
export function chargeRun(budget) {
  if (!budget) return { ok: true, budget: null };
  const next = { ...budget, usedRuns: (budget.usedRuns ?? 0) + 1 };
  if (isPositiveInt(next.maxRuns) && next.usedRuns > next.maxRuns) {
    return reject(
      BUDGET_REJECT.exhausted,
      'budget.maxRuns',
      `执行次数已用尽（${Number.isFinite(Number(usedFromLedger)) ? Number(usedFromLedger) : (budget.usedRuns ?? 0)}/${budget.maxRuns}）`,
    );
  }
  return { ok: true, budget: next };
}

/**
 * 退回一次额度。仅在有证据证明那次执行没真正发生时使用。
 */
export function refundRun(budget) {
  if (!budget) return { ok: true, budget: null };
  const used = budget.usedRuns ?? 0;
  if (used <= 0) {
    return reject(BUDGET_REJECT.nothingToRefund, 'budget.usedRuns', '没有可退回的额度');
  }
  return { ok: true, budget: { ...budget, usedRuns: used - 1 } };
}

/**
 * 追加额度。
 *
 * ★ 同时写 `maxRuns` 与 `extraRuns`（批次 01 归约器的 `resumed` 读 `extraRuns`）。
 *   只改 `maxRuns` 会让「扩额成功但仍是 paused_budget」（审查 B05 实测）。
 */
export function extendBudget(budget, extraRuns) {
  if (!budget) return reject(BUDGET_REJECT.badBudget, 'budget', '没有预算可以追加');
  if (!isPositiveInt(extraRuns)) {
    return reject(BUDGET_REJECT.badBudget, 'extraRuns', '追加额度必须是正整数');
  }
  const next = { ...budget };
  if (isPositiveInt(next.maxRuns)) next.maxRuns += extraRuns;
  next.extraRuns = (next.extraRuns ?? 0) + extraRuns;
  return { ok: true, budget: next };
}

/**
 * 给用户/界面的预算口径说明。
 */
export function describeBudget(budget, usedFromLedger) {
  if (!budget) {
    return {
      limited: false,
      lines: ['未设置预算限制'],
      authoritative: 'attempts',
      unmeasured: [...UNMEASURED_METRICS],
    };
  }
  const lines = [];
  const left = remainingRuns(budget, usedFromLedger);
  if (left === null) {
    lines.push(`执行次数不限额（已执行 ${Number.isFinite(Number(usedFromLedger)) ? Number(usedFromLedger) : (budget.usedRuns ?? 0)} 次）`);
  } else {
    lines.push(`执行次数 ${Number.isFinite(Number(usedFromLedger)) ? Number(usedFromLedger) : (budget.usedRuns ?? 0)}/${budget.maxRuns}，剩余 ${left} 次`);
  }
  if (isPositiveInt(budget.extraRuns)) {
    lines.push(`其中追加 ${budget.extraRuns} 次`);
  }
  if (isTime(budget.deadlineAt)) {
    lines.push(`截止时间 ${new Date(budget.deadlineAt).toLocaleString('zh-CN')}（等待不延长）`);
  }
  if (isPositiveInt(budget.concurrencyLimit)) {
    lines.push(`同时最多 ${budget.concurrencyLimit} 个执行`);
  }
  return {
    limited: true,
    lines,
    authoritative: 'attempts',
    unmeasured: [...UNMEASURED_METRICS],
  };
}