/**
 * AttemptResult 的构造与**严格校验**（纯逻辑）。
 *
 * ## 审查 R03 实测到的缺口
 *
 *   · `attempt_finished` 不带 attempt 也返回成功并安排后续 dispatch；
 *   · 当前任务接受了**另一个 taskRunId、另一个 revision、另一个 Bot** 的
 *     AttemptResult，并进入 verifying。
 *
 * 根因是归约入口没校验，直接把 `event.attempt` 当可信数据用。
 * 这里补上：字段全量校验 + 与实际任务/活动尝试的关联核对。
 *
 * ## 为什么"关联"要单独一层
 *
 * 结构合法（是 AttemptResult）不等于"属于这个任务的这一次尝试"。
 * 并发场景下两个任务的结果交错回来，只验结构会把 A 的结果记到 B 上。
 * 所以分两步：`validateAttemptResult`（结构）、`matchAttempt`（关联）。
 */
import {
  ALL_STOPS,
  ALL_PHASES,
  REJECT,
  reject,
  ok,
} from './task-contract.js';

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const isTime = (v) => Number.isFinite(v) && v > 0;
const nonNegInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * 用量规范化。
 *
 * ★ 未知是 `null`，不是 `0`。
 *   `Number(null) === 0` 且是有限数 —— 直接 `isFinite(Number(v))` 会把
 *   "不知道花了多少"写成 0，预算统计就变成假账本（审查 R03 的边角）。
 *
 * 负数不是"合法的 0"，直接判非法：负次数/负时长说明上游算错了，
 * 悄悄归零会让错误消失。
 * @returns {{ok:true, usage:object|null}|{ok:false, code:string, field:string, text:string}}
 */
export function normalizeUsage(usage) {
  if (usage === undefined || usage === null) return ok({ usage: null });
  if (typeof usage !== 'object' || Array.isArray(usage)) {
    return reject(REJECT.badField, 'attempt.usage', '用量必须是对象或 null');
  }
  const out = { runs: null, inputTokens: null, outputTokens: null, ms: null, unknown: [] };
  for (const key of ['runs', 'inputTokens', 'outputTokens', 'ms']) {
    const raw = usage[key];
    if (raw === undefined || raw === null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return reject(REJECT.badField, `attempt.usage.${key}`, `${key} 不是有效数字`);
    }
    if (n < 0) {
      return reject(REJECT.badField, `attempt.usage.${key}`, `${key} 不能是负数`);
    }
    out[key] = n;
  }
  if (Array.isArray(usage.unknown)) {
    out.unknown = usage.unknown.map((u) => String(u ?? '').trim()).filter(Boolean).slice(0, 20);
  }
  return ok({ usage: out });
}

/**
 * 阶段报告规范化。非法 kind 一律拒绝（不能悄悄当没报）。
 * @returns {{ok:true, phase:object|null}|{ok:false, ...}}
 */
export function normalizePhase(phase) {
  if (phase === undefined || phase === null) return ok({ phase: null });
  if (typeof phase !== 'object' || Array.isArray(phase)) {
    return reject(REJECT.badField, 'attempt.phase', '阶段报告必须是对象或 null');
  }
  const kind = String(phase.kind ?? '').trim();
  if (!ALL_PHASES.includes(kind)) {
    return reject(REJECT.badField, 'attempt.phase.kind', `未知阶段报告：${kind || '(空)'}`);
  }
  const strList = (v, limit) =>
    Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, limit) : [];
  const evidence = [];
  if (Array.isArray(phase.claimedEvidence)) {
    for (const [index, item] of phase.claimedEvidence.entries()) {
      if (!item || typeof item !== 'object') {
        return reject(REJECT.badField, `attempt.phase.claimedEvidence[${index}]`, '证据必须是对象');
      }
      const ref = String(item.ref ?? '').trim();
      if (!ref) continue;
      evidence.push({ ref, note: String(item.note ?? '').trim().slice(0, 300) });
    }
  }
  // ★ 等待类阶段必须带"在等什么"的描述和引用（F01）。
  //   不带的话归约器无法登记 pendingWait，之后任何解除事件都对不上。
  const wait = normalizeWait(phase, kind);
  if (!wait.ok) return wait;

  return ok({
    phase: {
      kind,
      claimedDone: strList(phase.claimedDone, 50),
      claimedEvidence: evidence.slice(0, 50),
      unmet: strList(phase.unmet, 50),
      note: String(phase.note ?? '').slice(0, 600),
      // 只有等待类阶段才有；其余为 null
      waitFor: wait.waitFor,
    },
  });
}

/**
 * 等待类阶段必须带 `waitFor`：等的是哪一件事、凭什么引用认它。
 *
 * | phase.kind        | 对应等待种类 | 必填引用字段   |
 * |-------------------|-------------|---------------|
 * | need_approval     | approval    | approvalId    |
 * | need_input        | input       | inputKey      |
 * | waiting_dependency| dependency  | dependencyTaskId |
 *
 * 引用必填：没有引用的等待无法校验"解除的是不是这件事"，
 * 等于任何解除事件都能放行（审查 F01 实测到的旁路）。
 */
const WAIT_PHASE = Object.freeze({
  need_approval: { kind: 'approval', refField: 'approvalId' },
  need_input: { kind: 'input', refField: 'inputKey' },
  waiting_dependency: { kind: 'dependency', refField: 'dependencyTaskId' },
});

export { WAIT_PHASE };

function normalizeWait(phase, kind) {
  const spec = WAIT_PHASE[kind];
  if (!spec) return ok({ waitFor: null });
  const source = phase.waitFor;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return reject(
      REJECT.missingField,
      'attempt.phase.waitFor',
      `「${kind}」阶段必须带 waitFor（等的是哪件事、引用是什么）`,
    );
  }
  // ★ waitFor.kind 必须和 phase.kind 对应。
  //   不对应的话，归约器会按 phase.kind 决定目标状态、再拿 waitFor 去登记，
  //   最后两者说的不是同一件事（F01-8）。
  if (source.kind !== undefined && source.kind !== spec.kind) {
    return reject(
      REJECT.waitMismatch,
      'attempt.phase.waitFor.kind',
      `「${kind}」阶段等的是 ${spec.kind}，waitFor 却写成 ${source.kind}`,
    );
  }
  const ref = String(source.ref ?? source[spec.refField] ?? '').trim();
  if (!isId(ref)) {
    return reject(
      REJECT.missingField,
      `attempt.phase.waitFor.${spec.refField}`,
      `等待引用不合法（${spec.refField} 必填）`,
    );
  }
  return ok({
    waitFor: {
      kind: spec.kind,
      ref,
      // 给人看的说明，可选
      describe: String(source.describe ?? source.note ?? '').slice(0, 300),
    },
  });
}

/**
 * 造一个 AttemptResult（结构校验通过才返回）。
 *
 * @returns {{ok:true, attempt:object}|{ok:false, code:string, field:string, text:string}}
 */
export function createAttemptResult({
  taskRunId,
  revision,
  attemptId,
  botId,
  stop = null,
  usage = null,
  artifacts = [],
  phase = null,
  reason = '',
  at,
} = {}) {
  if (!isId(taskRunId)) return reject(REJECT.badField, 'attempt.taskRunId', 'taskRunId 不合法');
  if (!Number.isInteger(revision) || revision < 1) {
    return reject(REJECT.badField, 'attempt.revision', 'revision 必须是正整数');
  }
  if (!isId(attemptId)) return reject(REJECT.badField, 'attempt.attemptId', 'attemptId 不合法');
  if (!isId(botId)) return reject(REJECT.badField, 'attempt.botId', 'botId 不合法');
  if (!ALL_STOPS.includes(stop)) {
    return reject(REJECT.badField, 'attempt.stop', `未知停止原因：${stop || '(空)'}`);
  }
  if (!isTime(at)) return reject(REJECT.badField, 'attempt.at', 'at 必须是毫秒时间戳');

  const usageOut = normalizeUsage(usage);
  if (!usageOut.ok) return usageOut;
  const phaseOut = normalizePhase(phase);
  if (!phaseOut.ok) return phaseOut;

  const artifactList = [];
  if (!Array.isArray(artifacts)) {
    return reject(REJECT.badField, 'attempt.artifacts', '产物列表必须是数组');
  }
  for (const [index, item] of artifacts.entries()) {
    if (typeof item !== 'string') {
      return reject(REJECT.badField, `attempt.artifacts[${index}]`, '产物引用必须是字符串');
    }
    const clean = item.trim();
    if (clean) artifactList.push(clean);
  }

  return ok({
    attempt: {
      taskRunId,
      revision,
      attemptId,
      botId,
      stop,
      usage: usageOut.usage,
      artifacts: artifactList.slice(0, 200),
      phase: phaseOut.phase,
      reason: String(reason ?? '').slice(0, 600),
      at,
    },
  });
}

/**
 * 校验一个**已有的** AttemptResult（加载/回放/归约入口统一用）。
 * @returns {{ok:true, attempt:object}|{ok:false, ...}}
 */
export function validateAttemptResult(attempt) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    return reject(REJECT.missingField, 'attempt', '没有尝试结果');
  }
  // 复用构造函数：结构规则只有一份，不重复写
  return createAttemptResult({
    taskRunId: attempt.taskRunId,
    revision: attempt.revision,
    attemptId: attempt.attemptId,
    botId: attempt.botId,
    stop: attempt.stop,
    usage: attempt.usage,
    artifacts: attempt.artifacts,
    phase: attempt.phase,
    reason: attempt.reason,
    at: attempt.at,
  });
}

/**
 * 这次尝试是不是**当前任务的活动尝试**。
 *
 * 结构合法远远不够 —— 并发下 A 任务的结果可能落到 B 上。
 * 必须同时核对四件事：
 *   1. taskRunId 是当前任务；
 *   2. revision 是当前目标版本；
 *   3. attemptId 是 dispatch 时登记的那个活动尝试；
 *   4. botId 是那次 dispatch 分配的执行者。
 *
 * @param {object} run
 * @param {object} attempt 已通过结构校验的 AttemptResult
 * @returns {{ok:true}|{ok:false, code:string, field:string, text:string}}
 */
export function matchAttempt(run, attempt) {
  const active = run?.activeAttempt;
  if (!active || !isId(active.attemptId)) {
    return reject(REJECT.noActiveAttempt, 'activeAttempt', '当前没有在途尝试，不能接收尝试结果');
  }
  if (attempt.taskRunId !== run.id) {
    return reject(
      REJECT.attemptMismatch,
      'attempt.taskRunId',
      `这次结果属于任务 ${attempt.taskRunId}，不是当前任务 ${run.id}`,
    );
  }
  if (attempt.revision !== run.revision) {
    return reject(
      REJECT.attemptMismatch,
      'attempt.revision',
      `这次结果是针对第 ${attempt.revision} 版目标，当前是第 ${run.revision} 版`,
    );
  }
  if (attempt.attemptId !== active.attemptId) {
    return reject(
      REJECT.attemptMismatch,
      'attempt.attemptId',
      `活动尝试是 ${active.attemptId}，收到的是 ${attempt.attemptId}（旧尝试或别的尝试）`,
    );
  }
  if (attempt.botId !== active.botId) {
    return reject(
      REJECT.attemptMismatch,
      'attempt.botId',
      `这次尝试分配给了 ${active.botId}，结果是 ${attempt.botId} 报的`,
    );
  }
  return { ok: true };
}

/**
 * 这次尝试**能不能**成为"目标完成的候选"。
 *
 * ★ 与 `task-reduce.js` 里的实际迁移必须用同一规则。
 *   审查 R04 实测到两处各判一套：这里返回 false，归约器却推进了 verifying。
 *   现在两边都引用 `COMPLETION_ELIGIBLE_STOPS`（只有 `returned`）。
 *
 * @returns {{candidate:boolean, why:string}}
 */
export function isCompletionCandidate(attempt, { eligibleStops } = {}) {
  if (!attempt) return { candidate: false, why: '没有尝试结果' };
  if (!ALL_STOPS.includes(attempt.stop)) {
    return { candidate: false, why: `停止原因缺失或未知：${attempt.stop ?? '(空)'}` };
  }
  const allowed = eligibleStops ?? ['returned'];
  if (!allowed.includes(attempt.stop)) {
    const whyText = {
      failed: '执行失败',
      yielded: '达到执行段上限，已让出（不等于完成）',
      skipped: '这一轮没有真正执行',
      waiting: '在等待外部条件',
      cancelled: '已取消',
    };
    return { candidate: false, why: whyText[attempt.stop] ?? `停止原因 ${attempt.stop} 不能算完成` };
  }
  if (attempt.phase?.kind !== 'apply_completion') {
    return { candidate: false, why: '模型没有申请完成' };
  }
  return { candidate: true, why: '模型申请完成，进入验收' };
}