/**
 * 请求终态权威读取与发布：query、lifecycle close、publisher 共用。
 *
 * 业务不变量：认证 requesterId + requestId 对应的 TaskRun 已持久存在，
 * 即宿主已接管该请求；回执缺失/滞后/写失败不能把它降级为 pending/failed。
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

export function validRequestId(id) {
  return typeof id === 'string' && REQUEST_ID_PATTERN.test(id);
}

export function requestIdentityKey(requesterId, requestId) {
  return String(requesterId ?? '') + '\u0000' + String(requestId ?? '');
}

export function projectRequestResult({ requesterId, requestId, receipt = null, taskRun = null }) {
  if (taskRun) {
    return {
      requesterId, requestId, status: 'accepted', accepted: true,
      kind: receipt?.kind ?? taskRun.request?.mode ?? 'accept_task',
      taskRunId: taskRun.id, retryable: false, source: 'taskrun',
    };
  }
  if (!receipt) {
    return { requesterId, requestId, status: 'pending', accepted: false, retryable: false, taskRunId: null, source: 'none' };
  }
  const stage = receipt.stage;
  if (stage === 'accepted') {
    return {
      requesterId, requestId, status: 'accepted', accepted: true,
      kind: receipt.kind ?? 'accept_task', taskRunId: receipt.taskRunId ?? null,
      retryable: false, source: 'receipt',
    };
  }
  if (stage === 'answered') {
    return {
      requesterId, requestId,
      status: receipt.kind === 'clarification' ? 'clarification' : (receipt.kind === 'discussion' ? 'discussion' : 'answer'),
      accepted: false, kind: receipt.kind ?? 'answer', taskRunId: null,
      retryable: false, source: 'receipt',
    };
  }
  if (stage === 'failed') {
    return {
      requesterId, requestId, status: 'failed', accepted: false,
      kind: receipt.kind ?? null, error: receipt.error ?? null,
      taskRunId: null, retryable: true, source: 'receipt',
    };
  }
  return { requesterId, requestId, status: 'pending', accepted: false, retryable: false, taskRunId: null, source: 'receipt' };
}

/** 一份权威结果读取服务：TaskRun 事实优先，其次校验后的回执，最后 pending。 */
export function createRequestResultService({ receipts, taskRuns }) {
  return {
    read({ requesterId, requestId }) {
      let found = null;
      try {
        found = taskRuns?.findByRequest?.(requesterId, requestId) ?? null;
      } catch {
        return { ok: false, code: 'lookup_indeterminate', text: '无法确认请求的持久任务' };
      }
      if (found?.status === 'indeterminate') {
        return { ok: false, code: 'lookup_indeterminate', text: '无法确认请求的持久任务' };
      }
      if (found?.status === 'found') {
        const read = receipts?.read?.(requesterId, requestId) ?? { status: 'absent' };
        if (read.status === 'corrupt') {
          return { ok: false, code: read.code ?? 'receipt_corrupt', text: read.text ?? '请求回执损坏' };
        }
        return { ok: true, projection: projectRequestResult({ requesterId, requestId, receipt: read.status === 'ok' ? read.receipt : null, taskRun: found.taskRun }) };
      }
      const read = receipts?.read?.(requesterId, requestId) ?? { status: 'absent' };
      if (read.status === 'corrupt') {
        return { ok: false, code: read.code ?? 'receipt_corrupt', text: read.text ?? '请求回执损坏' };
      }
      return { ok: true, projection: projectRequestResult({ requesterId, requestId, receipt: read.status === 'ok' ? read.receipt : null }) };
    },
  };
}

/** 终态事件（携带原 requestId；不含模型文本）。 */
export function terminalEventOf(scope, projection) {
  return {
    t: 'request.result',
    requestId: scope.requestId,
    requesterId: scope.requesterId,
    status: projection.status,
    accepted: projection.accepted === true,
    kind: projection.kind ?? null,
    taskRunId: projection.taskRunId ?? null,
    retryable: projection.retryable === true,
    error: projection.error ?? null,
    source: projection.source ?? null,
  };
}

/** WS/HTTP 共用发布装配：只发权威结果，不各自复制投影。 */
export function createTerminalPublisher({ service, emit }) {
  return (scope) => {
    if (!scope) return;
    const read = service.read({ requesterId: scope.requesterId, requestId: scope.requestId });
    if (!read.ok) {
      // 读取不确定不是可靠拒绝：发非终态 unknown，客户端必须保留原信封
      emit({ t: 'request.result', requestId: scope.requestId, requesterId: scope.requesterId, status: 'unknown', accepted: false, kind: null, taskRunId: null, retryable: true, error: read.text ?? null, source: 'uncertain' });
      return;
    }
    emit(terminalEventOf(scope, read.projection));
  };
}
