/**
 * 技能库（skill library）的规范化与匹配 —— 纯函数，无 IO。
 *
 * 为什么要单独一层：
 *   skill 现在有两处来源（用户在设置里手填、导入 SKILL.md 文件），
 *   还有一处消费方（按任务挑几条拼进提示词）。三处的字段规则必须一致，
 *   否则会出现"存进去的能显示、但匹配不上"这种难查的问题。
 *
 * 与 bot 自带 skills 的区别：
 *   bot.skills 是"这个 bot 自己会的事"（存在 bot 上，直接全量进提示词）；
 *   这里是**全局库**，所有 bot 共享，按需挑几条注入 —— 库可以很大，
 *   但每个 bot 每轮只拿到相关的那几条，不撑上下文。
 */

/** 单条技能各字段的长度上限（这些数字会进提示词，必须收口） */
export const SKILL_LIMITS = {
  title: 80,
  summary: 200,
  howto: 4000,
  tags: 8,
  tagLength: 20,
  /** 库里最多存多少条 */
  total: 200,
};

/**
 * 文本里有没有"编码损坏"的痕迹。
 *
 * `U+FFFD`（替换字符）是解码失败时产生的：一个本来是中文的字节流，
 * 被当成别的编码解过一遍再编码回来，就会变成一串 `�`。
 * 这种内容一旦入库，界面上显示的就是乱码，而且**用户自己也没法修**
 * （他看到的就是问号，不知道该填什么），只能删了重来。
 *
 * 所以宁可当场拒收并说清原因，也不要把垃圾存进去。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasBrokenEncoding(text) {
  return /�/.test(String(text ?? ''));
}

/**
 * 规范化单条技能。
 *
 * @param {object} raw
 * @returns {{id:string,title:string,summary:string,howto:string,tags:string[],enabled:boolean,createdAt:number,updatedAt:number}|null}
 *          标题为空时返回 null（无标题的条目没有意义，也没法让人挑）
 */
export function normalizeSkill(raw = {}, now = Date.now()) {
  const title = String(raw?.title ?? '').trim().slice(0, SKILL_LIMITS.title);
  if (!title) return null;
  // 编码坏掉的内容不收：存进去只会变成界面上的乱码，用户还改不回来
  if (hasBrokenEncoding(title) || hasBrokenEncoding(raw?.howto) || hasBrokenEncoding(raw?.summary)) {
    return null;
  }

  const tags = Array.isArray(raw?.tags)
    ? [...new Set(
        raw.tags
          .map((t) => String(t ?? '').trim().slice(0, SKILL_LIMITS.tagLength))
          .filter(Boolean),
      )].slice(0, SKILL_LIMITS.tags)
    : [];

  return {
    id: String(raw?.id ?? '').trim() || `sk_${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    title,
    summary: String(raw?.summary ?? '').trim().slice(0, SKILL_LIMITS.summary),
    howto: String(raw?.howto ?? '').trim().slice(0, SKILL_LIMITS.howto),
    tags,
    // 默认启用：用户加进来就是打算用的，要停用得显式关
    enabled: raw?.enabled !== false,
    createdAt: Number(raw?.createdAt) || now,
    updatedAt: Number(raw?.updatedAt) || now,
  };
}

/**
 * 校验一条技能能否入库，返回**人话原因**（能入库返回 null）。
 *
 * 与 normalizeSkill 的分工：那个只负责"整理数据形状"，这个负责"告诉用户为什么不行"。
 * 界面和工具都需要一句能直接显示的话，不然用户只看到保存失败。
 *
 * @param {object} raw
 * @returns {string|null}
 */
export function skillRejectReason(raw = {}) {
  const title = String(raw?.title ?? '').trim();
  if (!title) return '技能需要一个标题';
  if (hasBrokenEncoding(title) || hasBrokenEncoding(raw?.howto) || hasBrokenEncoding(raw?.summary)) {
    return '内容里有乱码（编码损坏），请重新输入或换个方式导入';
  }
  return null;
}

/**
 * 规范化整个库（去重、限量、保持顺序）。
 * @param {Array} list
 * @param {number} [now]
 * @returns {Array}
 */
export function normalizeSkillList(list = [], now = Date.now()) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const skill = normalizeSkill(raw, now);
    if (!skill) continue;
    // 同 id 只留第一条；同标题也去重（用户重复导入同一份 SKILL.md 很常见）
    const key = skill.title.toLowerCase();
    if (seen.has(skill.id) || seen.has(key)) continue;
    seen.add(skill.id);
    seen.add(key);
    out.push(skill);
    if (out.length >= SKILL_LIMITS.total) break;
  }
  return out;
}

/**
 * 从 `SKILL.md` 的正文里解析出技能。
 *
 * pi 的 skill 格式是带 frontmatter 的 markdown：
 *   ---
 *   name: 名字
 *   description: 一句话说明
 *   ---
 *   # 正文（做法）
 *
 * 解析失败不抛错：拿不到 frontmatter 就用文件名当标题、整段当做法 ——
 * 用户导入一份普通 markdown 也应该能用，不该因为格式不对就拒绝。
 *
 * @param {string} text 文件内容
 * @param {string} [fileName] 文件名（没有 frontmatter 时当标题用）
 * @returns {{title:string,summary:string,howto:string,tags:string[]}|null}
 */
export function parseSkillMarkdown(text, fileName = '') {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;

  let body = raw;
  let name = '';
  let description = '';
  let tags = [];

  const fm = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    const header = fm[1];
    body = fm[2];
    for (const line of header.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      // 去掉包裹引号
      const value = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (key === 'name') name = value;
      else if (key === 'description') description = value;
      else if (key === 'tags') {
        tags = value
          .replace(/^\[|\]$/g, '')
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
  }

  // 标题优先级：frontmatter 的 name > 正文第一个 # 标题 > 文件名
  let title = name;
  if (!title) {
    const h1 = body.match(/^\s*#\s+(.+)$/m);
    if (h1) title = h1[1].trim();
  }
  if (!title && fileName) {
    title = fileName.replace(/\.(md|markdown|txt)$/i, '').trim();
  }
  if (!title) return null;

  const howto = body.trim();
  if (!howto) return null;

  return {
    title,
    summary: description || howto.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, SKILL_LIMITS.summary) || '',
    howto,
    tags,
  };
}

/**
 * 按当前任务挑出相关的技能（给提示词用）。
 *
 * 打分规则（全都很朴素，可解释）：
 *   · 标题命中任务里的词 → +3
 *   · 标签命中 → +2
 *   · 摘要/做法里命中 → +1
 *   · 明确停用的不参与
 * 分数为 0 的不要（宁可不给，也别塞一堆无关的撑上下文）。
 *
 * @param {Array} skills 技能库
 * @param {string} task 当前任务文本（用户这句话 / 派活内容）
 * @param {object} [opts]
 * @param {number} [opts.max] 最多给几条
 * @param {number} [opts.minScore] 多少分算相关
 * @returns {Array}
 */
export function selectSkillsFor(skills = [], task = '', { max = 5, minScore = 1 } = {}) {
  const text = String(task ?? '').toLowerCase();
  if (!text.trim()) return [];

  const scored = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || skill.enabled === false) continue;
    let score = 0;

    // 中文没有天然分词：按 2 字以上的连续片段做包含匹配即可，
    // 过度分词反而会引入噪声。
    for (const word of splitWords(skill.title)) {
      if (text.includes(word)) score += 3;
    }
    for (const tag of skill.tags ?? []) {
      const t = String(tag).toLowerCase();
      if (t && text.includes(t)) score += 2;
    }
    for (const word of splitWords(skill.summary)) {
      if (text.includes(word)) score += 1;
    }
    for (const word of splitWords(skill.howto.slice(0, 800))) {
      if (text.includes(word)) score += 1;
    }

    if (score >= minScore) scored.push({ skill, score });
  }

  // 分高的在前；同分保持原有顺序（稳定排序，结果可预期）
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.skill);
}

/**
 * 把一段文字切成可匹配的词。
 *
 * 中文按"2~4 字滑窗"取片段，英文数字按词切 —— 只为做包含匹配，
 * 不追求语言学正确。单字不取（"的"、"了"会命中一切）。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitWords(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  // 英文/数字词
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  // 中文连续片段：滑窗取 2~4 字
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0];
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= seg.length; i++) {
        out.add(seg.slice(i, i + len));
      }
    }
  }
  return [...out];
}

/**
 * 生成给提示词的技能段落（没有命中就返回空数组，调用方直接展开）。
 *
 * @param {Array} picked selectSkillsFor 的结果
 * @returns {string[]}
 */
export function skillsPromptLines(picked = []) {
  if (!Array.isArray(picked) || !picked.length) return [];
  return [
    '【可用的做法（技能库）】下面这些是用户整理过的标准做法，遇到同类事情照做，不要重新摸索：',
    ...picked.map((s, i) => {
      const head = s.summary ? `${s.title}（${s.summary}）` : s.title;
      return `${i + 1}. ${head}\n${String(s.howto ?? '').trim()}`;
    }),
  ];
}
