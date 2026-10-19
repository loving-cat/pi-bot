/** 私聊异步投递；取用竞争时保留输入并按原模式排队，不重复创建用户消息。 */
export async function deliverDirectInput({ prepare, run, getEntry, queue, accepted, isCancelled }) {
  const checkCancelled = () => {
    if (isCancelled()) throw Object.assign(new Error('已终止'), { name: 'AbortError' });
  };
  checkCancelled();
  const input = await prepare();
  checkCancelled();
  let result = await run(input);
  while (result?.code === 'SESSION_BUSY') {
    checkCancelled();
    const entry = getEntry();
    if (entry?.busy && entry.session) {
      const queued = await queue(entry.session, input);
      checkCancelled();
      accepted(queued);
      return { ok: true, queued: true };
    }
    checkCancelled();
    result = await run(input);
  }
  if (result?.ok === false && !result.messageId) throw new Error(result.error || '消息未能送达');
  return result;
}
