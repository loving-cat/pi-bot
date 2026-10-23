/**
 * 站点登录探测：自动找出「登录路径 + 账号字段 + 口令字段 + token 位置」。
 *
 * 为什么需要探测：这类自研系统的登录接口命名各家不同
 * （`/api/auth/login` / `/api/login` / `/api/user/login`，字段叫 account / email / username…）。
 * 让用户手填这些是把他当程序员用；自动试一遍再让人确认，体验对得多。
 *
 * 探测策略（按代价从低到高）：
 *   1. 先用用户给的账号口令试**常见路径 × 常见字段组合**；
 *   2. 只要有一个组合能拿到 token，就认定成功；
 *   3. 全部失败时，把最后一次的真实错误带回去（而不是笼统的"失败"）——
 *      这样"口令错了"和"字段名不对"用户能分清。
 *
 * 安全约束：
 *   · 探测和登录按 user-config：允许用户填的本机/局域网，仍拦元数据地址；
 *   · 重定向每一跳改按 untrusted，跳到别的内网主机会被拒绝；
 *   · 连续失败就停，不打爆对方接口；
 *   · 口令只在内存里用，不写日志。
 */
import { assertPublicTarget, publicFetch } from './net-guard.js';
import {
  LOGIN_PATH_CANDIDATES,
  ACCOUNT_FIELDS,
  PASSWORD_FIELDS,
  TOKEN_PATHS,
  pickToken,
  hostOf,
} from './sites.js';

/** 单次探测请求的超时（毫秒） */
const TIMEOUT_MS = 10_000;

/**
 * 最多尝试多少次登录。
 *
 * 组合会爆炸（7 路径 × 7 账号字段 × 4 口令字段 = 196），必须收口。
 * 20 次 ≈ 能把「最常见的账号字段 × 全部路径」跑一遍；
 * 更冷门的组合留给"用户手动指定字段名"那条路 ——
 * 与其无声地打对方 200 次接口，不如失败得快一点并告诉用户怎么办。
 */
const MAX_ATTEMPTS = 20;

/**
 * 探测一个站点的登录方式。
 *
 * @param {object} p
 * @param {string} p.baseUrl  站点根地址
 * @param {string} p.account
 * @param {string} p.password
 * @param {Function} [p.fetchImpl]
 * @param {string[]} [p.paths]      只试这些路径（用户手填时用）
 * @param {string} [p.accountField] 只试这个字段名
 * @param {string} [p.passwordField]
 * @returns {Promise<{ok:boolean, auth?:object, token?:string, reason:string,
 *                    tried:number, sample?:object}>}
 */
export async function probeLogin({
  baseUrl,
  account,
  password,
  fetchImpl = null,
  paths = LOGIN_PATH_CANDIDATES,
  accountField = '',
  passwordField = '',
  timeoutMs = TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, reason: '站点地址要以 http:// 或 https:// 开头', tried: 0 };
  }
  if (!String(account ?? '').trim()) {
    return { ok: false, reason: '请填账号', tried: 0 };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: '当前环境不能发网络请求', tried: 0 };
  }

  const accs = accountField ? [accountField] : ACCOUNT_FIELDS;
  const pwds = passwordField ? [passwordField] : PASSWORD_FIELDS;

  let tried = 0;
  let lastReason = '';
  let lastStatus = 0;

  // 按"字段组合"为外层轮转，而不是按路径：
  //   先用最常见的 account+password 把所有路径试一遍，再换 email+password…
  //   否则路径一多，尝试次数在上半截就用完，靠后的路径永远轮不到。
  outer: for (const af of accs) {
    for (const pf of pwds) {
      for (const path of paths) {
        if (tried >= maxAttempts) break outer;
        tried++;
        const result = await tryLogin({
          base,
          path,
          body: { [af]: account, [pf]: password },
          fetchImpl,
          timeoutMs,
        });
        if (result.ok) {
          return {
            ok: true,
            reason: `已连上（登录接口 ${path}，账号字段 ${af}）`,
            tried,
            token: result.token,
            sample: result.sample,
            auth: {
              kind: 'json',
              loginPath: path,
              accountField: af,
              passwordField: pf,
              tokenPath: result.tokenPath,
              header: 'Authorization',
              scheme: 'Bearer',
            },
          };
        }
        lastReason = result.reason;
        lastStatus = result.status;
        // 内网在第一次就会被拒，换字段名没有意义，也不该继续打
        if (/^(拒绝访问|重定向|域名解析失败)/.test(lastReason)) {
          return { ok: false, reason: lastReason, tried };
        }
      }
    }
  }

  // 把最可能的原因说清楚：401/403 通常真是凭证问题，404 是路径不对
  const hint =
    lastStatus === 401 || lastStatus === 403
      ? '账号或口令不对'
      : lastStatus === 404
        ? '没找到登录接口（对方系统可能不是这类接口）'
        : lastStatus === 0
          ? '连不上这个地址'
          : `登录接口返回 ${lastStatus}`;

  return {
    ok: false,
    reason: `${hint}（试了 ${tried} 种组合${lastReason ? `，最后一次：${lastReason}` : ''}）`,
    tried,
  };
}

/**
 * 试一次登录。成功时返回 token 与它所在的位置。
 *
 * @returns {Promise<{ok:boolean, token?:string, tokenPath?:string, sample?:object,
 *                    reason:string, status:number}>}
 */
async function tryLogin({ base, path, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { res } = await publicFetch(
      `${base}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      },
      { fetchImpl: fetchImpl || undefined, scope: 'user-config' }, // 探测/登录/探活：用户填的 baseUrl
    );

    let json = null;
    const text = await res.text().catch(() => '');
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      // 400 常见于"字段名不对"，把服务端的话带回去（有时它会说缺哪个字段）
      const detail =
        json?.error?.issues?.[0]?.path?.[0] ??
        json?.error?.message ??
        json?.error ??
        json?.message ??
        '';
      return {
        ok: false,
        status: res.status,
        reason: detail ? `${res.status} ${String(detail).slice(0, 80)}` : `${res.status}`,
      };
    }

    // 成功：按常见位置找 token
    for (const tp of TOKEN_PATHS) {
      const token = pickToken(json, tp);
      if (token) {
        return {
          ok: true,
          status: res.status,
          token,
          tokenPath: tp,
          // 只留字段名，不留值（避免把用户信息带进日志）
          sample: json && typeof json === 'object' ? { keys: Object.keys(json).slice(0, 10) } : null,
        };
      }
    }
    return { ok: false, status: res.status, reason: '登录成功但响应里没有 token' };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      reason: aborted ? `超时（${timeoutMs / 1000}s）` : String(err?.message ?? err).slice(0, 80),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 登录并拿 token（正常使用时走这里，不是探测）。
 *
 * @param {object} site 已保存的站点配置
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, token?:string, reason:string}>}
 */
export async function loginSite(site, { fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const auth = site?.auth ?? {};
  const result = await tryLogin({
    base: String(site?.baseUrl ?? '').replace(/\/+$/, ''),
    path: auth.loginPath ?? '/api/auth/login',
    body: {
      [auth.accountField ?? 'account']: site?.account ?? '',
      [auth.passwordField ?? 'password']: site?.password ?? '',
    },
    fetchImpl,
    timeoutMs,
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  // 已保存的站点记录了 tokenPath，优先按它取
  const token = pickToken({ ...result }, auth.tokenPath ?? '') || result.token;
  return { ok: true, token, reason: '' };
}

/**
 * query_site 发出去之前的预检。路径是模型给的，按 untrusted：
 * 即使用户把 baseUrl 配在本机或局域网，这里也不放行。
 *
 * @param {string} url
 * @returns {{ok:boolean, reason:string}}
 */
export async function assertSafeUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false, reason: '不是合法地址' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: '只支持 http/https' };
  }
  try {
    await assertPublicTarget(u, { scope: 'untrusted' });
    return { ok: true, reason: '', host: hostOf(url) };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}
