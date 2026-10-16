const fs = require('fs');
const p = 'src/store.js';
let s = fs.readFileSync(p, 'utf8');

// 1) 只写「脏」房间，不要每次变更都把 20 个房间全量重写
s = s.replace(
  `    this.saveTimer = null;
  }`,
  `    this.saveTimer = null;
    /** 有变更的房间 id —— 落盘时只写这些，不要全量重写 */
    this.dirtyRooms = new Set();
  }`,
  1,
);

s = s.replace(
  `  saveNow() {
    writeJsonAtomic(STATE_FILE, this.state);
    for (const [roomId, list] of this.messages) {
      writeJsonAtomic(path.join(ROOMS_DIR, \`\${roomId}.json\`), list);
    }
  }`,
  `  saveNow() {
    writeJsonAtomic(STATE_FILE, this.state);
    // 只写有变更的房间：之前是每次变更都把全部房间重写一遍，
    // 房间一多（每个群 500 条消息）就是纯浪费。
    for (const roomId of this.dirtyRooms) {
      writeJsonAtomic(path.join(ROOMS_DIR, \`\${roomId}.json\`), this.messages.get(roomId) ?? []);
    }
    this.dirtyRooms.clear();
  }`,
);

// 2) 所有改动消息的地方都标脏
s = s.replace(
  `    const list = this.messages.get(roomId);
    list.push(msg);
    if (list.length > config.maxMessagesPerRoom) list.splice(0, list.length - config.maxMessagesPerRoom);`,
  `    const list = this.messages.get(roomId);
    list.push(msg);
    if (list.length > config.maxMessagesPerRoom) list.splice(0, list.length - config.maxMessagesPerRoom);
    this.dirtyRooms.add(roomId);`,
);
s = s.replace(
  `    Object.assign(msg, patch, { updatedAt: now() });
    this.scheduleSave();`,
  `    Object.assign(msg, patch, { updatedAt: now() });
    this.dirtyRooms.add(roomId);
    this.scheduleSave();`,
);
s = s.replace(
  `    list.splice(idx, 1);
    this.scheduleSave();`,
  `    list.splice(idx, 1);
    this.dirtyRooms.add(roomId);
    this.scheduleSave();`,
);
s = s.replace(
  `          msg.updatedAt = now();
          n++;`,
  `          msg.updatedAt = now();
          this.dirtyRooms.add(roomId);
          n++;`,
);
s = s.replace(
  `    this.state.rooms[room.id] = room;
    this.messages.set(room.id, []);
    this.scheduleSave();`,
  `    this.state.rooms[room.id] = room;
    this.messages.set(room.id, []);
    this.dirtyRooms.add(room.id);
    this.scheduleSave();`,
);

// 3) roomSummary 不要为了取最后一条和总数各 slice 一次
s = s.replace(
  `  roomSummary(room) {
    const messages = this.listMessages(room.id, { limit: 1 });
    const lead = this.state.bots[room.leadBotId];
    return {
      ...room,
      leadName: lead?.name ?? null,
      leadEmoji: lead?.emoji ?? null,
      botNames: room.botIds.map((id) => this.state.bots[id]?.name).filter(Boolean),
      lastMessage: messages[0] ?? null,
      messageCount: (this.messages.get(room.id) ?? []).length,
    };
  }`,
  `  roomSummary(room) {
    // 直接读数组尾部/长度，避免两次 slice(-1)/(-500)
    const list = this.messages.get(room.id) ?? [];
    const lead = this.state.bots[room.leadBotId];
    return {
      ...room,
      leadName: lead?.name ?? null,
      leadEmoji: lead?.emoji ?? null,
      botNames: room.botIds.map((id) => this.state.bots[id]?.name).filter(Boolean),
      lastMessage: list.length ? list[list.length - 1] : null,
      messageCount: list.length,
    };
  }`,
);

// 4) listMessages 别对空数组做 slice
s = s.replace(
  `  listMessages(roomId, { limit = 100 } = {}) {
    return (this.messages.get(roomId) ?? []).slice(-limit);
  }`,
  `  listMessages(roomId, { limit = 100 } = {}) {
    const list = this.messages.get(roomId);
    if (!list || list.length === 0) return [];
    return list.length <= limit ? list.slice() : list.slice(-limit);
  }`,
);

fs.writeFileSync(p, s);
console.log('store.js 性能补丁完成');
