/**
 * 派活流水 → 任务标题的规范化（纯字符串处理，无 IO）。
 *
 * ## 为什么需要
 *
 * `upsertDispatchTask` 原来把模型的**整段发言**当标题存下来（截 200 字），
 * 于是任务板上出现的是「我是**跨境运营负责人**，这个季度我盯…」这种自我介绍，
 * 或者「收到。先看基线和色板…」这种应答 —— 用户的原话是"很多都不像一个任务"。
 *
 * 两件事分开做：
 *   1. `isTaskWorthy`：这句话是不是真在派活？自我介绍、打招呼、提问、
 *      纯应答（收到/好的）都不该建任务。
 *   2. `normalizeTaskTitle`：真派活时，把标题压成"一句话"：
 *      去掉 markdown 记号（**、`、#）、只取第一段、压掉换行与多余空白、截断。
 */

/** 一眼就知道不是任务的开口（自我介绍 / 招呼）。 */
const CHITCHAT_HEAD_RE =
  /^(?:你好|您好|嗨|hi|hello|hey|在吗|在不在|收到了?|好的|好嘞|明白|了解|ok|嗯|行)(?:[\s，,。.!！~～:：]|$)/i;

/** 自我介绍开头：“我是<名字>…” 一律不是派活（名字后面不一定跟逗号）。 */
const SELF_INTRO_RE = /^(?:我是|我叫)/;

/** 纯应答（整句只有这些，允许尾部表情/标点）。 */
const ACK_ONLY_RE = /^(?:收到|好的|好嘞|明白|了解|没问题|ok|okay|嗯+|行)$/i;

/** 提问句（结尾是问号 / 吗呢么），派活里很少这么写。 */
const QUESTION_TAIL_RE = /(?:[?？]|(?:吗|呢|么)[。.!！\s]*)$/;

/**
 * 这句话值不值得建一条任务？
 *
 * 判据刻意保守：只要像"陈述式的工作安排"就放行，
 * 只有明显是寒暄/应答/提问才拦 —— 宁可多留一条，也不要吞掉真派活。
 */
export function isTaskWorthy(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (raw.length < 4) return false;
  // 先去掉 markdown 再判：`我是**跨境运营负责人**` 里“我是”后面跟着 `**`，
  // 直接在原文上测正则会因为星号而不匹配。
  const plain = raw
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/^[ \t]*(?:#{1,6}[ \t]*|>|[-*+])[ \t]*/gm, '')
    .trim();
  if (!plain) return false;
  const ackLike = plain
    .replace(/[\s。.!！~～，,、:：]+$/u, '')
    .replace(/[\p{Emoji_Presentation}\uFE0F]/gu, '')
    .trim();
  if (ACK_ONLY_RE.test(ackLike)) return false;
  if (SELF_INTRO_RE.test(plain)) return false;
  if (CHITCHAT_HEAD_RE.test(plain)) return false;
  // 短问句不建任务；长文里夹一个问号可能是确认细节，不拦
  if (plain.length <= 40 && QUESTION_TAIL_RE.test(plain)) return false;
  return true;
}

/**
 * 把一段发言压成一条任务标题。
 *
 * · 去掉 markdown：**加粗**、`代码`、# 标题、> 引用、列表符号
 * · 只取第一段（第一个空行之前）；没有空行就取第一行
 * · 压掉换行与连续空白
 * · 超长按字符截断（不会切半个 emoji），末尾加省略号
 */
export function normalizeTaskTitle(text, { maxChars = 48 } = {}) {
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // 先剥加粗/斜体/代码强调，再剥行首标记 —— 顺序反了会把 `**` 只吃掉一个
  s = s.replace(/\*\*|__|~~|`/g, '');
  s = s.replace(/^[ \t]*(?:#{1,6}[ \t]*|>|[-*+])[ \t]*/gm, '');
  // 第一段 / 第一行
  const firstBlock = s.split(/\n\s*\n/)[0] ?? '';
  const firstLine = (firstBlock.split('\n').find((line) => line.trim()) ?? '').trim();
  s = (firstLine || firstBlock).replace(/\s+/g, ' ').trim();
  s = s.replace(/^[：:，,、。.\-—\s]+/, '').trim();
  if (!s) return '';
  const runes = [...s];
  if (runes.length <= maxChars) return s;
  return `${runes.slice(0, maxChars).join('')}…`;
}
