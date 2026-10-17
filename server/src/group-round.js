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
  closing = false,
} = {}) {
  // 用户按了终止：立刻收手，不再往下派（正在跑的那些也已经被 abort 了）
  if (aborting) return { stop: true, why: '已终止' };
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
export function planItem({ item, name = '', done = 0, budget = 0, busy = false, superior = false } = {}) {
  if (done >= budget) {
    return { kind: 'skip', why: `${name} 这轮已说过 ${done} 次` };
  }
  if (!busy) {
    return { kind: 'run', why: item?.reason ?? '' };
  }
  // 忙的时候怎么处理，是两条完全不同的路：
  //   上级要的是"立刻改主意"（实时），同级要的是"别打断但别丢"
  if (superior) {
    return { kind: 'interrupt', why: `${name} 正忙，但叫它的是上级 → 打断` };
  }
  return { kind: 'queue', why: `${name} 正忙，且是同级 → 投递进 inbox` };
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
 * 判定规则（全部基于消息记录，不看时间）：
 *   · 老大从没在这轮说过话 → 不用收尾（它没有可汇总的内容，交给下一轮）
 *   · 老大说完之后又有别的成员发言 → 需要收尾
 *   · 老大最后一句就是全场最后一句 → 它已经是收口，不用再叫
 *
 * @param {object} p
 * @param {Array<{id:string, authorType?:string, authorId?:string}>} p.messages 房间消息（旧→新）
 * @param {string|null} p.leadId 老大的 bot id
 * @param {Set<string>|string[]} [p.members] 成员 id（用于排除非成员）
 * @returns {{needed: boolean, why: string}}
 */
export function planClosing({ messages = [], leadId = null, members = [] } = {}) {
  if (!leadId) return { needed: false, why: '这个部门没有老大' };
  const set = members instanceof Set ? members : new Set(members ?? []);
  const bots = messages.filter((m) => m?.authorType === 'bot' && m?.authorId);
  if (!bots.length) return { needed: false, why: '这一轮还没有人发言' };

  let lastLead = -1;
  for (let i = 0; i < bots.length; i++) {
    if (bots[i].authorId === leadId) lastLead = i;
  }
  if (lastLead < 0) return { needed: false, why: '老大这一轮还没发过言' };

  // 老大之后还有谁说过话（只算部门成员，别人的消息不算）
  const after = bots.slice(lastLead + 1).filter((m) => !set.size || set.has(m.authorId));
  if (!after.length) return { needed: false, why: '老大已经收口了' };
  return {
    needed: true,
    why: `老大说完之后还有 ${after.length} 个人交了作业，需要它汇总收口`,
  };
}
