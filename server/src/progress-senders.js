/** 根据明确的消息或调度关联规划回执来源补全；不通过正文或消息相邻关系推断。 */

const textId = (value) => typeof value === 'string' ? value.trim() : '';

function senderOf(meta = {}) {
  const fromId = textId(meta.fromId);
  const fromName = textId(meta.fromName);
  return fromId && fromName ? { fromId, fromName } : null;
}

function precedes(source, receipt) {
  return Number.isFinite(source.createdAt) && source.createdAt > 0 &&
    Number.isFinite(receipt.createdAt) && source.createdAt <= receipt.createdAt;
}

function compatible(meta, sender) {
  return (!textId(meta.fromId) || textId(meta.fromId) === sender.fromId) &&
    (!textId(meta.fromName) || textId(meta.fromName) === sender.fromName);
}

function sourceSender(receipt, messagesByRoom) {
  const meta = receipt.meta ?? {};
  const sourceId = textId(meta.sourceMessageId);
  const roomId = textId(meta.fromRoomId);
  if (!sourceId || !roomId) return null;
  const matches = (messagesByRoom.get(roomId) ?? []).filter((m) => m.id === sourceId);
  if (matches.length !== 1) return null;
  const source = matches[0];
  if (source.roomId !== roomId || source.status !== 'done' ||
      !['bot', 'user'].includes(source.authorType) ||
      !precedes(source, receipt) || source.authorId === receipt.authorId) return null;
  const sender = senderOf({ fromId: source.authorId, fromName: source.authorName });
  return sender && compatible(meta, sender)
    ? { ...sender, sourceMessageId: sourceId }
    : null;
}

function dispatchKey(receipt) {
  const meta = receipt.meta ?? {};
  const parts = [meta.fromRoomId, receipt.authorId, meta.dispatchId].map(textId);
  return parts.every(Boolean) ? JSON.stringify(parts) : null;
}

function startSender(start, messagesByRoom) {
  const meta = start.meta ?? {};
  if (textId(meta.sourceMessageId)) return sourceSender(start, messagesByRoom);
  const sender = senderOf(meta);
  return sender && sender.fromId !== start.authorId ? sender : null;
}

/**
 * @param {{rooms: object[], messagesByRoom: Map<string, object[]>}} input
 * @returns {{roomId: string, messageId: string, meta: object}[]}
 * 完整来源保持原样；缺失来源仅接受有效 sourceMessageId 或唯一的同房间、同执行员调度关联。
 */
export function planProgressSenderBackfill({ rooms = [], messagesByRoom = new Map() } = {}) {
  const patches = [];
  for (const room of rooms) {
    if (room.kind !== 'dm') continue;
    const receipts = (messagesByRoom.get(room.id) ?? []).filter(
      (m) => m.roomId === room.id && m.meta?.progress === true,
    );
    const starts = new Map();
    for (const receipt of receipts) {
      if (receipt.meta.phase !== 'start') continue;
      const key = dispatchKey(receipt);
      if (!key) continue;
      const group = starts.get(key) ?? [];
      group.push(receipt);
      starts.set(key, group);
    }
    for (const receipt of receipts) {
      const meta = receipt.meta;
      if (!['start', 'done'].includes(meta.phase) || senderOf(meta)) continue;
      let sender = null;
      if (textId(meta.sourceMessageId)) {
        sender = sourceSender(receipt, messagesByRoom);
      } else if (meta.phase === 'done') {
        const candidates = starts.get(dispatchKey(receipt)) ?? [];
        if (candidates.length === 1 && precedes(candidates[0], receipt)) {
          sender = startSender(candidates[0], messagesByRoom);
        }
      }
      if (!sender || !compatible(meta, sender)) continue;
      patches.push({
        roomId: room.id,
        messageId: receipt.id,
        meta: { ...meta, ...sender },
      });
    }
  }
  return patches;
}
