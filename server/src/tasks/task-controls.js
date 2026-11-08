/**
 * 任务控制：审批/输入到达、取消、改版与早到事实。
 *
 * ## 一条匹配规则
 *
 * 无论控制事实是**等待已登记后到达**、**早于门槛登记到达**，还是**恢复后重放**，
 * 都走同一套判定：事实带 {type, decision, ref, revision}，只有
 * 「引用相同且版本相同」才允许解除对应门槛。
 *
 *   · 早到：事实先持久保存，门槛稍后登记时由推进器核对消费；
 *   · 重复到达：同一事实只消费一次；
 *   · 旧版本/错引用：明确拒绝，不放行当前动作。
 *
 * ## 边界
 *
 *   · 拒绝只阻塞任务，不允许换工具绕过；
 *   · 取消只影响本任务及其子任务，不动同房间其他任务；
 *   · 改版升版本、旧待派作废、成果保留待重验。
 */
import { EVENT, STATE } from './task-contract.js';

/** 控制类型。 */
export const CONTROL = Object.freeze({
  approvalGranted: 'approval_granted',
  approvalRejected: 'approval_rejected',
  inputProvided: 'input_provided',
  cancel: 'cancel',
  revision: 'revision',
  /** 失败上抬：回到同一任务，由负责人继续推进（不影响门槛/版本） */
  escalated: 'escalated',
  /** 用户暂停 / 继续（只清用户暂停，不绕过预算暂停与门槛） */
  pause: 'pause',
  resume: 'resume',
  /**
   * 解除受阻：只清阻塞事实，让任务回到原步骤继续。
   *
   * 为什么需要它：执行失败会把任务判成 blocked 并停在那里，
   * 而真实情况常常是「外部原因已经消失 / 已经在别处做完了」。
   * 之前只有暂停和取消两条路，用户只能把做了一半的任务丢掉。
   */
  unblock: 'unblock',
});

const MAX_FACTS = 40;

/** 封闭的控制类型：未知/缺失一律拒绝，不能默认成批准。 */
const KNOWN_TYPES = new Set([
  CONTROL.approvalGranted, CONTROL.approvalRejected, CONTROL.inputProvided,
  CONTROL.cancel, CONTROL.revision, CONTROL.escalated, CONTROL.pause, CONTROL.resume, CONTROL.unblock,
]);

/** 真实决定归一化：store 用 granted/denied，事件用 granted/rejected。 */
export function normalizeDecision(type, decision) {
  const raw = String(decision ?? '').trim().toLowerCase();
  if (raw === 'denied' || raw === 'rejected' || raw === 'deny') return 'rejected';
  if (raw === 'granted' || raw === 'approved' || raw === 'allow' || raw === 'allowed') return 'granted';
  // 显式给了决定但不在封闭集合里（pending/cancel/拼写错误）→ 一律拒绝，不猜成批准
  if (raw) return 'unknown';
  if (type === CONTROL.approvalRejected) return 'rejected';
  if (type === CONTROL.approvalGranted) return 'granted';
  return 'unknown';
}

/** 把一次控制输入规范成可持久的事实。 */
export function controlFactOf(control = {}, taskRun, at) {
  const type = String(control.type ?? '');
  const decision = normalizeDecision(type, control.decision);
  return {
    type,
    decision,
    ref: control.approvalId ?? control.inputKey ?? control.ref ?? null,
    revision: control.revision ?? taskRun?.revision ?? null,
    at,
  };
}

/** 事实是否已被消费过（重复到达/重放）。 */
export function isConsumed(taskRun, fact) {
  return (taskRun.controlFacts ?? []).some(
    (f) => f.type === fact.type
      && f.ref === fact.ref
      && f.revision === fact.revision
      && f.consumed === true,
  );
}

/** 记下一条控制事实（去重）。 */
export function withFact(taskRun, fact) {
  const facts = [...(taskRun.controlFacts ?? [])];
  const same = facts.findIndex(
    (f) => f.type === fact.type && f.ref === fact.ref && f.revision === fact.revision,
  );
  if (same >= 0) facts[same] = { ...facts[same], ...fact };
  else facts.push(fact);
  return facts.slice(-MAX_FACTS);
}

/** 标记事实已消费。 */
export function markConsumed(taskRun, fact) {
  return withFact(taskRun, { ...fact, consumed: true });
}

/**
 * 匹配当前门槛。
 *
 * @returns {{ok:true, gate:object}|{ok:false, code:string, text:string}|{ok:true, gate:null}}
 */
export function matchGate(taskRun, fact) {
  const gate = (taskRun?.openGates ?? [])[0] ?? null;
  if (!gate) return { ok: true, gate: null };
  if (fact.revision !== taskRun.revision) {
    return { ok: false, code: 'stale_revision', text: '旧版本的控制事实不能放行当前动作' };
  }
  const wantKind = fact.type === CONTROL.inputProvided ? 'input' : 'approval';
  if (gate.kind !== wantKind) {
    return { ok: false, code: 'gate_kind_mismatch', text: `当前等的是 ${gate.kind}` };
  }
  if (!fact.ref || gate.ref !== fact.ref) {
    return { ok: false, code: 'gate_mismatch', text: '控制引用与当前门槛不一致' };
  }
  return { ok: true, gate };
}

/**
 * 应用一条控制事实。
 *
 * @param {object} p
 * @param {object} p.taskRuns TaskRunStore
 * @param {string} p.taskRunId
 * @param {object} p.control
 * @param {Function} p.settle 事务内归约（service 注入）
 * @param {Function} p.patch 写簿记字段
 * @param {Function} p.notify 事件唤醒
 * @param {Function} p.block 明确阻塞
 * @param {()=>number} p.clock
 */
export async function applyControl({
  taskRuns, taskRunId, control, settle, patch, notify, block, clock,
}) {
  const loaded = taskRuns.read(taskRunId);
  const taskRun = loaded?.status === 'found' ? loaded.taskRun : null;
  if (!taskRun) return { ok: false, code: 'not_found' };

  if (!KNOWN_TYPES.has(String(control.type ?? ''))) {
    return { ok: false, code: 'unknown_control_type', text: '控制类型不合法，已拒绝（不会默认放行）' };
  }

  if (control.type === CONTROL.cancel) return cancelTask({ taskRuns, taskRunId, control, settle, patch, clock });
  if (control.type === CONTROL.pause) {
    if (taskRun.state === STATE.cancelled || taskRun.state === STATE.completed) {
      return { ok: false, code: 'terminal', text: '任务已结束，不能暂停' };
    }
    const paused = await settle(taskRunId, { type: EVENT.paused, revision: taskRun.revision, at: clock(), reason: control.reason ?? '用户暂停' });
    return paused.ok ? { ok: true, applied: true } : paused;
  }
  if (control.type === CONTROL.resume) {
    if (taskRun.state !== STATE.paused_user && taskRun.state !== STATE.paused_budget) {
      return { ok: false, code: 'not_paused', text: '任务当前没有暂停' };
    }
    if (taskRun.state === STATE.paused_budget) {
      return { ok: false, code: 'budget_paused', text: '预算用尽需先追加额度，不能用继续绕过' };
    }
    const resumed = await settle(taskRunId, { type: EVENT.resumed, revision: taskRun.revision, at: clock() });
    if (!resumed.ok) return resumed;
    // ★ 暂停之前就已经受阻的，继续时要一起把阻塞解除。
    //
    //   否则会形成一个死循环：任务受阻 → 用户点暂停 → 再点继续 →
    //   状态回到 blocked（阻塞事实还在），任务永远救不回来。
    //   用户的意图很清楚：我要它继续干活。
    const afterPause = resumed.taskRun ?? (await (async () => null)());
    const stillBlocked = Boolean(
      (resumed.taskRun?.flags?.blockedAt) || resumed.taskRun?.state === STATE.blocked,
    );
    if (stillBlocked) {
      await settle(taskRunId, {
        type: EVENT.unblocked, revision: resumed.taskRun.revision, at: clock(),
        reason: '用户继续任务，同时解除原有阻塞',
      });
    }
    notify(taskRunId);
    return { ok: true, applied: true, alsoUnblocked: stillBlocked };
  }
  if (control.type === CONTROL.unblock) {
    // 只清阻塞事实：门禁、暂停、预算暂停、版本都不动，
    // 解除后按既有 next-action 重新判定该干什么。
    if (taskRun.state === STATE.completed || taskRun.state === STATE.cancelled) {
      return { ok: false, code: 'terminal', text: '任务已结束，不需要解除阻塞' };
    }
    if (!taskRun.flags?.blockedAt && taskRun.state !== STATE.blocked) {
      return { ok: false, code: 'not_blocked', text: '任务当前没有受阻' };
    }
    const released = await settle(taskRunId, {
      type: EVENT.unblocked, revision: taskRun.revision, at: clock(), reason: control.reason ?? '手动解除阻塞',
    });
    if (!released.ok) return released;
    await patch(taskRunId, { recoverableBlock: null, retryAt: null, retry: null, stall: null });
    notify(taskRunId);
    return { ok: true, applied: true, released: true };
  }

  if (control.type === CONTROL.escalated) {
    await patch(taskRunId, { escalation: { reason: String(control.reason ?? '').slice(0, 300), at: clock() } });
    notify(taskRunId);
    return { ok: true, routed: true };
  }
  if (control.type === CONTROL.revision) {
    return bumpRevision({ taskRuns, taskRunId, control, settle, patch, notify, clock });
  }

  let effective = control;
  if (control.type === CONTROL.approvalGranted || control.type === CONTROL.approvalRejected) {
    const decision = normalizeDecision(control.type, control.decision);
    if (decision === 'unknown') {
      return { ok: false, code: 'unknown_decision', text: '审批决定不明确，已拒绝' };
    }
    effective = { ...control, type: decision === 'rejected' ? CONTROL.approvalRejected : CONTROL.approvalGranted };
  }

  const fact = controlFactOf(effective, taskRun, clock());

  // 重复到达：只消费一次
  if (isConsumed(taskRun, fact)) {
    return { ok: true, applied: true, replayed: true };
  }

  // 先持久事实：即使门槛还没登记也不丢
  await patch(taskRunId, { controlFacts: withFact(taskRun, fact) });

  const matched = matchGate(taskRun, fact);
  if (!matched.ok) return matched;

  if (!matched.gate) {
    // 早到：事实已保存，等门槛登记时核对
    return { ok: true, applied: false, saved: true };
  }

  if (effective.type === CONTROL.approvalRejected) {
    const rejected = await settle(taskRunId, {
      type: EVENT.approval_rejected,
      revision: taskRun.revision,
      at: clock(),
      approvalId: fact.ref,
      reason: control.reason ?? '',
    });
    if (!rejected.ok) return rejected;
    await patch(taskRunId, {
      controlFacts: markConsumed(taskRuns.read(taskRunId).taskRun ?? taskRun, fact),
    });
    await block(taskRunId, '审批被拒绝，不能换工具绕过');
    return { ok: true, applied: true, blocked: true };
  }

  const released = await settle(taskRunId, {
    type: control.type === CONTROL.inputProvided ? EVENT.input_provided : EVENT.approval_granted,
    revision: taskRun.revision,
    at: clock(),
    ...(effective.type === CONTROL.inputProvided ? { inputKey: fact.ref } : { approvalId: fact.ref }),
  });
  if (!released.ok) return released;

  await patch(taskRunId, {
    controlFacts: markConsumed(taskRuns.read(taskRunId).taskRun ?? taskRun, fact),
  });
  notify(taskRunId);
  return { ok: true, applied: true };
}

/**
 * 核对早到的控制事实：门槛刚登记时消费一次。
 *
 * @returns {Promise<boolean>} 是否消费了至少一条
 */
export async function reconcileEarlyControls({
  taskRuns, taskRunId, settle, patch, notify, clock,
}) {
  let applied = false;
  for (let i = 0; i < 3; i += 1) {
    const loaded = taskRuns.read(taskRunId);
    const taskRun = loaded?.status === 'found' ? loaded.taskRun : null;
    if (!taskRun) break;
    const gate = (taskRun.openGates ?? [])[0];
    if (!gate) break;
    const fact = [...(taskRun.controlFacts ?? [])]
      .reverse()
      .find((f) => f.consumed !== true && f.ref === gate.ref && f.revision === taskRun.revision);
    if (!fact) break;

    if (fact.type === CONTROL.approvalRejected) {
      const rejected = await settle(taskRunId, {
        type: EVENT.approval_rejected,
        revision: taskRun.revision,
        at: clock(),
        approvalId: fact.ref,
        reason: '早到的拒绝',
      });
      if (!rejected.ok) break;
      await patch(taskRunId, {
        controlFacts: markConsumed(taskRuns.read(taskRunId).taskRun ?? taskRun, fact),
      });
      applied = true;
      continue;
    }

    const released = await settle(taskRunId, {
      type: fact.type === CONTROL.inputProvided ? EVENT.input_provided : EVENT.approval_granted,
      revision: taskRun.revision,
      at: clock(),
      ...(fact.type === CONTROL.inputProvided ? { inputKey: fact.ref } : { approvalId: fact.ref }),
    });
    if (!released.ok) break;
    await patch(taskRunId, {
      controlFacts: markConsumed(taskRuns.read(taskRunId).taskRun ?? taskRun, fact),
    });
    applied = true;
  }
  if (applied) notify(taskRunId);
  return applied;
}

/** 取消：本任务 + 子任务；已完成成果保留。 */
export async function cancelTask({ taskRuns, taskRunId, control, settle, patch, clock }) {
  const loaded = taskRuns.read(taskRunId);
  const taskRun = loaded?.status === 'found' ? loaded.taskRun : null;
  if (!taskRun) return { ok: false, code: 'not_found' };
  if (taskRun.state === STATE.cancelled || taskRun.state === STATE.completed) {
    return { ok: true, already: true };
  }

  const cancelled = await settle(taskRunId, {
    type: EVENT.cancelled,
    revision: taskRun.revision,
    at: clock(),
    reason: String(control.reason ?? '用户取消'),
  });
  if (!cancelled.ok) return cancelled;

  for (const childId of descendants(taskRuns, taskRunId)) {
    const child = taskRuns.read(childId);
    const run = child?.status === 'found' ? child.taskRun : null;
    if (!run || run.state === STATE.completed || run.state === STATE.cancelled) continue;
    await settle(childId, {
      type: EVENT.cancelled,
      revision: run.revision,
      at: clock(),
      reason: '父任务已取消',
    });
  }

  await patch(taskRunId, {
    nextAction: null,
    pendingDispatch: (taskRun.pendingDispatch ?? []).map((d) => (
      d.status === 'pending' ? { ...d, status: 'cancelled', cancelledAt: clock() } : d
    )),
  });
  return { ok: true, cancelled: true };
}

/** 改目标：升版本，旧待派作废，成果保留待重验。 */
export async function bumpRevision({
  taskRuns, taskRunId, control, settle, patch, notify, clock,
}) {
  const loaded = taskRuns.read(taskRunId);
  const taskRun = loaded?.status === 'found' ? loaded.taskRun : null;
  if (!taskRun) return { ok: false, code: 'not_found' };
  if (Number.isInteger(control.expectedRevision) && control.expectedRevision !== taskRun.revision) {
    return { ok: false, code: 'stale_revision', text: '改版操作针对的目标版本已过期' };
  }

  const expectedRevision = Number.isInteger(control.expectedRevision) ? control.expectedRevision : taskRun.revision;
  const bumped = await settle(taskRunId, {
    type: EVENT.revision_bumped,
    revision: taskRun.revision,
    expectedRevision,
    at: clock(),
    goal: control.goal,
    reason: control.reason ?? '目标有更新',
  });
  if (!bumped.ok) return bumped;

  await patch(taskRunId, {
    nextAction: null,
    stall: { rounds: 0, lastSignature: null },
    pendingDispatch: (taskRun.pendingDispatch ?? []).map((d) => (
      d.status === 'pending' ? { ...d, status: 'superseded', supersededAt: clock() } : d
    )),
  });
  if (control.deferNotify !== true) notify(taskRunId);
  return { ok: true, revision: bumped.taskRun.revision };
}

/** 直接子任务与更深层（按 parentTaskId）。 */
export function descendants(taskRuns, rootId) {
  const scan = taskRuns.listAll?.();
  const all = scan?.taskRuns ?? scan ?? [];
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const parent = stack.pop();
    for (const run of all) {
      if (run.parentTaskId === parent && !out.includes(run.id)) {
        out.push(run.id);
        stack.push(run.id);
      }
    }
  }
  return out;
}
