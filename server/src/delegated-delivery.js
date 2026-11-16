/**
 * 派活的**交付落点**（规格之外，产品决定 2026-11-16）。
 *
 * ## 问题
 *
 * `message_bot` 派活时，执行用的房间是 `dm.<成员>` —— 也就相当于
 * **成员在自己的私聊里跟用户说话**。于是同一件事用户会看到两遍：
 *
 *   1. 成员私聊里：它说的话、它发的图（过程 + 交付物）；
 *   2. 派活人的私聊里：又总结一遍。
 *
 * 而第一处**没有上下文**：那里没有用户说的话（是模型写的工作说明书），
 * 所以打开就是一堵自言自语。
 *
 * ## 决定
 *
 * 消息出现在哪个房间，应该跟"谁在跟你说话"一致：
 *
 * | 情形 | 落在哪 |
 * |---|---|
 * | 用户直接问某个 bot | 那个 bot 的私聊 |
 * | 某个 bot 被派活 | **派活的那个房间**，作者是干活的 bot |
 *
 * 所以这里做两件事：
 *
 *   1. 把这次执行的产出（最终答复 + 附件）**搬到派活房间**；
 *   2. 把成员那边的那一份标成 `internal`（还在磁盘/接口里可查，但默认不推给用户）。
 *
 * ## 为什么"搬"而不是"复制"
 *
 * 附件是**按 id 引用**的（文件本身只有一份）。所以这里只把 attachment id
 * 挂到新消息上，不复制文件、也不重新上传 —— 搬完两边引用的是同一份。
 *
 * ## 这个文件只算"该搬什么"，不碰 store
 *
 * 纯函数：给一批消息 + 时间窗 + 干活的人 → 算出最终答复和附件。
 * 落盘在 `mirrorDelegatedResult`，那一步很薄，一眼能看完。
 */

/**
 * 从一段消息里挑出"这次执行的交付物"。
 *
 * 挑的规则：
 *   · 只看**这个 bot** 在**这个时间窗之后**写的（防止把上一轮的旧东西带上）；
 *   · 跳过 `ref` 这类内部指针消息（它们描述"发了私信"，不是内容）；
 *   · 最终答复 = 最后一条有正文的 bot 消息；
 *   · 附件 = 时间窗内所有消息上的附件，按 id 去重、保持出现顺序。
 *
 * @param {object} p
 * @param {Array} p.messages 该房间的全部消息（按时间序）
 * @param {string} p.workerId
 * @param {number} p.since 时间窗起点（本次执行开始的时间戳）
 * @param {string} [p.finalText] 运行结果里的最终正文（优先用它，它比消息更完整）
 * @returns {{text:string, attachments:Array, picked:number}}
 */
export function collectDelegatedArtifacts({ messages = [], workerId = '', since = 0, finalText = '' } = {}) {
  const wid = String(workerId ?? '');
  const from = Number(since) || 0;
  const mine = (Array.isArray(messages) ? messages : []).filter(
    (m) =>
      m &&
      m.authorId === wid &&
      m.authorType === 'bot' &&
      Number(m.createdAt ?? 0) >= from &&
      m.kind !== 'ref' &&
      m.kind !== 'compact',
  );

  const attachments = [];
  const seen = new Set();
  for (const m of mine) {
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
      if (!a?.id || seen.has(a.id)) continue;
      seen.add(a.id);
      attachments.push(a);
    }
  }

  // 最终答复：运行结果里的正文更完整（消息可能被流式截断/改写）
  const fromResult = String(finalText ?? '').trim();
  if (fromResult) return { text: fromResult, attachments, picked: mine.length };

  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const t = String(mine[i].text ?? '').trim();
    if (t) return { text: t, attachments, picked: mine.length };
  }
  return { text: '', attachments, picked: mine.length };
}

/**
 * 把交付物搬到派活房间，并把成员那边标成 internal。
 *
 * @param {object} p
 * @param {object} p.store
 * @param {string} p.callerRoomId 派活的房间（用户看的那一处）
 * @param {string} p.workerRoomId 成员私聊（执行发生的地方）
 * @param {object} p.worker 干活的 bot（`{id, name, emoji}`）
 * @param {string} p.callerId 派活的人（bot id）
 * @param {number} p.since
 * @param {string} [p.finalText]
 * @returns {{messageId:string|null, attachments:number, marked:number, text:string}}
 */
export function mirrorDelegatedResult({
  store, callerRoomId, workerRoomId, worker, callerId, since, finalText = '',
} = {}) {
  const empty = { messageId: null, attachments: 0, marked: 0, text: '' };
  if (!store || !callerRoomId || !workerRoomId || !worker?.id) return empty;

  const inWorkerRoom = store.listMessages?.(workerRoomId, { limit: 500 }) ?? [];
  const art = collectDelegatedArtifacts({
    messages: inWorkerRoom,
    workerId: worker.id,
    since,
    finalText,
  });

  // ① 成员那边那一份标成 internal：内容还在，但默认不推给用户（避免两处重复）。
  let marked = 0;
  for (const m of inWorkerRoom) {
    if (!m || m.authorId !== worker.id || m.authorType !== 'bot') continue;
    if (Number(m.createdAt ?? 0) < Number(since || 0)) continue;
    if (m.kind === 'ref' || m.kind === 'compact') continue;
    if (m.meta?.internal === true) continue;
    store.updateMessage?.(workerRoomId, m.id, { meta: { ...(m.meta ?? {}), internal: true } }, { silent: true });
    marked += 1;
  }

  // ② 派活房间收到一条"作者是干活的人"的交付消息。
  if (!art.text && !art.attachments.length) return { ...empty, marked };
  const msg = store.appendMessage?.({
    roomId: callerRoomId,
    authorType: 'bot',
    authorId: worker.id,
    authorName: worker.name ?? worker.id,
    authorEmoji: worker.emoji ?? null,
    kind: 'delegated',
    text: art.text,
    attachments: art.attachments,
    status: 'done',
    meta: { via: 'message_bot', delegated: true, from: callerId },
  });
  return {
    messageId: msg?.id ?? null,
    attachments: art.attachments.length,
    marked,
    text: art.text,
  };
}
