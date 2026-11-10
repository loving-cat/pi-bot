/**
 * 群聊的**会话层**：谁先开口、每个人能看见什么、提示词怎么拼。
 *
 * 这一层**几乎全是纯逻辑**：
 *   · 输入是房间、成员、消息列表；
 *   · 输出是一个 id 列表或一段字符串。
 * 因此可以直接单测，不需要把 PiRunner 的原型方法整个打桩 ——
 * 例如验"@点名时是不是只叫被点名的"。
 *
 * 唯一的外部依赖是 store（查 bot、查消息游标），没有网络、没有模型、
 * 没有 session，也不写任何东西。
 */
import { store } from './store.js';
import { parseMentions, rosterLine } from './mentions.js';
import { clipMessage, trimTranscript } from './transcript-budget.js';
import { isLeadOfRoom, isDelegatingLead } from './role-tools.js';

/** 部门成员（含老大）+ 老大 id。老大的 id 不在名单里时退回第一个 */
export function departmentOf(room) {
  const members = room.botIds.map((id) => store.getBot(id)).filter(Boolean);
  const leadId =
    room.leadBotId && members.some((m) => m.id === room.leadBotId)
      ? room.leadBotId
      : (members[0]?.id ?? null);
  return { members, leadId };
}

/**
 * 一条消息进来时，该谁先开口。
 *
 *   · @点名 → 只叫被点名的（@all 就是除自己外全员）
 *   · 否则**部门老大先接**（老大负责把活拆开分下去）
 *   · 部门刚成立（kickoff）→ 直接交给老大安排
 */
export function openingSpeakers(room, { text = '', openerBotId = null, kickoff = false } = {}) {
  const { members, leadId } = departmentOf(room);
  const others = members.filter((m) => m.id !== openerBotId);
  if (!others.length) return [];
  if (kickoff) return leadId ? [leadId] : [others[0].id];

  const { all, found } = parseMentions(text, members, { selfId: openerBotId });
  if (all) return others.map((m) => m.id);
  const named = found.filter((id) => id !== openerBotId);
  if (named.length) return named;
  if (leadId) return [leadId];
  return [others[0].id];
}

/** 同事之间的长结论只留这么多字（保头尾）。派给它的活、用户和上级的话不受这个限制 */
export const PEER_CLIP_CHARS = 1600;

/**
 * 这条消息对「正在读记录的这个 bot」是不是必须看全的：
 *   · 用户说的话 —— 用户是最高权威；
 *   · 部门老大 / 主控说的话 —— 派活和改口径都从这里来；
 *   · 点了它名字（@ 它或 @all）的话 —— 那就是派给它的活。
 * 派活正文被截断，受派人就只能靠猜范围干活；要叫的人的 @ 也可能恰好在被截掉的那段里。
 */
export function isAddressedToReader(m, { readerId, leadId = null, chiefId = null, members = [] } = {}) {
  if (!m) return false;
  if (m.authorType === 'user') return true;
  if (m.authorId && (m.authorId === leadId || m.authorId === chiefId)) return true;
  if (!readerId || !members.length) return false;
  const { all, found } = parseMentions(m.text ?? '', members, { selfId: m.authorId ?? null });
  return all || found.includes(readerId);
}

/**
 * 某个成员"还没看过"的那段记录 —— 用游标（seenCursor）算位置，
 * 已经说过的、自己说的、没写完的都不给它看。
 *
 * 三重收口：
 *   · 条数（默认 30 条）—— 防止把整个房间倒给它；
 *   · 字数预算（默认 12000 字）—— 真实群聊里单条能有四千多字；
 *   · 同事的长结论按 PEER_CLIP_CHARS 保头尾截断，预算按截断后的长度记。
 * 派给它的活、用户和上级的话不受这三重限制（见 isAddressedToReader）。
 * 其它消息越新越重要，所以预算从新往旧装。
 */
export function transcriptFor(roomId, botId, limit = 30, { maxChars = 12000 } = {}) {
  const list = store.listMessages(roomId, { limit: 200 });
  const cursor = store.seenCursor(roomId, botId);
  let start = 0;
  if (cursor) {
    const idx = list.findIndex((m) => m.id === cursor);
    if (idx >= 0) start = idx + 1;
  }
  const fresh = list
    .slice(start)
    .filter((m) => m.authorId !== botId && m.status === 'done' && (m.text ?? '').trim());

  const room = store.getRoom(roomId);
  const { members, leadId } = room ? departmentOf(room) : { members: [], leadId: null };
  const chiefId = store.mainBot()?.id ?? null;
  const addressed = (m) => isAddressedToReader(m, { readerId: botId, leadId, chiefId, members });
  const { items, dropped } = trimTranscript(fresh, {
    maxChars,
    maxItems: limit,
    mustKeep: addressed,
    capOf: (m) => (addressed(m) ? Infinity : PEER_CLIP_CHARS),
  });
  // 展示时要知道哪些不能截：打上标记（拷贝一份，不动 store 里的消息对象）
  const out = items.map((m) => (addressed(m) ? { ...m, keepFull: true } : m));
  // 调用方绝大多数只关心"有哪些消息"，所以返回值仍是数组；
  // 需要知道"前面还丢了几条"时读 droppedCount（普通属性，传递/拷贝都不会丢）。
  //
  // ★ 窗口外被挤掉的**未读**条数要算进来，但只算未读的。
  //
  //   listMessages 返回的是**最后 200 条**（slice(-limit)）——
  //   房间超过 200 条时，更旧的直接不在 list 里，而上面的 dropped
  //   只统计 trimTranscript 内部为省预算丢掉的条数。
  //   所以未读超过 200 条时，被窗口挤掉的部分原先是完全无声的。
  //
  //   但「房间总条数 - 窗口条数」是**错的**：那会把 bot 早就读过的旧消息
  //   也算进去。300 条且已读完的房间会报 100+，500 条会报约 300，
  //   提示词写成「更早的 N 条已省略」，模型以为自己漏看了一大段 —— 纯虚报。
  //
  //   正确口径：从「bot 读到的位置（cursor）之后」到「窗口起点之前」
  //   这一段有多少条 —— 那才是"有内容、但被窗口挤掉看不到"的真实数量。
  //   cursor 不存在（从没读过）时，窗口外全都是未读。
  const omittedUnread = countUnreadOutsideWindow(roomId, botId, list.length);
  out.droppedCount = dropped + omittedUnread;
  return out;
}

/**
 * 「bot 读到的位置之后、又被窗口挤掉」的条数。
 *
 * 举例：房间 500 条，bot 的 cursor 停在第 400 条（前 400 条都读过），
 * 窗口只留最后 200 条（第 300–500 条）。
 *
 *   未读起点 = cursor 在完整列表里的下标 + 1   （= 400）
 *   窗口起点 = 完整列表长度 - windowSize       （= 300）
 *   被挤掉的未读 = max(0, 窗口起点 - 未读起点)  →  300 - 400 < 0  →  0
 *
 * 房间 300 条、已全部读完 → cursor 是最后一条，未读起点 = 300，
 * 窗口起点 = 100，100 - 300 < 0 → 0（**不虚报**）。
 *
 * 房间 550 条、cursor 停在第 300 条 → 未读起点 300、窗口起点 350，
 * 被挤掉 50 条 —— 这才是"有新内容但看不到"的真实数量。
 *
 * cursor 找不到（消息已被裁掉/删除）时保守返回 0：宁可少报，
 * 也不要让模型以为自己漏看了一大段并不存在的未读。
 *
 * @param {number} windowSize 窗口里保留了多少条（listMessages 的 limit）
 */
function countUnreadOutsideWindow(roomId, botId, windowSize) {
  try {
    const all = store.messages?.get?.(roomId);
    if (!Array.isArray(all) || all.length <= windowSize) return 0;

    const windowStart = all.length - windowSize;
    const cursor = store.seenCursor(roomId, botId);

    // 没有 cursor：从没读过任何一条，窗口外全都是未读
    if (!cursor) return Math.max(0, windowStart);

    const idx = all.findIndex((m) => m.id === cursor);
    if (idx < 0) return 0; // cursor 已不在列表里，不猜

    const unreadStart = idx + 1;
    return Math.max(0, windowStart - unreadStart);
  } catch {
    return 0;
  }
}

/**
 * 房间当前的消息位置（用于标记"本轮从哪里开始"）。
 * @returns {number} 最后一条消息的序号；空房间返回 -1
 */
export function lastDoneIndexAll(roomId) {
  const list = store.listMessages(roomId, { limit: 1 });
  return list.length ? store.listMessages(roomId, { limit: 100000 }).length - 1 : -1;
}

/**
 * 某个作者集合"最近一条已完成发言"的消息 id。
 *
 * ★ 为什么用 id 而不是数组下标
 *
 *   房间满 `maxMessagesPerRoom`（500）条后，`store.appendMessage`
 *   会从头部 `splice` 掉最旧的几条，**数组下标整体前移**；
 *   另有一条插入路径把消息插到"正在写的那条"之前，下标也会错位。
 *   而收尾判定用的"本轮起点"是 runRound 里的局部变量，
 *   它拿到的是开轮那一刻的下标 —— 裁剪发生后这个数字就再也对不上了。
 *
 *   实际后果：满 500 条后起点会卡在 499，老大发言位置始终 ≤ 497，
 *   于是 `lastLeadIndex <= roundStartIndex` 恒成立，
 *   `planClosing` 永远返回"老大这一轮还没发过言" ——
 *   收尾彻底不触发，用户再也拿不到最终结论。
 *
 *   id 不受裁剪影响，所以按 id 定位是稳的。
 *
 * @returns {string|null} 消息 id；没有发言过返回 null
 */
export function lastDoneIdOf(roomId, authorIds = []) {
  const set = new Set(authorIds);
  if (!set.size) return null;
  const list = store.listMessages(roomId, { limit: 100000 });
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.status !== 'done') continue; // 失败的消息不算"说过话"
    if (m.authorType !== 'bot') continue;
    if (set.has(m.authorId)) return m.id;
  }
  return null;
}

/**
 * 两条消息在房间当前数组里的先后：target 在 ref **之后**（strict）返回 true。
 *
 * ★ 必须用严格大于，不能用 >=。
 *
 *   「成员是否在老大之后发言」里，participants 是**含老大**的集合，
 *   所以老大最后发言时 lastDoneIdOf([leadId]) 和 lastDoneIdOf(participants)
 *   是同一条消息。用 >= 会判成"成员在老大之后说过话"，
 *   于是已经收口的情况下还要再叫老大收尾一轮 —— 白烧一次调用。
 *
 *   语义对应原来的 `lastMemberIndex <= lastLeadIndex → 不用收尾`：
 *   相等（同一条消息）不算"之后"。
 */
export function isStrictlyAfter(roomId, refId, targetId) {
  if (!refId || !targetId) return false;
  return compareMessageOrder(roomId, refId, targetId) > 0;
}

/**
 * 按消息 id 在当前房间数组里的位置比较：**idB 相对 idA 的先后**。
 *
 *   返回 1  → idB 在 idA 之后（更新）
 *   返回 0  → 同一条消息
 *  返回 -1  → idB 在 idA 之前（更旧）
 * 返回 null → 任一条找不到（已被删/被裁出 100000 条窗口），
 *             调用方要当作"不确定"处理，不要当成某个确定的先后。
 *
 * ★ 注意方向：参数顺序是 (ref, target)，返回的是 target 相对 ref 的位置。
 *   写反了会让"成员在老大之后发言"永远判成 false —— 收尾又不触发了，
 *   而且测不出来（两边都是 false）。
 */
function compareMessageOrder(roomId, idA, idB) {
  const list = store.listMessages(roomId, { limit: 100000 });
  const ia = list.findIndex((m) => m.id === idA);
  const ib = list.findIndex((m) => m.id === idB);
  if (ia < 0 || ib < 0) return null;
  return ia === ib ? 0 : (ib > ia ? 1 : -1);
}

/** 房间里最后一条消息的 id（推进游标用） */
export function lastMessageId(roomId) {
  const list = store.listMessages(roomId, { limit: 1 });
  return list[list.length - 1]?.id ?? null;
}

/** 给某个成员看的提示词：我是谁、同事是谁、老大是谁、现在轮到我了 */
export function composeGroupPrompt(
  room,
  bot,
  fresh,
  {
    isLead = false,
    reason = '',
    members = [],
    leadId = null,
    order = null,
    closing = false,
    // 记录被裁掉了几条：由 transcriptFor 给出；没传就看数组上挂的属性
    droppedCount = null,
  } = {},
) {
  const lead = members.find((m) => m.id === leadId) ?? null;
  const peers = members.filter((m) => m.id !== bot.id);
  const roleRoom = {
    ...room,
    kind: room.kind ?? 'group',
    botIds: room.botIds ?? members.map((member) => member.id),
    leadBotId: room.leadBotId ?? leadId,
  };
  const soloLead = isLead && bot.role !== 'main' && !isLeadOfRoom(roleRoom, bot.id);

  const head = [
    `【部门】${room.name}${room.topic ? ` —— ${room.topic}` : ''}`,
    lead
      ? `【部门老大】${lead.emoji ?? ''}${lead.name}${lead.id === bot.id ? '（就是你）' : ''}`
      : '',
    `【同事】${peers.map((m) => rosterLine(m, { isLead: m.id === leadId })).join('、') || '（暂时没有）'}`,
    '',
    // 发言顺序与并发：被叫的顺序就是老大 @ 的顺序（老大定先后）。
    // 同时要说清"你们是并行的"，不然它们会以为得排队等人说完。
    order ? `你是这一轮**第 ${order.index} 个**被叫到的（顺序由部门老大决定）。` : '',
    '同一批被叫到的人**同时开干**（各干各的，不用等人）；谁先干完谁先发言。',
    '你可以 @ 别人接着做 —— 那就是下一波。',
    '',
    // 群里要连续推进任务：卡片会让人停下来等，任务就卡住了。
    isDelegatingLead(roleRoom, bot)
      ? '★ 群里收到活先拆解并派给成员，收到结果后核对交付。'
      : '★ 群里收到活就**先执行**：需要确认的事写在回复正文里，然后继续把能做的部分做完。',
    '  不要用询问卡片（ask_user）停下来等用户点 —— 那张卡是私聊里才用的。',
    '',
    // ★ 受管执行是单目标：这一轮只跑负责人本人。
    //   但负责人正文里的 @ 会被系统解析成持久子任务，成员随后被真正唤醒。
    //   所以 @ 就是派活；一次 @ 一个名字，并写清要它做什么。
    isDelegatingLead(roleRoom, bot) && order !== null
      ? '★ @ 同事就是派活：系统会为它建一份子任务并唤醒它。一次 @ 一个名字，写清要它做什么、交付什么。'
      : '',
    '规则：写「@同事名字」就是把这件事交给它（它会接着干、交回来）；',
    '只写名字不带 @ 就只是提到它，不会派活。',
    // ★ 对话与派活是两件事。没有这一条，模型遇到不确定的地方只会
    //   闷头猜（或者干脆停在那里），而不是问一句。
    '★ 同事的话里有你判断不了的地方（缺前提、前提打架、范围不清）就先问，别猜着往下做：',
    '  用 reply_bot（就近回一句，对方直接答，不开工），或在群里 @ 它 + 问句。',
    '  问要具体：说清你卡在哪一步、需要它给什么。',
    '  反过来，同事问你的也要答 —— 一句话说清就行，不要借机重新汇报。',
  ].filter(Boolean);

  const parts = [head.join('\n')];

  if (fresh?.length) {
    const lines = fresh.map((m) => {
      const who = m.authorType === 'user' ? '用户' : m.authorName;
      const body = (m.text ?? '').trim();
      // 派给它的活、用户和上级的话原文照给（keepFull 由 transcriptFor 标记）；
      // 同事的长结论保头尾：结论和数字常在末尾，只留开头会砍掉最关键的
      const shown = m.keepFull ? body : clipMessage(body, PEER_CLIP_CHARS);
      const gap = m.gapBefore ? `（中间省略 ${m.gapBefore} 条）\n` : '';
      return `${gap}${who}: ${shown}`;
    });
    const dropped = Number(droppedCount ?? fresh?.droppedCount ?? 0);
    parts.push(
      '',
      dropped > 0
        ? `【群里刚刚发生的事（补给你的记录，更早的 ${dropped} 条已省略）】`
        : '【群里刚刚发生的事（补给你的记录）】',
      ...lines,
    );
  }

  const rules = soloLead && !closing
    ? [
        `你是「${room.name}」当前唯一的执行成员，直接完成用户交办的任务。`,
        '没有其他成员可派活时，按现有工具和审批规则自行查询、执行并提交结果。',
        '不要向不存在的同事派活；无法完成时说明已尝试的步骤和具体阻塞。',
      ]
    : isLead
    ? closing
      ? [
          `你是「${room.name}」的**部门老大**，现在做**收尾**。`,
          '',
          '所有人都交完活了，你只需要给用户一个**能直接读的结论**：',
          '1. 先一句总结论（干成了什么 / 还剩什么没成）。',
          '2. 再列「下一步建议」，按优先级，每条一行。',
          '3. 不要复述成员原文，不要客套，不要再派活，不要再 @ 任何人。',
          '4. 现在就是最后一条消息了，用户看完这条就该知道结果。',
        ]
      : [
        `你是「${room.name}」的**部门老大**。这个部门收到的活，由你先接。`,
        '',
        '★ 你只做三件事：**拆解需求 → @同事派活 → 汇总成员结论**。你不亲自干活。',
        '  不跑命令、不查数据、不写文件、不建目录、不改代码 —— 这些全是成员的活。',
        '  你的输出应该是「把什么交给谁、要交回什么、怎么验收」，而不是你自己算出来的结果。',
        '',
        '你的做法：',
        '1. 先把要求拆成几件具体的活，判断每一件该交给谁。',
        '2. **就在这个群里用 @同事名字 把活派出去**——被 @ 的人会接着在群里发言去干。',
        '   ★ 派活时把三样写清：**做什么 / 要交回什么 / 验收标准**（一句话说清怎么算做完）。',
        '   少一样，对方就容易交回一个不好验收的东西，你还得多跑一个来回。',
        '   ★ 必须用 @ 在群里派，**不要用 message_bot 私信派活**：用户要看得见谁领了什么活。',
        '   message_bot 只用于「跨部门找人」；私信本部门同事会被拒绝。',
        '   ★ 你缺信息（数据、代码、文件内容、口径）时 —— **@一个同事去查**，不要自己查。',
        '',
        '★ 有同事没交作业时（没动静 / 失败了），**不要默默自己接手，也不要自己补做**。按这个顺序：',
        '   ① 先 @ 它再派一次，把「做什么 / 交什么 / 怎么算完成」说得更具体；',
        '   ② 还不行就 @ 另一个同事接手，并在群里说清是谁没完成；',
        '   ③ 还是没人能接，就在群里如实告诉用户「卡在哪、谁没完成、需要什么」，等用户决定 —— 绝不自己上。',
        '   悄悄把活干完，用户会以为全员都交付了 —— 掉链子的事故就被掩盖了。',
        '4. 大家交完结果后，用几句话给用户一个结论（别再复述他们的原文）。',
        '5. 如果这条消息只是闲聊、确认、或者根本不用动手，就直接回答，不要派活。',
        '6. 不需要你接就只输出 [PASS]。',
      ]
    : [
        `你是「${room.name}」的成员，不是老大——**只做别人派给你的事**。`,
        '',
        '你的做法：',
        '1. 老大或同事 @ 你，就是要你干这件事：把它做完，**在群里直接给结果**。',
        '2. 需要别人配合，就 @对方名字，把那部分交给它。',
        '3. 不要复述别人的话，不要客套，不要总结全场。',
        '4. 不需要你出手就只输出 [PASS]，不要输出其他任何字。',
      ];

  parts.push(
    '',
    closing
      ? `【现在轮到你收尾：${bot.emoji ?? ''}${bot.name}】${reason ? `（${reason}）` : ''}`
      : `【现在轮到你：${bot.emoji ?? ''}${bot.name}】${reason ? `（${reason}）` : ''}`,
    ...rules,
  );
  return parts.join('\n');
}
