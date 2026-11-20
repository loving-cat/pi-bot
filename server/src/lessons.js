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

import { createHash } from 'node:crypto';
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
  // ---- SIM-Lite（2.0）新增上限：只加字段，不改既有预算 ----
  /** 一条经验最多记几个模型族的战果 */
  byFamilyKeys: 8,
  /** 关系边总数上限（超了按时间淘汰最旧） */
  edges: 2000,
  /** 单条经验挂的边上限 */
  edgesPerLesson: 50,
  /** 模型族名字最大长度 */
  family: 24,
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

  const out = {
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
    // ---- SIM-Lite（2.0）新增字段：缺省给安全值，老库不需要迁移脚本 ----
    modelFamily: str(raw.modelFamily, LESSON_LIMITS.family).toLowerCase() || UNKNOWN_MODEL_FAMILY,
    byFamily: normalizeFamilyStats(raw.byFamily),
  };
  out.contentHash = str(raw.contentHash, 80) || lessonContentHash(out);
  return out;
}

/** 规范化整个库：去无效、去重复（同房间同 cue / 同内容哈希）、限量 */
export function normalizeLessonList(list = [], now = Date.now()) {
  const out = [];
  const seen = new Set();
  const seenHashes = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const lesson = normalizeLesson(item, now);
    if (!lesson) continue;
    const key = `${lesson.roomId}\u0000${lesson.cue.toLowerCase()}`;
    if (seen.has(key)) continue;
    if (lesson.contentHash && seenHashes.has(lesson.contentHash)) continue;
    seen.add(key);
    if (lesson.contentHash) seenHashes.add(lesson.contentHash);
    out.push(lesson);
    if (out.length >= LESSON_LIMITS.total) break;
  }
  return out;
}

/**
 * 打分权重（改这里 = 改筛选口径，别在别处写魔法数字）。
 *
 * 前四项是 1.x 就有的；后三项是 SIM-Lite（2.0）的**跨模型去偏**与**关系边**：
 *   · `sameFamily`：当前模型族在这条经验上确实赢过 → 加分；
 *   · `untestedFamily`：经验有归因，但当前族没战果 → 减分（不排除，界面会标「未在同模型验证」）；
 *   · `generalizesHop`：一跳 `generalizes` 边 → 让泛化条也能被召回。
 * `contradicts` 不是减分，是**直接排除** —— 宁可不给，也不给矛盾经验。
 */
export const LESSON_SCORING = Object.freeze({
  cueHit: 3,
  lessonHit: 1,
  sameRoom: 1,
  sameFamily: 2,
  untestedFamily: -1,
  generalizesHop: 1,
  minScore: 3,
});

/**
 * 按当前任务给一条经验打分（纯函数；不参与候选时返回 null）。
 *
 * 【SIM-Lite】`modelFamily` / `edgeIndex` 都是可选的：都不传时行为与 1.x **完全一致**
 * —— 这是 Phase 0 的硬要求，新字段不许悄悄改变旧行为。
 *
 * @param {object} item 经验
 * @param {string} task 当前任务文本
 * @param {{ roomId?: string, modelFamily?: string, edgeIndex?: Map|null }} [opts]
 * @returns {number|null} 分数；null = 不参与候选（非 active / 被 contradicts 排除）
 */
export function lessonScore(item, task, { roomId = '', modelFamily = '', edgeIndex = null } = {}) {
  if (!item || item.status !== 'active') return null;
  const text = String(task ?? '').toLowerCase();
  if (!text.trim()) return null;
  let score = 0;
  for (const word of splitWords(item.cue)) {
    if (text.includes(word)) score += LESSON_SCORING.cueHit;
  }
  for (const word of splitWords(item.lesson)) {
    if (text.includes(word)) score += LESSON_SCORING.lessonHit;
  }
  if (roomId && item.roomId && item.roomId === roomId) score += LESSON_SCORING.sameRoom;

  if (edgeIndex) {
    for (const edge of edgeIndex.get(item.id) ?? []) {
      if (edge.type === 'contradicts') return null; // 排除，不是减分
      if (edge.type === 'generalizes') score += LESSON_SCORING.generalizesHop;
    }
  }

  // `unknown` = 1.x 沉淀的老经验，没有归因信息：既不享受同族加成，也不背"未验证"扣分
  const declaredFamily = item.modelFamily && item.modelFamily !== UNKNOWN_MODEL_FAMILY ? item.modelFamily : '';
  if (modelFamily) {
    const stats = item.byFamily?.[modelFamily] ?? null;
    const verified = Boolean(stats) && (stats.win || 0) + (stats.fail || 0) > 0;
    if (verified) score += LESSON_SCORING.sameFamily;
    else if (declaredFamily === modelFamily) score += LESSON_SCORING.sameFamily;
    else if (declaredFamily || stats) score += LESSON_SCORING.untestedFamily;
  }
  return score;
}

/**
 * 按当前任务挑经验。
 *
 * 打分（和技能库同一套思路，但门槛更高 —— 经验只有 3 个名额）：
 *   · cue 命中 → +3 / lesson 命中 → +1 / 同房间 → +1
 *   · 【SIM-Lite】同族验证过 → +2，有归因但本族未验证 → -1，一跳 generalizes → +1
 * 只有 active 参与；总分 < 3 的不要（房间分单独不够，必须真的相关）。
 *
 * @param {Array} lessons 经验库
 * @param {string} task 当前任务文本（派活内容 + 用户消息）
 * @param {object} [opts]
 * @param {string} [opts.roomId] 当前房间（同部门经验加分）
 * @param {number} [opts.max] 最多几条
 * @param {number} [opts.minScore] 多少分算相关
 * @param {string} [opts.modelFamily] 当前模型族（SIM-Lite；不传 = 1.x 行为）
 * @param {Array} [opts.edges] 关系边（SIM-Lite；不传 = 1.x 行为）
 */
export function selectLessonsFor(
  lessons = [],
  task = '',
  {
    roomId = '',
    max = LESSON_LIMITS.maxInject,
    minScore = LESSON_SCORING.minScore,
    modelFamily = '',
    edges = null,
  } = {},
) {
  const text = String(task ?? '').toLowerCase();
  if (!text.trim()) return [];

  const edgeIndex = edges?.length ? lessonEdgeIndex(edges) : null;
  const scored = [];
  for (const item of Array.isArray(lessons) ? lessons : []) {
    const score = lessonScore(item, task, { roomId, modelFamily, edgeIndex });
    if (score === null || score < minScore) continue;
    scored.push({ lesson: item, score });
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

// ===========================================================================
// SIM-Lite（2.0）：模型族、关系边、置信度、去重与淘汰
//
// 这一节只**定契约与纯函数**，不碰磁盘、不碰 store（Phase 0 定稿，Phase 1 接线）。
// 三条硬约束：
//   1. 老库直接可读：缺字段给默认值，不需要迁移脚本；
//   2. 不传新参数时行为与 1.x 完全一致（`selectLessonsFor` 已守住）；
//   3. 关系边和代码一样是"可审"的：类型只有 4 种，越界一律拒绝。
// ===========================================================================

/** 模型族的封闭词表：跨模型去偏只在这里面归因，避免拼写漂移成十几个"族" */
export const MODEL_FAMILIES = Object.freeze([
  'glm', 'deepseek', 'kimi', 'qwen', 'gpt', 'claude', 'gemini', 'other',
]);

/** 没有任何归因信息时的族名（1.x 沉淀的老经验都是这个） */
export const UNKNOWN_MODEL_FAMILY = 'unknown';

/** provider / model 名 → 族的猜测规则（顺序敏感：先具体后宽泛） */
const FAMILY_HINTS = [
  [/glm|zhipu|chatglm|sensenova|nvidia/i, 'glm'],
  [/deepseek/i, 'deepseek'],
  [/kimi|moonshot/i, 'kimi'],
  [/qwen|tongyi|dashscope/i, 'qwen'],
  [/gpt|openai|azure/i, 'gpt'],
  [/claude|anthropic/i, 'claude'],
  [/gemini|google|vertex/i, 'gemini'],
];

/**
 * 从 provider / model 名推模型族（纯字符串函数）。
 *
 * 传多个提示时取**第一个命中的规则**；一个都没命中 → `other`；
 * 一个提示都没给 → `unknown`（= 这条经验没有归因信息）。
 */
export function resolveModelFamily(...hints) {
  const list = hints.flat().filter((h) => typeof h === 'string' && h.trim());
  if (!list.length) return UNKNOWN_MODEL_FAMILY;
  for (const hint of list) {
    for (const [re, family] of FAMILY_HINTS) {
      if (re.test(hint)) return family;
    }
  }
  return 'other';
}

const toCount = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1_000_000, Math.floor(n));
};

/** 规范化 `byFamily`：只留计数、最多 `byFamilyKeys` 个族、族名截断小写 */
export function normalizeFamilyStats(raw = {}) {
  const out = {};
  let keys = 0;
  for (const [name, stats] of Object.entries(raw ?? {})) {
    if (keys >= LESSON_LIMITS.byFamilyKeys) break;
    const family = str(name, LESSON_LIMITS.family).toLowerCase();
    if (!family) continue;
    out[family] = { hit: toCount(stats?.hit), win: toCount(stats?.win), fail: toCount(stats?.fail) };
    keys++;
  }
  return out;
}

/**
 * 置信度（0~0.95，纯派生、可重算、不必落库）。
 *
 * 公式故意简单，能向用户解释清楚：
 *   base     —— verdict 给的先验（helped 0.5 / confounded 0.25 / hurt 0.15 / no_effect 0.1）
 *   ratio    —— 跨所有族的 win/(win+fail)（没打过就按 0.5）
 *   volume   —— 样本量（5 次封顶）
 *   coverage —— 有几个族真的打过（2 个封顶）→ 这就是"跨模型"的权重
 */
export function lessonConfidence(item = {}) {
  const stats = Object.values(normalizeFamilyStats(item.byFamily));
  const win = stats.reduce((n, s) => n + s.win, 0);
  const fail = stats.reduce((n, s) => n + s.fail, 0);
  const trials = win + fail;
  const validatedFamilies = stats.filter((s) => s.win + s.fail > 0).length;
  const base =
    item.verdict === 'helped'
      ? 0.5
      : item.verdict === 'hurt'
        ? 0.15
        : item.verdict === 'no_effect'
          ? 0.1
          : 0.25;
  const ratio = trials ? win / trials : 0.5;
  const volume = Math.min(1, trials / 5);
  const coverage = Math.min(1, validatedFamilies / 2);
  const mixed = base * 0.4 + ratio * 0.3 + volume * 0.15 + coverage * 0.15;
  return Math.round(Math.min(0.95, Math.max(0, mixed)) * 1000) / 1000;
}

/**
 * 去重键：`cue + lesson` 归一化后的 sha256 前 32 位。
 *
 * 只用来判断"是不是同一条经验"，不参与任何安全判定（不是签名也不是 MAC）。
 * 归一化只做小写与空白折叠 —— 换模型改写措辞会产生新哈希，这是有意的：
 * 措辞不同就当成新经验，靠 `supersedes` 边收旧条，而不是猜"这俩是一回事"。
 */
export function lessonContentHash(item = {}) {
  const cue = str(item.cue, LESSON_LIMITS.cue).toLowerCase().replace(/\s+/g, '');
  const body = str(item.lesson, LESSON_LIMITS.lesson).toLowerCase().replace(/\s+/g, '');
  const digest = createHash('sha256').update(`${cue}\u0000${body}`, 'utf8').digest('hex');
  return `sha256:${digest.slice(0, 32)}`;
}

/** 关系边的 4 种类型（多一种都要先改这里 + 规格） */
export const LESSON_EDGE_TYPES = Object.freeze([
  'supersedes', 'requires', 'contradicts', 'generalizes',
]);

/** 校验一条边能不能入库，返回人话原因（能入库返回 null） */
export function lessonEdgeRejectReason(raw = {}) {
  const from = str(raw.from, 64);
  const to = str(raw.to, 64);
  if (!from || !to) return '边要写清 from / to（哪条指向哪条）';
  if (from === to) return '不能自己连自己';
  if (!LESSON_EDGE_TYPES.includes(raw.type)) {
    return `边类型只能是 ${LESSON_EDGE_TYPES.join(' / ')}`;
  }
  return null;
}

/** 规范化一条边（形状固定；不合格返回 null） */
export function normalizeLessonEdge(raw = {}, now = Date.now()) {
  if (lessonEdgeRejectReason(raw)) return null;
  return {
    from: str(raw.from, 64),
    to: str(raw.to, 64),
    type: raw.type,
    at: Number.isFinite(raw.at) ? raw.at : now,
    by: str(raw.by, 32) || 'distiller',
  };
}

/**
 * 规范化整个边集合：丢无效、去重（同 from+to+type）、丢悬空（给了 knownIds 时）、限量。
 * 超上限时保留**最后写入**的边（新证据优先），避免旧边把新结论挤掉。
 */
export function normalizeLessonEdgeList(list = [], { knownIds = null, now = Date.now() } = {}) {
  const known = knownIds instanceof Set ? knownIds : Array.isArray(knownIds) ? new Set(knownIds) : null;
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const edge = normalizeLessonEdge(item, now);
    if (!edge) continue;
    if (known && (!known.has(edge.from) || !known.has(edge.to))) continue;
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out.length > LESSON_LIMITS.edges ? out.slice(out.length - LESSON_LIMITS.edges) : out;
}

/** 边索引：`from` → 该条经验挂出去的边（一跳足够，2 跳留 2.1） */
export function lessonEdgeIndex(edges = []) {
  const index = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge || !LESSON_EDGE_TYPES.includes(edge.type)) continue;
    if (!index.has(edge.from)) index.set(edge.from, []);
    index.get(edge.from).push(edge);
  }
  return index;
}

/**
 * 淘汰谁（纯函数）：库里超上限时挑出要丢的。
 *
 * 优先级（先丢前面）：
 *   1. 没有 `contradicts` 边的先丢 —— 有冲突标记的留给人工裁决；
 *   2. 最久没被命中的（`lastUsedAt`）先丢；
 *   3. 置信度低的先丢；
 *   4. 最老的先丢。
 * 返回要丢弃的条目（调用方负责落库）。
 */
export function selectEvictions(lessons = [], { max = LESSON_LIMITS.total, edges = [] } = {}) {
  const list = (Array.isArray(lessons) ? lessons : []).filter(Boolean);
  const overflow = list.length - Math.max(0, max);
  if (overflow <= 0) return [];
  const contradicted = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (edge?.type === 'contradicts') contradicted.add(edge.to);
  }
  const ranked = list.slice().sort((a, b) => {
    const ca = contradicted.has(a.id) ? 1 : 0;
    const cb = contradicted.has(b.id) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const ua = Number(a.lastUsedAt) || 0;
    const ub = Number(b.lastUsedAt) || 0;
    if (ua !== ub) return ua - ub;
    const fa = lessonConfidence(a);
    const fb = lessonConfidence(b);
    if (fa !== fb) return fa - fb;
    return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
  });
  return ranked.slice(0, overflow);
}
