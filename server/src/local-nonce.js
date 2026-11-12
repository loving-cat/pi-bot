/**
 * 一次性 nonce：改安全配置的接口除了 token 还要带它。
 *
 * ## 防的是什么
 *
 * 本地 token 解决了"别的进程能不能连上服务端"，但没解决"它能不能冒充界面"：
 * 同用户进程完全可以在自己家里读 local-token 文件，然后直接调
 *   PATCH /api/policy  { dangerous: 'allow' }
 *   POST  /api/mcp     { command: '...' }
 * 改掉策略或者挂一个 MCP。
 *
 * 把 token 换成钥匙串存不是修复：同用户进程能**静默**读钥匙串。
 *
 * ## nonce 改变了什么
 *
 * 服务端只在你**通过界面点击**、并且这次点击被界面转成一次请求时，
 * 才签发一个 nonce。它：
 *   · 单次有效（用掉即作废）
 *   · 60 秒过期
 *   · 绑定在签发它的那次会话上（一个 nonce 不能挪给别的用途）
 *
 * 于是"偷偷读 token → 直接调接口"这条路就断了：它拿得到 token，
 * 但拿不到一个**正在被界面使用**的 nonce。
 *
 * ## 局限（必须写清楚）
 *
 * 这挡的是"在磁盘上捡到 token 的静态攻击"，**挡不住**在同一台机器上
 * 实时注入桌面端进程、或直接驱动 UI 的攻击者 —— 那种攻击者能拿到
 * 界面本该发出的那次请求本身。要挡那一层需要独立的安全边界
 * （不同 uid、或者用户在场确认），不是这里能解决的。
 */

import crypto from 'node:crypto';

/** nonce 有效期。 */
export const NONCE_TTL_MS = 60_000;

/** 每个 nonce 的用途。不同用途的 nonce 不能互换。 */
export const NONCE_PURPOSE = {
  /** 改策略（PATCH /api/policy） */
  POLICY: 'policy',
  /** 改 MCP 库（POST /api/mcp，含增删改） */
  MCP: 'mcp',
};

/** 上限：防止有人刷爆内存。 */
const MAX_NONCES = 200;

/** nonce → { purpose, expiresAt, used } */
const issued = new Map();

/** 清掉过期的（每次签发/校验时顺手做）。 */
function sweep(nowMs) {
  for (const [nonce, entry] of issued) {
    if (entry.used || entry.expiresAt <= nowMs) issued.delete(nonce);
  }
}

/**
 * 签发一个 nonce。
 *
 * ★ 只该由"用户点了某个按钮"这条路径调用。服务端没有办法验证
 *   "这个请求背后真的有个人点了按钮"，那是界面的责任 —— 界面必须
 *   在 onClick 里申请，不能在定时任务或启动流程里预先申请。
 *
 * @param {string} purpose NONCE_PURPOSE 之一
 * @param {number} [nowMs]
 * @returns {{nonce: string, expiresAt: number}}
 */
export function issueNonce(purpose, nowMs = Date.now()) {
  sweep(nowMs);
  if (issued.size >= MAX_NONCES) {
    // 满了就清最旧的（Map 保持插入顺序）
    const oldest = issued.keys().next().value;
    if (oldest !== undefined) issued.delete(oldest);
  }
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = nowMs + NONCE_TTL_MS;
  issued.set(nonce, { purpose: String(purpose), expiresAt, used: false });
  return { nonce, expiresAt };
}

/**
 * 校验并**消费**一个 nonce。
 *
 * @param {string} nonce
 * @param {string} purpose
 * @param {number} [nowMs]
 * @returns {{ok: true} | {ok: false, reason: 'missing'|'unknown'|'expired'|'used'|'purpose'}}
 */
export function consumeNonce(nonce, purpose, nowMs = Date.now()) {
  const value = String(nonce ?? '').trim();
  if (!value) return { ok: false, reason: 'missing' };
  const entry = issued.get(value);
  if (!entry) return { ok: false, reason: 'unknown' };
  if (entry.used) return { ok: false, reason: 'used' };
  if (entry.expiresAt <= nowMs) {
    issued.delete(value);
    return { ok: false, reason: 'expired' };
  }
  if (entry.purpose !== String(purpose)) return { ok: false, reason: 'purpose' };
  // 单次有效：标记用掉并立即删
  entry.used = true;
  issued.delete(value);
  return { ok: true };
}

/** 清空（测试用）。 */
export function clearNonces() {
  issued.clear();
}

/** 当前存活数量（诊断用）。 */
export function nonceCount(nowMs = Date.now()) {
  sweep(nowMs);
  return issued.size;
}
