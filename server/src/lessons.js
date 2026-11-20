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
    modelFamily: normalizeModelFamily(raw.modelFamily),
    byFamily: normalizeFamilyStats(raw.byFamily),
  };
  // contentHash 是**纯派生值**：每次规范化都现算。信任传入值会让改完文案的哈希永远停在旧值。
  out.contentHash = lessonContentHash(out);
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
    const hashKey = lesson.contentHash ? `${lesson.roomId}\u0000${lesson.contentHash}` : '';
    if (hashKey && seenHashes.has(hashKey)) continue;
    seen.add(key);
    if (hashKey) seenHashes.add(hashKey);
    out.push(lesson);
    if (out.length >= LESSON_LIMITS.total) break;
  }
  return out;
}

/**
 * 打分权重（改这里 = 改筛选口径，别在别处写魔法数字）。
 *
 * 前四项是 1.x 就有的；后四项是 SIM-Lite（2.0）的**跨模型去偏**与**关系边**：
 *   · `sameFamily`：当前模型族在这条经验上**赢过且不亏** → 加分；
 *   · `lostOnFamily`：本族打输过（`fail > win`）→ 扣分。⚠️ 不能因为"打过"就加分，
 *     0 胜 3 负 的经验正是最该往后排的那种；
 *   · `untestedFamily`：经验有归因，但当前族没战果 → 减分（不排除，界面会标「未在同模型验证」）；
 *   · `generalizesHop`：一跳 `generalizes`（特化条命中任务）→ 泛化条 +1，**单条上限 +1**。
 * `contradicts` / 被 `supersedes` 取代都不是减分，是**直接排除**。
 */
export const LESSON_SCORING = Object.freeze({
  cueHit: 3,
  lessonHit: 1,
  sameRoom: 1,
  sameFamily: 2,
  untestedFamily: -1,
  lostOnFamily: -2,
  generalizesHop: 1,
  minScore: 3,
});

/**
 * 词面相关性（cue 命中 + lesson 命中）；`0` = 跟当前任务毫无关系。
 *
 * ★ 这是**相关性闸门**的输入：只有它 > 0 的经验才允许进入候选。
 * 否则 `sameRoom(+1) + sameFamily(+2) = 3 >= minScore` 会让同房间同模型下
 * **所有完全无关的历史经验**都被塞进提示词 —— 直接违背本文件第一原则
 * 「没有相关性就不给 —— 宁可不给，也别塞一堆无关的经验把提示词撑爆」。
 */
export function lessonLexicalScore(item, task) {
  const text = String(task ?? '').toLowerCase();
  if (!item || !text.trim()) return 0;
  let score = 0;
  for (const word of splitWords(item.cue)) {
    if (text.includes(word)) score += LESSON_SCORING.cueHit;
  }
  for (const word of splitWords(item.lesson)) {
    if (text.includes(word)) score += LESSON_SCORING.lessonHit;
  }
  return score;
}

/**
 * 这条经验是否被关系边排除（`contradicts` 双向 / 被 `supersedes` 取代）。
 *
 * 抽出来是因为两处都要用：打分时排除它自己，以及算 `relatedIds` 时**不许**
 * 让一条被否决/未启用的特化条给泛化条送分。
 */
export function lessonExcludedByEdges(item, edgeIndex) {
  const links = edgeIndex?.get(item?.id) ?? null;
  if (!links) return false;
  if ([...links.incoming, ...links.outgoing].some((edge) => edge.type === 'contradicts')) return true;
  return links.incoming.some((edge) => edge.type === 'supersedes');
}

/**
 * 按当前任务给一条经验打分（纯函数；不参与候选时返回 null）。
 *
 * 【SIM-Lite】`modelFamily` / `edgeIndex` / `relatedIds` 全是可选的：都不传时
 * 行为与 1.x **完全一致** —— 这是 Phase 0 的硬要求。
 *
 * 排除（返回 null）的三种情形：
 *   1. 非 `active`（候选只能在界面上看）；
 *   2. `contradicts` 边（**双向**：不管写在 from 还是 to 上，两条都不进候选）；
 *   3. 被更晚的经验 `supersedes` 取代（旧条只留在库里供审计）。
 *
 * @param {object} item 经验
 * @param {string} task 当前任务文本
 * @param {object} [opts]
 * @param {string} [opts.roomId] 当前房间
 * @param {string} [opts.modelFamily] 当前模型族
 * @param {Map} [opts.edgeIndex] `lessonEdgeIndex()` 的结果
 * @param {Set<string>} [opts.relatedIds] 与任务词面相关的经验 id 集合（`generalizes` 传导要用）
 * @returns {number|null}
 */
export function lessonScore(
  item,
  task,
  { roomId = '', modelFamily = '', edgeIndex = null, relatedIds = null } = {},
) {
  if (!item || item.status !== 'active') return null;
  const text = String(task ?? '').toLowerCase();
  if (!text.trim()) return null;

  const lexical = lessonLexicalScore(item, text);
  let score = lexical;
  if (roomId && item.roomId && item.roomId === roomId) score += LESSON_SCORING.sameRoom;

  if (lessonExcludedByEdges(item, edgeIndex)) return null;
  const links = edgeIndex?.get(item.id) ?? null;
  let hopBonus = 0;
  if (links && relatedIds) {
    // 泛化条只有在「特化条真的命中当前任务」时才 +1，且单条上限 +1（挂十条边也不叠加）
    if (links.incoming.some((edge) => edge.type === 'generalizes' && relatedIds.has(edge.from))) {
      hopBonus = LESSON_SCORING.generalizesHop;
    }
  }
  score += hopBonus;

  // ★ 相关性闸门：词面 0 分、且没有"特化邻居命中"，一律不给 —— 房间分/族分不许无中生有
  if (lexical <= 0 && hopBonus <= 0) return null;

  // `unknown` = 1.x 沉淀的老经验，没有归因信息：既不享受同族加成，也不背"未验证"扣分
  const declaredFamily = item.modelFamily && item.modelFamily !== UNKNOWN_MODEL_FAMILY ? item.modelFamily : '';
  if (modelFamily) {
    const stats = item.byFamily?.[modelFamily] ?? null;
    const win = stats?.win ?? 0;
    const fail = stats?.fail ?? 0;
    if (win > 0 && win >= fail) score += LESSON_SCORING.sameFamily;
    else if (fail > win) score += LESSON_SCORING.lostOnFamily;
    else if (declaredFamily === modelFamily) score += LESSON_SCORING.sameFamily;
    else if (declaredFamily) score += LESSON_SCORING.untestedFamily;
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

  const list = Array.isArray(lessons) ? lessons : [];
  const edgeIndex = edges?.length ? lessonEdgeIndex(edges) : null;
  // `generalizes` 传导要问"特化条是否真的命中任务"，所以先算一遍词面相关性。
  // ★ 只认「已启用 + 未被排除 + 词面分达到有效门槛」的特化条：
  //   否则一条未批准/被否决的候选只要碰中 1 个字，就能给泛化条送 +1 绕过相关性闸门。
  const relatedIds = edgeIndex
    ? new Set(
        list
          .filter(
            (item) =>
              item &&
              item.status === 'active' &&
              lessonLexicalScore(item, text) >= LESSON_SCORING.cueHit &&
              !lessonExcludedByEdges(item, edgeIndex),
          )
          .map((item) => item.id),
      )
    : null;
  const scored = [];
  for (const item of list) {
    const score = lessonScore(item, task, { roomId, modelFamily, edgeIndex, relatedIds });
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
//   3. 关系边和代码一样是"可审"的：类型只有 4 种，方向语义写死，越界一律拒绝。
//
// ## 边的方向语义（**唯一权威定义**，别处不许各写一套）
//
//   supersedes  from=新, to=旧      → 旧条（入边 to）不进候选
//   contradicts from/to 任意方向     → 两条**双向**排除，留给人工裁决
//   generalizes from=特化, to=泛化   → 特化条命中任务时，泛化条 +1（单条上限 +1）
//   requires    from 依赖 to         → 只作附带上下文，不影响排序
//
// `from` 允许两个哨兵：`user`（用户在界面上的否决）与 `system`（系统自动降级）。
// 没有哨兵的话，单条经验的"记错了"根本写不出合法的 `contradicts` 边
// —— 它不能自己指向自己。
// ===========================================================================

/** 模型族的封闭词表：跨模型去偏只在这里面归因，避免拼写漂移成十几个"族" */
export const MODEL_FAMILIES = Object.freeze([
  'glm', 'deepseek', 'kimi', 'qwen', 'gpt', 'claude', 'gemini', 'other',
]);

/** 没有任何归因信息时的族名（1.x 沉淀的老经验都是这个） */
export const UNKNOWN_MODEL_FAMILY = 'unknown';

/**
 * provider / model 名 → 族的猜测规则。
 *
 * ★ 分两层，**先具体后宽泛**：
 *   第一层是不会有歧义的模型族名（glm / deepseek / kimi / qwen / claude / gemini）；
 *   第二层是宽泛的厂商名（gpt / openai / azure / o1-o4）。
 * 为什么必须分层：调用方常写 `resolveModelFamily('openai-compat', 'deepseek-chat')`，
 * 一层搞的话 provider 里的 `openai` 会先命中，把 deepseek 的模型判成 gpt 族。
 *
 * `nvidia` / `sensenova` 这类是**托管平台**（同一个平台下托管着多家模型），
 * 不能当族 —— 认不出就落 `other`，宁可少归因也不归错因。
 */
const FAMILY_HINTS_SPECIFIC = [
  [/glm|zhipu|chatglm/i, 'glm'],
  [/deepseek/i, 'deepseek'],
  [/kimi|moonshot/i, 'kimi'],
  [/qwen|tongyi|dashscope/i, 'qwen'],
  [/claude|anthropic/i, 'claude'],
  [/gemini|vertex/i, 'gemini'],
];
const FAMILY_HINTS_BROAD = [
  [/\bchatgpt\b|\bgpt|openai|azure|\bo[1-4](?:-|$)/i, 'gpt'],
];

/**
 * 从 provider / model 名推模型族（纯字符串函数）。
 *
 * 传入多个提示时**先在所有提示里找具体族名**，都找不到才回退到宽泛厂商名；
 * 一个都没命中 → `other`；一个提示都没给 → `unknown`（= 这条经验没有归因信息）。
 */
export function resolveModelFamily(...hints) {
  const list = hints.flat().filter((h) => typeof h === 'string' && h.trim());
  if (!list.length) return UNKNOWN_MODEL_FAMILY;
  for (const rules of [FAMILY_HINTS_SPECIFIC, FAMILY_HINTS_BROAD]) {
    for (const hint of list) {
      for (const [re, family] of rules) {
        if (re.test(hint)) return family;
      }
    }
  }
  return 'other';
}

/**
 * 从「模型对象」推族（复盘器、注入点直接用这个，别各处自己拼字段名）。
 *
 * pi 的模型对象字段是 `{ provider, id, name }`；我们多试几个名字，
 * 是因为不同来源（模型组菜单 / SDK 注入 / 测试桩）字段不完全一样。
 */
export function resolveModelFamilyForModel(model) {
  if (!model) return UNKNOWN_MODEL_FAMILY;
  return resolveModelFamily(model.provider, model.id, model.name, model.slug, model.model);
}

/**
 * 族名归一：先认词表里的正式名，再拿猜测规则兜一次（`deepseek-v3` → `deepseek`），
 * 都不认就落 `other` —— 防拼写漂移把同一个族拆成十几个。
 */
export function normalizeModelFamily(raw) {
  const name = str(raw, LESSON_LIMITS.family).toLowerCase();
  if (!name) return UNKNOWN_MODEL_FAMILY;
  if (name === UNKNOWN_MODEL_FAMILY) return UNKNOWN_MODEL_FAMILY;
  if (MODEL_FAMILIES.includes(name)) return name;
  const guessed = resolveModelFamily(name);
  return guessed === UNKNOWN_MODEL_FAMILY ? 'other' : guessed;
}

const toCount = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1_000_000, Math.floor(n));
};

/** 规范化 `byFamily`：只留计数、最多 `byFamilyKeys` 个族、族名按封闭词表归一 */
export function normalizeFamilyStats(raw = {}) {
  const out = {};
  for (const [name, stats] of Object.entries(raw ?? {})) {
    // key 必须走封闭词表：否则 `deepseek-v3` 与 `deepseek-chat` 会成为两个"族"，
    // 打分查 `byFamily['deepseek']` 查不到，置信度的 coverage 还会被虚算成 2 个族。
    const family = normalizeModelFamily(name);
    if (family === UNKNOWN_MODEL_FAMILY) continue; // 没有归因的键不占位
    const add = { hit: toCount(stats?.hit), win: toCount(stats?.win), fail: toCount(stats?.fail) };
    const cur = out[family];
    if (cur) {
      cur.hit += add.hit;
      cur.win += add.win;
      cur.fail += add.fail;
      continue;
    }
    if (Object.keys(out).length >= LESSON_LIMITS.byFamilyKeys) continue;
    out[family] = add;
  }
  return out;
}

/**
 * 置信度（0~0.95，纯派生、可重算、不必落库）。
 *
 * 标尺是按路线图 §5.4 的晋升门槛反推的 —— **必须让门槛够得着**：
 *   「跨 ≥2 族 + 样本 ≥5 + win:fail ≥ 3:1 + verdict=helped」要稳稳 ≥ 0.80。
 *
 *     0.25×base(0.7) + 0.45×ratio(0.75) + 0.15×volume(1) + 0.15×coverage(1)
 *   = 0.175 + 0.3375 + 0.15 + 0.15 = **0.8125** ✅
 *
 * 单族同条件只有 coverage=0.5 → 0.7375 < 0.80 ✅（单族不许升稳定经验，这正是设计意图）
 * 全胜（ratio≈1）且两族 → ≈0.92，仍低于 0.95 上限（永远不给"绝对确定"）。
 *
 * ⚠️ 旧版把 `helped` 的先验设成 0.5、权重 0.4/0.3/0.15/0.15，数学上界正好 0.800，
 * 只要历史上出现过 1 次 fail 就再也到不了 0.80 —— 门槛永远不可达。别改回去。
 *
 * `hurt`（避坑经验）的 base 与 `helped` 同为 0.7：**"别这么做"是高价值经验**，
 * 它和"这么做"一样需要跨族验证才能升稳定；但在没有验证时它不该比正向经验低一大截。
 */
export function lessonConfidence(item = {}) {
  const stats = Object.values(normalizeFamilyStats(item.byFamily));
  const win = stats.reduce((n, s) => n + s.win, 0);
  const fail = stats.reduce((n, s) => n + s.fail, 0);
  const trials = win + fail;
  const validatedFamilies = stats.filter((s) => s.win + s.fail > 0).length;
  const base =
    item.verdict === 'helped' || item.verdict === 'hurt'
      ? 0.7
      : item.verdict === 'no_effect'
        ? 0.2
        : 0.35;
  const ratio = trials ? win / trials : 0.5;
  const volume = Math.min(1, trials / 5);
  const coverage = Math.min(1, validatedFamilies / 2);
  const mixed = base * 0.25 + ratio * 0.45 + volume * 0.15 + coverage * 0.15;
  return Math.round(Math.min(0.95, Math.max(0, mixed)) * 1000) / 1000;
}

/**
 * 去重键：`cue + lesson` 归一化后的 sha256 前 32 位。
 *
 * 只用来判断"是不是同一条经验"，不参与任何安全判定（不是签名也不是 MAC）。
 * 归一化把空白**全部去掉**（中文一行里空格是排版噪声），否则 `按模块   拆`
 * 与 `按模块拆` 会算出两个哈希，去重直接失效。
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

/** 允许出现在 `from` 的哨兵：用户否决 / 系统降级（它们不是经验条目） */
export const LESSON_EDGE_SENTINELS = Object.freeze(['user', 'system']);

/** 校验一条边能不能入库，返回人话原因（能入库返回 null） */
export function lessonEdgeRejectReason(raw = {}) {
  const from = str(raw.from, 64);
  const to = str(raw.to, 64);
  if (!from || !to) return '边要写清 from / to（哪条指向哪条）';
  if (from === to) return '不能自己连自己（用户否决请用 from: "user"）';
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
 *
 * 哨兵（`user` / `system`）的 `from` **不算悬空** —— 否则用户的单条否决永远写不进去。
 * 超上限时保留**最后写入**的边（新证据优先）。
 */
export function normalizeLessonEdgeList(list = [], { knownIds = null, now = Date.now() } = {}) {
  const known = knownIds instanceof Set ? knownIds : Array.isArray(knownIds) ? new Set(knownIds) : null;
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const edge = normalizeLessonEdge(item, now);
    if (!edge) continue;
    if (known) {
      if (!known.has(edge.to)) continue; // 目标必须是真实经验
      if (!known.has(edge.from) && !LESSON_EDGE_SENTINELS.includes(edge.from)) continue;
    }
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out.length > LESSON_LIMITS.edges ? out.slice(out.length - LESSON_LIMITS.edges) : out;
}

/**
 * 边索引：`id → { incoming, outgoing }`。
 *
 * ★ 方向必须双向可查：`contradicts` 要对两条都排除，`supersedes` / `generalizes`
 * 要按**入边**判（旧条、泛化条都是被指向的那一方）。只建 `from → edges` 的话，
 * `{from: new, to: old, type:'contradicts'}` 会排除 new 却放过 old —— 正好反了。
 */
export function lessonEdgeIndex(edges = []) {
  const index = new Map();
  const slot = (id) => {
    if (!index.has(id)) index.set(id, { incoming: [], outgoing: [] });
    return index.get(id);
  };
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge || !LESSON_EDGE_TYPES.includes(edge.type)) continue;
    slot(edge.from).outgoing.push(edge);
    slot(edge.to).incoming.push(edge);
  }
  return index;
}

/**
 * 淘汰谁（纯函数）：库里超上限时挑出要丢的。
 *
 * 优先级（先丢前面）：
 *   1. `archived` → `candidate` → `active`（**绝不能先丢 active**，那是唯一会注入的档）；
 *   2. 没有 `contradicts` 边的先丢 —— 有冲突标记的留给人工裁决；
 *   3. 最久没被命中的（`lastUsedAt`）先丢；
 *   4. 置信度低的先丢；
 *   5. 最老的先丢。
 * 返回要丢弃的条目（调用方负责落库）。
 */
export function selectEvictions(lessons = [], { max = LESSON_LIMITS.total, edges = [] } = {}) {
  const list = (Array.isArray(lessons) ? lessons : []).filter(Boolean);
  const overflow = list.length - Math.max(0, max);
  if (overflow <= 0) return [];
  const contradicted = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (edge?.type !== 'contradicts') continue;
    if (edge.to) contradicted.add(edge.to);
    if (edge.from) contradicted.add(edge.from);
  }
  const tierOf = (item) => (item.status === 'archived' ? 0 : item.status === 'active' ? 2 : 1);
  const ranked = list.slice().sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return ta - tb;
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
