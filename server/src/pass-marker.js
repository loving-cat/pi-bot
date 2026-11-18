/**
 * `[PASS]` 标记的剥离（纯字符串处理，无 IO）。
 *
 * ## 为什么需要这一层
 *
 * 群聊里 bot 之间有个约定：这一轮不该我出手，就只回 `[PASS]`，编排层看到
 * 整条都是 PASS 就把消息删掉 —— 用户看不到。
 *
 * 但模型经常把标记**贴在报告末尾**：
 *
 *   报告写完了…（几百字）
 *   [PASS]（不需要接，直接回答进度）
 *
 * 这时整条消息不是 PASS（里面有正事），编排层不能删，于是这行内部协议
 * 就漏到了用户面前 —— 截图里那条「[PASS]（不需要接，直接回答进度）」
 * 就是这么来的。
 *
 * 规则（刻意保守）：
 *   · 只剥**结尾**的 PASS，正文里的不动（那可能是引用别人的话）；
 *   · 允许后面跟一个括号说明（中英文括号都算）；
 *   · 如果整条本来就是 PASS，原样返回 —— 这是"纯 PASS"，交给编排层删消息，
 *     剥成空串反而会让它变成一条空白消息。
 */

/** 结尾的 `[PASS]` + 可选的括号说明。 */
const TRAILING_PASS_RE = /(?:\s*[[【]\s*PASS\s*[\]】]\s*(?:[（(][^（()）]*[)）])?\s*)$/i;

/** 整条消息是不是「纯 PASS」（可以有括号说明和空白）。 */
export function isBarePass(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return false;
  return /^[[【]?\s*PASS\s*[\]】]?$/i.test(clean) ||
    /^[[【]\s*PASS\s*[\]】]\s*(?:[（(][^（()）]*[)）])?$/i.test(clean);
}

/**
 * 剥掉结尾的 PASS 标记。
 *
 * @param {string} text 模型原话
 * @returns {string} 去掉结尾标记后的正文（没有标记就原样返回）
 */
export function stripTrailingPassMarker(text) {
  const clean = String(text ?? '');
  if (!clean.trim()) return clean;
  if (isBarePass(clean)) return clean;
  const match = clean.match(TRAILING_PASS_RE);
  if (!match) return clean;
  const head = clean.slice(0, match.index).trimEnd();
  // 只剥到还剩正文为止；剥完是空的说明本来就是标记，保持原样交给上层判断
  return head || clean;
}
