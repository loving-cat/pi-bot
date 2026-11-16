/**
 * "这次动作是凭哪一条授权放行的" —— 一个极小的传递层。
 *
 * ## 为什么需要它
 *
 * 规格 §5.5 要求审计能回答「授权引用」。但判定发生在 `policy-hook`
 * （那里知道 `gate.check()` 返回的 grant），而审计是在下游写的
 * （`desktop-input-session` / `git-ops` 之类）。两边隔着一层工具调用，
 * 没有任何参数能把 grantId 传下去 —— 除非把整个上下文都捅一遍。
 *
 * 所以这里只放一件事：**最近一次由哪条授权放行了哪个动作**。
 *
 * ## 边界（写清楚，免得有人拿它当授权来源）
 *
 *   · 这**不是授权**，只是"刚才那次判定的结果"。它不能拿来放行任何东西。
 *   · 它按 botId 记录、5 分钟过期：过期后读到的就是 null，
 *     不会把一小时前的授权说成"这次的"。
 *   · 只在一个进程内有效（进程重启就没了）—— 和"实例世代"是同一个立场：
 *     审计要能对上具体哪一次执行。
 */

/** 过期时间：判定和用它记账之间不该隔太久。 */
const TTL_MS = 5 * 60_000;

/** botId → { grantId, action, at } */
const last = new Map();

/**
 * 记一笔"刚才这条授权放行了这个动作"。
 *
 * @param {object} p
 * @param {string} p.botId
 * @param {string|null} p.grantId
 * @param {string} p.action 网关动作名（`desktop.input` 等）
 * @param {number} [p.now]
 */
export function noteGrant({ botId, grantId = null, action = '', now = Date.now() } = {}) {
  const id = String(botId ?? '');
  if (!id) return null;
  const row = { grantId: grantId ? String(grantId) : null, action: String(action ?? ''), at: Number(now) || Date.now() };
  last.set(id, row);
  return row;
}

/**
 * 读这个 bot 最近一次放行的授权引用。
 *
 * 过期的、或者动作对不上的都返回 null —— 宁可审计里少一条引用，
 * 也不要把"点屏幕"记成"凭 push 的授权干的"。
 *
 * @param {object} p
 * @param {string} p.botId
 * @param {string} [p.action] 要求动作一致（给了就必须一致）
 * @param {number} [p.now]
 */
export function currentGrantOf({ botId, action = null, now = Date.now() } = {}) {
  const row = last.get(String(botId ?? ''));
  if (!row) return null;
  if (Number(now) - row.at > TTL_MS) {
    last.delete(String(botId));
    return null;
  }
  if (action && row.action !== action) return null;
  return row.grantId ? { ...row } : null;
}

/** 测试用：清空。 */
export function resetGrantContext() {
  last.clear();
}
