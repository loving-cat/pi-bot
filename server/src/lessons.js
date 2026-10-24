/**
 * 经验库（lessons）—— 从**实际执行**里长出来的「下次别这么做 / 就这么做」。
 *
 * ## 它和另外三样东西的区别
 *
 *   · 人设 persona：这个 bot 是谁（人写的、静态）
 *   · 技能 skills：这类活怎么做（人整理的、静态）
 *   · 记忆 / 项目上下文：这个项目的事实（静态）
 *   ★ 经验 lessons：**做过什么、结果如何、下次改什么**（执行产出的、带证据、可被推翻）
 *
 * 前三个是声明式的；只有经验能回答"上次这么干是成是败"。
 *
 * ## 上下文预算（这是这个模块的第一原则）
 *
 * 经验库会一直长，但**注入量必须恒定**：
 *   · 只注入 status=active 的（候选只给界面看，不进提示词）；
 *   · 一次最多 3 条、渲染后总共不超过 600 字；
 *   · 只给**主控**（派活质量决定后面所有轮次；成员层噪音大、收益低）；
 *   · 只在一轮真正开始时按任务挑（和技能库同一个位置），不是会话常驻；
 *   · 只注入 cue + lesson，evidence 留在库里供人审计，不进上下文。
 *
 * 没有相关性就不给 —— 宁可不给，也别塞一堆无关的经验把提示词撑爆。
 */

import { splitWords } from './skills.js';

/** 字段与注入上限（改这里就等于改预算，别在别处写魔法数字） */
export const LESSON_LIMITS = {
  /** 情境描述的最大字数 */
  cue: 120,
  /** 做法/教训的最大字数 */
  lesson: 240,
  /** 一条经验最多留几条证据 */
  evidence: 3,
  /** 单条证据引文的最大字数 */
  quote: 200,
  /** 库里最多存多少条 */
  total: 200,
  /** 一次最多注入几条 */
  maxInject: 3,
  /** 一次注入的总字数（不含标题行） */
  maxChars: 600,
};

/** 结论四档：和 Harness² 的用词一致，`confounded` 是"说不清"的诚实档 */
export const LESSON_VERDICTS = ['helped', 'hurt', 'no_effect', 'confounded'];

/** 候选 → 启用 → 归档。只有 active 会进提示词。 */
export const LESSON_STATUSES = ['candidate', 'active', 'archived'];

/** 文本里有没有编码损坏（同 skills.js 的理由） */
export function hasBrokenEncoding(text) {
  return /\uFFFD/.test(String(text ?? ''));
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** 证据：{ taskId, msgId, quote }，至少要有 quote */
export function normalizeEvidence(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const quote = str(item.quote, LESSON_LIMITS.quote);
    if (!quote) continue;
    if (hasBrokenEncoding(quote)) continue;
    out.push({
      taskId: str(item.taskId, 64),
      msgId: str(item.msgId, 64),
      quote,
    });
    if (out.length >= LESSON_LIMITS.evidence) break;
  }
  return out;
}

/**
 * 校验一条经验能不能入库，返回**人话原因**（能入库返回 null）。
 *
 * 最重要的一条：**没有证据不能启用**。这是从 Harness² 学来的纪律 ——
 * "被采纳"不等于"有效"，凭印象写下的因果会把整个库带偏。
 */
export function lessonRejectReason(raw = {}) {
  const cue = str(raw?.cue, LESSON_LIMITS.cue);
  const lesson = str(raw?.lesson, LESSON_LIMITS.lesson);

  if (!cue) return '要写清「什么情况下用得上」（cue）';
  if (!lesson) return '要写清「下次具体怎么做」（lesson）';

  if (hasBrokenEncoding(raw?.cue) || hasBrokenEncoding(raw?.lesson)) {
    return '内容里有乱码（编码损坏），请重新输入或换个方式导入';
  }

  if (raw?.verdict !== undefined && !LESSON_VERDICTS.includes(raw.verdict)) {
    return '结论只能是 helped / hurt / no_effect / confounded';
  }
  if (raw?.status !== undefined && !LESSON_STATUSES.includes(raw.status)) {
    return '状态只能是 candidate / active / archived';
  }

  const status = LESSON_STATUSES.includes(raw?.status) ? raw.status : 'candidate';
  if (status === 'active' && normalizeEvidence(raw?.evidence).length === 0) {
    return '没有证据的经验不能启用 —— 至少留一条来源（哪次任务、用户原话）';
  }

  return null;
}

/** 规范化一条经验（形状固定，读出来和存进去一致） */
export function normalizeLesson(raw = {}, now = Date.now()) {
  const cue = str(raw.cue, LESSON_LIMITS.cue);
  const lesson = str(raw.lesson, LESSON_LIMITS.lesson);
  if (!cue || !lesson) return null;

  const verdict = LESSON_VERDICTS.includes(raw.verdict) ? raw.verdict : 'confounded';
  let status = LESSON_STATUSES.includes(raw.status) ? raw.status : 'candidate';
  const evidence = normalizeEvidence(raw.evidence);

  // 没证据的只能停在候选，别让调用方绕过校验把它写成 active
  if (status === 'active' && evidence.length === 0) status = 'candidate';

  return {
    id: str(raw.id, 64) || `les_${Math.random().toString(36).slice(2, 10)}`,
    roomId: str(raw.roomId, 64),
    dept: str(raw.dept, 60),
    cue,
    lesson,
    evidence,
    verdict,
    status,
    hits: Number.isFinite(raw.hits) ? Math.max(0, Math.floor(raw.hits)) : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : 0,
  };
}

/** 规范化整个库：去无效、去重复、限量 */
export function normalizeLessonList(list = [], now = Date.now()) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const lesson = normalizeLesson(item, now);
    if (!lesson) continue;
    const key = `${lesson.roomId}\u0000${lesson.cue.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lesson);
    if (out.length >= LESSON_LIMITS.total) break;
  }
  return out;
}

/**
 * 按当前任务挑经验。
 *
 * 打分（和技能库同一套思路，但门槛更高 —— 经验只有 3 个名额）：
 *   · cue 命中 → +3
 *   · lesson 命中 → +1
 *   · 同房间 → +1
 * 只有 active 参与；总分 < 3 的不要（房间分单独不够，必须真的相关）。
 *
 * @param {Array} lessons 经验库
 * @param {string} task 当前任务文本（派活内容 + 用户消息）
 * @param {object} [opts]
 * @param {string} [opts.roomId] 当前房间（同部门经验加分）
 * @param {number} [opts.max] 最多几条
 * @param {number} [opts.minScore] 多少分算相关
 */
export function selectLessonsFor(
  lessons = [],
  task = '',
  { roomId = '', max = LESSON_LIMITS.maxInject, minScore = 3 } = {},
) {
  const text = String(task ?? '').toLowerCase();
  if (!text.trim()) return [];

  const scored = [];
  for (const item of Array.isArray(lessons) ? lessons : []) {
    if (!item || item.status !== 'active') continue;
    let score = 0;
    for (const word of splitWords(item.cue)) {
      if (text.includes(word)) score += 3;
    }
    for (const word of splitWords(item.lesson)) {
      if (text.includes(word)) score += 1;
    }
    if (roomId && item.roomId && item.roomId === roomId) score += 1;
    if (score >= minScore) scored.push({ lesson: item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, max)).map((s) => s.lesson);
}

/** `10/19` 这种短日期：告诉模型这条经验有多旧，不占几个字 */
function shortDate(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 渲染成提示词片段。
 *
 * 硬约束：总字数（不含标题行）不超过 maxChars；塞不下就截断当前这条，
 * 连 40 字都放不下就整条不要 —— 绝不为了"多给一条"把提示词撑大。
 *
 * @param {Array} picked selectLessonsFor 的结果
 * @param {object} [opts]
 * @param {number} [opts.maxChars]
 * @returns {string[]} 空数组 = 不注入
 */
export function lessonsPromptLines(picked = [], { maxChars = LESSON_LIMITS.maxChars } = {}) {
  if (!Array.isArray(picked) || !picked.length) return [];

  const lines = [];
  let used = 0;
  for (let i = 0; i < picked.length; i++) {
    const item = picked[i];
    const date = shortDate(item.createdAt);
    const prefix = item.verdict === 'hurt' ? '别：' : '';
    let body = `${i + 1}. ${item.cue} → ${prefix}${item.lesson}${date ? `（${date}）` : ''}`;

    const room = maxChars - used;
    if (body.length > room) {
      if (room < 40) break;
      body = `${body.slice(0, room - 1)}…`;
    }
    lines.push(body);
    used += body.length + 1;
  }

  if (!lines.length) return [];
  return [
    '【这个团队踩过的坑（是经验，不是硬规则；跟当前任务无关就忽略）】',
    ...lines,
  ];
}
