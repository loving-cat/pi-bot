import { planProgressSenderBackfill } from './progress-senders.js';

/** 读取消息快照并应用有明确来源关联的回执补全；不改动已有完整来源与任务结果。 */
export function backfillProgressSenders(store) {
  const rooms = store.listRooms();
  const messagesByRoom = new Map();
  const sourceRooms = new Set();
  for (const room of rooms) {
    if (room.kind !== 'dm') continue;
    const messages = store.listMessages(room.id, { limit: Number.MAX_SAFE_INTEGER });
    messagesByRoom.set(room.id, messages);
    for (const message of messages) {
      if (message.meta?.progress === true && typeof message.meta.fromRoomId === 'string') {
        sourceRooms.add(message.meta.fromRoomId);
      }
    }
  }
  for (const roomId of sourceRooms) {
    if (!messagesByRoom.has(roomId)) {
      messagesByRoom.set(roomId, store.listMessages(roomId, { limit: Number.MAX_SAFE_INTEGER }));
    }
  }
  const patches = planProgressSenderBackfill({ rooms, messagesByRoom });
  let fixed = 0;
  for (const patch of patches) {
    if (store.updateMessage(patch.roomId, patch.messageId, { meta: patch.meta }, { silent: true })) {
      fixed++;
    }
  }
  return fixed;
}
