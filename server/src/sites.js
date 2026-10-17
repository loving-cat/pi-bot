/**
 * 外部 Web 系统的接入配置（纯逻辑：规范化、登录请求构造、token 提取）。
 *
 * 目标形态只有一类：**带 JSON API 的 SPA**（例如自研投研系统）。
 * 这类系统的共同点：
 *   · 前端是 React/Vue SPA，数据全走 `/api/...`；
 *   · 登录是一个 POST 接口，交出「账号 + 口令」，拿回一个 token；
 *   · 之后每个请求带 `Authorization: Bearer <token>`。
 *
 * 不在这里处理的：验证码、扫码、OAuth、只能浏览器登录的系统 ——
 * 那些需要真人参与，硬接只会做出一个"看起来能用、实际天天挂"的功能。
 */

/** 站点配置里各字段的长度上限（它们会进提示词与界面） */
export const SITE_LIMITS = {
  name: 40,
  baseUrl: 200,
  account: 200,
  password: 200,
  path: 120,
  field: 40,
  tokenPath: 60,
};

/** 常见登录路径（按命中概率排序，探测时依次尝试） */
export const LOGIN_PATH_CANDIDATES = [
  '/api/auth/login',
  '/api/login',
  '/api/user/login',
  '/api/v1/auth/login',
  '/api/v1/login',
  '/auth/login',
  '/login',
];

/** 账号字段的常见命名 */
export const ACCOUNT_FIELDS = ['account', 'email', 'username', 'user', 'login', 'mobile', 'phone'];

/** 口令字段的常见命名 */
export const PASSWORD_FIELDS = ['password', 'passwd', 'pwd', 'secret'];

/** token 在响应里可能的位置（点号路径） */
export const TOKEN_PATHS = ['accessToken', 'token', 'access_token', 'data.token', 'data.accessToken', 'result.token'];

/**
 * 规范化一个站点配置。
 *
 * @param {object} raw
 * @param {number} [now]
 * @returns {object|null} 缺少关键字段（baseUrl / account）时返回 null
 */
export function normalizeSite(raw = {}, now = Date.now()) {
  const baseUrl = String(raw?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) return null;
  // 只接受 http(s)：防止 file:// 之类被当成"站点"
  if (!/^https?:\/\//i.test(baseUrl)) return null;

  const account = String(raw?.account ?? '').trim();
  if (!account) return null;

  const auth = raw?.auth ?? {};
  const loginPath = String(auth.loginPath ?? '/api/auth/login').trim() || '/api/auth/login';

  return {
    id: String(raw?.id ?? '').trim() || `site_${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: String(raw?.name ?? '').trim().slice(0, SITE_LIMITS.name) || hostOf(baseUrl),
    baseUrl: baseUrl.slice(0, SITE_LIMITS.baseUrl),
    auth: {
      // 目前只支持 JSON 登录；字段名可由探测结果或用户手填决定
      kind: 'json',
      loginPath: loginPath.slice(0, SITE_LIMITS.path),
      accountField: String(auth.accountField ?? 'account').slice(0, SITE_LIMITS.field),
      passwordField: String(auth.passwordField ?? 'password').slice(0, SITE_LIMITS.field),
      tokenPath: String(auth.tokenPath ?? 'accessToken').slice(0, SITE_LIMITS.tokenPath),
      header: String(auth.header ?? 'Authorization').slice(0, SITE_LIMITS.field),
      scheme: String(auth.scheme ?? 'Bearer').slice(0, 20),
    },
    account: account.slice(0, SITE_LIMITS.account),
    password: String(raw?.password ?? '').slice(0, SITE_LIMITS.password),
    // 一个站点对应一个部门（"把一个系统简化为一个团队"）
    teamRoomId: raw?.teamRoomId ? String(raw.teamRoomId) : '',
    createdAt: Number(raw?.createdAt) || now,
    updatedAt: Number(raw?.updatedAt) || now,
  };
}

/**
 * 从 URL 取主机名，用作站点默认显示名。
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url ?? '').slice(0, 40);
  }
}

/**
 * 构造登录请求体。
 * @param {object} site
 * @returns {Record<string, string>}
 */
export function loginBody(site) {
  const auth = site?.auth ?? {};
  return {
    [auth.accountField ?? 'account']: String(site?.account ?? ''),
    [auth.passwordField ?? 'password']: String(site?.password ?? ''),
  };
}

/**
 * 从登录响应里按点号路径取 token。
 * @param {any} json
 * @param {string} path 如 `accessToken` / `data.token`
 * @returns {string}
 */
export function pickToken(json, path = 'accessToken') {
  let cur = json;
  for (const key of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = cur[key];
  }
  return typeof cur === 'string' ? cur : '';
}

/**
 * token 是否已经过期（按 JWT 的 exp 判断；不是 JWT 就认为没过期）。
 *
 * @param {string} token
 * @param {number} [now] 毫秒
 * @param {number} [skewMs] 提前多久算过期（避免"刚好卡在边界"）
 * @returns {boolean}
 */
export function isTokenExpired(token, now = Date.now(), skewMs = 60_000) {
  const payload = decodeJwtPayload(token);
  if (!payload || !Number.isFinite(payload.exp)) return false;
  return payload.exp * 1000 <= now + skewMs;
}

/**
 * 解出 JWT 的 payload（解不出来返回 null，不抛错）。
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 把站点配置变成"给用户/bot 看的摘要"，隐去口令。
 *
 * @param {object} site
 * @param {object} [status] 运行时状态（token 是否有效等），由调用方传入
 * @returns {object|null}
 */
export function publicSite(site, status = {}) {
  if (!site) return null;
  return {
    id: site.id,
    name: site.name,
    baseUrl: site.baseUrl,
    account: site.account,
    // 口令只回一个"有没有设"，绝不回明文
    hasPassword: Boolean(site.password),
    loginPath: site.auth?.loginPath ?? '',
    teamRoomId: site.teamRoomId ?? '',
    // 运行时状态：是否已拿到可用 token
    connected: status.connected === true,
    lastCheckedAt: status.lastCheckedAt ?? 0,
    lastError: status.lastError ?? '',
  };
}
