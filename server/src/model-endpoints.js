/** 模型端点的规范化、目标匹配与局部编辑合并；不读取文件或发起请求。 */
export const MAX_ENDPOINTS = 5;

const URL_MAX = 400;
const KEY_MAX = 400;
const LABEL_MAX = 40;
const text = (value, max) => String(value ?? '').trim().slice(0, max);
const address = (value) => {
  const raw = text(value, URL_MAX);
  const suffix = raw.search(/[?#]/);
  if (suffix === -1) return raw.replace(/\/+$/, '');
  return raw.slice(0, suffix).replace(/\/+$/, '') + raw.slice(suffix);
};

/** 非空端点最多保留五项；无有效列表时可由单地址字段建立首项。 */
export function normalizeEndpoints(raw, { fallbackBaseUrl = '', fallbackApiKey = '' } = {}) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const baseUrl = address(item.baseUrl);
    if (!baseUrl) continue;
    out.push({
      baseUrl,
      apiKey: text(item.apiKey, KEY_MAX),
      label: text(item.label, LABEL_MAX),
    });
    if (out.length >= MAX_ENDPOINTS) break;
  }
  if (!out.length && address(fallbackBaseUrl)) {
    out.push({ baseUrl: address(fallbackBaseUrl), apiKey: text(fallbackApiKey, KEY_MAX), label: '' });
  }
  return out;
}

/** 完整请求目标作为凭据身份；片段不发送，路径和查询参数参与匹配。 */
export function endpointTarget(baseUrl) {
  try {
    const url = new URL(String(baseUrl ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return null;
  }
}

/** 省略列表保留所有端点；空白密钥只在目标唯一且不变时继承。 */
export function mergeModelEndpoints(input = {}, existing = null) {
  const previous = normalizeEndpoints(existing?.endpoints, {
    fallbackBaseUrl: existing?.baseUrl,
    fallbackApiKey: existing?.apiKey,
  });
  const specified = input.endpoints !== undefined && input.endpoints !== null;
  if (specified && !Array.isArray(input.endpoints)) {
    return { error: 'endpoints 须为端点列表' };
  }
  const rawUrls = specified ? input.endpoints.map((item) => item?.baseUrl) : [input.baseUrl];
  if (rawUrls.some((url) => String(url ?? '').trim().length > URL_MAX)) {
    return { error: `端点地址不能超过 ${URL_MAX} 个字符` };
  }

  if (!specified) {
    const oldFirst = previous[0];
    const baseUrl = address(input.baseUrl ?? oldFirst?.baseUrl);
    if (!baseUrl) return { error: 'baseUrl 不能为空' };
    const target = endpointTarget(baseUrl);
    const sameTarget = target !== null && target === endpointTarget(oldFirst?.baseUrl);
    const first = {
      baseUrl,
      apiKey: text(input.apiKey, KEY_MAX) || (sameTarget ? oldFirst.apiKey : ''),
      label: oldFirst?.label ?? '',
    };
    return { endpoints: [first, ...previous.slice(1)] };
  }

  let next = normalizeEndpoints(input.endpoints);
  if (!next.length) {
    if (input.endpoints.length || !address(input.baseUrl)) {
      return { error: '模型组至少需要一个有效端点地址' };
    }
    next = normalizeEndpoints([], { fallbackBaseUrl: input.baseUrl, fallbackApiKey: input.apiKey });
  }

  const targets = next.map((ep) => endpointTarget(ep.baseUrl));
  for (let index = 0; index < next.length; index++) {
    const ep = next[index];
    if (ep.apiKey) continue;
    const target = targets[index];
    // 明确给出的单地址凭据仅能用于同地址的首端点。
    if (index === 0 && target && target === endpointTarget(input.baseUrl) && text(input.apiKey, KEY_MAX)) {
      ep.apiKey = text(input.apiKey, KEY_MAX);
      continue;
    }
    const matches = target ? previous.filter((old) => endpointTarget(old.baseUrl) === target) : [];
    if (matches.length && (matches.length !== 1 || targets.filter((key) => key === target).length !== 1)) {
      return { error: '同一地址有多条端点，无法确定要保留哪把密钥，请为这些端点重新填写密钥' };
    }
    if (matches.length === 1) ep.apiKey = matches[0].apiKey;
  }
  return { endpoints: next };
}

/** 返回游标对应的端点及下标。 */
export function endpointAt(endpoints, cursor = 0) {
  if (!Array.isArray(endpoints) || !endpoints.length) return null;
  const index = Math.abs(Math.floor(Number(cursor) || 0)) % endpoints.length;
  return { endpoint: endpoints[index], index };
}

/** 将轮转游标限制在当前端点数量内。 */
export function rotateCursor(cursor, endpointCount) {
  const count = Math.max(1, Number(endpointCount) || 1);
  return ((Math.floor(Number(cursor) || 0) + 1) % count + count) % count;
}
