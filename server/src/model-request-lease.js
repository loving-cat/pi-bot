/** 模型请求超时后通知调用方并中止网络；真实请求结束前保留配置租约。 */
export async function requestWithProviderLease(runner, request, timeoutMs) {
  runner.flushProviderUpdates?.();
  const release = runner.providerUpdates?.acquire() ?? (() => {});
  const controller = new AbortController();
  let timer;
  const pending = Promise.resolve().then(() => request(controller.signal, release)).finally(release);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`超时 ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
