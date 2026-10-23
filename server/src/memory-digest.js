/**
 * 记忆摘要的"材料挑选"：纯函数，方便单测。
 *
 * 只挑真正有信息量的对话内容 —— 进度回执（"接到活/做完了"）、系统提示、
 * 引用指针、压缩提示条都不进摘要，否则几百条回执会把结论挤掉。
 */

export function isMemoryMaterial(message) {
  if (!message) return false;
  if (!(message.text ?? '').trim()) return false;
  if (message.kind === 'ref' || message.kind === 'compact') return false;
  if (message.authorType === 'system') return false;
  if (message.meta?.progress === true) return false;
  return true;
}

export function memoryConversation(messages = []) {
  return messages.filter(isMemoryMaterial);
}

/** 拼成给模型的摘要材料；按条数/单条/总字数三重截断。 */
export function buildMemoryDigest(
  messages = [],
  { maxMessages = 60, maxCharsPerMessage = 500, maxChars = 12000 } = {},
) {
  const picked = memoryConversation(messages).slice(-maxMessages);
  const text = picked
    .map((m) => {
      const who = m.authorType === 'user' ? '用户' : (m.authorName || 'bot');
      const body = String(m.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxCharsPerMessage);
      return `${who}：${body}`;
    })
    .join('\n');
  return text.length <= maxChars ? text : text.slice(-maxChars);
}
