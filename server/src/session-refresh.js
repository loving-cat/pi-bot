/** 按配置变化标记会话；下次取用前重载，历史文件与已经发出的轮次保持原样。 */
import { releaseEntry } from './session-pool.js';

/** 同步预留已取用条目，防止 await 返回前被下一轮释放或重复取用。 */
export function reserveSession(entry) {
  if (entry.busy) {
    const error = new Error('会话正在忙');
    error.code = 'SESSION_BUSY';
    throw error;
  }
  entry.busy = true;
  return entry;
}

export function invalidateSessions(sessions, predicate) {
  let count = 0;
  for (const [key, entry] of sessions) {
    if (!predicate(key, entry)) continue;
    count++;
    entry.reloadPending = true;
  }
  return count;
}

export function retireStaleSession(sessions, key) {
  const entry = sessions.get(key);
  if (!entry?.reloadPending || entry.busy || entry.pending) return false;
  releaseEntry(entry);
  sessions.delete(key);
  return true;
}
