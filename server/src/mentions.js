/**
 * @提及解析 —— 整个组织架构的"调度信号"。
 *
 * **写 @某某 就是把发言权交给它**（它接着说话 / 干你派给它的活），
 * 不带 @ 只是提到名字，不触发发言。
 *   @all / @全体 / @所有人  → 叫上除自己外的全部成员
 */

/** 名字里的正则特殊字符转义 */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 匹配 "@名字"，允许 @ 和名字之间夹 emoji / 空白 / 零宽字符。
 * bot 很爱写 `@🎨UI设计师`、`@ UI设计师` 这种。
 */
function mentionPattern(name) {
  return new RegExp(`@[\\s\\p{Extended_Pictographic}\\uFE0F\\u200D\\u20E3]*${escapeRe(name)}`, 'gu');
}

/**
 * @param {string} text
 * @param {Array<{id:string,name:string}>} members
 * @param {{selfId?:string|null}} options
 * @returns {{all:boolean, found:string[]}}
 */
export function parseMentions(text, members, { selfId = null } = {}) {
  const body = String(text ?? '');
  const found = new Set();
  let all = false;

  if (/@\s*(all|All|ALL|全体|所有人|大家|全员)/.test(body)) all = true;

  // 长名字优先，避免 "@后端" 把 "@后端工程师" 也吃掉
  const sorted = [...members]
    .filter((m) => m && m.name && m.id !== selfId)
    .sort((a, b) => b.name.length - a.name.length);

  let rest = body;
  for (const member of sorted) {
    const re = mentionPattern(member.name);
    if (re.test(rest)) {
      found.add(member.id);
      // 把已匹配的部分抹掉，防止短名字再匹配到同一处
      rest = rest.replace(mentionPattern(member.name), '\u0000');
    }
  }

  return { all, found: [...found] };
}

/** 给模型看的"成员花名册"一行 */
export function rosterLine(bot, { isLead = false } = {}) {
  const role = isLead ? '部门老大' : '成员';
  const duty = String(bot.persona ?? '')
    .split('\n')
    .find((l) => l.trim())
    ?.slice(0, 70) ?? '';
  return `${bot.emoji ?? ''}${bot.name}（${role}${duty ? `：${duty}` : ''}）`;
}
