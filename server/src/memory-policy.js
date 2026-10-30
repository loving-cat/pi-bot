/**
 * 记忆摘要的**自动触发策略**：纯函数，方便单测。
 *
 * 用户定的规则：
 *   · 首次累计满 10 轮就总结一次；
 *   · 之后不固定"每 10 轮"，而是**按事情的重要程度**总结
 *     （碰到关键内容立刻总结；否则慢慢攒，攒得越多说明一直是琐事，
 *      阈值才放宽）。
 *
 * 为什么要策略而不写死 "count % 10 == 0"：
 *   · 十次"好的"和十次"换了数据库/改了口径"完全不是一回事；
 *   · 只在琐事上机械触发，会把模型调用浪费在没信息的对话上，
 *     而真正的关键决策可能刚好落在计数点之间，隔了 9 轮才被记住。
 */

/** 一轮 = 用户说的 + bot 回的。这里只数"有信息量"的消息。 */
export const FIRST_SUMMARY_TURNS = 10;

/** 之后的阶梯：越往后需要的增量越大（说明前几轮都是琐事）。 */
export const MIN_TURNS_STEP = 6;
export const MAX_TURNS_STEP = 20;

/**
 * 关键内容的信号。命中越多，越该马上总结。
 *
 * 刻意只认**明确改变后续行为**的东西：决策、结论、口径变更、
 * 未完成事项、文件/路径。不把"谢谢""好的"这类算进来。
 */
const IMPORTANT_SIGNALS = [
  // 决策 / 定案
  /决定|定了|就这么|改成|换成|改用|切换|上线|回滚|废弃/,
  // 结论 / 判断
  /结论|总结一下|最终|确认|核实过|验证过/,
  // 口径 / 规则
  /口径|规则|标准|约定|以后都|一律|不许|必须/,
  // 未完成
  /待办|还没|未完成|下一步|回头|接着做|未做/,
  // 具体对象：路径、文件、数字结论
  /[A-Za-z]:\\|\/[\w.-]+\/|\.(xlsx|csv|pdf|docx|md|json)\b/,
  // 明确的否定/纠正（往往是用户纠错，最该记住）
  /不对|不是这样|错了|别这样|不要用|有问题/,
];

export function importanceScore(message) {
  const text = String(message?.text ?? '');
  if (!text.trim()) return 0;
  // 用户说的话权重更高：用户纠正/派活通常就是"关键内容"
  const base = message?.authorType === 'user' ? 2 : 1;
  let hits = 0;
  for (const re of IMPORTANT_SIGNALS) {
    if (re.test(text)) hits++;
  }
  if (!hits) return 0;
  return hits * base;
}

/**
 * 从上次总结之后的新消息里，算出"重要度"。
 * @returns {{score:number, hits:number, hasUser:boolean}}
 */
export function importanceOf(messages = []) {
  let score = 0;
  let hits = 0;
  let hasUser = false;
  for (const m of messages) {
    if (m?.authorType === 'user') hasUser = true;
    const s = importanceScore(m);
    if (s > 0) {
      score += s;
      hits++;
    }
  }
  return { score, hits, hasUser };
}

/** 数"轮"：用户发一条算一轮的起点；没有用户消息时按 bot 消息条数折算。 */
export function countTurns(messages = []) {
  const userMsgs = messages.filter((m) => m?.authorType === 'user').length;
  if (userMsgs > 0) return userMsgs;
  // 全是 bot 说的（例如自动巡检报告的群）：两条算一轮，避免永不触发
  return Math.floor(messages.length / 2);
}

/**
 * 该不该自动总结。
 *
 * @param {object} p
 * @param {object|null} p.summary      上次的摘要记录（含 count/at）
 * @param {number} p.totalTurns        这个会话到目前为止的总轮数
 * @param {Array}  p.newMessages       上次总结之后的新消息
 * @param {number} p.now               当前时间戳
 * @returns {{due:boolean, reason:string, score:number}}
 */
export function shouldAutoSummarize({
  summary = null,
  totalTurns = 0,
  newMessages = [],
  now = Date.now(),
  // 同一会话最短间隔：防止用户连发消息把模型打爆
  minIntervalMs = 3 * 60 * 1000,
} = {}) {
  const lastTurns = Number(summary?.count ?? 0);
  const sinceTurns = Math.max(0, totalTurns - lastTurns);

  // 从没总结过：攒够 10 轮才第一次总结
  if (!summary || !summary.text) {
    if (totalTurns >= FIRST_SUMMARY_TURNS) {
      return { due: true, reason: 'first', score: 0 };
    }
    return { due: false, reason: 'first-not-enough', score: 0 };
  }

  // 刚总结过，冷却中
  const lastAt = Number(summary.at ?? 0) * (summary.at > 1e12 ? 1 : 1000);
  if (lastAt && now - lastAt < minIntervalMs) {
    return { due: false, reason: 'cooldown', score: 0 };
  }

  const { score, hits } = importanceOf(newMessages);

  // ★ 关键内容优先：命中重要信号就立刻总结，不等轮数。
  //   但要有个下限，否则一来一回两句话也触发。
  if (score >= 4 && sinceTurns >= 2) {
    return { due: true, reason: 'important', score };
  }

  // 否则按"攒得越多、门槛越高"的阶梯：
  //   连续攒了 n 个台阶的琐事，说明确实没什么要紧事，可以更晚再总结。
  const steps = Math.max(0, Math.floor(sinceTurns / FIRST_SUMMARY_TURNS));
  const step = Math.min(MAX_TURNS_STEP, MIN_TURNS_STEP + steps * 2);
  if (sinceTurns >= step && hits > 0) {
    return { due: true, reason: 'enough-with-signal', score };
  }
  if (sinceTurns >= step * 2) {
    // 攒了很久还是没信号 —— 仍然要总结一次，否则记忆会一直停在很久以前
    return { due: true, reason: 'stale', score };
  }
  return { due: false, reason: 'not-enough', score };
}
