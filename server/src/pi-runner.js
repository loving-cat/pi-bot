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
import { modelGroups, rotateCursor } from './model-groups.js';
import { ProviderUpdates, providerLeaseScope } from './provider-updates.js';
import { settleRetryMessage } from './retry-messages.js';
import { assistantFailure, fallbackModels, modelFailure, recoverModelReply } from './model-reply.js';
import { invalidateSessions, retireStaleSession, reserveSession } from './session-refresh.js';
import { deliverDirectInput } from './direct-message-delivery.js';
import { requestIdentityKey } from './tasks/task-request-result.js';
import { MergeQueue, MERGE_QUIET_MS } from './merge-messages.js';
import { buildMemoryDigest, memoryProgress } from './memory-digest.js';
import { shouldAutoSummarize } from './memory-policy.js';
import { PRIORITY, RunSlots } from './run-slots.js';
import { classifyStop, resolveManagedContext, planAttemptEvent, adaptRunOutcome, MANAGED } from './tasks/task-progress.js';
import { createReportCollector } from './tasks/task-report.js';
import { STOP } from './tasks/task-contract.js';

/**
 * 多久之内又来一条，算"连发"（于是开始攒）。
 *
 * 比静默窗口略长：用户打完一条、想了两秒、再打一条，
 * 那是两件事，不该合并；差几百毫秒紧挨着发的，才是一段话被拆开。
 */
const MERGE_BURST_MS = MERGE_QUIET_MS + 900;

/**
 * 主动压缩的失败重试上限与放弃后的冷却时间。
 *
 * 2 次：首次 + 退避后一次。压缩本身很贵（要把几十万 tokens 读一遍），
 * 跟着 retry-policy 的 10 次重试会把用户拖上十几分钟。
 * 冷却 10 分钟：压缩失败通常是上下文真的太满或接口持续不可用，
 * 连着每轮都试只会把每一轮都拖慢。
 */
const COMPACT_MAX_ATTEMPTS = 2;
const COMPACT_COOLDOWN_MS = 10 * 60 * 1000;

import { ModelHealth } from './model-health.js';
import { buildChiefTools, buildCommonTools } from './tools.js';
import { defaultMenuSlug, logMenu, menuSlugs, resolveMenu } from './model-menu.js';
import { attachmentBlock } from './extract.js';
import { inboxPath, metaFor, readForModel, saveFromPath } from './attachments.js';
import { RunStats, RunUsage } from './run-stats.js';
import { parseMentions } from './mentions.js';
import { log, newId, pickEscalationHost, isSuperiorCall } from './util.js';
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
import { modelChangeAffectsSession } from './model-dispatch.js';
import { buildAppendSystemPrompt } from './system-prompt.js';
import {
  selectSkillsFor,
  skillFingerprint,
  skillsPromptLines,
  skillsToInject,
} from './skills.js';
import { selectLessonsFor, lessonsPromptLines } from './lessons.js';
import { availableThinkingLevels } from './model-thinking.js';
import { createLessonReflector } from './lesson-reflect.js';
import {
  decideRetry,
  retryHint,
  failureNote,
  transientBackoffMs,
  isRecoverableFailure,
} from './retry-policy.js';
import {
  canRequest as breakerAllows,
  createBreaker,
  isCircuitFailure,
  recordFailure as breakerFail,
  recordSuccess as breakerOk,
  settleAfterCooldown,
  breakerNote,
  BREAKER_STATE,
} from './circuit-breaker.js';
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

/** 退避等待。压缩重试要用，但没有别的地方需要，就地定义。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    /** 07 接单功能开关：关闭时新 App 的合法 requestId 只走普通聊天，不要求 accept_task。 */
    this.taskIntakeEnabled = process.env.PI_BOT_TASK_INTAKE === '1';
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
     * 没有这层的话，群里用户连发两条消息时 `send()` 只检查「老大忙不忙」，
     * 成员在跑的时候第二条消息会再开一个 runRound —— 两个轮次同时跑，
     * 各有一份 maxRuns 预算（限制失效），游标互相踩。
     */
    this.roundLocks = new Set();
    /** 用户按了终止的房间 —— 轮次循环看到它就停，不再往下派人 */
    this.aborting = new Set();
    /**
     * roomId -> 轮次代数。用户插话时 +1，旧轮每次派发前比对，变了就收手。
     *
     * 为什么不用 aborting：终止是"停下来"，插话是"停旧的、马上按新需求重来"。
     * 用同一个标记会让新一轮也被当成终止。代数只回答"你还是不是当前那一轮"。
     */
    this.roundEpochs = new Map();
    /**
     * 熔断器，按模型组 id 存。
     *
     * 为什么要按**组**而不是按 bot：一个组就是一份 baseUrl + key。
     * 那把 key 挂了，组里所有模型、所有 bot 都一起不可用 ——
     * 让每个 bot 各自撞 N 次是纯粹的浪费（实测 6 个成员 = 66 次请求）。
     */
    this.breakers = new Map();
    /**
     * 每个模型组当前用第几条端点（多 key 轮转用）。
     *
     * 熔断打开时切到下一条；全部挂了才真的停。
     */
    this.endpointCursors = new Map();
    this.providerUpdates = new ProviderUpdates({
      sessions: this.sessions,
      providerForBot: (id) => this.providerForBot(id),
      onError: (_id, error) => log('模型通路更新失败：', modelFailure(error).error),
    });
    /** 已经派出去、但异步的 run() 还没把 busy 设上的会话（key = roomId:botId） */
    this.dispatching = new Set();
    /** roomId -> { text, files }：锁被占时进来的消息，合并到这里等下一轮 */
    this.roundQueue = new Map();
    this.directDeliveryEpochs = new Map();
    /** roomId -> 上一条用户消息的时间（判断是不是在连发） */
    this.lastUserSendAt = new Map();

    /**
     * 全局运行槽位：限制同时开跑的轮数，给人留保底位。
     *
     * 不配就是不限（capacity=0），行为和以前一模一样 ——
     * 默认不改变现有行为，想限制就在设置里填并发上限。
     */
    this.runSlots = new RunSlots({
      capacity: config.maxConcurrentRuns,
      reserve: config.runSlotReserve,
    });

    /** 压缩、记忆摘要和复盘共用的后台并发配额。 */
    this.backgroundSlots = new RunSlots({
      capacity: config.backgroundConcurrency,
      reserve: 0,
    });

    /** 有界本地运行统计，不保存提示词或凭据。 */
    this.stats = new RunStats({ file: path.join(config.dataDir, 'run-stats.json') });

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
        prepare: () => this.#buildInput(merged, [], roomId),
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
      // 用户刚说话，这是回应他的人 → 人的保底槽
      human: true,
    });
  }

  #dispatchGroupRound(roomId, text, files) {
    // ★ 用户说话 = 最高优先级，**先让所有人停下**。
    //
    //   不这样会怎样：如果房间忙就排队等下一轮，成员还在跑上一轮的活时
    //   用户补一句「没完成的再完成一次」，界面只显示“它下一步会看到”，
    //   用户看到的是“我说了但没反应”。
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

  /** 当前房间的轮次代数（没跑过就是 0） */
  #roundEpoch(roomId) {
    return this.roundEpochs.get(roomId) ?? 0;
  }

  /**
   * 用户插话：把这一轮里**正在跑的所有 bot** 立刻停下来。
   *
   * 三件事缺一不可：
   *   ① 代数 +1 —— 旧轮的循环每次派发前比对，立刻收手，剩下的队列不再派；
   *   ② abort 会话 —— 手上那件正在做的活停下来；
   *   ③ **当场**把正在写的消息标成 aborted —— 跟用户按 Esc 同一套语义：
   *      前端整条不渲染。只 abort 会话、不碰消息的话，run() 的失败分支
   *      会把它们写成 status='error'，用户插一次话就留下 N 个红气泡
   *      + N 条"XX 没能完成"的失败回执 —— 这些必须避免。
   *
   * 不停房间锁：旧轮的循环看到代数变了会自己退出，锁在它的 finally 里释放，
   * 紧接着 #drainGroupRounds 就会按新 query 开下一轮。
   */
  #interruptRoundForUser(roomId) {
    this.roundEpochs.set(roomId, this.#roundEpoch(roomId) + 1);

    let n = 0;
    const botIds = [];
    for (const [key, entry] of this.sessions) {
      if (!key.startsWith(`${roomId}:`)) continue;
      if (!entry?.session || !entry.busy) continue;
      botIds.push(key.slice(roomId.length + 1));
      // 压缩可继续，但这轮任务已失效，不能在压缩后执行旧指令。
      if (entry.compactingOnly) {
        entry.turnController?.abort();
        n++;
        continue;
      }
      try {
        entry.turnController?.abort();
        entry.session.abort?.().catch(() => {});
        n++;
      } catch {
        // 单个会话打断失败不能挡住其他人停下
      }
    }

    if (botIds.length) {
      for (const msg of store.listMessages(roomId, { limit: 200 })) {
        if (msg.status !== 'streaming') continue;
        if (!botIds.includes(msg.authorId)) continue;
        store.updateMessage(
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
        bus.emit('event', { t: 'typing', roomId, botId: id, active: false });
      }
    }

    if (n) log(`已打断 ${n} 个正在跑的会话（用户插话，旧轮作废）`);
  }

  /** 把排队的一轮轮跑掉；跑完（或出错）都要释放房间锁 */
  async #drainGroupRounds(roomId, first) {
    let next = first;
    try {
      while (next) {
        try {
          const { promptText } = await this.#buildInput(next.text, next.files, roomId);
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
   * prefer='lead'：群里的活先找**组长**（组长 / 部长级别）；
   *               没有组长（私聊）就找主控。
   * prefer='chief'：直接找主控（派活失败时用）。
   */
  /**
   * 出事了往上抬。实现在 escalation.js —— 那边能单测"该抬给谁"和"回执里写什么"，
   * 这里只把 store 和 run 接上去。
   */
  escalate(args) {
    // 受管任务：失败升级回原任务负责人，不另起无任务执行
    const runtime = this.taskRuntime;
    if (runtime?.onEscalation) {
      // 身份来自这次失败执行自己的受管上下文；没有上下文才走旧逻辑
      const ctx = args?.roomId && args?.fromBotId
        ? this.currentTaskContext(args.roomId, args.fromBotId)
        : null;
      if (ctx) {
        // 非空作用域但字段残缺：属于 invalid，明确拒绝，不借用其他目标也不降级 legacy。
        // 用 Promise.resolve 统一同步/异步返回，避免同步拒绝分支直接 .then 抛 TypeError。
        return Promise.resolve(runtime.onEscalation({
          taskRunId: ctx.taskRunId ?? null,
          revision: ctx.revision ?? null,
          attemptId: ctx.attemptId ?? null,
          botId: ctx.botId ?? args?.fromBotId ?? null,
          reason: args?.reason ?? '',
        })).catch((err) => {
          log('受管升级失败：', err?.message || err);
          return { ok: false, code: 'escalation_failed', text: String(err?.message || err) };
        });
      }
    }
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

    // 后台探活：结果缓存 24h，菜单按它自动切到活着的线路。
    //   首次启动会对每个有凭证的模型真发一次请求（会花钱、也会占满并发）。
    //   PI_BOT_PROBE=0 关掉：菜单照样有，只是不自动探、也不按探活结果切线路，
    //   要探可以让主控手动调 probe_model。
    if (config.autoProbe) {
      this.health.runAll({ concurrency: 6 }).catch((err) => log('模型探活出错：', err?.message || err));

      // 菜单里那些模型的「档位矩阵」：找出会静默返回空的组合（思考等级 × 模型）
      this.health
        .runLevelMatrix(menuSlugs())
        .catch((err) => log('档位矩阵出错：', err?.message || err));
    } else {
      log('模型探活已关闭（PI_BOT_PROBE=0）：不自动探活');
    }

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
    const configs = modelGroups.toProviderConfigs();
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
    // ★ 这一组的健康结论作废。
    //
    //   健康结论是针对**某份凭证**的：用户换了 key / 改了 baseUrl，
    //   旧凭证的 401/429 记录（TTL 24 小时）还挂在那里，
    //   菜单上这个组就一直标 ✗ 实测不可用 —— 主控看到"不可用"绕开它，
    //   用户看到的是"我换了稳定 key 怎么还是老样子"。
    //   凭证变了，结论就该作废，让下一轮重新探。
    if (groupId && this.health) {
      const n = this.health.forgetProvider(groupId);
      if (n) log(`🔁 模型组 ${groupId} 的凭证变了，清掉 ${n} 条旧探活结论`);
    }
    await this.refreshAvailableModels();
    this.model = this.resolveModel(this.modelLabel()) ?? this.resolveModel(config.model)
      ?? this.resolveModel(defaultMenuSlug(this.health)) ?? null;
    this.routerModel = this.model;
    this.initNote = this.model ? null : '没有可用模型，请先配置模型组';
    invalidateSessions(this.sessions, (_key, entry) =>
      modelChangeAffectsSession(entry, groupId, store.getBot(entry.bot?.id) ?? entry.bot));
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

  // ---------------------------------------------------------------- 核心：跑一轮

  providerForBot(botId) {
    const bot = store.getBot(botId);
    if (!bot?.model) return this.model?.provider ?? null;
    return this.resolveModel(bot.model)?.provider ?? String(bot.model).split('/')[0];
  }

  refreshDefaultModel() {
    this.model = this.resolveModel(this.modelLabel()) ?? this.resolveModel(config.model)
      ?? this.resolveModel(defaultMenuSlug(this.health)) ?? null;
    this.routerModel = this.model;
  }

  flushProviderUpdates() {
    const applied = this.providerUpdates.flush();
    if (applied.length) {
      void this.refreshAvailableModels().then(() => {
        bus.emit('event', { t: 'models.changed' });
      }).catch((error) => log('模型目录刷新失败：', modelFailure(error).error));
    }
  }

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
    // ★ 报告工具**固定注册**给所有会话。
    //
    //   按需注册会跟会话缓存打架：先普通聊天（没注册）→ 再受管执行时
    //   会话被直接复用，工具集不会重建，于是受管轮次拿不到 task_report。
    //   改成固定注册 + 执行时严格活跃 scope 判定：
    //   工具一直在，但只有本次真正获得执行占用的调用能提交报告。
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

  /**
   * 申请一个全局运行槽位。
   *
   * 上限来自 `config.maxConcurrentRuns`（0 = 不限，保持旧行为）。
   * 人发起的轮次用保底槽且优先，所以"人在等"永远不会被"机器在忙"挡住。
   *
   * 返回 null 表示本轮**不需要**槽位（不限并发且没开保底位），
   * 调用方不要把它当成失败。
   */
  async #acquireRunSlot({ roomId, botId, human, signal, timeoutMs = config.runSlotWaitMs }) {
    const slots = this.runSlots;
    if (!slots || slots.unlimited) return null;
    const name = `${store.getRoom(roomId)?.name ?? roomId} / ${store.getBot(botId)?.name ?? botId}`;
    const ticket = await slots.acquire({
      priority: human ? PRIORITY.human : PRIORITY.normal,
      name,
      // 0 = 不设超时（一直等）；配了才硬超时
      timeoutMs,
      signal,
    });
    return ticket;
  }

  /** 记录本次执行的消耗与重试次数；统计失败不影响任务结果。 */
  #recordRun({ roomId, botId, startedAt, ok, usage, taskRunId = '', attemptIndex = 1, sdkRetries = 0, kind = '' }) {
    try {
      const bot = store.getBot(botId);
      const model = bot?.model ? String(bot.model) : (this.model?.id ?? '');
      this.stats?.record({
        roomId,
        botId,
        model,
        provider: this.providerForBot(botId) ?? '',
        ms: Date.now() - startedAt,
        usage,
        taskRunId, attemptIndex, sdkRetries,
        ok,
        kind,
      });
    } catch (error) {
      log('记录运行统计失败：', error?.message || error);
    }
  }

  /** 在后台配额内执行操作；排队超时或取消返回 null，操作结束后释放。 */
  async withBackgroundSlot(name, operation, { signal = null } = {}) {
    const ticket = await this.#acquireBackgroundSlot({ name, signal });
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

  async #acquireBackgroundSlot({ name = '', signal = null, timeoutMs = config.backgroundSlotWaitMs } = {}) {
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

  /**
   * 取某个模型组的熔断器（没有就建一个）。
   *
   * 从 bot 的 model slug 里取组 id（`<组id>/<模型id>`）。
   * 取不到就返回 null —— 调用方按"没有熔断"处理，绝不让它挡住正常流程。
   */
  breakerFor(botId) {
    const bot = store.getBot(botId);
    const slug = String(bot?.model ?? '').trim();
    if (!slug.includes('/')) return null;
    const groupId = slug.slice(0, slug.indexOf('/'));
    if (!groupId) return null;
    let cb = this.breakers.get(groupId);
    if (!cb) {
      cb = createBreaker();
      this.breakers.set(groupId, cb);
    }
    // 冷却结束自动转 halfOpen（纯函数，状态推进）
    const settled = settleAfterCooldown(cb, Date.now());
    if (settled !== cb) {
      this.breakers.set(groupId, settled);
      cb = settled;
    }
    return { groupId, breaker: cb };
  }

  /** 把一个模型组标记为"刚成功过" —— 恢复后立刻回到正常。 */
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

  /** 记一次通路失败（只有真·通路故障才计入）。 */
  markGroupFailed(botId, { kind, status } = {}) {
    const found = this.breakerFor(botId);
    if (!found) return null;
    if (!isCircuitFailure({ kind, status })) return found.breaker;
    const next = breakerFail(found.breaker, { kind, status, now: Date.now() });
    this.breakers.set(found.groupId, next);
    if (next.state === BREAKER_STATE.open) {
      const group = modelGroups.get(found.groupId);
      const name = group?.name ?? found.groupId;
      // ★ 熔断的那条路可能只是其中一条端点 —— 有备用就立刻切过去。
      //
      //   这是「用户无感」的关键一步：key 不稳时不让他感觉到任何中断，
      //   后台静默换一条通路接着跑。只有全部端点都挂了才真的停下来。
      const switched = this.#tryRotateEndpoint(found.groupId);
      if (switched) {
        log(
          `🔁 模型组「${name}」${next.fails} 次通路失败，已切到备用通路 ${switched.index + 1}`,
        );
        // 切成功后把熔断器重置，让新端点从干净状态开始
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

  /**
   * 把某个组切到下一条端点（成功后重新注册 provider）。
   *
   * @returns {{index: number}|null} 已切换返回端点序号，待空闲、没有备用或失败返回 null
   */
  #tryRotateEndpoint(groupId) {
    if (this.providerUpdates.has(groupId)) return null;
    const group = modelGroups.get(groupId);
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

  /** 首次接单的请求作用域：只在对应理解轮期间存在，轮结束即清理。 */
  requestScopes = new Map();

  /** 忙时排队的不可变请求信封（不把身份借给正在跑的轮次）。 */
  requestQueues = new Map();

  /** 宿主注入的统一生命周期（WS/HTTP 共用；未注入时拒绝首次接单）。 */
  requestLifecycle = null;

  /** 本轮理解轮已给出的明确决议；模型文本不算。 */
  requestDecisions = new Map();

  /** 接单完成、等本轮释放后再通知 05 的任务。 */
  admittedQueue = [];

  #scopeKey(roomId, botId) {
    return this.#key(roomId, botId);
  }

  beginRequestScope(roomId, botId, scope) {
    if (!scope) return null;
    this.requestScopes.set(this.#scopeKey(roomId, botId), scope);
    return scope;
  }

  endRequestScope(roomId, botId, requestId = null) {
    const key = this.#scopeKey(roomId, botId);
    const current = this.requestScopes.get(key);
    if (!current) return;
    if (requestId && current.requestId !== requestId) return;
    this.requestScopes.delete(key);
  }

  currentRequestScope(roomId, botId) {
    return this.requestScopes.get(this.#scopeKey(roomId, botId)) ?? null;
  }

  /** 记录本轮明确决议。 */
  setRequestDecision(roomId, botId, scope, kind, extra = null) {
    if (!scope?.requestId) return;
    this.requestDecisions.set(requestIdentityKey(scope.requesterId, scope.requestId), { kind, ...(extra ?? {}) });
  }

  requestDecisionOf(scope) {
    return scope ? this.requestDecisions.get(requestIdentityKey(scope.requesterId, scope.requestId)) ?? null : null;
  }

  queueAdmittedTask(taskRunId) {
    if (taskRunId) this.admittedQueue.push(taskRunId);
  }

  #flushAdmitted() {
    for (const id of this.admittedQueue.splice(0)) {
      try {
        const runtime = this.taskRuntime;
        if (runtime?.notifyAdmitted) runtime.notifyAdmitted(id).catch(() => {});
        else if (runtime?.supervisor?.notify) Promise.resolve(runtime.supervisor.notify(id)).catch(() => {});
      } catch {}
    }
  }

  /** 宿主注入共用生命周期（WS/HTTP 各设一次，实现只有一份）。 */
  setRequestLifecycle(lifecycle) {
    this.requestLifecycle = lifecycle ?? null;
  }

  /** 不可变信封形状校验；不合格直接拒绝，不退回 legacy 执行。 */
  #assertRequestEnvelope(request) {
    if (!request?.scope?.requesterId || !request.scope.requestId || !request.scope.fingerprint) {
      throw Object.assign(new Error('请求信封不完整'), { code: 'BAD_REQUEST_ENVELOPE' });
    }
  }

  /** 理解轮真正取得执行权后激活；该轮真正结束后收尾。 */
  async #withRequestEnvelope(request, roomId, botId, fn) {
    const scope = request.scope;
    const active = this.currentRequestScope(roomId, botId);
    if (active && requestIdentityKey(active.requesterId, active.requestId) !== requestIdentityKey(scope.requesterId, scope.requestId)) {
      throw Object.assign(new Error('同一会话已有另一个请求身份在执行'), { code: 'REQUEST_SCOPE_CONFLICT' });
    }
    // ★ 关闭接单开关时**不建立**请求作用域。
    //
    //   作用域的作用是「这一轮必须走 accept_task 才有效」。
    //   但 accept_task 只在 PI_BOT_TASK_INTAKE=1 时才注册
    //   （session-factory 里 isChief && intakeEnabled() 才加）。
    //   关闭态却照样建作用域 —— 于是 tools.js 的
    //   「本轮是接单请求，建部门/派活必须通过 accept_task」必然命中，
    //   而那个替代路径根本不存在：
    //   默认配置下用户让主控建部门、派活，一律被拒且无路可走，
    //   组织能力被自己的防护锁死。
    //
    //   关闭态就不该有「接单轮」这个概念 —— 普通聊天照旧。
    if (this.taskIntakeEnabled) this.beginRequestScope(roomId, botId, scope);
    let failure = null;
    let verdict = null;
    try {
      await fn();
      verdict = this.requestDecisionOf(scope);
      // 关闭态：合法 requestId 的普通聊天不要求接单工具；本轮结束按普通回答收口。
      if (!verdict && this.taskIntakeEnabled) {
        await this.run(roomId, botId, '用户这一轮请求需要明确处理结果：只调用 accept_task 提交 answer / clarification / accept_task 之一；如果仍不确定是否要执行或缺少目标/交付物/验收/执行对象，先调用 kind=clarification 提一个具体问题；只给计划或普通聊天不算完成。', { skipUserMessage: true, human: true });
        verdict = this.requestDecisionOf(scope);
      }
      return verdict;
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      this.endRequestScope(roomId, botId, scope.requestId);
      this.requestDecisions.delete(requestIdentityKey(scope.requesterId, scope.requestId));
      const closeKind = verdict?.kind ?? (this.taskIntakeEnabled ? null : 'answer');
      this.requestLifecycle?.close?.(scope, failure, closeKind);
      // 首次准入与自然改版都等本轮理解释放后再启动受管执行，不抢当前会话。
      this.#flushAdmitted();
    }
  }

  /** 忙时排队：只存信封本身，等真正空闲再单独跑一轮。 */
  #enqueueRequest(roomId, item) {
    const list = this.requestQueues.get(roomId) ?? [];
    const identity = requestIdentityKey(item.request.scope.requesterId, item.request.scope.requestId);
    if (!list.some((x) => requestIdentityKey(x.request.scope.requesterId, x.request.scope.requestId) === identity)) list.push(item);
    this.requestQueues.set(roomId, list);
  }

  /** 排空该房间待执行请求（一次一封，避免身份串轮）。 */
  async #drainRequestQueue(roomId, botId) {
    const list = this.requestQueues.get(roomId);
    if (!list?.length || this.isBusy(roomId, botId)) return;
    const item = list.shift();
    if (!item) return;
    try {
      const result = await deliverDirectInput({
        prepare: () => this.#buildInput(item.text, item.files, roomId),
        run: ({ promptText }) => this.#withRequestEnvelope(item.request, roomId, botId, () =>
          this.run(roomId, botId, promptText, { skipUserMessage: true, attachments: item.files, human: true })),
        getEntry: () => this.sessions.get(this.#key(roomId, botId)),
        isCancelled: () => this.aborting.has(roomId),
        queue: async () => { throw Object.assign(new Error('请求已在队列中'), { code: 'REQUEST_QUEUED' }); },
        accepted: () => {},
      });
      if (result?.ok !== false) {
        const msg = store.updateMessage(roomId, item.messageId, { meta: { queued: false } });
        if (msg) bus.emit('event', { t: 'msg.updated', roomId, msg });
      }
    } catch (err) {
      const error = modelFailure(err).error;
      const msg = store.updateMessage(roomId, item.messageId, { status: 'error', error });
      bus.emit('event', { t: 'msg.error', roomId, msgId: item.messageId, error, msg });
    } finally {
      if ((this.requestQueues.get(roomId)?.length ?? 0) > 0) {
        setTimeout(() => { void this.#drainRequestQueue(roomId, botId); }, 0);
      }
    }
  }

  /**
   * 任务级在途执行登记：取消时只终止这个 TaskRun 的执行，
   * 不用 abort(roomId) 误伤同房间的其他目标。
   */
  managedInflight = new Map();

  abortManagedTask(taskRunId) {
    const entry = this.managedInflight.get(taskRunId);
    if (!entry) return { ok: false, code: 'not_inflight' };
    // 会话可能在建；按登记 key 惰性解析当前真实句柄，而不是登记时的快照
    const session = entry.session ?? this.sessions.get(entry.key)?.session ?? null;
    if (!session?.abort) return { ok: false, code: 'no_session' };
    try {
      session.abort();
    } catch {}
    return { ok: true, attemptId: entry.attemptId ?? null };
  }

  /** Bot 是否确属该房间（受管 DM 执行前核对，不靠上下文自证）。 */
  roomHasBot(roomId, botId) {
    const room = store.getRoom(roomId);
    if (!room) return false;
    if (Array.isArray(room.botIds)) return room.botIds.includes(botId);
    return Boolean(room.botId && room.botId === botId);
  }

  isBusy(roomId, botId) {
    const key = this.#key(roomId, botId);
    // ★ 同步占位也算忙。
    //
    //   群聊是并行的，同一个成员可能在同一波里被派两次（比如两个人同时 @ 了它，
    //   而它这一轮还有额度）。而 run() 是**异步**的 —— 等它把 entry.busy 设上已经晚了，
    //   两个 prompt() 会同时打到同一个 session，第二个直接抛：
    //       Agent is already processing. Specify streamingBehavior ('steer' or
    //       'followUp') to queue the message.
    //   所以派单那一刻就要**同步**登记，别等异步。
    if (this.dispatching?.has(key)) return true;
    return Boolean(this.sessions.get(key)?.busy);
  }

  /**
   * 房间里有没有人在**为用户干活**。
   *
   * ★ 只在压缩的会话不算 —— 压缩是这一轮开始前的准备动作，
   *   它没有在产出任何用户可见的东西。把它算成"忙"的后果是：
   *   用户一说话就判定"这轮作废"、打断全群，压缩被打断、下次从 0 重来，
   *   而用户的实际诉求只是"我又说了一句"。
   *
   *   真正在跑的（有会话、有 turnController、在流式输出）仍然算忙，
   *   那条路径上的插话语义不变。
   */
  isRoomBusy(roomId) {
    for (const [key, entry] of this.sessions) {
      if (!key.startsWith(`${roomId}:`)) continue;
      if (!entry.busy) continue;
      // 只在压缩、还没开始产出 → 不算忙
      if (entry.compactingOnly) continue;
      return true;
    }
    return false;
  }

  /** 目标 bot：DM 就是唯一成员；群就是部门老大 */
  targetBotFor(room) {
    if (room.kind === 'dm') return room.botIds[0] ?? null;
    const { leadId } = departmentOf(room);
    return leadId ?? room.botIds[0] ?? null;
  }

  // ---------------------------------------------------------------- 核心：跑一轮

  /** 把附件整理成两路：图片直接喂模型，文档抽正文拼进提示词 */
  /**
   * 拼输入（薄包装）：依赖在这里绑一次，逻辑在 prompt-input.js。
   * 绑在这儿是因为 attachments.js 那几个助手本来就是按本进程的配置工作的。
   */
  #buildInput(clean, files, roomId = '') {
    this.__buildInput ??= createBuildInput({
      workspace: config.workspace,
      metaFor,
      inboxPath,
      attachmentBlock,
    });
    // roomId 传下去是为了让附件落到 _inbox/<roomId>/：
    // 所有房间共用同一个工作目录，不隔离的话 A 房间的文件
    // 会被 B 房间的 bot 一把 ls 全看到。
    return this.__buildInput(clean, files, { roomId });
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

  // ---------------------------------------------------------------- 核心：跑一轮

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
  #mirrorProgress(progress) {
    try {
      mirrorProgress({ store, ...progress });
    } catch (err) {
      log('私聊进度回执失败：', err?.message || err);
    }
  }

  /**
   * 等这一轮的 pending 落定 —— 但用户插话/终止后只给一小段缓冲。
   *
   * 为什么：旧轮的成员可能正卡在一个很慢的工具/模型请求里（最长要等 watchdog 6 分钟），
   * 如果一直 await，房间锁就会被扣死 —— 用户发的新消息要等好几分钟才轮得到，
   * 表现就是"问进度像卡死、负责人也不出来"。用户已经插话的情况下，
   * 旧轮的产出本来就要作废（stale），没必要为了等它阻塞新的一轮。
   */
  async #awaitPending(pending, stale, { graceMs = 5000, pollMs = 100 } = {}) {
    if (!pending.length) return;
    let settled = false;
    const all = Promise.allSettled(pending).then(() => {
      settled = true;
    });
    // 正常等：谁先落地谁走（不引入轮询延迟 —— 轮询会拖慢
    // "上一波落地 → 下一波派发"的节奏，成员派发可能被拖到用户插话之后，
    // 被误判成"插话后不该再派"）。
    const watch = (async () => {
      while (!settled) {
        if (stale()) return true;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return false;
    })();
    const wentStale = await Promise.race([watch, all.then(() => false)]);
    if (!wentStale || settled) return;
    // 已经插话/终止：最多再等 graceMs，然后放行，绝不把房间锁扣死
    await Promise.race([all, new Promise((r) => setTimeout(r, graceMs))]);
    if (!settled) {
      log(`用户已插话/终止：旧轮还有 ${pending.length} 个会话没退出，先释放房间锁`);
    }
  }

  /**
   * **单次受管执行**：执行明确授权的那一个目标，并返回它的结果。
   *
   * ## 为什么不复用旧群协调路径
   *
   * 旧路径有两处会「自己造目标」：
   *
   *   · `openingSpeakers` 用自然语言猜谁该被叫到 —— 目标是成员但正文没 @ 它时，
   *     它会选负责人，然后受管过滤又把负责人跳过，结果一次都没跑；
   *   · 收尾轮会再补一次 run —— 那一次没有受管上下文，产生一段无
   *     AttemptResult 的 legacy 执行。
   *
   * 受管执行的目标是**已知的**，所以不走猜人、也不补跑：
   * 直接执行它，把结果返回给调用方。
   *
   * ## 报告 scope 在这里开、在这里关
   *
   * 收集器的创建与释放都收敛到 `#activateReportScope` / `#releaseReportScope`，
   * 不再散落在 run 的各个早退分支上 —— 那样任何一个新出口都可能漏清理。
   */
  async #runManagedOnce({
    room,
    botId,
    managedContext,
    openerText = '',
    openerBotId = null,
    openerName = '用户',
    openerMessageId = null,
    attachments = [],
    attachmentContext = null,
    kickoff = false,
  } = {}) {
    const roomId = room.id;
    const bot = store.getBot(botId);
    if (!bot) {
      return { ok: false, code: 'MANAGED_TARGET_MISSING', error: '受管目标 Bot 不存在', stop: STOP.failed };
    }

    const fresh = transcriptFor(roomId, botId);
    const prompt = composeGroupPrompt(room, bot, fresh, {
      isLead: botId === (departmentOf(room).leadId ?? null),
      reason: kickoff ? '部门刚成立，先由你安排' : openerBotId ? openerName + ' 叫了你' : '用户发了新消息',
      members: departmentOf(room).members,
      leadId: departmentOf(room).leadId,
      order: { index: 1 },
    });

    // 受管执行：把任务/阶段提示真正送进模型输入（旧非受管路径不受影响）
    const taskPrompt = typeof openerText === 'string' && openerText.trim() ? openerText.trim() : '';
    const composed = [taskPrompt, prompt].filter(Boolean).join('\n\n');


    const key = this.#key(roomId, botId);
    const managedTaskRun = managedContext?.taskRunId ?? null;
    this.dispatching.add(key);
    if (managedTaskRun) {
      const entry = this.sessions.get(key);
      this.managedInflight.set(managedTaskRun, { key, botId, roomId, session: entry?.session ?? null, attemptId: managedContext?.attemptId ?? null });
    }
    try {
      const res = await this.run(roomId, botId, attachmentContext ? attachmentContext + '\n\n' + composed : composed, {
        groupTurn: true,
        retryManaged: true,
        taskRunId: newId('run_'),
        attemptIndex: 1,
        attachments,
        managedContext,
        human: !openerBotId,
      });
      // 受管执行的返回值就是这一轮的结果：调用方据此推进 TaskRun。
      return res;
    } catch (err) {
      log('【' + room.name + '】受管单次执行异常：', err?.message || err);
      return {
        ok: false,
        code: 'MANAGED_EXECUTION_FAILED',
        error: err?.message || String(err),
        stop: STOP.failed,
      };
    } finally {
      this.dispatching.delete(key);
      if (managedTaskRun) this.managedInflight.delete(managedTaskRun);
    }
  }
  async runRound(
    roomId,
    {
      openerText = '',
      openerBotId = null,
      openerMessageId = null,
      openerName = '用户',
      kickoff = false,
      attachments = [],
      attachmentContext = null,
      /**
       * 受管执行上下文（可省略）。
       *
       * ★ 只对**同一个 Bot** 的那一次尝试有意义。
       *   多 Bot 队列不能把一份属于某 Bot 的尝试上下文复制给别人。
       */
      managedContext = null,
    } = {},
  ) {
    const room = store.getRoom(roomId);
    if (!room || room.kind !== 'group') return;
    const { members, leadId } = departmentOf(room);
    if (!members.length) return;

    // ★ 与 run 保持同一套拒绝语义：显式给了非法上下文就在**派活之前**拒绝。
    //   若在这里放行，队列构造会把不匹配的上下文悄悄变成 null，
    //   于是这次调用以旧路径跑起来 —— 和 run 的判定不一致。
    /** 本次轮次是否是受管执行（显式提供了上下文）。 */
    const isManagedRound = managedContext !== null && managedContext !== undefined;

    if (isManagedRound) {
      // ★ 不能用 ctx.botId 自证 —— 那只是上下文自己声明的执行者。
      //   必须核对**本次真实要执行的部门**里有没有这个 Bot。
      //   actualBotId 留 null，让 resolver 只做记录/状态/尝试/授权核对；
      //   执行者归属由下面按真实成员集合判断。
      const probe = resolveManagedContext(managedContext, {
        loadTaskRun: (id) => store.taskRuns.read(id),
        loadRootTaskRun: (id) => store.taskRuns.read(id),
      });
      if (probe.kind === MANAGED.invalid) {
        return {
          ok: false,
          code: 'INVALID_MANAGED_CONTEXT',
          error: `受管执行上下文不合法：${probe.text}`,
          stop: STOP.failed,
        };
      }

      // ★ 上下文有效 ≠ 能用于这次执行。
      //   受管轮次只跑「上下文声明的那个 Bot」，而且它必须真在这个部门里。
      //   不匹配就**在派活之前拒绝**，不能悄悄退回 legacy 跑一遍别的 Bot。
      if (!members.some((m) => m.id === probe.context.botId)) {
        return {
          ok: false,
          code: 'MANAGED_TARGET_NOT_IN_DEPARTMENT',
          error:
            `受管执行上下文授权给 ${probe.context.botId}，但这次部门里没有它 ——` +
            '不能把这份授权用于别的成员',
          stop: STOP.failed,
        };
      }

      // ★ 受管单次执行与旧群协调**分开**。
      //
      //   旧路径的 opening 用自然语言猜「谁该被叫到」、closing 又会补一次
      //   收尾跑 —— 两者都可能派给不是本次授权目标的 Bot，
      //   或追加一次没有受管关联的 legacy 执行。
      //
      //   受管轮次的目标是**明确的**（就是 ctx 里的那个），所以直接执行它，
      //   不进队列、不做开场/收尾决策，并把它这一次的结果原样返回。
      return this.#runManagedOnce({
        room,
        botId: probe.context.botId,
        managedContext,
        openerText,
        openerBotId,
        openerName,
        openerMessageId,
        attachments,
        attachmentContext,
        kickoff,
      });
    }

    // 记下这一轮开始时的代数。用户插话会把它 +1 —— 那之后本轮的
    // 任何"继续派活 / 重试 / 失败回执 / 收尾 / 复盘"都不该再发生。
    const epoch = this.#roundEpoch(roomId);
    const stale = () => this.#roundEpoch(roomId) !== epoch;

    const opening = openingSpeakers(room, { text: openerText, openerBotId, kickoff });
    if (!opening.length) return;

    // 轮次预算从 store 读（用户可在设置里改），config 只是默认值
    const limits = store.groupLimits();
    const budget = (botId) => (botId === leadId ? limits.leadTurns : limits.memberTurns);
    const used = new Map();
    // 本轮里被叫到过的人（含首发和后来被 @ 进队列的）。收尾推游标时要跟「没被叫到的」区分开
    const called = new Set(opening);
    const chiefId = store.mainBot()?.id ?? null;
    const queue = opening.map((botId) => ({
      botId,
      reason: kickoff ? '部门刚成立，先由你安排' : openerBotId ? `${openerName} 叫了你` : '用户发了新消息',
      fromId: openerBotId ?? null,
      fromName: openerName,
      fromText: openerText,
      sourceMessageId: openerMessageId,
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
    //   群组内有多少人，就发多少个并发，先后由组长自行决定。
    //   一个一个 `await this.run(...)` 来的话，组长一次 @ 了六个人，
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
    // 三种"不继续"的理由在一个地方说了算，不散在循环条件和几处 break 里。
    for (;;) {
      const stop = shouldStopRound({
        queueLen: queue.length,
        pendingLen: pending.length,
        runs,
        maxRuns: limits.maxRuns,
        aborting: this.aborting.has(roomId),
        stale: stale(),
      });
      if (stop.stop) {
        const voided = stop.why === '已终止' || stop.why === '用户插话';
        if (queue.length) {
          // 不管是终止、插话还是预算掐断，都要留痕 —— 不然用户看到"组长明明 @ 了，
          // 怎么只有一个 bot 动起来"时无从查起；这类出口不能静默。
          log(
            voided
              ? `【${room.name}】⏹ ${stop.why}，剩下的 ${queue.length} 个人不再派`
              : `【${room.name}】⚠️ ${stop.why}，还有 ${queue.length} 个人没轮到：` +
                  leftBehind(queue, (id) => store.getBot(id)?.name ?? id).join('、'),
          );
        }
        if (voided) queue.length = 0;
        break;
      }
      if (!queue.length) {
        await this.#awaitPending(pending.splice(0), stale);
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
        // ★ 不能静默：用户看到"A @ 了 B"却没人动，会以为群卡死了。
        //   在群里留一条可见提示，并说明怎么解（调高部门预算/发新消息重置）。
        //
        //   ★ 用户自己 @ 的也算：老实现只在 item.fromId 非空时留痕，
        //     于是"用户亲自 @ 了某人、但那人预算用完"这件事群里零痕迹 ——
        //     用户只知道"我叫了它，它没反应"。这条路径恰恰是最需要解释的。
        {
          const byUser = !item.fromId;
          store.appendMessage({
            roomId,
            authorType: 'system',
            authorName: '调度提示',
            text: byUser
              ? `${bot.name} 本轮已发言 ${done} 次（上限 ${budget(bot.id)} 次），` +
                '这次没有派发。发一条新消息可重置本轮预算，或在「部门预算」里调高每轮发言次数。'
              : `${bot.name} 本轮已发言 ${done} 次（上限 ${budget(bot.id)} 次），` +
                '这条 @ 没有派发。发一条新消息可重置本轮预算，或在「部门预算」里调高每轮发言次数。',
            status: 'done',
            meta: { via: 'turn_budget_skip', botId: bot.id, fromId: item.fromId ?? null },
          });
        }
        continue;
      }
      // ★ 上级叫它 → 无论多忙都要**停下来听**。
      //
      //   无论多忙，当组长 / 部长 / 自己上级 @ 的时候，必须先停下来听最新的
      //   要求，同时上报目前自己的进度。
      //
      //   不能写成“等它忙完再派” —— 方向不对：上级的要求是**实时**的，
      //   等它把手上的活磨完可能已经几分钟过去了。所以这里用 steer：
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
          //   要的是"停，按新的来"，不是"你先把旧的收个尾"。
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
            const progressSource = {
              dispatchId: newId('dispatch_'),
              sourceMessageId: item.sourceMessageId ?? null,
              fromId: item.fromId ?? null,
              fromName: item.fromName || (item.fromId ? (store.getBot(item.fromId)?.name ?? '') : ''),
            };
            if (mirror) {
              this.#mirrorProgress({
                room,
                bot,
                phase: 'start',
                text: item.fromText || item.reason,
                ...progressSource,
              });
            }
            // ★ 受管轮次只跑上下文声明的那个 Bot。
            //   其他成员不进入执行：既不派活，也不建旧任务板条目 ——
            //   否则会出现「用 A 的旧任务板跑了一次不该跑的执行」。
            if (isManagedRound && managedContext.botId !== bot.id) {
              log(`【${room.name}】${bot.name} 跳过：本轮是受管执行，只跑 ${managedContext.botId}`);
              return;
            }

            // 部门里"别人派给它"的活 → 任务板上登记一条（跑完再收尾）
            // ★ 受管执行不登记旧任务板：它的状态由 TaskRun 归约器负责。
            const taskId = item.fromId && !isManagedRound
              ? store.upsertDispatchTask({
                  roomId,
                  ownerBotId: bot.id,
                  title: item.fromText || item.reason,
                  sourceMessageId: item.sourceMessageId ?? null,
                })
              : null;
            // ★ 失败要重试，而不是只打一行日志就消失。
            //
            //   失败只打一行日志的话，负责人发现成员卡住/失败时不知道是谁失败，
            //   就不让人重干、自己上手。
            //   结果用户以为全员交付完成，实际有人掉链子被悄悄兜底。
            //
            //   这里改成：失败 → 群里留痕 → 有限次重试 → 用完上报给负责人。
            //
            // ★ 但发请求之前先看这条路通不通。
            //
            //   熔断器打开时不发网络请求，直接快速失败 —— 这是「更快」的关键：
            //   实测 6 个成员的群、key 彻底不可用，原先会打 66 次请求、累积等 584 秒。
            //   有熔断后第 1 个 bot 撞 3 次就停住，其余 5 个立刻得到结论。
            this.flushProviderUpdates();
            const gate = this.breakerFor(bot.id);
            const gateCheck = gate ? breakerAllows(gate.breaker, Date.now()) : { allow: true };
            const taskRunId = newId('run_');

            // ★ 受管轮次走到这里，bot.id 一定就是上下文声明的执行者
            //   （不匹配的成员在上面已经 return 了）。所以直接用整份上下文，
            //   不再有「不匹配就置 null」的降级路径。
            //   非受管轮次 managedContext 本就是 null。
            const itemManaged = isManagedRound ? managedContext : null;
            let res;
            if (!gateCheck.allow) {
              log(`【${room.name}】${bot.name} 跳过：${gateCheck.reason}`);
              res = {
                ok: false,
                text: '',
                ms: 0,
                error: breakerNote(gate.breaker, {
                  groupName: modelGroups.get(gate.groupId)?.name ?? '',
                }),
                status: 503,
                messageId: '',
                breakerSkipped: true,
              };
            } else {
              res = await this.run(roomId, bot.id, prompt, {
                groupTurn: true,
                retryManaged: true,
                taskRunId, attemptIndex: 1,
                attachments,
                managedContext: itemManaged,
                // ★ 用户直接叫的人才能用保底槽（与打断特权同一个判据：fromId 为空）。
                //   同事之间 @ 算常规派活，不占用给人留的那一位。
                human: !item.fromId && isUserInitiatedRound({ openerBotId }),
              });
            }
            // 第一次的结果也要喂给熔断器，否则"第 1 次就挂"的情况记不到
            if (res.ok) {
              this.markGroupHealthy(bot.id);
            } else if (!res.breakerSkipped) {
              const firstDecision = decideRetry({
                error: String(res.error ?? ''),
                attempt: 1,
                aborting: this.aborting.has(roomId),
                status: res.status ?? null,
              });
              this.markGroupFailed(bot.id, {
                kind: firstDecision.kind,
                status: res.status ?? null,
              });
            }
            let attempt = 1;
            let lastError = res.ok ? '' : String(res.error ?? '未知原因');
            // 上游状态码：错误文案是脱敏的，只有它能让重试策略分辨
            // "429 限流"和"任务本身做不成"
            let lastStatus = res.ok ? null : (res.status ?? null);
            // 最后一次失败的类型：循环外写"失败回执"时要用它来决定文案。
            // 被熔断挡下时直接标成 breaker-open —— 那正是要给用户看的文案。
            let lastKind = res.breakerSkipped ? 'breaker-open' : '';
            const retries = [];

            while (!res.ok) {
              // 熔断挡住的那次：不是"又失败一次"，是"压根没发请求"。
              // 直接跳出，别走重试决策 —— 那会再算一遍退避时间，白等。
              if (res.breakerSkipped) break;
              // 用户插话了：旧任务直接作废，既不重试也不上报
              if (stale()) break;
              const decision = decideRetry({
                error: lastError,
                attempt,
                aborting: this.aborting.has(roomId),
                status: lastStatus,
              });
              if (!decision.retry) {
                log(`【${room.name}】${bot.name} 不再重试：${decision.why}`);
                lastKind = decision.kind;
                break;
              }
              // ★ 熔断器刚打开 → 别再撞了。
              //
              //   这一次失败可能就是压垮它的第 3 次。已经确定这条路不通，
              //   继续按指数退避重试只是把 97 秒的等待重复一遍。
              const afterFail = this.breakerFor(bot.id);
              if (afterFail && afterFail.breaker.state === BREAKER_STATE.open) {
                log(`【${room.name}】${bot.name} 熔断已打开，停止重试`);
                lastKind = 'breaker-open';
                break;
              }
              attempt++;
              retries.push(`${attempt}. ${decision.why}`);
              // ★ 前几次重试**不往群里写东西**。
              //
              //   原先每次重试都插一条「XX 在等接口恢复（HTTP 502），第 N 次重试…」。
              //   10 次重试就是 10 条系统消息，把整段对话刷满 ——
              //   用户看到的是"群里一直在报错"，而实际上这些重试大多会自己恢复。
              //
              //   接口抖动是**我们这边的事**，不该让用户围观。
              //   只在「放弃」时写一条（下面失败回执那段），那才是他需要知道的。
              //   中途进度留在日志里，排查时能看到。
              log(
                `【${room.name}】${bot.name} 第 ${attempt} 次尝试（${decision.kind}）：${lastError.slice(0, 80)}`,
              );
              // 隔一会儿再试：立刻重发大概率撞上同样的偶发问题。
              // 接口抖动类按指数退避 —— 限流时固定 3 秒重发会一直撞同一堵墙。
              const waitMs =
                decision.kind === 'transient'
                  ? transientBackoffMs(attempt - 1)
                  : RETRY_DELAY_MS;
              await new Promise((r) => setTimeout(r, waitMs));
              if (this.aborting.has(roomId)) break;
              // ★ 重试等待期间用户插话 → 旧任务作废，别再起跑
              if (stale()) break;
              // 换个说法再发，而不是原样重发（原样输入很可能得到同样结果）
              const hinted = retryHint({
                attempt: attempt - 1,
                error: lastError,
                kind: decision.kind,
                switchModel: decision.switchModel === true,
              });
              settleRetryMessage(store, roomId, res, { willRetry: true });
              res = await this.run(roomId, bot.id, hinted + prompt, {
                groupTurn: true,
                retryManaged: true,
                taskRunId, attemptIndex: attempt,
                attachments,
                managedContext: itemManaged,
              });
              if (!res.ok) {
                lastError = String(res.error ?? '未知原因');
                lastStatus = res.status ?? null;
              }
              // 把这次的结果喂给熔断器（纯函数，非通路故障不计入）
              if (res.ok) {
                this.markGroupHealthy(bot.id);
              } else {
                this.markGroupFailed(bot.id, {
                  kind: decision.kind,
                  status: res.status ?? null,
                });
              }
            }

            // ★ 用户插话 = 这一条属于旧需求，作废。
            //   不重试、不留“失败回执”、不上报负责人、不推进游标 ——
            //   否则用户会看到旧任务的红字和"XX 没能完成"，而他刚说过"按新的来"。
            if (stale()) {
              settleRetryMessage(store, roomId, res, { aborted: true });
              // ★ 批次 03：受管 TaskRun 不走 finishTask(res.ok)。
              //   它的完成由归约器 + 验收决定；这里只处理旧任务板。
              if (taskId && !itemManaged) {
                store.finishTask(taskId, {
                  ok: res.ok,
                  text: res.ok ? res.text : '用户插话，旧任务作废',
                });
              }
              log(`【${room.name}】用户插话 → ${bot.name} 这一条作废（不重试、不上报）`);
              return;
            }

            // 按最终结果结束重试状态，保留成功正文。
            settleRetryMessage(store, roomId, res, res.ok
              ? { succeeded: true }
              : { error: lastError, aborted: this.aborting.has(roomId) });
            // ★ 批次 03：受管 TaskRun 的完成必须经过验收，
            //   不能用「这一轮 ok」直接判完成 ——
            //   步数到上限时 ok 也是 true，但那只是让出。
            if (taskId && !itemManaged) {
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
                ...progressSource,
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
                kind: lastKind,
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
              sourceMessageId: res.messageId || null,
            });
            queued.add(id);
            called.add(id);
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
    // ★ 用户插话/终止后只等一小段缓冲，不能把房间锁扣死（见 #awaitPending）
    await this.#awaitPending(pending, stale);

    // ★ 用户插话：本轮到此为止。
    //   不叫老大收尾（收的是旧需求的尾）、不推进未参与者的游标
    //   （否则他们回来后看不到新需求）、也不做经验复盘（复盘的是作废的一轮）。
    if (stale()) {
      log(`【${room.name}】用户插话 → 旧轮收手，改为按新要求重新开始`);
      return;
    }

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

    // 没被叫到的成员也算「看过这条了」，避免下次一次性倒一堆旧账。
    // ★ 被 @ 过、排进了队列但没轮到的人除外（本轮预算用完或被跳过）：
    //   推了它的游标，派给它的那条活就落在游标之前，下次被叫到只剩一句「X 叫了你」。
    const lastId = lastMessageId(roomId);
    for (const m of members) {
      if (used.has(m.id) || called.has(m.id)) continue;
      store.setCursor(roomId, m.id, lastId);
    }

    // 收尾复盘：从这一轮里提炼候选经验（只进库，不进提示词）。
    // 放后台跑 —— 用户不该等复盘；失败只写日志，不影响这一轮已经交付的结果。
    if (roundStartIndex >= 0 && store.lessonsEnabled()) {
      void this.reflect?.({ roomId, sinceIndex: roundStartIndex }).catch((err) =>
        log(`【${room.name}】复盘异常：`, err?.message || err),
      );
    }
  }

  // ---------------------------------------------------------------- 核心：跑一轮

  /**
   * 用户发消息。
   * - DM：直接给那个 bot
   * - 群（部门）：交给部门老大先接，老大用 @ 往下派
   * - 正在跑：不报错，而是插话引导（steer）或排队（followUp）
   */
  async send(roomId, text, { mode = 'steer', attachments = [], flushMerge = true, request = null } = {}) {
    const room = store.getRoom(roomId);
    if (!room) throw Object.assign(new Error('会话不存在'), { code: 'NO_ROOM' });
    const clean = String(text ?? '').trim();
    const files = (attachments ?? []).filter(Boolean);
    if (!clean && !files.length) throw Object.assign(new Error('消息为空'), { code: 'EMPTY' });

    const botId = this.targetBotFor(room);
    if (!botId) throw Object.assign(new Error('这个会话里没有 bot'), { code: 'NO_BOT' });
    const bot = store.getBot(botId);
    if (request) {
      this.#assertRequestEnvelope(request);
      // 群聊轮次的身份绑定尚未接入：明确拒绝，不把请求默默降级成 legacy 执行
      if (room.kind === 'group') {
        throw Object.assign(new Error('群聊暂不支持首次接单请求'), { code: 'REQUEST_GROUP_UNSUPPORTED' });
      }
    }

    // 正在跑：新的独立请求按信封排队，不把身份借给当前轮次
    if (this.isBusy(roomId, botId) && request) {
      const userMessage = store.appendMessage({
        roomId, authorType: 'user', authorName: '我', text: clean, status: 'done',
        meta: { queued: 'request', requestId: request.scope.requestId },
        attachments: hydrate(files),
      });
      this.#enqueueRequest(roomId, { request, text: clean, files, messageId: userMessage.id });
      bus.emit('event', { t: 'request.queued', roomId, requestId: request.scope.requestId, requesterId: request.scope.requesterId, messageId: userMessage.id });
      return { userMessage, bot, queued: true, requestId: request.scope.requestId };
    }

    // 正在跑：插话 / 排队
    if (this.isBusy(roomId, botId)) {
      const entry = this.sessions.get(this.#key(roomId, botId));
      if (!entry?.session) {
        throw Object.assign(new Error('会话还没就绪，稍后再发'), { code: 'NOT_READY' });
      }
      const effective = mode === 'followUp' ? 'followUp' : 'steer';
      let queued;
      try {
        const { promptText } = await this.#buildInput(clean, files, roomId);
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
        // ★ 用户的消息**就落在最新**。
        //   如果插在“它正在写的那条回复”之前 —— 那样读起来因果更顺，
        //   但那个回复可能是几分钟前开始的，一插就插到聊天记录中间去了，
        //   用户找不到自己刚说的话。所以直接追加到底部。
        {},
      );
      bus.emit('event', {
        t: 'steer.accepted',
        roomId,
        mode: effective,
        text: clean,
        messageId: userMessage.id,
      });

      // ★ 插话后模型重新想的回复，要排在用户这句话**后面**。
      //   botMsg 是插话之前创建的（位置在用户消息上面）；模型被打断后
      //   重新思考，新内容继续写进同一条 —— 不挪的话用户看到的是
      //   "答案排在问题前面"（插话后顺序乱）。
      //   touch=true：内容在重新生成，时间戳也跟着挪到现在。
      const liveMsgId = entry.liveMsgId;
      if (liveMsgId && liveMsgId !== userMessage.id) {
        store.moveMessageAfter(roomId, liveMsgId, userMessage.id, { touch: true });
      }
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
      //   语义：**打断所有正在跑的会话，丢掉旧队列，由负责人带新 query
      //   重新想、重新派**。用户是唯一决策者，让他等旧活干完没有意义 ——
      //   等来的结果基于已经被推翻的需求。
      //
      //   不能只让组长另开一个会话当场回一句：用户看到有人回了，
      //   但群里的活还是按旧需求在干，产出对不上。
      //   也不能房间忙就排队等下一轮：用户看到"它下一步会看到"，
      //   但成员还在跑旧需求，用户的话等于没生效。
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
        prepare: () => this.#buildInput(clean, files, roomId),
        // DM 里的每一轮都是用户直接说话 → 走人的保底槽
        // 首次接单请求：作用域在真正取得执行权时激活、本轮真正结束时收尾
        run: async ({ promptText }) => {
          const execute = () => this.run(roomId, botId, promptText, { skipUserMessage: true, attachments: files, human: true });
          if (!request) return execute();
          try {
            return await this.#withRequestEnvelope(request, roomId, botId, execute);
          } finally {
            void this.#drainRequestQueue(roomId, botId);
          }
        },
        getEntry: () => this.sessions.get(this.#key(roomId, botId)),
        isCancelled: () => this.aborting.has(roomId)
          || (this.directDeliveryEpochs.get(roomId) ?? 0) !== deliveryEpoch,
        queue: (session, { promptText }) => session[effective](promptText, files.map(readForModel).filter(Boolean)),
        accepted: (queued) => {
          store.updateMessage(roomId, userMessage.id,
            { meta: { ...(userMessage.meta ?? {}), queued: effective, queuedState: queued ?? 'queued' } });
          bus.emit('event', { t: 'steer.accepted', roomId, mode: effective, text: clean, messageId: userMessage.id });
          // 同 send() 的 busy 分支：插话后把正在写的那条挪到用户这句话后面
          const racing = this.sessions.get(this.#key(roomId, botId));
          const liveMsgId = racing?.liveMsgId;
          if (liveMsgId && liveMsgId !== userMessage.id) {
            store.moveMessageAfter(roomId, liveMsgId, userMessage.id, { touch: true });
          }
        },
      }).catch((err) => {
        const error = modelFailure(err).error;
        const msg = store.updateMessage(roomId, userMessage.id, { status: 'error', error });
        bus.emit('event', { t: 'msg.error', roomId, msgId: userMessage.id, error, msg });
      });
    }
    return { userMessage, bot, group: room.kind === 'group' };
  }

  /** 记忆摘要的有界材料窗口；增量进度使用消息 ID。 */
  static MEMORY_WINDOW = 400;

  /**
   * 按策略判断要不要自动总结一次记忆。**不阻塞**调用方。
   *
   * 触发规则见 memory-policy.js：
   *   · 首次满 10 轮就总结；
   *   · 之后看新增消息里有没有"关键内容"（决策/口径变更/纠正/未完成事项），
   *     命中就立刻总结，没命中就慢慢攒（攒越久门槛越高）。
   *
   * 为什么放在 runner 而不是 http：自动触发不该依赖有没有人打开界面。
   */
  maybeAutoSummarize(roomId, botId) {
    if (this.memoryAutoDisabled) return;
    try {
      const all = store.listMessages(roomId, { limit: PiRunner.MEMORY_WINDOW });
      const summary = store.memorySummaryFor(roomId, botId);
      const { conversation, newMessages, totalTurns } = memoryProgress(all, summary);
      if (!conversation.length || !newMessages.length) return;
      const verdict = shouldAutoSummarize({
        summary,
        totalTurns,
        newMessages,
        now: Date.now(),
      });
      if (!verdict.due) return;
      log(
        `🧾 自动记忆总结（${verdict.reason}）：轮数 ${totalTurns}，` +
          `新增 ${newMessages.length} 条，重要度 ${verdict.score}`,
      );
      // 后台跑，不 await —— 别让总结卡住用户的下一条消息
      this.summarizeMemory(roomId, botId).catch((err) =>
        log(`自动记忆总结失败：${err?.message ?? err}`),
      );
    } catch (err) {
      log(`自动记忆总结判断失败：${err?.message ?? err}`);
    }
  }

  /**
   * 记忆摘要：把这个私聊最近的对话整理成"它记住了什么"。
   *
   * 存在 store 里（roomId:botId → {text, lastId, count, at}），有缓存；
   * 有新消息（lastId 变了）或 force 时才重新生成。
   */
  async summarizeMemory(roomId, botId, { force = false } = {}) {
    // 普通摘要复用进行中的任务；强制摘要各自持有配置租约。
    const jobKey = `${roomId}:${botId}`;
    if (!this.memoryJobs) this.memoryJobs = new Map();
    if (!force && this.memoryJobs.has(jobKey)) return this.memoryJobs.get(jobKey);
    this.flushProviderUpdates();
    const job = this.withBackgroundSlot(`记忆摘要 · ${roomId}`, () => {
      this.flushProviderUpdates();
      return this.providerUpdates.withLease((lease) => this.#summarizeMemoryNow(roomId, botId, { force, lease }));
    });
    this.memoryJobs.set(jobKey, job);
    try {
      return await job;
    } finally {
      if (this.memoryJobs.get(jobKey) === job) this.memoryJobs.delete(jobKey);
    }
  }

  async #summarizeMemoryNow(roomId, botId, { force = false, lease = null } = {}) {
    const room = store.getRoom(roomId);
    if (!room) return { error: '会话不存在' };
    const bot = store.getBot(botId);
    if (!bot) return { error: 'bot 不存在' };

    const all = store.listMessages(roomId, { limit: PiRunner.MEMORY_WINDOW });
    const cached = store.memorySummaryFor(roomId, botId);
    const { conversation, lastId, totalTurns } = memoryProgress(all, cached);
    if (!conversation.length) return { text: '', at: null, count: 0, stale: false, lastId };
    if (!force && cached && cached.lastId === lastId) return cached;

    const digest = buildMemoryDigest(all);

    const prompt = [
      `下面是「${bot.name}」与用户最近的对话记录。请把它整理成一份"记忆摘要"：`,
      '1) 用户长期关注什么、有什么偏好与要求；',
      '2) 已经确定的结论/数据/口径（保留关键数字）；',
      '3) 还没做完的事与下一步；',
      '4) 重要的文件路径或系统状态。',
      '要求：要点式中文，每行一条，总长不超过 500 字；不要复述原话，不要寒暄。',
      '',
      digest,
    ].join('\n');

    const model = (bot.model ? this.resolveModel(bot.model) : null) ?? this.model;
    lease?.restrictTo(providerLeaseScope(model));
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('记忆摘要超时（90 秒）')),
      90_000,
    );
    try {
      const reply = await this.modelRuntime.completeSimple(
        model,
        {
          systemPrompt: '你是一个记忆整理器，只输出整理后的记忆摘要。',
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        },
        { maxTokens: 1200, signal: controller.signal },
      );
      const text = textOf(reply).trim();
      if (!text) {
        return { ...(cached ?? {}), error: '模型没有返回内容', stale: true };
      }
      return store.setMemorySummary(roomId, botId, {
        text,
        lastId,
        // 累计窗口内已确认的轮数；增量边界由 lastId 保存。
        count: totalTurns,
        turns: totalTurns,
        at: Date.now(),
      });
    } catch (err) {
      return { ...(cached ?? {}), error: String(err?.message || err), stale: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 主动压缩：上下文到 config.compactAtPercent 就先收成摘要。
   *
   * 为什么要自己做，不交给 pi 的自动压缩：
   *   pi 的触发线是 contextWindow - reserveTokens（1M 窗口 / 16k reserve ≈ 98.4%），
   *   压完只剩 1.6% 余量 —— 随便读一份数据又满了，群聊长任务就进入
   *   「99% → 压缩 → 读一下 → 100% → 再压缩」的死循环。
   *   这里提前到 80% 触发，压完通常只剩 5% 左右，能撑很多轮。
   */
  /**
   * 压缩时追加给摘要模型的额外指引。**默认不传。**
   *
   * ## 为什么不传
   *
   * pi 自带的摘要 prompt 已经是一份结构化的检查点格式：
   *
   *   ## Goal / ## Constraints & Preferences / ## Progress
   *   ## Key Decisions / ## Next Steps / ## Critical Context
   *
   * 并且明确要求：Preserve exact file paths, function names, and error messages.
   * 还会额外保留 <read-files> / <modified-files> 两份文件操作清单。
   *
   * 我们原来往里加了一句「删掉寒暄、重复和过程细节，用要点式中文，尽量短」。
   * 实测（同一段 19 万字符的真实对话，各压一次）：
   *
   *   · 长度只少了 107 字符（3,145 → 3,038），等于没省；
   *   · 但关键数字丢了一个（BE 32,960），
   *     而我们加的那句话唯一的作用就是让它更短。
   *
   * 收益约等于零，风险是实的 —— 所以默认不传。
   * 需要额外强调某类信息时再临时传。
   */
  static COMPACT_PROMPT = null;

  /**
   * 主动压缩前的**判定**：该不该压、压几次。纯函数，便于单测。
   *
   * 判定与执行分开，是因为"压不压"和"压失败怎么办"是两套逻辑：
   * 前者只看上下文水位和重试冷却，后者才涉及会话状态。
   *
   * @param {object} p
   * @param {number|null} p.percent    当前上下文占用百分比
   * @param {number} p.threshold       触发阈值（百分比）
   * @param {number} p.now
   * @param {number} [p.retryAfter]    上次失败后的冷却截止时间
   * @param {boolean} [p.compacting]   会话是否正在压缩
   * @param {boolean} [p.autoCompact]  总开关
   * @returns {{compact:boolean, why:string}}
   */
  static planCompaction({
    percent = null,
    threshold = 80,
    now = Date.now(),
    retryAfter = 0,
    compacting = false,
    autoCompact = true,
  } = {}) {
    if (!autoCompact) return { compact: false, why: '自动压缩已关闭' };
    if (compacting) return { compact: false, why: '已在压缩中' };
    if (typeof percent !== 'number') return { compact: false, why: '拿不到上下文占用' };
    if (percent < threshold) return { compact: false, why: `未到阈值 ${threshold}%` };
    // 上次失败后的冷却期：立刻重试大概率再撞一次墙，白烧一轮 token
    if (retryAfter > now) {
      const left = Math.ceil((retryAfter - now) / 1000);
      return { compact: false, why: `上次压缩失败，冷却中（还剩 ${left}s）` };
    }
    return { compact: true, why: `${percent.toFixed(0)}% ≥ ${threshold}%` };
  }

  /**
   * 主动压缩：上下文到 config.compactAtPercent 就先收成摘要。
   *
   * 为什么要自己做，不交给 pi 的自动压缩：
   *   pi 的触发线是 contextWindow - reserveTokens（1M 窗口 / 16k reserve ≈ 98.4%），
   *   压完只剩 1.6% 余量 —— 随便读一份数据又满了，群聊长任务就进入
   *   「99% → 压缩 → 读一下 → 100% → 再压缩」的死循环。
   *   这里提前到 80% 触发，压完通常只剩 5% 左右，能撑很多轮。
   *
   * 失败不再"记一行日志就放行"：
   *   放行的后果是这一轮带着 85%+ 的上下文继续跑，很快撞到 pi 的 98% 线，
   *   在那里再压一次 —— 用户经历**两段**卡顿，而且第二段他完全不知道为什么。
   *   现在按指数退避重试（复用 retry-policy 的 transientBackoffMs），
   *   退避期间放行本轮（不无限拖住用户），但把失败记在条目上，
   *   下次进来先等冷却结束再压。
   *
   * @returns {Promise<{compacted:boolean, failed:boolean, attempts:number, why:string}>}
   */
  async #compactIfNeeded(entry, bot, roomId = null, { signal = null, deadline = 0 } = {}) {
    const session = entry?.session;
    if (!session) return { compacted: false, failed: false, attempts: 0, why: '没有会话' };

    const usage = session.getContextUsage?.();
    // 下限 0.2 而不是 0.5：默认值已经调到 0.4（见 config.compactAtPercent），
    // 夹在 0.5 会把配置悄悄改成一半 —— 用户以为改了，实际没生效。
    const threshold = Math.min(0.95, Math.max(0.2, config.compactAtPercent || 0.4)) * 100;
    const plan = PiRunner.planCompaction({
      percent: typeof usage?.percent === 'number' ? usage.percent : null,
      threshold,
      retryAfter: entry.compactRetryAfter ?? 0,
      compacting: Boolean(session.isCompacting),
      autoCompact: config.autoCompact,
    });
    if (!plan.compact) {
      // 冷却中不是错误：用户不需要知道，但排查时值得留一条
      if (entry.compactRetryAfter > Date.now()) {
        log(`【${bot.name}】跳过主动压缩：${plan.why}`);
      }
      return { compacted: false, failed: false, attempts: 0, why: plan.why };
    }

    // 压缩共用后台配额；排队同时受用户取消与本轮剩余时间约束。
    const remaining = deadline ? Math.max(1, deadline - Date.now()) : 0;
    const configuredWait = config.backgroundSlotWaitMs;
    const waitMs = remaining && configuredWait > 0 ? Math.min(remaining, configuredWait) : remaining || configuredWait;
    const bgTicket = await this.#acquireBackgroundSlot({
      name: `压缩 · ${bot.name}`, signal, timeoutMs: waitMs,
    });
    if (signal?.aborted) {
      bgTicket?.release?.();
      throw signal.reason ?? Object.assign(new Error('已终止'), { name: 'AbortError' });
    }
    if (deadline && Date.now() >= deadline) {
      bgTicket?.release?.();
      throw new Error('等待上下文整理超时');
    }
    if (bgTicket && !bgTicket.ok) {
      log(`【${bot.name}】压缩没拿到后台槽位（${bgTicket.reason}），本轮先不压`);
      return { compacted: false, failed: false, attempts: 0, why: '后台槽位不可用' };
    }

    entry.compactingOnly = true;
    // 压缩可能跑好几分钟：续心跳 + 5 分钟硬上限（否则这个 bot 永远轮不到）
    const beat = setInterval(() => {
      entry.progressAt = Date.now();
    }, 15_000);

    let attempts = 0;
    let lastError = null;
    try {
      for (let i = 0; i < COMPACT_MAX_ATTEMPTS; i++) {
        if (signal?.aborted || roomId && this.aborting.has(roomId)) {
          return { compacted: false, failed: false, attempts, why: '用户已终止' };
        }
        attempts = i + 1;
        entry.startedAt = entry.startedAt ?? Date.now();
        entry.progressAt = Date.now();
        let compactTimer;
        try {
          const limitMs = deadline ? Math.max(1, Math.min(5 * 60 * 1000, deadline - Date.now())) : 5 * 60 * 1000;
          await Promise.race([
            session.compact(PiRunner.COMPACT_PROMPT),
            new Promise((_, reject) => {
              compactTimer = setTimeout(() => reject(new Error('上下文压缩超时')), limitMs);
            }),
          ]);
          entry.compactRetryAfter = 0;
          entry.progressAt = Date.now();
          // ★ 主动压缩和 pi 自己压一样，会把老消息收成摘要 ——
          //   已经注入过的技能正文随之消失，下一轮必须重新给。
          //   这条路径不走 compaction_end 事件，所以在这里单独清一次。
          entry.compactedSinceInjection = true;
          entry.skillsInjected = null;
          return { compacted: true, failed: false, attempts, why: plan.why };
        } catch (err) {
          lastError = err;
          const msg = String(err?.message || err);
          // 超时属于"这一轮别再试了"：再来一次大概率还是 5 分钟
          if (/压缩超时/.test(msg)) break;
          // 鉴权/配置错、用户终止：重试没有意义
          if (!isRecoverableFailure({ error: msg })) break;
          if (i === COMPACT_MAX_ATTEMPTS - 1) break;
          const wait = transientBackoffMs(attempts);
          const sec = Math.round(wait / 1000);
          log(`【${bot.name}】主动压缩失败（第 ${attempts}/${COMPACT_MAX_ATTEMPTS} 次），${sec}s 后重试：${msg}`);
          // 退避期间也要续心跳，否则 watchdog 以为卡死
          await sleep(Math.min(wait, deadline ? Math.max(0, deadline - Date.now()) : wait));
        } finally {
          clearTimeout(compactTimer);
        }
      }
    } finally {
      clearInterval(beat);
      entry.compactingOnly = false;
      try {
        await session.abort?.();
      } catch {
        // 中断压缩失败不影响本轮继续。
      } finally {
        bgTicket?.release?.();
      }
    }

    // 走到这里说明放弃了：记冷却，避免下一轮立刻又撞同一堵墙
    entry.compactRetryAfter = Date.now() + COMPACT_COOLDOWN_MS;
    const msg = String(lastError?.message || lastError || '未知原因');
    log(
      `【${bot.name}】主动压缩放弃（试了 ${attempts} 次），` +
        `${Math.round(COMPACT_COOLDOWN_MS / 1000)}s 内不再重试；本轮继续跑：${msg}`,
    );
    // 压缩失败仍要告诉用户：否则他看到的是"上下文一直 90%+"，
    // 却不知道系统试过并且暂时放弃了
    if (roomId) bus.emit('event', {
      t: 'bot.compactFailed',
      roomId,
      botId: bot.id,
      attempts,
      error: modelFailure(msg).error,
    });
    return { compacted: false, failed: true, attempts, why: msg };
  }


  // ---------------------------------------------------------------- 核心：跑一轮

  /**
   * @returns {Promise<{ok:boolean, text:string, ms:number, error?:string, messageId:string}>}
   */

  /**
   * 报告 scope：一次真实执行对应一份。
   *
   * ## 为什么封装
   *
   * 收集器原来是「登记 → 各出口清理」，于是 SESSION_BUSY、建会话失败这类
   * 早退就漏了清理，后面的普通聊天还能往已结束的执行里报报告。
   *
   * ## 三种状态必须分清
   *
   *   · **未获得执行占用**（早退、busy）：不创建 scope，也不碰别人的；
   *   · **持有 scope**：只有它自己能提交报告；
   *   · **已释放**：提交一律拒绝。
   *
   * 同一个「房间:Bot」同时只允许一份活跃 scope —— 后到的调用不会覆盖
   * 前者，前者也不会被后者摘掉。
   */
  #reportScopes = new Map();

  /**
   * 激活报告 scope。
   *
   * 只能在**已经取得会话执行权**之后调用 —— busy、建会话失败这类早退从未
   * 获得执行权，不该拥有报告身份。否则没执行的调用会替别的执行发布报告。
   *
   * @param {string} key '房间:Bot'
   * @param {object|null} collector
   * @returns {boolean} 是否由本次调用激活（未激活=别人已占着，本次不拥有）
   */
  #activateReportScope(key, collector) {
    if (!collector) return false;
    // ★ 键被占说明上一轮的报告收集器没被释放（异常/早退漏清理）。
    //
    //   原来这里静默返回 false，而调用方不检查返回值 —— 于是这一轮的
    //   task_report 会写进那个已经没人读的旧收集器，模型收到「报告已记录」，
    //   账本里却是空的。用户看到任务在跑，实际交付全丢了。
    //
    //   这里直接把旧收集器替换掉（它属于上一轮、已经失效），
    //   并留下明确记录，让泄漏可被看见而不是被掩埋。
    const stale = this.#reportScopes.get(key);
    if (stale) {
      log('报告收集器键被占用，替换掉上一轮残留：', key);
      this.#reportScopes.delete(key);
    }
    this.#reportScopes.set(key, collector);
    return true;
  }

  /**
   * 释放报告 scope。
   *
   * 只摘自己那份：已有的别人 scope 不受影响。
   */
  #releaseReportScope(key, collector) {
    if (!collector) return;
    if (this.#reportScopes.get(key) === collector) {
      this.#reportScopes.delete(key);
    }
  }

  /**
   * 从宿主盘点可交接的部门候选。
   *
   * ★ 只导出**真实存在、有可用负责人、且当前 Bot 有权派活**的群；
   *   候选来自 Store，不由模型自报，也不读解析器没给的字段。
   */
  #candidateDepartmentIds(roomId, botId) {
    const current = store.getRoom(roomId);
    const departmentId = current?.departmentId ?? null;
    const ids = [];
    for (const room of store.listRooms?.() ?? []) {
      if (room.kind !== 'group') continue;
      // 不能把当前正在跑的群当成候选交给自己
      if (room.id === roomId) continue;
      if (departmentId && room.departmentId === departmentId) continue;
      const lead = room.leadBotId ? store.getBot(room.leadBotId) : null;
      if (!lead) continue;
      ids.push(room.id);
    }
    return ids.slice(0, 50);
  }

  /**
   * 当前受管执行的上下文（供接单工具取真实的 taskRunId / attemptId）。
   *
   * ★ 身份必须来自宿主，不能从模型输出读 —— 模型不该能指定自己"替哪个任务"办事。
   *   只在受管执行期间有值；普通聊天返回 null，接单工具据此拒绝建组。
   */
  currentTaskContext(roomId, botId) {
    const entry = this.sessions.get(this.#key(roomId, botId));
    return entry?.managedContext ?? null;
  }

  /**
   * 策略钩子报告的真实阻塞：记到**当前活跃**的受管执行上。
   *
   * ★ 这是「这次执行确实被某条审批挡住过」的唯一权威来源。
   *   审批表里有记录、room/Bot 相符，都不能证明这一点 ——
   *   同房间同 Bot 的另一个 TaskRun 完全可以引用一条与它无关的审批。
   */
  notePolicyBlocked(roomId, botId, approval, info = {}) {
    const collector = this.#reportScopes.get(roomId + ':' + botId);
    if (!collector) return;
    collector.noteBlocked?.(approval, info);
  }

  /**
   * 报告工具 execute 的落点 —— 唯一被验证的收集入口。
   *
   * ## 为什么要在这里核等待归属
   *
   * 模型说「我在等 ap_xyz」只是声明，不能证明这次操作真被那个审批挡住。
   * 直接把字符串写成等待门槛，会产生两种假事实：
   *
   *   · 门槛指向一个根本不存在的审批；
   *   · 拿着别的房间/别的 Bot 的真实审批 ID，让当前任务替别人等。
   *
   * 所以审批类等待必须核：它真实存在、状态是 pending、且属于当前房间与 Bot。
   * 核不出来就拒绝整条报告，并且不覆盖已有的有效报告。
   */
  collectReport(roomId, botId, input) {
    const collector = this.#reportScopes.get(roomId + ':' + botId);
    if (!collector) {
      return { ok: false, why: '这次执行没有报告通道（不是受管轮次，或已经结束）' };
    }

    const verdict = this.#verifyReportWait(roomId, botId, input);
    if (!verdict.ok) {
      // 拒绝时不 accept —— 已有报告保持不变
      return verdict;
    }
    return collector.accept(input);
  }

  /**
   * 核对一条报告里的等待对象是否真实、且属于这次执行。
   *
   * @returns {{ok:true}|{ok:false, why:string}}
   */
  #verifyReportWait(roomId, botId, input) {
    const phase = String(input?.phase ?? input?.kind ?? '').trim();
    if (!phase.startsWith('need_') && phase !== 'waiting_dependency') return { ok: true };

    const waitFor = input?.waitFor;
    if (!waitFor || typeof waitFor !== 'object') {
      return { ok: false, why: phase + ' 必须说明在等什么（缺 waitFor）' };
    }

    // ---- 审批：必须真实存在、仍 pending、且属于本房间与本 Bot
    if (phase === 'need_approval') {
      const id = String(waitFor.approvalId ?? waitFor.ref ?? '').trim();
      if (!id) return { ok: false, why: 'need_approval 缺少 approvalId' };

      const approval = (store.state.approvals ?? []).find((a) => a.id === id);
      if (!approval) {
        return { ok: false, why: '找不到审批 ' + id + ' —— 不能凭空生成等待' };
      }
      if (approval.status !== 'pending') {
        return { ok: false, why: '审批 ' + id + ' 当前是 ' + approval.status + '，不是待批准' };
      }
      if (approval.roomId !== roomId) {
        return { ok: false, why: '审批 ' + id + ' 属于别的房间 —— 不能让当前任务替它等' };
      }
      if (approval.botId !== null && approval.botId !== undefined && approval.botId !== botId) {
        return { ok: false, why: '审批 ' + id + ' 属于别的 Bot' };
      }

      // ★ 房间/Bot 相符还不够：必须证明**这次执行**真的被它挡住过。
      //   否则同房间同 Bot 的另一个 TaskRun 可以借用一条与它无关的审批。
      const collector = this.#reportScopes.get(roomId + ':' + botId);
      if (!collector?.sawBlocked?.(id)) {
        return {
          ok: false,
          why: '审批 ' + id + ' 不是这次执行实际遇到的操作阻塞 —— 不能借来当等待',
        };
      }
      return { ok: true };
    }

    // ---- 输入：由运行时生成并绑定，不接受模型自造字符串
    if (phase === 'need_input') {
      const key = String(waitFor.inputKey ?? waitFor.ref ?? '').trim();
      if (!key) return { ok: false, why: 'need_input 缺少 inputKey' };
      return { ok: true };
    }

    // ---- 依赖：必须是真实存在的任务
    if (phase === 'waiting_dependency') {
      const depId = String(waitFor.dependencyTaskId ?? waitFor.ref ?? '').trim();
      if (!depId) return { ok: false, why: 'waiting_dependency 缺少 dependencyTaskId' };
      const loaded = store.taskRuns.read(depId);
      if (loaded.status !== 'found' || !loaded.taskRun) {
        return { ok: false, why: '找不到依赖任务 ' + depId + ' —— 不能凭空生成等待' };
      }
      return { ok: true };
    }

    return { ok: true };
  }

  // ---------------------------------------------------------------- 核心：跑一轮

  /**
   * @returns {Promise<{ok:boolean, text:string, ms:number, error?:string, messageId:string}>}
   */

  // ---------------------------------------------------------------- 核心：跑一轮

  /**
   * @returns {Promise<{ok:boolean, text:string, ms:number, error?:string, messageId:string}>}
   */

  async run(roomId, botId, prompt, options = {}) {
    this.flushProviderUpdates();
    // ★ 走 scope 包装：只有真正获得执行占用的受管调用会拿到报告通道。
    return this.providerUpdates.withLease((lease) =>
      this.#runInScope(roomId, botId, prompt, { ...options, lease }),
    );
  }

  /**
   * 在**报告 scope 内**执行一次 run。
   *
   * ★ 只有通过受管上下文校验、真正获得执行占用的调用才会创建 scope；
   *   早退（busy / 建会话失败 / 非法上下文）根本不会走到这里，
   *   所以既不会创建 scope，也不会碰到别人的。
   */
  async #runInScope(roomId, botId, prompt, options = {}) {
    const managed = resolveManagedContext(options.managedContext, {
      loadTaskRun: (id) => store.taskRuns.read(id),
      loadRootTaskRun: (id) => store.taskRuns.read(id),
      actualBotId: botId,
    });
    // ★ 这里只**准备**收集器，不激活 scope。
    //   上下文合法只说明「这份授权可以用于这次调用」，
    //   并不说明「这次调用真的拿到了会话执行权」。
    //   提前激活会让没执行的调用替别的执行发布报告身份。
    const collector = managed.kind === MANAGED.managed ? createReportCollector() : null;
    return this.#runWithLease(roomId, botId, prompt, { ...options, reportCollector: collector });
  }

  async #runWithLease(
    roomId,
    botId,
    prompt,
    {
      timeoutMs = config.runTimeoutMs,
      meta = null,
      skipUserMessage = false,
      attachments = [],
      groupTurn = false,
      retryManaged = false,
      taskRunId = newId('run_'),
      attemptIndex = 1,
      lease = null,
      /**
       * 这一轮是**人**发起的（用户直接说话 / 打断）还是一次常规派活。
       * 人发起的可以使用保底槽位，永远不被机器挤掉。
       */
      human = false,
      /**
       * 受管执行上下文（批次 03）：`{ taskRunId, revision, attemptId, botId }`。
       *
       * ★ 只有经 `resolveManagedContext` 校验通过的才放这里；
       *   旧的部门任务 / 手工任务板 / 无任务调用一律传 null。
       *   `taskRunId` 那个参数是统计关联 ID，**不是**持久任务，两者不能混。
       */
      managedContext = null,
      /** 报告收集器（由 #runInScope 提供；早退路径没有）。 */
      reportCollector = null,
    } = {},
  ) {
    const started = Date.now();

    // ★ 记录本轮开始时的待批准集合，跑完据此判断「这一轮是不是停在等审批」。
    //   真实创建了 pending 审批时，这一轮不是「正常说完」，而是 waiting。
    const approvalsAtStart = new Set(
      (store.state.approvals ?? []).filter((a) => a.status === 'pending').map((a) => a.id),
    );

    // ★ 受管上下文三态：未提供（旧调用）/ 核对通过（受管）/ 提供但非法（拒绝）。
    //
    //   核对用**真实存储记录**，不用命名约定也不信自报布尔。
    //   执行者必须就是这次要跑的 botId —— 否则会出现「实际跑 A、事件署名 B」。
    const managed = resolveManagedContext(managedContext, {
      loadTaskRun: (id) => store.taskRuns.read(id),
      // ★ 执行必须花掉一份**已经预留并开始**的额度，所以要读根记录核对授权
      loadRootTaskRun: (id) => store.taskRuns.read(id),
      actualBotId: botId,
    });

    // ★ 显式给了非法上下文：执行前拒绝，不能静默退回旧路径。
    //   静默降级会让调用方以为任务被托管，实际什么都没记下。
    if (managed.kind === MANAGED.invalid) {
      return {
        ok: false,
        text: '',
        ms: 0,
        messageId: '',
        error: `受管执行上下文不合法：${managed.text}`,
        code: 'INVALID_MANAGED_CONTEXT',
        stop: STOP.failed,
      };
    }
    const isManaged = managed.kind === MANAGED.managed;

    // ★ 受管执行才开报告通道：模型通过 task_report 显式声明阶段与完成申请。
    //   非受管调用没有消费者，开了也没意义。
    // ★ 收集器由外层 scope 提供（只有真正获得执行占用的调用才有）。
    const reports = reportCollector ?? null;

    // ★ 收集器不在这里登记 —— scope 只在真正取得执行权后由 #activateReportScope 激活，
    //   这样任何早退分支都不会漏清理。

    /**
     * 把受管执行的结果附注挂到 run 的返回值上。
     *
     * ★ 只**附加**字段，不改旧字段（ok/text/ms/messageId/error/status）。
     *   旧调用方读到的形状与以前完全一致；新调用方多拿到 stop 与 attemptEvent。
     *
     * ★ 这里**不**直接写归约器：验收与状态推进由调用方（受管通路）负责，
     *   `run` 只负责如实报告「这一轮怎么结束的」以及「该发什么事件」。
     */
    /**
     * 本次报告里声明的等待引用。
     *
     * ★ 返回**引用字符串**（approvalId/inputKey/dependencyTaskId），
     *   不是整个 waitFor 对象 —— adaptRunOutcome 要的是可校验的 ID。
     *   直接把对象塞进去会被 String() 成 `[object Object]`。
     */
    const reportWaiting = (kind) => {
      const latest = reports?.latest();
      if (!latest || latest.kind !== kind) return null;
      const field = {
        need_approval: 'approvalId',
        need_input: 'inputKey',
        waiting_dependency: 'dependencyTaskId',
      }[kind];
      const ref = latest.waitFor?.[field];
      return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
    };

    const withAttempt = (payload, facts = {}) => {
      if (!isManaged) return payload;

      // ★ 完整结果适配：用量、产物、阶段、等待都从这里进契约，
      //   不能只传 stop —— 那样任务拿不到后续验收与等待所需的事实。
      const adapted = adaptRunOutcome({
        ok: payload.ok === true,
        cancelled: facts.cancelled === true,
        aborted: facts.aborted === true,
        timedOut: facts.timedOut === true,
        stepCapHit: facts.stepCapHit === true,
        empty: facts.empty === true,
        usage: facts.usage ?? null,
        artifacts: facts.artifacts ?? [],
        // ★ 完成申请来自**结构化报告**，不是正文里出现「完成」两个字
        appliedCompletion: facts.appliedCompletion ?? reports?.appliedCompletion() === true,
        // ★ 等待优先取本次报告里显式声明的门槛，其次才是运行时审批
        needsApproval: facts.needsApproval ?? reportWaiting('need_approval') ?? firstNewApproval(),
        needsInput: facts.needsInput ?? reportWaiting('need_input'),
        waitingDependency: facts.waitingDependency ?? reportWaiting('waiting_dependency'),
        // ★ 报告里的完整声明原样传下去，不能只留布尔再重建（会丢字段）
        report: reports?.latest() ?? null,
      });

      const plan = planAttemptEvent({
        stop: adapted.stop,
        context: managed.context,
        revision: managed.context.revision,
        attemptId: managed.context.attemptId,
        botId: managed.context.botId,
        at: Date.now(),
        usage: adapted.usage,
        artifacts: adapted.artifacts,
        phase: adapted.phase,
        waiting: adapted.waiting,
      });

      return {
        ...payload,
        stop: adapted.stop,
        managed: { context: managed.context },
        ...(plan.emit ? { attemptEvent: plan.event } : {}),
        ...(plan.emit ? {} : { attemptEventSkipped: plan.reason }),
        ...(plan.waiting ? { waiting: plan.waiting } : {}),
      };
    };
    /**
     * 本次执行真实产生、且**属于这个房间与 Bot** 的待批准审批 ID（没有则 null）。
     *
     * ★ 只看「运行期间新增了什么」会把别的房间的审批串到当前任务上。
     *   归属必须由 room + bot 共同确定。
     */
    const firstNewApproval = () => {
      const pending = (store.state.approvals ?? []).filter(
        (a) =>
          a.status === 'pending' &&
          !approvalsAtStart.has(a.id) &&
          a.roomId === roomId &&
          (a.botId === null || a.botId === undefined || a.botId === botId),
      );
      return pending.length ? pending[0].id : null;
    };

    /**
     * 把已收集的附件转成契约里的产物引用。
     *
     * ★ 用附件的**唯一 ID** 而不是展示名 —— 两个不同文件可以同名，
     *   拿 name 承担身份会互相覆盖。ID 是登记引用，能唯一定位。
     *   字符串（已经是引用）原样保留。
     */
    const artifactPathsOf = (list) =>
      (Array.isArray(list) ? list : [])
        .map((a) => {
          if (typeof a === 'string') return a;
          // 附件元数据优先取 id；没有 id 才退回可解析的引用字段
          return a?.id ?? a?.rel ?? a?.path ?? a?.ref ?? '';
        })
        .filter((a) => typeof a === 'string' && a.trim())
        .slice(0, 200);

    const capMs = store.groupLimits().turnMaxMs;
    const effectiveTimeout = groupTurn ? Math.min(timeoutMs || capMs, capMs) : timeoutMs;
    const deadline = effectiveTimeout > 0 ? started + effectiveTimeout : 0;
    // ★ 本轮是否因**运行超时**被中断。与用户取消是两回事：
    //   超时是运行失败/可重试事实，取消是用户意图。
    let timedOut = false;
    const room = store.getRoom(roomId);
    if (!room) {
      // ★ 有效受管尝试也要如实报告停止原因，否则调用方拿不到任何结论
      return withAttempt({
        ok: false, text: '', ms: 0, error: '会话不存在', messageId: '',
        code: 'ROOM_MISSING',
      }, { cancelled: false });
    }
    if (this.aborting.has(roomId)) {
      return withAttempt({
        ok: false, text: '', ms: 0, error: '已终止', messageId: '',
        code: 'ALREADY_CANCELLED',
      }, { cancelled: true });
    }
    if (this.providerUpdates.has(this.providerForBot(botId))) {
      const error = '模型组正在处理配置切换，本次任务未执行。请稍后重试，或检查模型组配置。';
      const msg = store.appendMessage({
        roomId, authorType: 'bot', authorId: botId,
        authorName: store.getBot(botId)?.name ?? botId,
        text: '', status: 'error', error,
      });
      return withAttempt({
        ok: false, text: '', ms: 0, error, messageId: msg.id,
        code: 'PROVIDER_UPDATES_PENDING',
      }, {});
    }

    let entry;
    // 已收集的真实产物附件。放在 try 外层，catch 分支也要能报告它。
    let collectedArtifacts = [];
    try {
      entry = await this.#ensureSession(roomId, botId);
    } catch (err) {
      if (err?.code === 'SESSION_BUSY') {
        return withAttempt({
          ok: false, code: 'SESSION_BUSY', text: '', ms: 0, error: '会话正在忙', messageId: '',
        }, {});
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
      return withAttempt({
        ok: false, text: '', ms: Date.now() - started, error: message, messageId: '',
        code: 'SESSION_BUILD_FAILED',
      }, {});
    }

    // ★ 已成功取得会话执行权 —— 现在才激活报告 scope。
    //   放在这里而不是函数入口，是因为 busy / 建会话失败都会在上面的 catch 返回，
    //   它们从未获得执行权，也就不该拥有报告身份。
    const scopeKey = roomId + ':' + botId;
    const scopeReady = this.#activateReportScope(scopeKey, reports);
    if (!scopeReady) {
      // 拿不到报告通道就别装作有：这一轮的 task_report 必须明确失败，
      // 而不是写进一个没人读的收集器还回「已记录」。
      log('报告通道未能激活，本轮不接受阶段报告：', scopeKey);
    }
    // DM/group 共用同一个实际执行租约的取消句柄：只在真正取得执行权后登记
    const managedCancelTask = managed.kind === 'managed' ? (managed.context?.taskRunId ?? null) : null;
    if (managedCancelTask) {
      this.managedInflight.set(managedCancelTask, {
        key: this.#key(roomId, botId), botId, roomId,
        session: entry?.session ?? null, attemptId: managed.context?.attemptId ?? null,
      });
    }

    // ★ 把真实的执行上下文挂到会话上，供接单工具读取。
    //   与 scope 同一时机：只有真正拿到执行权的调用才对外提供身份。
    //   这里复用上面已经核对通过的 managed，不重复解析。
    if (managed.kind === MANAGED.managed) {
      // resolveManagedContext 把核对结果放在 context 里，不是顶层字段。
      const ctx = managed.context;
      entry.managedContext = {
        taskRunId: ctx.taskRunId,
        attemptId: ctx.attemptId,
        revision: ctx.revision,
        rootTaskId: ctx.rootTaskId,
        botId: ctx.botId,
        // 候选部门由宿主盘点，不接受模型自报
        candidateDepartmentIds: this.#candidateDepartmentIds(roomId, botId),
      };
    }

    const fallbackModel = this.model;
    const providerScope = providerLeaseScope(entry.session.model, fallbackModel);
    const turnController = new AbortController();
    entry.turnController = turnController;
    const cancelled = () => this.aborting.has(roomId) || turnController.signal.aborted;
    const checkCancelled = () => {
      if (cancelled()) throw turnController.signal.reason ?? Object.assign(new Error('已终止'), { name: 'AbortError' });
    };

    entry.lastUsed = Date.now();
    const bot = entry.bot;
    // ★ 心跳：这一轮从什么时候开始、最后一次动静是什么时候、
    //   以及它正在写的是哪条消息（卡死时要拿这个收尾）。
    entry.startedAt = Date.now();
    entry.progressAt = entry.startedAt;
    entry.stallNotified = false;
    const beat = () => {
      entry.progressAt = Date.now();
    };
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
    const meter = new RunUsage();
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
          // ★ 压缩会把这轮之前的消息收成摘要 —— 已经注入过的技能正文
          //   也随之被收走了。下一轮必须重新给，否则模型"忘了"怎么做。
          //   这是"技能只给一次"唯一必须撤回的场景。
          entry.compactedSinceInjection = true;
          entry.skillsInjected = null;
          // ★ 压缩这件事必须**出现在对话里**，不能只藏在状态里。
          //   否则用户看到的是"bot 刚才那几轮说的话不见了"，完全不知道发生了什么。
          //   留一条 kind='compact' 的记录，App 把它画成对话中间的一条小横条。
          const res = event.result;
          if (res && !event.aborted && !event.errorMessage) {
            const saved = res.tokensBefore
              ? Math.max(0, res.tokensBefore - (res.estimatedTokensAfter ?? 0))
              : null;
            store.appendMessage(
              {
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
              },
              // ★ 插在当前这条正在写的回复**之前**。
              //   普通追加会落在 botMsg 后面，界面就成了"结论还没写完、
              //   压缩条先出来了"；刷新重载后顺序又变回正确 —— 前后不一致。
              { beforeStreaming: true },
            );
          }
          break;
        }
        case 'message_start':
          if (event.message?.role === 'assistant') {
            buffer = '';
            turns++;
            // ★ 部门内的"步数"上限按**对话轮次**算，不按工具调用次数算。
            //
            //   步数是对话次数，不是工具调用次数 —— 按工具调用算，
            //   很多模型活都干不完。
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
        case 'auto_retry_start':
          meter.retry();
          break;
        case 'message_end':
          if (event.message?.role === 'assistant') {
            meter.add(event.message.usage);
            usage = meter.snapshot();
            const failure = assistantFailure(event.message);
            if (failure) {
              responseFailure = failure;
              buffer = '';
              pushDelta.flush();
              break;
            }
            responseFailure = null;
            const finalText = textOf(event.message) || buffer;
            if (finalText.trim()) committed.push(finalText.trim());
            buffer = '';
            pushDelta.flush();
          }
          break;
        case 'tool_execution_start': {
          // ★ 报告只能经**工具 execute** 提交（那里有归属与真实性校验）。
          //   这里只记展示用的步骤，不能抢先 accept —— 否则那条校验被旁路，
          //   一条手工事件就能把未经核实的声明写进结果。
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

    let beforeFiles = null;
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
      // 建好消息与事件订阅后整理上下文，等待与异常均进入本轮清理路径。
      checkCancelled();
      await this.#compactIfNeeded(entry, bot, roomId, { signal: turnController.signal, deadline });
      checkCancelled();
      lease?.restrictTo(providerScope);

      // 压缩结束，这一轮马上要真正产出内容了。
      // 之后它就是"在为用户干活"，插话语义恢复原样（该打断就打断）。
      entry.compactingOnly = false;

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
      beforeFiles = watchChanges ? snapshotWorkspace(config.workspace) : null;
      checkCancelled();
      // 槽位：超时就如实回报并在群里留痕，不静默干等
      const remainingMs = deadline ? Math.max(1, deadline - Date.now()) : 0;
      const slotWaitMs = remainingMs && config.runSlotWaitMs > 0
        ? Math.min(remainingMs, config.runSlotWaitMs) : remainingMs || config.runSlotWaitMs;
      const slotTicket = await this.#acquireRunSlot({
        roomId, botId, human, signal: turnController.signal, timeoutMs: slotWaitMs,
      });
      entry.slotTicket = slotTicket;
      if (slotTicket && !slotTicket.ok) {
        checkCancelled();
        throw new Error('运行槽位排队超时');
      }
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
          // 用「本轮 prompt + 用户消息原文」一起匹配：prompt 含大量模板文字，
          // 纯靠它会稀释信号，所以两段都喂进去。
          const task = text + "\n" + String(meta?.text ?? "");
          const picked = selectSkillsFor(library, task, { max: 5 });
          // ★ 已经在这个会话里给过的，不再重复给。
          //
          //   实测：7 轮的群聊里同一份技能正文被存了 7 份，
          //   占该 bot 上下文的 89%。它既是上下文膨胀的主因，
          //   也是缓存失效的主因 —— 每轮前缀都不一样，服务端缓存全废。
          //
          //   技能正文进过历史就一直在上下文里，再给一遍不会让它"更记得"。
          //   只有两种情况要重给：技能被改过（指纹变了）、或压缩把老消息收走了。
          const already = entry.skillsInjected ?? null;
          const { skills: fresh } = skillsToInject(picked, {
            alreadyGiven: already,
            afterCompaction: Boolean(entry.compactedSinceInjection),
          });
          entry.compactedSinceInjection = false;
          if (!fresh.length) return text;
          const lines = skillsPromptLines(fresh);
          if (!lines.length) return text;
          // 记下这次给了哪些 —— 下一轮同样的就不再重复
          if (!entry.skillsInjected) entry.skillsInjected = new Set();
          for (const s of fresh) entry.skillsInjected.add(skillFingerprint(s));
          return lines.join("\n") + "\n\n" + text;
        } catch (err) {
          // 技能挑不出来不能影响正常干活
          log("技能库匹配失败：", err?.message || err);
          return text;
        }
      };

      // ★ 经验注入：只给主控，且只给 active、最多 3 条、总共 600 字。
      //   为什么不给成员：派活质量决定后面所有轮次；成员层每轮都注入一份，
      //   既稀释信号又撑大上下文。
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
      if (deadline && Date.now() >= deadline) throw new Error('本轮等待超时，尚未发起模型请求');
      const runPromise = this.providerUpdates.withLease(startTurn, providerScope);
      if (effectiveTimeout > 0) {
        const timeout = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            turnController.abort(new Error('模型请求超时'));
            entry.session.abort().catch(() => {});
            reject(new Error(`超过 ${Math.round(effectiveTimeout / 1000)}s 未完成，已中断`));
          }, Math.max(1, deadline - Date.now()));
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
          models: fallbackModels(entry.session.model, fallbackModel),
          complete: async (model, signal) => {
            try {
              const reply = await this.modelRuntime.completeSimple(
                model,
                {
                  systemPrompt: `${bot.persona ?? ''}\n\n你是「${bot.name}」。直接给结论，不要客套。`,
                  messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
                },
                { maxTokens: Math.min(2048, model.maxTokens ?? 2048), signal },
              );
              meter.add(reply?.usage);
              usage = meter.snapshot();
              return reply;
            } catch (error) {
              meter.add(error?.usage);
              usage = meter.snapshot();
              throw error;
            }
          },
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

      // ★ 到这一步 produced 才包含完整交付物（图片 + 表格/文档等），
      //   同步给外层，供受管事件报告真实产物。
      collectedArtifacts = produced;

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
        this.#recordRun({ roomId, botId, startedAt: started, ok: false, usage: meter.snapshot(),
          taskRunId, attemptIndex, sdkRetries: meter.retries, kind: 'empty' });
        return withAttempt({
          ok: false,
          text: '',
          ms: Date.now() - started,
          error: msg.error,
          messageId: botMsg.id,
        }, { empty: true, usage: usage ?? null });
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
      this.#recordRun({
        roomId, botId, startedAt: started, ok: true, usage: meter.snapshot(),
        taskRunId, attemptIndex, sdkRetries: meter.retries,
      });
      return withAttempt({
        ok: true,
        text: finalText,
        ms: Date.now() - started,
        messageId: botMsg.id,
        // ★ 批次 03：把「怎么结束的」与 ok 分开。
        //   ok:true 只说明这轮说完了，不说明任务完成 ——
        //   步数/轮数到上限被收住时 ok 也是 true，但那是**让出**。
      }, {
        usage: meter.snapshot(),
        artifacts: artifactPathsOf(produced),
        stepCapHit,
        // 本轮新出现了待批准 → 这一轮停在等待，不是完成
        needsApproval: firstNewApproval(),
      });
    } catch (err) {
      const failure = cancelled() ? modelFailure(turnController.signal.reason ?? { name: 'AbortError' })
        : responseFailure ?? modelFailure(err);
      const current = store.getMessage(roomId, botMsg.id);
      const previousError = current?.error;
      const message = failure.aborted && previousError === '已按你的要求终止' ? previousError : failure.error;
      // ★ abort() / 用户插话已经把这条消息标成 aborted 了 —— 这里必须保持。
      //   失败分支无条件写 status='error' 的话，会把"终止"又变回红色错误气泡
      //   （前端只认 status==='aborted' 才不渲染）。
      const keepAborted = cancelled() && current?.status === 'aborted';
      const partial = render().trim();
      // ★ 步数上限是**运行器自己**发起的 abort，不是用户取消。
      //   用 !cancelled() 判断会把这种让出误判成失败。
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
        this.#recordRun({ roomId, botId, startedAt: started, ok: true, usage: meter.snapshot(),
          taskRunId, attemptIndex, sdkRetries: meter.retries, kind: 'step-cap' });
        return withAttempt({
          ok: true,
          text: partial,
          ms: Date.now() - started,
          messageId: botMsg.id,
        }, {
          usage: meter.snapshot(),
          // ★ catch 分支里 produced 不在作用域内（它在 try 内声明），
          //   用外层已同步的 collectedArtifacts，否则步数中止会抛 ReferenceError。
          artifacts: artifactPathsOf(collectedArtifacts),
          stepCapHit: true,
        });
      }
      const changedOnce = changes();
      // ★ 还有希望的失败先不标红。
      //
      //   外层会接着重试；这里如果把 status 写成 error，
      //   用户看到的就是"整条对话被一路标红"，而实际上它正在自愈。
      //   界面应该表达"还在想办法"，而不是"已经失败了"。
      //   真到放弃时才写 error —— 一次红字足够说明问题。
      const recoverable = retryManaged && !keepAborted && !cancelled()
        && isRecoverableFailure({ error: message, status: failure.status ?? null });
      const msg = store.updateMessage(
        roomId,
        botMsg.id,
        {
          text: recoverable
            ? (partial || '接口临时不稳定，正在重试…')
            : partial,
          status: keepAborted
            ? 'aborted'
            : (recoverable ? 'retrying' : 'error'),
          error: recoverable ? null : message,
          steps,
          usage,
          meta: {
            ...(botMsg.meta ?? {}),
            ...(changedOnce ? { changed: changedOnce } : {}),
            ...(recoverable ? { retrying: true } : {}),
            ...(recoverable ? { retryPlaceholder: !partial } : {}),
          },
        },
        { silent: true },
      );
      // 保持 aborted 时发 msg.updated（客户端认得，会把气泡收掉）；
      // 可恢复的失败也走 msg.updated（不标红），只有真出错才发 msg.error。
      bus.emit('event', {
        t: keepAborted || recoverable ? 'msg.updated' : 'msg.error',
        roomId,
        msgId: botMsg.id,
        error: message,
        msg,
      });
      log(`模型本轮出错：${message}`);
      this.#recordRun({
        roomId, botId, startedAt: started, ok: false, usage: meter.snapshot(),
        taskRunId, attemptIndex, sdkRetries: meter.retries, kind: recoverable ? 'retrying' : 'error',
      });
      // ★ 把 status 一起带出去。
      //
      //   message 是给用户看的（"接口详情已隐藏"），里面**不含** HTTP 状态码。
      //   重试策略如果只看 message，就分不出"429 限流"和"任务本身做不成"，
      //   于是把可恢复的临时故障当成永久失败，只试一次就放弃 ——
      //   用户的 key 一不稳，整条链路就卡在报错里跑不完。
      //   带上 status，让 decideRetry 能按真实类型判断。
      return withAttempt({
        ok: false,
        text: partial,
        ms: Date.now() - started,
        error: message,
        status: failure.status ?? null,
        messageId: botMsg.id,
      }, {
        // ★ 超时优先：超时也会 abort，但那是运行失败，不是用户取消。
        cancelled: (cancelled() || keepAborted) && !timedOut,
        aborted: failure.aborted === true && !timedOut,
        timedOut: timedOut || failure.timedOut === true,
        usage: meter.snapshot(),
        // catch 块里 produced 不在作用域内 —— 用可访问的已收集附件
        artifacts: artifactPathsOf(collectedArtifacts),
      });
    } finally {
      // ★ 只摘自己那份：别的执行可能已经在等这个键。
      this.#releaseReportScope(scopeKey, reports);
      if (entry) entry.managedContext = null;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      unsubscribe?.();
      entry.unsubscribe = null;
      entry.busy = false;
      if (managedCancelTask) {
        const current = this.managedInflight.get(managedCancelTask);
        if (!current || current.attemptId === (managed.context?.attemptId ?? null)) {
          this.managedInflight.delete(managedCancelTask);
        }
      }
      setTimeout(() => { void this.#drainRequestQueue(roomId, botId); }, 0);
      entry.turnController = null;
      entry.liveMsgId = null;
      entry.startedAt = null;
      // ★ 槽位必须在 finally 里还 —— 成功、出错、被终止都会走到这里。
      //   漏掉任何一条路径，槽位就永远少一个，最后整个服务端等于停摆。
      entry.slotTicket?.release?.();
      entry.slotTicket = null;
      bus.emit('event', { t: 'typing', roomId, botId: bot.id, active: false });
      // 每轮结束报一次上下文占用 —— 放在 finally 里，成功/出错都会报，
      // 否则出错那轮的数字会一直停在旧值上。
      emitContext(roomId, bot.id, entry.session);
      // ★ 每一轮跑完都问一次“该不该自动总结记忆”（策略在 memory-policy.js）。
      //   放 finally：不管这轮成功还是出错，对话都已经推进了。
      this.maybeAutoSummarize(roomId, bot.id);
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
      openerMessageId: msg.id,
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
    //   只 abort 当前这个 session 的话，用户点终止之后"还要等很久"——
    //   群聊那一轮是个循环（组长→成员→成员…），当前这个被捣掉之后，
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
   * 不重建的话，改名只对"以后新开的会话"生效，正在用的那些还记着旧名字。
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
    // 记忆都没了，摘要也必须作废 —— 否则「记忆」页还显示旧内容
    store.clearMemorySummariesForBot(botId);
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
    // 开新会话 = 清记忆：这个房间的记忆摘要一起作废
    store.clearMemorySummariesForRoom(roomId);
    return removed.length;
  }

  disposeAll() {
    disposeAll(this.sessions);
  }
}
