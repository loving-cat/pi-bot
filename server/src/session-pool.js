/**
 * 会话池的**收尾动作**：释放一个会话条目、按条件作废、LRU 驱逐、全部释放。
 *
 * "怎么释放一个会话"只在这里定义一次（遍历 → unsubscribe → dispose → delete），
 * 调用方只说"哪些该释放"。这种释放散在各处时（改预算、改名、改规矩、重开记忆…），
 * 稍有差别（有的清会话文件、有的跳过忙的）就容易漏。
 *
 * 这一层只认一个 Map（key -> entry），不认识 pi、不认识房间 ——
 * 所以能拿假的 Map 直接测。
 */

/**
 * 释放一个条目：注销订阅 + 关掉 pi 会话。
 *
 * 两步都各自 try：收尾阶段不该因为一个 dispose 抛错，
 * 就让后面的会话全都漏在那儿关不掉。
 */
export function releaseEntry(entry) {
  try {
    entry?.unsubscribe?.();
  } catch {
    /* ignore */
  }
  try {
    entry?.session?.dispose();
  } catch {
    /* ignore */
  }
}

/**
 * 按条件作废：命中的释放并从表里删掉。
 *
 * @param {Map<string, any>} sessions
 * @param {(key: string, entry: any) => boolean} predicate
 * @returns {string[]} 被作废的 key（调用方可能要拿它清会话文件）
 */
export function disposeMatching(sessions, predicate) {
  const removed = [];
  for (const [key, entry] of [...sessions]) {
    if (!predicate(key, entry)) continue;
    releaseEntry(entry);
    sessions.delete(key);
    removed.push(key);
  }
  return removed;
}

/**
 * 超过上限时，释放**最久没用且不忙**的那些。
 *
 * 忙的绝不释放：那一轮还在跑，把它关掉等于把用户的活儿掐了。
 */
export function evictIdle(sessions, cap) {
  if (sessions.size <= cap) return 0;
  const idle = [...sessions.entries()]
    .filter(([, e]) => e.session && !e.busy)
    .sort((a, b) => (a[1].lastUsed ?? 0) - (b[1].lastUsed ?? 0));
  let released = 0;
  while (sessions.size > cap && idle.length) {
    const [key, entry] = idle.shift();
    releaseEntry(entry);
    sessions.delete(key);
    released++;
  }
  return released;
}

/** 全部释放（进程退出前用） */
export function disposeAll(sessions) {
  for (const entry of sessions.values()) releaseEntry(entry);
  sessions.clear();
}
