/**
 * 请求闸门：首次接单的预约、并发抑制与收尾。
 *
 * WS 与 HTTP 发送入口共用这一份判定，避免两处各写一套幂等规则。
 *
 * ## 顺序
 *
 *   忙判断（不预约，返回 queued，客户端用同一 requestId 重试）
 *     → reserve（running；inflight/done/conflict/corrupt 如实返回）
 *     → 理解轮（宿主建立请求作用域）
 *     → finish（accepted 由接单工具写；本轮没接单则 answered；异常 failed 可重试）
 */
import { createRequestScope, resumeAdmission, findAdmittedTask } from './task-admission.js';

/**
 * @returns {{status:'new',scope:object}
 *   |{status:'inflight'|'done'|'conflict'|'corrupt', code?:string, text?:string, receipt?:object}}
 */
export function openRequest({
  receipts, taskRuns = null, requesterId, requestId, roomId, text, attachments = [], mode = 'auto', clock = () => Date.now(),
}) {
  if (!requesterId || !requestId) {
    return { status: 'corrupt', code: 'bad_request_identity', text: '请求缺少认证身份或 requestId' };
  }
  const base = createRequestScope({
    requesterId, requestId, roomId, text, attachments, mode, at: clock(),
  });
  if (!base) return { status: 'corrupt', code: 'bad_request_scope', text: '请求作用域不合法' };
  // 允许理解/预约之前先查接受事实：任务已存在就恢复，不再重跑理解
  const found = taskRuns ? findAdmittedTask({ taskRuns, requesterId, requestId }) : { status: 'absent' };
  if (found.status === 'indeterminate') {
    return { status: 'corrupt', code: 'lookup_indeterminate', text: '无法确认请求是否已受理' };
  }
  if (found.status === 'found') {
    if (found.taskRun.request?.fingerprint !== base.fingerprint) {
      return { status: 'conflict', code: 'request_conflict', text: '同一请求 ID 的内容与任务记录不一致' };
    }
    return {
      status: 'done',
      scope: Object.freeze({ ...base, leaseId: null }),
      receipt: { requesterId, requestId, fingerprint: base.fingerprint, stage: 'accepted', taskRunId: found.taskRun.id },
      taskRunId: found.taskRun.id,
      recovered: true,
    };
  }

  const reserved = receipts.reserve({
    requesterId, requestId, fingerprint: base.fingerprint,
  });
  if (reserved.status === 'reserved') {
    const scope = Object.freeze({ ...base, leaseId: reserved.leaseId });
    return { status: 'new', scope, leaseId: reserved.leaseId };
  }
  const scoped = Object.freeze({ ...base, leaseId: reserved.leaseId ?? null });
  if (reserved.status === 'done') return { status: 'done', receipt: reserved.receipt, scope: scoped };
  if (reserved.status === 'inflight') return { status: 'inflight', receipt: reserved.receipt, scope: scoped };
  if (reserved.status === 'conflict') return reserved;
  return { ...reserved, status: 'corrupt' };
}

/** 理解轮结束：没接单的请求记为 answered；异常记为 failed（允许同 ID 重试）。 */
export function closeRequest({ receipts, taskRuns = null, scope, error = null, verdict = null }) {
  // 权威事实优先：已持久接管的 TaskRun 不因回执缺失/滞后被降级
  let found = null;
  try {
    found = taskRuns?.findByRequest?.(scope.requesterId, scope.requestId) ?? null;
  } catch {
    return { ok: false, code: 'lookup_indeterminate', text: '无法确认请求的持久任务' };
  }
  if (found?.status === 'indeterminate') {
    return { ok: false, code: 'lookup_indeterminate', text: '无法确认请求的持久任务' };
  }
  if (found?.status === 'found') {
    const current = receipts.read(scope.requesterId, scope.requestId);
    if (current.status === 'ok' && current.receipt.stage === 'accepted') {
      return { ok: true, receipt: current.receipt, taskRun: found.taskRun, authoritative: true };
    }
    // 回执修复是独立事实：写失败不让已接管的任务变成失败
    try {
      receipts.finish({
        requesterId: scope.requesterId, requestId: scope.requestId, fingerprint: scope.fingerprint,
        stage: 'accepted', kind: found.taskRun?.admission?.outcome === 'direct' ? 'accept_task' : (current.status === 'ok' ? current.receipt.kind : 'accept_task'),
        taskRunId: found.taskRun.id,
      });
    } catch {}
    return { ok: true, receipt: current.status === 'ok' ? current.receipt : null, taskRun: found.taskRun, authoritative: true };
  }
  const current = receipts.read(scope.requesterId, scope.requestId);
  if (current.status === 'corrupt') return current;
  if (current.status === 'ok' && current.receipt.stage !== 'running' && current.receipt.stage !== 'received') {
    return { ok: true, receipt: current.receipt };
  }
  if (error) {
    return receipts.finish({
      requesterId: scope.requesterId, requestId: scope.requestId, fingerprint: scope.fingerprint,
      stage: 'failed', error,
    });
  }
  // 只有明确 answer/clarification 才算 answered；只给计划/无结构 → 明确失败，不默认当接单完成
  if (verdict !== 'answer' && verdict !== 'clarification') {
    return receipts.finish({
      requesterId: scope.requesterId, requestId: scope.requestId, fingerprint: scope.fingerprint,
      stage: 'failed', error: 'NO_INTAKE_VERDICT', kind: 'no_verdict',
    });
  }
  return receipts.finish({
    requesterId: scope.requesterId, requestId: scope.requestId, fingerprint: scope.fingerprint,
    stage: 'answered', kind: verdict,
  });
}

/** 已受理结果：不重复起理解轮，直接返回原任务。 */
export function acceptedSummary(receipt) {
  return {
    accepted: receipt?.stage === 'accepted' || receipt?.accepted === true,
    taskRunId: receipt?.taskRunId ?? null,
    kind: receipt?.kind ?? null,
    stage: receipt?.stage ?? null,
  };
}


/**
 * 请求生命周期：理解轮真正取得执行权时激活，该轮真正结束时收尾。
 *
 * WS 与 HTTP 只把不可变信封交给 runner；begin/close 只在这一处实现，
 * 外层入口不得自己 begin/finally（send 返回只是受理/入队，不是理解轮结束）。
 */
export function createRequestLifecycle({ receipts, taskRuns = null, onTerminal = null }) {
  return {
    close(scope, error = null, verdict = null) {
      if (!scope) return;
      const out = closeRequest({ receipts, taskRuns, scope, error: error ? String(error?.message || error) : null, verdict });
      if (typeof onTerminal === 'function') {
        try { onTerminal(scope, out); } catch {}
      }
      return out;
    },
  };
}

/** 回执显示已受理但交接未完成：按持久事实继续交接（无模型）。 */
export async function resumeAdmitted({ store, taskRuns, scope }) {
  const found = findAdmittedTask({ taskRuns, requesterId: scope.requesterId, requestId: scope.requestId });
  if (found.status === 'absent') return { ok: true, resumed: false, accepted: false };
  if (found.status === 'indeterminate') return { ok: false, resumed: false, code: 'lookup_indeterminate' };
  if (found.taskRun.request?.fingerprint !== scope.fingerprint) return { ok: false, resumed: false, code: 'request_conflict' };
  return resumeAdmission({ store, taskRuns, taskRun: found.taskRun, prepareSpec: () => ({ ok: true }) });
}
