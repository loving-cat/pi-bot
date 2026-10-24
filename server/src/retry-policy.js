/**
 * 成员任务失败后的**重试决策**（纯函数：只回答"该怎么办"，不执行任何动作）。
 *
 * 为什么需要单独一层：
 * 群聊里成员失败时若只打一行日志就 `return`，负责人和用户都不知道，
 * 负责人回来只看到"弟弟没说话"，于是自己上手把活干了 ——
 * **用户以为全员交付完成，实际有人掉链子被悄悄兜底了**。
 *
 * 这里只回答三个问题：
 *   · 这次失败要不要重试？
 *   · 重试时给它的提示词该怎么变？
 *   · 重试用完了，该对负责人说什么？
 */

/** 默认最多重试几次（不含第一次）。2 次 ≈ 原样一次 + 换个说法一次 */
export const MAX_RETRIES = 2;

/**
 * 这次失败能不能重试。
 *
 * 不重试的情况分两类：
 *   · 明显不该重试的：用户主动终止、对方一直忙、权限/配置问题；
 *   · 重试也没用的：账号/鉴权错误、明确的参数错误。
 *
 * @param {object} p
 * @param {string} p.error   失败原因（原始错误文本）
 * @param {number} p.attempt 已经尝试过几次（含第一次）
 * @param {boolean} [p.aborting] 用户是不是按了终止
 * @param {number} [p.maxRetries]
 * @returns {{retry: boolean, why: string, kind: string}}
 */
export function decideRetry({
  error = '',
  attempt = 1,
  aborting = false,
  maxRetries = MAX_RETRIES,
} = {}) {
  if (aborting) return { retry: false, why: '用户已终止，不再重试', kind: 'aborted' };
  if (attempt > maxRetries) {
    return { retry: false, why: `已经试了 ${attempt} 次`, kind: 'exhausted' };
  }

  const text = String(error ?? '');
  // 「忙」不是失败：它只是还在干上一件事，重试只会继续撞墙
  if (/already processing|正在处理|在忙/i.test(text)) {
    return { retry: false, why: '它还在处理上一件事，等它空了再说', kind: 'busy' };
  }
  // 鉴权 / 配置类：重试一百次也一样
  if (/401|403|unauthorized|forbidden|invalid api key|鉴权|未授权/i.test(text)) {
    return { retry: false, why: '鉴权或配置有问题，重试也没用', kind: 'auth' };
  }
  // 用户主动中止（"已被终止""这一轮已中止"这类都要认出来）
  if (/已.{0,2}(终止|中止)|aborted|cancelled/i.test(text)) {
    return { retry: false, why: '这一轮已被终止', kind: 'aborted' };
  }
  // 空回复：这是最值得重试的一类（模型偶发不出内容）
  if (/没有给出内容|空回复|empty/i.test(text)) {
    return { retry: true, why: '它上次没出内容，值得再来一次', kind: 'empty' };
  }
  // 超时：重试有价值，但只给一次机会（第二次还超时就别耗了）
  if (/超时|timeout|timed out/i.test(text)) {
    return attempt <= 1
      ? { retry: true, why: '上次超时了，再给一次机会', kind: 'timeout' }
      : { retry: false, why: '连续超时，可能是任务太重或模型不稳', kind: 'timeout-twice' };
  }

  // 其余（工具报错、模型抽风、未知）：默认给一次重试
  return attempt <= 1
    ? { retry: true, why: '上次没跑成，再试一次', kind: 'unknown' }
    : { retry: false, why: `试了 ${attempt} 次都没成`, kind: 'exhausted' };
}

/**
 * 重试时追加到提示词里的说明。
 *
 * 为什么要换措辞而不是原样重发：原样重发的输入完全一样，
 * 模型很可能给出同样的结果（尤其是它上次卡在某个工具上）。
 * 明确告诉它"上次失败了、换个办法"，它能改路径。
 *
 * @param {object} p
 * @param {number} p.attempt  第几次重试（1 = 第一次重试）
 * @param {string} p.error    上次的失败原因
 * @param {string} [p.kind]   失败类型（来自 decideRetry）
 * @returns {string} 要拼在提示词前面的段落（空串表示不加）
 */
export function retryHint({ attempt = 1, error = '', kind = 'unknown' } = {}) {
  const reason = String(error ?? '').slice(0, 200);
  const head = `【上一次没成，这是第 ${attempt} 次重试】${reason ? `原因：${reason}` : ''}`;

  const advice =
    kind === 'empty'
      ? '上次你没有输出任何内容。这次直接给结论，不要只调工具不说话。'
      : kind === 'timeout'
        ? '上次超时了。这次先做最关键的那一步，别一次做太多。'
        : '换个做法再试：如果上次卡在某个命令/工具上，换个方式达成同样的结果。';

  return `${head}\n${advice}\n\n`;
}

/**
 * 重试用完之后，该对负责人说什么。
 *
 * 关键是**不能给它"自己上"的口子** —— "请你重新安排：换个人，或者再派一次"
 * 这种文案读起来像在暗示它可以自己接手。
 *
 * @param {object} p
 * @param {string} p.botName   掉链子的那个人
 * @param {string} p.task      原任务（会截断）
 * @param {number} p.attempts  一共试了几次
 * @param {string} p.reason    最后一次失败原因
 * @returns {string}
 */
export function giveUpNote({ botName = '', task = '', attempts = 0, reason = '' } = {}) {
  return (
    `[派活失败] ${botName} 没能完成，已经试了 ${attempts} 次。` +
    (reason ? `\n最后一次的原因：${String(reason).slice(0, 300)}` : '') +
    (task ? `\n\n原任务：${String(task).slice(0, 600)}` : '') +
    '\n\n请按这个顺序处理：\n' +
    `1. 先 @ ${botName} 再派一次，把要求说得更具体（做什么 / 交什么 / 怎么算完成）。\n` +
    '2. 还不行就 @ 另一个同事接手，并说明是谁没完成。\n' +
    '3. 实在没人能接，你自己上 —— 但**必须在群里说明你接手了、因为谁没完成**。\n' +
    '★ 不要悄悄把活接下：用户会以为全员都交付了，掉链子的事故就被掩盖了。'
  );
}

/**
 * 成员失败时，群里留痕的文案（用户也看得到）。
 *
 * @param {object} p
 * @param {string} p.botName
 * @param {string} p.reason
 * @param {number} p.attempt
 * @param {boolean} p.willRetry
 * @returns {string}
 */
export function failureNote({ botName = '', reason = '', attempt = 1, willRetry = false } = {}) {
  const r = String(reason ?? '').slice(0, 160);
  return willRetry
    ? `${botName} 这次没跑成（${r}），正在重试第 ${attempt} 次…`
    : `${botName} 没能完成（${r}）`;
}
