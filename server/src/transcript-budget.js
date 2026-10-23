/**
 * 把一段群聊记录裁到指定的**字符预算**内（纯函数，无 IO）。
 *
 * 为什么不能只按条数截：一条真实消息可能有四千多字，30 条的上限
 * 轻松就是两万多 token，够把上下文预算挤爆、频繁触发压缩。
 * 所以这里按"总字数"倒着装：越新的消息越重要，先装新的，
 * 装不下就停，最老的那几条直接被丢掉。
 *
 * 被裁掉的消息不是无声消失 —— 返回的 `dropped` 会告诉调用方
 * "前面还有 N 条没说给你听"，让提示词里能明确写出来。
 */

/**
 * @param {Array<{text?:string}>} messages 旧→新的消息列表
 * @param {object} [opts]
 * @param {number} [opts.maxChars] 总字数预算
 * @param {number} [opts.maxItems] 条数上限（两重限制取先到者）
 * @param {(m:object)=>number} [opts.capOf] 这条最终最多展示多少字。预算按展示长度记，
 *   不按原文长度 —— 一条会被截到 1600 字的 4000 字报告，不该占掉 4000 字的预算。默认不截。
 * @param {(m:object)=>boolean} [opts.mustKeep] 必须保留的消息（派给它的活、用户的话）。
 *   先于其它消息装，不受预算和条数限制 —— 否则派活之后同事们一通长讨论，
 *   最先被挤掉的恰恰是最早的那条派活。
 * @returns {{items:Array, usedChars:number, dropped:number, leadingDropped:number}}
 *   dropped = 一共丢了几条；leadingDropped = 其中排在最前面的几条。
 *   中间跳过的条数记在后一条的 gapBefore 上（这条会拷贝一份，不改传进来的对象）。
 */
export function trimTranscript(
  messages = [],
  { maxChars = 12000, maxItems = 30, capOf = null, mustKeep = null } = {},
) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length || maxChars <= 0 || maxItems <= 0) {
    return { items: [], usedChars: 0, dropped: list.length, leadingDropped: list.length };
  }

  const lengthOf = (m) => {
    const len = String(m?.text ?? '').length;
    const cap = capOf ? Number(capOf(m)) : Infinity;
    return Number.isFinite(cap) && cap >= 0 ? Math.min(len, cap) : len;
  };
  const take = new Array(list.length).fill(false);
  let used = 0;
  let taken = 0;
  const grab = (i) => {
    take[i] = true;
    used += lengthOf(list[i]);
    taken++;
  };

  // 最新的一条永远收下（哪怕它自己就超预算），否则会出现"一条都装不下"
  grab(list.length - 1);
  if (mustKeep) {
    for (let i = 0; i < list.length - 1; i++) if (mustKeep(list[i])) grab(i);
  }
  // 其余从最新往回装：新的消息对当前决策更重要；装不下就停
  for (let i = list.length - 2; i >= 0; i--) {
    if (take[i]) continue;
    if (used >= maxChars || taken >= maxItems) break;
    if (used + lengthOf(list[i]) > maxChars) break;
    grab(i);
  }

  const items = [];
  let gap = 0;
  let leadingDropped = 0;
  for (let i = 0; i < list.length; i++) {
    if (!take[i]) {
      gap++;
      continue;
    }
    if (!items.length) leadingDropped = gap;
    items.push(gap && items.length ? { ...list[i], gapBefore: gap } : list[i]);
    gap = 0;
  }
  return { items, usedChars: used, dropped: list.length - items.length, leadingDropped };
}

/**
 * 单条消息的展示裁剪：超长消息保留头尾，中间省略。
 *
 * 为什么不一刀切尾巴：结论和数字常在**末尾**（"所以建议按 A→B→C"），
 * 只留开头会把最关键的部分砍掉。头尾各留一半更实用。
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function clipMessage(text, maxChars = 1600) {
  const s = String(text ?? '');
  if (maxChars <= 0 || s.length <= maxChars) return s;
  const keep = Math.max(0, maxChars - 20); // 给省略号留点位置
  const head = Math.ceil(keep * 0.6);
  const tail = Math.floor(keep * 0.4);
  return `${s.slice(0, head)}\n……（此处省略 ${s.length - head - tail} 字）……\n${s.slice(s.length - tail)}`;
}
