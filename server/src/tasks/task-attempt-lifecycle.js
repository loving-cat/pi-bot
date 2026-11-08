/**
 * 执行预留的**生命周期规则**（纯逻辑：无 IO、无时钟、无随机）。
 *
 * ## 为什么单独一个模块
 *
 * 前几轮每个入口各写一套判断：
 *
 *   · `reserve` 只看「有这个 ID 吗」→ 已退款的能复用；
 *   · `start` 只看「有这个占位吗」→ **已退款的能被推进到 started**；
 *   · `refund` 只看「阶段是不是 reserved」→ 不检查别人是否在跑；
 *   · `classifyOnRestart` 各模块自己猜阶段含义。
 *
 * 于是出现「已退款的执行又被开始，形成免扣额度的执行」（审查第三轮实测）。
 * 补一条 `refund→refund` 的断言不解决问题 —— 要**一套规则**，所有入口共用。
 *
 * ## 一条预留的四个阶段
 *
 * ```
 *   reserved ──start──→ started ──settle──→ settled
 *      │
 *      └──refund──→ refunded
 * ```
 *
 * 铁律：
 *
 *   1. **单向**。只能沿箭头走，绝不回退。
 *   2. `refunded` / `settled` 是**已结束事实**，不能被任何操作复活。
 *   3. 重新执行必须用**新的 attemptId**，不能复用已结束的身份。
 *   4. `refunded` 只表示「额度已退还」，**不表示可以再执行**。
 *
 * ## 一份预留记的是「授权给谁」
 *
 * 不只是「占了额度」，而是「授权给哪个任务的第几次尝试」：
 *
 * ```js
 * { attemptId, taskRunId, botId, revision, phase, ... }
 * ```
 *
 * 根额度侧的预留必须写清 `taskRunId` —— 否则子任务的执行无法与它对应，
 * 「根额度被谁用掉了」就无从核对（审查第三轮 B05 实测：子任务 started 了，根占位仍是 reserved）。
 */

/** 预留阶段。 */
export const PHASE = Object.freeze({
  /** 已扣额、尚未交给执行器 */
  reserved: 'reserved',
  /** 执行器已确认开始 */
  started: 'started',
  /** 已出结果（或确认无结果） */
  settled: 'settled',
  /** 额度已退还（**已结束**，不可再执行） */
  refunded: 'refunded',
});

/** 终局阶段：不能再变。 */
export const FINAL_PHASES = Object.freeze([PHASE.settled, PHASE.refunded]);

/**
 * 阶段序号。用来判断「是不是往回走」。
 *
 * `refunded` 故意给最大值 —— 它是终点，任何转移都算回退。
 */
const RANK = Object.freeze({
  [PHASE.reserved]: 0,
  [PHASE.started]: 1,
  [PHASE.settled]: 2,
  [PHASE.refunded]: 3,
});

export function isFinal(phase) {
  return FINAL_PHASES.includes(phase);
}

export function isLive(phase) {
  return phase === PHASE.reserved || phase === PHASE.started;
}

/**
 * 预留拒绝原因。
 */
export const REJECT = Object.freeze({
  noReservation: 'no_reservation',
  alreadySettled: 'already_settled',
  alreadyRefunded: 'already_refunded',
  cannotStart: 'cannot_start',
  cannotRefund: 'cannot_refund',
  cannotSettle: 'cannot_settle',
  identityMismatch: 'identity_mismatch',
});

function reject(code, text) {
  return { ok: false, code, text };
}

// ---------------------------------------------------------------------------
// 身份核对
// ---------------------------------------------------------------------------

/**
 * 这份预留是不是**这个任务、这次尝试、这个执行者、这个版本**的。
 *
 * ★ 审查第三轮 B05：根预留必须知道实际授权给谁。
 *   只比 `attemptId` 不够 —— 两个任务可能恰好用了同名 attempt。
 *
 * @param {object} reservation 已存在的预留
 * @param {{attemptId:string, taskRunId?:string, botId?:string, revision?:number}} claim 这次要核对的身份
 * @returns {null|{ok:false, code, text}}
 */
export function checkIdentity(reservation, claim) {
  if (!reservation) return reject(REJECT.noReservation, '没有对应的预留');

  if (claim.taskRunId !== undefined && reservation.taskRunId !== undefined) {
    if (reservation.taskRunId !== claim.taskRunId) {
      return reject(
        REJECT.identityMismatch,
        `这份预留授权给任务 ${reservation.taskRunId}，不是 ${claim.taskRunId}`,
      );
    }
  }
  if (claim.botId !== undefined && claim.botId !== null && reservation.botId !== undefined && reservation.botId !== null) {
    if (reservation.botId !== claim.botId) {
      return reject(
        REJECT.identityMismatch,
        `这份预留授权给执行者 ${reservation.botId}，不是 ${claim.botId}`,
      );
    }
  }
  if (claim.revision !== undefined && claim.revision !== null && reservation.revision !== undefined && reservation.revision !== null) {
    if (reservation.revision !== claim.revision) {
      return reject(
        REJECT.identityMismatch,
        `这份预留属于第 ${reservation.revision} 版目标，不是第 ${claim.revision} 版`,
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 四个操作 × 四个阶段
// ---------------------------------------------------------------------------

/**
 * **预留**（申请一次执行授权）。
 *
 * | 当前阶段 | 结果 |
 * |---|---|
 * | 不存在 | 新建 `reserved` ✅ |
 * | `reserved` | 复用（幂等）✅ |
 * | `started` | 复用（已经在跑，不重复扣）✅ |
 * | `settled` | **拒绝** —— 已结束 |
 * | `refunded` | **拒绝** —— 已退款，重新执行要用新 attemptId |
 *
 * ★ `refunded` 那行是审查第三轮点名的缺陷：原来返回复用了，于是能继续 start。
 */
export function planReserve(existing, { attemptId }) {
  if (!existing) {
    return { ok: true, action: 'create', phase: PHASE.reserved };
  }
  if (existing.phase === PHASE.settled) {
    return reject(REJECT.alreadySettled, `尝试 ${attemptId} 已经结算，不能重新预留（请用新 attemptId）`);
  }
  if (existing.phase === PHASE.refunded) {
    return reject(
      REJECT.alreadyRefunded,
      `尝试 ${attemptId} 的额度已经退还，不能再用它申请执行（请用新 attemptId）`,
    );
  }
  // reserved / started：复用，不重复扣额
  return { ok: true, action: 'reuse', phase: existing.phase };
}

/**
 * **开始执行**。
 *
 * | 当前阶段 | 结果 |
 * |---|---|
 * | 不存在 | 拒绝 |
 * | `reserved` | → `started` ✅ |
 * | `started` | 复用（幂等）✅ |
 * | `settled` | 拒绝 |
 * | `refunded` | **拒绝** —— 已退款不是执行授权 |
 */
export function planStart(existing, claim = {}) {
  if (!existing) return reject(REJECT.noReservation, '没有预留，不能开始执行');

  const mismatch = checkIdentity(existing, claim);
  if (mismatch) return mismatch;

  if (existing.phase === PHASE.started) return { ok: true, action: 'reuse', phase: PHASE.started };
  if (existing.phase === PHASE.reserved) return { ok: true, action: 'advance', phase: PHASE.started };
  if (existing.phase === PHASE.settled) {
    return reject(REJECT.alreadySettled, '这次尝试已经结算，不能再开始');
  }
  return reject(
    REJECT.alreadyRefunded,
    '这次尝试的额度已经退还，不是执行授权；要重新执行请用新的 attemptId',
  );
}

/**
 * **退款**。
 *
 * | 当前阶段 | 结果 |
 * |---|---|
 * | 不存在 | 拒绝 |
 * | `reserved` | → `refunded` ✅（只有从未开始的才能退）|
 * | `started` | **拒绝** —— 真实资源已消耗 |
 * | `settled` | 拒绝 |
 * | `refunded` | 幂等复用 ✅（不重复减余额）|
 */
export function planRefund(existing, claim = {}) {
  if (!existing) return reject(REJECT.noReservation, '没有对应的预留，不能退款');

  const mismatch = checkIdentity(existing, claim);
  if (mismatch) return mismatch;

  if (existing.phase === PHASE.refunded) {
    return { ok: true, action: 'reuse', phase: PHASE.refunded, alreadyRefunded: true };
  }
  // 已开始（或曾有 startedAt）：真实资源已消耗
  if (existing.phase === PHASE.started || existing.startedAt) {
    // ★ 例外：dispatch 被拒的那次，执行并没有真的发生。
    //
    //   占位会被推进到 started，但状态机的 dispatch 事件被拒时，
    //   模型一次都没跑。这时候拒绝退款会留下「已扣额度 + started 占位」
    //   的脏账：额度白扣、占位永不释放，任务重试时又撞 too_many_pending。
    //   只有「已经真正执行过」（有过结果或已结算）才不能退。
    const reallyRan = existing.phase === PHASE.settled || Boolean(existing.result);
    if (reallyRan) {
      return reject(
        REJECT.cannotRefund,
        '这次执行已经开始，真实资源已消耗，不能退款',
      );
    }
    return { ok: true, action: 'advance', phase: PHASE.refunded };
  }
  if (existing.phase === PHASE.settled) {
    return reject(REJECT.cannotRefund, '这次执行已经结算，不能退款');
  }
  return { ok: true, action: 'advance', phase: PHASE.refunded };
}

/**
 * **结算**。
 *
 * | 当前阶段 | 结果 |
 * |---|---|
 * | 不存在 | 拒绝 |
 * | `reserved` | 拒绝 —— 没开始就结算说明数据错了 |
 * | `started` | → `settled` ✅ |
 * | `settled` | 幂等复用 ✅ |
 * | `refunded` | 拒绝 |
 */
export function planSettle(existing, claim = {}) {
  if (!existing) {
    // 没有预留就结算：可能是「确认无结果」（执行器启动前失败）
    // 这种情况允许，但由调用方决定是否要占位存在
    return reject(REJECT.noReservation, '没有对应的预留，不能结算');
  }

  const mismatch = checkIdentity(existing, claim);
  if (mismatch) return mismatch;

  if (existing.phase === PHASE.settled) return { ok: true, action: 'reuse', phase: PHASE.settled };
  if (existing.phase === PHASE.started) return { ok: true, action: 'advance', phase: PHASE.settled };
  if (existing.phase === PHASE.refunded) {
    return reject(REJECT.alreadyRefunded, '这次尝试的额度已经退还，不能结算');
  }
  return reject(REJECT.cannotSettle, '这次执行还没开始，不能结算');
}

// ---------------------------------------------------------------------------
// 重启恢复
// ---------------------------------------------------------------------------

/**
 * 重启时给每份预留分类。
 *
 * ★ 审查第三轮要求：恢复分类必须明确区分**已退款、未开始和结果未知**，
 *   不能让不同模块各自猜阶段含义。
 *
 * | 阶段 | 分类 | 重启后 |
 * |---|---|---|
 * | `reserved` 且未 started | `notStarted` | 可释放（确未交给执行器）|
 * | `started` | `unknown` | **保留**，结果未知 |
 * | `settled` | `settled` | 无需处理 |
 * | `refunded` | `refunded` | 无需处理（已结束）|
 */
export function classify(reservations) {
  const list = Array.isArray(reservations) ? reservations : Object.values(reservations ?? {});
  const notStarted = [];
  const unknown = [];
  const settled = [];
  const refunded = [];

  for (const r of list) {
    if (!r || !r.attemptId) continue;
    if (r.phase === PHASE.settled) settled.push(r);
    else if (r.phase === PHASE.refunded) refunded.push(r);
    else if (r.phase === PHASE.started) unknown.push(r);
    else if (r.phase === PHASE.reserved && !r.startedAt) notStarted.push(r);
    else unknown.push(r);
  }
  return { notStarted, unknown, settled, refunded };
}

/**
 * 现在有多少执行真正在跑。
 *
 * ★ 只有 `started` 算在跑。`reserved` 是「已扣额未开始」，
 *   `refunded` / `settled` 是已结束。
 *
 * 审查第三轮 B05：根占位若停在 `reserved` 而子任务实际已 started，
 * 说明根不知道子已经开始 —— 那是同步缺陷，不是计数问题。
 */
export function runningCount(reservations) {
  const list = Array.isArray(reservations) ? reservations : Object.values(reservations ?? {});
  return list.filter((r) => r && r.phase === PHASE.started).length;
}

/**
 * 这份预留还占着额度吗。
 *
 * `reserved` 与 `started` 都占；`settled` 与 `refunded` 不占（已扣的已经用掉或已退回）。
 */
export function occupiesQuota(phase) {
  return phase === PHASE.reserved || phase === PHASE.started;
}