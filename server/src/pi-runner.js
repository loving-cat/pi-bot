/**
 * pi agent 运行时。
 *
 * 会话按 (房间, bot) 维度缓存并持久化：同一个 bot 在不同的群里互不干扰，
 * 重启服务端后接着之前的上下文继续。
 *
 * 组织架构（学 ds-bot）：
 *   主控 = 总经理，直接对用户负责，可以往任何部门下达任务
 *   群   = 部门，有部门老大（leadBotId）
 *   用户往部门里发消息 → 部门老大先接，拆任务后用 @同事 派下去
 *   被 @ 的人接着发言；干完把结果交回来
 *
 * 事件流（bus 广播 → App）：
 *   msg.new / msg.delta / msg.steps / msg.done / msg.error / msg.updated / msg.deleted
 *   typing {roomId, botId, active}
 *   bot.updated / room.created / room.updated / room.deleted
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { config } from './config.js';
import { bus } from './bus.js';
import { store } from './store.js';
import { loadExtraProviders, settingsDefaultModel } from './providers.js';
import { ModelHealth } from './model-health.js';
import { buildChiefTools, buildCommonTools } from './tools.js';
import { MODEL_MENU, defaultMenuSlug, logMenu, resolveMenu } from './model-menu.js';
import { attachmentBlock } from './extract.js';
import { inboxPath, metaFor, readForModel, saveFromPath } from './attachments.js';
import { parseMentions, rosterLine } from './mentions.js';
import { log } from './util.js';

const MAX_STEP_TEXT = 200;

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
  }
  return '';
}

/** 附件 id -> 完整元信息（存进消息里的必须是对象，不然 App 渲染不了） */
function hydrate(ids) {
  const out = [];
  for (const id of ids ?? []) {
    const meta = metaFor(id);
    if (!meta) continue;
    out.push({ id: meta.id, name: meta.name, mime: meta.mime, kind: meta.kind, size: meta.size });
  }
  return out;
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task', 'text', 'name']) {
    if (typeof args[key] === 'string') return `${key}: ${args[key]}`.slice(0, MAX_STEP_TEXT);
  }
  try {
    const json = JSON.stringify(args);
    return json === '{}' ? '' : json.slice(0, MAX_STEP_TEXT);
  } catch {
    return '';
  }
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  const invoke = () => {
    last = Date.now();
    timer = null;
    const args = pendingArgs;
    pendingArgs = null;
    fn(...(args ?? []));
  };
  const wrapped = (...args) => {
    pendingArgs = args;
    const elapsed = Date.now() - last;
    if (elapsed >= ms) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke();
    } else if (!timer) {
      timer = setTimeout(invoke, ms - elapsed);
    }
  };
  wrapped.flush = () => {
    if (timer) clearTimeout(timer);
    invoke();
  };
  return wrapped;
}
/**
 * 把某个 bot 的上下文预算套到会话上。
 *
 * 触发线 = contextWindow - reserveTokens 用满就自动压缩；
 * 压缩时保留最近 keepRecentTokens 不总结。
 *
 * 三层回退：bot 上单独设的 → 全局 config（环境变量）→ pi 自带默认（16384 / 20000）。
 * 任何一层是 null 就不覆盖，交给下一层。
 */
export function applyCompactionBudget(session, bot = {}) {
  const sm = session?.settingsManager;
  if (!sm || typeof sm.applyOverrides !== 'function') return null;

  const reserve = positiveOrNull(bot.reserveTokens) ?? config.reserveTokens ?? null;
  const keep = positiveOrNull(bot.keepRecentTokens) ?? config.keepRecentTokens ?? null;
  const overrides = {};
  if (reserve != null) overrides.reserveTokens = reserve;
  if (keep != null) overrides.keepRecentTokens = keep;
  if (!config.autoCompact) overrides.enabled = false;
  if (Object.keys(overrides).length === 0) return null;
  try {
    sm.applyOverrides({ compaction: overrides });
    return overrides;
  } catch (err) {
    log('⚠️  设置上下文预算失败：', err?.message || err);
    return null;
  }
}

/**
 * 读一个会话的上下文占用。
 *
 * 返回 null 表示"现在还不知道"（比如刚压缩完、还没等到下一次回复）——
 * 这时候界面该显示"—"而不是 0%，否则用户会以为上下文是空的。
 */
export function readContext(session) {
  try {
    const u = session?.getContextUsage?.();
    if (!u) return null;
    return {
      tokens: u.tokens ?? null,
      contextWindow: u.contextWindow ?? null,
      percent: u.percent ?? null,
      compacting: Boolean(session.isCompacting),
    };
  } catch {
    return null;
  }
}

/**
 * 把 bot 上设的 contextWindow / maxTokens 盖到模型对象上。
 *
 * ★ 只影响这一个会话 —— 不去改 pi 的 models.json。那是全局的，改了连用户在终端里
 *   用的 pi 一起变；而且"每个 bot 一套预算"本来就该是会话级的事。
 * 典型场景：模型标称 1M 上下文 / 32k 输出，但用户知道它实际能出 161k。
 */
export function withCapacity(model, bot = {}) {
  const cw = positiveOrNull(bot.contextWindow);
  const mt = positiveOrNull(bot.maxTokens);
  if (cw == null && mt == null) return model;
  return {
    ...model,
    ...(cw != null ? { contextWindow: cw } : {}),
    ...(mt != null ? { maxTokens: mt } : {}),
  };
}

/** 和 store 里那个同名助手一个意思：正数才要，其他一律 null */
function positiveOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** 把一个会话的上下文占用推给界面（每轮结束、以及压缩前后都会调） */
function emitContext(roomId, botId, session) {
  const u = readContext(session);
  if (!u) return;
  bus.emit('event', { t: 'context', roomId, botId, ...u });
}

/**
 * 拼一个 bot 的 appendSystemPrompt。
 *
 * 单独抽出来是为了能单测：这是全项目**最容易悄悄写坏、又最难发现**的地方 ——
 * 提示词写错了不报错，只是 bot 突然开始念配置表、或者把用户教过的 SOP 忘了。
 *
 * 组成（顺序有意义）：
 *   1. persona —— bot 的人设
 *   2. skills  —— 用户手把手教过的做法（SOP），直接当"你已经会了"
 *   3. 文件规矩 —— 附件在 _inbox/、产出图要 send_image
 *   4. 说话规矩 —— 禁止念模型名/思考等级/token/id、禁止点评谁是老大
 */
export function buildAppendSystemPrompt(bot = {}) {
  const skills = Array.isArray(bot.skills) ? bot.skills.filter((s) => s?.title) : [];
  return [
    ...(bot.persona ? [bot.persona] : []),
    // 用户教过它的做法（SOP）：直接当成"你已经会了"，不要每轮重新摸索
    ...(skills.length
      ? [
          '【用户教过你的做法】下面这些是用户手把手教过你的，遇到同类事情照做，不要重新摸索、也不要再问：',
          ...skills.map((s, i) => `${i + 1}. ${s.title}：${s.howto}`),
        ]
      : []),
    '【关于文件】用户发的附件会被放进工作目录的 _inbox/ 目录；读文档正文用 extract_file；',
    '你生成的图表/导出的表格，用 send_image 发出来用户才看得到（工作目录里新生成的图片也会自动带上）。',
    // ★ 这条是防“念配置表”的。工具返回值里带着模型名/思考等级，模型会忍不住
    //   原样转述给用户；而且它爱点评“谁能力强、谁是老大”。现实里没人这么拉群。
    '【说话规矩】给用户看的消息里，永远不要出现：模型名/线路名、思考等级、token 用量、id、\n' +
      '以及“谁是老大”“谁能力强”这类点评。职位（工程师/设计师/负责人）本身已经说明了分工和分量。\n' +
      '工具返回值里 «» 包起来的是内部参数，只给你自己用，不要转述。\n' +
      '像真人老板拉群那样说话：说清要做什么、找谁对接，就够了，不要念名单。',
  ];
}


export class PiRunner {
  constructor() {
    /** @type {Map<string, {session:any, bot:any, busy:boolean, unsubscribe?:Function, pending?:Promise<any>}>} */
    this.sessions = new Map();
    this.modelRuntime = null;
    this.model = null;
    this.routerModel = null;
    this.availableModels = [];
    this.initNote = null;
  }

  async init() {
    this.modelRuntime = await ModelRuntime.create();

    for (const [providerId, providerConfig] of Object.entries(loadExtraProviders())) {
      try {
        this.modelRuntime.registerProvider(providerId, providerConfig);
      } catch (err) {
        log(`⚠️  provider ${providerId} 注册失败：${err?.message || err}`);
      }
    }

    const candidates = [config.model, settingsDefaultModel()].filter(Boolean);
    for (const slug of candidates) {
      const found = this.resolveModel(slug);
      if (found) {
        this.model = found;
        break;
      }
    }

    try {
      const available = await this.modelRuntime.getAvailable();
      this.availableModels = available.map((m) => ({
        provider: m.provider,
        id: m.id,
        contextWindow: m.contextWindow,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output } : null,
        reasoning: Boolean(m.reasoning),
      }));
    } catch (err) {
      log('⚠️  取可用模型列表失败：', err?.message || err);
    }

    this.health = new ModelHealth(this);

    // 默认模型：菜单里第一个活的（优先 deepseek v4.1 flash）
    if (!this.model) {
      const fallback = defaultMenuSlug(this.health);
      if (fallback) this.model = this.resolveModel(fallback) ?? null;
    }

    // 群消息路由用的便宜模型（现在只做兜底判断）
    const routerSlug = resolveMenu('glm-5.3-flash', this.health)?.slug ?? defaultMenuSlug(this.health);
    this.routerModel = routerSlug ? this.resolveModel(routerSlug) : null;

    if (this.model) {
      log(`默认模型：${this.model.provider}/${this.model.id}`);
    } else {
      this.initNote = '没有可用模型，请先配置 pi 的 provider';
      log('⚠️ ', this.initNote);
    }
    logMenu(this.health);

    // 后台探活：结果缓存 24h，菜单按它自动切到活着的线路
    this.health.runAll({ concurrency: 6 }).catch((err) => log('模型探活出错：', err?.message || err));

    // 白名单模型的「档位矩阵」：找出会静默返回空的组合（比如 glm-5.3-oc @ medium）
    const menuSlugs = MODEL_MENU.flatMap((m) => m.slugs);
    this.health
      .runLevelMatrix(menuSlugs)
      .catch((err) => log('档位矩阵出错：', err?.message || err));

    return this;
  }

  /** 宽容解析：支持 "provider/id"、裸 id、以及唯一后缀匹配 */
  resolveModel(slug) {
    if (!slug || !this.modelRuntime) return null;
    const idx = slug.indexOf('/');
    if (idx > 0) {
      const direct = this.modelRuntime.getModel(slug.slice(0, idx), slug.slice(idx + 1));
      if (direct) return direct;
    }
    const all = this.modelRuntime.getModels();
    const byId = all.find((m) => m.id === slug);
    if (byId) return byId;
    const suffix = all.filter((m) => m.id.endsWith(`/${slug}`) || `${m.provider}/${m.id}` === slug);
    return suffix.length === 1 ? suffix[0] : null;
  }

  modelLabel() {
    return this.model ? `${this.model.provider}/${this.model.id}` : null;
  }

  /**
   * 当前所有活着的会话的上下文占用，形如 `{ '房间:bot': {tokens, contextWindow, percent, compacting} }`。
   * /api/state 带上它，App 一进来就能把每个 bot 的占用画出来。
   */
  contextUsage() {
    const out = {};
    for (const [key, entry] of this.sessions) {
      if (!entry.session) continue;
      const u = readContext(entry.session);
      if (u) out[key] = u;
    }
    return out;
  }

  // ---------------------------------------------------------------- 会话

  #key(roomId, botId) {
    return `${roomId}:${botId}`;
  }

  async #ensureSession(roomId, botId) {
    const key = this.#key(roomId, botId);
    const existing = this.sessions.get(key);
    if (existing?.session) return existing;
    if (existing?.pending) return existing.pending;

    const bot = store.getBot(botId);
    if (!bot) throw new Error(`找不到 bot ${botId}`);

    const promise = (async () => {
      const sessionDir = path.join(config.dataDir, 'sessions');
      const savedFile = store.sessionFileFor(roomId, botId);
      const sessionManager =
        savedFile && fs.existsSync(savedFile)
          ? SessionManager.open(savedFile)
          : SessionManager.create(config.workspace, sessionDir);

      const isChief = bot.role === 'main';
      const commonTools = buildCommonTools({ runner: this, roomId, botId });
      const customTools = [
        ...commonTools,
        ...(isChief ? buildChiefTools({ runner: this, health: this.health, roomId }) : []),
      ];

      const resourceLoader = new DefaultResourceLoader({
        cwd: config.workspace,
        agentDir: getAgentDir(),
        appendSystemPrompt: buildAppendSystemPrompt(bot),
        noExtensions: config.noExtensions || undefined,
      });
      await resourceLoader.reload();

      const baseTools = isChief ? config.chiefTools : config.tools;
      const options = {
        cwd: config.workspace,
        sessionManager,
        resourceLoader,
        tools: [...baseTools, ...customTools.map((t) => t.name)],
        customTools,
      };
      const botModel = bot.model ? this.resolveModel(bot.model) : null;
      const picked = botModel ?? this.model;
      // 容量覆盖：bot 上设过的 contextWindow / maxTokens 盖在模型自带值之上
      if (picked) options.model = withCapacity(picked, bot);
      if (bot.thinking) {
        // 已知这个模型在这个档位会返回空 → 自动换一个能用的
        const modelSlug = botModel ? `${botModel.provider}/${botModel.id}` : this.modelLabel();
        options.thinkingLevel = this.health.safeLevel(modelSlug, bot.thinking) ?? bot.thinking;
      }

      const { session, modelFallbackMessage } = await createAgentSession(options);
      if (modelFallbackMessage) log(`[${bot.name}] 模型回退：${modelFallbackMessage}`);

      // 上下文预算：bot 自己设过的优先，其次全局默认，都没有就听 pi 的。
      // 用 applyOverrides 而不是去写 settings.json —— 那个是全局的，
      // 而"每个 bot 一套预算"必须在会话级别生效。
      applyCompactionBudget(session, bot);

      if (session.sessionFile && session.sessionFile !== savedFile) {
        store.setSessionFile(roomId, botId, session.sessionFile);
      }
      log(`会话就绪 ${roomId} · ${bot.emoji ?? ''}${bot.name} → ${path.basename(session.sessionFile ?? '(内存)')}`);
      return { session, bot, busy: false, unsubscribe: null, pending: null };
    })();

    this.sessions.set(key, { session: null, busy: false, pending: promise, unsubscribe: null });
    try {
      const entry = await promise;
      entry.lastUsed = Date.now();
      this.sessions.set(key, entry);
      this.#evictSessions();
      return entry;
    } catch (err) {
      this.sessions.delete(key);
      throw err;
    }
  }

  /**
   * 会话 LRU：每个 (房间, bot) 一个 AgentSession，各自带着完整上下文和工具，
   * 房间一多内存会一直涨。超过上限就释放最久没用且不忙的那些。
   */
  #evictSessions() {
    const cap = config.maxSessions;
    if (this.sessions.size <= cap) return;
    const idle = [...this.sessions.entries()]
      .filter(([, e]) => e.session && !e.busy)
      .sort((a, b) => (a[1].lastUsed ?? 0) - (b[1].lastUsed ?? 0));
    let released = 0;
    while (this.sessions.size > cap && idle.length) {
      const [key, entry] = idle.shift();
      try {
        entry.unsubscribe?.();
        entry.session?.dispose();
      } catch {
        /* ignore */
      }
      this.sessions.delete(key);
      released++;
    }
    if (released) log(`会话 LRU 释放 ${released} 个（当前 ${this.sessions.size}）`);
  }

  isBusy(roomId, botId) {
    return Boolean(this.sessions.get(this.#key(roomId, botId))?.busy);
  }

  isRoomBusy(roomId) {
    for (const [key, entry] of this.sessions) {
      if (key.startsWith(`${roomId}:`) && entry.busy) return true;
    }
    return false;
  }

  /** 目标 bot：DM 就是唯一成员；群就是部门老大 */
  targetBotFor(room) {
    if (room.kind === 'dm') return room.botIds[0] ?? null;
    const { leadId } = this.#department(room);
    return leadId ?? room.botIds[0] ?? null;
  }

  // ---------------------------------------------------------------- 附件

  /** 把附件整理成两路：图片直接喂模型，文档抽正文拼进提示词 */
  async #buildInput(clean, files) {
    const imageIds = [];
    const docBlocks = [];
    const inboxRel = [];
    for (const id of files) {
      const meta = metaFor(id);
      if (!meta) continue;
      if (meta.kind === 'image') {
        imageIds.push(id);
        continue;
      }
      const abs = inboxPath(id);
      if (!abs) continue;
      inboxRel.push(path.relative(config.workspace, abs).replace(/\\/g, '/'));
      docBlocks.push(await attachmentBlock(abs, meta.name));
    }

    const parts = [];
    if (clean) parts.push(clean);
    if (imageIds.length) parts.push(`（用户发了 ${imageIds.length} 张图）`);
    if (docBlocks.length) {
      if (!clean) parts.push('用户发了文件，正文如下：');
      parts.push('', ...docBlocks);
    }
    if (inboxRel.length) {
      parts.push('', `【附件已放进工作目录：${inboxRel.join('、')}，需要重读时用 extract_file】`);
    }
    return { promptText: parts.join('\n').trim(), imageIds };
  }

  /** 工作目录里的图片快照，用来发现 bot 刚生成的图 */
  #snapshotImages() {
    const out = new Map();
    const walk = (dir, depth) => {
      if (depth > 4 || out.size > 400) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(entry.name)) {
          try {
            out.set(full, fs.statSync(full).mtimeMs);
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(config.workspace, 0);
    return out;
  }

  /** 跑完一轮后，把工作目录里新出现/刚改过的图收成附件 */
  #newImagesSince(before) {
    const after = this.#snapshotImages();
    const fresh = [];
    for (const [file, mtime] of after) {
      const prev = before.get(file);
      if (prev === undefined || mtime > prev + 5) fresh.push({ file, mtime });
    }
    fresh.sort((a, b) => b.mtime - a.mtime);
    const out = [];
    for (const item of fresh.slice(0, 4)) {
      try {
        const meta = saveFromPath(item.file);
        out.push({ id: meta.id, name: meta.name, mime: meta.mime, kind: meta.kind, size: meta.size });
      } catch (err) {
        log('自动附图失败：', err?.message || err);
      }
    }
    return out;
  }

  /** 给 send_image 工具用：把工作目录里的文件发到某个会话 */
  sendImage({ roomId, botId, filePath, caption }) {
    const bot = store.getBot(botId);
    const meta = saveFromPath(filePath);
    const attachment = { id: meta.id, name: meta.name, mime: meta.mime, kind: meta.kind, size: meta.size };
    const msg = store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: botId,
      authorName: bot?.name ?? botId,
      authorEmoji: bot?.emoji,
      text: caption ?? '',
      status: 'done',
      attachments: [attachment],
      meta: { via: 'send_image' },
    });
    return { meta, msg };
  }

  // ---------------------------------------------------------------- 群聊（部门）

  /** 这个 bot 在群里还没看过的消息 */
  #transcriptFor(roomId, botId, limit = 30) {
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
    return fresh.slice(-limit);
  }

  #lastMessageId(roomId) {
    const list = store.listMessages(roomId, { limit: 1 });
    return list[list.length - 1]?.id ?? null;
  }

  /** 部门成员（含老大）+ 老大 id */
  #department(room) {
    const members = room.botIds.map((id) => store.getBot(id)).filter(Boolean);
    const leadId =
      room.leadBotId && members.some((m) => m.id === room.leadBotId) ? room.leadBotId : members[0]?.id ?? null;
    return { members, leadId };
  }

  /**
   * 一条消息进来时，该谁先开口。
   * 学 ds-bot 的 openingSpeakers：
   *   · @点名 → 只叫被点名的（@all 就是除自己外全员）
   *   · 否则部门老大先接（老大负责把活拆开分下去）
   */
  #openingSpeakers(room, { text, openerBotId = null, kickoff = false }) {
    const { members, leadId } = this.#department(room);
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

  /** 给部门成员看的提示词：我是谁、同事是谁、老大是谁、现在轮到我了 */
  #composeGroupPrompt(room, bot, fresh, { isLead, reason, members, leadId }) {
    const lead = members.find((m) => m.id === leadId) ?? null;
    const peers = members.filter((m) => m.id !== bot.id);

    const head = [
      `【部门】${room.name}${room.topic ? ` —— ${room.topic}` : ''}`,
      lead ? `【部门老大】${lead.emoji ?? ''}${lead.name}${lead.id === bot.id ? '（就是你）' : ''}` : '',
      `【同事】${peers.map((m) => rosterLine(m, { isLead: m.id === leadId })).join('、') || '（暂时没有）'}`,
      '',
      '规则：写「@同事名字」就是把发言权交给它（它会接着说话、去干你派的活）；',
      '只写名字不带 @ 就只是提到它，不会触发它发言。',
    ].filter(Boolean);

    const parts = [head.join('\n')];

    if (fresh.length) {
      const lines = fresh.map((m) => {
        const who = m.authorType === 'user' ? '用户' : m.authorName;
        const body = (m.text ?? '').trim();
        return `${who}: ${body.length > 1600 ? `${body.slice(0, 1600)}…` : body}`;
      });
      parts.push('', '【群里刚刚发生的事（补给你的记录）】', ...lines);
    }

    const rules = isLead
      ? [
          `你是「${room.name}」的**部门老大**。这个部门收到的活，由你先接。`,
          '',
          '你的做法：',
          '1. 先把要求拆成几件具体的活，判断每一件该交给谁。',
          '2. **就在这个群里用 @同事名字 把活派出去**——被 @ 的人会接着在群里发言去干。',
          '   ★ 必须用 @ 在群里派，**不要用 message_bot 私信派活**：用户要看得见谁领了什么活。',
          '   message_bot 只用于「跨部门找人」或「确实不该让用户看到的内部确认」。',
          '3. 自己别闷头把活全干完；只有「确实只有你能干」的那部分才自己做。',
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

    parts.push('', `【现在轮到你：${bot.emoji ?? ''}${bot.name}】${reason ? `（${reason}）` : ''}`, ...rules);
    return parts.join('\n');
  }

  /**
   * 群（部门）里跑一轮。
   *
   * 流程：定首发人 → 依次跑 → 每个 bot 的输出里 @了谁，谁就排到队尾接着跑。
   * 每人有轮次预算（老大多一些），总步数有上限，防止部门内部无限互吹。
   */
  async runRound(
    roomId,
    {
      openerText = '',
      openerBotId = null,
      openerName = '用户',
      kickoff = false,
      attachments = [],
      attachmentContext = null,
    } = {},
  ) {
    const room = store.getRoom(roomId);
    if (!room || room.kind !== 'group') return;
    const { members, leadId } = this.#department(room);
    if (!members.length) return;

    const opening = this.#openingSpeakers(room, { text: openerText, openerBotId, kickoff });
    if (!opening.length) return;

    const budget = (botId) => (botId === leadId ? config.groupTurnsLead : config.groupTurnsMember);
    const used = new Map();
    const queue = opening.map((botId) => ({
      botId,
      reason: kickoff ? '部门刚成立，先由你安排' : openerBotId ? `${openerName} 叫了你` : '用户发了新消息',
    }));

    log(
      `【${room.name}】${openerBotId ? `${openerName} 发言` : '用户发言'} → 首发：${opening
        .map((id) => store.getBot(id)?.name ?? id)
        .join('、')}`,
    );

    let runs = 0;
    while (queue.length && runs < config.groupMaxRuns) {
      const item = queue.shift();
      const bot = store.getBot(item.botId);
      if (!bot) continue;
      const done = used.get(item.botId) ?? 0;
      if (done >= budget(item.botId)) continue;
      used.set(item.botId, done + 1);
      if (this.isBusy(roomId, bot.id)) continue;
      runs++;

      const fresh = this.#transcriptFor(roomId, bot.id);
      let prompt = this.#composeGroupPrompt(room, bot, fresh, {
        isLead: bot.id === leadId,
        reason: item.reason,
        members,
        leadId,
      });
      if (attachmentContext) prompt = `${attachmentContext}\n\n${prompt}`;

      const res = await this.run(roomId, bot.id, prompt, { groupTurn: true, attachments });
      store.setCursor(roomId, bot.id, this.#lastMessageId(roomId));

      if (!res.ok) continue;
      const text = res.text.trim();
      if (/^\[?PASS\]?$/i.test(text)) {
        store.deleteMessage(roomId, res.messageId);
        log(`${bot.name} PASS`);
        continue;
      }

      // 它 @ 了谁，谁就接着上
      const { all, found } = parseMentions(text, members, { selfId: bot.id });
      const next = all ? members.filter((m) => m.id !== bot.id).map((m) => m.id) : found;
      const queued = new Set(queue.map((q) => q.botId));
      for (const id of next) {
        if (id === bot.id || queued.has(id)) continue;
        queue.push({ botId: id, reason: `${bot.name} 叫了你` });
        queued.add(id);
      }
    }

    // 没被叫到的成员也算「看过这条了」，避免下次一次性倒一堆旧账
    const lastId = this.#lastMessageId(roomId);
    for (const m of members) {
      if (!used.has(m.id)) store.setCursor(roomId, m.id, lastId);
    }
  }

  // ---------------------------------------------------------------- 用户发消息

  /**
   * 用户发消息。
   * - DM：直接给那个 bot
   * - 群（部门）：交给部门老大先接，老大用 @ 往下派
   * - 正在跑：不报错，而是插话引导（steer）或排队（followUp）
   */
  async send(roomId, text, { mode = 'steer', attachments = [] } = {}) {
    const room = store.getRoom(roomId);
    if (!room) throw Object.assign(new Error('会话不存在'), { code: 'NO_ROOM' });
    const clean = String(text ?? '').trim();
    const files = (attachments ?? []).filter(Boolean);
    if (!clean && !files.length) throw Object.assign(new Error('消息为空'), { code: 'EMPTY' });

    const botId = this.targetBotFor(room);
    if (!botId) throw Object.assign(new Error('这个会话里没有 bot'), { code: 'NO_BOT' });
    const bot = store.getBot(botId);

    // 正在跑：插话 / 排队
    if (this.isBusy(roomId, botId)) {
      const entry = this.sessions.get(this.#key(roomId, botId));
      if (!entry?.session) {
        throw Object.assign(new Error('会话还没就绪，稍后再发'), { code: 'NOT_READY' });
      }
      const effective = mode === 'followUp' ? 'followUp' : 'steer';
      let queued;
      try {
        queued =
          effective === 'followUp' ? await entry.session.followUp(clean) : await entry.session.steer(clean);
      } catch (err) {
        throw Object.assign(new Error(`插话失败：${err?.message || err}`), { code: 'STEER_FAILED' });
      }
      const userMessage = store.appendMessage({
        roomId,
        authorType: 'user',
        authorName: '我',
        text: clean,
        status: 'done',
        meta: { queued: effective, queuedState: queued ?? 'queued' },
        attachments: hydrate(files),
      });
      bus.emit('event', {
        t: 'steer.accepted',
        roomId,
        mode: effective,
        text: clean,
        messageId: userMessage.id,
      });
      return { userMessage, bot, steered: effective };
    }

    const userMessage = store.appendMessage({
      roomId,
      authorType: 'user',
      authorName: '我',
      text: clean,
      status: 'done',
      attachments: hydrate(files),
    });

    if (room.kind === 'group') {
      // 部门：老大先接，再往下派
      this.#buildInput(clean, files)
        .then(({ promptText }) => this.runRound(roomId, { openerText: clean, attachmentContext: promptText, attachments: files }))
        .catch((err) => log('runRound 异常：', err?.stack || err));
    } else {
      this.#buildInput(clean, files)
        .then(({ promptText }) =>
          this.run(roomId, botId, promptText, { skipUserMessage: true, attachments: files }),
        )
        .catch((err) => log('run 异常：', err?.stack || err));
    }
    return { userMessage, bot, group: room.kind === 'group' };
  }

  // ---------------------------------------------------------------- 核心：跑一轮

  /**
   * @returns {Promise<{ok:boolean, text:string, ms:number, error?:string, messageId:string}>}
   */
  async run(
    roomId,
    botId,
    prompt,
    {
      timeoutMs = config.runTimeoutMs,
      meta = null,
      skipUserMessage = false,
      attachments = [],
      groupTurn = false,
    } = {},
  ) {
    const started = Date.now();
    const room = store.getRoom(roomId);
    if (!room) return { ok: false, text: '', ms: 0, error: '会话不存在', messageId: '' };

    let entry;
    try {
      entry = await this.#ensureSession(roomId, botId);
    } catch (err) {
      const message = String(err?.message || err);
      store.appendMessage({
        roomId,
        authorType: 'bot',
        authorId: botId,
        authorName: store.getBot(botId)?.name ?? botId,
        text: '',
        status: 'error',
        error: `起不来：${message}`,
      });
      return { ok: false, text: '', ms: Date.now() - started, error: message, messageId: '' };
    }

    entry.lastUsed = Date.now();
    const bot = entry.bot;
    const botMsg = store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: bot.id,
      authorName: bot.name,
      authorEmoji: bot.emoji,
      text: '',
      status: 'streaming',
      meta,
    });
    bus.emit('event', { t: 'typing', roomId, botId: bot.id, active: true });

    const committed = [];
    let buffer = '';
    let usage = null;
    const steps = [];

    const render = () => {
      const parts = [...committed];
      if (buffer) parts.push(buffer);
      return parts.join('\n\n');
    };
    const pushDelta = throttle(() => {
      bus.emit('event', { t: 'msg.delta', roomId, msgId: botMsg.id, text: render() });
    }, 80);
    const pushSteps = () => {
      bus.emit('event', { t: 'msg.steps', roomId, msgId: botMsg.id, steps: [...steps] });
      store.updateMessage(roomId, botMsg.id, { steps: [...steps] }, { silent: true });
    };

    let stepCapHit = false;
    const stepCap = groupTurn ? config.groupTurnMaxSteps : 0;

    const onEvent = (event) => {
      switch (event.type) {
        // ★ 上下文撞阈值，pi 正在把老消息总结掉。必须告诉用户 ——
        //   不告诉的话，界面上就是"bot 突然不动了"，看着像卡死。
        case 'compaction_start':
          bus.emit('event', {
            t: 'bot.compacting',
            roomId,
            botId: bot.id,
            active: true,
            reason: event.reason,
          });
          log(`[${bot.name}] 上下文压缩开始（${event.reason}）`);
          break;
        case 'compaction_end':
          bus.emit('event', {
            t: 'bot.compacting',
            roomId,
            botId: bot.id,
            active: false,
            reason: event.reason,
            error: event.errorMessage || null,
          });
          log(`[${bot.name}] 上下文压缩结束（${event.reason}）`);
          break;
        case 'message_start':
          if (event.message?.role === 'assistant') buffer = '';
          break;
        case 'message_update':
          if (event.assistantMessageEvent?.type === 'text_delta') {
            buffer += event.assistantMessageEvent.delta;
            pushDelta();
          }
          break;
        case 'message_end':
          if (event.message?.role === 'assistant') {
            const finalText = textOf(event.message) || buffer;
            if (finalText.trim()) committed.push(finalText.trim());
            buffer = '';
            usage = event.message.usage ?? usage;
            pushDelta.flush();
          }
          break;
        case 'tool_execution_start': {
          steps.push({
            tool: event.toolName,
            detail: summarizeArgs(event.args),
            status: 'running',
            startedAt: Date.now(),
          });
          pushSteps();
          // 部门内回答不该跑成长任务：超过上限就收住，避免一个成员把整个部门拖住
          if (stepCap > 0 && steps.length >= stepCap && !stepCapHit) {
            stepCapHit = true;
            log(`${bot.name} 在群里连跑了 ${steps.length} 步，收住`);
            entry.session.abort().catch(() => {});
          }
          break;
        }
        case 'tool_execution_end': {
          const step = [...steps].reverse().find((s) => s.status === 'running' && s.tool === event.toolName);
          if (step) {
            step.status = event.isError ? 'error' : 'done';
            step.durationMs = event.durationMs ?? Date.now() - step.startedAt;
          }
          pushSteps();
          break;
        }
        case 'queue_update':
          bus.emit('event', {
            t: 'queue',
            roomId,
            botId: bot.id,
            steering: event.steering ?? [],
            followUp: event.followUp ?? [],
          });
          break;
        default:
          break;
      }
    };

    const unsubscribe = entry.session.subscribe(onEvent);
    entry.unsubscribe = unsubscribe;
    entry.busy = true;

    // 用户带的图 -> 喂给模型（视觉模型能直接看）
    const images = [];
    for (const id of attachments) {
      const img = readForModel(id);
      if (img) images.push(img);
    }
    // bot 自己画图：记下开跑前的快照，跑完把新出现的图自动带上
    const beforeImages = config.autoAttachImages ? this.#snapshotImages() : null;

    let timeoutHandle = null;
    try {
      const runPromise = images.length
        ? entry.session.prompt(prompt, { images })
        : entry.session.prompt(prompt);
      // 部门里的单轮有额外时间预算：不能一个成员把整个部门卡住
      const effectiveTimeout = groupTurn ? Math.min(timeoutMs || config.groupTurnMaxMs, config.groupTurnMaxMs) : timeoutMs;
      if (effectiveTimeout > 0) {
        const timeout = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            entry.session.abort().catch(() => {});
            reject(new Error(`超过 ${Math.round(effectiveTimeout / 1000)}s 未完成，已中断`));
          }, effectiveTimeout);
        });
        await Promise.race([runPromise, timeout]);
      } else {
        await runPromise;
      }

      let finalText = render().trim();
      let emptyRecovered = false;

      // ★ 空回复兜底。两种失败模式：
      //   a) 完全没输出（实测某些「模型 × 思考等级」组合会静默吐空）
      //   b) 工具调了一堆但没说结论（assistant 最后一条是空的）
      //   两种都不能让用户看到空白。
      const toolNames = [...new Set(steps.map((s) => s.tool))];
      if (!finalText && !stepCapHit) {
        log(`[${bot.name}] ${steps.length ? `${steps.length} 步操作后没给结论` : '空回复'}，催一次…`);
        const nudge = steps.length
          ? `你刚才调用了工具（${toolNames.join('、')}）但没有给出结论。请用一两句话说明：你做了什么、结果是什么。不要调用工具。`
          : '你上一条没有输出任何内容。请直接用文字回答刚才的问题，不要调用工具。';
        try {
          await entry.session.prompt(nudge);
          finalText = render().trim();
          if (finalText) emptyRecovered = true;
        } catch (err) {
          log(`[${bot.name}] 催一次失败：`, err?.message || err);
        }
      }

      // 还是空 → 用最稳的模型直接补一段（不带工具，纯文字）
      //   串多个线路：单模型兜底也可能吐空，多试一个成功率明显更高
      if (!finalText && !stepCapHit) {
        log(`[${bot.name}] 仍然空，切兜底模型…`);
        const stepDigest = steps.length
          ? `\n\n你刚才实际执行了这些操作：\n${steps.map((s) => `- ${s.tool} ${s.detail ?? ''}`.slice(0, 160)).join('\n')}`
          : '';
        const userContent = `下面是你（另一个模型）接到的任务：\n\n${prompt.slice(0, 6000)}${stepDigest}\n\n请用几句话给出结论。`;
        const chain = [
          this.model,
          this.resolveModel('selfhost/wbi-deepseek-v4.1-flash'),
          this.resolveModel('selfhost/wb-glm-5.3-flash'),
        ]
          .filter(Boolean)
          .filter((m, i, arr) => arr.findIndex((x) => `${x.provider}/${x.id}` === `${m.provider}/${m.id}`) === i);

        for (const fallbackModel of chain) {
          try {
            const reply = await this.modelRuntime.completeSimple(
              fallbackModel,
              {
                systemPrompt: `${bot.persona ?? ''}\n\n你是「${bot.name}」。直接给结论，不要客套。`,
                messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
              },
              { maxTokens: 2048, reasoning: 'low' },
            );
            const fallbackText = textOf(reply).trim();
            if (fallbackText) {
              finalText = fallbackText;
              emptyRecovered = true;
              log(`[${bot.name}] 兜底成功（${fallbackModel.provider}/${fallbackModel.id}）`);
              break;
            }
          } catch (err) {
            log(`[${bot.name}] 兜底 ${fallbackModel.id} 失败：`, err?.message || err);
          }
        }
      }

      const produced = beforeImages ? this.#newImagesSince(beforeImages) : [];

      // 两次都救不回来 → 退而给一份操作摘要（总比一片空白好），并标成错误
      if (!finalText && !stepCapHit) {
        const digest = steps.length
          ? `（${bot.name} 执行了 ${steps.length} 步但没有给出说明）\n\n${steps
              .map((s) => `- \`${s.tool}\` ${s.detail ?? ''}`)
              .join('\n')}`
          : '';
        const msg = store.updateMessage(
          roomId,
          botMsg.id,
          {
            text: digest,
            status: 'error',
            error: `${bot.name} 没有给出内容（已自动重试两次）。可能是当前模型在 thinking ${bot.thinking} 档下不稳定，试试换个思考等级或换模型。`,
            steps,
            usage,
            attachments: produced,
          },
          { silent: true },
        );
        bus.emit('event', { t: 'msg.error', roomId, msgId: botMsg.id, error: msg.error, msg });
        return { ok: false, text: '', ms: Date.now() - started, error: msg.error, messageId: botMsg.id };
      }

      if (!finalText) finalText = '（在群里动手步数到上限，先收住）';
      if (emptyRecovered) finalText = `${finalText}\n\n_（原模型首次没出内容，已自动重试）_`;

      const msg = store.updateMessage(
        roomId,
        botMsg.id,
        {
          text: stepCapHit
            ? `${finalText}\n\n_（部门内单次最多动手 ${stepCap} 步，已收住；要它继续做完就在私聊里派活）_`
            : finalText,
          status: 'done',
          steps,
          usage,
          attachments: produced,
        },
        { silent: true },
      );
      bus.emit('event', { t: 'msg.done', msg });
      return { ok: true, text: finalText, ms: Date.now() - started, messageId: botMsg.id };
    } catch (err) {
      const message = String(err?.message || err);
      const partial = render().trim();
      if (stepCapHit) {
        const msg = store.updateMessage(
          roomId,
          botMsg.id,
          {
            text: `${partial || '（在群里动手步数到上限，先收住）'}\n\n_（部门内单次最多动手 ${stepCap} 步，已收住）_`,
            status: 'done',
            steps,
            usage,
          },
          { silent: true },
        );
        bus.emit('event', { t: 'msg.done', msg });
        return { ok: true, text: partial, ms: Date.now() - started, messageId: botMsg.id };
      }
      const msg = store.updateMessage(
        roomId,
        botMsg.id,
        { text: partial, status: 'error', error: message, steps, usage },
        { silent: true },
      );
      bus.emit('event', { t: 'msg.error', roomId, msgId: botMsg.id, error: message, msg });
      log(`[${bot.name}] 本轮出错：${message}`);
      return { ok: false, text: partial, ms: Date.now() - started, error: message, messageId: botMsg.id };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      unsubscribe?.();
      entry.unsubscribe = null;
      entry.busy = false;
      bus.emit('event', { t: 'typing', roomId, botId: bot.id, active: false });
      // 每轮结束报一次上下文占用 —— 放在 finally 里，成功/出错都会报，
      // 否则出错那轮的数字会一直停在旧值上。
      emitContext(roomId, bot.id, entry.session);
    }
  }

  /** ask_bot 用：让某个 bot 在某个会话里独立跑一轮 */
  async runBotOnce({ roomId, botId, prompt, timeoutMs, meta }) {
    if (this.isBusy(roomId, botId)) {
      return { ok: false, text: '', ms: 0, error: `${store.getBot(botId)?.name ?? botId} 正在忙` };
    }
    return this.run(roomId, botId, prompt, { timeoutMs, meta });
  }

  /** 总经理（主控）往部门下达任务：以主控身份发帖，然后触发一轮部门响应 */
  async dispatchToGroup({ roomId, text, fromBotId = null }) {
    const room = store.getRoom(roomId);
    if (!room) return { ok: false, error: '部门不存在' };
    const chief = fromBotId ? store.getBot(fromBotId) : store.mainBot();
    const msg = store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: chief?.id ?? 'chief',
      authorName: chief?.name ?? 'Pi',
      authorEmoji: chief?.emoji ?? 'π',
      text,
      status: 'done',
      meta: { via: 'dispatch' },
    });
    // 部门老大接着接单
    this.runRound(roomId, {
      openerText: text,
      openerBotId: chief?.id ?? null,
      openerName: chief?.name ?? '主控',
    }).catch((err) => log('dispatchToGroup 异常：', err?.stack || err));
    return { ok: true, messageId: msg.id };
  }

  async abort(roomId) {
    let aborted = false;
    for (const [key, entry] of this.sessions) {
      if (key.startsWith(`${roomId}:`) && entry.session && entry.busy) {
        await entry.session.abort().catch(() => {});
        aborted = true;
      }
    }
    return { aborted };
  }

  /** 换模型/改人设后，把该 bot 的所有会话作废 */
  /**
   * 只把内存里的会话丢掉，**保留会话文件** —— 下次开跑时按新配置重建，
   * 但对话历史还在。
   *
   * 和 resetSessionForBot 的区别很重要：那个会 clearSessionFile（等于让 bot 失忆），
   * 用在"换模型/开新会话"上是对的；而调上下文预算不该失忆 ——
   * 用户只是想让它"能装更多"，不是想让它忘掉刚才做的事。
   */
  reloadSessionForBot(botId) {
    let n = 0;
    for (const [key, entry] of [...this.sessions]) {
      if (!key.endsWith(`:${botId}`)) continue;
      try {
        entry.unsubscribe?.();
        entry.session?.dispose();
      } catch {
        /* ignore */
      }
      this.sessions.delete(key);
      n++;
    }
    if (n) log(`${store.getBot(botId)?.name ?? botId} 的会话已按新预算重建（历史保留）`);
    return n;
  }

  resetSessionForBot(botId) {
    let n = 0;
    for (const [key, entry] of [...this.sessions]) {
      if (!key.endsWith(`:${botId}`)) continue;
      try {
        entry.unsubscribe?.();
        entry.session?.dispose();
      } catch {
        /* ignore */
      }
      this.sessions.delete(key);
      const [roomId] = key.split(':');
      store.clearSessionFile(roomId, botId);
      n++;
    }
    return n;
  }

  /** 重开某个会话里所有 bot 的记忆 */
  resetRoomSessions(roomId) {
    let n = 0;
    for (const [key, entry] of [...this.sessions]) {
      if (!key.startsWith(`${roomId}:`)) continue;
      const botId = key.slice(roomId.length + 1);
      try {
        entry.unsubscribe?.();
        entry.session?.dispose();
      } catch {
        /* ignore */
      }
      this.sessions.delete(key);
      store.clearSessionFile(roomId, botId);
      n++;
    }
    return n;
  }

  disposeAll() {
    for (const entry of this.sessions.values()) {
      try {
        entry.unsubscribe?.();
        entry.session?.dispose();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }
}
