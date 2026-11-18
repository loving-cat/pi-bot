/**
 * 聊天消息中的明文凭据自动脱敏（纯函数、零 IO）。
 *
 * 使用场景：
 *   用户通过电脑/手机聊天框把 API Key 发给主控（Jarvis）让它配置模型组或路由时，
 *   系统把密钥加密落盘后，立即把聊天记录里对应消息的明文密钥原地打码并通过 WS 推给客户端，
 *   避免明文 Key 长期留在房间历史或记忆中。
 */

/** 按 key 长度打码：只留头尾字符，中间用省略号代替。 */
export function maskSecretValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.length <= 10) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

const SECRET_SHAPE_PATTERNS = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_[A-Za-z0-9]{24,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
];

const BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})\b/gi;

/**
 * 把文本里的明文密钥（显式传入值 + 常见高置信度 Token 形态）替换为掩码。
 *
 * @param {string} text
 * @param {string[]} [extraSecrets]
 * @returns {string}
 */
export function redactChatSecrets(text, extraSecrets = []) {
  let out = String(text ?? '');
  if (!out) return out;

  const extras = [...new Set(
    (Array.isArray(extraSecrets) ? extraSecrets : [])
      .map((v) => String(v ?? '').trim())
      .filter((v) => v.length >= 8),
  )].sort((a, b) => b.length - a.length);

  for (const sec of extras) {
    if (out.includes(sec)) {
      out = out.split(sec).join(maskSecretValue(sec));
    }
  }

  for (const re of SECRET_SHAPE_PATTERNS) {
    out = out.replace(re, (m) => maskSecretValue(m));
  }

  out = out.replace(BEARER_PATTERN, (_m, tok) => `Bearer ${maskSecretValue(tok)}`);
  return out;
}
