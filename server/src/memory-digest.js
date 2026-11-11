/**
 * 记忆摘要的"材料挑选"：纯函数，方便单测。
 *
 * 只挑真正有信息量的对话内容 —— 进度回执（"接到活/做完了"）、系统提示、
 * 引用指针、压缩提示条都不进摘要，否则几百条回执会把结论挤掉。
 */

import { countTurns } from './memory-policy.js';

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

/** 用已处理消息 ID 定位增量；游标不在窗口时处理当前可见材料，避免窗口滑动后停更。 */
export function memoryProgress(messages = [], summary = null) {
  const conversation = memoryConversation(messages);
  const cursor = summary?.lastId;
  const index = cursor ? messages.findIndex((message) => message.id === cursor) : -1;
  const newMessages = memoryConversation(index >= 0 ? messages.slice(index + 1) : messages);
  const previousTurns = Math.max(0, Number(summary?.count) || 0);
  return {
    conversation,
    newMessages,
    lastId: messages.at(-1)?.id ?? null,
    totalTurns: summary?.text ? previousTurns + countTurns(newMessages) : countTurns(conversation),
  };
}


/**
 * 拼「让模型更新记忆」的提示词。纯函数，方便单测。
 *
 * 两种形态：
 *   · 有 previousText（已有摘要）：在旧摘要上**增量更新** ——
 *     模型只需要并入新信息、修正过时结论，不必从零重写。
 *     整份重写的代价是：上一版里仍然成立的结论容易在重写中丢失。
 *   · 没有 previousText（首次）：只用对话材料。
 *
 * 注意：要点 1–3 的措辞改过，第 4 条「重要的文件路径或系统状态」
 * 和「总长不超过 500 字」保持原文 —— 那两条还没拍板。
 */
export function buildSummarizePrompt({ botName = '', previousText = '', digest = '' } = {}) {
  const hasPrevious = Boolean(String(previousText ?? '').trim());
  const head = hasPrevious
    ? `下面是「${botName}」已有的记忆和最近新增的对话记录。请在已有记忆上更新，不要整份重写：`
    : `下面是「${botName}」与用户最近的对话记录。请把它整理成一份"记忆摘要"：`;

  const rules = [
    '1) 用户长期关注什么、有什么偏好与要求；',
    '2) 已经确定的结论/数据/口径（保留关键数字）；',
    '3) 还没做完的事与下一步；',
    '4) 重要的文件路径或系统状态。',
  ];

  const constraints = [
    '要求：要点式中文，每行一条，总长不超过 500 字；不要复述原话，不要寒暄。',
  ];
  if (hasPrevious) {
    constraints.push(
      '相互矛盾时以用户更正为准，只保留现行结论，不要并列两份相反事实；已有记忆中仍成立的结论和数字必须保留。',
    );
  }

  const parts = [head, ...rules, ...constraints];
  if (hasPrevious) {
    parts.push('', '【已有记忆】', String(previousText).trim());
  }
  parts.push('', hasPrevious ? '【新增对话】' : '', digest);
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
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
