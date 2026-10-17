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
 * @returns {{items:Array, usedChars:number, dropped:number}} dropped = 前面丢掉几条
 */
export function trimTranscript(messages = [], { maxChars = 12000, maxItems = 30 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length || maxChars <= 0 || maxItems <= 0) {
    return { items: [], usedChars: 0, dropped: list.length };
  }

  const picked = [];
  let used = 0;
  // 从最新往回装：新的消息对当前决策更重要
  for (let i = list.length - 1; i >= 0; i--) {
    if (picked.length >= maxItems) break;
    const text = String(list[i]?.text ?? '');
    // 第一条永远收下（哪怕它自己就超预算），否则会出现"一条都装不下"
    if (picked.length > 0 && used + text.length > maxChars) break;
    picked.push(list[i]);
    used += text.length;
    if (used >= maxChars) break;
  }

  picked.reverse();
  return { items: picked, usedChars: used, dropped: list.length - picked.length };
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
