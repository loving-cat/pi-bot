/**
 * TaskRun 的**归约器**（纯函数：无 IO、无时钟、无随机）。
 *
 * ## 本轮（第四轮）的结构性改动
 *
 * 前三轮每轮都冒出新的"门槛丢失"缺口。根因不是某一个分支写错，
 * 而是**同一个事实存在多处**：
 *
 *   · `state` 说"在等批准"，`pendingWait` 记一份，`pausedFrom.pendingWait` 又记一份；
 *   · 暂停一层存一层，嵌套两次就互相覆盖（审查 H04 实测）。
 *
 * 现在改成：**门槛只存一处，状态全部派生。**
 *
 * ```
 * run.openGates = [{ kind, ref, describe }]    ← 未解除的等待，只在这里
 * run.flags     = { pausedAt, budgetPausedAt, blockedAt, verifyingAt }
 * run.state     = deriveState(run)             ← 派生，不手工维护
 * ```
 *
 * 于是"暂停"只是给 `pausedAt` 赋值，"阻塞"只是给 `blockedAt` 赋值 ——
 * 它们**碰不到** `openGates`，结构上就不可能擦掉审批门槛。
 * 暂停解除后状态自动落回 waiting_*，不需要"恢复到哪"的记忆。
 *
 * ## 五条不变量（审查 §4 的收口要求）
 *
 * 1. **每个成功结果都合法。** 所有路径共用一个出口：应用补丁 → 派生状态 →
 *    校验 → 返回。没有绕过校验的快捷分支（H01）。
 * 2. **身份一致。** Attempt 结果、账本记录、所在 TaskRun 三者必须对得上（H03）。
 * 3. **累计事实不可回退。** 账本不裁剪，长度即累计（H02）。
 * 4. **门槛不会被组合丢掉。** 暂停/阻塞/解除都不动 `openGates`（H04）。
 * 5. **两条收尾路径都能工作。** 有结果的 `attempt_finished` 与无结果的
 *    `attempt_closed` 在终态下同样可以结算（H05）。
 */
import {
  ALL_EVENTS,
  COMPLETION_ELIGIBLE_STOPS,
  EVENT,
  PHASE,
  REJECT,
  STATE,
  STATE_FIELDS,
  STATE_TEXT,
  STOP,
  WAIT_KIND,
  WAIT_STATE_OF,
  allowedFrom,
  isTerminal,
  isWaiting,
  ok,
  reject,
} from './task-contract.js';
import { validateAttemptResult, isCompletionCandidate } from './task-attempt.js';
import { checkCanRun } from './task-budget.js';
import { validateGoal, goalChanged } from './task-goal.js';
import {
  ATTEMPT_STATE,
  activeAttemptOf,
  abandonPending,
  closeAttempt,
  findAttempt,
  pendingAttemptsOf,
  registerAttempt,
  settleAttempt,
  validateAttempts,
} from './attempt-ledger.js';

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const isTime = (v) => Number.isFinite(v) && v > 0;

const WAIT_TEXT = Object.freeze({
  [WAIT_KIND.approval]: '待批准',
  [WAIT_KIND.input]: '待补充信息',
  [WAIT_KIND.dependency]: '待子任务',
});

// ---------------------------------------------------------------------------
// 状态派生（唯一真相）
// ---------------------------------------------------------------------------

/**
 * 由 `openGates` / `flags` / `attempts` 派生出任务状态。
 *
 * 优先级：终态 > 用户暂停 > 预算暂停 > 阻塞 > 等待 > 验收中 > 执行中 > 排队。
 *
 * 这个顺序就是产品语义：用户暂停最优先；阻塞比"等某件事"更紧急；
 * 都在时才轮到执行。改顺序会影响行为，改动前想清楚。
 */
export function deriveState(run) {
  if (isTerminal(run.state)) return run.state;

  const f = run.flags ?? {};
  if (f.pausedAt) return STATE.paused_user;
  if (f.budgetPausedAt) return STATE.paused_budget;
  if (f.blockedAt) return STATE.blocked;

  const gate = (run.openGates ?? [])[0];
  if (gate) return WAIT_STATE_OF[gate.kind] ?? STATE.queued;

  if (f.verifyingAt) return STATE.verifying;
  if (activeAttemptOf(run)) return STATE.running;
  return STATE.queued;
}

/** 由状态派生出"下一步该由谁做什么"，不手工维护。 */
function deriveNext(state, run) {
  switch (state) {
    case STATE.waiting_approval:
      return { action: 'await_user', actor: null, waitingFor: WAIT_KIND.approval };
    case STATE.waiting_input:
      return { action: 'await_user', actor: null, waitingFor: WAIT_KIND.input };
    case STATE.waiting_dependency:
      return { action: 'await_dependency', actor: null, waitingFor: WAIT_KIND.dependency };
    case STATE.paused_user:
      return { action: 'wait', actor: null, waitingFor: 'user_resume' };
    case STATE.paused_budget:
      return { action: 'wait', actor: null, waitingFor: 'budget' };
    case STATE.blocked:
      return { action: 'await_user', actor: null, waitingFor: 'blocker' };
    case STATE.verifying:
      return { action: 'verify', actor: null, waitingFor: null };
    case STATE.running:
      return { action: 'await_attempt', actor: activeAttemptOf(run)?.botId ?? null, waitingFor: null };
    case STATE.completed:
      return { action: 'deliver', actor: null, waitingFor: null };
    case STATE.cancelled:
      return { action: 'none', actor: null, waitingFor: null };
    default:
      return { action: 'dispatch', actor: null, waitingFor: null };
  }
}

// ---------------------------------------------------------------------------
// 结构校验
// ---------------------------------------------------------------------------

/** 校验一个 TaskRun 结构与状态自洽（创建、加载、归约出口共用）。 */
export function validateTaskRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    return reject(REJECT.missingField, 'taskRun', '任务记录不存在');
  }
  if (!isId(run.id)) return reject(REJECT.badField, 'id', '任务 ID 不合法');
  if (!isId(run.requestId)) return reject(REJECT.badField, 'requestId', 'requestId 不合法');
  if (!isId(run.rootTaskId)) return reject(REJECT.badField, 'rootTaskId', 'rootTaskId 不合法');

  const hasParent = run.parentTaskId !== null && run.parentTaskId !== undefined;
  if (hasParent) {
    if (!isId(run.parentTaskId)) return reject(REJECT.badField, 'parentTaskId', 'parentTaskId 不合法');
    if (run.parentTaskId === run.id) {
      return reject(REJECT.badField, 'parentTaskId', '任务不能是自己的父任务');
    }
    if (run.rootTaskId === run.id) {
      return reject(REJECT.badField, 'rootTaskId', '有父任务就不能自成根（否则根预算被绕过）');
    }
  } else if (run.rootTaskId !== run.id) {
    return reject(REJECT.badField, 'rootTaskId', '根任务的 rootTaskId 必须等于自身 ID');
  }

  if (!Number.isInteger(run.revision) || run.revision < 1) {
    return reject(REJECT.badField, 'revision', 'revision 必须是正整数');
  }
  if (!Number.isInteger(run.sequence) || run.sequence < 0) {
    return reject(REJECT.badField, 'sequence', 'sequence 必须是非负整数');
  }
  if (!Object.values(STATE).includes(run.state)) {
    return reject(REJECT.badField, 'state', `未知状态：${run.state}`);
  }
  if (!run.origin || !isId(run.origin.requesterId)) {
    return reject(REJECT.missingField, 'origin.requesterId', '发起人缺失');
  }

  const goal = validateGoal(run.goal, { requireVerification: true });
  if (!goal.ok) return goal;

  if (!run.progress || !Array.isArray(run.progress.evidence)) {
    return reject(REJECT.badField, 'progress.evidence', '证据列表缺失');
  }
  if (!Array.isArray(run.progress.unmet)) {
    return reject(REJECT.badField, 'progress.unmet', '缺项列表缺失');
  }

  const budget = validateBudget(run.budget);
  if (!budget.ok) return budget;

  // 账本：身份必须绑定本任务（H03）
  const ledger = validateAttempts(run.attempts, { taskRunId: run.id, revision: run.revision });
  if (!ledger.ok) return ledger;

  // 门槛事实
  const gates = validateGates(run.openGates);
  if (!gates.ok) return gates;

  const flags = validateFlags(run.flags);
  if (!flags.ok) return flags;

  // ★ 状态与在途尝试的一致性（STATE_FIELDS 的真正执行点）。
  //
  //   这张表原来没有任何调用方：completed / cancelled 挂着在途尝试、
  //   verifying 挂着在途尝试都能通过校验。表写了却没人查，
  //   下一位维护者会按注释以为得到了保护。
  const spec = STATE_FIELDS[run.state];
  if (spec) {
    const active = activeAttemptOf(run);
    if (spec.requireActive && !active) {
      return reject(REJECT.badField, 'state', `「${STATE_TEXT[run.state]}」必须有在途执行，实际没有`);
    }
    if (!spec.allowActive && active) {
      return reject(
        REJECT.badField,
        'attempts',
        `「${STATE_TEXT[run.state]}」不允许有在途执行（${active.attemptId}）`,
      );
    }
  }

  // ★ 状态必须等于派生值 —— 不允许"字段说一套、状态说另一套"
  const derived = deriveState(run);
  if (derived !== run.state) {
    return reject(
      REJECT.badField,
      'state',
      `状态字段是「${STATE_TEXT[run.state]}」，但按门槛与执行情况应为「${STATE_TEXT[derived]}」`,
    );
  }

  return ok();
}

/** 预算结构校验（F04）。 */
export function validateBudget(budget) {
  if (budget === null || budget === undefined) return ok();
  if (typeof budget !== 'object' || Array.isArray(budget)) {
    return reject(REJECT.badField, 'budget', '预算必须是对象或 null');
  }
  const { maxRuns, usedRuns, extraRuns, deadlineAt, concurrencyLimit } = budget;
  if (maxRuns !== null && maxRuns !== undefined) {
    if (!Number.isInteger(maxRuns) || maxRuns <= 0) {
      return reject(REJECT.badField, 'budget.maxRuns', 'maxRuns 必须是正整数或 null（不限额）');
    }
  }
  // ★ 与 task-budget.js 的规则对齐。
  //
  //   两份 validateBudget 各写一套，实测在「usedRuns > maxRuns」上不一致：
  //   那一份拒绝、这一份通过。于是同一个预算对象，写进存储时被判坏、
  //   但归约器认为没问题 —— 数据坏了却没人发现，账目从此对不上。
  if (concurrencyLimit !== null && concurrencyLimit !== undefined) {
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit <= 0) {
      return reject(REJECT.badField, 'budget.concurrencyLimit', 'concurrencyLimit 必须是正整数或 null');
    }
  }
  if (usedRuns !== undefined && usedRuns !== null) {
    if (!Number.isInteger(usedRuns) || usedRuns < 0) {
      return reject(REJECT.badField, 'budget.usedRuns', 'usedRuns 必须是非负整数');
    }
  }
  if (extraRuns !== undefined && extraRuns !== null) {
    if (!Number.isInteger(extraRuns) || extraRuns < 0) {
      return reject(REJECT.badField, 'budget.extraRuns', 'extraRuns 必须是非负整数');
    }
  }
  if (deadlineAt !== undefined && deadlineAt !== null) {
    if (!isTime(deadlineAt)) {
      return reject(REJECT.badField, 'budget.deadlineAt', 'deadlineAt 必须是毫秒时间戳');
    }
  }
  // 同样的口径：已用不能超过基础上限（追加额度另算）
  if (Number.isInteger(maxRuns) && maxRuns > 0
    && Number.isInteger(usedRuns) && usedRuns > maxRuns) {
    return reject(
      REJECT.badField,
      'budget.usedRuns',
      '已用 ' + usedRuns + ' 次超过上限 ' + maxRuns + '，预算数据不一致',
    );
  }
  return ok();
}

/** 门槛列表结构校验。 */
function validateGates(gates) {
  if (gates === undefined || gates === null) return ok();
  if (!Array.isArray(gates)) return reject(REJECT.badField, 'openGates', '门槛列表必须是数组');
  const seen = new Set();
  for (const [i, g] of gates.entries()) {
    const at = `openGates[${i}]`;
    if (!g || typeof g !== 'object') return reject(REJECT.badField, at, '门槛必须是对象');
    if (!Object.values(WAIT_KIND).includes(g.kind)) {
      return reject(REJECT.badField, `${at}.kind`, `未知门槛种类：${g.kind}`);
    }
    if (!isId(g.ref)) return reject(REJECT.badField, `${at}.ref`, '门槛必须有可核对的引用');
    const key = `${g.kind}:${g.ref}`;
    if (seen.has(key)) return reject(REJECT.badField, at, `同一条件重复登记：${key}`);
    seen.add(key);
  }
  return ok();
}

function validateFlags(flags) {
  if (flags === undefined || flags === null) return ok();
  if (typeof flags !== 'object' || Array.isArray(flags)) {
    return reject(REJECT.badField, 'flags', 'flags 必须是对象');
  }
  for (const key of ['pausedAt', 'budgetPausedAt', 'blockedAt', 'verifyingAt']) {
    const v = flags[key];
    if (v === null || v === undefined) continue;
    if (!isTime(v)) return reject(REJECT.badField, `flags.${key}`, `${key} 必须是毫秒时间戳`);
  }
  return ok();
}

// ---------------------------------------------------------------------------
// 归约主入口（单管道）
// ---------------------------------------------------------------------------

export function reduceTaskRun(run, event) {
  // ---- 1. 结构
  const valid = validateTaskRun(run);
  if (!valid.ok) return valid;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return reject(REJECT.missingField, 'event', '没有事件');
  }
  if (!ALL_EVENTS.includes(event.type)) {
    return reject(REJECT.badField, 'event.type', `未知事件：${event.type}`);
  }

  // ---- 2. 序号：**所有**事件都要过，包括结算路径（H01）
  if (!Number.isInteger(event.sequence)) {
    return reject(REJECT.missingField, 'event.sequence', '事件必须携带序号');
  }
  if (event.sequence < 0) {
    return reject(REJECT.badField, 'event.sequence', 'sequence 必须是非负整数');
  }
  if (event.sequence <= run.sequence) {
    return reject(
      REJECT.staleSequence,
      'event.sequence',
      `事件序号 ${event.sequence} 不大于当前 ${run.sequence}（迟到事件）`,
    );
  }

  // ---- 3. 确定这条事件的**唯一**执行身份（第五轮 P2）
  //
  //   ★ 以前这里取 `event.attemptId ?? event.attempt?.attemptId`：
  //     外层给 a1、内层给 a2 时，**版本校验用 a1、实际结算用 a2** ——
  //     同一条事件的身份校验和处理对象没有绑定。
  //
  //   现在按事件类型定死来源，两者不一致直接拒绝：
  //
  //     attempt_finished → 用**内层结果**里的 attemptId（那是真正要结算的）
  //     attempt_closed   → 用**外层** attemptId（没有内层结果）
  //     其余事件         → 不吃 attemptId
  const identity = resolveAttemptIdentity(event);
  if (!identity.ok) return identity;
  const attemptId = identity.attemptId;
  const record = attemptId ? findAttempt(run, attemptId) : null;
  const isSettlement =
    Boolean(record) &&
    (event.type === EVENT.attempt_finished || event.type === EVENT.attempt_closed);

  // 版本：结算用**记录自己的**版本核对，其余用当前版本
  const expectRevision = isSettlement ? record.revision : run.revision;
  if (!Number.isInteger(event.revision)) {
    return reject(REJECT.missingField, 'event.revision', '事件必须携带它针对的目标版本');
  }
  if (event.revision < 1) {
    return reject(REJECT.badField, 'event.revision', 'revision 必须是正整数');
  }
  // ★ 结算事件按**记录自己的版本**归档。
  //
  //   推进器是在当前版本下发起结算的（它拿的是 run.revision），
  //   但这次执行本身属于旧版本 —— 改版后旧尝试的结果仍然必须能落地，
  //   否则「旧结果按它自己的版本归档」这条设计根本无法实现：
  //   每次改版都会留下一批永远结算不了的尝试。
  //
  //   所以这里不再用「事件版本 > 记录版本」判 future，
  //   而是以记录版本为准，只保留「迟到」判断（事件版本 < 记录版本）。
  const effectiveRevision = isSettlement ? record.revision : event.revision;
  if (effectiveRevision < expectRevision) {
    return reject(
      REJECT.staleRevision,
      'event.revision',
      `事件针对第 ${effectiveRevision} 版目标，这里已是第 ${expectRevision} 版（迟到）`,
    );
  }
  if (effectiveRevision > expectRevision) {
    return reject(
      REJECT.futureRevision,
      'event.revision',
      `事件针对第 ${effectiveRevision} 版目标，但这里只有第 ${expectRevision} 版`,
    );
  }

  // ---- 5. 结算路径（H01/H05：同样经过上面的序号与版本校验）
  if (isSettlement) {
    return applySettlement(run, event, record);
  }

  // ---- 6. 终态守卫（结算已在上面放行）
  if (isTerminal(run.state)) {
    if (event.type === EVENT.cancelled && run.state === STATE.cancelled) {
      return ok({ taskRun: { ...run, sequence: event.sequence } , noop: 'already_cancelled' });
    }
    return reject(
      REJECT.terminalState,
      'state',
      `任务已是「${STATE_TEXT[run.state]}」，不再接受「${event.type}」`,
    );
  }

  // ---- 7. 来源状态
  const source = checkSource(run, event);
  if (!source.ok) {
    return reject(REJECT.illegalSource, 'state', source.text);
  }

  // ---- 8. 载荷校验，产出"对 run 的修改"
  const planned = planTransition(run, event);
  if (!planned.ok) return planned;

  // ---- 9. 统一出口（H01：不存在绕过校验的返回）
  return finish(run, event, planned);
}

/**
 * 唯一出口：应用补丁 → 派生状态 → 出口校验 → 返回。
 *
 * 所有成功路径都必须经过这里，包括结算与幂等。
 */
/**
 * 这个事件能从当前任务触发吗。
 *
 * 大部分事件直接用派生状态判断；但有两个例外，因为**暂停与阻塞可以并存**：
 *
 *   · resumed   ：只要求 pausedAt 或 budgetPausedAt 有值（哪怕同时被阻塞）；
 *   · unblocked ：只要求 blockedAt 有值（哪怕同时被暂停）。
 *
 * 派生状态只能显示优先级最高的那一个，所以"能不能解除"不能按它判断 ——
 * 否则"暂停中发生阻塞"就永远解除不了（H04 实测路径的一半）。
 */
/**
 * 按事件类型确定**唯一**的执行身份（第五轮 P2）。
 *
 * 一条事件只能指向一次执行。允许外层和内层各写一个 ID，就必须要求它们一致；
 * 不一致说明调用方把两条事件拼在了一起 —— 拒绝，而不是挑一个用。
 *
 * @returns {{ok:true, attemptId:string|null}|{ok:false, code, field, text}}
 */
function resolveAttemptIdentity(event) {
  const outer = normalizeId(event.attemptId);
  const inner = normalizeId(event.attempt?.attemptId);

  if (event.type === EVENT.attempt_finished) {
    // 完成事件：身份取**内层结果**（那才是要结算的）
    if (!inner) {
      return reject(REJECT.missingField, 'attempt.attemptId', '完成事件必须携带尝试结果里的 attemptId');
    }
    if (outer && outer !== inner) {
      return reject(
        REJECT.attemptMismatch,
        'event.attemptId',
        `事件外层写的是 ${outer}，结果里是 ${inner}；同一条事件不能指向两次执行`,
      );
    }
    return { ok: true, attemptId: inner };
  }

  if (event.type === EVENT.attempt_closed) {
    // 确认停止：没有内层结果，身份取外层
    if (!outer) {
      return reject(REJECT.missingField, 'event.attemptId', '确认停止必须说明是哪一次执行');
    }
    if (inner && inner !== outer) {
      return reject(
        REJECT.attemptMismatch,
        'event.attemptId',
        `事件外层写的是 ${outer}，结果里是 ${inner}；同一条事件不能指向两次执行`,
      );
    }
    return { ok: true, attemptId: outer };
  }

  // 其余事件不吃 attemptId
  return { ok: true, attemptId: null };
}

/** 把可能为空的 ID 规范成 string|null。 */
function normalizeId(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function checkSource(run, event) {
  const f = run.flags ?? {};

  if (event.type === EVENT.resumed) {
    if (!f.pausedAt && !f.budgetPausedAt) {
      return { ok: false, text: '当前没有暂停，不需要继续' };
    }
    return { ok: true };
  }

  if (event.type === EVENT.unblocked) {
    if (!f.blockedAt) {
      return { ok: false, text: '当前没有阻塞，不需要解除' };
    }
    return { ok: true };
  }

  return allowedFrom(event.type, run.state);
}

function finish(run, event, planned) {
  const patch = { ...(planned.patch ?? {}) };

  const next = {
    ...run,
    ...patch,
    sequence: event.sequence,
    revision: planned.bumpRevision ? run.revision + 1 : run.revision,
    updatedAt: isTime(event.at) ? event.at : run.updatedAt,
  };

  // 状态一律派生，不接受调用方指定
  next.state = deriveState(next);
  next.next = deriveNext(next.state, next);

  if (planned.effective && isTime(event.at)) next.lastEffectiveAt = event.at;

  // 出口校验：写坏的中间态不许返回
  const check = validateTaskRun(next);
  if (!check.ok) {
    return reject(
      REJECT.illegalTransition,
      check.field,
      `归约结果不自洽：${check.text}`,
    );
  }

  const result = { ok: true, taskRun: next };
  if (planned.noop) result.noop = planned.noop;
  return result;
}

/**
 * 结算已登记的执行。
 *
 * 有结果（`attempt_finished`）与确认无结果（`attempt_closed`）走同一条路。
 * 两者在终态下同样可用（H05）—— 取消之后账本也要能收尾。
 */
function applySettlement(run, event, record) {
  if (event.type === EVENT.attempt_finished) {
    const structural = validateAttemptResult(event.attempt);
    if (!structural.ok) return structural;
    const attempt = structural.attempt;

    const settled = settleAttempt(run.attempts, attempt, {
      at: isTime(event.at) ? event.at : run.updatedAt,
    });
    if (!settled.ok) return settled;

    // 重复结算：幂等，不改变任务状态（但序号照常前进）
    if (settled.noop === 'already_settled') {
      return finish(run, event, {
        patch: { attempts: settled.attempts },
        noop: 'already_settled',
      });
    }

    // 作废后迟到的结果：结算但不推进状态
    if (settled.wasAbandoned) {
      return finish(run, event, {
        patch: { attempts: settled.attempts },
        effective: hasNewArtifacts(run, attempt.artifacts),
        noop: 'abandoned_attempt',
      });
    }

    // 正常结算：推进状态
    const candidate = isCompletionCandidate(attempt, { eligibleStops: COMPLETION_ELIGIBLE_STOPS });
    const patch = { attempts: settled.attempts };

    // 进入等待：登记门槛（F01）
    if (isWaitingStateHint(attempt)) {
      const wait = attempt.phase?.waitFor;
      if (!wait) {
        return reject(
          REJECT.missingField,
          'attempt.phase.waitFor',
          '进入等待必须带等待描述与引用',
        );
      }
      patch.openGates = [
        {
          kind: wait.kind,
          ref: wait.ref,
          describe: wait.describe ?? '',
          openedAt: isTime(event.at) ? event.at : run.updatedAt,
        },
      ];
      patch.flags = { ...(run.flags ?? {}), verifyingAt: null };
    } else if (candidate.candidate) {
      // 进入验收
      patch.flags = { ...(run.flags ?? {}), verifyingAt: isTime(event.at) ? event.at : run.updatedAt };
    } else if (attempt.stop === STOP.failed || attempt.phase?.kind === PHASE.blocked) {
      // 执行失败或自报阻塞 → 阻塞
      patch.flags = {
        ...(run.flags ?? {}),
        blockedAt: isTime(event.at) ? event.at : run.updatedAt,
        blockedReason: String(attempt.reason ?? '').slice(0, 300) || '执行失败',
        verifyingAt: null,
      };
    } else {
      // 让出/跳过/返回但未完成 → 继续排队
      patch.flags = { ...(run.flags ?? {}), verifyingAt: null };
    }

    // 产物与缺项
    const newEvidence = collectEvidence(run, attempt);
    if (newEvidence.length) {
      patch.progress = { ...(run.progress ?? {}), evidence: newEvidence };
    }
    if (attempt.phase?.unmet?.length) {
      patch.progress = { ...(patch.progress ?? run.progress ?? {}), unmet: attempt.phase.unmet };
    }

    return finish(run, event, {
      patch,
      effective: hasNewArtifacts(run, attempt.artifacts),
    });
  }

  // attempt_closed：确认停止，无结果
  const closed = closeAttempt(run.attempts, event.attemptId, {
    at: isTime(event.at) ? event.at : run.updatedAt,
    reason: event.reason,
  });
  if (!closed.ok) return closed;

  return finish(run, event, {
    patch: { attempts: closed.attempts },
    effective: true,
    noop: closed.noop,
  });
}

/** 这次尝试的结果是否在要求"进入某个等待态"。 */
function isWaitingStateHint(attempt) {
  return Boolean(attempt.phase?.waitFor);
}

// ---------------------------------------------------------------------------
// 逐事件（只产出 patch，不碰 state）
// ---------------------------------------------------------------------------

function planTransition(run, event) {
  switch (event.type) {
    case EVENT.dispatch:
      return planDispatch(run, event);
    case EVENT.attempt_finished:
      // 走到这里说明账本里没登记过这个 attemptId —— 那是异常，不是正常结算
      return reject(
        REJECT.noActiveAttempt,
        'attempt.attemptId',
        `没有登记过尝试 ${event.attempt?.attemptId ?? '(空)'}，不能接收它的结果`,
      );
    case EVENT.attempt_closed:
      return reject(
        REJECT.noActiveAttempt,
        'event.attemptId',
        `没有登记过尝试 ${event.attemptId ?? '(空)'}，不能确认它已停止`,
      );
    case EVENT.verification_finished:
      return planVerificationFinished(run, event);
    case EVENT.approval_granted:
      return planReleaseGate(run, event, WAIT_KIND.approval, '已批准，继续执行');
    case EVENT.approval_rejected:
      return planRejectGate(run, event, WAIT_KIND.approval, '用户拒绝了该操作');
    case EVENT.input_provided:
      return planReleaseGate(run, event, WAIT_KIND.input, '信息已补齐');
    case EVENT.dependency_settled:
      return planReleaseGate(run, event, WAIT_KIND.dependency, '子任务已结束');
    case EVENT.paused:
      return planPause(run, event);
    case EVENT.resumed:
      return planResume(run, event);
    case EVENT.budget_exhausted:
      return planBudgetExhausted(run, event);
    case EVENT.budget_extended:
      return planBudgetExtended(run, event);
    case EVENT.revision_bumped:
      return planRevisionBumped(run, event);
    case EVENT.blocked:
      return planBlocked(run, event);
    case EVENT.unblocked:
      return planUnblocked(run, event);
    case EVENT.cancelled:
      return planCancelled(run, event);
    default:
      return reject(REJECT.badField, 'event.type', `未处理的事件：${event.type}`);
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

function planDispatch(run, event) {
  if (!isId(event.attemptId)) {
    return reject(REJECT.missingField, 'event.attemptId', '派发必须登记本次尝试的 attemptId');
  }
  if (!isId(event.botId)) {
    return reject(REJECT.missingField, 'event.botId', '派发必须登记执行者');
  }

  const registered = registerAttempt(run.attempts, {
    attemptId: event.attemptId,
    taskRunId: run.id,
    botId: event.botId,
    startedAt: isTime(event.at) ? event.at : 0,
    revision: run.revision,
  });
  if (!registered.ok) return registered;

  // 未结算的执行还在 → 不能派新的（G02）
  const pending = pendingAttemptsOf(run);
  if (pending.length) {
    return reject(
      REJECT.tooManyPending,
      'attempts',
      `还有 ${pending.length} 次执行未结算（${pending.map((a) => a.attemptId).join('、')}），` +
        '确认它们已停止或等结果回来再派发',
    );
  }

  const budget = checkBudget(run, event.at);
  if (!budget.ok) return budget;

  return {
    ok: true,
    patch: {
      attempts: registered.attempts,
      reason: '开始执行',
      flags: { ...(run.flags ?? {}), verifyingAt: null },
    },
    effective: false,
  };
}

function checkBudget(run, at) {
  const budget = run.budget;
  if (!budget) return ok();
  // ★ 用 task-budget 的统一判定，不要在这里再写一份。
  //
  //   原来这里只看 attempts.length：忽略 deadlineAt（过期任务照样能派），
  //   而且与 checkCanRun 的结论经常相反（一个说还能跑、一个说用尽了）。
  //   预算只能有一个判定点。
  const gate = checkCanRun(budget, {
    at: isTime(at) ? at : run.updatedAt,
    runningCount: 0,
    usedFromLedger: (run.attempts ?? []).length,
  });
  if (gate.ok) return ok();
  return reject(REJECT.illegalSource, 'budget', gate.text ?? gate.code ?? '预算不允许继续派发');
}

// ---------------------------------------------------------------------------
// verification_finished
// ---------------------------------------------------------------------------

function planVerificationFinished(run, event) {
  if (typeof event.passed !== 'boolean') {
    return reject(REJECT.missingField, 'event.passed', '验收结论必须是明确的通过或不通过');
  }
  if (event.passed) {
    // ★ 「验收通过」不能是一个空壳断言。
    //
    //   归约器无条件采信 event.passed 就能把任务标成完成 —— 但验收本该
    //   真的跑过条件（产物/专家确认/文件）。一个来源不明的事件
    //   （旧版本、误发、别的执行串进来）就能让任务凭空完成，
    //   而实际上没人验过。
    //   这里要求：事件要么带上验收证据（条件 ID 或理由），
    //   要么说明这是对当前在验目标的结论（revision 对齐已在前面校验）。
    const evidence = Array.isArray(event.verifiedConditions)
      ? event.verifiedConditions.filter((c) => typeof c === 'string' && c.trim()).length
      : 0;
    const hasReason = typeof event.reason === 'string' && event.reason.trim().length >= 2;
    if (!evidence && !hasReason) {
      return reject(
        REJECT.missingField,
        'event.reason',
        '验收通过必须说明依据（验过了哪些条件），不能是空结论',
      );
    }
    return {
      ok: true,
      patch: {
        state: STATE.completed,
        reason: String(event.reason ?? '验收通过').slice(0, 300),
        flags: { ...(run.flags ?? {}), verifyingAt: null },
        openGates: [],
      },
      effective: true,
    };
  }

  const provided = Array.isArray(event.unmet)
    ? event.unmet.map((u) => String(u ?? '').trim()).filter(Boolean)
    : null;
  const nextUnmet = provided ?? (run.progress?.unmet ?? []);

  return {
    ok: true,
    patch: {
      reason: String(event.reason ?? '验收未通过，需要继续').slice(0, 300),
      flags: { ...(run.flags ?? {}), verifyingAt: null },
      progress: { ...(run.progress ?? {}), unmet: nextUnmet },
    },
    effective: provided !== null && unmetChanged(run.progress?.unmet ?? [], nextUnmet),
  };
}

function unmetChanged(before, after) {
  if (before.length !== after.length) return true;
  const a = [...before].sort();
  const b = [...after].sort();
  return a.some((x, i) => x !== b[i]);
}

// ---------------------------------------------------------------------------
// 门槛解除（只动 openGates）
// ---------------------------------------------------------------------------

/**
 * 解除一个门槛。
 *
 * ★ 引用必须两边都有且相等（F01）：只有"都有且不同才拒"会放过"事件没带引用"。
 * ★ 只移除**匹配的那一个**：其他门槛原样保留（H04）。
 */
function planReleaseGate(run, event, kind, reasonText) {
  const gates = run.openGates ?? [];
  const index = gates.findIndex((g) => g.kind === kind);
  if (index < 0) {
    return reject(
      REJECT.waitMismatch,
      'openGates',
      `当前没有在等「${WAIT_TEXT[kind]}」，不能解除`,
    );
  }
  const gate = gates[index];
  const provided = eventRefFor(kind, event);

  if (!isId(gate.ref)) {
    return reject(REJECT.badField, 'openGates.ref', '登记的门槛没有可核对的引用');
  }
  if (!isId(provided)) {
    return reject(
      REJECT.missingField,
      refFieldName(kind),
      '解除等待必须带上是哪一件事的引用（否则任何解除都能放行）',
    );
  }
  if (gate.ref !== provided) {
    return reject(
      REJECT.waitMismatch,
      refFieldName(kind),
      `解除的是 ${provided}，当前等的是 ${gate.ref}`,
    );
  }

  return {
    ok: true,
    patch: {
      openGates: gates.filter((_, i) => i !== index),
      reason: reasonText,
    },
    effective: true,
  };
}

function planRejectGate(run, event, kind, reasonText) {
  const gates = run.openGates ?? [];
  const index = gates.findIndex((g) => g.kind === kind);
  if (index < 0) {
    return reject(REJECT.waitMismatch, 'openGates', `当前没有在等「${WAIT_TEXT[kind]}」`);
  }
  // ★ 拒绝同样要核对引用：拒绝的是**哪一件事**。
  //
  //   原来只按 kind 找第一个门槛就移除 —— 于是一个完全不相干的
  //   approvalId 也能把任意审批门槛解除并把任务阻塞。
  //   批准和拒绝对「解除的是哪一件事」应当一样严格。
  const gate = gates[index];
  const provided = eventRefFor(kind, event);
  if (!isId(gate.ref)) {
    return reject(REJECT.badField, 'openGates.ref', '登记的门槛没有可核对的引用');
  }
  if (!isId(provided)) {
    return reject(
      REJECT.missingField,
      refFieldName(kind),
      '拒绝等待必须带上是哪一件事的引用（否则任何拒绝都能解除门槛）',
    );
  }
  if (gate.ref !== provided) {
    return reject(
      REJECT.waitMismatch,
      refFieldName(kind),
      `拒绝的是 ${provided}，当前等的是 ${gate.ref}`,
    );
  }
  return {
    ok: true,
    patch: {
      openGates: gates.filter((_, i) => i !== index),
      reason: reasonText,
      flags: {
        ...(run.flags ?? {}),
        blockedAt: isTime(event.at) ? event.at : run.updatedAt,
        blockedReason: reasonText,
      },
    },
  };
}

function refFieldName(kind) {
  return {
    [WAIT_KIND.approval]: 'event.approvalId',
    [WAIT_KIND.input]: 'event.inputKey',
    [WAIT_KIND.dependency]: 'event.dependencyTaskId',
  }[kind];
}

function eventRefFor(kind, event) {
  const value = {
    [WAIT_KIND.approval]: event.approvalId,
    [WAIT_KIND.input]: event.inputKey,
    [WAIT_KIND.dependency]: event.dependencyTaskId,
  }[kind];
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// 暂停 / 恢复（H04：完全不碰 openGates）
// ---------------------------------------------------------------------------

/**
 * 暂停 = 请求停止。
 *
 * ★ 只给 `flags.pausedAt` 赋值，**不碰** `openGates`。
 *   于是嵌套多少次暂停/阻塞都不会覆盖门槛 —— 结构上不可能丢（H04）。
 */
function planPause(run, event) {
  // ★ 「预算暂停」再被用户暂停也必须受理。
  //
  //   用户意图很明确：别跑了。原来 paused_budget 不在允许来源里，
  //   点暂停直接 illegal_source —— 一个已经停住的任务拒绝被暂停，
  //   用户只会觉得按钮坏了。两种暂停是不同原因，可以同时成立：
  //   用户暂停优先，额度仍然记着。
  return {
    ok: true,
    patch: {
      reason: String(event.reason ?? '用户暂停').slice(0, 300),
      flags: { ...(run.flags ?? {}), pausedAt: isTime(event.at) ? event.at : run.updatedAt },
      attempts: abandonPending(run.attempts, {
        reason: '暂停',
        at: isTime(event.at) ? event.at : run.updatedAt,
      }),
    },
  };
}

/**
 * 继续。
 *
 * ★ 只清 `pausedAt` / `budgetPausedAt`，门槛自动决定落回哪个状态（H04）。
 */
function planResume(run, event) {
  if (run.state === STATE.paused_budget) {
    // ★ 必须有**尚未花掉的**额度，而不是"曾经追加过"。
    //
    //   extraRuns 是累计追加次数，只看它 > 0 等于：追加过一次之后，
    //   此后任何一次预算用尽都能直接点「继续」绕过 —— 额度形同虚设。
    //   这里改成看剩余：追加额度 + 基础额度 - 已用。
    const maxRuns = run.budget?.maxRuns ?? null;
    const used = Number(run.budget?.usedRuns ?? 0);
    const ownExtra = Number(run.budget?.extraRuns ?? 0);
    const shared = run.budget?.sharedWithRoot === true
      ? Number(run.budget?.sharedExtraRuns ?? 0) : 0;
    const extra = ownExtra + shared;
    const remaining = maxRuns === null ? Infinity
      : (Number(maxRuns) + extra) - (Number.isInteger(used) ? used : 0);
    if (!(remaining > 0) || (extra <= 0 && maxRuns !== null)) {
      return reject(
        REJECT.budgetNotExtended,
        'budget',
        '预算没有可用的追加额度，不能继续（请先追加额度）',
      );
    }
  }
  return {
    ok: true,
    patch: {
      reason: '已继续',
      flags: { ...(run.flags ?? {}), pausedAt: null, budgetPausedAt: null },
    },
  };
}

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

function planBudgetExhausted(run, event) {
  return {
    ok: true,
    patch: {
      reason: String(event.reason ?? '预算已用尽').slice(0, 300),
      flags: { ...(run.flags ?? {}), budgetPausedAt: isTime(event.at) ? event.at : run.updatedAt },
      attempts: abandonPending(run.attempts, {
        reason: '预算暂停',
        at: isTime(event.at) ? event.at : run.updatedAt,
      }),
    },
  };
}

function planBudgetExtended(run, event) {
  const extra = event.extraRuns;
  if (!Number.isInteger(extra) || extra <= 0) {
    return reject(REJECT.badField, 'event.extraRuns', '追加额度必须是正整数');
  }
  const budget = run.budget && typeof run.budget === 'object' ? { ...run.budget } : {};
  if (budget.maxRuns !== null && budget.maxRuns !== undefined) {
    budget.maxRuns = Number(budget.maxRuns) + extra;
  }
  budget.extraRuns = Number(budget.extraRuns ?? 0) + extra;
  return {
    ok: true,
    patch: {
      budget,
      reason: `额度追加 ${extra}（累计追加 ${budget.extraRuns}），等待继续`,
    },
    effective: true,
  };
}

// ---------------------------------------------------------------------------
// 目标变更
// ---------------------------------------------------------------------------

function planRevisionBumped(run, event) {
  if (event.expectedRevision !== undefined && event.expectedRevision !== run.revision) {
    return reject(REJECT.staleRevision ?? REJECT.badField, 'event.expectedRevision', '改版事件针对旧版本，不能作用到当前记录');
  }
  const validated = validateGoal(event.goal, { requireVerification: true });
  if (!validated.ok) return validated;
  if (!goalChanged(run.goal, validated.goal)) {
    return reject(REJECT.badField, 'event.goal', '目标没有实际变化，不需要升版本');
  }

  return {
    ok: true,
    bumpRevision: true,
    effective: true,
    patch: {
      goal: validated.goal,
      reason: String(event.reason ?? '目标有更新').slice(0, 300),
      // 旧目标时代的门槛引用已对不上，全部作废（这是唯一允许批量清空门槛的路径之一）
      openGates: [],
      flags: { ...(run.flags ?? {}), verifyingAt: null },
      // 旧执行作废但不丢弃：报回结果时仍按它自己的 revision 结算
      attempts: abandonPending(run.attempts, {
        reason: '目标变更',
        at: isTime(event.at) ? event.at : run.updatedAt,
      }),
      progress: {
        ...(run.progress ?? {}),
        evidence: (run.progress?.evidence ?? []).map((e) => ({
          ...e,
          verdict: 'pending',
          verifiedAt: null,
          staleForRevision: true,
        })),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 阻塞 / 解除 / 取消（H04 / G06）
// ---------------------------------------------------------------------------

/**
 * 阻塞：新增一个阻塞原因，**不动** openGates。
 */
function planBlocked(run, event) {
  return {
    ok: true,
    patch: {
      reason: String(event.reason ?? '阻塞').slice(0, 300),
      flags: {
        ...(run.flags ?? {}),
        blockedAt: isTime(event.at) ? event.at : run.updatedAt,
        blockedReason: String(event.reason ?? '阻塞').slice(0, 300),
      },
      attempts: abandonPending(run.attempts, {
        reason: '阻塞',
        at: isTime(event.at) ? event.at : run.updatedAt,
      }),
    },
    effective: true,
  };
}

/**
 * 解除阻塞：只清 blockedAt；门槛还在就自动落回等待态（H04）。
 */
function planUnblocked(run, event) {
  return {
    ok: true,
    patch: {
      reason: String(event.reason ?? '阻塞已解除').slice(0, 300),
      flags: {
        ...(run.flags ?? {}),
        blockedAt: null,
        blockedReason: '',
      },
    },
    effective: true,
  };
}

function planCancelled(run, event) {
  return {
    ok: true,
    patch: {
      state: STATE.cancelled,
      reason: String(event.reason ?? '用户取消').slice(0, 300),
      // 取消是终态规则：清空门槛与暂停标记
      openGates: [],
      flags: { pausedAt: null, budgetPausedAt: null, blockedAt: null, blockedReason: '', verifyingAt: null },
      attempts: abandonPending(run.attempts, {
        reason: '取消',
        at: isTime(event.at) ? event.at : run.updatedAt,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

function collectEvidence(run, attempt) {
  const evidence = [...(run.progress?.evidence ?? [])];
  const known = new Set(evidence.map((e) => `${e.source}:${e.attemptId ?? ''}:${e.ref}`));
  for (const ref of attempt.artifacts) {
    const key = `attempt:${attempt.attemptId}:${ref}`;
    if (known.has(key)) continue;
    known.add(key);
    evidence.push({
      ref,
      kind: 'artifact',
      source: 'attempt',
      attemptId: attempt.attemptId,
      revision: attempt.revision,
      verdict: 'pending',
      verifiedAt: null,
    });
  }
  for (const item of attempt.phase?.claimedEvidence ?? []) {
    const key = `claim:${attempt.attemptId}:${item.ref}`;
    if (known.has(key)) continue;
    known.add(key);
    evidence.push({
      ref: item.ref,
      kind: 'claim',
      note: item.note ?? '',
      source: 'claim',
      attemptId: attempt.attemptId,
      revision: attempt.revision,
      verdict: 'pending',
      verifiedAt: null,
    });
  }
  return evidence.slice(-500);
}

function hasNewArtifacts(run, artifacts) {
  if (!artifacts?.length) return false;
  const known = new Set((run.progress?.evidence ?? []).map((e) => e.ref));
  return artifacts.some((ref) => !known.has(ref));
}

export function makePendingWait(kind, ref = null, note = '') {
  const state = WAIT_STATE_OF[kind];
  if (!state) return reject(REJECT.badField, 'kind', `未知等待种类：${kind}`);
  if (!isId(ref)) return reject(REJECT.missingField, 'ref', '等待必须有可核对的引用');
  return ok({ gate: { kind, ref, describe: String(note ?? '').slice(0, 300) } });
}