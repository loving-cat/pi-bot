/**
 * 审批卡上的 MCP 参数摘要 —— 能看到"它要干什么"，但看不到凭据。
 *
 * ## 为什么不能直接把 input 塞进卡片
 *
 * 原来 MCP 调用建审批时传的是 `input: null`（policy-hook.js），
 * 卡片上只有"调用外部工具 mcp__xxx__yyy"这一句 —— 用户看不到参数，
 * 等于盲批。但反过来直接把原始参数显示出来同样不行：
 * 模型可能把 API key 当参数传（有些 MCP 工具就是要求显式传 key），
 * 那张卡就成了凭据泄漏面（审批记录会落盘、会推给客户端）。
 *
 * 所以：结构完整保留、值按"是否像凭据"打码。
 *
 * ## 打码判定
 *
 * 三层，任意一层命中就打码：
 *   1. 键名像凭据（api_key / token / secret / password / authorization …）
 *   2. 键名正好是那个 MCP server 已存的 env / header 键名
 *   3. 值本身像凭据（Bearer 前缀、长随机串、sk- 前缀等）
 *
 * 第 2 条是关键：即使用户把凭据存在 env `FOO` 里、模型又恰好在参数里
 * 传了同一个名字，也能遮掉 —— 光看键名 `FOO` 是判断不出来的。
 */

/** 键名像凭据 */
const SECRET_KEY = /(api[-_]?key|apikey|token|secret|password|passwd|pwd|credential|authorization|auth[-_]?key|private[-_]?key|access[-_]?key|session[-_]?id|cookie)/i;

/** 值像凭据 */
const SECRET_VALUE = [
  /^Bearer\s+\S+/i,
  /^Basic\s+\S+/i,
  /^sk-[A-Za-z0-9_-]{12,}/,
  /^gh[pousr]_[A-Za-z0-9]{16,}/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}/,
  /^AKIA[0-9A-Z]{16}$/,
  // 长随机串：24 位以上、无空格、字母数字混合
  /^[A-Za-z0-9_+/=-]{24,}$/,
];

const MASK = '[已隐藏]';

function looksSecretValue(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return SECRET_VALUE.some((re) => re.test(text));
}

/**
 * 造一份可安全展示的参数摘要。
 *
 * @param {object|null|undefined} input 工具调用入参
 * @param {object} [opts]
 * @param {string[]} [opts.secretKeys] 该 server 已存的 env/header 键名（大小写不敏感）
 * @param {number} [opts.maxLength] 摘要总长上限
 * @returns {string} 人话摘要
 */
export function mcpApprovalSummary(input, opts = {}) {
  const { secretKeys = [], maxLength = 400 } = opts;
  const secretSet = new Set(secretKeys.map((k) => String(k).toLowerCase()));

  if (input == null) return '(无参数)';
  if (typeof input !== 'object' || Array.isArray(input)) {
    return maskScalar(input, secretSet);
  }

  const keys = Object.keys(input);
  if (!keys.length) return '(无参数)';

  const parts = [];
  for (const key of keys.slice(0, 20)) {
    const value = input[key];
    if (secretSet.has(key.toLowerCase()) || SECRET_KEY.test(key)) {
      parts.push(key + '=' + MASK);
      continue;
    }
    if (value && typeof value === 'object') {
      parts.push(key + '=' + (Array.isArray(value) ? '[' + value.length + ' 项]' : '{…}'));
      continue;
    }
    parts.push(key + '=' + maskScalar(value, secretSet));
  }

  let text = parts.join(', ');
  if (keys.length > 20) text += `, …(还有 ${keys.length - 20} 项)`;
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

function maskScalar(value, secretSet) {
  if (value === null || value === undefined) return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (secretSet?.has(String(text).toLowerCase())) return MASK;
  if (looksSecretValue(text)) return MASK;
  return text.length > 120 ? text.slice(0, 119) + '…' : text;
}
