/**
 * 单 Bot 单轮会话执行循环子模块。
 *
 * 收敛：`run` -> `runInScope` -> `runWithLease` 完整执行主干：
 *   1. 受管上下文校验与报告 scope 生命周期绑定；
 *   2. 获取运行槽位与主动压缩检查；
 *   3. 技能按需增量注入（压缩后自动失效重注）、经验注入、旁路备忘消费；
 *   4. 流式事件订阅（delta / steps / compaction_end）、空回复三层恢复、产物收集与统计落盘。
 */
import { log, newId } from '../util.js';
import { readBrandEnv } from '../brand.js';
import { readForModel, saveFromPath } from '../attachments.js';
import { RunUsage } from '../run-stats.js';
import { providerLeaseScope } from '../provider-updates.js';
import { assistantFailure, fallbackModels, modelFailure, recoverModelReply, withModelHint } from '../model-reply.js';
import { isRecoverableFailure } from '../retry-policy.js';
import { collectNewImages, snapshotImages } from '../image-watch.js';
import { snapshotWorkspace, diffSnapshots, summarizeChanges } from '../change-watch.js';
import { collectArtifacts } from '../artifact-watch.js';
import { selectSkillsFor, skillFingerprint, skillsPromptLines, skillsToInject } from '../skills.js';
import { selectLessonsFor, lessonsPromptLines, resolveModelFamilyForModel } from '../lessons.js';
import { resolveManagedContext, planAttemptEvent, adaptRunOutcome, MANAGED } from '../tasks/task-progress.js';
import { createReportCollector } from '../tasks/task-report.js';
import { STOP } from '../tasks/task-contract.js';
import { emitContext, sessionKey, summarizeArgs, textOf, throttle } from './runner-utils.js';

/** 执行一次 bot 会话回合（带 provider 配置更新租约与受管报告通道作用域） */
export async function executeTurn(runner, roomId, botId, prompt, options = {}) {
  runner.flushProviderUpdates();
  return runner.providerUpdates.withLease((lease) =>
    runInScope(runner, roomId, botId, prompt, { ...options, lease }),
  );
}

async function runInScope(runner, roomId, botId, prompt, options = {}) {
  const managed = resolveManagedContext(options.managedContext, {
    loadTaskRun: (id) => runner.store.taskRuns.read(id),
    loadRootTaskRun: (id) => runner.store.taskRuns.read(id),
    actualBotId: botId,
  });
  const collector = managed.kind === MANAGED.managed ? createReportCollector() : null;
  return runWithLease(runner, roomId, botId, prompt, { ...options, reportCollector: collector });
}

async function runWithLease(
  runner,
  roomId,
  botId,
  prompt,
  {
    timeoutMs = runner.config.runTimeoutMs,
    meta = null,
    skipUserMessage = false,
    attachments = [],
    groupTurn = false,
    retryManaged = false,
    taskRunId = newId('run_'),
    attemptIndex = 1,
    lease = null,
    human = false,
    managedContext = null,
    reportCollector = null,
    summaryTurn = false,
  } = {},
) {
  const started = Date.now();
  // 汇总交卷轮标记：工具层（dispatch_to_department / create_department / accept_task）
  // 靠它硬拦"汇总完又自己派活"的无限套娃。entry 在这里还没装配，后面再写上去。
  const isSummaryTurn = summaryTurn === true;
  // 只有「真的跑完并落出回复」才值得评估注入的经验。
  // 429 / 超时 / 用户终止进的是 catch → finally，那时评估等于拿没跑通的对话给经验打分。
  let turnSucceeded = false;
  const approvalsAtStart = new Set(
    (runner.store.state.approvals ?? []).filter((a) => a.status === 'pending').map((a) => a.id),
  );

  const managed = resolveManagedContext(managedContext, {
    loadTaskRun: (id) => runner.store.taskRuns.read(id),
    loadRootTaskRun: (id) => runner.store.taskRuns.read(id),
    actualBotId: botId,
  });

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
  const reports = reportCollector ?? null;

  const firstNewApproval = () => {
    const pending = (runner.store.state.approvals ?? []).filter(
      (a) =>
        a.status === 'pending' &&
        !approvalsAtStart.has(a.id) &&
        a.roomId === roomId &&
        (a.botId === null || a.botId === undefined || a.botId === botId),
    );
    return pending.length ? pending[0].id : null;
  };

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

  const artifactPathsOf = (list) =>
    (Array.isArray(list) ? list : [])
      .map((a) => (typeof a === 'string' ? a : (a?.id ?? a?.rel ?? a?.path ?? a?.ref ?? '')))
      .filter((a) => typeof a === 'string' && a.trim())
      .slice(0, 200);

  const withAttempt = (payload, facts = {}) => {
    if (!isManaged) return payload;
    const adapted = adaptRunOutcome({
      ok: payload.ok === true,
      cancelled: facts.cancelled === true,
      aborted: facts.aborted === true,
      timedOut: facts.timedOut === true,
      stepCapHit: facts.stepCapHit === true,
      empty: facts.empty === true,
      usage: facts.usage ?? null,
      artifacts: facts.artifacts ?? [],
      appliedCompletion: facts.appliedCompletion ?? reports?.appliedCompletion() === true,
      needsApproval: facts.needsApproval ?? reportWaiting('need_approval') ?? firstNewApproval(),
      needsInput: facts.needsInput ?? reportWaiting('need_input'),
      waitingDependency: facts.waitingDependency ?? reportWaiting('waiting_dependency'),
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

  const capMs = runner.store.groupLimits().turnMaxMs;
  const effectiveTimeout = groupTurn ? Math.min(timeoutMs || capMs, capMs) : timeoutMs;
  const deadline = effectiveTimeout > 0 ? started + effectiveTimeout : 0;
  let timedOut = false;

  const room = runner.store.getRoom(roomId);
  if (!room) {
    return withAttempt({
      ok: false, text: '', ms: 0, error: '会话不存在', messageId: '',
      code: 'ROOM_MISSING',
    }, { cancelled: false });
  }
  if (runner.aborting.has(roomId)) {
    return withAttempt({
      ok: false, text: '', ms: 0, error: '已终止', messageId: '',
      code: 'ALREADY_CANCELLED',
    }, { cancelled: true });
  }
  if (runner.providerUpdates.has(runner.providerForBot(botId))) {
    const error = '模型组正在处理配置切换，本次任务未执行。请稍后重试，或检查模型组配置。';
    const msg = runner.store.appendMessage({
      roomId, authorType: 'bot', authorId: botId,
      authorName: runner.store.getBot(botId)?.name ?? botId,
      text: '', status: 'error', error,
    });
    return withAttempt({
      ok: false, text: '', ms: 0, error, messageId: msg.id,
      code: 'PROVIDER_UPDATES_PENDING',
    }, {});
  }

  let entry;
  let collectedArtifacts = [];
  try {
    entry = await runner.ensureSession(roomId, botId);
  } catch (err) {
    if (err?.code === 'SESSION_BUSY') {
      return withAttempt({
        ok: false, code: 'SESSION_BUSY', text: '', ms: 0, error: '会话正在忙', messageId: '',
      }, {});
    }
    const message = modelFailure(err).error;
    runner.store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: botId,
      authorName: runner.store.getBot(botId)?.name ?? botId,
      text: '',
      status: 'error',
      error: `起不来：${message}`,
    });
    return withAttempt({
      ok: false, text: '', ms: Date.now() - started, error: message, messageId: '',
      code: 'SESSION_BUILD_FAILED',
    }, {});
  }

  const scopeKey = roomId + ':' + botId;
  const scopeReady = runner.activateReportScope(scopeKey, reports);
  if (!scopeReady) {
    log('报告通道未能激活，本轮不接受阶段报告：', scopeKey);
  }
  const managedCancelTask = managed.kind === 'managed' ? (managed.context?.taskRunId ?? null) : null;
  if (managedCancelTask) {
    runner.managedInflight.set(managedCancelTask, {
      key: sessionKey(roomId, botId), botId, roomId,
      session: entry?.session ?? null, attemptId: managed.context?.attemptId ?? null,
    });
  }

  if (managed.kind === MANAGED.managed) {
    const ctx = managed.context;
    entry.managedContext = {
      taskRunId: ctx.taskRunId,
      attemptId: ctx.attemptId,
      revision: ctx.revision,
      rootTaskId: ctx.rootTaskId,
      botId: ctx.botId,
      candidateDepartmentIds: runner.candidateDepartmentIds(roomId, botId),
    };
  }

  const fallbackModel = runner.model;
  const providerScope = providerLeaseScope(entry.session.model, fallbackModel);
  const turnController = new AbortController();
  entry.turnController = turnController;
  const cancelled = () => runner.aborting.has(roomId) || turnController.signal.aborted;
  const checkCancelled = () => {
    if (cancelled()) throw turnController.signal.reason ?? Object.assign(new Error('已终止'), { name: 'AbortError' });
  };

  entry.lastUsed = Date.now();
  entry.summaryTurn = isSummaryTurn;
  const bot = entry.bot;
  entry.startedAt = Date.now();
  entry.progressAt = entry.startedAt;
  entry.stallNotified = false;
  const beat = () => {
    entry.progressAt = Date.now();
  };

  let botMsg;
  try {
    botMsg = runner.store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: bot.id,
      authorName: bot.name,
      authorEmoji: bot.emoji,
      text: '',
      status: 'streaming',
      meta,
    });
  } catch (err) {
    try { runner.releaseReportScope(scopeKey, reports); } catch {}
    try { entry.managedContext = null; } catch {}
    try { entry.busy = false; } catch {}
    try { entry.slotTicket?.release?.(); } catch {}
    try { entry.slotTicket = null; } catch {}
    if (managedCancelTask) {
      try { runner.managedInflight.delete(managedCancelTask); } catch {}
    }
    log('建消息失败，已归还执行权：', roomId, botId, err?.message || err);
    return withAttempt({
      ok: false, code: 'MESSAGE_WRITE_FAILED', text: '', ms: Date.now() - started,
      error: '无法写入消息：' + String(err?.message ?? err).slice(0, 120), messageId: '',
    }, {});
  }
  entry.liveMsgId = botMsg.id;
  entry.goalText = String(prompt ?? '').slice(0, 600);
  beat();
  runner.bus.emit('event', { t: 'typing', roomId, botId: bot.id, active: true, lane: 'work', msgId: botMsg.id });

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
  entry.liveSteps = steps;
  entry.liveDraft = render;
  entry.turnAmends = [];
  /**
   * 插话换条（P0-2 情形 B），**只能在消息轮次边界调用**。
   *
   * 为什么不能放在 delta 里（D1）：`message_update` 是先 `buffer += delta` 再 push，
   * 此时 render() 已经把**新回复的首段**算进去了 —— 在那里换条会把新内容封进旧气泡，
   * 接着清空草稿，新气泡直接缺开头。
   *
   * 所以时机固定在两处：
   * - `message_start`：新 turn 还没吐 delta，render() 里全是旧内容；
   * - `message_end` 之后：旧正文已 committed 进旧气泡，再换条不会污染新气泡。
   *
   * @param {boolean} createNext 收尾兜底时传 false —— 只封口旧气泡，不凭空建一条空的
   */
  const reseatAtBoundary = (createNext = true) => {
    const next = applyPendingReseat({
      store: runner.store,
      roomId,
      entry,
      botMsgId: botMsg.id,
      render,
      steps,
      meta,
      bot,
      bus: runner.bus,
      log,
      createNext,
      resetDraft: () => {
        committed.length = 0;
        buffer = '';
        steps.length = 0;
      },
    });
    if (next) botMsg = next;
  };

  const pushDelta = throttle(() => {
    beat();
    const text = render();
    // ★ 同步落库（静默）：duplex-lane 判「这一轮到底写出正文没有」读的就是
    //   store 里这条消息的 text。只 emit 不落库，那边永远看到空字符串，
    //   于是“已写半截”会被误判成“空占位”，FD-0 直接破。
    runner.store.updateMessage(roomId, botMsg.id, { text }, { silent: true });
    runner.bus.emit('event', { t: 'msg.delta', roomId, msgId: botMsg.id, text });
  }, 80);
  const pushSteps = () => {
    // 工具步骤属于**当前**气泡：换条只发生在消息边界，这里不能动
    beat();
    runner.bus.emit('event', { t: 'msg.steps', roomId, msgId: botMsg.id, steps: [...steps] });
    runner.store.updateMessage(roomId, botMsg.id, { steps: [...steps] }, { silent: true });
  };

  let stepCapHit = false;
  const turnCap = groupTurn ? runner.store.groupLimits().maxSteps : 0;
  let turns = 0;

  const onEvent = (event) => {
    switch (event.type) {
      case 'compaction_start':
        runner.bus.emit('event', {
          t: 'bot.compacting',
          roomId,
          botId: bot.id,
          active: true,
          reason: event.reason,
        });
        log(`[${bot.name}] 上下文压缩开始（${event.reason}）`);
        break;
      case 'compaction_end': {
        runner.bus.emit('event', {
          t: 'bot.compacting',
          roomId,
          botId: bot.id,
          active: false,
          reason: event.reason,
          error: event.errorMessage ? modelFailure(event.errorMessage).error : null,
        });
        log(`[${bot.name}] 上下文压缩结束（${event.reason}）`);
        entry.compactedSinceInjection = true;
        entry.skillsInjected = null;
        const res = event.result;
        if (res && !event.aborted && !event.errorMessage) {
          const saved = res.tokensBefore
            ? Math.max(0, res.tokensBefore - (res.estimatedTokensAfter ?? 0))
            : null;
          runner.store.appendMessage(
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
            { beforeStreaming: true },
          );
        }
        break;
      }
      case 'message_start':
        if (event.message?.role === 'assistant') {
          // ★ 换条的最佳时机（D1）：新 turn 还没吐任何 delta，render() 里全是旧内容。
          //   在这里封口，旧的 steps 一并写进旧气泡，新气泡从空开始。
          reseatAtBoundary(true);
          buffer = '';
          turns++;
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
          // ★ 旧正文已经 committed 进**旧**气泡，此时再换条（D1 第 2 条）：
          //   早一步换会让这条 message_end 把整段旧正文 push 进新气泡，两边内容重复。
          reseatAtBoundary(true);
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
        runner.bus.emit('event', {
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
      const diff = diffSnapshots(beforeFiles, snapshotWorkspace(runner.config.workspace));
      return diff.total ? summarizeChanges(diff) : null;
    } catch {
      return null;
    }
  };

  let timeoutHandle = null;
  try {
    checkCancelled();
    await runner.compactIfNeeded(entry, bot, roomId, { signal: turnController.signal, deadline });
    checkCancelled();
    lease?.restrictTo(providerScope);

    entry.compactingOnly = false;

    const images = [];
    for (const id of attachments) {
      const img = readForModel(id);
      if (img) images.push(img);
    }
    const beforeImages = runner.config.autoAttachImages ? snapshotImages(runner.config.workspace) : null;
    const watchChanges = readBrandEnv(process.env, 'WATCH_CHANGES') !== '0';
    beforeFiles = watchChanges ? snapshotWorkspace(runner.config.workspace) : null;
    checkCancelled();

    const remainingMs = deadline ? Math.max(1, deadline - Date.now()) : 0;
    const slotWaitMs = remainingMs && runner.config.runSlotWaitMs > 0
      ? Math.min(remainingMs, runner.config.runSlotWaitMs) : remainingMs || runner.config.runSlotWaitMs;
    const slotTicket = await runner.acquireRunSlot({
      roomId, botId, human, signal: turnController.signal, timeoutMs: slotWaitMs,
    });
    entry.slotTicket = slotTicket;
    if (slotTicket && !slotTicket.ok) {
      checkCancelled();
      throw new Error('运行槽位排队超时');
    }
    checkCancelled();

    let skillsAddedThisTurn = [];
    const withSkills = (text) => {
      try {
        const library = runner.store.skillLibrary();
        if (!library.length) return text;
        const task = text + '\n' + String(meta?.text ?? '');
        const picked = selectSkillsFor(library, task, { max: 5 });
        const already = entry.skillsInjected ?? null;
        const { skills: fresh } = skillsToInject(picked, {
          alreadyGiven: already,
          afterCompaction: Boolean(entry.compactedSinceInjection),
        });
        entry.compactedSinceInjection = false;
        if (!fresh.length) return text;
        const lines = skillsPromptLines(fresh);
        if (!lines.length) return text;
        if (!entry.skillsInjected) entry.skillsInjected = new Set();
        for (const s of fresh) {
          const fp = skillFingerprint(s);
          if (!entry.skillsInjected.has(fp)) skillsAddedThisTurn.push(fp);
          entry.skillsInjected.add(fp);
        }
        return lines.join('\n') + '\n\n' + text;
      } catch (err) {
        log('技能库匹配失败：', err?.message || err);
        return text;
      }
    };

    const withLessons = (text) => {
      try {
        if (bot?.role !== 'main') return text;
        const library = runner.store.lessonLibrary();
        if (!library.length) return text;
        const task = text + '\n' + String(meta?.text ?? '');
        // SIM-Lite：把「当前模型的族」与「关系边」一起传进去 —— 不传的话，
        // 同族加成与矛盾排除在真实注入里等于没做。
        const modelFamily = resolveModelFamilyForModel(entry.session?.model ?? runner.model);
        const edges = runner.store.lessonEdges?.() ?? [];
        const picked = selectLessonsFor(library, task, { roomId, modelFamily, edges });
        const lines = lessonsPromptLines(picked);
        if (!lines.length) return text;
        try {
          // ★ 只记 `hit`（被注入过一次）。**绝不在这里记 win/fail**：
          //   本轮 ok 只说明模型没报错（答非所问也是 ok）；429/超时/用户终止也不是 fail。
          //   真实胜率只来自复盘评估 / 已验收 TaskRun / 用户反馈。
          runner.store.touchLessons(picked.map((l) => l.id), { modelFamily });
          entry.lessonsInjected = { ids: picked.map((l) => l.id), modelFamily, at: Date.now() };
        } catch {}
        return lines.join('\n') + '\n\n' + text;
      } catch (err) {
        log('经验库匹配失败：', err?.message || err);
        return text;
      }
    };

    const consumedSide = !isManaged && !meta?.opening
      ? runner.consumeSideContext(roomId, botId)
      : { items: [], promptBlock: '' };

    const startTurn = async () => {
      const promptWithSide = consumedSide.promptBlock
        ? `${consumedSide.promptBlock}\n\n${prompt}`
        : prompt;
      const finalPrompt = withLessons(withSkills(promptWithSide));
      try {
        return images.length
          ? await entry.session.prompt(finalPrompt, { images })
          : await entry.session.prompt(finalPrompt);
      } catch (err) {
        const msg = String(err?.message || err);
        if (!/already processing/i.test(msg) || !entry.session.followUp) throw err;
        log(`${bot.name} 那一轮还没完，这条改成排队投递（followUp）`);
        try {
          return images.length
            ? await entry.session.followUp(finalPrompt, images)
            : await entry.session.followUp(finalPrompt);
        } catch (followErr) {
          if (entry.skillsInjected && skillsAddedThisTurn.length) {
            for (const fp of skillsAddedThisTurn) entry.skillsInjected.delete(fp);
          }
          skillsAddedThisTurn = [];
          runner.restoreSideContext(roomId, botId, consumedSide.items);
          throw followErr;
        }
      }
    };
    if (deadline && Date.now() >= deadline) throw new Error('本轮等待超时，尚未发起模型请求');
    const runPromise = runner.providerUpdates.withLease(startTurn, providerScope);
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
            const reply = await runner.modelRuntime.completeSimple(
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
      ? collectNewImages(runner.config.workspace, beforeImages, {
          save: saveFromPath,
          onError: (err) => log('自动附图失败：', err?.message || err),
        })
      : [];

    if (runner.config.autoAttachArtifacts !== false && beforeFiles) {
      try {
        for (const item of collectArtifacts(runner.config.workspace, beforeFiles)) {
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

    collectedArtifacts = produced;

    // ★ 收尾兜底（D1 第 3 条）：走到这里还有 pendingReseat，说明插话之后
    //   这一轮**没有任何新的 assistant 轮**（纯工具 / 直接结束）。此时只能把旧气泡
    //   封口，**不能**再建一条 —— 否则下面把缓存的 finalText 写进新气泡就是复制一份。
    reseatAtBoundary(false);

    if (!finalText && !stepCapHit) {
      const digest = steps.length
        ? `（${bot.name} 执行了 ${steps.length} 步但没有给出说明）\n\n${steps
            .map((s) => `- \`${s.tool}\` ${s.detail ?? ''}`)
            .join('\n')}`
        : '';
      const msg = runner.store.updateMessage(
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
      runner.bus.emit('event', { t: 'msg.error', roomId, msgId: botMsg.id, error: msg.error, msg });
      runner.recordRun({
        roomId, botId, startedAt: started, ok: false, usage: meter.snapshot(),
        taskRunId, attemptIndex, sdkRetries: meter.retries, kind: 'empty',
      });
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
    const msg = runner.store.updateMessage(
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
    runner.bus.emit('event', { t: 'msg.done', msg });
    runner.recordRun({
      roomId, botId, startedAt: started, ok: true, usage: meter.snapshot(),
      taskRunId, attemptIndex, sdkRetries: meter.retries,
    });
    turnSucceeded = true;
    return withAttempt({
      ok: true,
      text: finalText,
      ms: Date.now() - started,
      messageId: botMsg.id,
    }, {
      usage: meter.snapshot(),
      artifacts: artifactPathsOf(produced),
      stepCapHit,
      needsApproval: firstNewApproval(),
    });
  } catch (err) {
    const failure = cancelled() ? modelFailure(turnController.signal.reason ?? { name: 'AbortError' })
      : responseFailure ?? modelFailure(err);
    const current = runner.store.getMessage(roomId, botMsg.id);
    const previousError = current?.error;
    const message = failure.aborted && previousError === '已按你的要求终止'
      ? previousError
      : withModelHint(failure.error, runner.store.getBot(botId)?.model || runner.modelLabel?.() || '');
    const keepAborted = cancelled() && current?.status === 'aborted';
    const partial = render().trim();
    if (stepCapHit) {
      const msg = runner.store.updateMessage(
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
      runner.bus.emit('event', { t: 'msg.done', msg });
      runner.recordRun({
        roomId, botId, startedAt: started, ok: true, usage: meter.snapshot(),
        taskRunId, attemptIndex, sdkRetries: meter.retries, kind: 'step-cap',
      });
      // 轮数到上限也算"跑完了"（真实落出了回复），只是被收住 —— 照样可以评估
      turnSucceeded = true;
      return withAttempt({
        ok: true,
        text: partial,
        ms: Date.now() - started,
        messageId: botMsg.id,
      }, {
        usage: meter.snapshot(),
        artifacts: artifactPathsOf(collectedArtifacts),
        stepCapHit: true,
      });
    }
    const changedOnce = changes();
    const recoverable = retryManaged && !keepAborted && !cancelled()
      && isRecoverableFailure({ error: message, status: failure.status ?? null });
    const msg = runner.store.updateMessage(
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
    runner.bus.emit('event', {
      t: keepAborted || recoverable ? 'msg.updated' : 'msg.error',
      roomId,
      msgId: botMsg.id,
      error: message,
      msg,
    });
    log(`模型本轮出错：${message}`);
    runner.recordRun({
      roomId, botId, startedAt: started, ok: false, usage: meter.snapshot(),
      taskRunId, attemptIndex, sdkRetries: meter.retries, kind: recoverable ? 'retrying' : 'error',
    });
    return withAttempt({
      ok: false,
      text: partial,
      ms: Date.now() - started,
      error: message,
      status: failure.status ?? null,
      messageId: botMsg.id,
    }, {
      cancelled: (cancelled() || keepAborted) && !timedOut,
      aborted: failure.aborted === true && !timedOut,
      timedOut: timedOut || failure.timedOut === true,
      usage: meter.snapshot(),
      artifacts: artifactPathsOf(collectedArtifacts),
    });
  } finally {
    runner.releaseReportScope(scopeKey, reports);
    if (entry) entry.managedContext = null;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    unsubscribe?.();
    entry.unsubscribe = null;
    entry.busy = false;
    if (managedCancelTask) {
      const current = runner.managedInflight.get(managedCancelTask);
      if (!current || current.attemptId === (managed.context?.attemptId ?? null)) {
        runner.managedInflight.delete(managedCancelTask);
      }
    }
    // 汇总轮标记只活在这一轮里：异常退出也不能污染下一轮
    entry.summaryTurn = false;
    // ★ 发起轮封口：这一轮登记出来的批次必须 `dispatchOpen=false` 才能就绪。
    //   部门回得比派活快是常态，不封口就会出现"汇总里漏掉后面那个部门"。
    if (bot?.role === 'main' && !isSummaryTurn) {
      try {
        runner.store.sealChiefSummariesForTurn(`msg:${entry.liveMsgId ?? ''}`, {
          mainBusy: false,
        });
      } catch (err) {
        log('封口主控汇总失败：', err?.message || err);
      }
    }
    setTimeout(() => { void runner.drainRequestQueue(roomId, botId); }, 0);
    // 这一轮结束后，把排队等发送的主控汇总消费掉（汇总轮自己不再触发，防递归）
    if (bot.role === 'main' && !isSummaryTurn) {
      setTimeout(() => { void runner.drainChiefSummaries?.().catch?.(() => {}); }, 0);
    }
    entry.turnController = null;
    entry.liveMsgId = null;
    entry.startedAt = null;
    entry.goalText = '';
    entry.liveSteps = null;
    entry.liveDraft = null;
    entry.turnAmends = null;
    // ★ 必须清（D2）：本轮若挂着 pendingReseat 就超时/报错/被 abort，
    //   标志会残留在持久化的 entry 上，下一轮一吐字就被强行封口挪走。
    entry.pendingReseat = null;
    entry.slotTicket?.release?.();
    entry.slotTicket = null;
    runner.bus.emit('event', { t: 'typing', roomId, botId: bot.id, active: false, lane: 'work', msgId: botMsg?.id ?? null });
    emitContext(roomId, bot.id, entry.session, runner.bus);
    // SIM-Lite：本轮注入过经验才做一次独立评估（win/fail 的唯一合法来源之一）。
    // 先把快照摘走再交给后台：`drainRequestQueue` 会立刻起下一轮，
    // 留在 entry 上会被下一批注入覆盖掉，导致少记/错记。
    if (entry.lessonsInjected) {
      const injected = entry.lessonsInjected;
      entry.lessonsInjected = null;
      // 失败/终止轮只清痕迹、不评估：没有可信的因果，硬评只会制造噪音。
      if (turnSucceeded) {
        void Promise.resolve(
          runner.reflect?.evaluateInjected?.({ roomId, botId: bot.id, injected }),
        ).catch(() => {});
      }
    }
    if (bot.role === 'main') {
      try { runner.store.redactRoomSecrets(roomId, [], { limit: 8 }); } catch {}
    }
    runner.maybeAutoSummarize(roomId, bot.id);
  }
}

/**
 * 把「这一轮的在途气泡」按插话位置重新安置（P0-2 情形 B 的落地实现）。
 *
 * 为什么单独抽出来：它要同时做四件事（封口旧条、清空草稿、新开一条、
 * 把新条挪到插话之后），而它只在**流式过程中**被触发 —— 端到端跑需要真模型。
 * 抽成函数后可以直接单测：给定一条已写正文的 bot 消息 + 一条 user 插话，
 * 断言旧条定稿、新条排在 user 之后、且新条从空开始（内容不重复）。
 *
 * @returns {object|null} 新建的那条消息；没有待换条任务时返回 null
 */
export function applyPendingReseat({
  store, roomId, entry, botMsgId, render, meta = null, bot, bus = null, log: logFn = () => {},
  resetDraft = null,
  /** 这一轮已产生的工具步骤：封口旧气泡时要一起写进去，否则会被清空丢弃（D1 第 3 条） */
  steps = null,
  /** false = 只封口旧气泡，不新建（收尾兜底用，避免复制出第二份内容） */
  createNext = true,
} = {}) {
  const pending = entry?.pendingReseat;
  if (!pending) return null;
  entry.pendingReseat = null;

  const sealed = typeof render === 'function' ? render() : '';
  const oldMsg = store.getMessage(roomId, botMsgId);
  try {
    store.updateMessage(roomId, botMsgId, {
      text: sealed,
      status: 'done',
      // ★ 工具步骤属于这一轮：封口时一并写进去，别让随后的 resetDraft 把它们清丢
      ...(Array.isArray(steps) ? { steps: [...steps] } : {}),
      meta: { ...(oldMsg?.meta ?? {}), reseatAfterId: pending.afterId },
    }, { silent: false });
  } catch (err) {
    logFn('封口旧气泡失败：', err?.message || err);
  }

  if (typeof resetDraft === 'function') resetDraft();

  // 收尾兜底：只封口，不新建 —— 否则调用方接着把同一份 finalText 写进新气泡就是复制
  if (!createNext) return null;

  let next;
  try {
    next = store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: bot?.id ?? null,
      authorName: bot?.name ?? '',
      authorEmoji: bot?.emoji ?? null,
      text: '',
      status: 'streaming',
      meta: { ...(meta ?? {}), continuedFrom: botMsgId },
    });
  } catch (err) {
    logFn('插话后新建气泡失败：', err?.message || err);
    return null;
  }
  store.moveMessageAfter(roomId, next.id, pending.afterId, { touch: true });
  entry.liveMsgId = next.id;
  // ★ 不再手动补发 msg.new：store.appendMessage 内部已经发过一次（D3 第 1 条）。
  //   重复广播会让总线 / SDK 订阅者收到两条同样的新建事件。
  bus?.emit?.('event', { t: 'typing', roomId, botId: bot?.id ?? null, active: true, lane: 'work', msgId: next.id });
  return next;
}
