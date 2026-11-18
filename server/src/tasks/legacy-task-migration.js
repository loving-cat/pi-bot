/**
 * 旧 `TaskItem` → 历史的**判定与打标**（纯函数，无 IO、不读时钟）。
 *
 * ## 为什么需要
 *
 * 任务板早期把"每次派活"都记成一条 `TaskItem`，标题直接用模型原话：
 * 于是历史里堆着「我是**跨境运营负责人**，这个季度我盯…」「收到。先看基线和色板…」。
 * 这类条目对用户不是任务，是**对话片段**；直接删掉又不行（它们是审计线索）。
 *
 * 所以只做一件事：给它们打一个 `meta.legacyNote = true` 标签，界面默认折叠，
 * 数据原样保留、可追溯。**幂等**：已有标记的条目不会被再次修改。
 *
 * 判定刻意保守 —— 宁可漏标（用户还能看到），也不要把真正的交付记录藏起来：
 *   · 只认**已完成**（未完成的可能真在跑）；
 *   · 有交付物（`deliverables`）的一律不标；
 *   · 标题像自我介绍 / 招呼 / 纯应答，或过长（>30 字）像一段话的，才标。
 */

/** 一眼就是寒暄/应答的开口。 */
const CHITCHAT_HEAD_RE =
  /^(?:你好|您好|嗨|hi|hello|hey|在吗|在不在|收到了?|好的|好嘞|明白|了解|ok|okay|嗯|行)(?:[\s，,。.!！~～:：]|$)/i;

/** 自我介绍开头：`我是<名字>…` 后面不一定跟逗号，单独一轮。 */
const SELF_INTRO_RE = /^(?:我是|我叫)/;

/** 标题过长时按"一段话"处理（真任务标题通常很短）。 */
const LONG_TITLE = 30;

/**
 * 这条旧任务是不是"对话片段"？
 * @param {{status?: string, title?: string, deliverables?: string[], meta?: object}} task
 */
export function looksLikeChatFragment(task) {
  if (!task) return false;
  if (task.status !== 'done') return false;
  if (Array.isArray(task.deliverables) && task.deliverables.length) return false;
  // 先剥 markdown 再判：`我是**跨境运营负责人**` 里“我是”后面跟着 `**`，
  // 直接在原文上测正则会因星号不匹配。
  const title = String(task.title ?? '')
    .replace(/\*\*|__|~~|`/g, '')
    .trim();
  if (!title) return true;
  if (SELF_INTRO_RE.test(title)) return true;
  if (CHITCHAT_HEAD_RE.test(title)) return true;
  return title.length > LONG_TITLE;
}

/**
 * 挑出需要打标的条目（幂等：已带 `legacyNote` 的跳过）。
 * @returns {string[]} task id 列表
 */
export function planLegacyNotes(tasks = []) {
  const out = [];
  for (const t of tasks) {
    if (!t?.id) continue;
    if (t.meta?.legacyNote === true) continue;
    if (looksLikeChatFragment(t)) out.push(t.id);
  }
  return out;
}

/**
 * 应用打标（纯函数：返回新数组，不改入参）。
 * @param {Array} tasks 原列表
 * @param {Set<string>|string[]} ids 要打标的 id
 * @param {{at?: number}} opts
 */
export function withLegacyNotes(tasks = [], ids = [], { at = 0 } = {}) {
  const mark = ids instanceof Set ? ids : new Set(ids);
  if (!mark.size) return tasks;
  return tasks.map((t) => {
    if (!t?.id || !mark.has(t.id)) return t;
    return { ...t, meta: { ...(t.meta ?? {}), legacyNote: true, legacyNotedAt: at || null } };
  });
}
