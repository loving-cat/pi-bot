/**
 * 调度者决定下一步后结清重试占位，不让已结束的尝试永久显示等待。
 *
 * @param {object} store
 * @param {string} roomId
 * @param {{messageId?: string}} result 那次尝试的结果
 * @param {object} [options]
 * @param {boolean} [options.succeeded] 这次尝试**成功了** —— 标 done，别标 error
 * @param {boolean} [options.willRetry] 还会再试一次
 * @param {boolean} [options.aborted] 用户插话/终止，这条作废
 * @param {string} [options.error]
 */
export function settleRetryMessage(store, roomId, result, {
  succeeded = false,
  willRetry = false,
  aborted = false,
  error = '',
} = {}) {
  if (!result?.messageId) return;
  const message = store.getMessage(roomId, result.messageId);
  if (!message || message.status !== 'retrying') return;
  const placeholder = message.meta?.retryPlaceholder === true;
  // 这次还会再试，且消息里只有一行占位 → 直接删掉，别让聊天记录里堆一串
  if (willRetry && placeholder && !(message.steps?.length)) {
    store.deleteMessage(roomId, message.id);
    return;
  }
  // 成功只更新状态与重试标记，保留已有正文。
  if (succeeded) {
    store.updateMessage(roomId, message.id, {
      status: 'done',
      error: null,
      meta: { ...(message.meta ?? {}), retrying: false, retryPlaceholder: false },
    });
    return;
  }
  store.updateMessage(roomId, message.id, {
    status: aborted ? 'aborted' : (willRetry ? 'done' : 'error'),
    text: placeholder ? (willRetry ? '本次尝试未完成，已开始下一次尝试。' : '') : message.text,
    error: aborted || willRetry ? null : (error || result.error || '本次任务未完成'),
    meta: { ...(message.meta ?? {}), retrying: false, retryPlaceholder: false },
  });
}
