/**
 * Attempt **账本**（纯逻辑，无 IO）。
 *
 * ## 职责
 *
 * 只维护"本任务范围内每一次执行"的完整生命周期。归约器只通过它查询：
 * 现在有在途的吗、占用了多少次额度、还有哪些没结算。
 *
 * ## 一条执行的三个状态
 *
 * ```
 *   registerAttempt  →  registered
 *          ↓ abandon          ↓ settle
 *      abandoned  ──settle──→  settled
 * ```
 *
 * 三者**都算占用过一次额度**：登记过就是占用过，不管它怎么结束的。
 *
 * ## 三条不变量（第四轮审查 H02 / H03 的要求）
 *
 * 1. **累计事实不可回退。** 账本不裁剪。
 *    审查 H02 实测：原来只留 200 条明细，却用 `attempts.length` 当累计计数，
 *    跑满 205 次后计数停在 200，被裁掉的 att_0 还能重新派发 ——
 *    "累计执行量"和"近期明细条数"被混成了一个事实。
 *    本批的做法是**不裁剪**：一个事实就够，不引入第二个权威计数器。
 *    批次 02 若要归档，必须同时引入不可回退的累计计数与已用 ID 集合。
 *
 * 2. **记录必须属于所在 TaskRun。** 审查 H03 实测：把 tr_b 的合法记录
 *    放进 tr_a 的快照，`validateTaskRun` 说合法，随后 tr_b 的结果也被 tr_a 接受。
 *    现在加载与结算都核对 `record.taskRunId === run.id`。
 *
 * 3. **在途记录的目标版本与任务自洽。** 在途的必须是当前版本；
 *    作废/已结算的保留它自己的原版本（改目标后旧结果仍能归档）。
 */
import {
  REJECT,
  reject,
  ok,
  PHASE,
} from './task-contract.js';

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const isTime = (v) => Number.isFinite(v) && v > 0;

/** 账本里一条执行的状态。 */
export const ATTEMPT_STATE = Object.freeze({
  registered: 'registered',
  abandoned: 'abandoned',
  settled: 'settled',
});

/**
 * 未结算条数上限。超了**拒绝新派发**并报告，而不是静默丢弃。
 *
 * 这是"执行可能卡住"的显式信号：要么等结果回来，要么确认它已停止。
 */
export const MAX_PENDING_ATTEMPTS = 20;

/**
 * 归一化一次完成申请的交付选择。只有 apply_completion 才有选择事实；
 * 普通 progress 的证据是过程声明，不能当最终交付。
 */
export function normalizeCompletionSelection(phase) {
  if (phase?.kind !== PHASE.apply_completion) return null;
  const refs = [];
  for (const item of phase.claimedEvidence ?? []) {
    const ref = String(item?.ref ?? '').trim();
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs.slice(0, 50);
}

/**
 * 读取账本结果里的选择事实；区分“旧账本没有字段（legacy）”与
 * “新完成申请明确空选择（present + []）”。
 */
export function completionSelectionOfResult(result) {
  if (!result || typeof result !== 'object') return { present: false, refs: null, legacy: false };
  if (!Object.prototype.hasOwnProperty.call(result, 'completionSelection')) {
    return { present: false, refs: null, legacy: result.phaseKind === PHASE.apply_completion };
  }
  const raw = result.completionSelection;
  if (raw === null) return { present: true, refs: null, legacy: false };
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    return { present: true, refs: null, legacy: false, invalid: true };
  }
  return { present: true, refs: [...new Set(raw.map((x) => x.trim()).filter(Boolean))].slice(0, 50), legacy: false };
}

/**
 * 账本总条数硬上限。
 *
 * 批次 01 **不裁剪**（H02）；到达上限时拒绝新派发并明确报错，
 * 而不是丢掉最早记录。批次 02 的存储层负责归档与累计账本。
 */
export const MAX_LEDGER_ATTEMPTS = 2000;

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 当前在途的尝试（registered）。派生值，不单独存字段。 */
export function activeAttemptOf(run) {
  return (run?.attempts ?? []).find((a) => a.state === ATTEMPT_STATE.registered) ?? null;
}

/** 未结算的尝试（registered + abandoned）。 */
export function pendingAttemptsOf(run) {
  // ★ abandoned 不算「未结算」。
  //
  //   abandoned 的语义是「这次执行被主动放弃了」（暂停/阻塞/改版时打的标记），
  //   它已经注定不会再有结果，不构成新派发的阻碍。
  //
  //   把它算成未结算会造成死锁：用户点一次「暂停 → 继续」，
  //   账本就留一条 abandoned，之后再派发一律 too_many_pending，
  //   而唯一能清掉它的 attempt_closed 没有任何生产者 —— 任务从此再也跑不动。
  return (run?.attempts ?? []).filter(
    (a) => a.state !== ATTEMPT_STATE.settled && a.state !== ATTEMPT_STATE.abandoned,
  );
}

/**
 * 已登记的总执行次数 —— 这就是"占用了几次额度"。
 *
 * ★ H02：账本不裁剪，所以长度就是累计事实，不存在第二个计数器。
 */
export function registeredCount(run) {
  return (run?.attempts ?? []).length;
}

/** 已结算的尝试数。 */
export function settledCount(run) {
  return (run?.attempts ?? []).filter((a) => a.state === ATTEMPT_STATE.settled).length;
}

/** 按 attemptId 找记录。 */
export function findAttempt(run, attemptId) {
  return (run?.attempts ?? []).find((a) => a.attemptId === attemptId) ?? null;
}

// ---------------------------------------------------------------------------
// 登记
// ---------------------------------------------------------------------------

/**
 * 登记一次新执行。
 *
 * @param {object[]} attempts 当前账本
 * @param {{attemptId:string, taskRunId:string, botId:string, startedAt:number, revision:number}} entry
 * @returns {{ok:true, attempts:object[]}|{ok:false, ...}}
 */
export function registerAttempt(attempts, { attemptId, taskRunId, botId, startedAt, revision } = {}) {
  if (!isId(attemptId)) return reject(REJECT.badField, 'attempt.attemptId', 'attemptId 不合法');
  if (!isId(taskRunId)) return reject(REJECT.badField, 'attempt.taskRunId', 'taskRunId 不合法');
  if (!isId(botId)) return reject(REJECT.badField, 'attempt.botId', '执行者不合法');
  if (!Number.isInteger(revision) || revision < 1) {
    return reject(REJECT.badField, 'attempt.revision', 'revision 必须是正整数');
  }

  const list = Array.isArray(attempts) ? attempts : [];

  // ★ 已用过的 attemptId 不能再登记（旧 ID 不能成为另一次新执行）
  if (list.some((a) => a.attemptId === attemptId)) {
    return reject(
      REJECT.attemptMismatch,
      'attempt.attemptId',
      `尝试 ${attemptId} 已经用过，新执行必须用新 ID`,
    );
  }

  // ★ 未结算太多：拒绝新派发，不丢旧记录
  const pending = list.filter((a) => a.state !== ATTEMPT_STATE.settled);
  if (pending.length >= MAX_PENDING_ATTEMPTS) {
    return reject(
      REJECT.tooManyPending,
      'attempts',
      `还有 ${pending.length} 次执行未结算（上限 ${MAX_PENDING_ATTEMPTS}），` +
        '先等它们回来或确认已停止，再派新的',
    );
  }

  // ★ 账本上限：拒绝而不是裁剪（H02）
  if (list.length >= MAX_LEDGER_ATTEMPTS) {
    return reject(
      REJECT.tooManyPending,
      'attempts',
      `账本已达 ${MAX_LEDGER_ATTEMPTS} 条上限，无法继续登记（需要批次 02 的归档服务）`,
    );
  }

  return ok({
    attempts: [
      ...list,
      {
        attemptId,
        taskRunId,
        botId,
        startedAt: isTime(startedAt) ? startedAt : 0,
        revision,
        state: ATTEMPT_STATE.registered,
        abandonedAt: null,
        abandonReason: null,
        settledAt: null,
        result: null,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// 作废
// ---------------------------------------------------------------------------

/**
 * 把未结算的尝试标记为作废。
 *
 * 作废**不等于停止**：执行可能还在跑，结果仍会被接收和结算，
 * 只是不再推进任务状态。要表达"确认停止"，用 `closeAttempt`。
 */
export function abandonPending(attempts, { reason = '', at = 0 } = {}) {
  return (Array.isArray(attempts) ? attempts : []).map((a) =>
    a.state === ATTEMPT_STATE.settled
      ? a
      : {
          ...a,
          state: ATTEMPT_STATE.abandoned,
          abandonedAt: isTime(at) ? at : 0,
          abandonReason: String(reason ?? '').slice(0, 200),
        },
  );
}

// ---------------------------------------------------------------------------
// 结算（有结果）
// ---------------------------------------------------------------------------

/**
 * 结算一次执行的结果。
 *
 * 校验链：**登记存在 → 归属一致 → 幂等或冲突**。
 * 无论记录是 registered 还是 abandoned，走的都是这一套。
 *
 * @returns {{ok:true, attempts, noop?, wasAbandoned:boolean, record}|{ok:false,...}}
 */
export function settleAttempt(attempts, attempt, { at = 0 } = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  const index = list.findIndex((a) => a.attemptId === attempt?.attemptId);

  if (index < 0) {
    return reject(
      REJECT.noActiveAttempt,
      'attempt.attemptId',
      `没有登记过尝试 ${attempt?.attemptId}，不能结算`,
    );
  }

  const record = list[index];

  const mismatch = checkOwnership(record, attempt);
  if (mismatch) return mismatch;

  if (record.state === ATTEMPT_STATE.settled) {
    if (sameResult(record.result, attempt)) {
      return { ok: true, attempts: list, noop: 'already_settled', record, wasAbandoned: false };
    }
    return reject(
      REJECT.conflictSettlement,
      'attempt',
      `尝试 ${attempt.attemptId} 已结算过，新结果与已确认的不一致，不能覆盖`,
    );
  }

  const next = [...list];
  next[index] = {
    ...record,
    state: ATTEMPT_STATE.settled,
    settledAt: isTime(at) ? at : record.settledAt ?? 0,
    result: {
      stop: attempt.stop,
      usage: attempt.usage ?? null,
      artifacts: [...(attempt.artifacts ?? [])],
      phaseKind: attempt.phase?.kind ?? null,
      // 正式完成申请的选择事实与结果一起持久；普通 progress 不落选择。
      completionSelection: normalizeCompletionSelection(attempt.phase),
      reason: attempt.reason ?? '',
    },
  };

  return {
    ok: true,
    attempts: next,
    record: next[index],
    wasAbandoned: record.state === ATTEMPT_STATE.abandoned,
  };
}

// ---------------------------------------------------------------------------
// 结算（确认无结果）
// ---------------------------------------------------------------------------

/**
 * 确认某次执行已停止、且不会再有结果。
 *
 * ★ H05：与 `settleAttempt` 是**同一类收尾**，只是没有结果。
 *   两条路径都要能在任务已取消/已完成时工作 —— 否则账本永远挂着未结算。
 *
 * @returns {{ok:true, attempts, noop?}|{ok:false,...}}
 */
export function closeAttempt(attempts, attemptId, { at = 0, reason = '' } = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  const index = list.findIndex((a) => a.attemptId === attemptId);

  if (index < 0) {
    return reject(REJECT.noActiveAttempt, 'attempt.attemptId', `没有登记过尝试 ${attemptId}`);
  }
  if (list[index].state === ATTEMPT_STATE.settled) {
    return { ok: true, attempts: list, noop: 'already_settled' };
  }

  const next = [...list];
  next[index] = {
    ...next[index],
    state: ATTEMPT_STATE.settled,
    settledAt: isTime(at) ? at : next[index].settledAt ?? 0,
    result: {
      stop: 'cancelled',
      usage: null,
      artifacts: [],
      phaseKind: null,
      reason: String(reason ?? '已确认停止').slice(0, 300),
    },
    closedWithoutResult: true,
  };
  return { ok: true, attempts: next };
}

/**
 * 归属核对：这次结果是不是**这一次**执行的。
 *
 * ★ 用记录登记时的 revision 核对，不是当前任务版本（H04/G04）：
 *   任务改目标后，旧执行的迟到结果仍应按它当初的版本被接收并归档。
 */
function checkOwnership(record, attempt) {
  if (attempt.taskRunId !== record.taskRunId) {
    return reject(
      REJECT.attemptMismatch,
      'attempt.taskRunId',
      `这次结果属于任务 ${attempt.taskRunId}，不是 ${record.taskRunId}`,
    );
  }
  if (attempt.revision !== record.revision) {
    return reject(
      REJECT.attemptMismatch,
      'attempt.revision',
      `这次执行登记在第 ${record.revision} 版目标，结果却报第 ${attempt.revision} 版`,
    );
  }
  if (attempt.botId !== record.botId) {
    return reject(
      REJECT.attemptMismatch,
      'attempt.botId',
      `这次执行分配给了 ${record.botId}，结果是 ${attempt.botId} 报的`,
    );
  }
  return null;
}

/**
 * 两次结果是不是同一件事（用于重放幂等判定）。
 *
 * ★ 第四轮 §3：`usage` 和 `reason` 也要比。
 *   用量从 1 改成 999 是有实际意义的差异，不能笼统算"同一结果"。
 *   （将来若要"事后补充未知用量"，那是独立协议，不混在重复结算里。）
 */
function sameResult(a, b) {
  if (!a) return false;
  if (a.stop !== b.stop) return false;
  if (JSON.stringify(a.artifacts ?? []) !== JSON.stringify(b.artifacts ?? [])) return false;
  if ((a.phaseKind ?? null) !== (b.phase?.kind ?? null)) return false;
  const storedSel = completionSelectionOfResult(a);
  const incomingSel = normalizeCompletionSelection(b.phase);
  if (storedSel.invalid) return false;
  if (storedSel.present) {
    if (JSON.stringify(storedSel.refs ?? []) !== JSON.stringify(incomingSel ?? [])) return false;
  } else if (storedSel.legacy) {
    // 旧账本没有选择字段：只允许与“无选择”的同一结果幂等，非空新选择视为冲突。
    if ((incomingSel ?? []).length) return false;
  } else if ((incomingSel ?? []).length) {
    return false;
  }
  if ((a.reason ?? '') !== (b.reason ?? '')) return false;
  if (!sameUsage(a.usage, b.usage ?? null)) return false;
  return true;
}

function sameUsage(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  for (const key of ['runs', 'inputTokens', 'outputTokens', 'ms']) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 账本结构校验（H03：绑定所在 TaskRun）
// ---------------------------------------------------------------------------

/**
 * 校验一整份账本。
 *
 * @param {object[]} attempts
 * @param {{taskRunId:string, revision:number}} owner 所在任务的身份与当前版本
 */
export function validateAttempts(attempts, { taskRunId, revision } = {}) {
  if (attempts === undefined || attempts === null) return ok();
  if (!Array.isArray(attempts)) {
    return reject(REJECT.badField, 'attempts', '账本必须是数组');
  }
  const seen = new Set();
  let activeCount = 0;

  for (const [index, a] of attempts.entries()) {
    const at = `attempts[${index}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return reject(REJECT.badField, at, '账本条目必须是对象');
    }
    if (!isId(a.attemptId)) return reject(REJECT.badField, `${at}.attemptId`, 'attemptId 不合法');
    if (seen.has(a.attemptId)) {
      return reject(REJECT.badField, `${at}.attemptId`, `attemptId 重复：${a.attemptId}`);
    }
    seen.add(a.attemptId);

    // ★ H03：记录必须属于所在 TaskRun
    if (!isId(a.taskRunId)) {
      return reject(REJECT.badField, `${at}.taskRunId`, '记录缺少所属任务；账本只能装本任务的执行');
    }
    if (taskRunId && a.taskRunId !== taskRunId) {
      return reject(
        REJECT.attemptMismatch,
        `${at}.taskRunId`,
        `这条执行属于任务 ${a.taskRunId}，不属于 ${taskRunId}`,
      );
    }

    if (!isId(a.botId)) return reject(REJECT.badField, `${at}.botId`, '执行者不合法');
    if (!Number.isInteger(a.revision) || a.revision < 1) {
      return reject(REJECT.badField, `${at}.revision`, 'revision 必须是正整数');
    }
    if (!Object.values(ATTEMPT_STATE).includes(a.state)) {
      return reject(REJECT.badField, `${at}.state`, `未知账本状态：${a.state}`);
    }

    // ★ H03：在途记录必须是当前版本；历史记录保留原版本
    if (a.state === ATTEMPT_STATE.registered) {
      activeCount++;
      if (Number.isInteger(revision) && a.revision !== revision) {
        return reject(
          REJECT.badField,
          `${at}.revision`,
          `在途执行登记在第 ${a.revision} 版，任务当前是第 ${revision} 版`,
        );
      }
    }

    if (a.state === ATTEMPT_STATE.settled && !a.result) {
      return reject(REJECT.badField, `${at}.result`, '已结算的记录必须有结果');
    }
    if (a.state !== ATTEMPT_STATE.settled && a.result) {
      return reject(REJECT.badField, `${at}.result`, '未结算的记录不该有结果');
    }
    if (a.state === ATTEMPT_STATE.settled && a.result) {
      const sel = completionSelectionOfResult(a.result);
      if (sel.invalid) return reject(REJECT.badField, `${at}.result.completionSelection`, '完成选择必须是字符串数组或 null');
      if (sel.present && sel.refs !== null && (a.result.phaseKind ?? null) !== PHASE.apply_completion) {
        return reject(REJECT.badField, `${at}.result.completionSelection`, '只有 apply_completion 结果能携带交付选择');
      }
    }
  }

  if (activeCount > 1) {
    return reject(REJECT.badField, 'attempts', `同时有 ${activeCount} 次在途执行，最多一个`);
  }
  return ok();
}