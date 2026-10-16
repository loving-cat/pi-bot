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
import { newId, now, readJson, writeJsonAtomic, insertionPoint } from './util.js';

const STATE_FILE = path.join(config.dataDir, 'state.json');
const ROOMS_DIR = path.join(config.dataDir, 'rooms');
const STATE_VERSION = 2;

/** 正整数字符串/数字 → 正整数；其他（含空、null、负数、小数）→ null（= 用上层默认） */
/**
 * 群聊的"轮次预算"默认值。
 *
 * 为什么要有这层：这几个数以前只写在环境变量里（config.groupTurns*），
 * 但它们是**用户会想按群调的东西** —— 有的群就是需要多来几轮，有的群
 * 吵起来没完。所以搬到 store 里（落盘 + 能改），config 只当默认值。
 *
 * 目的很实际：**防止 bot 解不了就互相聊个没完**。
 */
export const GROUP_LIMITS_DEFAULT = {
  /** 部门老大每次发言最多跑几轮 */
  leadTurns: 4,
  /** 普通成员每次发言最多跑几轮 */
  memberTurns: 2,
  /** 一条用户消息最多触发几次 bot 运行（防无限互吹） */
  maxRuns: 10,
  /** 部门里单次最多**来回几轮**（对话轮次，不是工具调用次数） */
  maxSteps: 30,
  /** 部门单轮最长跑多久（毫秒） */
  turnMaxMs: 300_000,
};

function positiveIntOrDefault(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function positiveOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * 把 avatar 颜色统一成 `#RRGGBB`。
 * 接受 `#E93D82` / `e93d82` / `#e93`；非法输入返回 null（= 让客户端按 id 自己算）。
 */
function normalizeHex(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().replace(/^#/, '');
  const full = /^[0-9a-fA-F]{3}$/.test(s)
    ? s.split('').map((c) => c + c).join('')
    : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return `#${full.toUpperCase()}`;
}

export const MAIN_BOT_ID = 'chief';

/** 主控（总经理）的默认人设 */
export const MAIN_PERSONA = [
  // ★ 这里刻意**不写"总经理"这个词来定义它自己**。
  //   写过，结果它回给用户的第一句话是"我是你的总经理" —— 而用户给它的名字
  //   才是我（用户原话："所有 bot 都要用用户给他命名的名字自称，其次是负责
  //   的内容"）。角色怎么理解归角色，自称必须用自己的名字。
  '你直接对用户负责——用户只跟你一个人对接。活交给谁、盯着谁、什么时候给交代，都是你说了算。',
  '',
  '【组织架构】',
  '  · 你 = 全队的总负责人：听懂用户要什么，决定该交给哪个部门/哪个人，盯着结果，给用户交代。',
  '    （这些是内部角色词，方便你自己搞清楚结构；对外永远用自己的名字自称）',
  '  · 部门（群）= 一群专才，每个部门有一个**部门老大**。',
  '  · 部门老大：用户往部门里发指令时由它先接，负责拆活、@ 成员、汇总。',
  '  · 成员：只做被派到的事，可以 @ 同事协作。',
  '',
  '【你的职责】',
  '1. 用户提需求 → 判断这事该谁干：',
  '   · 已有合适部门 → dispatch_to_department 下达任务，部门老大接着接单。',
  '   · 没有合适的人 → create_department 一次建好（造人 + 建部门 + 指定老大 + 发开工说明），或 create_bot 招一个人。',
  '   · 一件小事只找一个人 → message_bot。',
  '2. 用户问进展 → read_department 去看，然后给用户一个结论。',
  '3. 用户对部门结果不满意 → 带着具体要求再 dispatch_to_department，别自己去干。',
  '',
  '【建部门的关键】',
  '  · 每个成员必须有独立的名字、emoji、人设，职责不能重叠。',
  '  · **一定要指定部门老大**（lead 参数），选最有统筹能力、懂全局的那个人，',
  '    通常是产品/架构/负责人角色，不是只会闷头写代码的。',
  '  · 模型和思考等级按分工分别选，不要都用一个模型。',
  '',
  '【模型白名单】只能从这 4 个里挑（list_models 有详细说明）：',
  '  · ds-4.1-flash    DeepSeek V4.1 Flash —— 写代码/改文件/跑命令的主力',
  '  · glm-5.3         GLM 5.3 —— 通用中文活、性价比高',
  '  · kimi-k3         Kimi K3 —— 长文档、方案、写作、复杂推理',
  '  · glm-5.3-flash   GLM 5.3 Flash —— 简单批量、格式转换',
  '  ★ 严禁选 kimi-k2.5、glm-5/5.1、deepseek-v4-pro、minimax、amd 之类的一切其他模型。',
  '  ★ 思考等级：深度推理/架构决策用 high 或 max；写代码用 medium；简单活用 low 或 off。',
  '',
  '【★ 你手上只有只读文件工具】read / ls / grep / find，没有 bash、不能写文件。',
  '  这是故意的：你负责指挥，不负责动手。不要反复试探性地调工具确认环境。',
  '',
  '【风格】直接、简短、不废话。先说结论再说过程。不要复述用户的指令。',
  '派完活用一两句话交代“交给谁了、在干什么、什么时候有结果”，不要把别人的长输出再抄一遍。',
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
    /** 有变更的房间 id —— 落盘时只写这些，不要全量重写 */
    this.dirtyRooms = new Set();
  }

  #seed() {
    const chief = {
      id: MAIN_BOT_ID,
      name: 'Pi',
      emoji: 'π',
      role: 'main',
      persona: MAIN_PERSONA,
      tagline: 'AI 团队总经理',
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
    // 只写有变更的房间：之前是每次变更都把全部房间重写一遍，
    // 房间一多（每个群 500 条消息）就是纯浪费。
    for (const roomId of this.dirtyRooms) {
      writeJsonAtomic(path.join(ROOMS_DIR, `${roomId}.json`), this.messages.get(roomId) ?? []);
    }
    this.dirtyRooms.clear();
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
      role: 'member',
      persona: String(patch.persona || '').slice(0, 4000),
      // tagline 是给用户看的一句话简介；persona 是给模型看的系统提示，不能直接展示到界面上
      tagline: String(patch.tagline || '').slice(0, 60),
      // 形象：avatarShape 是预设形状下标（null = 按 id 随机），avatarColor 是 #RRGGBB（null = 按 id 随机）
      avatarShape: Number.isInteger(patch.avatarShape) ? patch.avatarShape : null,
      avatarColor: normalizeHex(patch.avatarColor),
      model: patch.model || null,
      thinking: patch.thinking || config.thinking,
      // 用户手把手教给它的做法（SOP）。会拼进系统提示词，让 bot 真的"学会"。
      skills: [],
      // 群聊轮次预算（全局一份，用户可在设置里改）
      groupLimits: { ...GROUP_LIMITS_DEFAULT },
      // 用户自己是谁（bot 要知道在跟谁说话）
      userName: config.userName,
      // 上下文预算：null = 用全局默认（config.reserveTokens / keepRecentTokens），
      // 而全局默认是 null 时就用 pi 自带的 16384 / 20000。
      reserveTokens: null,
      keepRecentTokens: null,
      // 模型容量覆盖：null = 用模型自带的。有些模型标称 1M 上下文 / 32k 输出，
      // 但实际能给到 161k 输出 —— 这种就得让用户（或总经理）手动抬。
      contextWindow: null,
      maxTokens: null,
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
    if (patch.tagline !== undefined) next.tagline = String(patch.tagline).slice(0, 60);
    if (patch.avatarShape !== undefined)
      next.avatarShape = Number.isInteger(patch.avatarShape) ? patch.avatarShape : null;
    if (patch.avatarColor !== undefined) next.avatarColor = normalizeHex(patch.avatarColor);
    if (patch.skills !== undefined && Array.isArray(patch.skills)) {
      next.skills = patch.skills
        .slice(0, 40)
        .map((s) => ({
          id: String(s?.id || newId('sk_')),
          title: String(s?.title || '').slice(0, 80),
          howto: String(s?.howto || '').slice(0, 2000),
          createdAt: s?.createdAt || now(),
        }))
        .filter((s) => s.title.trim());
    }
    if (patch.reserveTokens !== undefined)
      next.reserveTokens = positiveOrNull(patch.reserveTokens);
    if (patch.keepRecentTokens !== undefined)
      next.keepRecentTokens = positiveOrNull(patch.keepRecentTokens);
    if (patch.contextWindow !== undefined)
      next.contextWindow = positiveOrNull(patch.contextWindow);
    if (patch.maxTokens !== undefined)
      next.maxTokens = positiveOrNull(patch.maxTokens);
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

  // ---------- 用户身份 ----------

  /**
   * 用户叫什么。
   * 没设过就用 config 的默认值（环境变量 / 系统用户名）。
   * 空字符串等于没设 —— 界面上会退回默认，不会出现"bot 不知道你是谁"。
   */
  userName() {
    const v = String(this.state.userName ?? '').trim();
    return v || config.userName;
  }

  updateUserName(name) {
    const v = String(name ?? '').trim().slice(0, 40);
    this.state.userName = v;
    this.scheduleSave();
    bus.emit('event', { t: 'user.updated', user: this.userSummary() });
    return this.userSummary();
  }

  userSummary() {
    return { name: this.userName() };
  }

  // ---------- 群聊轮次预算 ----------

  /** 当前的轮次预算（缺项用默认值补齐，老状态文件也能直接用） */
  groupLimits() {
    const saved = this.state.groupLimits ?? {};
    const out = {};
    for (const [k, def] of Object.entries(GROUP_LIMITS_DEFAULT)) {
      out[k] = positiveIntOrDefault(saved[k], def);
    }
    return out;
  }

  /** 改轮次预算。只认已知的键，值必须是正数，否则保持原样。 */
  updateGroupLimits(patch = {}) {
    const next = this.groupLimits();
    for (const k of Object.keys(GROUP_LIMITS_DEFAULT)) {
      if (patch[k] === undefined) continue;
      next[k] = positiveIntOrDefault(patch[k], next[k]);
    }
    this.state.groupLimits = next;
    this.scheduleSave();
    bus.emit('event', { t: 'groupLimits.updated', limits: next });
    return next;
  }

  // ---------- 房间 ----------

  listRooms() {
    const rooms = Object.values(this.state.rooms);
    const mainId = this.mainBot()?.id;
    return rooms.sort((a, b) => {
      // 1) 用户手动置顶的最前（右键菜单里那个「置顶」）
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      // 2) 没手动置顶时，主控 DM 默认在最上面
      const aPin = a.kind === 'dm' && a.botIds[0] === mainId ? 1 : 0;
      const bPin = b.kind === 'dm' && b.botIds[0] === mainId ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      // 3) 其余按最新消息
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
    this.dirtyRooms.add(room.id);
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
    // 侧边栏的三个开关（右键菜单里改）。都是"看的人自己"的属性，不影响 bot 怎么干活。
    if (patch.pinned !== undefined) room.pinned = Boolean(patch.pinned);
    if (patch.hidden !== undefined) room.hidden = Boolean(patch.hidden);
    if (patch.unread !== undefined) room.unread = Boolean(patch.unread);
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
    if (!room) return null;
    // ★ 私聊也能删。
    //   以前这里写的是 `if (!room || room.kind === 'dm') return null` —— 结果侧边栏
    //   那一列 bot 私聊（恰恰是用户最想清掉的一堆）一个都删不掉。
    //   注意删的是**这个会话**，不是那个 bot：下次点它 / @它，ensureDm 会重新开一个空的。
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
    const list = this.messages.get(roomId);
    if (!list || list.length === 0) return [];
    return list.length <= limit ? list.slice() : list.slice(-limit);
  }

  getMessage(roomId, messageId) {
    return (this.messages.get(roomId) ?? []).find((m) => m.id === messageId) ?? null;
  }

  /**
   * 追加一条消息。
   *
   * beforeStreaming：**插队**用 —— 插在"正在写的那条回复"之前。
   *   用户插话时，bot 手上那条回复还没写完；如果按普通追加放到最后，
   *   读起来就是"它先答了、我才插话"，因果是反的（用户报的：
   *   "只要是插队成功的，就把 bot 的回复放到最新"）。
   */
  appendMessage(partial, { silent = false, beforeStreaming = false } = {}) {
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
      // kind='ref' 的消息不画气泡，只渲染一个"已发给 XX"的小浮动条。
      kind: partial.kind || 'text',
      // 跨会话引用：bot 给别的 bot 发了私信时，在来源房间留一条指向
      // { botId, roomId } 的记录，用户点开能看到他们聊了什么。
      refs: partial.refs ?? [],
      attachments: partial.attachments ?? [],
      steps: partial.steps ?? [],
      usage: partial.usage ?? null,
      error: partial.error ?? null,
      meta: partial.meta ?? null,
      createdAt: partial.createdAt ?? now(),
      updatedAt: now(),
    };
    const list = this.messages.get(roomId);
    // 插队：落在"正在写的那条"之前；没有正在写的就按普通追加
    const at = beforeStreaming ? insertionPoint(list) : list.length;
    list.splice(at, 0, msg);
    if (list.length > config.maxMessagesPerRoom) list.splice(0, list.length - config.maxMessagesPerRoom);
    this.dirtyRooms.add(roomId);
    const room = this.state.rooms[roomId];
    if (room) room.lastMessageAt = msg.createdAt;
    this.scheduleSave();
    if (!silent) {
      // 落点要一起告诉客户端 —— 不然它按"追加"放到最后，
      // 本地看到的顺序和重新加载后的顺序就不一样了。
      const insertBefore = at < list.length - 1 ? list[at + 1].id : null;
      bus.emit('event', { t: 'msg.new', msg, insertBefore });
    }
    return msg;
  }

  updateMessage(roomId, messageId, patch, { silent = false } = {}) {
    const msg = this.getMessage(roomId, messageId);
    if (!msg) return null;
    Object.assign(msg, patch, { updatedAt: now() });
    this.dirtyRooms.add(roomId);
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
          this.dirtyRooms.add(roomId);
          n++;
        }
      }
    }
    if (n) this.saveNow();
    return n;
  }

  roomSummary(room) {
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
    this.dirtyRooms.add(roomId);
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
