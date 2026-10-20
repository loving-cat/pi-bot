/**
 * 群聊调度的**决策层**（纯函数：只回答"该做什么"，不执行任何副作用）。
 *
 * 为什么把这几个判断单独拎出来：
 *   它们原来长在 `pi-runner.js` 的 runRound 里（那个方法 250 多行，
 *   决策和执行搅在一起）。表现是"调度规则没法单测"——
 *   想验"上级 @ 忙碌成员要不要打断"，得把 PiRunner 的原型方法打桩才能测，
 *   而且稍不注意就把原型方法删掉（这个坑真踩过）。
 *
 * 拆开之后：
 *   · 这边只有"数据进、结论出"，一行副作用都没有；
 *   · 那边（pi-runner）只负责把我们算出来的结论执行出去（派发/打断/投递/等待）。
 *
 * 判断依据全部由调用方传进来（isBusy / superior 都是布尔），
 * 所以这一层不碰 store、不碰 session、不碰日志。
 */

/**
 * 这一轮还该继续吗？
 *
 * @returns {{stop: boolean, why: string}} stop=true 时调用方应该清掉队列并收手
 */
export function shouldStopRound({
  queueLen = 0,
  pendingLen = 0,
  runs = 0,
  maxRuns = 0,
  aborting = false,
  stale = false,
  closing = false,
} = {}) {
  // 用户按了终止：立刻收手，不再往下派（正在跑的那些也已经被 abort 了）
  if (aborting) return { stop: true, why: '已终止' };
  // ★ 用户插话 = 需求变了，旧轮整个作废。
  //
  //   与"终止"的区别：终止是停下来什么都不做；插话是停旧轮、马上按新
  //   query 重开一轮。但**旧轮剩下的队列必须丢** —— 那是按旧需求算出来的
  //   派单，继续派出去只会让用户看到一堆跟新需求无关的产出。
  if (stale) return { stop: true, why: '用户插话' };
  // 队列空了但还有人在跑：**不能停** —— 他们的回复里 @ 的人会补进队列
  if (queueLen === 0 && pendingLen === 0) return { stop: true, why: '没有排队的人了' };
  // 收尾轮不受 maxRuns 约束：它是老大的汇总，抽掉它用户就看不到结论了
  if (closing) return { stop: false, why: '' };
  if (queueLen > 0 && runs >= maxRuns) {
    return { stop: true, why: `本轮到上限 ${maxRuns} 次` };
  }
  return { stop: false, why: '' };
}

/**
 * 队列里这一条该怎么处理。
 *
 * 四种结论：
 *   · skip       —— 这轮它已经说过够了，不再叫它（以前是静默 continue，现在至少能记日志）
 *   · interrupt  —— 上级/用户 @ 它：**打断**它手上的活，让它先报进度再接新要求
 *   · queue      —— 同级同事 @ 它：不打断，把话**投递进它的 inbox**，它忙完自己看
 *   · run        —— 它不忙，直接派
 *
 * @param {object} p
 * @param {{botId:string, reason?:string}} p.item        队列里这一条
 * @param {string} p.name                                它的名字（日志/文案用）
 * @param {number} p.done                                它这轮已经说了几次
 * @param {number} p.budget                              它这轮最多能说几次
 * @param {boolean} p.busy                               它现在忙不忙
 * @param {boolean} p.superior                           叫它的是不是上级（或用户）
 * @returns {{kind:'skip'|'interrupt'|'queue'|'run', why:string}|{kind:'wait', why:string}}
 */
export function planItem({
  item,
  name = '',
  done = 0,
  budget = 0,
  busy = false,
  superior = false,
  userRound = false,
} = {}) {
  if (done >= budget) {
    return { kind: 'skip', why: `${name} 这轮已说过 ${done} 次` };
  }
  if (!busy) {
    return { kind: 'run', why: item?.reason ?? '' };
  }
  // ★ 用户发起的新需求 → 不管叫它的是谁，**一律打断**。
  //
  //   用户说"没完成的再完成一次"，意思是"之前的作废，按新的来"。
  //   如果还让它把旧活干完再听（排队），等来的结果是基于旧需求的，
  //   用户看到的就是"我说了但它还在忙原来的事"。
  //
  //   成员之间互相 @ 不在此列（那是日常协作，打断会互相擂断）。
  if (userRound) {
    return { kind: 'interrupt', why: `${name} 正忙，但这一轮是用户新需求 → 打断` };
  }
  // 上级要的是"立刻改主意"（实时），同级要的是"别打断但别丢"
  if (superior) {
    return { kind: 'interrupt', why: `${name} 正忙，但叫它的是上级 → 打断` };
  }
  return { kind: 'queue', why: `${name} 正忙，且是同级 → 投递进 inbox` };
}

/**
 * 这一轮是**由用户发起的新需求**吗？（区别于成员之间互相 @ 的日常调度）
 *
 * 为什么需要区分：
 *   · 用户发起 → 这是“改需求”，所有人手上的活都作废，成员**必须停下来**
 *     接新任务；排队等它忙完，等来的还是旧需求的产物。
 *   · 成员互 @ → 这是日常协作，打断会让群里互相擂断，必须排队。
 *
 * @param {object} p
 * @param {string|null} p.openerBotId 谁起的头（null = 用户）
 * @param {string} [p.openerName]
 * @returns {boolean}
 */
export function isUserInitiatedRound({ openerBotId = null } = {}) {
  return !openerBotId;
}

/**
 * 队列中尚未轮到的成员（预算截断时用于留痕）。
 */
export function leftBehind(queue = [], nameOf = (id) => id) {
  return queue.map((q) => nameOf(q.botId));
}

/**
 * 这一轮跑完之后要不要叫老大回来做**收尾总结**？
 *
 * 为什么需要它：
 * 老大的总结只是它自己最后一轮的输出，而同一波成员是并发跑完的——
 * 谁的回复落地得晚，谁就排在总结后面。用户看到的就是“结论夹在中间，
 * 后面还有人在交作业”。预算（maxRuns / leadTurns）一用完，更没人收口。
 *
 * 为什么用三个位置（序号）而不是消息数组：
 *   传数组就得选一个"取多少条"的窗口。窗口小了，一轮产出超过窗口就漏判；
 *   窗口大了，会把上一轮老大的发言带进来造成误判。
 *   位置是绝对值，不存在窗口问题。
 *
 * 判定规则：
 *   · 老大本轮没说过话 → 不收尾（它没有可汇总的内容）
 *   · 老大说完之后没人再说话 → 它已经是收口，不用再叫
 *   · 老大说完之后还有成员说过话 → 需要收尾
 *
 * @param {object} p
 * @param {number} p.roundStartIndex 本轮开始时的房间消息位置（-1 表示空房间）
 * @param {number} p.lastLeadIndex   老大最近一次发言的位置（-1 表示从没说过）
 * @param {number} p.lastMemberIndex 参与本轮的成员（含老大）最近一次发言的位置
 * @returns {{needed: boolean, why: string}}
 */
export function planClosing({
  roundStartIndex = -1,
  lastLeadIndex = -1,
  lastMemberIndex = -1,
} = {}) {
  // 老大这一轮没发言（要么从没说过，要么最后一次在开轮之前）
  if (lastLeadIndex < 0 || lastLeadIndex <= roundStartIndex) {
    return { needed: false, why: '老大这一轮还没发过言' };
  }
  // 老大说完之后没有人再说话
  if (lastMemberIndex <= lastLeadIndex) {
    return { needed: false, why: '老大已经收口了' };
  }
  return { needed: true, why: '老大说完之后还有人交作业，需要它汇总收口' };
}
