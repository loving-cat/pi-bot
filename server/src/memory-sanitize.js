/**
 * 记忆摘要的写入脱敏：纯函数，无 IO、无状态，方便单测。
 *
 * 摘要会长期落盘、跨会话复用，所以写之前把明显是凭据的东西抹掉。
 * 这一阶段只处理凭据，**不处理文件路径** —— 路径怎么脱敏还没拍板。
 *
 * ★ 宁可漏也不能误杀：
 *   规则都锚定在"像赋值/像令牌"的形状上，不用裸 token 字样匹配 ——
 *   否则「token 预算」「最大 token 数」这种正常表述会被一起删掉。
 */

const REDACTED = '[已脱敏]';

/** 邮箱 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** PEM 私钥块（含头尾）。用 [\s\S] 跨行匹配，贪婪到 END 标记。 */
const PEM_PRIVATE_KEY =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g;

/** Bearer 令牌：必须字面出现 Bearer 前缀才处理。 */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * 赋值式凭据：键名必须是凭据语义，值至少 8 位。
 *
 * 键名限定成这几种，是为了避开「token 预算」「secret 配置项说明」
 * 这类正文 —— 它们后面要么没有 =/：，要么值不是一串高熵字符。
 */
const ASSIGNMENT =
  /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|pwd)\b\s*[=:]\s*(?:"[^"]{8,}"|'[^']{8,}'|[^\s,;，；]{8,})/gi;

/**
 * 把一段文本里明显是凭据的部分替换成 [已脱敏]。
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeMemoryText(text) {
  let out = String(text ?? '');
  if (!out) return out;
  // 顺序有讲究：先抹私钥块（它内部可能含类邮箱/类赋值的行），
  // 再抹 Bearer，最后抹赋值式凭据和邮箱。
  out = out.replace(PEM_PRIVATE_KEY, REDACTED);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  out = out.replace(ASSIGNMENT, (match) => {
    // 保留键名和分隔符，只替换值，读起来还能知道"这里原本有个 key"
    const sep = match.search(/[=:]/);
    if (sep < 0) return REDACTED;
    return `${match.slice(0, sep + 1)} ${REDACTED}`;
  });
  out = out.replace(EMAIL, REDACTED);
  return out;
}

export default sanitizeMemoryText;
