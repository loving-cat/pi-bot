/**
 * 内存态 + 落盘持久化。
 *
 * 数据模型（v2）：
 *   bots   花名册。每个 bot 有 persona / model / thinking / role。
 *          role = "main" 的是主控（superroot），唯一，能建群、造 bot、派活。
 *   rooms  会话。kind = "dm"（一对一）| "group"（群，多个 bot，有一个 leadBotId 负责接话）
 *   devices 手机端配对出来的 token
 *
 * 落盘：
 *   state.json        设备 / bot / 房间 / 每个会话的 sessionFile
 *   rooms/<id>.json   房间消息
 */
import path from 'node:path';
import { config } from './config.js';
import { bus } from './bus.js';
import { newId, now, readJson, writeJsonAtomic } from './util.js';

const STATE_FILE = path.join(config.dataDir, 'state.json');
const ROOMS_DIR = path.join(config.dataDir, 'rooms');
const STATE_VERSION = 2;

export const MAIN_BOT_ID = 'chief';

/** 主控的默认人设 */
export const MAIN_PERSONA = [
  '你是 pi-bot 的主控（superroot），用户唯一直接对话的对象。',
  '',
  '你的职责是「指挥」，不是「动手」：',
  '1. 听懂用户想要什么，把大任务拆成可执行的活。',
  '2. 用户说「建个团队 / 拉几个人 / 多角色协作」→ 用 create_team 一次搞定（造 N 个有名字有分工的 bot + 建群 + 拉人 + 发开工说明）。',
  '   单独造一个专才用 create_bot；单独建群用 create_group。',
  '3. 每个 bot 都必须有独立的名字、emoji、人设，模型和思考等级按分工分别选，不要都用一个模型。',
  '4. 派活用 ask_bot，它会真的让那个 bot 独立跑一轮，并把它的回复发到群里，用户能直接看到。',
  '',
  '★ 你手上只有只读文件工具（read / ls / grep / find），没有 bash、不能写文件。',
  '  这意味着你没法自己写代码、跑命令、装依赖。这是故意的：需要动手就造 bot 派活。',
  '  不要反复试探性地调工具确认环境——直接派活，让干活的 bot 去确认。',
  '',
  '选模型（硬性白名单，只能从这 4 个里挑，其他一律不许用）：',
  '  · ds-4.1-flash    DeepSeek V4.1 Flash —— 写代码/改文件/跑命令的主力，大部分活用它',
  '  · glm-5.3         GLM 5.3 —— 通用中文活、性价比高',
  '  · kimi-k3         Kimi K3 —— 长文档、方案、写作、复杂推理',
  '  · glm-5.3-flash   GLM 5.3 Flash —— 简单批量、格式转换，省钱',
  '  ★ 严禁选 kimi-k2.5、glm-5/5.1、deepseek-v4-pro、minimax、amd 之类的一切其他模型。',
  '  ★ 思考等级：深度推理/架构决策用 high 或 max；写代码用 medium；简单活用 low 或 off。',
  '  ★ list_models 一轮只调一次。模型写别名（如 ds-4.1-flash）或完整 slug 都行。',
  '',
  '风格：直接、简短、不废话。先说结论再说过程。不要复述用户的指令。',
  '一次派活之后，用一两句话总结结果，不要把对方的长篇输出再抄一遍。',
].join('\n');

export class Store {
  constructor() {
    const saved = readJson(STATE_FILE, null);
    this.state = saved?.version === STATE_VERSION ? saved : this.#seed();
    if (!this.state.sessions) this.state.sessions = {};
    /** @type {Map<string, any[]>} roomId -> messages */
    this.messages = new Map();
    for (const room of Object.values(this.state.rooms)) {
      this.messages.set(room.id, this.#loadRoomMessages(room.id));
    }
    this.saveTimer = null;
  }

  #seed() {
    const chief = {
      id: MAIN_BOT_ID,
      name: 'Pi',
      emoji: 'π',
      role: 'main',
      persona: MAIN_PERSONA,
      model: null,
      thinking: config.thinking,
      enabled: true,
      createdAt: now(),
      createdBy: 'system',
    };
    const dm = {
      id: 'dm_chief',
      kind: 'dm',
      name: chief.name,
      topic: '',
      botIds: [chief.id],
      leadBotId: chief.id,
      createdAt: now(),
      lastMessageAt: now(),
    };
    return {
      version: STATE_VERSION,
      serverName: config.serverName,
      devices: {},
      bots: { [chief.id]: chief },
      rooms: { [dm.id]: dm },
      sessions: {},
    };
  }

  #loadRoomMessages(roomId) {
    const list = readJson(path.join(ROOMS_DIR, `${roomId}.json`), []);
    return Array.isArray(list) ? list.slice(-config.maxMessagesPerRoom) : [];
  }

  // ---------- 持久化 ----------

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
  }

  saveNow() {
    writeJsonAtomic(STATE_FILE, this.state);
    for (const [roomId, list] of this.messages) {
      writeJsonAtomic(path.join(ROOMS_DIR, `${roomId}.json`), list);
    }
  }

  // ---------- 设备 ----------

  addDevice(name) {
    const token = newId('t_') + newId('');
    const device = {
      id: newId('d_'),
      name: String(name || '未命名设备').slice(0, 60),
      createdAt: now(),
      lastSeenAt: now(),
    };
    this.state.devices[token] = device;
    this.scheduleSave();
    return { token, device };
  }

  findDeviceByToken(token) {
    return this.state.devices[token] ?? null;
  }

  /** 已配对的远程设备（token 只给前几位预览） */
  listDevices() {
    return Object.entries(this.state.devices)
      .map(([token, d]) => ({ ...d, tokenPreview: `${token.slice(0, 10)}…`, token }))
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  }

  revokeDevice(token) {
    if (!this.state.devices[token]) return false;
    delete this.state.devices[token];
    this.scheduleSave();
    bus.emit('event', { t: 'device.revoked', token });
    return true;
  }

  touchDevice(token) {
    const d = this.state.devices[token];
    if (d) {
      d.lastSeenAt = now();
      this.scheduleSave();
    }
  }

  // ---------- Bot 花名册 ----------

  listBots() {
    const bots = Object.values(this.state.bots);
    // 主控永远排第一
    return bots.sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
  }

  getBot(id) {
    return this.state.bots[id] ?? null;
  }

  mainBot() {
    return this.listBots().find((b) => b.role === 'main') ?? null;
  }

  createBot(patch = {}) {
    const bot = {
      id: newId('b_'),
      name: String(patch.name || '新 Bot').slice(0, 40),
      emoji: patch.emoji || '🤖',
      role: patch.role === 'main' ? 'member' : 'member',
      persona: String(patch.persona || '').slice(0, 4000),
      model: patch.model || null,
      thinking: patch.thinking || config.thinking,
      enabled: true,
      createdAt: now(),
      createdBy: patch.createdBy || null,
    };
    this.state.bots[bot.id] = bot;
    this.scheduleSave();
    // 像加好友一样：造出来的 bot 自动开一个私聊窗口
    this.ensureDm(bot.id);
    bus.emit('event', { t: 'bot.updated', bot });
    return bot;
  }

  updateBot(id, patch = {}) {
    const bot = this.state.bots[id];
    if (!bot) return null;
    const next = { ...bot };
    if (patch.name !== undefined) next.name = String(patch.name).slice(0, 40);
    if (patch.emoji !== undefined) next.emoji = String(patch.emoji).slice(0, 8);
    if (patch.persona !== undefined) next.persona = String(patch.persona).slice(0, 4000);
    if (patch.model !== undefined) next.model = patch.model || null;
    if (patch.thinking !== undefined) next.thinking = patch.thinking || config.thinking;
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    this.state.bots[id] = next;

    // DM 房间名跟着 bot 名走
    for (const room of Object.values(this.state.rooms)) {
      if (room.kind === 'dm' && room.botIds[0] === id) {
        room.name = next.name;
        bus.emit('event', { t: 'room.updated', room: this.roomSummary(room) });
      }
    }
    this.scheduleSave();
    bus.emit('event', { t: 'bot.updated', bot: next });
    return next;
  }

  deleteBot(id) {
    const bot = this.state.bots[id];
    if (!bot || bot.role === 'main') return null;
    delete this.state.bots[id];
    for (const room of Object.values(this.state.rooms)) {
      if (room.kind === 'dm' && room.botIds[0] === id) {
        delete this.state.rooms[room.id];
        this.messages.delete(room.id);
        bus.emit('event', { t: 'room.deleted', roomId: room.id });
      } else if (room.botIds.includes(id)) {
        room.botIds = room.botIds.filter((b) => b !== id);
        if (room.leadBotId === id) room.leadBotId = room.botIds[0] ?? null;
        bus.emit('event', { t: 'room.updated', room: this.roomSummary(room) });
      }
    }
    for (const key of Object.keys(this.state.sessions)) {
      if (key.endsWith(`:${id}`)) delete this.state.sessions[key];
    }
    this.scheduleSave();
    bus.emit('event', { t: 'bot.deleted', botId: id });
    return { id };
  }

  // ---------- 房间 ----------

  listRooms() {
    const rooms = Object.values(this.state.rooms);
    const mainId = this.mainBot()?.id;
    return rooms.sort((a, b) => {
      // 主控 DM 置顶
      const aPin = a.kind === 'dm' && a.botIds[0] === mainId ? 1 : 0;
      const bPin = b.kind === 'dm' && b.botIds[0] === mainId ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      return (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
    });
  }

  getRoom(id) {
    return this.state.rooms[id] ?? null;
  }

  /** 拿到（或新建）与某个 bot 的 DM */
  ensureDm(botId) {
    const bot = this.getBot(botId);
    if (!bot) return null;
    const existing = Object.values(this.state.rooms).find(
      (r) => r.kind === 'dm' && r.botIds.length === 1 && r.botIds[0] === botId,
    );
    if (existing) return existing;
    const room = {
      id: newId('dm_'),
      kind: 'dm',
      name: bot.name,
      topic: '',
      botIds: [botId],
      leadBotId: botId,
      createdAt: now(),
      lastMessageAt: now(),
      cursors: {},
    };
    this.state.rooms[room.id] = room;
    this.messages.set(room.id, []);
    this.scheduleSave();
    bus.emit('event', { t: 'room.created', room: this.roomSummary(room) });
    return room;
  }

  createGroup({ name, topic = '', botIds = [], leadBotId = null, createdBy = null }) {
    const main = this.mainBot();
    const members = [...new Set(botIds.filter((id) => this.state.bots[id]))];
    // 部门就是部门：只有没人时才把主控放进来兜底（主控是总经理，不是部门成员）
    if (main && members.length === 0) members.push(main.id);

    const leadCandidates = members.filter((id) => id !== main?.id);
    const lead =
      leadBotId && members.includes(leadBotId)
        ? leadBotId
        : (leadCandidates[0] ?? members[0] ?? null);

    const room = {
      id: newId('r_'),
      kind: 'group',
      name: String(name || '新部门').slice(0, 60),
      topic: String(topic || '').slice(0, 500),
      botIds: members,
      leadBotId: lead,
      createdAt: now(),
      lastMessageAt: now(),
      createdBy,
      cursors: {},
    };
    this.state.rooms[room.id] = room;
    this.messages.set(room.id, []);
    this.scheduleSave();
    bus.emit('event', { t: 'room.created', room: this.roomSummary(room) });
    return room;
  }

  updateRoom(id, patch = {}) {
    const room = this.state.rooms[id];
    if (!room) return null;
    if (patch.name !== undefined) room.name = String(patch.name).slice(0, 60);
    if (patch.topic !== undefined) room.topic = String(patch.topic).slice(0, 500);
    if (patch.leadBotId !== undefined && room.botIds.includes(patch.leadBotId)) room.leadBotId = patch.leadBotId;
    if (patch.botIds !== undefined) {
      room.botIds = [...new Set(patch.botIds.filter((b) => this.state.bots[b]))];
      if (!room.botIds.includes(room.leadBotId)) room.leadBotId = room.botIds[0] ?? null;
    }
    this.scheduleSave();
    bus.emit('event', { t: 'room.updated', room: this.roomSummary(room) });
    return room;
  }

  deleteRoom(id) {
    const room = this.state.rooms[id];
    if (!room || room.kind === 'dm') return null;
    delete this.state.rooms[id];
    this.messages.delete(id);
    for (const key of Object.keys(this.state.sessions)) {
      if (key.startsWith(`${id}:`)) delete this.state.sessions[key];
    }
    this.scheduleSave();
    bus.emit('event', { t: 'room.deleted', roomId: id });
    return { id };
  }

  // ---------- 会话文件 ----------

  sessionFileFor(roomId, botId) {
    return this.state.sessions[`${roomId}:${botId}`] ?? null;
  }

  setSessionFile(roomId, botId, file) {
    this.state.sessions[`${roomId}:${botId}`] = file;
    this.scheduleSave();
  }

  clearSessionFile(roomId, botId) {
    delete this.state.sessions[`${roomId}:${botId}`];
    this.scheduleSave();
  }

  // ---------- 消息 ----------

  listMessages(roomId, { limit = 100 } = {}) {
    return (this.messages.get(roomId) ?? []).slice(-limit);
  }

  getMessage(roomId, messageId) {
    return (this.messages.get(roomId) ?? []).find((m) => m.id === messageId) ?? null;
  }

  appendMessage(partial, { silent = false } = {}) {
    const roomId = partial.roomId;
    if (!this.messages.has(roomId)) this.messages.set(roomId, []);
    const msg = {
      id: partial.id || newId('m_'),
      roomId,
      authorType: partial.authorType || 'system',
      authorId: partial.authorId || null,
      authorName: partial.authorName || '',
      authorEmoji: partial.authorEmoji ?? null,
      text: partial.text ?? '',
      status: partial.status || 'done',
      attachments: partial.attachments ?? [],
      steps: partial.steps ?? [],
      usage: partial.usage ?? null,
      error: partial.error ?? null,
      meta: partial.meta ?? null,
      createdAt: partial.createdAt ?? now(),
      updatedAt: now(),
    };
    const list = this.messages.get(roomId);
    list.push(msg);
    if (list.length > config.maxMessagesPerRoom) list.splice(0, list.length - config.maxMessagesPerRoom);
    const room = this.state.rooms[roomId];
    if (room) room.lastMessageAt = msg.createdAt;
    this.scheduleSave();
    if (!silent) bus.emit('event', { t: 'msg.new', msg });
    return msg;
  }

  updateMessage(roomId, messageId, patch, { silent = false } = {}) {
    const msg = this.getMessage(roomId, messageId);
    if (!msg) return null;
    Object.assign(msg, patch, { updatedAt: now() });
    this.scheduleSave();
    if (!silent) bus.emit('event', { t: 'msg.updated', msg });
    return msg;
  }

  reapStaleStreaming() {
    let n = 0;
    for (const [, list] of this.messages) {
      for (const msg of list) {
        if (msg.status === 'streaming') {
          msg.status = msg.text ? 'done' : 'error';
          if (!msg.text) msg.error = '服务端重启，本轮中断';
          msg.updatedAt = now();
          n++;
        }
      }
    }
    if (n) this.saveNow();
    return n;
  }

  roomSummary(room) {
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
  }

  // ---------- 群消息游标（每个 bot 在群里看到哪了）----------

  seenCursor(roomId, botId) {
    return this.state.rooms[roomId]?.cursors?.[botId] ?? null;
  }

  setCursor(roomId, botId, messageId) {
    const room = this.state.rooms[roomId];
    if (!room || !messageId) return;
    if (!room.cursors) room.cursors = {};
    room.cursors[botId] = messageId;
    this.scheduleSave();
  }

  /** 删除一条消息（用于 [PASS] 这种占位） */
  deleteMessage(roomId, messageId) {
    const list = this.messages.get(roomId);
    if (!list) return false;
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.scheduleSave();
    bus.emit('event', { t: 'msg.deleted', roomId, msgId: messageId });
    return true;
  }

  stats() {
    let total = 0;
    for (const list of this.messages.values()) total += list.length;
    return {
      rooms: Object.keys(this.state.rooms).length,
      bots: Object.keys(this.state.bots).length,
      devices: Object.keys(this.state.devices).length,
      messages: total,
    };
  }
}

export const store = new Store();
