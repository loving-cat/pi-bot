/**
 * 全双工双轨旁路与消息入口分流子模块。
 *
 * 收敛：
 *   1. 旁路备忘沉淀/消费（`recordSideContext` / `consumeSideContext` / `restoreSideContext`）；
 *   2. 旁路 Talk 单飞会话执行与实时快照构造（`runTalkTurn` / `executeTalkItem` / `collectLiveSnapshot`）；
 *   3. 统一发信分流入口（`sendUserMessage`：私聊全双工三路 / 群聊忙碌旁路问答 / 连发合并 `deliverMerged` / `abortTalkFor` / `abortTalkInRoom`）。
 */
import { log } from '../util.js';
import { shells } from '../shells.js';
import { readForModel } from '../attachments.js';
import { parseMentions } from '../mentions.js';
import { RunUsage } from '../run-stats.js';
import { providerLeaseScope } from '../provider-updates.js';
import { assistantFailure, modelFailure } from '../model-reply.js';
import { deliverDirectInput } from '../direct-message-delivery.js';
import { releaseEntry } from '../session-pool.js';
import { createSessionBuilder } from '../session-factory.js';
import { decide as decidePoint, shouldUseJev } from '../decision-router.js';
import { looksLikeSupplement } from '../duplex-router.js';
import { routeBusyInput, DUPLEX_KIND } from '../duplex-router.js';
import {
  buildLiveWorkSnapshot,
  formatLiveWorkSnapshotPrompt,
  buildGroupWorkSnapshot,
  formatGroupWorkSnapshotPrompt,
} from '../live-work-snapshot.js';
import { hydrate, sessionKey, sleep, textOf, throttle } from './runner-utils.js';

export function recordSideContext(runner, roomId, botId, userText, replyText) {
  const key = sessionKey(roomId, botId);
  const list = runner.pendingSideContext.get(key) ?? [];
  list.push({
    userText: String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
    replyText: String(replyText ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
    ts: Date.now(),
  });
  while (list.length > 6) list.shift();
  let total = list.reduce((n, item) => n + item.userText.length + item.replyText.length, 0);
  while (list.length > 1 && total > 1200) {
    const drop = list.shift();
    total -= drop.userText.length + drop.replyText.length;
  }
  runner.pendingSideContext.set(key, list);
}

export function consumeSideContext(runner, roomId, botId) {
  const key = sessionKey(roomId, botId);
  const items = runner.pendingSideContext.get(key) ?? [];
  runner.pendingSideContext.delete(key);
  if (!items.length) return { items: [], promptBlock: '' };
  const lines = [
    '【此前后台干活期间的旁路沟通备忘】',
    ...items.map((x) => `- 用户问「${x.userText}」→ 你当时回答「${x.replyText}」`),
  ];
  return { items, promptBlock: lines.join('\n') };
}

export function restoreSideContext(runner, roomId, botId, items) {
  if (!Array.isArray(items) || !items.length) return;
  const key = sessionKey(roomId, botId);
  const current = runner.pendingSideContext.get(key) ?? [];
  runner.pendingSideContext.set(key, [...items, ...current].slice(-6));
}

function abortTalkEntry(runner, key, inflight) {
  const split = key.indexOf(':');
  const roomId = split >= 0 ? key.slice(0, split) : '';
  const botId = split >= 0 ? key.slice(split + 1) : '';
  inflight.aborted = true;
  try {
    inflight.turnController?.abort(Object.assign(new Error('已终止'), { name: 'AbortError' }));
  } catch {}
  try {
    inflight.session?.abort?.().catch(() => {});
  } catch {}
  if (inflight.next?.scope) {
    runner.requestLifecycle?.close?.(inflight.next.scope, null, 'answer');
  }
  inflight.next = null;
  if (roomId && botId) {
    runner.bus.emit('event', { t: 'typing', roomId, botId, active: false, lane: 'talk' });
  }
  return Boolean(roomId);
}

function markTalkStreamingAborted(runner, roomId, botId = null) {
  for (const msg of runner.store.listMessages(roomId, { limit: 200 })) {
    if (msg.status !== 'streaming') continue;
    if (msg.meta?.duplex !== DUPLEX_KIND.sideReply) continue;
    if (botId && msg.authorId !== botId) continue;
    runner.store.updateMessage(
      roomId,
      msg.id,
      { status: 'aborted', error: '已按你的要求终止' },
      { silent: false },
    );
  }
}

export function abortTalkFor(runner, roomId, botId) {
  const key = sessionKey(roomId, botId);
  runner.pendingSideContext.delete(key);
  const inflight = runner.talkInflight.get(key);
  markTalkStreamingAborted(runner, roomId, botId);
  if (!inflight) return false;
  return abortTalkEntry(runner, key, inflight);
}

export function abortTalkInRoom(runner, roomId) {
  let any = false;
  const prefix = `${roomId}:`;
  for (const key of [...runner.pendingSideContext.keys()]) {
    if (key.startsWith(prefix)) runner.pendingSideContext.delete(key);
  }
  for (const [key, inflight] of [...runner.talkInflight.entries()]) {
    if (!key.startsWith(prefix)) continue;
    if (abortTalkEntry(runner, key, inflight)) any = true;
  }
  markTalkStreamingAborted(runner, roomId, null);
  return any;
}

function collectLiveSnapshot(runner, roomId, botId) {
  const entry = runner.sessions.get(sessionKey(roomId, botId));
  const bot = runner.store.getBot(botId);
  const roomShells = shells.list({ roomId });
  const activeShells = roomShells
    .filter((s) => s.running)
    .slice(0, 3)
    .map((s) => ({
      id: s.id,
      command: s.command,
      running: s.running,
      tail: shells.output(s.id) ?? '',
    }));
  const taskId = entry?.managedContext?.taskRunId ?? null;
  let activeTaskRun = null;
  if (taskId) {
    const readRes = runner.store.taskRuns?.read?.(taskId);
    if (readRes?.status === 'found') activeTaskRun = readRes.taskRun;
  }
  const draftText = typeof entry?.liveDraft === 'function' ? entry.liveDraft() : '';
  return buildLiveWorkSnapshot({
    roomId,
    botId,
    botName: bot?.name ?? botId,
    goalText: entry?.goalText ?? '',
    workMsgId: entry?.liveMsgId ?? null,
    workStartedAt: entry?.startedAt ?? 0,
    nowMs: Date.now(),
    recentSteps: entry?.liveSteps ?? [],
    draftText,
    activeShells,
    sideNotes: entry?.turnAmends ?? [],
    activeTaskRun,
  });
}

function collectGroupSnapshot(runner, room) {
  const memberSnapshots = [];
  for (const bid of room?.botIds ?? []) {
    const entry = runner.sessions.get(sessionKey(room.id, bid));
    if (!entry?.busy) continue;
    memberSnapshots.push(collectLiveSnapshot(runner, room.id, bid));
  }
  return buildGroupWorkSnapshot({
    roomName: room?.name ?? room?.id ?? '',
    leadName: runner.store.getBot(room?.leadBotId)?.name ?? '',
    memberSnapshots,
    queuedCount: runner.roundQueue.has(room?.id) ? 1 : 0,
  });
}

async function routeBusyMessage(runner, {
  roomId,
  botId,
  text,
  hasAttachments = false,
  duplexMode = 'auto',
  mode = 'steer',
  roomKind = 'dm',
  workSnapshot = null,
}) {
  const askJev = async () => {
    const settings = (() => {
      try { return runner.store.decisionRoute(); } catch { return {}; }
    })();
    if (!shouldUseJev('busy-intent', settings).use) return null;
    const decision = await decidePoint('busy-intent', {
      message: text,
      goal: workSnapshot?.goalExcerpt ?? '',
      phase: workSnapshot?.phase ?? '',
    }, settings);
    if (!decision?.ok) return null;
    return {
      ok: true,
      kind: decision.values?.intent,
      confidence: decision.confidences?.intent,
      reason: decision.why,
    };
  };
  return routeBusyInput(
    {
      text,
      hasAttachments,
      explicitMode: duplexMode,
      mode,
      workSnapshot,
      roomKind,
    },
    { askJev },
  );
}

function ensureTalkBuilder(runner) {
  runner.__buildSession ??= createSessionBuilder({
    runner,
    health: runner.health,
    resolveModel: (slug) => runner.resolveModel(slug),
    modelLabel: () => runner.modelLabel(),
    config: runner.config,
    store: runner.store,
    bus: runner.bus,
    ...(runner.sessionApi ? { sessionApi: runner.sessionApi } : {}),
  });
  return runner.__buildTalkSession ?? ((roomId, botId, opts = {}) =>
    runner.__buildSession(roomId, botId, { ...opts, talkLane: true }));
}

async function executeTalkItem(runner, item, inflight) {
  const { roomId, botId, userMessage, cleanText, snapshotPrompt, duringMsgId, scope } = item;
  const bot = runner.store.getBot(botId);
  if (!bot) {
    runner.requestLifecycle?.close?.(scope, new Error('找不到 bot'), null);
    return;
  }

  let slotTicket = null;
  let talkEntry = null;
  let talkMsg = null;
  let talkErr = null;
  let unsubscribe = null;
  let pushDelta = null;

  try {
    if (inflight.aborted || runner.aborting.has(roomId)) return;
    slotTicket = await runner.acquireRunSlot({
      roomId,
      botId,
      human: true,
      signal: inflight.turnController.signal,
      timeoutMs: 5000,
    });
    if (slotTicket && !slotTicket.ok) {
      throw new Error('旁路对话等待运行槽位超时');
    }
    if (inflight.aborted || runner.aborting.has(roomId)) return;

    talkMsg = runner.store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: bot.id,
      authorName: bot.name,
      authorEmoji: bot.emoji,
      text: '',
      status: 'streaming',
      meta: {
        duplex: DUPLEX_KIND.sideReply,
        duringMsgId: duringMsgId ?? null,
        re: userMessage?.id ?? null,
      },
    });
    runner.bus.emit('event', {
      t: 'typing',
      roomId,
      botId: bot.id,
      active: true,
      lane: 'talk',
      msgId: talkMsg.id,
    });

    const buildTalk = ensureTalkBuilder(runner);
    talkEntry = await buildTalk(roomId, botId, { talkLane: true, snapshotPrompt });
    if (!talkEntry?.session) throw new Error('旁路会话初始化失败');
    inflight.session = talkEntry.session;
    if (inflight.aborted || runner.aborting.has(roomId)) return;

    let committed = [];
    let buffer = '';
    let usage = null;
    let responseFailure = null;
    const meter = new RunUsage();
    const render = () => {
      const parts = [...committed];
      if (buffer) parts.push(buffer);
      return parts.join('\n\n');
    };
    pushDelta = throttle(() => {
      if (inflight.aborted || !talkMsg) return;
      runner.bus.emit('event', { t: 'msg.delta', roomId, msgId: talkMsg.id, text: render() });
    }, 80);

    unsubscribe = talkEntry.session.subscribe?.((event) => {
      switch (event.type) {
        case 'message_start':
          if (event.message?.role === 'assistant') buffer = '';
          break;
        case 'message_update':
          if (event.assistantMessageEvent?.type === 'text_delta') {
            buffer += event.assistantMessageEvent.delta;
            pushDelta?.();
          }
          break;
        case 'message_end':
          if (event.message?.role === 'assistant') {
            meter.add(event.message.usage);
            usage = meter.snapshot();
            const failure = assistantFailure(event.message);
            if (failure) {
              responseFailure = failure;
              buffer = '';
              pushDelta?.flush?.();
              break;
            }
            responseFailure = null;
            const finalText = textOf(event.message) || buffer;
            if (finalText.trim()) committed.push(finalText.trim());
            buffer = '';
            pushDelta?.flush?.();
          }
          break;
        default:
          break;
      }
    }) ?? null;

    const memText = String(runner.store.memorySummaryFor(roomId, botId)?.text ?? '').trim().slice(0, 600);
    const recentDone = runner.store.listMessages(roomId, { limit: 12 })
      .filter((m) => m.authorType !== 'system' && m.status === 'done' && m.id !== userMessage?.id && m.id !== talkMsg.id)
      .slice(-8)
      .map((m) => `${m.authorName || (m.authorType === 'user' ? '用户' : bot.name)}：${String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}`)
      .filter(Boolean);

    const promptParts = [
      memText ? `【历史记忆摘要】\n${memText}` : '',
      recentDone.length ? `【近期对话片段】\n${recentDone.join('\n')}` : '',
      snapshotPrompt || '',
      `用户刚问：\n${cleanText}\n\n请直接结合上面的实时工作台快照与上下文，用 1～4 句自然口吻回答用户。`,
    ].filter(Boolean);
    const talkPrompt = promptParts.join('\n\n');

    const providerScope = providerLeaseScope(talkEntry.session.model, runner.model);
    await runner.providerUpdates.withLease(
      () => talkEntry.session.prompt(talkPrompt),
      providerScope,
    );

    if (inflight.aborted || runner.aborting.has(roomId)) {
      const msg = runner.store.updateMessage(
        roomId,
        talkMsg.id,
        { status: 'aborted', error: '已按你的要求终止' },
        { silent: true },
      );
      runner.bus.emit('event', { t: 'msg.updated', roomId, msgId: talkMsg.id, msg });
      return;
    }

    if (responseFailure) throw new Error(responseFailure.error);
    const finalText = render().trim() || '后台正在推进当前任务，稍后给你同步最新进展。';
    const msg = runner.store.updateMessage(
      roomId,
      talkMsg.id,
      { text: finalText, status: 'done', usage },
      { silent: true },
    );
    runner.bus.emit('event', { t: 'msg.done', msg });
    recordSideContext(runner, roomId, botId, cleanText, finalText);
  } catch (err) {
    talkErr = err;
    if (talkMsg) {
      const cancelled = inflight.aborted || runner.aborting.has(roomId) || err?.name === 'AbortError';
      const message = cancelled ? '已按你的要求终止' : modelFailure(err).error;
      const msg = runner.store.updateMessage(
        roomId,
        talkMsg.id,
        { status: cancelled ? 'aborted' : 'error', error: message },
        { silent: true },
      );
      runner.bus.emit('event', {
        t: cancelled ? 'msg.updated' : 'msg.error',
        roomId,
        msgId: talkMsg.id,
        error: message,
        msg,
      });
    }
  } finally {
    try { unsubscribe?.(); } catch {}
    inflight.session = null;
    try { releaseEntry(talkEntry); } catch {}
    try { slotTicket?.release?.(); } catch {}
    runner.bus.emit('event', {
      t: 'typing',
      roomId,
      botId: bot.id,
      active: false,
      lane: 'talk',
      msgId: talkMsg?.id ?? null,
    });
    runner.requestLifecycle?.close?.(scope, talkErr, talkErr ? null : 'answer');
  }
}

async function runTalkTurn(runner, item) {
  const key = sessionKey(item.roomId, item.botId);
  const existing = runner.talkInflight.get(key);
  if (existing) {
    if (existing.next?.scope) {
      runner.requestLifecycle?.close?.(existing.next.scope, null, 'answer');
    }
    existing.next = item;
    return existing.promise;
  }

  const inflight = {
    aborted: false,
    turnController: new AbortController(),
    next: null,
    promise: null,
  };
  const promise = (async () => {
    let current = item;
    try {
      while (current) {
        inflight.turnController = new AbortController();
        await executeTalkItem(runner, current, inflight);
        if (inflight.aborted || runner.aborting.has(item.roomId) || !inflight.next) break;
        current = inflight.next;
        inflight.next = null;
      }
    } finally {
      if (inflight.next?.scope) {
        runner.requestLifecycle?.close?.(inflight.next.scope, null, 'answer');
      }
      if (runner.talkInflight.get(key) === inflight) {
        runner.talkInflight.delete(key);
      }
    }
  })();
  inflight.promise = promise;
  runner.talkInflight.set(key, inflight);
  return promise;
}

async function replaceDmWorkTurn(runner, { roomId, botId, clean, files, userMessage, request, mode, deliveryEpoch }) {
  const deadline = Date.now() + 5000;
  while (
    runner.isBusy(roomId, botId) &&
    Date.now() < deadline &&
    !runner.aborting.has(roomId) &&
    (runner.directDeliveryEpochs.get(roomId) ?? 0) === deliveryEpoch
  ) {
    await sleep(25);
  }
  if (runner.aborting.has(roomId) || (runner.directDeliveryEpochs.get(roomId) ?? 0) !== deliveryEpoch) {
    if (request?.scope) {
      runner.requestLifecycle?.close?.(request.scope, new Error('已终止'), null);
    }
    return;
  }
  const effective = mode === 'followUp' ? 'followUp' : 'steer';
  let scopeSettled = false;
  try {
    await deliverDirectInput({
      prepare: () => runner.buildInput(clean, files, roomId),
      run: async ({ promptText }) => {
        const execute = () => runner.run(roomId, botId, promptText, {
          skipUserMessage: true, attachments: files, human: true,
        });
        if (!request) return execute();
        try {
          return await runner.withRequestEnvelope(request, roomId, botId, execute);
        } finally {
          scopeSettled = true;
          void runner.drainRequestQueue(roomId, botId);
        }
      },
      getEntry: () => runner.sessions.get(sessionKey(roomId, botId)),
      isCancelled: () => runner.aborting.has(roomId)
        || (runner.directDeliveryEpochs.get(roomId) ?? 0) !== deliveryEpoch,
      queue: (session, { promptText }) => session[effective](promptText, files.map(readForModel).filter(Boolean)),
      accepted: (queued) => {
        runner.store.updateMessage(roomId, userMessage.id, {
          meta: { ...(userMessage.meta ?? {}), queued: effective, queuedState: queued ?? 'queued' },
        });
        runner.bus.emit('event', { t: 'steer.accepted', roomId, mode: effective, text: clean, messageId: userMessage.id });
        if (request?.scope) {
          scopeSettled = true;
          runner.requestLifecycle?.close?.(request.scope, null, 'answer');
        }
      },
    });
  } catch (err) {
    if (request?.scope && !scopeSettled) {
      runner.requestLifecycle?.close?.(request.scope, err, null);
    }
    if (err?.name !== 'AbortError') {
      const error = modelFailure(err).error;
      const msg = runner.store.updateMessage(roomId, userMessage.id, { status: 'error', error });
      runner.bus.emit('event', { t: 'msg.error', roomId, msgId: userMessage.id, error, msg });
    }
  }
}

/** 合并后的投递（由 MergeQueue 在静默窗口到期时调用） */
export async function deliverMerged(runner, roomId, merged) {
  const room = runner.store.getRoom(roomId);
  if (!room) return;
  const botId = room.leadBotId ?? room.botIds?.[0];
  if (!botId) return;
  const deliveryEpoch = runner.directDeliveryEpochs.get(roomId) ?? 0;
  try {
    await deliverDirectInput({
      prepare: () => runner.buildInput(merged, [], roomId),
      run: ({ promptText }) =>
        runner.run(roomId, botId, promptText, { skipUserMessage: true, attachments: [] }),
      getEntry: () => runner.sessions.get(sessionKey(roomId, botId)),
      isCancelled: () =>
        runner.aborting.has(roomId) ||
        (runner.directDeliveryEpochs.get(roomId) ?? 0) !== deliveryEpoch,
      queue: (session, { promptText }) => session.followUp(promptText),
      accepted: () => {},
    });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    log(`合并消息投递失败：${err?.message ?? err}`);
  }
}

/**
 * 用户发消息总入口（私聊 / 群聊、全双工三路分流、插话 / 合并）。
 */
export async function sendUserMessage(
  runner,
  roomId,
  text,
  { mode = 'steer', attachments = [], flushMerge = true, request = null, groupScope = null, duplexMode = 'auto' } = {},
) {
  const room = runner.store.getRoom(roomId);
  if (!room) throw Object.assign(new Error('会话不存在'), { code: 'NO_ROOM' });
  const clean = String(text ?? '').trim();
  const files = (attachments ?? []).filter(Boolean);
  if (!clean && !files.length) throw Object.assign(new Error('消息为空'), { code: 'EMPTY' });

  const botId = runner.targetBotFor(room);
  if (!botId) throw Object.assign(new Error('这个会话里没有 bot'), { code: 'NO_BOT' });
  const bot = runner.store.getBot(botId);
  if (request) {
    runner.assertRequestEnvelope(request);
    if (room.kind === 'group') {
      throw Object.assign(new Error('群聊暂不支持首次接单请求'), { code: 'REQUEST_GROUP_UNSUPPORTED' });
    }
  }

  // ---------------------------------------------------------------- 私聊忙碌：全双工三路分流 / 兼容队列
  if (room.kind !== 'group' && runner.isBusy(roomId, botId)) {
    const snapshot = runner.fullDuplexEnabled ? collectLiveSnapshot(runner, roomId, botId) : null;
    const decision = runner.fullDuplexEnabled
      ? await routeBusyMessage(runner, {
          roomId,
          botId,
          text: clean,
          hasAttachments: files.length > 0,
          duplexMode,
          mode,
          roomKind: 'dm',
          workSnapshot: snapshot,
        })
      : { kind: DUPLEX_KIND.amend, decidedBy: 'rules', confidence: 1, reason: 'duplex_disabled' };

    if (runner.isBusy(roomId, botId)) {
      const entry = runner.sessions.get(sessionKey(roomId, botId));

      if (runner.fullDuplexEnabled && decision.kind === DUPLEX_KIND.sideReply) {
        runner.aborting.delete(roomId);
        const userMessage = runner.store.appendMessage({
          roomId,
          authorType: 'user',
          authorName: '我',
          text: clean,
          status: 'done',
          meta: {
            duplex: DUPLEX_KIND.sideReply,
            decidedBy: decision.decidedBy,
            duringMsgId: snapshot?.workMsgId ?? entry?.liveMsgId ?? null,
            ...(request ? { requestId: request.scope.requestId } : {}),
          },
          attachments: hydrate(files),
        });
        runner.store.answerPendingAsk(roomId, clean);
        runner.bus.emit('event', {
          t: 'duplex.routed',
          roomId,
          messageId: userMessage.id,
          requestId: request?.scope?.requestId ?? null,
          kind: DUPLEX_KIND.sideReply,
          decidedBy: decision.decidedBy,
          duringMsgId: snapshot?.workMsgId ?? entry?.liveMsgId ?? null,
        });
        void runTalkTurn(runner, {
          roomId,
          botId,
          userMessage,
          cleanText: clean,
          snapshotPrompt: formatLiveWorkSnapshotPrompt(snapshot),
          duringMsgId: snapshot?.workMsgId ?? entry?.liveMsgId ?? null,
          scope: request?.scope ?? null,
        });
        return { userMessage, bot, duplex: DUPLEX_KIND.sideReply, scopeHandled: Boolean(request?.scope) };
      }

      if (runner.fullDuplexEnabled && decision.kind === DUPLEX_KIND.abortReplace) {
        runner.aborting.delete(roomId);
        const deliveryEpoch = runner.directDeliveryEpochs.get(roomId) ?? 0;
        const liveMsgId = entry?.liveMsgId;
        const activeTaskRunId = entry?.managedContext?.taskRunId ?? null;
        if (liveMsgId) {
          const cur = runner.store.getMessage(roomId, liveMsgId);
          if (cur?.status === 'streaming') {
            runner.store.updateMessage(
              roomId,
              liveMsgId,
              {
                status: 'aborted',
                error: '已按你的要求终止',
                steps: (cur.steps ?? []).map((s) =>
                  s?.status === 'running' ? { ...s, status: 'error', error: '已终止' } : s,
                ),
              },
              { silent: false },
            );
          }
        }
        entry?.turnController?.abort(Object.assign(new Error('已按你的要求终止'), { name: 'AbortError' }));
        entry?.session?.abort?.().catch(() => {});
        abortTalkFor(runner, roomId, botId);
        if (activeTaskRunId) {
          if (typeof runner.taskRuntime?.onCancel === 'function') {
            await runner.taskRuntime.onCancel({
              taskRunId: activeTaskRunId,
              reason: '用户发新指令，终止并替换原任务',
            }).catch(() => {});
          } else {
            runner.abortManagedTask?.(activeTaskRunId);
          }
        }

        const userMessage = runner.store.appendMessage({
          roomId,
          authorType: 'user',
          authorName: '我',
          text: clean,
          status: 'done',
          meta: {
            duplex: DUPLEX_KIND.abortReplace,
            decidedBy: decision.decidedBy,
            ...(request ? { requestId: request.scope.requestId } : {}),
          },
          attachments: hydrate(files),
        });
        runner.store.answerPendingAsk(roomId, clean);
        runner.bus.emit('event', {
          t: 'duplex.routed',
          roomId,
          messageId: userMessage.id,
          requestId: request?.scope?.requestId ?? null,
          kind: DUPLEX_KIND.abortReplace,
          decidedBy: decision.decidedBy,
          duringMsgId: snapshot?.workMsgId ?? liveMsgId ?? null,
        });
        void replaceDmWorkTurn(runner, {
          roomId,
          botId,
          clean,
          files,
          userMessage,
          request,
          mode,
          deliveryEpoch,
        });
        return { userMessage, bot, duplex: DUPLEX_KIND.abortReplace, scopeHandled: Boolean(request?.scope) };
      }

      if (request && runner.taskIntakeEnabled && !runner.fullDuplexEnabled) {
        const userMessage = runner.store.appendMessage({
          roomId, authorType: 'user', authorName: '我', text: clean, status: 'done',
          meta: { queued: 'request', requestId: request.scope.requestId },
          attachments: hydrate(files),
        });
        runner.enqueueRequest(roomId, { request, text: clean, files, messageId: userMessage.id });
        runner.bus.emit('event', {
          t: 'request.queued', roomId, requestId: request.scope.requestId,
          requesterId: request.scope.requesterId, messageId: userMessage.id,
        });
        return { userMessage, bot, queued: true, requestId: request.scope.requestId };
      }

      if (!entry?.session) {
        throw Object.assign(new Error('会话还没就绪，稍后再发'), { code: 'NOT_READY' });
      }
      const effective = mode === 'followUp' ? 'followUp' : 'steer';
      let queued;
      try {
        const { promptText } = await runner.buildInput(clean, files, roomId);
        if (runner.aborting.has(roomId)) throw Object.assign(new Error('已终止'), { name: 'AbortError' });
        queued = await entry.session[effective](promptText, files.map(readForModel).filter(Boolean));
      } catch (err) {
        throw Object.assign(new Error(`插话失败：${modelFailure(err).error}`), { code: 'STEER_FAILED' });
      }
      if (entry.turnAmends) entry.turnAmends.push(clean.slice(0, 160));
      const userMessage = runner.store.appendMessage(
        {
          roomId,
          authorType: 'user',
          authorName: '我',
          text: clean,
          status: 'done',
          meta: {
            queued: effective,
            queuedState: queued ?? 'queued',
            ...(runner.fullDuplexEnabled ? {
              duplex: DUPLEX_KIND.amend,
              decidedBy: decision.decidedBy,
              duringMsgId: entry.liveMsgId ?? null,
            } : {}),
            ...(request ? { requestId: request.scope.requestId } : {}),
          },
          attachments: hydrate(files),
        },
        {},
      );
      runner.bus.emit('event', {
        t: 'steer.accepted',
        roomId,
        mode: effective,
        text: clean,
        messageId: userMessage.id,
      });
      if (runner.fullDuplexEnabled) {
        runner.bus.emit('event', {
          t: 'duplex.routed',
          roomId,
          messageId: userMessage.id,
          requestId: request?.scope?.requestId ?? null,
          kind: DUPLEX_KIND.amend,
          decidedBy: decision.decidedBy,
          duringMsgId: entry.liveMsgId ?? null,
        });
      } else {
        const liveMsgId = entry.liveMsgId;
        if (liveMsgId && liveMsgId !== userMessage.id) {
          runner.store.moveMessageAfter(roomId, liveMsgId, userMessage.id, { touch: true });
        }
      }
      if (request?.scope) {
        runner.requestLifecycle?.close?.(request.scope, null, 'answer');
      }
      return {
        userMessage,
        bot,
        steered: effective,
        ...(runner.fullDuplexEnabled ? { duplex: DUPLEX_KIND.amend } : {}),
        scopeHandled: Boolean(request?.scope),
      };
    }
  }

  // ---------------------------------------------------------------- 群聊忙碌旁路问答：只唤醒负责人，不掐断在跑成员
  if (room.kind === 'group' && runner.fullDuplexEnabled && (runner.roundLocks.has(roomId) || runner.isRoomBusy(roomId))) {
    const groupSnap = collectGroupSnapshot(runner, room);
    const decision = await routeBusyMessage(runner, {
      roomId,
      botId,
      text: clean,
      hasAttachments: files.length > 0,
      duplexMode,
      mode,
      roomKind: 'group',
      workSnapshot: groupSnap.members[0] ?? null,
    });
    // ★ 补一句要求时「该找谁」：@了谁就找谁，否则找负责人。
    //
    //   不能把用户的一句话同时强转给**所有在跑的成员**：用户问「进度到多少了」，
    //   结果四个成员各自回一句、负责人反而没声音。这里先算出唯一目标。
    const groupMembers = (room.botIds ?? [])
      .map((id) => runner.store.getBot(id))
      .filter(Boolean);
    const mentionHit = parseMentions(clean, groupMembers, { selfId: bot.id }).found?.[0] ?? null;
    const amendTargetId = mentionHit ?? room.leadBotId ?? bot.id;
    const amendTargetBusy = Boolean(
      runner.sessions.get(sessionKey(roomId, amendTargetId))?.busy,
    );
    const isSupplement = decision.kind === DUPLEX_KIND.amend && looksLikeSupplement(clean);
    const wantsSideReply = decision.kind === DUPLEX_KIND.sideReply ||
      // 补一句约束但负责人没在跑：当旁路问答处理，不去 steer 在干的成员。
      // 新任务（「第二轮需求」这种）不走这条路 —— 仍然按插话重排处理。
      (isSupplement && !amendTargetBusy);

    if ((runner.roundLocks.has(roomId) || runner.isRoomBusy(roomId)) && wantsSideReply) {
      runner.aborting.delete(roomId);
      const userMessage = runner.store.appendMessage({
        roomId,
        authorType: 'user',
        authorName: '我',
        text: clean,
        status: 'done',
        meta: {
          duplex: DUPLEX_KIND.sideReply,
          decidedBy: decision.decidedBy,
          ...(groupScope ? { requestId: groupScope.requestId } : {}),
        },
        attachments: hydrate(files),
      });
      runner.store.answerPendingAsk(roomId, clean);
      const duringMsgId = groupSnap.members[0]?.workMsgId ?? null;
      runner.bus.emit('event', {
        t: 'duplex.routed',
        roomId,
        messageId: userMessage.id,
        requestId: groupScope?.requestId ?? null,
        kind: DUPLEX_KIND.sideReply,
        decidedBy: decision.decidedBy,
        duringMsgId,
      });
      void runTalkTurn(runner, {
        roomId,
        botId,
        userMessage,
        cleanText: clean,
        snapshotPrompt: formatGroupWorkSnapshotPrompt(groupSnap),
        duringMsgId,
        scope: groupScope ?? null,
      });
      return {
        userMessage,
        bot,
        group: true,
        duplex: DUPLEX_KIND.sideReply,
        scopeHandled: Boolean(groupScope),
      };
    }

    // ---------------------------------------------------------------- 群聊忙时「补充要求」：只把话递进去，不打断在跑的成员
    //
    // ★ 为什么不能再落到 dispatchGroupRound：那条路发现本轮在跑就 interruptRoundForUser，
    //   把每个成员的会话都 abort、正在写的消息标 aborted，然后按新要求重跑整轮。
    //   用户只是补一句约束（"把范围收窄到 A 股"），却把四个成员的活全部作废 ——
    //   这正是「说好的全双工但一插话就重来」的根因。
    //   所以 amend 走 steer：话进到正在跑的那几个会话里，谁在跑谁收到，谁都不被打断。
    if ((runner.roundLocks.has(roomId) || runner.isRoomBusy(roomId)) &&
        decision.kind === DUPLEX_KIND.amend &&
        // 只有看起来是「补一句约束」才走 steer；像「第二轮需求」这种新任务
        // 仍然走原来的插话重排（兼容 room-lock 那套契约）。
        looksLikeSupplement(clean)) {
      const running = [];
      const targetEntry = runner.sessions.get(sessionKey(roomId, amendTargetId));
      if (targetEntry?.busy && targetEntry.session?.steer) {
        running.push({ bid: amendTargetId, entry: targetEntry });
      }
      if (running.length) {
        const { promptText } = await runner.buildInput(clean, files, roomId);
        const models = files.map(readForModel).filter(Boolean);
        let steered = 0;
        for (const { bid, entry } of running) {
          try {
            await entry.session.steer(promptText, models);
            if (entry.turnAmends) entry.turnAmends.push(clean.slice(0, 160));
            steered += 1;
            runner.bus.emit('event', {
              t: 'steer.accepted',
              roomId,
              mode: 'steer',
              text: clean,
              botId: bid,
            });
          } catch (err) {
            log(`【${room.name}】补充要求注入 ${bid} 失败：${err?.message || err}`);
          }
        }
        if (steered > 0) {
          const userMessage = runner.store.appendMessage({
            roomId,
            authorType: 'user',
            authorName: '我',
            text: clean,
            status: 'done',
            meta: {
              duplex: DUPLEX_KIND.amend,
              decidedBy: decision.decidedBy,
              ...(groupScope ? { requestId: groupScope.requestId } : {}),
            },
            attachments: hydrate(files),
          });
          runner.store.answerPendingAsk(roomId, clean);
          runner.bus.emit('event', {
            t: 'duplex.routed',
            roomId,
            messageId: userMessage.id,
            requestId: groupScope?.requestId ?? null,
            kind: DUPLEX_KIND.amend,
            decidedBy: decision.decidedBy,
            botId: amendTargetId,
            duringMsgId: groupSnap.members[0]?.workMsgId ?? null,
          });
          if (groupScope) runner.requestLifecycle?.close?.(groupScope, null, 'answer');
          return {
            userMessage,
            bot,
            group: true,
            duplex: DUPLEX_KIND.amend,
            steered: 'amend',
            scopeHandled: Boolean(groupScope),
          };
        }
      }
    }
  }

  runner.aborting.delete(roomId);
  const userMessage = runner.store.appendMessage({
    roomId,
    authorType: 'user',
    authorName: '我',
    text: clean,
    status: 'done',
    attachments: hydrate(files),
  });

  runner.store.answerPendingAsk(roomId, clean);

  if (room.kind === 'group') {
    runner.dispatchGroupRound(roomId, clean, files).catch((err) =>
      log('runRound 异常：', err?.stack || err),
    );
  } else {
    const idle = !runner.isBusy(roomId, botId);

    if (idle && !files.length && !flushMerge) {
      runner.mergeQueue.push(roomId, clean);
      return { userMessage, bot, group: false, merging: true };
    }
    if (flushMerge && runner.mergeQueue.hasPending(roomId)) {
      runner.mergeQueue.push(roomId, clean);
      await runner.mergeQueue.flushAll();
      return { userMessage, bot, group: false, merging: false };
    }

    const effective = mode === 'followUp' ? 'followUp' : 'steer';
    const deliveryEpoch = runner.directDeliveryEpochs.get(roomId) ?? 0;
    let scopeSettled = false;
    deliverDirectInput({
      prepare: () => runner.buildInput(clean, files, roomId),
      run: async ({ promptText }) => {
        const execute = () => runner.run(roomId, botId, promptText, { skipUserMessage: true, attachments: files, human: true });
        if (!request) return execute();
        try {
          return await runner.withRequestEnvelope(request, roomId, botId, execute);
        } finally {
          scopeSettled = true;
          void runner.drainRequestQueue(roomId, botId);
        }
      },
      getEntry: () => runner.sessions.get(sessionKey(roomId, botId)),
      isCancelled: () => runner.aborting.has(roomId)
        || (runner.directDeliveryEpochs.get(roomId) ?? 0) !== deliveryEpoch,
      queue: (session, { promptText }) => session[effective](promptText, files.map(readForModel).filter(Boolean)),
      accepted: (queued) => {
        runner.store.updateMessage(roomId, userMessage.id,
          { meta: { ...(userMessage.meta ?? {}), queued: effective, queuedState: queued ?? 'queued' } });
        runner.bus.emit('event', { t: 'steer.accepted', roomId, mode: effective, text: clean, messageId: userMessage.id });
        if (!runner.fullDuplexEnabled) {
          const racing = runner.sessions.get(sessionKey(roomId, botId));
          const liveMsgId = racing?.liveMsgId;
          if (liveMsgId && liveMsgId !== userMessage.id) {
            runner.store.moveMessageAfter(roomId, liveMsgId, userMessage.id, { touch: true });
          }
        }
        if (request?.scope) {
          scopeSettled = true;
          runner.requestLifecycle?.close?.(request.scope, null, 'answer');
        }
      },
    }).catch((err) => {
      if (request?.scope && !scopeSettled) {
        runner.requestLifecycle?.close?.(request.scope, err, null);
      }
      const error = modelFailure(err).error;
      const msg = runner.store.updateMessage(roomId, userMessage.id, { status: 'error', error });
      runner.bus.emit('event', { t: 'msg.error', roomId, msgId: userMessage.id, error, msg });
    });
  }
  return { userMessage, bot, group: room.kind === 'group' };
}
