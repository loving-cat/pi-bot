/**
 * 站点运行时：管理登录态、把 bot 的查询转发到外部系统。
 *
 * 职责边界：
 *   · 只认「JSON API 型 SPA」（见 sites.js 开头说明）；
 *   · token 存在内存里（不落盘）—— 口令才是长期凭证，token 丢了重登即可；
 *   · 401 时自动重登一次再重试，让用户感觉不到过期；
 *   · 所有失败都返回 `{ok:false, reason}`，绝不抛到上层把 bot 那一轮搞挂。
 *
 * 不在这里做的：解析对方业务字段。这里是通用传输层，
 * "这个字段叫什么、怎么组合成回答"由 bot 自己看返回的 JSON 决定。
 */
import { loginSite, assertSafeUrl } from './site-probe.js';
import { publicFetch } from './net-guard.js';
import { isTokenExpired } from './sites.js';

/** token 缓存多久（毫秒）。JWT 自带 exp 时以 exp 为准 */
const TOKEN_TTL_MS = 30 * 60 * 1000;

/** 单次查询超时 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 单次响应最大字节数：对方返回一整张表时会很大，别把内存吃满 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * 站点运行时。
 *
 * @param {object} deps
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.log]
 */
export function createSiteRuntime({ fetchImpl = null, log = () => {} } = {}) {
  /** siteId -> { token, at, error } */
  const sessions = new Map();

  /**
   * 拿一个可用 token（必要时登录）。
   * @param {object} site
   * @param {boolean} [force]
   * @returns {Promise<{ok:boolean, token?:string, reason:string}>}
   */
  async function tokenFor(site, force = false) {
    const cached = sessions.get(site.id);
    if (!force && cached?.token && !cached.expired) {
      if (!isTokenExpired(cached.token)) return { ok: true, token: cached.token, reason: '' };
      cached.expired = true;
    }

    const res = await loginSite(site, { fetchImpl });
    if (!res.ok) {
      sessions.set(site.id, { token: '', at: Date.now(), expired: true, error: res.reason });
      return { ok: false, reason: res.reason };
    }
    sessions.set(site.id, { token: res.token, at: Date.now(), expired: false, error: '' });
    log(`[站点 ${site.name}] 登录成功`);
    return { ok: true, token: res.token, reason: '' };
  }

  /**
   * 查询站点的一个接口。
   *
   * @param {object} p
   * @param {object} p.site      站点配置
   * @param {string} p.path      以 / 开头的接口路径
   * @param {object} [p.query]   查询参数（值会转成字符串，数组用逗号连接）
   * @param {string} [p.method]  默认 GET
   * @param {object} [p.body]    POST/PATCH 时的 JSON body
   * @param {number} [p.timeoutMs]
   * @returns {Promise<{ok:boolean, status?:number, data?:any, reason:string, bytes?:number}>}
   */
  async function request({ site, path, query = null, method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!site) return { ok: false, reason: '站点不存在' };
    if (!String(path ?? '').startsWith('/')) {
      return { ok: false, reason: '接口路径要以 / 开头' };
    }
    // 用户填的地址可能被改成内网；登录和查询都还要再校验（含重定向）
    const safe = await assertSafeUrl(site.baseUrl);
    if (!safe.ok) return { ok: false, reason: safe.reason };

    const url = new URL(site.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }

    // 第一次 + 401 后重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await tokenFor(site, attempt > 0);
      if (!tok.ok) {
        return { ok: false, reason: `登录失败：${tok.reason}` };
      }
      const result = await fetchOnce({
        url,
        method,
        body,
        token: tok.token,
        site,
        fetchImpl,
        timeoutMs,
      });
      if (result.ok) return result;
      // 只有明确 401 才重登重试；其他错误（404/500）重登也没用
      if (result.status !== 401) return result;
      log(`[站点 ${site.name}] token 失效，重新登录后重试`);
    }
    return { ok: false, reason: '登录态反复失效（对方可能限制了并发或改了鉴权）' };
  }

  /** 清掉某个站点的登录态（改口令后调） */
  function forget(siteId) {
    sessions.delete(siteId);
  }

  /** 某站点当前是否"已连接"（有可用 token） */
  function statusOf(siteId) {
    const s = sessions.get(siteId);
    if (!s?.token || s.expired) return { connected: false, lastError: s?.error ?? '' };
    if (isTokenExpired(s.token)) return { connected: false, lastError: 'token 已过期' };
    return { connected: true, lastError: '' };
  }

  /** 主动探活：拿一次 token 看看通不通 */
  async function ping(site) {
    const tok = await tokenFor(site, true);
    return tok.ok ? { ok: true, reason: '连接正常' } : { ok: false, reason: tok.reason };
  }

  return { request, ping, forget, statusOf, tokenFor };
}

/**
 * 发一次请求（含大小与超时保护）。
 * @returns {Promise<{ok:boolean, status?:number, data?:any, reason:string, bytes?:number}>}
 */
async function fetchOnce({ url, method, body, token, site, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: 'application/json' };
    const scheme = site?.auth?.scheme ?? 'Bearer';
    const header = site?.auth?.header ?? 'Authorization';
    if (token) headers[header] = scheme ? `${scheme} ${token}` : token;
    if (body) headers['content-type'] = 'application/json';

    const { res } = await publicFetch(
      url.toString(),
      {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      },
      { fetchImpl: fetchImpl || undefined },
    );

    const text = await readLimited(res, MAX_RESPONSE_BYTES);
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 不是 JSON：可能是登录页 HTML（说明鉴权被重定向了）
      const isHtml = /^\s*<!doctype|^\s*<html/i.test(text);
      return {
        ok: false,
        status: res.status,
        reason: isHtml ? '返回的是网页而不是数据（可能需要重新登录或接口变了）' : '返回内容不是 JSON',
        bytes: text.length,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: `接口返回 ${res.status}${data?.error ? `：${String(data.error).slice(0, 120)}` : ''}`,
        data,
      };
    }
    return { ok: true, status: res.status, data, reason: '', bytes: text.length };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : String(err?.message ?? err).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读响应正文，超限就截断（避免对方返回巨大表格时把内存吃满）。
 * @param {Response} res
 * @param {number} max
 * @returns {Promise<string>}
 */
async function readLimited(res, max) {
  if (!res.body?.getReader) {
    const t = await res.text();
    return t.length > max ? t.slice(0, max) : t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= max) {
      try {
        await reader.cancel();
      } catch {
        // 取消失败不影响已读到的内容
      }
      break;
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.subarray(0, max).toString('utf8');
}
