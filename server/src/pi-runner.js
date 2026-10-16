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
import { store, toolsForPolicy } from './store.js';
import { loadExtraProviders, settingsDefaultModel } from './providers.js';
import { modelGroups } from './model-groups.js';
import { ModelHealth } from './model-health.js';
import { buildChiefTools, buildCommonTools } from './tools.js';
import { defaultMenuSlug, logMenu, menuSlugs, resolveMenu } from './model-menu.js';
import { attachmentBlock } from './extract.js';
import { inboxPath, metaFor, readForModel, saveFromPath } from './attachments.js';
import { parseMentions } from './mentions.js';
import { log, pickEscalationHost, isSuperiorCall } from './util.js';
import { planItem, shouldStopRound, leftBehind } from './group-round.js';
import {
  applyCompactionBudget,
  readContext,
  withCapacity,
} from './context-budget.js';
import {
  composeGroupPrompt,
  departmentOf,
  lastMessageId,
  openingSpeakers,
  transcriptFor,
} from './group-prompt.js';

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
export function buildAppendSystemPrompt(bot = {}, { userName = '', policy = null } = {}) {
  const skills = Array.isArray(bot.skills) ? bot.skills.filter((s) => s?.title) : [];
  return [
    ...(bot.persona ? [bot.persona] : []),
    // ★ 你是谁 / 用户是谁。
    //   不写这个的话，bot 只能从人设里猜用户身份，或者干脆不称呼 ——
    //   而在群里它还需要知道"哪条是那个真人发的"（其余都是同事）。
    // ★ 两层意思都要说清：
    //   ① 它是谁（叫名字，别问"您是谁"）
    //   ② 它是什么分量（唯一的人、最高决策者、所有 bot 都归它指挥）——
    //      不说第二条的话，模型容易把用户当成"又一个来插话的同事"，
    //      甚至反过来跟它商量"要不要听你的"。
    `【在跟谁说话】叫「${userName || '用户'}」的那个人是这个系统里**唯一的真人**，` +
      '也是**唯一的决策者** —— 所有 bot（包括你）都归它指挥，它是最高权威。' +
      '其余发言的都是你的同事（bot）。直接称呼它，不用问"您是谁"、也不用自我介绍。' +
      `要提到它就用「${userName || '用户'}」。`,
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
    // ★ 称呼规矩，和上面那几条一样是"永远在"的。
    //   不写这条的话，模型会拿**内部角色词**当自称 —— persona 里写了
    //   "你是…总经理"，它回给用户的第一句话就是"我是你的总经理"。
    //   但用户给它起的名字才是我（用户原话："所有 bot 都要用用户给他命名的
    //   名字自称，其次是负责的内容"）。
    `【怎么自称】你的名字是「${bot.name || '它'}」。介绍自己就说这个名字，` +
      '然后说你负责什么（一两句就够）。\n' +
      '"总经理/部门老大/主控/成员"这些是内部角色词，不是名字 ——' +
      '不要拿它们当自称，也不要拿它们叫用户或同事。',
    '【说话规矩】给用户看的消息里，永远不要出现：模型名/线路名、思考等级、token 用量、id、\n' +
      '以及“谁是老大”“谁能力强”这类点评。职位（工程师/设计师/负责人）本身已经说明了分工和分量。\n' +
      '工具返回值里 «» 包起来的是内部参数，只给你自己用，不要转述。\n' +
      // 内部动作不对外播报
      '也不要报告你刚调了什么工具、查了什么记录、跑了几步 —— 直接给结果（用户问了才说）。\n' +
      '像真人老板拉群那样说话：说清要做什么、找谁对接，就够了，不要念名单。',
    // ★ 部门规矩：只读 / 必须附证据。两条都是"行为"，所以写进系统提示。
    //   （只读还有一道硬拦：建会话时直接不给改文件的工具 —— 见 #ensureSession）
    ...(policy?.dangerous === 'deny'
      ? [
          '【这个部门是只读的】你只能看（读文件、搜索、列目录），**不能改文件、不能跑命令**。\n' +
            '需要动东西时：说清楚要改什么、为什么，交给用户或主控定 —— 别试。',
        ]
      : []),
    ...(policy?.requireProof
      ? [
          '【交付要附证据】交活时把凭据一起给：命令的输出、改动的文件路径、测试结果。\n' +
            '不要只说"改好了"——没有证据的交付按未完成算。',
        ]
      : []),
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
    /** 心跳看门狗（一个进程只需要一个） */
    this.watchdog = null;
    /**
     * 房间级锁：一个房间同一时刻只能跑一个 runRound。
     *
     * 以前没有这层：群里用户连发两条消息，`send()` 只检查「老大忙不忙」，
     * 成员在跑的时候第二条消息会再开一个 runRound —— 两个轮次同时跑，
     * 各有一份 maxRuns 预算（限制失效），游标互相踩。
     */
    this.roundLocks = new Set();
    /** 用户按了终止的房间 —— 轮次循环看到它就停，不再往下派人 */
    this.aborting = new Set();
    /** 已经派出去、但异步的 run() 还没把 busy 设上的会话（key = roomId:botId） */
    this.dispatching = new Set();
    /** roomId -> { text, files }：锁被占时进来的消息，合并到这里等下一轮 */
    this.roundQueue = new Map();
  }

  /**
   * 群（部门）里触发一轮 —— 带房间级串行。
   *
   * 忙的时候**不并发**：把这条消息记进排队表，等当前这轮跑完直接接着跑一轮
   * （消息本身 send() 已经落库了，下一轮的 transcript 里必然带上它，不会丢）。
   */
  /**
   * 用户在群里说话、但房间里还有人在跑：让组长**当场**回一句。
   *
   * 不打断正在干的人（各有各的会话），只是不让用户排在机器后面 ——
   * 用户是最高权威，不该等一个成员把手上的活磨完（那可能是几分钟）。
   */
  async #answerUserNow(roomId, leadBot, files) {
    const room = store.getRoom(roomId);
    if (!room) return;
    const { members, leadId } = departmentOf(room);
    const fresh = transcriptFor(roomId, leadBot.id);
    const prompt = composeGroupPrompt(room, leadBot, fresh, {
      isLead: leadBot.id === leadId,
      reason: '用户在群里刚说了话，先回应用户',
      members,
      leadId,
      order: { index: 1 },
    });
    await this.run(roomId, leadBot.id, prompt, {
      groupTurn: true,
      attachments: files,
    });
  }

  #dispatchGroupRound(roomId, text, files) {
    if (this.roundLocks.has(roomId) || this.isRoomBusy(roomId)) {
      const pending = this.roundQueue.get(roomId);
      this.roundQueue.set(roomId, {
        text: pending ? `${pending.text}\n${text}` : text,
        files: pending ? [...pending.files, ...files] : [...files],
      });
      log(`【${store.getRoom(roomId)?.name ?? roomId}】房间正忙，这条消息排队等下一轮`);
      return Promise.resolve();
    }
    this.roundLocks.add(roomId);
    return this.#drainGroupRounds(roomId, { text, files });
  }

  /** 把排队的一轮轮跑掉；跑完（或出错）都要释放房间锁 */
  async #drainGroupRounds(roomId, first) {
    let next = first;
    try {
      while (next) {
        try {
          const { promptText } = await this.#buildInput(next.text, next.files);
          await this.runRound(roomId, {
            openerText: next.text,
            attachmentContext: promptText,
            attachments: next.files,
          });
        } catch (err) {
          // 单轮炸掉不能把整个房间锁死，也不能吞掉排队的那条
          log('runRound 异常：', err?.stack || err);
        }
        // 取下一轮 + 释放锁之间不能有 await，否则新消息会落在缝里丢掉
        next = this.roundQueue.get(roomId) ?? null;
        if (next) this.roundQueue.delete(roomId);
      }
    } finally {
      this.roundLocks.delete(roomId);
    }
  }

  /**
   * 心跳机制 —— 给干活的 bot 们装上“我还活着”。
   *
   * 用户原话：“做个心跳机制可以给工程师 bot 们，这样如果任务中断了，
   * 组长 / 部长级别的知晓。”
   *
   * 为什么不能只看“进程还在不在”：最常见的卡死是**进程好好的、但那一轮
   * 再也不出声了**（工具挂住、socket 半死）。外面看到的就是永远转圈。
   *
   * 所以这里做两件事：
   *   · 每 config.heartbeatMs 报一次“还活着，最后一次动静是 N 秒前”；
   *   · 超过 config.stallMs 没动静 → 判为中断：收尾那一轮，并**上报组长**。
   */
  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(
      () => this.#beatAll(),
      Math.max(5_000, config.heartbeatMs),
    );
    // 别因为这个定时器把进程吊着不退
    this.watchdog.unref?.();
    log(
      `💓 心跳看门狗已启动：每 ${Math.round(Math.max(5_000, config.heartbeatMs) / 1000)}s 报一次，` +
        `超过 ${Math.round(config.stallMs / 1000)}s 没动静就判为中断并上报组长`,
    );
  }

  #beatAll() {
    const nowMs = Date.now();
    for (const [key, entry] of this.sessions) {
      if (!entry.busy) continue;
      const sep = key.indexOf(':');
      const roomId = key.slice(0, sep);
      const botId = key.slice(sep + 1);
      const ageMs = nowMs - (entry.progressAt ?? entry.startedAt ?? nowMs);
      bus.emit('event', {
        t: 'bot.heartbeat',
        roomId,
        botId,
        ageMs,
        startedAt: entry.startedAt ?? null,
      });
      if (ageMs < config.stallMs || entry.stallNotified) continue;
      entry.stallNotified = true;
      this.#onStall(roomId, botId, entry, ageMs);
    }
  }

  /** 心跳断了：收尾这一轮 + 让组长知道 */
  #onStall(roomId, botId, entry, ageMs) {
    const bot = store.getBot(botId);
    const secs = Math.round(ageMs / 1000);
    log(`💔 ${bot?.name ?? botId} 已经 ${secs}s 没动静 —— 判为中断，收尾并上报`);
    // ① 把这一轮捣掉（它已经没动静了）
    entry.session?.abort?.().catch(() => {});
    // ② 正在写的那条消息得收尾 —— 不收的话客户端永远转圈
    const msgId = entry.liveMsgId;
    if (msgId) {
      const msg = store.getMessage(roomId, msgId);
      store.updateMessage(
        roomId,
        msgId,
        {
          status: 'error',
          error: `心跳断了：${secs} 秒没动静，这一轮已中断`,
          steps: (msg?.steps ?? []).map((s) =>
            s?.status === 'running'
              ? { ...s, status: 'error', error: '心跳断了，这一步中断' }
              : s,
          ),
        },
        { silent: false },
      );
    }
    // ③ 让该知道的人知道，并请它重新安排
    this.escalate({
      roomId,
      fromBotId: botId,
      reason: `心跳断了：已经 ${secs} 秒没动静，这一轮中断了`,
      prefer: 'lead',
    }).catch((err) => log('上报中断失败：', err?.message || err));
  }

  /**
   * 有活卡住 / 没派出去 → 让“该知道的人”知晓，并请它重新安排。
   *
   * prefer='lead'：群里的活先找**组长**（用户说的“组长 / 部长级别”）；
   *               没有组长（私聊）就找主控。
   * prefer='chief'：直接找主控（派活失败时用）。
   */
  async escalate({ roomId, fromBotId, reason, task = '', attempts = 0, why = '', prefer = 'lead' }) {
    const room = store.getRoom(roomId);
    const chief = store.mainBot();
    const target = pickEscalationHost({
      roomKind: room?.kind,
      leadBotId: room?.leadBotId ?? null,
      fromBotId,
      chiefId: chief?.id ?? null,
      prefer,
    });
    if (!target.hostId) return null;
    const host = store.getBot(target.hostId);
    if (!host) return null;
    // 组长：就在群里说（用户也看得见“这单断了”）；主控：在它的私聊里说
    const inRoom = target.role === 'lead' ? roomId : store.ensureDm(host.id)?.id ?? null;
    if (!inRoom) return null;

    const from = store.getBot(fromBotId);
    const note =
      `[这单断了] ${from?.name ?? fromBotId}：${reason}` +
      (attempts ? `（试了 ${attempts} 次，${why}）` : '') +
      (task ? `\n\n原任务：${task.slice(0, 600)}` : '') +
      `\n\n请你重新安排：换个人，或者再派一次。`;
    store.appendMessage({
      roomId: inRoom,
      authorType: 'system',
      authorId: host.id,
      authorName: '中断回执',
      text: note,
      status: 'done',
      meta: { via: 'escalate', aboutBotId: fromBotId },
    });
    // 光留一条消息它不会自己动 —— 顺手叫醒它，让它当场重新安排
    this.run(inRoom, host.id, `【系统】${note}`, {
      skipUserMessage: true,
      timeoutMs: 300_000,
    }).catch((err) => log('叫醒失败：', err?.message || err));
    return { hostId: host.id, roomId: inRoom };
  }

  async init() {
    this.modelRuntime = await ModelRuntime.create();
    // 心跳看门狗：发现的“卡死不动”由它负责收尾 + 上报
    this.startWatchdog();
    // 部门规矩变了 → 作废空闲会话（工具集和系统提示是建会话时定的，不重建不生效）
    bus.on('event', (ev) => {
      if (ev?.t === 'policy.updated') this.applyPolicyChange();
    });

    for (const [providerId, providerConfig] of Object.entries(loadExtraProviders())) {
      try {
        this.modelRuntime.registerProvider(providerId, providerConfig);
      } catch (err) {
        log(`⚠️  provider ${providerId} 注册失败：${err?.message || err}`);
      }
    }

    // 自定义模型组也要注册进来（用户自己加的 baseUrl/key）
    this.registeredGroups = new Set();
    this.syncModelGroups();

    const candidates = [config.model, settingsDefaultModel()].filter(Boolean);
    for (const slug of candidates) {
      const found = this.resolveModel(slug);
      if (found) {
        this.model = found;
        break;
      }
    }

    await this.refreshAvailableModels();

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

    // 菜单里那些模型的「档位矩阵」：找出会静默返回空的组合（思考等级 × 模型）
    this.health
      .runLevelMatrix(menuSlugs())
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

  /** 重新读一遍可用模型（增删模型组之后要调，否则 App 的列表还是旧的） */
  async refreshAvailableModels() {
    if (!this.modelRuntime) return;
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
  }

  /**
   * 把用户自定义的模型组同步到模型运行时。
   *
   * pi 的 registerProvider/unregisterProvider 运行时就能调，所以**加完不用重启** ——
   * 用户填完 baseUrl/key 立刻能在模型列表里选到。
   *
   * 删掉的组必须显式注销，否则菜单里会留一个选不动的幽灵项
   * （选中之后请求发到一个已经没了的 provider，报的错还很难懂）。
   */
  syncModelGroups() {
    if (!this.modelRuntime) return;
    this.registeredGroups ??= new Set();
    const wanted = modelGroups.toProviderConfigs();

    for (const id of [...this.registeredGroups]) {
      if (wanted[id]) continue;
      try {
        this.modelRuntime.unregisterProvider(id);
        log(`🔌 模型组已移除：${id}`);
      } catch (err) {
        log(`⚠️  注销模型组 ${id} 失败：`, err?.message || err);
      }
      this.registeredGroups.delete(id);
    }

    for (const [id, cfg] of Object.entries(wanted)) {
      try {
        this.modelRuntime.registerProvider(id, cfg);
        this.registeredGroups.add(id);
      } catch (err) {
        log(`⚠️  注册模型组 ${id} 失败：`, err?.message || err);
      }
    }
  }

  /** 改完模型组：重新注册 + 刷新列表，然后广播一声让 App 更新 */
  async applyModelGroupChange() {
    this.syncModelGroups();
    await this.refreshAvailableModels();
    bus.emit('event', { t: 'models.changed' });
    return this.availableModels?.length ?? 0;
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
        appendSystemPrompt: buildAppendSystemPrompt(bot, {
          userName: store.userName(),
          // 部门规矩跟着会话走：工具集是建会话时定的，规矩变了会作废重建
          policy: store.policy(),
        }),
        noExtensions: config.noExtensions || undefined,
      });
      await resourceLoader.reload();

      // ★ 部门规矩：只读部门不给"能拆家"的工具。
      //
      //   这是**能真拦住**的那种约束 —— 不给工具，它就干不了；
      //   靠系统提示里写"请先征求同意"是拦不住的（模型忙起来就忘了）。
      //   看还是能看的（read/ls/find/grep 留着）。
      const rawTools = isChief ? config.chiefTools : config.tools;
      const baseTools = toolsForPolicy(rawTools, store.policy());
      const options = {
        cwd: config.workspace,
        sessionManager,
        resourceLoader,
        tools: [...baseTools, ...customTools.map((t) => t.name)],
        customTools,
        // ★★★ 把我们自己的 model runtime 传进去。
        //
        //   不传的话，pi 会**另造一个** runtime（默认只认 ~/.pi/agent/auth.json
        //   和 models.json）—— 而用户在 App 里配的模型组（baseUrl + key + 模型名）
        //   是**运行时注册到我们这个 runtime 上**的，那个新造的 runtime 根本不知道。
        //
        //   症状就是这个反复出现的报错：
        //       No API key found for local_cline.
        //   而且很骗人 —— 探活/模型菜单（走我们的 runtime）一直显示 ★ 可用，
        //   一到真跑就找不到 key。用户"每次重启、重组队伍都不行"就是这个。
        //   （cline 能用是因为 pi 自己会从 ~/.pi/agent/extensions 加载那个扩展，
        //    而用户在 App 里配的模型组没有对应的扩展文件。）
        modelRuntime: this.modelRuntime,
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
    const key = this.#key(roomId, botId);
    // ★ 同步占位也算忙。
    //
    //   群聊改成并行之后，同一个成员可能在同一波里被派两次（比如两个人同时 @ 了它，
    //   而它这一轮还有额度）。而 run() 是**异步**的 —— 等它把 entry.busy 设上已经晚了，
    //   两个 prompt() 会同时打到同一个 session，第二个直接抛：
    //       Agent is already processing. Specify streamingBehavior ('steer' or
    //       'followUp') to queue the message.
    //   所以派单那一刻就要**同步**登记，别等异步。
    if (this.dispatching?.has(key)) return true;
    return Boolean(this.sessions.get(key)?.busy);
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
    const { leadId } = departmentOf(room);
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
  /**
   * 群（部门）里跑一轮。
   *
   * 流程：定首发人 → 依次跑 → 每个 bot 的输出里 @了谁，谁就排到队尾接着跑。
   * 每人有轮次预算（老大多一些），自己来回的轮数也有上限，防止部门内部无限互吹。
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
    const { members, leadId } = departmentOf(room);
    if (!members.length) return;

    const opening = openingSpeakers(room, { text: openerText, openerBotId, kickoff });
    if (!opening.length) return;

    // 轮次预算从 store 读（用户可在设置里改），config 只是默认值
    const limits = store.groupLimits();
    const budget = (botId) => (botId === leadId ? limits.leadTurns : limits.memberTurns);
    const used = new Map();
    const chiefId = store.mainBot()?.id ?? null;
    const queue = opening.map((botId) => ({
      botId,
      reason: kickoff ? '部门刚成立，先由你安排' : openerBotId ? `${openerName} 叫了你` : '用户发了新消息',
      fromId: openerBotId ?? null,
      fromName: openerName,
      fromText: openerText,
    }));

    log(
      `【${room.name}】${openerBotId ? `${openerName} 发言` : '用户发言'} → 首发：${opening
        .map((id) => store.getBot(id)?.name ?? id)
        .join('、')}`,
    );

    let runs = 0;
    // ★ 同一波的人**同时**发出去。
    //
    //   用户：“我要的是 群组内有多少人 就要多少个 并发，可以让组长自行决定先后”
    //   以前是 `await this.run(...)` 一个一个来 —— 组长一次 @ 了六个人，
    //   实际就是六倍时长，界面上永远是“只有一个在跑，其他 bot 呢？”。
    //
    //   这也正是 ds-bot 的做法（groups.js 开头那句）：
    //     "Work does not hold a round up" —— 谁还在忙就让这一轮往下走，
    //     它干完自己发。每个成员都被告知自己是第几个（You are number N of M）。
    //
    //   做法：能派的人先发出去（不 await），任务进 pending；
    //   队列空了就等这一波落地 —— 它们回复里 @ 的人会补进队列，
    //   于是自然形成“一波接一波”，而不是一串排队。
    const pending = [];
    // 循环出口统一交给 shouldStopRound：终止、队列空了且没人在跑、预算用完，
    // 三种"不继续"的理由在一个地方说了算（以前散在循环条件和几处 break 里）。
    for (;;) {
      const stop = shouldStopRound({
        queueLen: queue.length,
        pendingLen: pending.length,
        runs,
        maxRuns: limits.maxRuns,
        aborting: this.aborting.has(roomId),
      });
      if (stop.stop) {
        if (queue.length) {
          // 不管是终止还是预算掐断，都要留痕 —— 用户报过"组长明明 @ 了，
          // 怎么只有一个 bot 动起来"，而以前这类出口全是静默的。
          log(
            stop.why === '已终止'
              ? `【${room.name}】⏹ 已终止，剩下的 ${queue.length} 个人不再派`
              : `【${room.name}】⚠️ ${stop.why}，还有 ${queue.length} 个人没轮到：` +
                  leftBehind(queue, (id) => store.getBot(id)?.name ?? id).join('、'),
          );
        }
        if (stop.why === '已终止') queue.length = 0;
        break;
      }
      if (!queue.length) {
        await Promise.allSettled(pending.splice(0));
        continue;
      }
      const item = queue.shift();
      const bot = store.getBot(item.botId);
      if (!bot) continue;
      const done = used.get(item.botId) ?? 0;
      const busyNow = this.isBusy(roomId, bot.id);
      const superior = isSuperiorCall({
        fromId: item.fromId,
        fromRole: item.fromId ? 'bot' : 'user',
        leadId,
        chiefId,
        selfId: bot.id,
      });
      // 决策交给纯函数（group-round.js）：那边只回答"该做什么"，
      // 这边只负责执行 —— 行动作一个字节没改，变的只是判断从哪来。
      const plan = planItem({
        item,
        name: bot.name,
        done,
        budget: budget(bot.id),
        busy: busyNow,
        superior,
      });
      if (plan.kind === 'skip') {
        log(`【${room.name}】${plan.why} → 不再叫它`);
        continue;
      }
      // ★ 上级叫它 → 无论多忙都要**停下来听**。
      //
      //   用户原话：“无论多忙 当组长 部长 自己上级@的时候 必须先停下来听最新的
      //   要求，同时上报目前自己的进度。”
      //
      //   上一版我写成了“等它忙完再派” —— 方向不对：上级的要求是**实时**的，
      //   等它把手上的活磨完可能已经几分钟过去了。所以这里改成 steer：
      //   把上级那句“先停下、先报进度、再按新要求干”直接插进它正在跑的那一轮。
      //      · 是上级 / 用户 → 打断（steer）
      //      · 只是同级同事 → 不打断，排队等它忙完（不然群里会互相擂断）
      if (plan.kind === 'interrupt' || plan.kind === 'queue') {
        const entry = this.sessions.get(this.#key(roomId, bot.id));
        if (plan.kind === 'interrupt' && entry?.session) {
          const steered =
            `【${item.fromName || '上级'} 叫停】先把你手上正在做的事停一下。\n\n` +
            `${item.fromName || '上级'} 刚刚说：\n` +
            `${(item.fromText || '').slice(0, 1200) || '（看群里的最新消息）'}\n\n` +
            '请先回报一句：你现在做到哪一步了、还差什么。\n' +
            '然后按上面的新要求继续 —— 新要求优先于你手上正在做的事。';
          try {
            await entry.session.steer(steered);
            log(`【${room.name}】上级改主意了 → 叫停 ${bot.name}（它正忙，让它先报进度再接新要求）`);
            store.appendMessage(
              {
                roomId,
                authorType: 'system',
                authorId: bot.id,
                authorName: '叫停回执',
                text: `已叫停${bot.name}：让它先报进度，再按新的要求继续。`,
                status: 'done',
                meta: { via: 'steer_by_superior', fromId: item.fromId ?? null },
              },
              // 插在它正在写的那条之前 —— 读起来是“叫停 → 它的回应”
              { beforeStreaming: true },
            );
            continue;
          } catch (err) {
            log(`叫停 ${bot.name} 失败：${err?.message || err}`);
          }
        }
        log(`【${room.name}】${bot.name} 还在忙 → 等它空下来再派（${item.reason}）`);
        // ★ 同级同事 @ 它：不打断，但**消息必须送到**。
        //
        //   这是学 ds-bot 的做法（`groups.js` 那句 "the call waits in its inbox →
        //   and is answered after that"）：忙就不等，把话投进它的 inbox，
        //   它手上的活做完自己会看到。比"死等两分钟"快，也不会等到一半就丢掉。
        if (entry?.session?.followUp) {
          try {
            await entry.session.followUp(
              `【${item.fromName || '同事'} 找你】${item.fromName || '同事'} 刚在群里说：\n` +
                `${(item.fromText || '').slice(0, 1200) || '（看群里的最新消息）'}\n\n` +
                '你手上那件做完之后再处理这条（不急，但也别忘了）。',
            );
            log(`【${room.name}】把话投进 ${bot.name} 的 inbox（它在忙，忙完自己看）`);
            store.appendMessage(
              {
                roomId,
                authorType: 'system',
                authorId: bot.id,
                authorName: '投递回执',
                text: `${bot.name} 正在忙：这句已经放进它的待办，忙完会看到。`,
                status: 'done',
                meta: { via: 'queued_for_busy', fromId: item.fromId ?? null },
              },
              { beforeStreaming: true },
            );
            continue;
          } catch (err) {
            log(`投递给 ${bot.name} 失败：${err?.message || err}`);
          }
        }
        // 投递也失败 → 退回等待，再不行就上报（绝不静默丢掉）
        const deadline = Date.now() + config.groupBusyWaitMs;
        while (this.isBusy(roomId, bot.id) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (this.isBusy(roomId, bot.id)) {
          log(`【${room.name}】${bot.name} 一直忙，这一单没派出去 → 上报`);
          this.escalate({
            roomId,
            fromBotId: bot.id,
            reason: `要派给${bot.name}的活一直没派出去（它忙了 ${Math.round(config.groupBusyWaitMs / 1000)} 秒以上）`,
            prefer: 'lead',
          }).catch((err) => log('上报失败：', err?.message || err));
          continue;
        }
      }
      used.set(item.botId, done + 1);
      runs++;
      // ★ 同步占位：别等异步的 run() 去设 busy（那之间会漏一个窗口，
      //   同一个人被派两次 → session 报 "Agent is already processing"）
      const dispatchKey = this.#key(roomId, bot.id);
      this.dispatching.add(dispatchKey);

      const fresh = transcriptFor(roomId, bot.id);
      let prompt = composeGroupPrompt(room, bot, fresh, {
        isLead: bot.id === leadId,
        reason: item.reason,
        members,
        leadId,
        // ★ 组长定的先后（用户：“可以让组长自行决定先后”）：
        //   把“你是第几个被叫到的”写进它的提示 —— 被叫的顺序就是组长 @ 的顺序。
        order: { index: runs },
      });
      if (attachmentContext) prompt = `${attachmentContext}\n\n${prompt}`;

      // ★ 不 await：同一波的人同时开干（群里有几个人就几个并发）
      pending.push(
        (async () => {
          try {
            const res = await this.run(roomId, bot.id, prompt, {
              groupTurn: true,
              attachments,
            });
          store.setCursor(roomId, bot.id, lastMessageId(roomId));

          // 没成也得说一声 —— 不然"叫了它但没动静"没人知道
          if (!res.ok) {
            log(
              `【${room.name}】${bot.name} 这轮没跑成：${res.error ?? '未知原因'}（${item.reason}）`,
            );
            return;
          }
          const text = res.text.trim();
          if (/^\[?PASS\]?$/i.test(text)) {
            store.deleteMessage(roomId, res.messageId);
            log(`${bot.name} PASS`);
            return;
          }

          // 它 @ 了谁，谁就接着上（下一波）
          const { all, found } = parseMentions(text, members, {
            selfId: bot.id,
          });
          const next = all
              ? members.filter((m) => m.id !== bot.id).map((m) => m.id)
              : found;
          const queued = new Set(queue.map((q) => q.botId));
          for (const id of next) {
            if (id === bot.id || queued.has(id)) continue;
            queue.push({
              botId: id,
              reason: `${bot.name} 叫了你`,
              fromId: bot.id,
              fromName: bot.name,
              fromText: text,
            });
            queued.add(id);
          }
          } finally {
            // 占位要还回去 —— 不然这个人就永远"忙"了，后面再也派不动
            this.dispatching.delete(dispatchKey);
          }
        })().catch((err) =>
          log(`【${room.name}】${bot.name} 这一轮异常：`, err?.message || err),
        ),
      );
    }
    // 收尾：还在跑的人别被丢下（它们的 @ 已经在上面补进队列了）
    await Promise.allSettled(pending);

    // 没被叫到的成员也算「看过这条了」，避免下次一次性倒一堆旧账
    const lastId = lastMessageId(roomId);
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
      const userMessage = store.appendMessage(
        {
          roomId,
          authorType: 'user',
          authorName: '我',
          text: clean,
          status: 'done',
          meta: { queued: effective, queuedState: queued ?? 'queued' },
          attachments: hydrate(files),
        },
        // ★ 用户的消息**就落在最新**（用户：“我的信息应该在最下面”）。
        //   以前是插在“它正在写的那条回复”之前 —— 那样读起来因果更顺，
        //   但那个回复可能是几分钟前开始的，一插就插到聊天记录中间去了，
        //   用户找不到自己刚说的话。现在直接追加到底部。
        {},
      );
      bus.emit('event', {
        t: 'steer.accepted',
        roomId,
        mode: effective,
        text: clean,
        messageId: userMessage.id,
      });
      return { userMessage, bot, steered: effective };
    }

    // 新消息 = 新一轮：把上一轮的"已终止"标记清掉，
    // 否则这个房间会一直停在终止状态，之后发什么都被跳过。
    this.aborting.delete(roomId);
    const userMessage = store.appendMessage({
      roomId,
      authorType: 'user',
      authorName: '我',
      text: clean,
      status: 'done',
      attachments: hydrate(files),
    });

    if (room.kind === 'group') {
      // ★ 用户说话必须优先。
      //
      //   真事：一个成员挂了（超时被收住），用户在群里发话 —— 组长半天不响。
      //   因为群聊有房间锁，而这锁是“忙则排队”：只要还有人在跑，
      //   用户这条就被排到下一轮（日志里是“房间正忙，这条消息排队等下一轮”），
      //   而那个成员可能还要跑好几分钟。
      //
      //   用户是最高权威，不该排在机器后面。所以：别人继续跑（各干各的），
      //   但组长当场回你一句 —— 它自己的会话是独立的，不会把正在干的人打断。
      const roomBusy =
        this.roundLocks.has(roomId) || this.isRoomBusy(roomId);
      if (roomBusy && !this.isBusy(roomId, botId)) {
        log(`【${room.name}】房间在忙，但用户说话了 → 让组长当场先回`);
        this.#answerUserNow(roomId, bot, files).catch((err) =>
          log('当场回应失败：', err?.message || err),
        );
      } else {
        // 部门：老大先接，再往下派（房间级串行，忙则排队）
        this.#dispatchGroupRound(roomId, clean, files).catch((err) =>
          log('runRound 异常：', err?.stack || err),
        );
      }
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
    // ★ 心跳：这一轮从什么时候开始、最后一次动静是什么时候、
    //   以及它正在写的是哪条消息（卡死时要拿这个收尾）。
    entry.startedAt = Date.now();
    entry.progressAt = entry.startedAt;
    entry.stallNotified = false;
    const beat = () => {
      entry.progressAt = Date.now();
    };
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
    entry.liveMsgId = botMsg.id;
    beat();
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
      beat();
      bus.emit('event', { t: 'msg.delta', roomId, msgId: botMsg.id, text: render() });
    }, 80);
    const pushSteps = () => {
      beat();
      bus.emit('event', { t: 'msg.steps', roomId, msgId: botMsg.id, steps: [...steps] });
      store.updateMessage(roomId, botMsg.id, { steps: [...steps] }, { silent: true });
    };

    let stepCapHit = false;
    // 部门里"最多来回几轮"（对话轮次，不是工具调用次数）
    const turnCap = groupTurn ? store.groupLimits().maxSteps : 0;
    let turns = 0;

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
        case 'compaction_end': {
          bus.emit('event', {
            t: 'bot.compacting',
            roomId,
            botId: bot.id,
            active: false,
            reason: event.reason,
            error: event.errorMessage || null,
          });
          log(`[${bot.name}] 上下文压缩结束（${event.reason}）`);
          // ★ 压缩这件事必须**出现在对话里**，不能只藏在状态里。
          //   否则用户看到的是"bot 刚才那几轮说的话不见了"，完全不知道发生了什么。
          //   留一条 kind='compact' 的记录，App 把它画成对话中间的一条小横条。
          const res = event.result;
          if (res && !event.aborted && !event.errorMessage) {
            const saved = res.tokensBefore
              ? Math.max(0, res.tokensBefore - (res.estimatedTokensAfter ?? 0))
              : null;
            store.appendMessage({
              roomId,
              authorType: 'system',
              authorId: bot.id,
              authorName: bot.name,
              kind: 'compact',
              text: '',
              status: 'done',
              meta: {
                reason: event.reason,
                tokensBefore: res.tokensBefore ?? null,
                tokensAfter: res.estimatedTokensAfter ?? null,
                saved,
              },
            });
          }
          break;
        }
        case 'message_start':
          if (event.message?.role === 'assistant') {
            buffer = '';
            turns++;
            // ★ 部门内的"步数"上限按**对话轮次**算，不按工具调用次数算。
            //
            //   用户原话："这个步数 不是算工具调用多少次，是每次干完要多次对话，
            //   步数是对话次数 —— 你这 30 步很多模型活都干不完，对话次数算才行。"
            //
            //   一次 assistant 发言 = 一轮（里面可能带好几个工具调用，也可能
            //   一个工具都不用、只是接着想）。按工具调用算的话，模型连查带改
            //   跑十几个 bash 就把额度烧光了 —— 活才刚开个头。
            if (turnCap > 0 && turns >= turnCap && !stepCapHit) {
              stepCapHit = true;
              log(`${bot.name} 在群里来回 ${turns} 轮，收住`);
              entry.session.abort().catch(() => {});
            }
          }
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
    // 已经按了终止的会话：这一轮就别起了（排队里被点掉的那些）
    if (this.aborting.has(roomId)) {
      log(`${bot.name} 这一轮已经被用户终止，跳过`);
      return { ok: false, text: '', ms: 0, error: '已终止', messageId: '' };
    }
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
      // ★ 兜底：万一还是撞上"这个会话正在处理"（并发下理论上不该有了，
      //   但外部/扩展也能直接调 prompt），**别把红字甩给用户** ——
      //   改成排队投递（followUp），它干完手上的自己会看到。
      const startTurn = async () => {
        try {
          return images.length
            ? await entry.session.prompt(prompt, { images })
            : await entry.session.prompt(prompt);
        } catch (err) {
          const msg = String(err?.message || err);
          if (!/already processing/i.test(msg) || !entry.session.followUp) throw err;
          log(`${bot.name} 那一轮还没完，这条改成排队投递（followUp）`);
          return entry.session.followUp(prompt);
        }
      };
      const runPromise = startTurn();
      // 部门里的单轮有额外时间预算：不能一个成员把整个部门卡住
      const capMs = store.groupLimits().turnMaxMs;
      const effectiveTimeout = groupTurn ? Math.min(timeoutMs || capMs, capMs) : timeoutMs;
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
            ? `${finalText}\n\n_（部门里一次最多来回 ${turnCap} 轮，已收住；要它继续做完就在私聊里派活）_`
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
            text: `${partial || '（在群里来回轮数到上限，先收住）'}\n\n_（部门里一次最多来回 ${turnCap} 轮，已收住）_`,
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
      entry.liveMsgId = null;
      entry.startedAt = null;
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
    // 用户按了停止：排队中的轮次一并清掉，不然它会在当前这轮结束后自己接着跑
    this.roundQueue.delete(roomId);
    // ★ 还要告诉**正在跑的那轮**别再往下派人了。
    //
    //   真事：用户点终止之后"还要等很久"。因为以前只 abort 了当前这个 session ——
    //   而群聊那一轮是个循环（组长→成员→成员…），当前这个被捣掉之后，
    //   循环接着把下一个成员派出去。从用户角度看就是"点了没反应"。
    this.aborting.add(roomId);
    let aborted = false;
    const live = [];
    for (const [key, entry] of this.sessions) {
      if (key.startsWith(`${roomId}:`) && entry.session && entry.busy) {
        live.push({ key, entry });
        entry.session.abort().catch(() => {});
        aborted = true;
      }
    }
    // ★ 不等 session 那边慢慢收尾（它可能还卡在一个长命令里）——
    //   先把界面上的"正在写"当场结掉：用户按了停止，界面必须马上停。
    const botIds = live.map((x) => x.key.slice(roomId.length + 1));
    const stamp = Date.now();
    for (const msg of store.listMessages(roomId, { limit: 200 })) {
      if (msg.status !== 'streaming') continue;
      if (!botIds.includes(msg.authorId)) continue;
      store.updateMessage(
        roomId,
        msg.id,
        {
          status: 'error',
          error: '已按你的要求终止',
          steps: (msg.steps ?? []).map((s) =>
            s?.status === 'running' ? { ...s, status: 'error', error: '已终止' } : s,
          ),
        },
        { silent: false },
      );
    }
    for (const id of botIds) {
      bus.emit('event', { t: 'typing', roomId, botId: id, active: false });
    }
    log(`⏹ 收到终止：${roomId}（停了 ${live.length} 个在跑的，${stamp ? '' : ''}队列也清了）`);
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

  /**
   * 把所有内存里的会话丢掉，下次开跑时按最新配置重建（**历史保留**）。
   *
   * 用户改自己的名字之后要调它：名字是拼进系统提示的，而提示只在建会话时构造一次 ——
   * 不重建的话，改名只对"以后新开的会话"生效，正在用的那些还记着旧名字
   * （用户明确要求"每次修改要通知到全局"）。
   */
  reloadAllSessions() {
    let n = 0;
    for (const key of [...this.sessions.keys()]) {
      const [, botId] = key.split(':');
      n += this.reloadSessionForBot(botId);
    }
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

  /**
   * 部门规矩变了 → 把会话作废重建。
   *
   * 为什么要重建：工具集和系统提示都是**建会话时**定下来的，
   * 不重建的话"改成只读"要等到会话自然过期才生效 —— 用户会以为没生效。
   * （对话历史保留，只是会话本身重新开一个。）
   */
  applyPolicyChange() {
    let n = 0;
    for (const [key, entry] of [...this.sessions]) {
      if (entry.busy) continue; // 正在跑的这轮不打断，它结束后下次自然重建
      try {
        entry.unsubscribe?.();
        entry.session?.dispose();
      } catch {
        /* ignore */
      }
      this.sessions.delete(key);
      n++;
    }
    if (n) log(`⚙️ 部门规矩变了 → 作废 ${n} 个空闲会话（下次跑会用新规矩重建）`);
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
