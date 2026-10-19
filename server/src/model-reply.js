/** 模型失败分类、可展示错误与空回复恢复；不输出接口原文或连接凭据。 */
export function modelFailure(error) {
  const raw = typeof error === 'string' ? error : String(error?.message ?? error?.errorMessage ?? '');
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.stopReason === 'aborted'
    || /\baborted\b|\bcancelled\b|\bcanceled\b|已终止|已中止/i.test(raw)) {
    return { status: null, auth: false, aborted: true, error: '已终止' };
  }
  const status = Number(error?.status ?? error?.statusCode) || Number(raw.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/)?.[1]) || null;
  if (status === 401 || /unauthorized|invalid[ _-]?(?:api[ _-]?)?key|authentication[ _-]?(?:failed|error)/i.test(raw)) {
    return { status: 401, auth: true, error: '模型请求认证失败（HTTP 401），请检查模型组凭据与接口认证配置。' };
  }
  if (status === 403 || /forbidden|permission[ _-]denied/i.test(raw)) {
    return { status: 403, auth: true, error: '模型请求被拒绝（HTTP 403），请检查账号及模型访问权限。' };
  }
  if (status === 429) return { status, auth: false, error: '模型请求被限流（HTTP 429），请稍后重试。' };
  if (/context.?length|context.?window|maximum.?context|too many tokens/i.test(raw)) {
    return { status, auth: false, error: '模型接口报告上下文超限，请核实容量配置或压缩会话。' };
  }
  if (/timeout|timed out|超时|超过.*未完成/i.test(raw) || status === 408 || status === 504) {
    return { status, auth: false, error: '模型请求超时，已停止等待，请稍后重试。' };
  }
  return { status, auth: false, error: status
    ? `模型请求失败（HTTP ${status}），请检查接口配置或稍后重试。`
    : '模型请求失败，接口详情已隐藏，请检查服务端或模型接口日志。' };
}

export function assistantFailure(message) {
  if (message?.role !== 'assistant') return null;
  if (message.stopReason === 'aborted') return modelFailure({ name: 'AbortError' });
  if (!message.errorMessage && message.stopReason !== 'error') return null;
  return modelFailure(message.errorMessage || message);
}

export function replyText(message) {
  return (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

/** 只使用本轮选中模型与原默认模型，不扩大到其它已配置线路。 */
export function fallbackModels(selected, defaultModel) {
  const seen = new Set();
  return [selected, defaultModel].filter((model) => {
    if (!model?.provider || !model?.id) return false;
    const key = JSON.stringify([model.provider, model.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 已有明确错误时直接返回；仅对真正空回复执行一次催促和限定模型的文本补答。 */
export async function recoverModelReply({ failure, nudge, readText, readFailure, complete, models,
  signal, isCancelled = () => false }) {
  const cancellation = () => signal?.aborted || isCancelled()
    ? modelFailure({ name: 'AbortError' }) : null;
  const stopped = (failure) => ({ text: '', failure, recovered: false });
  let cancelled = cancellation();
  if (cancelled) return stopped(cancelled);
  if (failure) return { text: '', failure, recovered: false };
  let lastFailure = null;
  try {
    await nudge(signal);
    cancelled = cancellation();
    if (cancelled) return stopped(cancelled);
    lastFailure = readFailure();
    if (lastFailure) return { text: '', failure: lastFailure, recovered: false };
    const text = readText().trim();
    if (text) return { text, failure: null, recovered: true };
  } catch (error) {
    lastFailure = cancellation() ?? modelFailure(error);
    if (lastFailure.auth || lastFailure.aborted || signal?.aborted) return stopped(lastFailure);
  }
  for (const model of models) {
    cancelled = cancellation();
    if (cancelled) return stopped(cancelled);
    try {
      const reply = await complete(model, signal);
      cancelled = cancellation();
      if (cancelled) return stopped(cancelled);
      const error = assistantFailure(reply);
      if (error) {
        lastFailure = error;
        if (error.auth || error.aborted) break;
        continue;
      }
      const text = replyText(reply).trim();
      if (text) return { text, failure: null, recovered: true };
    } catch (error) {
      lastFailure = cancellation() ?? modelFailure(error);
      if (lastFailure.auth || lastFailure.aborted || signal?.aborted) break;
    }
  }
  return { text: '', failure: lastFailure, recovered: false };
}
