/**
 * 用户习惯（preferences）—— 规格 `docs/spec-intent-and-habits-v1.md` §3。
 *
 * ## 它和经验（lessons）、记忆摘要有什么不同
 *
 * | 层 | 内容 | 谁产生 | 生效方式 |
 * |---|---|---|---|
 * | 经验 | "这种事这样做" | 复盘候选 → 用户启用 | 手工启用 |
 * | 摘要 | 聊过什么 | 自动总结 | 只进上下文 |
 * | **偏好** | **这个人的习惯** | 纠正 / 明确表达 / 重复 3 次 | **直接生效** |
 *
 * 偏好敢直接生效，是因为**说错了代价小**：最多是"下次按这个来"，
 * 用户在对话里一句就能改回来；而经验写歪会固化错误做法，必须人工兜。
 *
 * ## 为什么要有 `topic`
 *
 * "以新的为准"需要知道两条偏好**说的是不是同一件事**。靠文本相似度猜
 * （"别用 ego" vs "看视频用 ego"）猜不准，还会把无关的合并在一起。
 * 所以让复盘那一步直接给一个 `topic`（例如 `browser-choice`），
 * 同 topic 的新的覆盖旧的，旧的标 `superseded` —— 可复核，不猜。
 *
 * ## 这个文件是纯逻辑
 *
 * 不碰 store、不碰时钟（`now` 由调用方给），所以能穷举测试。
 */

/** 偏好的强度。决定它进不进提示词。 */
export const STRENGTH = Object.freeze({
  /** 用户明确说过 / 纠正过 —— 进提示词 */
  strong: 'strong',
  /** 重复观察到的（同一个选择出现 3 次）—— 只展示，不进提示词 */
  weak: 'weak',
});

/** 记录判据：只有这三种才记（规格 §3.2）。 */
export const ORIGIN = Object.freeze({
  /** 用户纠正（"不是这样"/"别…"） */
  correction: 'correction',
  /** 用户明确表达（"以后都用…"/"我习惯…"） */
  explicit: 'explicit',
  /** 同一个选择重复出现 */
  repeated: 'repeated',
});

/** 状态。`superseded` 是被新偏好覆盖掉的。 */
export const STATUS = Object.freeze({
  active: 'active',
  superseded: 'superseded',
  /** 用户删掉的 */
  retired: 'retired',
});

/** 进提示词的上限（规格 §3.3：多了会污染 prompt，还白烧 token）。 */
export const PROMPT_MAX = 5;

/** 一条偏好最长多少字（长了就不是偏好，是一段说明）。 */
export const MAX_TEXT = 160;

/**
 * 规范化一条候选偏好。
 *
 * @param {object} raw
 * @param {number} [now]
 * @returns {{ok:true, preference:object} | {ok:false, code:string, text:string}}
 */
export function normalizePreference(raw = {}, now = Date.now()) {
  const topic = String(raw.topic ?? '').trim().toLowerCase()
    // 只留安全字符，并且把首尾/连续的连字符收干净（`Browser Choice!` → `browser-choice`）
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const text = String(raw.text ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
  if (!topic) return { ok: false, code: 'no_topic', text: '偏好必须带一个 topic（它决定"新的覆盖谁"）' };
  if (!text) return { ok: false, code: 'no_text', text: '偏好没有内容' };
  const strength = String(raw.strength ?? '') === STRENGTH.strong ? STRENGTH.strong : STRENGTH.weak;
  const origin = Object.values(ORIGIN).includes(String(raw.origin ?? '')) ? String(raw.origin) : ORIGIN.explicit;
  const scope = String(raw.scope ?? '') || 'user';
  return {
    ok: true,
    preference: {
      id: String(raw.id ?? `pf_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`),
      topic,
      text,
      strength,
      origin,
      scope,
      status: STATUS.active,
      seenCount: Number.isInteger(raw.seenCount) && raw.seenCount > 0 ? raw.seenCount : 1,
      createdAt: Number(raw.createdAt) || now,
      lastSeenAt: now,
      /** 证据（原话），审计用；可以为空 */
      evidence: String(raw.evidence ?? '').slice(0, 200),
    },
  };
}

/**
 * 把一条新偏好并进列表。
 *
 * 三件事：
 *   1. 同 topic 的旧偏好 → 标 `superseded`（以新的为准，不让两条在 prompt 里打架）；
 *   2. 文本完全相同 → 不新增，只加 `seenCount` 并把强度取高的（重复观察会升级）；
 *   3. 文本不同但 topic 相同 → 新的覆盖旧的。
 *
 * @param {Array} list 现有偏好
 * @param {object} candidate `normalizePreference` 的产物
 * @param {number} [now]
 * @returns {{list:object[], added:object|null, superseded:string[], promoted:boolean}}
 */
export function mergePreference(list = [], candidate, now = Date.now()) {
  const items = (Array.isArray(list) ? list : []).map((p) => ({ ...p }));
  if (!candidate?.topic || !candidate?.text) return { list: items, added: null, superseded: [], promoted: false };

  // ① 文本完全相同：只加次数（重复 3 次可以把 weak 升成 strong）
  const same = items.find(
    (p) => p.topic === candidate.topic && p.text === candidate.text && p.status === STATUS.active,
  );
  if (same) {
    same.seenCount = (Number(same.seenCount) || 1) + 1;
    same.lastSeenAt = now;
    let promoted = false;
    if (same.strength !== STRENGTH.strong && same.seenCount >= 3) {
      same.strength = STRENGTH.strong;
      promoted = true;
    }
    return { list: items, added: same, superseded: [], promoted };
  }

  // ② 同 topic 的其它条目 → superseded
  const superseded = [];
  for (const p of items) {
    if (p.topic !== candidate.topic) continue;
    if (p.status !== STATUS.active) continue;
    p.status = STATUS.superseded;
    p.supersededAt = now;
    superseded.push(String(p.id));
  }

  const fresh = { ...candidate, lastSeenAt: now };
  items.push(fresh);
  return { list: items, added: fresh, superseded, promoted: false };
}

/**
 * 挑出要进提示词的那些（规格 §3.3）。
 *
 * 只放 `strong` + `active`，按最近出现排序，最多 `max` 条。
 * **weak 一条都不进** —— 它们是"观察到三次"的猜测，还没经过用户确认。
 *
 * @param {Array} list
 * @param {object} [opts]
 * @param {number} [opts.max]
 * @returns {object[]}
 */
export function pickPromptPreferences(list = [], { max = PROMPT_MAX } = {}) {
  const limit = Math.max(0, Math.min(Number(max) || PROMPT_MAX, PROMPT_MAX));
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && p.status === STATUS.active && p.strength === STRENGTH.strong && p.text)
    .sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0))
    .slice(0, limit);
}

/**
 * 拼成系统提示里的那几行（调用方直接 spread 进 prompt）。
 *
 * 空列表返回 `[]` —— 没有偏好时**一个字都不加**（不占 token）。
 *
 * @param {Array} list
 * @param {object} [opts]
 * @returns {string[]}
 */
export function preferencesPromptLines(list = [], { max = PROMPT_MAX } = {}) {
  const picked = pickPromptPreferences(list, { max });
  if (!picked.length) return [];
  return [
    '【用户的习惯】下面这些是这个人明确表达过或纠正过你的，**照做**；'
      + '和你的默认做法冲突时，以这里为准：',
    ...picked.map((p, i) => `${i + 1}. ${p.text}`),
  ];
}

/**
 * 从复盘模型的输出里取偏好条目（严格校验，宁缺勿错）。
 *
 * 复盘那一步会同时产出经验和偏好；这里只负责把偏好挑出来并规范化。
 *
 * @param {object} parsed 复盘输出（已 JSON.parse）
 * @param {number} [now]
 * @returns {object[]} 规范化后的偏好候选
 */
export function preferencesFromReflect(parsed, now = Date.now()) {
  const raw = Array.isArray(parsed?.preferences) ? parsed.preferences : [];
  const out = [];
  for (const item of raw.slice(0, 3)) {
    const n = normalizePreference(item, now);
    if (!n.ok) continue;
    // ★ 没有证据的推断不记（沿用 lesson-reflect 的规矩：编证据比没有更糟）
    if (item?.evidence !== undefined && !String(item.evidence ?? '').trim()) continue;
    out.push(n.preference);
  }
  return out;
}
