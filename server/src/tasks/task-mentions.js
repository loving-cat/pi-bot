/**
 * 负责人正文里的 @ 提及 → 持久子任务派工计划（纯逻辑，无 IO、无时钟）。
 *
 * ## 为什么需要它
 *
 * 受管执行是**单目标**的：一次唤醒只跑一个 Bot，不像旧群聊那样把 @ 的人
 * 顺次加进队列。于是负责人在群里 @ 了成员，成员并不会被唤醒 ——
 * 账面看起来只有负责人在动。
 *
 * 这里把「@ 了谁」翻译成「要给谁建子任务」，让群里的派活重新变成持久事实。
 *
 * ## 边界
 *
 *   · 只认完整名字匹配（复用 mentions.js 的解析规则，容忍 emoji/空白）；
 *   · 不派给负责人自己、不派给不在本群的 Bot；
 *   · @all / @全体 展开成除负责人外的全部成员；
 *   · 同一个成员只派一次（同一轮里多次 @ 不重复建）；
 *   · 已有同版本、未终态的子任务 → 跳过（幂等，重放不重复建）；
 *   · 单轮上限 MAX_PER_ROUND，超出的记 skipped，不静默丢弃。
 */
import { parseMentions } from '../mentions.js';
import { filesInText } from './task-file-claims.js';

/** 单轮最多为多少个成员建子任务。 */
export const MAX_PER_ROUND = 8;

/** 单份子任务目标文本的最大长度。 */
const MAX_REQUIREMENT = 300;

const TERMINAL = new Set(['completed', 'cancelled']);

/** 从正文里截出「跟这个成员有关的那句话」，作为子任务目标的提示。 */
function excerptFor(text, name) {
  const body = String(text ?? '');
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    '@[\\s\\p{Extended_Pictographic}\\uFE0F\\u200D\\u20E3]*' + escaped + '[^\\n]*',
    'u',
  );
  const hit = body.match(pattern);
  if (hit && hit[0].trim()) return hit[0].trim().slice(0, MAX_REQUIREMENT);
  const line = body.split('\n').find((l) => l.includes(name));
  return (line ?? body).trim().slice(0, MAX_REQUIREMENT);
}

/**
 * 规划这一轮要派给哪些成员。
 *
 * @param {object} p
 * @param {string} p.text            负责人这一轮的正文
 * @param {Array<{id:string,name:string}>} p.members 部门成员（含负责人）
 * @param {string|null} p.leadBotId  负责人本人
 * @param {Array<{botId?:string,state?:string}>} [p.existingChildren] 本版本已有子任务
 * @param {number} [p.maxPerRound]
 * @returns {{targets:Array<{botId:string,name:string,excerpt:string,files:string[]}>, skipped:Array<{name:string,why:string}>}}
 */
export function planMentionDispatch({
  text,
  members = [],
  leadBotId = null,
  existingChildren = [],
  maxPerRound = MAX_PER_ROUND,
} = {}) {
  const body = String(text ?? '');
  const roster = (Array.isArray(members) ? members : [])
    .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && m.name.trim());
  if (!body.trim() || !roster.length) return { targets: [], skipped: [] };

  const { all, found } = parseMentions(body, roster, { selfId: leadBotId });
  if (!all && !found.length) return { targets: [], skipped: [] };

  const byId = new Map(roster.map((m) => [m.id, m]));
  const wanted = [];
  if (all) {
    for (const m of roster) if (m.id !== leadBotId) wanted.push(m);
  } else {
    for (const id of found) {
      const m = byId.get(id);
      if (m && m.id !== leadBotId) wanted.push(m);
    }
  }

  // 已有未终态子任务 → 跳过（重放幂等）
  const busy = new Set(
    (Array.isArray(existingChildren) ? existingChildren : [])
      .filter((c) => c && !TERMINAL.has(String(c.state ?? '')))
      .map((c) => c.botId)
      .filter(Boolean),
  );

  const targets = [];
  const skipped = [];
  const seen = new Set();
  for (const m of wanted) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (busy.has(m.id)) {
      skipped.push({ name: m.name, why: '已有未完成的子任务' });
      continue;
    }
    if (targets.length >= maxPerRound) {
      skipped.push({ name: m.name, why: '单轮派工已达上限' });
      continue;
    }
    // 优先级 = 在正文里出现的先后。负责人说「先交首批」时，
    // 他排在前面的那个成员就该先跑 —— 顺序是信息，不能丢。
    //
    // 文件占用从这个人那一句里挑：负责人写「@甲 改 app/lib/a.dart」时，
    // 那句话里的路径就是甲的占用声明；调度器据此把撞车的活排开。
    const excerpt = excerptFor(body, m.name);
    targets.push({
      botId: m.id,
      name: m.name,
      excerpt,
      files: filesInText(excerpt),
      priority: orderOf(body, m.name),
    });
  }
  return { targets, skipped };
}

/** 子任务验收条件：由负责人确认这份活做完了。 */
export function leadConfirmVerification() {
  return [{
    id: 'lead_confirm',
    kind: 'expert',
    description: '负责人确认这份活已经完成',
    spec: {},
    required: true,
  }];
}

/** 名字在正文里第一次出现的先后（用作调度优先级）。 */
function orderOf(text, name) {
  const idx = String(text ?? '').indexOf(name);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

export { excerptFor, orderOf };