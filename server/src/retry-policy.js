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
 * 临时故障（限流 / 上游抖动）可以多试几次。
 *
 * 为什么要区别对待：用户配的 key 不稳时，模型接口会间歇性返回
 * 429 或 5xx —— 这不是"任务做不成"，只是"这一刻没排上"。
 * 按普通失败只给 1 次重试，等于把偶发抖动当成了永久失败，
 * 用户看到的就是整条链路一直报错、跑不完。
 */
export const MAX_RETRIES_TRANSIENT = 10;

/**
 * 临时故障的退避时间（毫秒）。
 *
 * 限流类错误立刻重发大概率再撞一次墙，所以按指数退避：
 * 2s → 4s → 8s → 16s → 32s（封顶 30s，别让用户干等太久）。
 * 带抖动，避免多个 bot 同时重试形成新的洪峰。
 */
export function transientBackoffMs(attempt = 1) {
  // 前几次快速重试（接口抖动往往一两秒就恢复），后面逐步拉长。
  // 封顶 12 秒：10 次重试总等待控制在 1 分半左右 ——
  // 再长用户就会觉得"卡死了"，而限流恢复通常也用不了那么久。
  const base = Math.min(1500 * Math.pow(2, Math.max(0, attempt - 1)), 12000);
  const jitter = Math.floor(Math.random() * 600);
  return base + jitter;
}

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

  /// 上游返回的 HTTP 状态码（如果拿得到）。
  ///
  /// 为什么需要它：给用户看的错误文案是脱敏过的
  ///（"接口详情已隐藏"），里面不含状态码。只看文案的话，
  /// 429 限流和"任务做不成"长得一模一样，重试策略就废了。
  status = null,
} = {}) {
  if (aborting) return { retry: false, why: '用户已终止，不再重试', kind: 'aborted' };

  const text = String(error ?? '');
  // 「忙」不是失败：它只是还在干上一件事，重试只会继续撞墙
  if (/already processing|正在处理|在忙/i.test(text)) {
    return { retry: false, why: '它还在处理上一件事，等它空了再说', kind: 'busy' };
  }
  // 鉴权 / 配置类：重试一百次也一样。
  //
  //   要同时看 status：错误文案是脱敏的，401 那条长这样 ——
  //   "模型请求认证失败"。如果文案里恰好没写 401 三个字，
  //   就得靠 status 认，否则会被后面的临时故障分支误判成"可重试"。
  const authCode = Number(status);
  if (
    authCode === 401 ||
    authCode === 403 ||
    /401|403|unauthorized|forbidden|invalid api key|鉴权|未授权/i.test(text)
  ) {
    return { retry: false, why: '鉴权或配置有问题，重试也没用', kind: 'auth' };
  }

  // ★ 临时故障：限流 / 上游抖动 / 网关错误。
  //
  //   这类失败的共同点是「不是任务做不成，只是这一刻没排上」。
  //   用户的 key 不稳时它们会间歇出现 —— 按普通失败只给 1 次重试，
  //   等于把偶发抖动当成永久失败，整条链路就卡在报错里跑不完。
  //   所以单独给更多次数和更长的退避（见 transientBackoffMs）。
  const code = Number(status) || null;
  if (
    code === 429 ||
    code === 500 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    /\b429\b|rate[ _-]?limit|too many requests|限流|请求过于频繁/i.test(text) ||
    /\b(500|502|503|504)\b|bad gateway|service unavailable|gateway timeout|上游|服务暂不可用/i.test(
      text,
    )
  ) {
    if (attempt > MAX_RETRIES_TRANSIENT) {
      return {
        retry: false,
        why: `接口连续 ${attempt} 次不稳定，先停下（可能是 key 额度或上游故障）`,
        kind: 'transient-exhausted',
      };
    }
    // 前几次老老实实等接口恢复；到后半程就换个思路 ——
    // 同一个模型连续抖这么多次，说明它这条通路本身就不可靠，
    // 继续干等不如换一个模型试（见 retryHint 里的换模型提示）。
    const switchModel = attempt >= Math.ceil(MAX_RETRIES_TRANSIENT * 0.6);
    return {
      retry: true,
      why: switchModel
        ? '接口一直不稳定，换一个模型再试'
        : '接口临时不稳定（限流或上游抖动），等一会儿再试',
      kind: 'transient',
      switchModel,
    };
  }

  if (attempt > maxRetries) {
    return { retry: false, why: `已经试了 ${attempt} 次`, kind: 'exhausted' };
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
 * 这次失败**还有没有希望**（不需要知道是第几次）。
 *
 * 用途：run() 内部要先判断"这次失败要不要给用户看红色气泡"。
 * 还有希望就别标红 —— 用户看到的是"正在重试"，而不是满屏红字；
 * 真到放弃时才标红，一次红字就够说明问题。
 *
 * 与 decideRetry 的区别：那个要 attempt 才能回答"还试不试"，
 * 这个只回答"这类错误是否属于可恢复的那一类"。
 *
 * @param {object} p
 * @param {string} p.error
 * @param {number|null} [p.status]
 * @returns {boolean}
 */
export function isRecoverableFailure({ error = '', status = null } = {}) {
  const text = String(error ?? '');
  const code = Number(status) || null;

  // 用户终止 / 忙 / 鉴权错：都不是"再试试就好"的类型
  if (/已.{0,2}(终止|中止)|aborted|cancelled|already processing|正在处理|在忙/i.test(text)) {
    return false;
  }
  if (
    code === 401 ||
    code === 403 ||
    /401|403|unauthorized|forbidden|invalid api key|鉴权|未授权/i.test(text)
  ) {
    return false;
  }

  // 临时故障：最值得再试的一类
  if (
    code === 429 ||
    code === 500 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    /\b429\b|rate[ _-]?limit|too many requests|限流|请求过于频繁/i.test(text) ||
    /\b(500|502|503|504)\b|bad gateway|service unavailable|gateway timeout|上游|服务暂不可用/i.test(
      text,
    )
  ) {
    return true;
  }

  // 空回复：模型偶发不出内容，再试通常就好
  if (/没有给出内容|空回复|empty/i.test(text)) return true;

  // 超时：再试一次有价值
  if (/超时|timeout|timed out/i.test(text)) return true;

  // 其余未知错误：给一次机会（和 decideRetry 的默认行为一致）
  return true;
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
export function retryHint({
  attempt = 1,
  error = '',
  kind = 'unknown',
  switchModel = false,
} = {}) {
  const reason = String(error ?? '').slice(0, 200);
  const head = `【上一次没成，这是第 ${attempt} 次重试】${reason ? `原因：${reason}` : ''}`;
  if (switchModel) {
    // 接口反复不稳时，光让模型"再试一次"没用 —— 通路本身有问题。
    // 告诉它保存已有进展，方便换模型后接着做。
    return (
      `${head}\n` +
      '接口一直不稳定，可能要换模型了。这个活从头再来的话代价很大，' +
      '所以这次**先把已经确认的事实和结论写下来**（已经查到的、已经改好的、还差什么），' +
      '再继续往下做 —— 万一真换了模型，这些成果能直接接着用。\n\n'
    );
  }

  const advice =
    kind === 'empty'
      ? '上次你没有输出任何内容。这次直接给结论，不要只调工具不说话。'
      : kind === 'timeout'
        ? '上次超时了。这次先做最关键的那一步，别一次做太多。'
        : kind === 'transient'
          ? // 接口抖动跟做法无关，让它别乱改方案
            '刚才接口临时不稳定（不是你的问题）。保持原来的做法再试一次即可。'
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
export function failureNote({
  botName = '',
  reason = '',
  attempt = 1,
  willRetry = false,
  kind = '',
} = {}) {
  const r = String(reason ?? '').slice(0, 160);
  if (willRetry) {
    // 接口抖动时说清楚"不是活干不了"，否则用户会以为任务本身有问题
    return kind === 'transient'
      ? `${botName} 在等接口恢复（${r}），第 ${attempt} 次重试…`
      : `${botName} 这次没跑成（${r}），正在重试第 ${attempt} 次…`;
  }
  // 临时故障耗尽：告诉用户下一步该查什么，而不是只丢一句失败
  if (kind === 'transient-exhausted') {
    return (
      `${botName} 没能完成：模型接口连续 ${attempt} 次不稳定（${r}）。` +
      '\n这种情况通常不是任务本身的问题，建议检查模型组的 key 是否还有额度、' +
      '接口地址是否正常，恢复后让它重跑即可。'
    );
  }
  return `${botName} 没能完成（${r}）`;
}
