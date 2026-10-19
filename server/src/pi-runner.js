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
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { config } from './config.js';
import { bus } from './bus.js';
import { store, toolsForPolicy } from './store.js';
import { dmOpeningPrompt, shouldMirrorProgress, mirrorProgress } from './dm.js';
import { loadExtraProviders, settingsDefaultModel } from './providers.js';
import { modelGroups } from './model-groups.js';
import { assistantFailure, fallbackModels, modelFailure, recoverModelReply } from './model-reply.js';
import { invalidateSessions, retireStaleSession, reserveSession } from './session-refresh.js';
import { deliverDirectInput } from './direct-message-delivery.js';
import { MergeQueue, MERGE_QUIET_MS } from './merge-messages.js';

/**
 * 多久之内又来一条，算"连发"（于是开始攒）。
 *
 * 比静默窗口略长：用户打完一条、想了两秒、再打一条，
 * 那是两件事，不该合并；差几百毫秒紧挨着发的，才是一段话被拆开。
 */
const MERGE_BURST_MS = MERGE_QUIET_MS + 900;
import { ModelHealth } from './model-health.js';
import { buildChiefTools, buildCommonTools } from './tools.js';
import { defaultMenuSlug, logMenu, menuSlugs, resolveMenu } from './model-menu.js';
import { attachmentBlock } from './extract.js';
import { inboxPath, metaFor, readForModel, saveFromPath } from './attachments.js';
import { parseMentions } from './mentions.js';
import { log, pickEscalationHost, isSuperiorCall } from './util.js';
import { planItem, shouldStopRound, leftBehind, planClosing, isUserInitiatedRound } from './group-round.js';
import {
  applyCompactionBudget,
  readContext,
  withCapacity,
} from './context-budget.js';
import { disposeAll, disposeMatching, evictIdle } from './session-pool.js';
import { createWatchdog, stallCleanup } from './watchdog.js';
import { createEscalator } from './escalation.js';
import { modelLabel, resolveModel, syncModelGroups } from './model-registry.js';
import { buildAppendSystemPrompt } from './system-prompt.js';
import { selectSkillsFor, skillsPromptLines } from './skills.js';
import { selectLessonsFor, lessonsPromptLines } from './lessons.js';
import { availableThinkingLevels } from './model-thinking.js';
import { createLessonReflector } from './lesson-reflect.js';
import { decideRetry, retryHint, failureNote } from './retry-policy.js';
import { createSessionBuilder } from './session-factory.js';
import { createBuildInput } from './prompt-input.js';
import { collectNewImages, snapshotImages } from './image-watch.js';
import { snapshotWorkspace, diffSnapshots, summarizeChanges } from './change-watch.js';
import { collectArtifacts } from './artifact-watch.js';
import {
  composeGroupPrompt,
  departmentOf,
  lastDoneIndexAll,
  lastDoneIndexOf,
  lastMessageId,
  openingSpeakers,
  transcriptFor,
} from './group-prompt.js';

const MAX_STEP_TEXT = 200;

/** 重试前等多久（毫秒）：立刻重发大概率撞上同样的偶发问题 */
const RETRY_DELAY_MS = 3000;

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
    this.directDeliveryEpochs = new Map();
    /** roomId -> 上一条用户消息的时间（判断是不是在连发） */
    this.lastUserSendAt = new Map();

    /**
     * 连发消息的合并队列（只在它空闲时用）。
     *
     * 到期后走的仍然是原来那条投递路径（deliverDirectInput），
     * 只是把几条文本拼成一段 —— 不另起一套投递逻辑，
     * 免得"合并投递"和"普通投递"出现两套行为差异。
     */
    this.mergeQueue = new MergeQueue({
      flush: (roomId, merged) => this.#deliverMerged(roomId, merged),
      log: (msg) => log(msg),
    });
  }

  /**
   * 合并后的投递（由 MergeQueue 在静默窗口到期时调用）。
   *
   * 复用原有路径：拿会话 → deliverDirectInput。
   * 这里**不重新 appendMessage** —— 用户那几条消息早就各自入库了，
   * 再写一条"合并后的"会让聊天记录出现重复。
   */
  async #deliverMerged(roomId, merged) {
    const room = store.getRoom(roomId);
    if (!room) return;
    const botId = room.leadBotId ?? room.botIds?.[0];
    if (!botId) return;
    const deliveryEpoch = this.directDeliveryEpochs.get(roomId) ?? 0;
    try {
      await deliverDirectInput({
        prepare: () => this.#buildInput(merged, []),
        run: ({ promptText }) =>
          this.run(roomId, botId, promptText, { skipUserMessage: true, attachments: [] }),
        getEntry: () => this.sessions.get(this.#key(roomId, botId)),
        isCancelled: () =>
          this.aborting.has(roomId) ||
          (this.directDeliveryEpochs.get(roomId) ?? 0) !== deliveryEpoch,
        queue: (session, { promptText }) => session.followUp(promptText),
        accepted: () => {},
      });
    } catch (err) {
      if (err?.name === 'AbortError') return; // 正常终止，不报错
      log(`合并消息投递失败：${err?.message ?? err}`);
    }
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
    // ★ 用户说话 = 最高优先级，**先让所有人停下**。
    //
    //   以前这里是“房间忙就排队等下一轮”：用户在群里补一句
    //   「没完成的再完成一次」，结果成员还在跑上一轮的活，
    //   界面显示“它下一步会看到” —— 用户看到的是“我说了但没反应”。
    //
    //   现在的语义：用户一开口，这一轮就作废。
    //     · 正在跑的 bot 全部打断（不保留它们的中间输出）
    //     · 旧轮次的队列清空
    //     · 新的一轮由负责人带新 query 重新想、重新派
    //
    //   为什么可以这么硬：用户是唯一决策者。让它等几十秒甚至几分钟，
    //   等来的还是基于旧需求的结果，比直接重来更糟。
    //
    //   ★ 注意：**房间锁不能被摘掉**。
    //     锁的作用是“同一个房间不能并发跑两轮”，它跟“谁在跑”是两件事：
    //     打断只是让旧轮的 bot 停下，旧轮本身还在走它的循环（要看到 abort
    //     才会退出）。这里保留锁，新的那一轮自然排在旧轮退出之后 ——
    //     否则两个 runRound 会同时在同一个房间里派活，消息会乱。
    if (this.roundLocks.has(roomId) || this.isRoomBusy(roomId)) {
      log(
        `【${store.getRoom(roomId)?.name ?? roomId}】用户插话 → 打断进行中的一轮，按新要求重来`,
      );
      this.#interruptRoundForUser(roomId);
      // 旧轮攒着还没派的内容属于旧需求，丢掉
      this.roundQueue.delete(roomId);
      this.mergeQueue.drop(roomId);
      // 把这条新消息登记成“下一轮”，等旧轮退出后 #drainGroupRounds 会接上
      this.roundQueue.set(roomId, { text, files: [...files] });
      return Promise.resolve();
    }
    this.roundLocks.add(roomId);
    return this.#drainGroupRounds(roomId, { text, files });
  }

  /**
   * 用户插话：把这一轮里**正在跑的所有 bot** 立刻停下来。
   *
   * 只 abort 会话、不碰消息状态：被中断的那几条消息会由 run() 自己的
   * 失败分支处理（写成 aborted，前端不渲染）—— 跟用户按 Esc 终止是同一套语义。
   * 区别只在于：这里不停房间锁，紧接着就要开新一轮。
   */
  #interruptRoundForUser(roomId) {
    let n = 0;
    for (const [key, entry] of this.sessions) {
      if (!key.startsWith(`${roomId}:`)) continue;
      if (!entry?.session || !entry.busy) continue;
      try {
        entry.turnController?.abort();
        entry.session.abort?.().catch(() => {});
        n++;
      } catch {
        // 单个会话打断失败不能挡住其他人停下
      }
    }
    if (n) log(`已打断 ${n} 个正在跑的会话（用户插话）`);
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
   * 心跳看门狗：还在跑的会话报心跳，卡死的判中断并收尾。
   *
   * 判断逻辑在 watchdog.js（那边能直接调 tick 单测，不用等定时器）；
   * 这里只负责把它接到 runner 上：会话表 + 事件总线 + 收尾动作。
   */
  startWatchdog() {
    this.watchdog ??= createWatchdog({
      sessions: this.sessions,
      heartbeatMs: config.heartbeatMs,
      stallMs: config.stallMs,
      emit: (ev) => bus.emit('event', ev),
      onStall: (info) => {
        const cleaned = this.#stallCleanup(info);
        if (!cleaned) return;
        this.escalate({
          roomId: cleaned.roomId,
          fromBotId: cleaned.botId,
          reason: `心跳断了：已经 ${cleaned.secs} 秒没动静，这一轮中断了`,
          prefer: 'lead',
        }).catch((err) => log('上报中断失败：', err?.message || err));
      },
    });
    this.watchdog.start();
  }

  /** 收尾：捣掉这一轮 + 把它正在写的消息结掉（不收的话客户端永远转圈） */
  #stallCleanup(info) {
    info.entry?.turnController?.abort();
    return stallCleanup({ store })(info);
  }

  /**
   * 有活卡住 / 没派出去 → 让“该知道的人”知晓，并请它重新安排。
   *
   * prefer='lead'：群里的活先找**组长**（用户说的“组长 / 部长级别”）；
   *               没有组长（私聊）就找主控。
   * prefer='chief'：直接找主控（派活失败时用）。
   */
  /**
   * 出事了往上抬。实现在 escalation.js —— 那边能单测"该抬给谁"和"回执里写什么"，
   * 这里只把 store 和 run 接上去。
   */
  escalate(args) {
    this.__escalator ??= createEscalator({
      store,
      run: (roomId, botId, text, opts) => this.run(roomId, botId, text, opts),
      onError: (what, err) => log(`${what}：`, err?.message || err),
    });
    return this.__escalator(args);
  }

  async init() {
    this.modelRuntime = await ModelRuntime.create();
    // 收尾复盘器：每次新建一个"无工具"的一次性会话，不污染 bot 的聊天记录
    this.reflect = createLessonReflector({ runner: this });
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
    return resolveModel(this.modelRuntime, slug);
  }

  modelLabel() {
    return modelLabel(this.model);
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
        // ★ pi 级模型（models.json 里配的）也要带上真实档位：
        //   pi 的 max/xhigh 只有在 thinkingLevelMap 里显式出现才算支持，
        //   不告诉前台的话，用户选 max 会被静默 clamp 成 high。
        thinkingLevels: availableThinkingLevels({
          reasoning: Boolean(m.reasoning),
          thinkingLevelMap: m.thinkingLevelMap,
        }),
      }));
    } catch (err) {
      log('取可用模型列表失败：', modelFailure(err).error);
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
    this.registeredGroups = syncModelGroups(
      this.modelRuntime,
      this.registeredGroups,
      modelGroups.toProviderConfigs(),
      {
        onLog: log,
        onError: (_id, err) => log('模型组同步失败：', modelFailure(err).error),
      },
    );
  }

  /** 改完模型组：重新注册 + 刷新列表，然后广播一声让 App 更新 */
  async applyModelGroupChange(groupId = null) {
    this.syncModelGroups();
    await this.refreshAvailableModels();
    this.model = this.resolveModel(this.modelLabel()) ?? this.resolveModel(config.model)
      ?? this.resolveModel(defaultMenuSlug(this.health)) ?? null;
    this.routerModel = this.model;
    this.initNote = this.model ? null : '没有可用模型，请先配置模型组';
    invalidateSessions(this.sessions, (_key, entry) => !groupId || !entry.bot?.model
      || entry.session?.model?.provider === groupId || entry.bot.model.startsWith(`${groupId}/`));
    bus.emit('event', { t: 'models.changed' });
    return this.availableModels?.length ?? 0;
  }

  /**
   * 模型组里的 MCP 服务变了。
   *
   * MCP 无法"热替换" —— 它是在建会话时注册进 pi 的（工具的 schema 那时就定了）。
   * 所以要全部作废重建：只作废那些真的挂了 MCP 的 bot，没挂的不动，
   * 否则改一个服务会把一堆无关的会话都重启，正在跑的活就断了。
   */
  async applyMcpChange() {
    invalidateSessions(this.sessions, (_key, entry) => {
      const names = Array.isArray(entry.bot?.mcpServers) ? entry.bot.mcpServers : [];
      return names.length > 0;
    });
    bus.emit('event', { t: 'mcp.changed' });
  }

  // ---------------------------------------------------------------- 会话

  #key(roomId, botId) {
    return `${roomId}:${botId}`;
  }

  /**
   * 拿到（或建出）这个 (房间, bot) 的会话。
   *
   * 这里只管**池子**：有就复用、正在建就等、建完驱逐超额的。
   * 怎么造（模型/工具/提示/预算）在 session-factory.js。
   */
  async #ensureSession(roomId, botId) {
    const key = this.#key(roomId, botId);
    retireStaleSession(this.sessions, key);
    const existing = this.sessions.get(key);
    if (existing?.session) return reserveSession(existing);
    if (existing?.pending) {
      await existing.pending;
      return this.#ensureSession(roomId, botId);
    }

    this.__buildSession ??= createSessionBuilder({
      runner: this,
      health: this.health,
      resolveModel: (slug) => this.resolveModel(slug),
      modelLabel: () => this.modelLabel(),
    });
    const promise = this.__buildSession(roomId, botId).then((r) => ({
      ...r,
      busy: false,
      unsubscribe: null,
      pending: null,
    }));

    this.sessions.set(key, { session: null, busy: false, pending: promise, unsubscribe: null });
    try {
      const entry = await promise;
      entry.reloadPending = this.sessions.get(key)?.reloadPending ?? false;
      entry.lastUsed = Date.now();
      this.sessions.set(key, entry);
      if (retireStaleSession(this.sessions, key)) return this.#ensureSession(roomId, botId);
      reserveSession(entry);
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
    const released = evictIdle(this.sessions, config.maxSessions);
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
  /**
   * 拼输入（薄包装）：依赖在这里绑一次，逻辑在 prompt-input.js。
   * 绑在这儿是因为 attachments.js 那几个助手本来就是按本进程的配置工作的。
   */
  #buildInput(clean, files) {
    this.__buildInput ??= createBuildInput({
      workspace: config.workspace,
      metaFor,
      inboxPath,
      attachmentBlock,
    });
    return this.__buildInput(clean, files);
  }

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
  /**
   * 私聊开场：空会话时自我介绍 + 用询问卡片问用户要做什么。
   *
   * 触发点在"打开私聊"的接口里；这里再做一遍检查（幂等），
   * 因为用户可能连着点两下，或者上次开场跑到一半被中断。
   */
  async greetDm(roomId, botId) {
    const room = store.getRoom(roomId);
    if (!room || room.kind !== 'dm') return { ok: false, skipped: 'not-dm' };
    if (room.greetedAt) return { ok: false, skipped: 'already-greeted' };
    if (store.listMessages(roomId, { limit: 1 }).length) {
      return { ok: false, skipped: 'not-empty' };
    }
    const bot = store.getBot(botId);
    if (!bot) return { ok: false, skipped: 'no-bot' };
    if (this.isBusy(roomId, botId)) return { ok: false, skipped: 'busy' };

    store.markRoomGreeted(roomId);
    return this.run(roomId, botId, dmOpeningPrompt(bot), {
      skipUserMessage: true,
      meta: { opening: true },
    });
  }

  /**
   * 往 bot 与用户的私聊里回一条进度（写库的实现在 dm.js，便于单测）。
   */
  #mirrorProgress({ room, bot, phase, text, ok = true }) {
    try {
      mirrorProgress({ store, room, bot, phase, text, ok });
    } catch (err) {
      log('私聊进度回执失败：', err?.message || err);
    }
  }

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

    // 本轮开始的房间位置 + 参与者集合：收尾轮判定要拿它们做基准
    const roundStartIndex = lastDoneIndexAll(roomId);
    const participants = [leadId, ...members.map((m) => m.id)].filter(Boolean);

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
        // ★ 只有"用户直接叫的"才享受打断特权。
        //
        //   为什么不能整轮都算：一轮里成员之间会互相 @，那些是日常协作。
        //   若整轮都按"用户新需求"处理，同事一句 @ 就能打断别人手上的活 ——
        //   群里会互相擂断（这正是 room-lock 那条测试守着的边界）。
        //
        //   判断依据看 item.fromId：为空说明这一条是用户直接点的名；
        //   有值说明是某个 bot 在 @ 它，按上下级规则走。
        userRound: !item.fromId && isUserInitiatedRound({ openerBotId }),
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
          const userRound = isUserInitiatedRound({ openerBotId });
          const from = item.fromName || '上级';
          // ★ 用户发起的新需求 vs 上级中途改主意，措辞不一样。
          //
          //   用户那一路要更硬：**旧活直接作废**，不要它"先报进度再继续"——
          //   用户要的是"停，按新的来"，不是"你先把旧的收个尾"。
          //   留着旧的收尾，用户会看到一堆跟新需求无关的产出。
          const steered = userRound
            ? `【用户叫停】用户刚发了新要求，**你手上那件立刻停下、不要再继续**。\n\n` +
              `用户说：\n${(item.fromText || '').slice(0, 1200) || '（看群里的最新消息）'}\n\n` +
              '旧任务的产出作废，不要再补完、也不要再汇报旧进度。\n' +
              '直接按用户的新要求重新开始；如果这活不该你干，说一句就停，等负责人重新安排。'
            : `【${from} 叫停】先把你手上正在做的事停一下。\n\n` +
              `${from} 刚刚说：\n` +
              `${(item.fromText || '').slice(0, 1200) || '（看群里的最新消息）'}\n\n` +
              '请先回报一句：你现在做到哪一步了、还差什么。\n' +
              '然后按上面的新要求继续 —— 新要求优先于你手上正在做的事。';
          try {
            await entry.session.steer(steered);
            log(
              userRound
                ? `【${room.name}】用户新需求 → 叫停 ${bot.name}（旧活作废，按新的重来）`
                : `【${room.name}】上级改主意了 → 叫停 ${bot.name}（它正忙，让它先报进度再接新要求）`,
            );
            store.appendMessage(
              {
                roomId,
                authorType: 'system',
                authorId: bot.id,
                authorName: '叫停回执',
                text: userRound
                  ? `已让${bot.name}停下，按你的新要求重来。`
                  : `已叫停${bot.name}：让它先报进度，再按新的要求继续。`,
                status: 'done',
                meta: {
                  via: userRound ? 'steer_by_user' : 'steer_by_superior',
                  fromId: item.fromId ?? null,
                },
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
            const mirror = shouldMirrorProgress({
              roomKind: room.kind,
              fromId: item.fromId,
              botId: bot.id,
            });
            if (mirror) {
              this.#mirrorProgress({
                room,
                bot,
                phase: 'start',
                text: item.fromText || item.reason,
              });
            }
            // 部门里"别人派给它"的活 → 任务板上登记一条（跑完再收尾）
            const taskId = item.fromId
              ? store.upsertDispatchTask({
                  roomId,
                  ownerBotId: bot.id,
                  title: item.fromText || item.reason,
                  sourceMessageId: lastMessageId(roomId),
                })
              : null;
            // ★ 失败要重试，而不是只打一行日志就消失。
            //
            //   用户观察到的问题：负责人发现成员卡住/失败时，不让人重干，
            //   而是自己上手 —— 因为**它根本不知道谁失败了**（原来只 log）。
            //   结果用户以为全员交付完成，实际有人掉链子被悄悄兜底。
            //
            //   这里改成：失败 → 群里留痕 → 有限次重试 → 用完上报给负责人。
            let res = await this.run(roomId, bot.id, prompt, {
              groupTurn: true,
              attachments,
            });
            let attempt = 1;
            let lastError = res.ok ? '' : String(res.error ?? '未知原因');
            const retries = [];

            while (!res.ok) {
              const decision = decideRetry({
                error: lastError,
                attempt,
                aborting: this.aborting.has(roomId),
              });
              if (!decision.retry) {
                log(`【${room.name}】${bot.name} 不再重试：${decision.why}`);
                break;
              }
              attempt++;
              retries.push(`${attempt}. ${decision.why}`);
              // 群里留痕：用户和负责人都能看到"它这次没成，正在重试"
              store.appendMessage(
                {
                  roomId,
                  authorType: 'system',
                  authorId: bot.id,
                  authorName: '重试回执',
                  text: failureNote({
                    botName: bot.name,
                    reason: lastError,
                    attempt: attempt - 1,
                    willRetry: true,
                  }),
                  status: 'done',
                  meta: { via: 'retry', attempt: attempt - 1 },
                },
                { beforeStreaming: true },
              );
              log(`【${room.name}】${bot.name} 第 ${attempt} 次尝试（${decision.kind}）`);
              // 隔一会儿再试：立刻重发大概率撞上同样的偶发问题
              await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
              if (this.aborting.has(roomId)) break;
              // 换个说法再发，而不是原样重发（原样输入很可能得到同样结果）
              const hinted = retryHint({ attempt: attempt - 1, error: lastError, kind: decision.kind });
              res = await this.run(roomId, bot.id, hinted + prompt, {
                groupTurn: true,
                attachments,
              });
              if (!res.ok) lastError = String(res.error ?? '未知原因');
            }

            if (taskId) {
              store.finishTask(taskId, {
                ok: res.ok,
                text: res.ok ? res.text : `失败 ${attempt} 次：${lastError}`,
              });
            }
            if (mirror) {
              this.#mirrorProgress({
                room,
                bot,
                phase: 'done',
                text: res.text,
                ok: res.ok,
              });
            }
          store.setCursor(roomId, bot.id, lastMessageId(roomId));

          // 重试用完还是没成 → 群里留痕 + 上报负责人（让它按顺序处理，别自己悄悄接手）
          if (!res.ok) {
            log(
              `【${room.name}】${bot.name} 最终没跑成（试了 ${attempt} 次）：${lastError}`,
            );
            store.appendMessage({
              roomId,
              authorType: 'system',
              authorId: bot.id,
              authorName: '失败回执',
              text: failureNote({
                botName: bot.name,
                reason: lastError,
                attempt,
                willRetry: false,
              }),
              status: 'done',
              meta: { via: 'failed', attempts: attempt },
            });

            // 有负责人就抬给它；它会被明确告知"先重派 → 换人 → 自己上也要说明"
            if (leadId && bot.id !== leadId && !this.aborting.has(roomId)) {
              this.escalate({
                roomId,
                fromBotId: bot.id,
                reason: `试了 ${attempt} 次都没成：${lastError}`,
                task: item.fromText || item.reason,
                attempts: attempt,
                why: retries[retries.length - 1] ?? '',
                prefer: 'lead',
              }).catch((err) => log('上报失败：', err?.message || err));
            }
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

    // 收尾轮：老大说完之后还有人交作业 → 把老大叫回来统一收口。
    //
    // 为什么要有这一轮：同一波成员是并发跑完的，"谁的回复落地得晚"纯看模型速度，
    // 于是老大的结论经常夹在中间，后面还挂着几份作业；预算一用完更是没人收口。
    //
    // 两个要点：
    //   1. 判定用**位置**而不是"取最近 N 条"：窗口型判定在长回合里会漏判/误判；
    //   2. 判定之后先**同步占位**再 await：否则在"最后一个成员清 busy"到
    //      "收尾 run 置 busy"之间的空档里，用户消息会并发起一轮，
    //      把收尾总结挤到用户回复之后 —— 正是这功能要修的那个毛病。
    if (!this.aborting.has(roomId) && leadId) {
      const lead = store.getBot(leadId);
      const closing = lead
        ? planClosing({
            roundStartIndex,
            lastLeadIndex: lastDoneIndexOf(roomId, [leadId]),
            lastMemberIndex: lastDoneIndexOf(roomId, participants),
          })
        : { needed: false, why: '找不到老大' };

      if (lead && closing.needed) {
        const leadKey = this.#key(roomId, lead.id);
        // —— 从这一行到下面的 await 之间不许再插入任何 await ——
        this.dispatching.add(leadKey);
        try {
          log(`【${room.name}】🗣 ${closing.why} → 叫 ${lead.name} 收尾`);
          const prompt = composeGroupPrompt(room, lead, transcriptFor(roomId, leadId), {
            isLead: true,
            reason: '大家交完了，给用户一个最终结论',
            members,
            leadId,
            closing: true,
          });
          const res = await this.run(roomId, lead.id, prompt, { groupTurn: true });
          if (res.ok && res.text.trim()) {
            log(`【${room.name}】✅ 收尾完成（${res.text.trim().length} 字）`);
            // 收尾轮是最后一条：它要是又 @ 了人，这一轮也不会再派了。
            // 留痕，避免用户以为"它说了还有活要干，怎么没人动"。
            const { found } = parseMentions(res.text, members, { selfId: lead.id });
            if (found.length) {
              log(
                `【${room.name}】⚠️ 收尾轮又 @ 了 ${found
                  .map((id) => store.getBot(id)?.name ?? id)
                  .join('、')}，但本轮已收口，这些活留到下次`,
              );
            }
          } else {
            log(`【${room.name}】收尾没跑成：${res.error ?? '空回复'}`);
          }
          store.setCursor(roomId, lead.id, lastMessageId(roomId));
        } catch (err) {
          // 收尾失败不能让 runRound 抛出去（房间锁在 finally 里释放）
          log(`【${room.name}】收尾异常：`, err?.message || err);
        } finally {
          this.dispatching.delete(leadKey);
        }
      }
    }

    // 没被叫到的成员也算「看过这条了」，避免下次一次性倒一堆旧账
    const lastId = lastMessageId(roomId);
    for (const m of members) {
      if (!used.has(m.id)) store.setCursor(roomId, m.id, lastId);
    }

    // 收尾复盘：从这一轮里提炼候选经验（只进库，不进提示词）。
    // 放后台跑 —— 用户不该等复盘；失败只写日志，不影响这一轮已经交付的结果。
    if (roundStartIndex >= 0 && store.lessonsEnabled()) {
      void this.reflect?.({ roomId, sinceIndex: roundStartIndex }).catch((err) =>
        log(`【${room.name}】复盘异常：`, err?.message || err),
      );
    }
  }

  // ---------------------------------------------------------------- 用户发消息

  /**
   * 用户发消息。
   * - DM：直接给那个 bot
   * - 群（部门）：交给部门老大先接，老大用 @ 往下派
   * - 正在跑：不报错，而是插话引导（steer）或排队（followUp）
   */
  async send(roomId, text, { mode = 'steer', attachments = [], flushMerge = true } = {}) {
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
        const { promptText } = await this.#buildInput(clean, files);
        if (this.aborting.has(roomId)) throw Object.assign(new Error('已终止'), { name: 'AbortError' });
        queued = await entry.session[effective](promptText, files.map(readForModel).filter(Boolean));
      } catch (err) {
        throw Object.assign(new Error(`插话失败：${modelFailure(err).error}`), { code: 'STEER_FAILED' });
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

    // ★ 用户回话了 → 那张“问你”卡片就该收起来。
    //   卡片是 bot 停下来等回话的地方；用户点了选项/自己说了一句，
    //   事情已经往下走了，卡片还能再点第二次只会让人怀疑自己点没点上。
    //   把回答也存进去，历史里能看出当时选的是哪个。
    store.answerPendingAsk(roomId, clean);

    if (room.kind === 'group') {
      // ★ 用户说话 = 这一轮作废，全部停下重来。
      //
      //   演进过程（三段历史都在这段注释里，免得以后又被改回去）：
      //   1. 最早：房间忙就排队等下一轮 → 用户看到"它下一步会看到"，
      //      但成员还在跑旧需求，用户的话等于没生效。
      //   2. 后来：让组长另开一个会话当场回一句，其他人继续跑 →
      //      用户看到有人回了，但群里的活还是按旧需求在干，产出对不上。
      //   3. 现在：**打断所有正在跑的会话，丢掉旧队列，由负责人带新 query
      //      重新想、重新派**。用户是唯一决策者，让他等旧活干完没有意义 ——
      //      等来的结果基于已经被推翻的需求。
      //
      //   打断动作在 #dispatchGroupRound 里做（那里能同时清掉 roundQueue），
      //   这里只负责把新的一轮发起来。
      this.#dispatchGroupRound(roomId, clean, files).catch((err) =>
        log('runRound 异常：', err?.stack || err),
      );
    } else {
      // ★ 私聊且**它当前空闲** → 先攒一下，把"连发的几条"合成一段再投递。
      //
      //   为什么不干脆每条都立刻投：用户说话像打字，「帮我看下这个系统」
      //   「https://xxx.com」「账号 admin 密码 123」是三条消息，
      //   逐条投递时 agent 第一条只看到半句就开始瞎猜，后面只能靠 steer 纠偏，
      //   三份互相打架的理解叠在一起。合并成一段它一次就能看懂完整意图。
      //
      //   正在跑的时候**不能合并**：那是"中断/插队"，必须立刻送进去让它改计划，
      //   等 700ms 反而让它多跑错一段。
      const idle = !this.isBusy(roomId, botId);

      // ★ 合并只在"真的在连发"时才启动，绝不给正常发送加延迟。
      //
      //   两条路径：
      //     · flushMerge=true（默认，= 用户明确按了发送键）
      //       → **立刻投递**。如果之前因为连发攒了几条，一起带上去，
      //         体感是"咔一下全部生效"。
      //     · flushMerge=false（前端判定"用户还在打字"，见 app_state 的
      //       flushMerge 参数）
      //       → 攒 700ms 静默窗口，把"想到一句发一句"合成一段再给模型。
      //
      //   为什么必须区分：逐条投递时 agent 第一条只看到半句话就开始瞎猜，
      //   后面只能靠 steer 纠偏，三份打架的理解叠在一起。
      //   但反过来，正常发一句也要等 700ms 就是卡顿 —— 两个都不能接受。
      //
      //   正在跑的时候**绝不合并**：那是中断/插队，必须立刻送进去。
      if (idle && !files.length && !flushMerge) {
        this.mergeQueue.push(roomId, clean);
        return { userMessage, bot, group: false, merging: true };
      }
      if (flushMerge && this.mergeQueue.hasPending(roomId)) {
        // 有攒着的：把这条也放进去，然后立刻全部发出
        this.mergeQueue.push(roomId, clean);
        await this.mergeQueue.flushAll();
        return { userMessage, bot, group: false, merging: false };
      }

      const effective = mode === 'followUp' ? 'followUp' : 'steer';
      const deliveryEpoch = this.directDeliveryEpochs.get(roomId) ?? 0;
      deliverDirectInput({
        prepare: () => this.#buildInput(clean, files),
        run: ({ promptText }) => this.run(roomId, botId, promptText, { skipUserMessage: true, attachments: files }),
        getEntry: () => this.sessions.get(this.#key(roomId, botId)),
        isCancelled: () => this.aborting.has(roomId)
          || (this.directDeliveryEpochs.get(roomId) ?? 0) !== deliveryEpoch,
        queue: (session, { promptText }) => session[effective](promptText, files.map(readForModel).filter(Boolean)),
        accepted: (queued) => {
          store.updateMessage(roomId, userMessage.id,
            { meta: { ...(userMessage.meta ?? {}), queued: effective, queuedState: queued ?? 'queued' } });
          bus.emit('event', { t: 'steer.accepted', roomId, mode: effective, text: clean, messageId: userMessage.id });
        },
      }).catch((err) => {
        const error = modelFailure(err).error;
        const msg = store.updateMessage(roomId, userMessage.id, { status: 'error', error });
        bus.emit('event', { t: 'msg.error', roomId, msgId: userMessage.id, error, msg });
      });
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
    if (this.aborting.has(roomId)) return { ok: false, text: '', ms: 0, error: '已终止', messageId: '' };

    let entry;
    try {
      entry = await this.#ensureSession(roomId, botId);
    } catch (err) {
      if (err?.code === 'SESSION_BUSY') {
        return { ok: false, code: 'SESSION_BUSY', text: '', ms: 0, error: '会话正在忙', messageId: '' };
      }
      const message = modelFailure(err).error;
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

    const turnController = new AbortController();
    entry.turnController = turnController;
    const cancelled = () => this.aborting.has(roomId) || turnController.signal.aborted;
    const checkCancelled = () => {
      if (cancelled()) throw turnController.signal.reason ?? Object.assign(new Error('已终止'), { name: 'AbortError' });
    };
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
    let responseFailure = null;
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
            error: event.errorMessage ? modelFailure(event.errorMessage).error : null,
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
            const failure = assistantFailure(event.message);
            if (failure) {
              responseFailure = failure;
              buffer = '';
              pushDelta.flush();
              break;
            }
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

    // 用户带的图 -> 喂给模型（视觉模型能直接看）
    const images = [];
    for (const id of attachments) {
      const img = readForModel(id);
      if (img) images.push(img);
    }
    // bot 自己画图：记下开跑前的快照，跑完把新出现的图自动带上
    const beforeImages = config.autoAttachImages ? snapshotImages(config.workspace) : null;
    // 这一轮改了哪些文件：跑之前拍一张，跑完比一次
    const watchChanges = process.env.PI_BOT_WATCH_CHANGES !== '0';
    const beforeFiles = watchChanges ? snapshotWorkspace(config.workspace) : null;
    const changes = () => {
      if (!beforeFiles) return null;
      try {
        const diff = diffSnapshots(beforeFiles, snapshotWorkspace(config.workspace));
        return diff.total ? summarizeChanges(diff) : null;
      } catch {
        return null;
      }
    };

    let timeoutHandle = null;
    try {
      checkCancelled();
      // ★ 兜底：万一还是撞上"这个会话正在处理"（并发下理论上不该有了，
      //   但外部/扩展也能直接调 prompt），**别把红字甩给用户** ——
      //   改成排队投递（followUp），它干完手上的自己会看到。
      // ★ 技能库按任务挑：库可以很大，但每个 bot 这轮只拿相关的几条。
      //   不放进 appendSystemPrompt —— 那是建会话时固化的，而"相关不相关"
      //   取决于这一轮具体要干什么。
      const withSkills = (text) => {
        try {
          const library = store.skillLibrary();
          if (!library.length) return text;
          // 用「本轮 prompt + 用户原话」一起匹配：prompt 含大量模板文字，
          // 纯靠它会稀释信号，所以两段都喂进去。
          const task = text + "\n" + String(meta?.text ?? "");
          const picked = selectSkillsFor(library, task, { max: 5 });
          const lines = skillsPromptLines(picked);
          return lines.length ? lines.join("\n") + "\n\n" + text : text;
        } catch (err) {
          // 技能挑不出来不能影响正常干活
          log("技能库匹配失败：", err?.message || err);
          return text;
        }
      };

      // ★ 经验注入：只给主控，且只给 active、最多 3 条、总共 600 字。
      //   为什么不给成员：派活质量决定后面所有轮次；成员层每轮都注入一份，
      //   既稀释信号又撑大上下文（这是用户最担心的那件事）。
      //   为什么放在这里（每轮挑）而不是 appendSystemPrompt：会话是复用的，
      //   经验会变（启用/归档/被推翻），固化进去就再也刷不掉了。
      const withLessons = (text) => {
        try {
          if (bot?.role !== 'main') return text;
          const library = store.lessonLibrary();
          if (!library.length) return text;
          const task = text + "\n" + String(meta?.text ?? "");
          const picked = selectLessonsFor(library, task, { roomId });
          const lines = lessonsPromptLines(picked);
          if (!lines.length) return text;
          try {
            store.touchLessons(picked.map((l) => l.id));
          } catch {
            // 记命中失败不能影响这一轮
          }
          return lines.join("\n") + "\n\n" + text;
        } catch (err) {
          // 经验挑不出来不能影响正常干活
          log("经验库匹配失败：", err?.message || err);
          return text;
        }
      };

      const startTurn = async () => {
        try {
          const finalPrompt = withLessons(withSkills(prompt));
          return images.length
            ? await entry.session.prompt(finalPrompt, { images })
            : await entry.session.prompt(finalPrompt);
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
            turnController.abort(new Error('模型请求超时'));
            entry.session.abort().catch(() => {});
            reject(new Error(`超过 ${Math.round(effectiveTimeout / 1000)}s 未完成，已中断`));
          }, effectiveTimeout);
        });
        await Promise.race([runPromise, timeout]);
      } else {
        await runPromise;
      }
      checkCancelled();

      let finalText = render().trim();
      let emptyRecovered = false;
      if (responseFailure) throw new Error(responseFailure.error);
      if (!finalText && !stepCapHit) {
        const stepDigest = steps.length
          ? `\n\n你刚才实际执行了这些操作：\n${steps.map((s) => `- ${s.tool} ${s.detail ?? ''}`.slice(0, 160)).join('\n')}`
          : '';
        const userContent = `下面是你（另一个模型）接到的任务：\n\n${prompt.slice(0, 6000)}${stepDigest}\n\n请用几句话给出结论。`;
        const recovery = await recoverModelReply({
          signal: turnController.signal,
          isCancelled: cancelled,
          failure: responseFailure,
          nudge: () => entry.session.prompt(steps.length
            ? '请用一两句话说明刚才操作的结果，不要调用工具。'
            : '请直接用文字回答刚才的问题，不要调用工具。'),
          readText: () => render(),
          readFailure: () => responseFailure,
          models: fallbackModels(entry.session.model ?? (bot.model ? this.resolveModel(bot.model) : this.model), this.model),
          complete: (model, signal) => this.modelRuntime.completeSimple(
              model,
              {
                systemPrompt: `${bot.persona ?? ''}\n\n你是「${bot.name}」。直接给结论，不要客套。`,
                messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
              },
              { maxTokens: Math.min(2048, model.maxTokens ?? 2048), signal },
            ),
        });
        if (recovery.failure) {
          responseFailure = recovery.failure;
          throw new Error(recovery.failure.error);
        }
        finalText = recovery.text;
        emptyRecovered = recovery.recovered;
      }
      checkCancelled();

      const produced = beforeImages
        ? collectNewImages(config.workspace, beforeImages, {
            save: saveFromPath,
            onError: (err) => log('自动附图失败：', err?.message || err),
          })
        : [];

      // ★ 跑完后把交付物（表格 / 文档 / PDF / 压缩包）也直接发到群里。
      //   只认这一轮新增或改过的文件，源码不算（那是 changed_files 的事）；
      //   图片已经在上面处理过，这里排掉避免重复附件。
      if (config.autoAttachArtifacts !== false && beforeFiles) {
        try {
          for (const item of collectArtifacts(config.workspace, beforeFiles)) {
            try {
              produced.push(saveFromPath(item.file));
            } catch (err) {
              log(`自动带产物失败（${item.rel}）：`, err?.message || err);
            }
          }
        } catch (err) {
          log('自动带产物失败：', err?.message || err);
        }
      }

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
            error: '模型没有返回可展示内容，也未提供明确错误，请检查接口状态与模型配置。',
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

      const changed = changes();
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
          meta: { ...(botMsg.meta ?? {}), ...(changed ? { changed } : {}) },
        },
        { silent: true },
      );
      bus.emit('event', { t: 'msg.done', msg });
      return { ok: true, text: finalText, ms: Date.now() - started, messageId: botMsg.id };
    } catch (err) {
      const failure = cancelled() ? modelFailure(turnController.signal.reason ?? { name: 'AbortError' })
        : responseFailure ?? modelFailure(err);
      const previousError = store.getMessage(roomId, botMsg.id)?.error;
      const message = failure.aborted && previousError === '已按你的要求终止' ? previousError : failure.error;
      const partial = render().trim();
      if (stepCapHit && !cancelled()) {
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
      const changedOnce = changes();
      const msg = store.updateMessage(
        roomId,
        botMsg.id,
        {
          text: partial,
          status: 'error',
          error: message,
          steps,
          usage,
          meta: { ...(botMsg.meta ?? {}), ...(changedOnce ? { changed: changedOnce } : {}) },
        },
        { silent: true },
      );
      bus.emit('event', { t: 'msg.error', roomId, msgId: botMsg.id, error: message, msg });
      log(`模型本轮出错：${message}`);
      return { ok: false, text: partial, ms: Date.now() - started, error: message, messageId: botMsg.id };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      unsubscribe?.();
      entry.unsubscribe = null;
      entry.busy = false;
      entry.turnController = null;
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

  /**
   * 用户批准之后，让那个 bot 继续。
   *
   * 不做"恢复上一次的调用栈"（SDK 没这能力）；而是把批准的事实告诉它，
   * 让它把同一件事再做一次 —— 同一次调用的指纹已经放行，这次能过去。
   */
  async resumeAfterApproval(approval) {
    const bot = store.getBot(approval.botId);
    if (!bot) return { ok: false, error: 'bot 不存在' };
    const prompt =
      `用户已经批准了这次操作：${approval.tool} ${approval.summary}
` +
      '请继续把刚才没做完的事做完（同样的事情直接执行，不用再问）。';
    store.appendMessage({
      roomId: approval.roomId,
      authorType: 'system',
      authorName: '审批',
      text: `已批准：${approval.summary}`,
      status: 'done',
      meta: { approvalId: approval.id, decision: 'approved' },
    });
    return this.run(approval.roomId, approval.botId, prompt, {
      skipUserMessage: true,
      meta: { approvalResume: approval.id },
    });
  }

  /**
   * 跑一条定时任务：在它的会话里像"到点了"那样触发一轮。
   * 群里交给组长接（和用户发消息同一条路径），私聊直接跑那个 bot。
   */
  async runAutomation(automation) {
    const room = store.getRoom(automation?.roomId);
    if (!room) return { ok: false, error: '会话不存在' };
    const botId = automation.botId ?? this.targetBotFor(room);
    if (!botId) return { ok: false, error: '这个会话里没有 bot' };

    store.appendMessage({
      roomId: room.id,
      authorType: 'system',
      authorName: '定时任务',
      text: `⏰ ${automation.title}`,
      status: 'done',
      meta: { automation: automation.id },
    });
    log(`⏰ 定时任务「${automation.title}」→ ${room.name}`);

    if (room.kind === 'group') {
      return this.send(room.id, automation.prompt, {});
    }
    return this.run(room.id, botId, automation.prompt, {
      skipUserMessage: true,
      meta: { automation: automation.id },
    });
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
    this.directDeliveryEpochs.set(roomId, (this.directDeliveryEpochs.get(roomId) ?? 0) + 1);
    // 用户按了停止：排队中的轮次一并清掉，不然它会在当前这轮结束后自己接着跑
    this.roundQueue.delete(roomId);
    // ★ 同理，连发合并队列里攥着的也要丢 ——
    //   用户按了停止，接着再冒出一条刚攒好的消息，看起来就像"停不住"。
    this.mergeQueue.drop(roomId);
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
        entry.turnController?.abort();
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
          // ★ 用 'aborted' 而不是 'error'：用户主动按 Esc 不是"出错"。
          //   渲染成红色错误气泡会让人以为程序坏了 —— 而在 pi agent 里
          //   按 Esc 终止就是终止，界面不留痕。
          //   前端据这个 status 直接不画气泡（见 chat_screen 的 isAborted）。
          //
          //   error 文本保留：上层（run 的返回值、日志）还要用它区分原因；
          //   只是前端拿到 status='aborted' 就不再渲染这一条。
          status: 'aborted',
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
    const n = invalidateSessions(this.sessions, (key) => key.endsWith(`:${botId}`));
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
    const removed = disposeMatching(this.sessions, (key) => key.endsWith(`:${botId}`));
    for (const key of removed) {
      const [roomId] = key.split(':');
      store.clearSessionFile(roomId, botId);
    }
    return removed.length;
  }

  /**
   * 部门规矩变了 → 把会话作废重建。
   *
   * 为什么要重建：工具集和系统提示都是**建会话时**定下来的，
   * 不重建的话"改成只读"要等到会话自然过期才生效 —— 用户会以为没生效。
   * （对话历史保留，只是会话本身重新开一个。）
   */
  applyPolicyChange() {
    // 正在跑的这轮不打断，它结束后下次自然重建
    const n = disposeMatching(this.sessions, (_key, entry) => !entry.busy).length;
    if (n) log(`⚙️ 部门规矩变了 → 作废 ${n} 个空闲会话（下次跑会用新规矩重建）`);
    return n;
  }

  /** 重开某个会话里所有 bot 的记忆 */
  resetRoomSessions(roomId) {
    const removed = disposeMatching(this.sessions, (key) => key.startsWith(`${roomId}:`));
    for (const key of removed) {
      store.clearSessionFile(roomId, key.slice(roomId.length + 1));
    }
    return removed.length;
  }

  disposeAll() {
    disposeAll(this.sessions);
  }
}
