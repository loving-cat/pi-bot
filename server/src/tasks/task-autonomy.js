/**
 * 「一直干到有结果」这类授权 → 任务自主推进标记。
 *
 * ## 为什么需要识别它
 *
 * 多 Agent 系统最常见的挫败感是：用户说「你们自己搞定，别问我」，
 * 结果团队干到一半停下来问「要不要继续？」—— 用户还得再回一句，
 * 一件事变成十次对话。
 *
 * 识别到这类授权后，任务会：
 *   · 不再因为「需要用户确认」而停在 waiting_approval；
 *   · 验收不通过时自己重试，而不是等用户回话；
 *   · 只有真正做不下去（缺外部信息/需要账号）才停下来问。
 *
 * ## 判定原则
 *
 * 只有**明确的自主授权**才算。含糊的「看着办」不算 —— 宁可多问一句，
 * 也不要替用户做他没授权的决定。
 */

/** 明确表示「自己搞定、别问我」的说法。 */
const AUTONOMY_PATTERNS = [
  /一直\s*(?:干|做|跑|推)?\s*(?:到|出)\s*(?:有)?\s*(?:结果|完成|做完)/,
  /(?:做|干|跑)\s*到\s*(?:有)?\s*(?:结果|完|完成)/,
  /不用\s*(?:再\s*)?问\s*我/,
  /不要\s*(?:再\s*)?问\s*我/,
  /别\s*(?:再\s*)?问\s*我/,
  /自己\s*(?:给|拿|出)\s*(?:个)?\s*(?:结果|结论|方案)/,
  /你们\s*(?:自己)?\s*(?:决定|判断|搞定|看着办)/,
  /直到\s*(?:做完|完成|出结果)/,
  /(?:全权|自行)\s*(?:处理|推进)/,
  /不需要\s*(?:我)?\s*(?:确认|批准|点头)/,
];

/** 反过来：明确要求「先问我」的说法，优先级更高。 */
const ASK_FIRST_PATTERNS = [
  /(?:先|要)\s*(?:问|跟|和)\s*我/,
  /(?:等|等?待)\s*我\s*(?:确认|批准|点头)/,
  /不要\s*(?:自己|擅自)\s*(?:决定|动手)/,
  /(?:每|逐)\s*(?:一)?步\s*(?:都)?\s*(?:要)?\s*(?:报|问)/,
];

/**
 * 从一段用户输入里判断是否授予了自主推进权限。
 *
 * @param {string} text
 * @returns {{autonomous:boolean, reason:string}}
 */
export function detectAutonomy(text) {
  const body = String(text ?? '');
  if (!body.trim()) return { autonomous: false, reason: '' };
  // 明确要求逐步汇报/先问，优先于自主授权
  for (const re of ASK_FIRST_PATTERNS) {
    if (re.test(body)) return { autonomous: false, reason: '用户要求先确认：' + (body.match(re)?.[0] ?? '') };
  }
  for (const re of AUTONOMY_PATTERNS) {
    const hit = body.match(re);
    if (hit) return { autonomous: true, reason: '用户授权自主推进：' + hit[0] };
  }
  return { autonomous: false, reason: '' };
}

export { AUTONOMY_PATTERNS, ASK_FIRST_PATTERNS };