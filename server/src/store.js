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
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { bus } from './bus.js';
import { newId, now, readJson, writeJsonAtomic, insertionPoint, log } from './util.js';
import { normalizeRules } from './shell-policy.js';

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
import { normalizeSkillList, normalizeSkill, skillRejectReason } from './skills.js';
import { normalizeSite } from './sites.js';
import { encrypt, decrypt, isEncrypted } from './secrets.js';

export const GROUP_LIMITS_DEFAULT = {
  /** 部门老大每次发言最多跑几轮 */
  leadTurns: 4,
  /** 普通成员每次发言最多跑几轮 */
  memberTurns: 2,
  /** 一条用户消息最多触发几次 bot 运行（防无限互吹） */
  maxRuns: 10,
  /** 部门里单次最多**来回几轮**（对话轮次，不是工具调用次数） */
  maxSteps: 30,
  /**
   * 部门单轮最长跑多久（毫秒）。
   *
   * 用户报过"为什么会有超过 300 秒中断" —— 这就是那个 300s。
   * 5 分钟对写代码这类慢活偏紧，所以默认放到 10 分钟；
   * 而且现在 App 的「部门预算」里能改（以前这个值在界面上根本没入口，
   * 只能改代码或环境变量 —— 用户只能干看着它被掐断）。
   */
  turnMaxMs: 600_000,
};

/**
 * 部门规矩（行为约束，和上面的预算分开）。
 *
 * 预算管的是"能跑多久/几轮"；规矩管的是"能不能拆家"。
 * 预算全是数字，规矩不是 —— 所以存在单独一份，不要往 GROUP_LIMITS_DEFAULT 里塞。
 */
export const POLICY_DEFAULT = {
  /**
   * 危险动作：
   *   allow = 照常；
   *   ask   = 工具照给，但每一次"会动手"的调用都要用户点批准（见 policy-hook）；
   *   deny  = 不给改文件/跑命令的工具（只读部门）。
   *
   * 这是**能真拦住的**那一种约束：不给工具，它就干不了。
   * （"需要批准"那一档要接审批闸门，等有真实需求再做。）
   */
  dangerous: 'allow',
  /** 交付必须附证据：命令输出 / 文件路径 / 测试结果，而不是一句"改好了" */
  requireProof: false,
  /**
   * 命令级规则：禁止执行的命令。
   *
   * 两种写法：`rm -rf *`（整条通配）、`aws:*s3 rm*`（可执行体:参数）。
   * 匹配前先归一化（还原引号/转义/去不可见字符），避免改写绕过。
   */
  denyCommands: [],
  /** 命令级规则：若非空，则只允许匹配的命令 */
  allowCommands: [],
};

function normalizePolicy(patch = {}, base = POLICY_DEFAULT) {
  return {
    dangerous:
      patch.dangerous === 'deny'
        ? 'deny'
        : patch.dangerous === 'ask'
          ? 'ask'
          : patch.dangerous === 'allow'
            ? 'allow'
            : base.dangerous,
    requireProof:
      patch.requireProof === undefined ? base.requireProof : Boolean(patch.requireProof),
    denyCommands:
      patch.denyCommands === undefined ? base.denyCommands : normalizeRules(patch.denyCommands),
    allowCommands:
      patch.allowCommands === undefined ? base.allowCommands : normalizeRules(patch.allowCommands),
  };
}

/**
 * 只读部门要拿掉哪些工具。
 * read/ls/find/grep 留着（看还是能看的），改东西和跑命令的一律收走。
 */
export const MUTATING_TOOLS = ['write', 'edit', 'bash', 'powershell'];

/**
 * 按部门规矩算出这个会话真正拿得到的工具集。
 *
 * 抽成纯函数是为了能单测：这条判断决定"bot 能不能拆家"，
 * 写错了（比如只读部门还留着 bash）从界面上根本看不出来。
 */
export function toolsForPolicy(baseTools = [], policy = POLICY_DEFAULT) {
  if (policy?.dangerous !== 'deny') return [...baseTools];
  return baseTools.filter((t) => !MUTATING_TOOLS.includes(t));
}

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
  '     造**开发类**（工程/前端/后端/架构/测试/运维/脚本…）的 bot 时，系统会自动给它挂上',
  '     「Engineering baseline」这份工程铁律 —— 你不用自己写，但**要在开工说明里点它一句**：',
  '     照基线干活（先读再改、破坏性操作先问、跑完测试再说完、不许静默丢活、提交要写清为什么）。',
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


/** 技能（SOP）规范化 —— create 和 update 两条路必须产出同样的形状 */
function normalizeSkills(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 40)
    .map((s) => ({
      id: String(s?.id || newId('sk_')),
      title: String(s?.title || '').slice(0, 80),
      howto: String(s?.howto || '').slice(0, 4000),
      createdAt: s?.createdAt || now(),
    }))
    .filter((s) => s.title.trim());
}

export class Store {
  /**
   * 站点口令的加密密钥。由 server-main 在启动时注入（loadOrCreateKey）。
   * 没注入时退化为"不加密"——单测里不需要真密钥，但生产必须注入。
   */
  secretsKey = null;

  /** 注入加密密钥（启动时调一次） */
  useSecretsKey(key) {
    this.secretsKey = key ?? null;
    // 借这次机会把历史明文口令迁成密文（只做一次，幂等）
    this.#migrateSitePasswords();
    return this;
  }

  /**
   * 把 state.sites 里还以明文存的 password 迁成密文。
   *
   * 老版本把口令直接写在 state.json 里，升级后要在启动时迁一遍，
   * 否则用户以为加密了、其实还是明文。
   */
  #migrateSitePasswords() {
    if (!this.secretsKey) return;
    const list = Array.isArray(this.state.sites) ? this.state.sites : [];
    let changed = 0;
    for (const site of list) {
      const pw = String(site?.password ?? '');
      if (!pw || isEncrypted(pw)) continue;
      site.password = encrypt(pw, this.secretsKey);
      changed++;
    }
    if (changed) {
      this.scheduleSave();
      // 迁移是要让用户知道的事 —— 但它不该出现在聊天里，只写日志
      console.log(`🔐 已把 ${changed} 个站点的口令从明文迁移为密文`);
    }
  }

  constructor() {
    const saved = readJson(STATE_FILE, null);
    this.state = saved?.version === STATE_VERSION ? saved : this.#seed();
    if (!this.state.sessions) this.state.sessions = {};
    if (!Array.isArray(this.state.tasks)) this.state.tasks = [];
    if (!Array.isArray(this.state.automations)) this.state.automations = [];
    if (!Array.isArray(this.state.approvals)) this.state.approvals = [];
    if (!Array.isArray(this.state.approvalGrants)) this.state.approvalGrants = [];
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
    try {
      writeJsonAtomic(STATE_FILE, this.state);
    } catch (err) {
      log('⚠️  写 state.json 失败（进程继续跑）：', err?.message || err);
    }
    // 只写有变更的房间：之前是每次变更都把全部房间重写一遍，
    // 房间一多（每个群 500 条消息）就是纯浪费。
    //
    // 逐房间独立处理：单个房间写入失败不影响其他房间，失败的保留在 dirty 中重试。
    for (const roomId of [...this.dirtyRooms]) {
      try {
        writeJsonAtomic(path.join(ROOMS_DIR, `${roomId}.json`), this.messages.get(roomId) ?? []);
        this.dirtyRooms.delete(roomId);
      } catch (err) {
        log(`⚠️  写房间 ${roomId} 失败（下次重试）：`, err?.message || err);
      }
    }
  }

  /** 删文件（房间/会话）：失败不算错，最多是磁盘上多留一份 */
  #removeFile(file) {
    if (!file) return;
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err?.code !== 'ENOENT') log(`⚠️  删文件失败 ${file}：`, err?.message || err);
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

  /**
   * 给客户端的设备列表：**不带 token**。
   * 撤销走 id，所以客户端不需要拿到 token（token 是那台设备的凭证）。
   */
  listDevicesPublic() {
    return this.listDevices().map(({ token, ...rest }) => rest);
  }

  /** 按设备 id 找（token 本身不给客户端，撤销只能靠 id） */
  findDeviceById(id) {
    if (!id) return null;
    for (const [token, d] of Object.entries(this.state.devices)) {
      if (d.id === id) return { token, device: d };
    }
    return null;
  }

  /**
   * 撤销设备：id 或 token 都能认（token 是历史调用方式）。
   * 事件里只带 id —— 广播给所有在线设备的消息里不能出现别人的 token。
   */
  revokeDevice(selector) {
    const key = String(selector ?? '');
    let token = this.state.devices[key] ? key : null;
    if (!token) {
      const hit = this.findDeviceById(key);
      token = hit ? hit.token : null;
    }
    if (!token) return false;
    const device = this.state.devices[token];
    delete this.state.devices[token];
    this.scheduleSave();
    bus.emit('event', { t: 'device.revoked', id: device?.id ?? null });
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
      // 技能（SOP）。会拼进系统提示词，让 bot 真的"学会"。
      // 造开发类 bot 时，create_bot 会塞一条"工程基线"进来（coding-baseline.js）。
      skills: normalizeSkills(patch.skills),
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
    if (patch.skills !== undefined) {
      next.skills = normalizeSkills(patch.skills);
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
        this.dirtyRooms.delete(room.id);
        this.#removeFile(path.join(ROOMS_DIR, `${room.id}.json`));
        bus.emit('event', { t: 'room.deleted', roomId: room.id });
      } else if (room.botIds.includes(id)) {
        room.botIds = room.botIds.filter((b) => b !== id);
        if (room.leadBotId === id) room.leadBotId = room.botIds[0] ?? null;
        bus.emit('event', { t: 'room.updated', room: this.roomSummary(room) });
      }
    }
    for (const key of Object.keys(this.state.sessions)) {
      if (key.endsWith(`:${id}`)) {
        this.#removeFile(this.state.sessions[key]);
        delete this.state.sessions[key];
      }
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

  // ---------------------------------------------------------------- 外部系统（站点）

  /** 已接入的外部 Web 系统 */
  /**
   * 站点列表。**返回的口令是明文**（runtime 要用它去登录），
   * 但 state 里存的是密文 —— 这个转换只在这里做，别的地方不许碰。
   */
  /**
   * 把（明文口令的）站点列表加密后写进 state。
   *
   * ★ 所有写 state.sites 的地方都必须走这里。
   *   直接 `this.state.sites = list` 会把明文重新落盘 ——
   *   siteList() 返回的是明文，很容易踩这个坑。
   */
  #persistSites(plainList) {
    this.state.sites = plainList.map((s) => ({
      ...s,
      password: this.secretsKey && s.password ? encrypt(s.password, this.secretsKey) : s.password,
    }));
    this.scheduleSave();
    bus.emit('event', { t: 'sites.updated' });
  }

  siteList() {
    const list = Array.isArray(this.state.sites) ? this.state.sites : [];
    return list
      .map((s) => {
        const plain = this.secretsKey
          ? { ...s, password: decrypt(s?.password, this.secretsKey) }
          : s;
        return normalizeSite(plain);
      })
      .filter(Boolean);
  }

  getSite(id) {
    return this.siteList().find((s) => s.id === id) ?? null;
  }

  /** 添加一个站点（重复的 baseUrl 会被拒，避免同一系统接两次） */
  addSite(raw = {}) {
    const site = normalizeSite({ ...raw, updatedAt: Date.now() });
    if (!site) return { error: '网址和账号是必填的' };
    const list = this.siteList();
    const dup = list.find(
      (s) => s.baseUrl.toLowerCase() === site.baseUrl.toLowerCase() && s.account === site.account,
    );
    if (dup) return { error: `这个系统已经接过了（${dup.name}）` };
    list.push(site);
    this.#persistSites(list);
    return { site };
  }

  /** 改站点（口令、登录路径、字段名都可能要改） */
  updateSite(id, patch = {}) {
    const list = this.siteList();
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return { error: '系统不存在' };
    const merged = normalizeSite({ ...list[idx], ...patch, id, updatedAt: Date.now() });
    if (!merged) return { error: '网址和账号是必填的' };
    list[idx] = merged;
    this.#persistSites(list);
    return { site: merged };
  }

  /** 删站点。关联的部门不自动删（那里面有聊天记录，删了收不回来） */
  removeSite(id) {
    const list = this.siteList();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return { error: '系统不存在' };
    this.#persistSites(next);
    return { ok: true };
  }

  /** 记下这个系统对应的部门（"一个系统一个团队"） */
  bindSiteTeam(id, roomId) {
    return this.updateSite(id, { teamRoomId: roomId ?? '' });
  }

  // ---------------------------------------------------------------- 技能库

  /**
   * 全局技能库（所有 bot 共享，存在 state.skills）。
   *
   * 和 bot.skills 的区别：bot.skills 是"这个 bot 自己会的事"，全量进提示词；
   * 这里是库，可以存很多条，按任务挑几条注入。库空着也不影响任何功能。
   */
  skillLibrary() {
    return normalizeSkillList(this.state.skills ?? []);
  }

  /** 加一条技能（重复标题会被拒，避免用户反复导入同一个文件） */
  addSkill(raw = {}) {
    const list = this.skillLibrary();
    const reason = skillRejectReason(raw);
    if (reason) return { error: reason };
    const skill = normalizeSkill({ ...raw, updatedAt: Date.now() });
    if (!skill) return { error: '技能内容不合法' };
    if (list.some((s) => s.title.toLowerCase() === skill.title.toLowerCase())) {
      return { error: `已经有同名技能「${skill.title}」` };
    }
    list.push(skill);
    this.state.skills = normalizeSkillList(list);
    this.scheduleSave();
    bus.emit('event', { t: 'skills.updated', skills: this.skillLibrary() });
    return { skill };
  }

  /** 改一条技能 */
  updateSkill(id, patch = {}) {
    const list = this.skillLibrary();
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return { error: '技能不存在' };
    const reason = skillRejectReason({ ...list[idx], ...patch });
    if (reason) return { error: reason };
    const merged = normalizeSkill({ ...list[idx], ...patch, id, updatedAt: Date.now() });
    if (!merged) return { error: '技能内容不合法' };
    // 改名后撞上别的条目也要拦
    if (list.some((s, i) => i !== idx && s.title.toLowerCase() === merged.title.toLowerCase())) {
      return { error: `已经有同名技能「${merged.title}」` };
    }
    list[idx] = merged;
    this.state.skills = list;
    this.scheduleSave();
    bus.emit('event', { t: 'skills.updated', skills: list });
    return { skill: merged };
  }

  /** 删一条技能 */
  removeSkill(id) {
    const list = this.skillLibrary();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return { error: '技能不存在' };
    this.state.skills = next;
    this.scheduleSave();
    bus.emit('event', { t: 'skills.updated', skills: next });
    return { ok: true };
  }

  /** 批量导入（解析好的技能数组），返回成功/跳过明细 */
  importSkills(items = []) {
    const list = this.skillLibrary();
    const imported = [];
    const skipped = [];
    for (const item of Array.isArray(items) ? items : []) {
      const reason = skillRejectReason(item);
      if (reason) {
        skipped.push({ title: String(item?.title ?? ''), reason });
        continue;
      }
      const skill = normalizeSkill(item);
      if (!skill) {
        skipped.push({ title: String(item?.title ?? ''), reason: '内容不合法' });
        continue;
      }
      if (list.some((s) => s.title.toLowerCase() === skill.title.toLowerCase())) {
        skipped.push({ title: skill.title, reason: '同名技能已存在' });
        continue;
      }
      list.push(skill);
      imported.push(skill);
    }
    if (imported.length) {
      this.state.skills = normalizeSkillList(list);
      this.scheduleSave();
      bus.emit('event', { t: 'skills.updated', skills: this.skillLibrary() });
    }
    return { imported, skipped };
  }

  /** 当前的部门规矩 */
  policy() {
    return normalizePolicy(this.state.policy ?? {}, POLICY_DEFAULT);
  }

  /** 改部门规矩。改完会广播，正在跑的会话下一轮就会拿到新的工具集 */
  updatePolicy(patch = {}) {
    const next = normalizePolicy(patch, this.policy());
    this.state.policy = next;
    this.scheduleSave();
    bus.emit('event', { t: 'policy.updated', policy: next });
    return next;
  }

  // ---------- 被拦下的命令（审计） ----------

  /** 记录一次被命令策略拒绝的执行；只保留最近 200 条 */
  addDenial({ roomId = null, botId = null, botName = '', command = '', rule = null, reason = '' } = {}) {
    if (!Array.isArray(this.state.denials)) this.state.denials = [];
    const denial = {
      id: newId('dn_'),
      at: now(),
      roomId,
      botId,
      botName,
      command: String(command ?? '').slice(0, 2000),
      rule: rule ? String(rule).slice(0, 200) : null,
      reason: String(reason ?? '').slice(0, 300),
    };
    this.state.denials.push(denial);
    if (this.state.denials.length > 200) {
      this.state.denials.splice(0, this.state.denials.length - 200);
    }
    this.scheduleSave();
    bus.emit('event', { t: 'policy.denied', denial });
    return denial;
  }

  /** 最近的拒绝记录（新的在前） */
  listDenials({ roomId = null, limit = 50 } = {}) {
    const list = Array.isArray(this.state.denials) ? this.state.denials : [];
    const picked = roomId ? list.filter((d) => d.roomId === roomId) : list;
    return picked.slice(-Math.max(1, Math.min(limit, 200))).reverse();
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
  /** 已经存在的私聊（不会新建） */
  findDm(botId) {
    return (
      Object.values(this.state.rooms).find(
        (r) => r.kind === 'dm' && r.botIds.length === 1 && r.botIds[0] === botId,
      ) ?? null
    );
  }

  /** 标记"这个私聊已经开场过了"，避免反复自我介绍 */
  markRoomGreeted(roomId) {
    const room = this.state.rooms[roomId];
    if (!room) return;
    room.greetedAt = now();
    this.scheduleSave();
  }

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
    // 同步删除磁盘文件，并从 dirty 集合移除，避免下次落盘重新写出空数组。
    this.dirtyRooms.delete(id);
    this.#removeFile(path.join(ROOMS_DIR, `${id}.json`));
    for (const key of Object.keys(this.state.sessions)) {
      if (key.startsWith(`${id}:`)) {
        this.#removeFile(this.state.sessions[key]);
        delete this.state.sessions[key];
      }
    }
    this.scheduleSave();
    bus.emit('event', { t: 'room.deleted', roomId: id });
    return { id };
  }

  // ---------- 会话文件 ----------

  /**
   * 造一帮人 + 开一个部门（原本写在主控的 create_department 工具里）。
   *
   * 抽进 store 是因为现在有两条路要用同一套逻辑：主控现凑班子、照模板开张。
   * 两边行为必须一致（重名复用、老大按名字匹配…），否则模板开出来的部门
   * 和手工建的总会差一点。
   */
  createDepartment({ name, topic = '', members = [], lead = null, createdBy = null }) {
    const created = [];
    for (const m of members.filter((x) => x?.name)) {
      const dup = this.listBots().find((b) => b.name === m.name);
      if (dup) {
        created.push(dup);
        continue;
      }
      created.push(
        this.createBot({
          name: m.name,
          persona: m.persona,
          emoji: m.emoji,
          tagline: m.tagline,
          model: m.model ?? null,
          thinking: m.thinking ?? undefined,
          skills: m.skills,
          createdBy: createdBy ?? 'chief',
        }),
      );
    }
    // 老大按名字匹配；匹配不上就退回第一个（宁可开出来没老大，也别开不出来）
    const leadBot = lead ? created.find((b) => b.name === lead) : null;
    const room = this.createGroup({
      name,
      topic,
      botIds: created.map((b) => b.id),
      leadBotId: leadBot?.id ?? created[0]?.id,
      createdBy,
    });
    return { room, bots: created };
  }

  // ---------- 审批（危险动作第三档） ----------

  listApprovals({ roomId = null, status = null, limit = 50 } = {}) {
    const all = Array.isArray(this.state.approvals) ? this.state.approvals : [];
    return all
      .filter((a) => (!roomId || a.roomId === roomId) && (!status || a.status === status))
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  getApproval(id) {
    return (this.state.approvals ?? []).find((a) => a.id === id) ?? null;
  }

  /** 同一个 hash 已经有"已批准但还没用掉"的，就放行一次 */
  takeApproved(hash) {
    const hit = (this.state.approvals ?? []).find(
      (a) => a.hash === hash && a.status === 'approved',
    );
    if (!hit) return null;
    hit.status = 'consumed';
    hit.updatedAt = now();
    this.scheduleSave();
    return hit;
  }

  findPendingApproval({ roomId, botId, hash }) {
    return (
      (this.state.approvals ?? []).find(
        (a) =>
          a.roomId === roomId &&
          a.botId === botId &&
          a.hash === hash &&
          a.status === 'pending',
      ) ?? null
    );
  }

  createApproval({
    roomId,
    botId,
    botName = '',
    tool,
    summary = '',
    input = null,
    hash,
  } = {}) {
    const dup = this.findPendingApproval({ roomId, botId, hash });
    if (dup) return dup;
    if (!Array.isArray(this.state.approvals)) this.state.approvals = [];
    const approval = {
      id: newId('ap_'),
      roomId,
      botId,
      botName,
      tool: String(tool ?? ''),
      summary: String(summary ?? '').slice(0, 500),
      input: input ?? null,
      hash,
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.approvals.push(approval);
    if (this.state.approvals.length > 200) {
      this.state.approvals.splice(0, this.state.approvals.length - 200);
    }
    this.scheduleSave();
    bus.emit('event', { t: 'approval.created', approval });
    return approval;
  }

  decideApproval(id, { approved = false } = {}) {
    const a = this.getApproval(id);
    if (!a || a.status !== 'pending') return null;
    a.status = approved ? 'approved' : 'denied';
    a.updatedAt = now();
    this.scheduleSave();
    bus.emit('event', { t: 'approval.decided', approval: a });
    return a;
  }

  /**
   * 开一个"临时放行窗口"：用户批准后，这个 bot 在这个会话里接下来的操作
   * 不再逐条弹卡片（默认 10 分钟）。避免它连着跑三条命令就要点三次。
   */
  grantApproval({ roomId, botId, minutes = 10 } = {}) {
    if (!roomId || !botId) return null;
    const until = now() + Math.max(1, Math.min(120, Number(minutes) || 10)) * 60_000;
    const list = this.state.approvalGrants ?? [];
    const existing = list.find((g) => g.roomId === roomId && g.botId === botId);
    if (existing) {
      existing.until = Math.max(existing.until, until);
    } else {
      list.push({ roomId, botId, until });
    }
    this.state.approvalGrants = list;
    this.scheduleSave();
    return { roomId, botId, until };
  }

  hasApprovalGrant({ roomId, botId } = {}) {
    const at = now();
    const list = (this.state.approvalGrants ?? []).filter((g) => g.until > at);
    this.state.approvalGrants = list;
    return list.some((g) => g.roomId === roomId && g.botId === botId);
  }

  /** 清掉放行窗口：给了谁就只清谁，都不给就全清 */
  clearApprovalGrants({ roomId = null, botId = null } = {}) {
    this.state.approvalGrants = (this.state.approvalGrants ?? []).filter((g) => {
      const roomMatch = roomId ? g.roomId === roomId : true;
      const botMatch = botId ? g.botId === botId : true;
      return !(roomMatch && botMatch);
    });
    this.scheduleSave();
  }

  // ---------- 定时任务 ----------

  listAutomations({ roomId = null } = {}) {
    const all = Array.isArray(this.state.automations) ? this.state.automations : [];
    return roomId ? all.filter((a) => a.roomId === roomId) : all.slice();
  }

  getAutomation(id) {
    return (this.state.automations ?? []).find((a) => a.id === id) ?? null;
  }

  createAutomation({
    roomId = null,
    title = '',
    prompt = '',
    botId = null,
    everyMinutes = null,
    dailyAt = null,
    enabled = true,
    createdBy = null,
    nextRunAt = null,
  } = {}) {
    const clean = String(title ?? '').trim().slice(0, 120);
    const body = String(prompt ?? '').trim();
    if (!clean || !body) return null;
    if (!Array.isArray(this.state.automations)) this.state.automations = [];
    const automation = {
      id: newId('au_'),
      roomId,
      title: clean,
      prompt: body.slice(0, 4000),
      botId,
      everyMinutes: everyMinutes ? Math.max(5, Math.round(Number(everyMinutes))) : null,
      dailyAt: dailyAt ? String(dailyAt).slice(0, 5) : null,
      enabled: enabled !== false,
      createdBy,
      createdAt: now(),
      lastRunAt: 0,
      nextRunAt: nextRunAt ?? 0,
    };
    this.state.automations.push(automation);
    this.scheduleSave();
    bus.emit('event', { t: 'automation.updated', automation });
    return automation;
  }

  updateAutomation(id, patch = {}) {
    const a = this.getAutomation(id);
    if (!a) return null;
    if (patch.title !== undefined) {
      const clean = String(patch.title ?? '').trim().slice(0, 120);
      if (clean) a.title = clean;
    }
    if (patch.prompt !== undefined) {
      const body = String(patch.prompt ?? '').trim();
      if (body) a.prompt = body.slice(0, 4000);
    }
    if (patch.botId !== undefined) a.botId = patch.botId || null;
    if (patch.everyMinutes !== undefined) {
      a.everyMinutes = patch.everyMinutes
        ? Math.max(5, Math.round(Number(patch.everyMinutes)))
        : null;
      if (a.everyMinutes) a.dailyAt = null;
    }
    if (patch.dailyAt !== undefined) {
      a.dailyAt = patch.dailyAt ? String(patch.dailyAt).slice(0, 5) : null;
      if (a.dailyAt) a.everyMinutes = null;
    }
    if (patch.enabled !== undefined) a.enabled = Boolean(patch.enabled);
    if (patch.nextRunAt !== undefined) a.nextRunAt = Number(patch.nextRunAt) || 0;
    this.scheduleSave();
    bus.emit('event', { t: 'automation.updated', automation: a });
    return a;
  }

  markAutomationRan(id, nextRunAt) {
    const a = this.getAutomation(id);
    if (!a) return null;
    a.lastRunAt = now();
    a.nextRunAt = Number(nextRunAt) || 0;
    this.scheduleSave();
    return a;
  }

  deleteAutomation(id) {
    const list = this.state.automations ?? [];
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.scheduleSave();
    bus.emit('event', { t: 'automation.deleted', id });
    return true;
  }

  // ---------- 任务板 ----------

  /** 全部任务（新在前） */
  listTasks({ roomId = null, status = null, limit = 200 } = {}) {
    const all = Array.isArray(this.state.tasks) ? this.state.tasks : [];
    return all
      .filter((t) => (!roomId || t.roomId === roomId) && (!status || t.status === status))
      .slice()
      .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, 500)));
  }

  getTask(id) {
    return (this.state.tasks ?? []).find((t) => t.id === id) ?? null;
  }

  createTask({
    roomId = null,
    title = '',
    detail = '',
    ownerBotId = null,
    createdBy = null,
    sourceMessageId = null,
    status = 'open',
  } = {}) {
    const clean = String(title ?? '').trim().slice(0, 200);
    if (!clean) return null;
    if (!Array.isArray(this.state.tasks)) this.state.tasks = [];
    const task = {
      id: newId('tk_'),
      roomId,
      title: clean,
      detail: String(detail ?? '').slice(0, 2000),
      status: ['open', 'doing', 'done'].includes(status) ? status : 'open',
      ownerBotId,
      ownerName: ownerBotId ? (this.getBot(ownerBotId)?.name ?? null) : null,
      createdBy,
      sourceMessageId,
      createdAt: now(),
      updatedAt: now(),
      unreadAt: 0,
      pinnedAt: 0,
    };
    this.state.tasks.push(task);
    // 任务板只留最近 500 条（旧的自动淘汰，别让它无限长）
    if (this.state.tasks.length > 500) {
      const done = this.state.tasks.filter((t) => t.status === 'done');
      const keep = this.state.tasks.slice(-500);
      this.state.tasks = keep;
      if (done.length > 0) log(`任务板已到 500 条上限，淘汰了较早的 ${done.length} 条已完成任务`);
    }
    this.scheduleSave();
    bus.emit('event', { t: 'task.updated', task });
    return task;
  }

  updateTask(id, patch = {}) {
    const task = this.getTask(id);
    if (!task) return null;
    if (patch.title !== undefined) {
      const clean = String(patch.title ?? '').trim().slice(0, 200);
      if (clean) task.title = clean;
    }
    if (patch.detail !== undefined) task.detail = String(patch.detail ?? '').slice(0, 2000);
    if (patch.ownerBotId !== undefined) {
      task.ownerBotId = patch.ownerBotId || null;
      task.ownerName = task.ownerBotId ? (this.getBot(task.ownerBotId)?.name ?? null) : null;
    }
    if (patch.status !== undefined && ['open', 'doing', 'done'].includes(patch.status)) {
      task.status = patch.status;
      // 变成"完成"时记一条未读，等用户看过再清掉
      task.unreadAt = patch.status === 'done' ? now() : 0;
    }
    if (patch.pinned !== undefined) task.pinnedAt = patch.pinned ? now() : 0;
    if (patch.read) task.unreadAt = 0;
    task.updatedAt = now();
    this.scheduleSave();
    bus.emit('event', { t: 'task.updated', task });
    return task;
  }

  deleteTask(id) {
    const list = this.state.tasks ?? [];
    const idx = list.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.scheduleSave();
    bus.emit('event', { t: 'task.deleted', taskId: id });
    return true;
  }

  /**
   * 部门里派活时登记一个任务（同一个执行者 + 同一句话，10 分钟内复用同一条）。
   * 返回任务 id，跑完用它收尾。
   */
  upsertDispatchTask({ roomId, ownerBotId, title, sourceMessageId = null }) {
    const clean = String(title ?? '').trim().slice(0, 200);
    if (!clean || !ownerBotId) return null;
    const at = now();
    const existing = (this.state.tasks ?? []).find(
      (t) =>
        t.roomId === roomId &&
        t.ownerBotId === ownerBotId &&
        t.status !== 'done' &&
        t.title === clean &&
        at - t.updatedAt < 10 * 60 * 1000,
    );
    if (existing) {
      existing.updatedAt = at;
      this.scheduleSave();
      return existing.id;
    }
    const task = this.createTask({
      roomId,
      title: clean,
      ownerBotId,
      createdBy: 'dispatch',
      sourceMessageId,
      status: 'doing',
    });
    return task?.id ?? null;
  }

  /** 一轮跑完后收尾：成功/失败都记下来，完成的置为 done 并标记未读 */
  finishTask(id, { ok = true, text = '' } = {}) {
    const task = this.getTask(id);
    if (!task) return null;
    task.detail = String(text ?? '').slice(0, 2000);
    task.status = ok ? 'done' : 'open';
    task.unreadAt = ok ? now() : 0;
    task.updatedAt = now();
    this.scheduleSave();
    bus.emit('event', { t: 'task.updated', task });
    return task;
  }

  // ---------- 部门模板 ----------

  /** 这台机器上存着的部门模板 */
  templates() {
    return Array.isArray(this.state.templates) ? this.state.templates : [];
  }

  /**
   * 从现成的部门存一份模板。
   *
   * 只存"班子"（人 + 人设 + 模型 + 技能）和谁当老大；
   * **不存**消息、不存会话 —— 模板要能反复用，带上历史就变成快照了。
   */
  saveTemplateFromRoom(roomId, { name = '' } = {}) {
    const room = this.getRoom(roomId);
    if (!room) return { error: '部门不存在' };
    const members = room.botIds
      .map((id) => this.getBot(id))
      .filter(Boolean)
      .map((b) => ({
        name: b.name,
        emoji: b.emoji ?? null,
        tagline: b.tagline ?? '',
        persona: b.persona ?? '',
        model: b.model ?? null,
        thinking: b.thinking ?? null,
        skills: Array.isArray(b.skills) ? b.skills : [],
      }));
    if (!members.length) return { error: '这个部门里没人' };
    return this.createTemplate({
      name: name || room.name,
      topic: room.topic ?? '',
      lead: this.getBot(room.leadBotId)?.name ?? members[0].name,
      members,
    });
  }

  createTemplate({ name, topic = '', lead = null, members = [] } = {}) {
    const clean = String(name || '').trim();
    if (!clean) return { error: '模板得有个名字' };
    const list = this.templates();
    // 同名就覆盖（想"拿这个部门更新一下模板"时不用先删）
    const kept = list.filter((t) => t.name !== clean);
    const tpl = {
      id: list.find((t) => t.name === clean)?.id ?? newId('tpl_'),
      name: clean.slice(0, 60),
      topic: String(topic || '').slice(0, 200),
      lead: lead && members.some((m) => m.name === lead) ? lead : (members[0]?.name ?? null),
      members: members.slice(0, 12).map((m) => ({
        name: String(m.name || '').slice(0, 40),
        emoji: m.emoji || null,
        tagline: String(m.tagline || '').slice(0, 60),
        persona: String(m.persona || '').slice(0, 4000),
        model: m.model || null,
        thinking: m.thinking || null,
        skills: Array.isArray(m.skills) ? m.skills.slice(0, 40) : [],
      })),
      createdAt: now(),
    };
    this.state.templates = [...kept, tpl];
    this.scheduleSave();
    bus.emit('event', { t: 'templates.updated', templates: this.state.templates });
    return { template: tpl };
  }

  deleteTemplate(id) {
    const list = this.templates();
    const next = list.filter((t) => t.id !== id);
    if (next.length === list.length) return { error: '没有这个模板' };
    this.state.templates = next;
    this.scheduleSave();
    bus.emit('event', { t: 'templates.updated', templates: next });
    return { ok: true };
  }

  /** 照模板开一个部门（重名的人复用现成的，不重复造） */
  applyTemplate(id, { name = '' } = {}) {
    const tpl = this.templates().find((t) => t.id === id || t.name === id);
    if (!tpl) return { error: '没有这个模板' };
    const { room, bots } = this.createDepartment({
      name: String(name || tpl.name).trim().slice(0, 60),
      topic: tpl.topic,
      members: tpl.members,
      lead: tpl.lead,
      createdBy: 'template',
    });
    return { room, bots, template: tpl };
  }

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

  /**
   * 把房间里最后一张还没答的“问你”卡片标成已答。
   *
   * 为什么要存在：那张卡片是 bot 停下来等用户回话的地方，一旦用户回了
   * （点了某个选项，或者自己打了一句），这件事就已经往下走了 ——
   * 卡片还挂着能被再点第二次，只会让人迷惑“我刚才点了吗”／误点拨乱进程。
   *
   * 只标**最新一张**：老的卡片在它被回答时就已经标过了；一次回答只对应一张卡。
   *
   * @returns {object|null} 被更新的消息
   */
  answerPendingAsk(roomId, answer, { silent = false } = {}) {
    const list = this.messages.get(roomId);
    if (!Array.isArray(list)) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (msg?.kind !== 'ask') continue;
      // 已答过的跳过，继续往前找
      if (msg.meta?.answer != null) continue;
      const answered = String(answer ?? '').slice(0, 500);
      const next = this.updateMessage(
        roomId,
        msg.id,
        { meta: { ...(msg.meta ?? {}), answer: answered, answeredAt: now() } },
        { silent },
      );
      return next;
    }
    return null;
  }

  reapStaleStreaming() {
    let n = 0;
    for (const [roomId, list] of this.messages) {
      for (const msg of list) {
        if (msg.status === 'streaming') {
          msg.status = msg.text ? 'done' : 'error';
          if (!msg.text) msg.error = '服务端重启，本轮中断';
          msg.updatedAt = now();
          this.dirtyRooms.add(roomId);
          n++;
        }
        // ★ 工具行也要收尾。
        //
        //   只把消息标成 done 是不够的：那条消息里的工具步骤会一直停在
        //   status='running' —— 客户端把它画成转圈的图标，于是群里永远显示
        //   "正在调用工具…"，圈一直转但什么也没发生（用户报的）。
        //   服务端重启打断的那一步，就明说被打断了。
        if (Array.isArray(msg.steps) && msg.steps.some((s) => s?.status === 'running')) {
          msg.steps = msg.steps.map((s) =>
            s?.status === 'running'
              ? { ...s, status: 'error', error: '服务端重启，这一步中断' }
              : s,
          );
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
