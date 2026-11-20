/**
 * pi agent 运行时协调器（外观层）。
 *
 * 会话按 (房间, bot) 维度缓存并持久化：同一个 bot 在不同的群里互不干扰，
 * 重启服务端后接着之前的上下文继续。
 *
 * 模块划分：
 *   - runner/turn-executor.js       单轮会话执行主干（run）
 *   - runner/group-orchestrator.js  部门群轮次编排（runRound / dispatchGroupRound）
 *   - runner/duplex-lane.js         全双工旁路 Talk、连发合并与发信分流（send）
 *   - runner/task-bridge.js         请求信封、受管任务报告 gate、看门狗与失败升级
 *   - runner/memory-compactor.js    主动压缩阈值校准与后台记忆摘要
 *   - runner/runner-utils.js        无状态基础常量与节流/文本助手
 */
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { config as defaultConfig } from './config.js';
import { createBus, bus as defaultBus } from './bus.js';
import { store as defaultStore } from './store.js';
import { dmOpeningPrompt } from './dm.js';
import { loadExtraProviders, settingsDefaultModel } from './providers.js';
import { modelGroups as defaultModelGroups, rotateCursor } from './model-groups.js';
import { ProviderUpdates } from './provider-updates.js';
import { modelFailure } from './model-reply.js';
import { invalidateSessions, retireStaleSession, reserveSession } from './session-refresh.js';
import { MergeQueue } from './merge-messages.js';
import { PRIORITY, RunSlots } from './run-slots.js';
import { ModelHealth } from './model-health.js';
import { defaultMenuSlug, logMenu, menuSlugs, resolveMenu } from './model-menu.js';
import { attachmentBlock } from './extract.js';
import { inboxPath, metaFor, saveFromPath } from './attachments.js';
import { RunStats } from './run-stats.js';
import { log } from './util.js';
import { readContext } from './context-budget.js';
import { disposeAll, disposeMatching, evictIdle } from './session-pool.js';
import { DUPLEX_KIND } from './duplex-router.js';
import { modelLabel, resolveModel, syncModelGroups } from './model-registry.js';
import { modelChangeAffectsSession } from './model-dispatch.js';
import { availableThinkingLevels } from './model-thinking.js';
import { createLessonReflector } from './lesson-reflect.js';
import { chiefTurnKey, createChiefSummaryRunner } from './runner/chief-summary-runner.js';
import {
  createBreaker, isCircuitFailure, recordFailure as breakerFail,
  recordSuccess as breakerOk, settleAfterCooldown, BREAKER_STATE,
} from './circuit-breaker.js';
import { createSessionBuilder } from './session-factory.js';
import { createBuildInput } from './prompt-input.js';
import { departmentOf } from './group-prompt.js';
import { intakeEnabled } from './coordination/intake-tool.js';
import { sessionKey } from './runner/runner-utils.js';
import {
  MEMORY_WINDOW, TARGET_RECENT_TOKENS, TARGET_RECENT_TOKENS_LIGHT, COMPACT_PROMPT,
  planCompaction, maybeAutoSummarize, summarizeMemory, compactIfNeeded,
} from './runner/memory-compactor.js';
import {
  startWatchdog, escalateFailure, beginRequestScope, endRequestScope, currentRequestScope,
  setRequestDecision, requestDecisionOf, queueAdmittedTask, assertRequestEnvelope,
  withRequestEnvelope, enqueueRequest, drainRequestQueue, abortManagedTask,
  activateReportScope, releaseReportScope, candidateDepartmentIds, currentTaskContext,
  notePolicyBlocked, collectReport,
} from './runner/task-bridge.js';
import {
  consumeSideContext, restoreSideContext, abortTalkInRoom, deliverMerged, sendUserMessage,
} from './runner/duplex-lane.js';
import { roundEpoch, dispatchGroupRound, executeGroupRound } from './runner/group-orchestrator.js';
import { executeTurn } from './runner/turn-executor.js';

export class PiRunner {
  static MEMORY_WINDOW = MEMORY_WINDOW;
  static TARGET_RECENT_TOKENS = TARGET_RECENT_TOKENS;
  static TARGET_RECENT_TOKENS_LIGHT = TARGET_RECENT_TOKENS_LIGHT;
  static COMPACT_PROMPT = COMPACT_PROMPT;

  /** @see planCompaction */
  static planCompaction(args) { return planCompaction(args); }

  #onBusEvent = null;

  constructor(opts = {}) {
    this.config = opts.config ?? defaultConfig;
    this.store = opts.store ?? defaultStore;
    this.bus = opts.bus ?? defaultBus ?? createBus();
    this.modelGroups = opts.modelGroups ?? defaultModelGroups;
    this.sessionApi = opts.sessionApi ?? null;
    this.modelRuntimeFactory = opts.modelRuntimeFactory ?? null;
    this.inheritHostProviders = opts.inheritHostProviders
      ?? (opts.modelRuntimeFactory == null && (opts.modelGroups == null || opts.modelGroups === defaultModelGroups));
    /** 接单功能开关：默认跟随环境开关，SDK 轻量运行时可传 taskIntake=false 关闭。 */
    this.taskIntakeEnabled = opts.taskIntake ?? intakeEnabled();
    /** 全双工边干边聊总开关（可通过 config 或实例字段在测试里热切）。 */
    this.fullDuplexEnabled = this.config.fullDuplex !== false;
    this.talkInflight = new Map();
    this.pendingSideContext = new Map();
    /** @type {Map<string, {session:any, bot:any, busy:boolean, unsubscribe?:Function, pending?:Promise<any>}>} */
    this.sessions = new Map();
    this.modelRuntime = null;
    this.model = null;
    this.routerModel = null;
    this.availableModels = [];
    this.initNote = null;
    this.watchdog = null;
    this.roundLocks = new Set();
    this.aborting = new Set();
    this.roundEpochs = new Map();
    this.breakers = new Map();
    this.endpointCursors = new Map();
    this.providerUpdates = new ProviderUpdates({
      sessions: this.sessions,
      providerForBot: (id) => this.providerForBot(id),
      onError: (_id, error) => log('模型通路更新失败：', modelFailure(error).error),
    });
    this.dispatching = new Set();
    this.roundQueue = new Map();
    this.directDeliveryEpochs = new Map();
    this.lastUserSendAt = new Map();
    this.requestScopes = new Map();
    this.requestQueues = new Map();
    this.requestLifecycle = null;
    this.requestDecisions = new Map();
    this.admittedQueue = [];
    this.managedInflight = new Map();
    this.reportScopes = new Map();
    this.shouldReplyAsked = new Map();
    this.memoryJobs = new Map();

    this.runSlots = new RunSlots({ capacity: this.config.maxConcurrentRuns, reserve: this.config.runSlotReserve });
    this.backgroundSlots = new RunSlots({ capacity: this.config.backgroundConcurrency, reserve: 0 });
    this.stats = new RunStats({ file: path.join(this.config.dataDir, 'run-stats.json') });
    this.mergeQueue = new MergeQueue({
      flush: (roomId, merged) => deliverMerged(this, roomId, merged),
      log: (msg) => log(msg),
    });
  }

  // ---------------------------------------------------------------- 看门狗与受管任务桥接

  startWatchdog() { return startWatchdog(this); }
  escalate(args) { return escalateFailure(this, args); }
  beginRequestScope(roomId, botId, scope) { return beginRequestScope(this, roomId, botId, scope); }
  endRequestScope(roomId, botId, requestId = null) { return endRequestScope(this, roomId, botId, requestId); }
  currentRequestScope(roomId, botId) { return currentRequestScope(this, roomId, botId); }
  setRequestDecision(roomId, botId, scope, kind, extra = null) { return setRequestDecision(this, roomId, botId, scope, kind, extra); }
  requestDecisionOf(scope) { return requestDecisionOf(this, scope); }
  queueAdmittedTask(taskRunId) { return queueAdmittedTask(this, taskRunId); }
  setRequestLifecycle(lifecycle) { this.requestLifecycle = lifecycle ?? null; }
  assertRequestEnvelope(request) { return assertRequestEnvelope(request); }
  withRequestEnvelope(request, roomId, botId, fn) { return withRequestEnvelope(this, request, roomId, botId, fn); }
  enqueueRequest(roomId, item) { return enqueueRequest(this, roomId, item); }
  drainRequestQueue(roomId, botId) { return drainRequestQueue(this, roomId, botId); }
  abortManagedTask(taskRunId) { return abortManagedTask(this, taskRunId); }
  activateReportScope(key, collector) { return activateReportScope(this, key, collector); }
  releaseReportScope(key, collector) { return releaseReportScope(this, key, collector); }
  candidateDepartmentIds(roomId, botId) { return candidateDepartmentIds(this, roomId, botId); }
  currentTaskContext(roomId, botId) { return currentTaskContext(this, roomId, botId); }
  notePolicyBlocked(roomId, botId, approval, info = {}) { return notePolicyBlocked(this, roomId, botId, approval, info); }
  collectReport(roomId, botId, input) { return collectReport(this, roomId, botId, input); }

  // ---------------------------------------------------------------- 初始化与模型管理

  async init() {
    this.modelRuntime = this.modelRuntime
      ?? (typeof this.modelRuntimeFactory === 'function'
        ? await this.modelRuntimeFactory({ config: this.config, modelGroups: this.modelGroups })
        : await ModelRuntime.create());
    this.reflect = createLessonReflector({ runner: this, config: this.config, store: this.store });
    // 主控总汇总的执行薄层（状态机在 pure 模块 chief-summary.js）
    this.chiefSummaries = createChiefSummaryRunner({ runner: this, store: this.store, logFn: log });
    this.startWatchdog();
    if (!this.#onBusEvent) {
      this.#onBusEvent = (ev) => {
        if (ev?.t === 'policy.updated') this.applyPolicyChange();
      };
      this.bus.on('event', this.#onBusEvent);
    }

    const agentDir = typeof this.sessionApi?.getAgentDir === 'function' ? this.sessionApi.getAgentDir() : null;
    for (const [providerId, providerConfig] of Object.entries(loadExtraProviders({
      config: this.config,
      modelGroups: this.modelGroups,
      agentDir,
      includeHost: this.inheritHostProviders,
    }))) {
      try {
        this.modelRuntime.registerProvider(providerId, providerConfig);
      } catch (err) {
        log(`⚠️  provider ${providerId} 注册失败：${err?.message || err}`);
      }
    }

    this.registeredGroups = new Set();
    this.syncModelGroups();

    const candidates = [
      this.store.defaultModel(),
      this.config.model,
      settingsDefaultModel({ agentDir, includeHost: this.inheritHostProviders }),
    ].filter(Boolean);
    for (const slug of candidates) {
      const found = this.resolveModel(slug);
      if (found) {
        this.model = found;
        break;
      }
    }

    await this.refreshAvailableModels();

    this.health = new ModelHealth(this);

    if (!this.model) {
      const fallback = defaultMenuSlug(this.health, this.modelGroups.menuEntries());
      if (fallback) this.model = this.resolveModel(fallback) ?? null;
    }

    const routerSlug = resolveMenu('glm-5.3-flash', this.health, this.modelGroups.menuEntries())?.slug
      ?? defaultMenuSlug(this.health, this.modelGroups.menuEntries());
    this.routerModel = routerSlug ? this.resolveModel(routerSlug) : null;

    if (this.model) {
      log(`默认模型：${this.model.provider}/${this.model.id}`);
    } else {
      this.initNote = '没有可用模型，请先配置 pi 的 provider';
      log('⚠️ ', this.initNote);
    }
    logMenu(this.health, this.modelGroups.menuEntries());

    if (this.config.autoProbe) {
      this.health.runAll({ concurrency: 6 }).catch((err) => log('模型探活出错：', err?.message || err));
      this.health
        .runLevelMatrix(menuSlugs(this.modelGroups))
        .catch((err) => log('档位矩阵出错：', err?.message || err));
    } else {
      log('模型探活已关闭（PI_BOT_PROBE=0）：不自动探活');
    }

    return this;
  }

  /** 宽容解析：支持 "provider/id"、裸 id、以及唯一后缀匹配 */
  resolveModel(slug) { return resolveModel(this.modelRuntime, slug); }
  modelLabel() { return modelLabel(this.model); }

  /** 当前所有活着的会话上下文占用 */
  contextUsage() {
    const out = {};
    for (const [key, entry] of this.sessions) {
      if (!entry.session) continue;
      const u = readContext(entry.session);
      if (u) out[key] = u;
    }
    return out;
  }

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
        thinkingLevels: availableThinkingLevels({
          reasoning: Boolean(m.reasoning),
          thinkingLevelMap: m.thinkingLevelMap,
        }),
      }));
    } catch (err) {
      log('取可用模型列表失败：', modelFailure(err).error);
    }
  }

  syncModelGroups() {
    this.registeredGroups = syncModelGroups(
      this.modelRuntime,
      this.registeredGroups,
      this.modelGroups.toProviderConfigs(),
      {
        onLog: log,
        onError: (_id, err) => log('模型组同步失败：', modelFailure(err).error),
      },
    );
  }

  async applyModelGroupChange(groupId = null) {
    const configs = this.modelGroups.toProviderConfigs();
    const ids = groupId ? [groupId] : [...new Set([
      ...(this.registeredGroups ?? []), ...Object.keys(configs),
    ])];
    for (const id of ids) {
      this.providerUpdates.request(id, () => {
        if (configs[id]) {
          this.modelRuntime?.registerProvider(id, configs[id]);
          (this.registeredGroups ??= new Set()).add(id);
        } else {
          this.modelRuntime?.unregisterProvider(id);
          this.registeredGroups?.delete(id);
        }
        this.endpointCursors.delete(id);
        this.breakers.delete(id);
        this.health?.forgetProvider?.(id);
        this.refreshDefaultModel();
      });
    }
    if (groupId && this.health) {
      const n = this.health.forgetProvider(groupId);
      if (n) log(`🔁 模型组 ${groupId} 的凭证变了，清掉 ${n} 条旧探活结论`);
    }
    await this.refreshAvailableModels();
    this.refreshDefaultModel();
    this.initNote = this.model ? null : '没有可用模型，请先配置模型组';
    invalidateSessions(this.sessions, (_key, entry) =>
      modelChangeAffectsSession(entry, groupId, this.store.getBot(entry.bot?.id) ?? entry.bot));
    this.bus.emit('event', { t: 'models.changed' });
    return this.availableModels?.length ?? 0;
  }

  async applyMcpChange() {
    invalidateSessions(this.sessions, (_key, entry) => {
      const names = Array.isArray(entry.bot?.mcpServers) ? entry.bot.mcpServers : [];
      return names.length > 0;
    });
    this.bus.emit('event', { t: 'mcp.changed' });
  }

  providerForBot(botId) {
    const bot = this.store.getBot(botId);
    if (!bot?.model) return this.model?.provider ?? null;
    return this.resolveModel(bot.model)?.provider ?? String(bot.model).split('/')[0];
  }

  refreshDefaultModel() {
    const persistedDefault = this.store.defaultModel();
    this.model = (persistedDefault ? this.resolveModel(persistedDefault) : null)
      ?? this.resolveModel(this.modelLabel()) ?? this.resolveModel(this.config.model)
      ?? this.resolveModel(defaultMenuSlug(this.health, this.modelGroups.menuEntries())) ?? null;
    this.routerModel = this.model;
  }

  async setDefaultModel(slug = '') {
    const clean = String(slug ?? '').trim();
    if (!clean) {
      this.store.setDefaultModel(null);
      this.refreshDefaultModel();
    } else {
      const found = this.resolveModel(clean);
      if (!found) {
        return { ok: false, error: `找不到可用模型：${clean}` };
      }
      const canonical = `${found.provider}/${found.id}`;
      this.store.setDefaultModel(canonical);
      this.model = found;
      this.routerModel = this.routerModel ?? found;
    }
    invalidateSessions(this.sessions, (_key, entry) =>
      !entry.busy && !(this.store.getBot(entry.bot?.id)?.model));
    return { ok: true, model: this.modelLabel() };
  }

  flushProviderUpdates() {
    const applied = this.providerUpdates.flush();
    if (applied.length) {
      void this.refreshAvailableModels().then(() => {
        this.bus.emit('event', { t: 'models.changed' });
      }).catch((error) => log('模型目录刷新失败：', modelFailure(error).error));
    }
  }

  // ---------------------------------------------------------------- 会话池、并发槽位与熔断

  async ensureSession(roomId, botId) {
    const key = sessionKey(roomId, botId);
    retireStaleSession(this.sessions, key);
    const existing = this.sessions.get(key);
    if (existing?.session) return reserveSession(existing);
    if (existing?.pending) {
      await existing.pending;
      return this.ensureSession(roomId, botId);
    }

    this.__buildSession ??= createSessionBuilder({
      runner: this,
      health: this.health,
      resolveModel: (slug) => this.resolveModel(slug),
      modelLabel: () => this.modelLabel(),
      config: this.config,
      store: this.store,
      bus: this.bus,
      ...(this.sessionApi ? { sessionApi: this.sessionApi } : {}),
    });
    const promise = this.__buildSession(roomId, botId, { reportTool: true }).then((r) => ({
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
      if (retireStaleSession(this.sessions, key)) return this.ensureSession(roomId, botId);
      reserveSession(entry);
      this.#evictSessions();
      return entry;
    } catch (err) {
      this.sessions.delete(key);
      throw err;
    }
  }

  #evictSessions() {
    const released = evictIdle(this.sessions, this.config.maxSessions);
    if (released) log(`会话 LRU 释放 ${released} 个（当前 ${this.sessions.size}）`);
  }

  async acquireRunSlot({ roomId, botId, human, signal, timeoutMs = this.config.runSlotWaitMs }) {
    const slots = this.runSlots;
    if (!slots || slots.unlimited) return null;
    const name = `${this.store.getRoom(roomId)?.name ?? roomId} / ${this.store.getBot(botId)?.name ?? botId}`;
    return slots.acquire({
      priority: human ? PRIORITY.human : PRIORITY.normal,
      name,
      timeoutMs,
      signal,
    });
  }

  recordRun({ roomId, botId, startedAt, ok, usage, taskRunId = '', attemptIndex = 1, sdkRetries = 0, kind = '' }) {
    try {
      const bot = this.store.getBot(botId);
      const model = bot?.model ? String(bot.model) : (this.model?.id ?? '');
      this.stats?.record({
        roomId,
        botId,
        model,
        provider: this.providerForBot(botId) ?? '',
        ms: Date.now() - startedAt,
        usage,
        taskRunId,
        attemptIndex,
        sdkRetries,
        ok,
        kind,
      });
    } catch (error) {
      log('记录运行统计失败：', error?.message || error);
    }
  }

  async withBackgroundSlot(name, operation, { signal = null } = {}) {
    const ticket = await this.acquireBackgroundSlot({ name, signal });
    if (ticket && !ticket.ok) {
      log(`【${name}】跳过：没拿到后台槽位（${ticket.reason}）`);
      return null;
    }
    try {
      return await operation();
    } finally {
      try { ticket?.release?.(); } catch { /* 释放失败不影响结果 */ }
    }
  }

  async acquireBackgroundSlot({ name = '', signal = null, timeoutMs = this.config.backgroundSlotWaitMs } = {}) {
    const slots = this.backgroundSlots;
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    if (!slots || slots.unlimited) return null;
    return slots.acquire({
      priority: PRIORITY.normal,
      name,
      timeoutMs,
      signal,
    });
  }

  breakerFor(botId) {
    const bot = this.store.getBot(botId);
    const slug = String(bot?.model ?? '').trim();
    if (!slug.includes('/')) return null;
    const groupId = slug.slice(0, slug.indexOf('/'));
    if (!groupId) return null;
    let cb = this.breakers.get(groupId);
    if (!cb) {
      cb = createBreaker();
      this.breakers.set(groupId, cb);
    }
    const settled = settleAfterCooldown(cb, Date.now());
    if (settled !== cb) {
      this.breakers.set(groupId, settled);
      cb = settled;
    }
    return { groupId, breaker: cb };
  }

  markGroupHealthy(botId) {
    const found = this.breakerFor(botId);
    if (!found) return;
    if (found.breaker.state !== BREAKER_STATE.closed || (found.breaker.fails ?? 0) > 0) {
      this.breakers.set(found.groupId, breakerOk(found.breaker));
      log(`✅ 模型组 ${found.groupId} 恢复正常`);
      return;
    }
    this.breakers.set(found.groupId, breakerOk(found.breaker));
  }

  markGroupFailed(botId, { kind, status } = {}) {
    const found = this.breakerFor(botId);
    if (!found) return null;
    if (!isCircuitFailure({ kind, status })) return found.breaker;
    const next = breakerFail(found.breaker, { kind, status, now: Date.now() });
    this.breakers.set(found.groupId, next);
    if (next.state === BREAKER_STATE.open) {
      const group = this.modelGroups.get(found.groupId);
      const name = group?.name ?? found.groupId;
      const switched = this.#tryRotateEndpoint(found.groupId);
      if (switched) {
        log(`🔁 模型组「${name}」${next.fails} 次通路失败，已切到备用通路 ${switched.index + 1}`);
        this.breakers.set(found.groupId, createBreaker());
        return { ...next, switchedTo: switched.index };
      }
      log(
        `⛔ 模型组「${name}」连续 ${next.fails} 次通路失败，熔断 ` +
          `${Math.round(next.cooldownMs / 1000)}s（这期间不再往它发请求）`,
      );
      return next;
    }
    return next;
  }

  #tryRotateEndpoint(groupId) {
    if (this.providerUpdates.has(groupId)) return null;
    const group = this.modelGroups.get(groupId);
    const eps = group?.endpoints ?? [];
    if (eps.length < 2) return null;
    const prevIdx = this.endpointCursors.get(groupId) ?? 0;
    const nextIdx = rotateCursor(prevIdx, eps.length);
    if (nextIdx === prevIdx) return null;
    try {
      const cfg = group.toProviderConfig(nextIdx);
      const applied = this.providerUpdates.request(groupId, () => {
        this.modelRuntime.registerProvider(groupId, cfg);
        this.endpointCursors.set(groupId, nextIdx);
        this.breakers.set(groupId, createBreaker());
        this.health?.forgetProvider?.(groupId);
        this.refreshDefaultModel();
      });
      return applied ? { index: nextIdx } : null;
    } catch (err) {
      log(`切换端点失败（${groupId}）：${err?.message ?? err}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- 状态查询与输入组装

  roomHasBot(roomId, botId) {
    const room = this.store.getRoom(roomId);
    if (!room) return false;
    if (Array.isArray(room.botIds)) return room.botIds.includes(botId);
    return Boolean(room.botId && room.botId === botId);
  }

  isBusy(roomId, botId) {
    const key = sessionKey(roomId, botId);
    if (this.dispatching?.has(key)) return true;
    return Boolean(this.sessions.get(key)?.busy);
  }

  isRoomBusy(roomId) {
    for (const [key, entry] of this.sessions) {
      if (!key.startsWith(`${roomId}:`)) continue;
      if (!entry.busy) continue;
      if (entry.compactingOnly) continue;
      return true;
    }
    return false;
  }

  targetBotFor(room) {
    if (room.kind === 'dm') return room.botIds[0] ?? null;
    const { leadId } = departmentOf(room, this.store);
    return leadId ?? room.botIds[0] ?? null;
  }

  buildInput(clean, files, roomId = '') {
    this.__buildInput ??= createBuildInput({
      workspace: this.config.workspace,
      metaFor,
      inboxPath,
      attachmentBlock,
    });
    return this.__buildInput(clean, files, { roomId });
  }

  sendImage({ roomId, botId, filePath, caption }) {
    const bot = this.store.getBot(botId);
    const meta = saveFromPath(filePath);
    const attachment = { id: meta.id, name: meta.name, mime: meta.mime, kind: meta.kind, size: meta.size };
    const msg = this.store.appendMessage({
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

  async greetDm(roomId, botId) {
    const room = this.store.getRoom(roomId);
    if (!room || room.kind !== 'dm') return { ok: false, skipped: 'not-dm' };
    if (room.greetedAt) return { ok: false, skipped: 'already-greeted' };
    if (this.store.listMessages(roomId, { limit: 1 }).length) {
      return { ok: false, skipped: 'not-empty' };
    }
    const bot = this.store.getBot(botId);
    if (!bot) return { ok: false, skipped: 'no-bot' };
    if (this.isBusy(roomId, botId)) return { ok: false, skipped: 'busy' };

    this.store.markRoomGreeted(roomId);
    return this.run(roomId, botId, dmOpeningPrompt(bot), {
      skipUserMessage: true,
      meta: { opening: true },
    });
  }

  // ---------------------------------------------------------------- 核心执行与编排委派

  maybeAutoSummarize(roomId, botId) { return maybeAutoSummarize(this, roomId, botId); }
  summarizeMemory(roomId, botId, opts = {}) { return summarizeMemory(this, roomId, botId, opts); }
  compactIfNeeded(entry, bot, roomId = null, opts = {}) { return compactIfNeeded(this, entry, bot, roomId, opts); }
  consumeSideContext(roomId, botId) { return consumeSideContext(this, roomId, botId); }
  restoreSideContext(roomId, botId, items) { return restoreSideContext(this, roomId, botId, items); }
  dispatchGroupRound(roomId, text, files) { return dispatchGroupRound(this, roomId, text, files); }
  runRound(roomId, opts = {}) { return executeGroupRound(this, roomId, opts); }
  send(roomId, text, opts = {}) { return sendUserMessage(this, roomId, text, opts); }
  run(roomId, botId, prompt, options = {}) { return executeTurn(this, roomId, botId, prompt, options); }

  async runBotOnce({ roomId, botId, prompt, timeoutMs, meta, summaryTurn = false }) {
    if (this.isBusy(roomId, botId)) {
      return { ok: false, text: '', ms: 0, error: `${this.store.getBot(botId)?.name ?? botId} 正在忙` };
    }
    return this.run(roomId, botId, prompt, { timeoutMs, meta, summaryTurn });
  }

  /**
   * 当前这一轮是不是「汇总交卷轮」。
   *
   * 工具层用它做硬防循环：汇总轮里不许再派活 / 建部门 / 接新任务。
   * 为什么不用 opts 层层透传：工具只能拿到 roomId/botId，entry 是唯一共同可及的地方。
   */
  /** 主控本轮聚合键 / 排空排队汇总（实现在 runner/chief-summary-runner.js） */
  currentTurnKey(roomId, botId) {
    return chiefTurnKey(this, roomId, botId);
  }

  drainChiefSummaries() {
    return this.chiefSummaries?.drain?.() ?? Promise.resolve({ sent: 0 });
  }

  isSummaryTurn(roomId, botId) {
    return this.sessions.get(sessionKey(roomId, botId))?.summaryTurn === true;
  }

  async resumeAfterApproval(approval) {
    const bot = this.store.getBot(approval.botId);
    if (!bot) return { ok: false, error: 'bot 不存在' };
    const prompt =
      `用户已经批准了这次操作：${approval.tool} ${approval.summary}\n` +
      '请继续把刚才没做完的事做完（同样的事情直接执行，不用再问）。';
    this.store.appendMessage({
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

  async runAutomation(automation) {
    const room = this.store.getRoom(automation?.roomId);
    if (!room) return { ok: false, error: '会话不存在' };
    const botId = automation.botId ?? this.targetBotFor(room);
    if (!botId) return { ok: false, error: '这个会话里没有 bot' };

    this.store.appendMessage({
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

  async dispatchToGroup({ roomId, text, fromBotId = null, summary = null }) {
    const room = this.store.getRoom(roomId);
    if (!room) return { ok: false, error: '部门不存在' };
    const chief = fromBotId ? this.store.getBot(fromBotId) : this.store.mainBot();
    const msg = this.store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: chief?.id ?? 'chief',
      authorName: chief?.name ?? 'Pi',
      authorEmoji: chief?.emoji ?? 'π',
      text,
      status: 'done',
      meta: { via: 'dispatch' },
    });
    this.runRound(roomId, {
      openerText: text,
      openerBotId: chief?.id ?? null,
      openerMessageId: msg.id,
      openerName: chief?.name ?? '主控',
      // 主控总汇总：把批次与目标键传进群轮，收尾时回填交付包
      summary,
    }).catch((err) => log('dispatchToGroup 异常：', err?.stack || err));
    return { ok: true, messageId: msg.id };
  }

  async abort(roomId, { scope = 'all' } = {}) {
    const cleanScope = scope === 'work' || scope === 'talk' ? scope : 'all';
    if (cleanScope !== 'talk') {
      this.directDeliveryEpochs.set(roomId, (this.directDeliveryEpochs.get(roomId) ?? 0) + 1);
      this.roundQueue.delete(roomId);
      this.mergeQueue.drop(roomId);
      if (cleanScope === 'all') {
        this.aborting.add(roomId);
      } else {
        this.roundEpochs.set(roomId, roundEpoch(this, roomId) + 1);
      }
    }

    let aborted = false;
    const live = [];
    if (cleanScope !== 'talk') {
      for (const [key, entry] of this.sessions) {
        if (key.startsWith(`${roomId}:`) && entry.session && entry.busy) {
          live.push({ key, entry });
          entry.turnController?.abort();
          entry.session.abort().catch(() => {});
          aborted = true;
        }
      }
      const botIds = live.map((x) => x.key.slice(roomId.length + 1));
      for (const msg of this.store.listMessages(roomId, { limit: 200 })) {
        if (msg.status !== 'streaming') continue;
        if (!botIds.includes(msg.authorId)) continue;
        if (cleanScope === 'work' && msg.meta?.duplex === DUPLEX_KIND.sideReply) continue;
        this.store.updateMessage(
          roomId,
          msg.id,
          {
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
        this.bus.emit('event', { t: 'typing', roomId, botId: id, active: false, lane: 'work' });
      }
    }

    if (cleanScope !== 'work') {
      if (abortTalkInRoom(this, roomId)) aborted = true;
    }

    log(`⏹ 收到终止（${cleanScope}）：${roomId}（停了 ${live.length} 个后台会话）`);
    return { aborted };
  }

  // ---------------------------------------------------------------- 会话回收与清理

  reloadSessionForBot(botId) {
    const n = invalidateSessions(this.sessions, (key) => key.endsWith(`:${botId}`));
    if (n) log(`${this.store.getBot(botId)?.name ?? botId} 的会话已按新预算重建（历史保留）`);
    return n;
  }

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
      this.store.clearSessionFile(roomId, botId);
    }
    this.store.clearMemorySummariesForBot(botId);
    return removed.length;
  }

  applyPolicyChange() {
    const n = disposeMatching(this.sessions, (_key, entry) => !entry.busy).length;
    if (n) log(`⚙️ 部门规矩变了 → 作废 ${n} 个空闲会话（下次跑会用新规矩重建）`);
    return n;
  }

  resetRoomSessions(roomId) {
    const removed = disposeMatching(this.sessions, (key) => key.startsWith(`${roomId}:`));
    for (const key of removed) {
      this.store.clearSessionFile(roomId, key.slice(roomId.length + 1));
    }
    this.store.clearMemorySummariesForRoom(roomId);
    return removed.length;
  }

  disposeAll() {
    this.watchdog?.stop?.();
    this.health?.stop?.();
    this.mergeQueue?.clearAll?.();
    if (this.#onBusEvent) {
      this.bus.off('event', this.#onBusEvent);
      this.#onBusEvent = null;
    }
    disposeAll(this.sessions);
  }
}
