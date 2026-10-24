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
  out.droppedCount = dropped;
  return out;
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
 * 某个作者集合"最近一条已完成发言"的位置（用消息在房间里的序号表示）。
 *
 * 为什么要有这个而不是直接传消息数组：收尾判定只关心"谁什么时候说的"，
 * 拿数组就得猜要多大的窗口 —— 窗口小会漏（一轮超 50 条就判错），
 * 窗口大又会把上一轮的消息带进来。这里直接按作者集合查最后位置，O(n) 但无窗口。
 *
 * @returns {number} 位置（越大越新）；没有发言过返回 -1
 */
export function lastDoneIndexOf(roomId, authorIds = []) {
  const set = new Set(authorIds);
  if (!set.size) return -1;
  const list = store.listMessages(roomId, { limit: 100000 });
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.status !== 'done') continue; // 失败的消息不算"说过话"
    if (m.authorType !== 'bot') continue;
    if (set.has(m.authorId)) return i;
  }
  return -1;
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
    '规则：写「@同事名字」就是把发言权交给它（它会接着说话、去干你派的活）；',
    '只写名字不带 @ 就只是提到它，不会触发它发言。',
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
