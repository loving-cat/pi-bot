/**
 * 群组（部门）多智能体并发轮次编排子模块。
 *
 * 收敛：
 *   1. 房间级串行锁与代数失效（`dispatchGroupRound` / `drainGroupRounds` / `interruptRoundForUser`）；
 *   2. 便宜同步 + Jev 兜底的发言判断（`shouldBotReplySync` / `askShouldReply`）；
 *   3. 受管单次执行（`runManagedOnce`）与非受管群波次并发调度、熔断重试、PASS 剔除及老大收尾轮（`executeGroupRound`）。
 *
 * 约定：所有实际触发单 Bot 运行的调用均经由 `runner.run(...)` 与 `runner.runRound(...)`，
 * 保持对外部测试桩与原型拦截的 100% 兼容。
 */
import { log, newId, isSuperiorCall } from '../util.js';
import { isMainChatBusy } from './chief-summary-runner.js';
import { shouldMirrorProgress, mirrorProgress, MIRROR_SKIPPED_NO_DM } from '../dm.js';
import { settleRetryMessage } from '../retry-messages.js';
import { decideRetry, failureNote, retryHint, transientBackoffMs } from '../retry-policy.js';
import {
  canRequest as breakerAllows,
  breakerNote,
  BREAKER_STATE,
} from '../circuit-breaker.js';
import { parseMentions } from '../mentions.js';
import { decide as decidePoint, interpretShouldReply, shouldAskShouldReply, shouldUseJev } from '../decision-router.js';
import { planItem, shouldStopRound, leftBehind, planClosing, isUserInitiatedRound } from '../group-round.js';
import { resolveManagedContext, MANAGED } from '../tasks/task-progress.js';
import { STOP } from '../tasks/task-contract.js';
import {
  composeGroupPrompt,
  departmentOf,
  isStrictlyAfter,
  lastDoneIdOf,
  lastDoneIndexAll,
  lastMessageId,
  openingSpeakers,
  transcriptFor,
} from '../group-prompt.js';
import { RETRY_DELAY_MS, sessionKey } from './runner-utils.js';

export function roundEpoch(runner, roomId) {
  return runner.roundEpochs.get(roomId) ?? 0;
}

/** 用户在群里插话：代数 +1，打断本轮在跑会话，当场把正在写消息标成 aborted。 */
export function interruptRoundForUser(runner, roomId) {
  runner.roundEpochs.set(roomId, roundEpoch(runner, roomId) + 1);

  let n = 0;
  const botIds = [];
  for (const [key, entry] of runner.sessions) {
    if (!key.startsWith(`${roomId}:`)) continue;
    if (!entry.session || !entry.busy) continue;
    const botId = key.slice(roomId.length + 1);
    botIds.push(botId);
    if (entry.compactingOnly) {
      entry.turnController?.abort();
      n++;
      continue;
    }
    try {
      entry.turnController?.abort();
      entry.session.abort?.().catch(() => {});
      n++;
    } catch {}
  }

  if (botIds.length) {
    for (const msg of runner.store.listMessages(roomId, { limit: 200 })) {
      if (msg.status !== 'streaming') continue;
      if (!botIds.includes(msg.authorId)) continue;
      runner.store.updateMessage(
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
      runner.bus.emit('event', { t: 'typing', roomId, botId: id, active: false });
    }
  }

  if (n) log(`已打断 ${n} 个正在跑的会话（用户插话，旧轮作废）`);
}

export function dispatchGroupRound(runner, roomId, text, files) {
  if (runner.roundLocks.has(roomId) || runner.isRoomBusy(roomId)) {
    log(
      `【${runner.store.getRoom(roomId)?.name ?? roomId}】用户插话 → 打断进行中的一轮，按新要求重来`,
    );
    interruptRoundForUser(runner, roomId);
    runner.roundQueue.delete(roomId);
    runner.mergeQueue.drop(roomId);
    runner.roundQueue.set(roomId, { text, files: [...files] });
    return Promise.resolve();
  }
  runner.roundLocks.add(roomId);
  return drainGroupRounds(runner, roomId, { text, files });
}

async function drainGroupRounds(runner, roomId, first) {
  let next = first;
  try {
    while (next) {
      try {
        const { promptText } = await runner.buildInput(next.text, next.files, roomId);
        await runner.runRound(roomId, {
          openerText: next.text,
          attachmentContext: promptText,
          attachments: next.files,
        });
      } catch (err) {
        log('runRound 异常：', err?.stack || err);
      }
      next = runner.roundQueue.get(roomId) ?? null;
      if (next) runner.roundQueue.delete(roomId);
    }
  } finally {
    runner.roundLocks.delete(roomId);
  }
}

function mirrorGroupProgress(runner, progress) {
  try {
    const result = mirrorProgress({ store: runner.store, ...progress });
    if (result === MIRROR_SKIPPED_NO_DM) {
      log(
        `私聊回执跳过：${progress.bot?.name ?? '某个 bot'} 还没和用户开过私聊 — ` +
          '在侧边栏点开它一次，之后的部门回执才会同步到这里',
      );
    }
  } catch (err) {
    log('私聊进度回执失败：', err?.message || err);
  }
}

async function awaitPending(pending, stale, { graceMs = 5000, pollMs = 100 } = {}) {
  if (!pending.length) return;
  let settled = false;
  const all = Promise.allSettled(pending).then(() => {
    settled = true;
  });
  const watch = (async () => {
    while (!settled) {
      if (stale()) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  })();
  const wentStale = await Promise.race([watch, all.then(() => false)]);
  if (!wentStale || settled) return;
  await Promise.race([all, new Promise((r) => setTimeout(r, graceMs))]);
  if (!settled) {
    log(`用户已插话/终止：旧轮还有 ${pending.length} 个会话没退出，先释放房间锁`);
  }
}

function shouldBotReplySync(runner, { room, roomId, item, bot, isOpening = false }) {
  if (runner.aborting.has(roomId)) return false;
  if (Boolean(item?.fromId) || isOpening) return true;

  const settings = (() => {
    try { return runner.store.decisionRoute(); } catch { return {}; }
  })();
  const gate = shouldUseJev('should-reply', settings);
  const throttleKey = `${roomId}:${bot.id}:${item?.sourceMessageId ?? ''}`;

  const { ask, why } = shouldAskShouldReply({
    addressed: false,
    enabled: gate.use,
    alreadyAsked: runner.shouldReplyAsked.has(throttleKey),
  });
  if (!ask) {
    const cached = runner.shouldReplyAsked.get(throttleKey);
    if (cached === false) {
      log(`【${room.name}】${bot.name} 不发言：${why}`);
      return false;
    }
    return true;
  }
  return null;
}

function rememberShouldReply(runner, key, value) {
  if (runner.shouldReplyAsked.size > 500) {
    const keys = [...runner.shouldReplyAsked.keys()].slice(0, 250);
    for (const k of keys) runner.shouldReplyAsked.delete(k);
  }
  runner.shouldReplyAsked.set(key, value);
}

async function askShouldReply(runner, { room, roomId, item, bot }) {
  const throttleKey = `${roomId}:${bot.id}:${item?.sourceMessageId ?? ''}`;
  const settings = (() => {
    try { return runner.store.decisionRoute(); } catch { return {}; }
  })();

  let decision;
  try {
    decision = await decidePoint('should-reply', {
      message: String(item?.fromText || item?.reason || '').slice(0, 2000),
      recent: runner.store.listMessages(roomId, { limit: 8 })
        .filter((m) => m.authorType !== 'system')
        .map((m) => `${m.authorName || '用户'}：${String(m.text ?? '').slice(0, 300)}`),
      botName: bot.name,
    }, settings, { timeoutMs: 4000 });
  } catch (err) {
    log(`【${room.name}】${bot.name} 的 should-reply 判断抛错：`, err?.message || err);
    rememberShouldReply(runner, throttleKey, false);
    return false;
  }

  const { run, why: verdict } = interpretShouldReply(decision);
  rememberShouldReply(runner, throttleKey, run);
  log(`【${room.name}】${bot.name} should-reply=${run}：${verdict}`);
  return run;
}

async function runManagedOnce(runner, {
  room,
  botId,
  managedContext,
  openerText = '',
  openerBotId = null,
  openerName = '用户',
  attachments = [],
  attachmentContext = null,
  kickoff = false,
} = {}) {
  const roomId = room.id;
  const bot = runner.store.getBot(botId);
  if (!bot) {
    return { ok: false, code: 'MANAGED_TARGET_MISSING', error: '受管目标 Bot 不存在', stop: STOP.failed };
  }

  const dept = departmentOf(room, runner.store);
  const fresh = transcriptFor(roomId, botId, undefined, { store: runner.store });
  const prompt = composeGroupPrompt(room, bot, fresh, {
    isLead: botId === (dept.leadId ?? null),
    reason: kickoff ? '部门刚成立，先由你安排' : openerBotId ? openerName + ' 叫了你' : '用户发了新消息',
    members: dept.members,
    leadId: dept.leadId,
    order: { index: 1 },
  });

  const taskPrompt = typeof openerText === 'string' && openerText.trim() ? openerText.trim() : '';
  const composed = [taskPrompt, prompt].filter(Boolean).join('\n\n');

  const key = sessionKey(roomId, botId);
  const managedTaskRun = managedContext?.taskRunId ?? null;
  runner.dispatching.add(key);
  if (managedTaskRun) {
    const entry = runner.sessions.get(key);
    runner.managedInflight.set(managedTaskRun, {
      key, botId, roomId, session: entry?.session ?? null, attemptId: managedContext?.attemptId ?? null,
    });
  }
  try {
    const res = await runner.run(roomId, botId, attachmentContext ? attachmentContext + '\n\n' + composed : composed, {
      groupTurn: true,
      retryManaged: true,
      taskRunId: newId('run_'),
      attemptIndex: 1,
      attachments,
      managedContext,
      human: !openerBotId,
    });
    return res;
  } catch (err) {
    log('【' + room.name + '】受管单次执行异常：', err?.message || err);
    return {
      ok: false,
      code: 'MANAGED_EXECUTION_FAILED',
      error: err?.message || String(err),
      reason: '执行失败：' + String(err?.message ?? err).slice(0, 200),
      stop: STOP.failed,
    };
  } finally {
    runner.dispatching.delete(key);
    if (managedTaskRun) runner.managedInflight.delete(managedTaskRun);
  }
}

/** 群（部门）一轮并发波次编排入口。 */
export async function executeGroupRound(
  runner,
  roomId,
  {
    openerText = '',
    openerBotId = null,
    openerMessageId = null,
    openerName = '用户',
    kickoff = false,
    attachments = [],
    attachmentContext = null,
    managedContext = null,
    summary = null,
  } = {},
) {
  const room = runner.store.getRoom(roomId);
  if (!room || room.kind !== 'group') return;
  const { members, leadId } = departmentOf(room, runner.store);
  if (!members.length) return;

  const isManagedRound = managedContext !== null && managedContext !== undefined;

  if (isManagedRound) {
    const probe = resolveManagedContext(managedContext, {
      loadTaskRun: (id) => runner.store.taskRuns.read(id),
      loadRootTaskRun: (id) => runner.store.taskRuns.read(id),
    });
    if (probe.kind === MANAGED.invalid) {
      return {
        ok: false,
        code: 'INVALID_MANAGED_CONTEXT',
        error: `受管执行上下文不合法：${probe.text}`,
        stop: STOP.failed,
      };
    }

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

    return runManagedOnce(runner, {
      room,
      botId: probe.context.botId,
      managedContext,
      openerText,
      openerBotId,
      openerName,
      attachments,
      attachmentContext,
      kickoff,
    });
  }

  const epoch = roundEpoch(runner, roomId);
  const stale = () => roundEpoch(runner, roomId) !== epoch;

  const opening = openingSpeakers(room, { text: openerText, openerBotId, kickoff, store: runner.store });
  const openingSet = new Set(opening);
  if (!opening.length) return;

  const limits = runner.store.groupLimits();
  const budget = (botId) => (botId === leadId ? limits.leadTurns : limits.memberTurns);
  const used = new Map();
  const called = new Set(opening);
  const chiefId = runner.store.mainBot()?.id ?? null;
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
      .map((id) => runner.store.getBot(id)?.name ?? id)
      .join('、')}`,
  );

  const roundStartIndex = lastDoneIndexAll(roomId, runner.store);
  const roundStartMsgId = lastMessageId(roomId, runner.store);
  const participants = [leadId, ...members.map((m) => m.id)].filter(Boolean);

  let runs = 0;
  const pending = [];
  for (;;) {
    const stop = shouldStopRound({
      queueLen: queue.length,
      pendingLen: pending.length,
      runs,
      maxRuns: limits.maxRuns,
      aborting: runner.aborting.has(roomId),
      stale: stale(),
    });
    if (stop.stop) {
      const voided = stop.why === '已终止' || stop.why === '用户插话';
      if (queue.length) {
        log(
          voided
            ? `【${room.name}】⏹ ${stop.why}，剩下的 ${queue.length} 个人不再派`
            : `【${room.name}】⚠️ ${stop.why}，还有 ${queue.length} 个人没轮到：` +
                leftBehind(queue, (id) => runner.store.getBot(id)?.name ?? id).join('、'),
        );
      }
      if (voided) queue.length = 0;
      break;
    }
    if (!queue.length) {
      await awaitPending(pending.splice(0), stale);
      continue;
    }
    const item = queue.shift();
    const bot = runner.store.getBot(item.botId);
    if (!bot) continue;
    const done = used.get(item.botId) ?? 0;
    const busyNow = runner.isBusy(roomId, bot.id);
    const superior = isSuperiorCall({
      fromId: item.fromId,
      fromRole: item.fromId ? 'bot' : 'user',
      leadId,
      chiefId,
      selfId: bot.id,
    });
    const plan = planItem({
      item,
      name: bot.name,
      done,
      budget: budget(bot.id),
      busy: busyNow,
      superior,
      userRound: !item.fromId && isUserInitiatedRound({ openerBotId }),
    });
    if (plan.kind === 'skip') {
      log(`【${room.name}】${plan.why} → 不再叫它`);
      const byUser = !item.fromId;
      runner.store.appendMessage({
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
      continue;
    }
    if (plan.kind === 'interrupt' || plan.kind === 'queue') {
      const entry = runner.sessions.get(sessionKey(roomId, bot.id));
      if (plan.kind === 'interrupt' && entry?.session) {
        const userRound = isUserInitiatedRound({ openerBotId });
        const from = item.fromName || '上级';
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
          runner.store.appendMessage(
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
            { beforeStreaming: true },
          );
          continue;
        } catch (err) {
          log(`叫停 ${bot.name} 失败：${err?.message || err}`);
        }
      }
      log(`【${room.name}】${bot.name} 还在忙 → 等它空下来再派（${item.reason}）`);
      if (entry?.session?.followUp) {
        try {
          await entry.session.followUp(
            `【${item.fromName || '同事'} 找你】${item.fromName || '同事'} 刚在群里说：\n` +
              `${(item.fromText || '').slice(0, 1200) || '（看群里的最新消息）'}\n\n` +
              '你手上那件做完之后再处理这条（不急，但也别忘了）。',
          );
          log(`【${room.name}】把话投进 ${bot.name} 的 inbox（它在忙，忙完自己看）`);
          runner.store.appendMessage(
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
      const deadline = Date.now() + runner.config.groupBusyWaitMs;
      while (runner.isBusy(roomId, bot.id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (runner.isBusy(roomId, bot.id)) {
        log(`【${room.name}】${bot.name} 一直忙，这一单没派出去 → 上报`);
        runner.escalate({
          roomId,
          fromBotId: bot.id,
          reason: `要派给${bot.name}的活一直没派出去（它忙了 ${Math.round(runner.config.groupBusyWaitMs / 1000)} 秒以上）`,
          prefer: 'lead',
        }).catch((err) => log('上报失败：', err?.message || err));
        continue;
      }
    }
    used.set(item.botId, done + 1);
    runs++;
    const dispatchKey = sessionKey(roomId, bot.id);
    runner.dispatching.add(dispatchKey);

    const fresh = transcriptFor(roomId, bot.id, undefined, { store: runner.store });
    let prompt = composeGroupPrompt(room, bot, fresh, {
      isLead: bot.id === leadId,
      reason: item.reason,
      members,
      leadId,
      order: { index: runs },
    });
    if (attachmentContext) prompt = `${attachmentContext}\n\n${prompt}`;

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
            fromName: item.fromName || (item.fromId ? (runner.store.getBot(item.fromId)?.name ?? '') : ''),
          };
          if (isManagedRound && managedContext.botId !== bot.id) {
            log(`【${room.name}】${bot.name} 跳过：本轮是受管执行，只跑 ${managedContext.botId}`);
            return;
          }

          const syncVerdict = shouldBotReplySync(runner, {
            room,
            roomId,
            item,
            bot,
            isOpening: openingSet.has(bot.id) && item.sourceMessageId === openerMessageId,
          });
          if (syncVerdict === false) return;
          if (syncVerdict === null) {
            if (!(await askShouldReply(runner, { room, roomId, item, bot }))) return;
            if (runner.aborting.has(roomId)) return;
          }

          // ★ 不再往旧 TaskItem 写派活流水：任务板/顶栏浮层现在只读 TaskRun，
          //   再写一份就是双轨。受管任务的账本在 taskRuns，未受管波次不再登记。
          const taskId = null;
          runner.flushProviderUpdates();
          const gate = runner.breakerFor(bot.id);
          const gateCheck = gate ? breakerAllows(gate.breaker, Date.now()) : { allow: true };
          const taskRunId = newId('run_');

          const itemManaged = isManagedRound ? managedContext : null;
          let res;
          if (!gateCheck.allow) {
            log(`【${room.name}】${bot.name} 跳过：${gateCheck.reason}`);
            res = {
              ok: false,
              text: '',
              ms: 0,
              error: breakerNote(gate.breaker, {
                groupName: runner.modelGroups.get(gate.groupId)?.name ?? '',
              }),
              status: 503,
              messageId: '',
              breakerSkipped: true,
            };
          } else {
            res = await runner.run(roomId, bot.id, prompt, {
              groupTurn: true,
              retryManaged: true,
              taskRunId, attemptIndex: 1,
              attachments,
              managedContext: itemManaged,
              human: !item.fromId && isUserInitiatedRound({ openerBotId }),
            });
          }
          if (res.ok) {
            runner.markGroupHealthy(bot.id);
          } else if (!res.breakerSkipped) {
            const firstDecision = decideRetry({
              error: String(res.error ?? ''),
              attempt: 1,
              aborting: runner.aborting.has(roomId),
              status: res.status ?? null,
            });
            runner.markGroupFailed(bot.id, {
              kind: firstDecision.kind,
              status: res.status ?? null,
            });
          }
          let attempt = 1;
          let lastError = res.ok ? '' : String(res.error ?? '未知原因');
          let lastStatus = res.ok ? null : (res.status ?? null);
          let lastKind = res.breakerSkipped ? 'breaker-open' : '';
          const retries = [];

          while (!res.ok) {
            if (res.breakerSkipped) break;
            if (stale()) break;
            const decision = decideRetry({
              error: lastError,
              attempt,
              aborting: runner.aborting.has(roomId),
              status: lastStatus,
            });
            if (!decision.retry) {
              log(`【${room.name}】${bot.name} 不再重试：${decision.why}`);
              lastKind = decision.kind;
              break;
            }
            const afterFail = runner.breakerFor(bot.id);
            if (afterFail && afterFail.breaker.state === BREAKER_STATE.open) {
              log(`【${room.name}】${bot.name} 熔断已打开，停止重试`);
              lastKind = 'breaker-open';
              break;
            }
            attempt++;
            retries.push(`${attempt}. ${decision.why}`);
            log(
              `【${room.name}】${bot.name} 第 ${attempt} 次尝试（${decision.kind}）：${lastError.slice(0, 80)}`,
            );
            const waitMs =
              decision.kind === 'transient'
                ? transientBackoffMs(attempt - 1)
                : RETRY_DELAY_MS;
            await new Promise((r) => setTimeout(r, waitMs));
            if (runner.aborting.has(roomId)) break;
            if (stale()) break;
            const hinted = retryHint({
              attempt: attempt - 1,
              error: lastError,
              kind: decision.kind,
              switchModel: decision.switchModel === true,
            });
            settleRetryMessage(runner.store, roomId, res, { willRetry: true });
            res = await runner.run(roomId, bot.id, hinted + prompt, {
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
            if (res.ok) {
              runner.markGroupHealthy(bot.id);
            } else {
              runner.markGroupFailed(bot.id, {
                kind: decision.kind,
                status: res.status ?? null,
              });
            }
          }

          if (stale()) {
            settleRetryMessage(runner.store, roomId, res, { aborted: true });
            if (taskId && !itemManaged) {
              runner.store.voidTask(taskId);
            }
            log(`【${room.name}】用户插话 → ${bot.name} 这一条作废（不重试、不上报）`);
            return;
          }

          settleRetryMessage(runner.store, roomId, res, res.ok
            ? { succeeded: true }
            : { error: lastError, aborted: runner.aborting.has(roomId) });
          if (taskId && !itemManaged) {
            runner.store.finishTask(taskId, {
              ok: res.ok,
              text: res.ok ? res.text : `失败 ${attempt} 次：${lastError}`,
            });
          }
          if (res.messageId && progressSource.sourceMessageId) {
            try {
              runner.store.updateMessage(roomId, res.messageId, {
                meta: {
                  ...(runner.store.getMessage(roomId, res.messageId)?.meta ?? {}),
                  re: progressSource.sourceMessageId,
                  reFrom: progressSource.fromId ?? null,
                },
              });
            } catch {}
          }
          const passText = (res.text ?? '').trim();
          const isPass = res.ok && /^\[?PASS\]?$/i.test(passText);
          if (mirror && !isPass) {
            mirrorGroupProgress(runner, {
              room,
              bot,
              phase: 'done',
              text: res.text,
              ok: res.ok,
              ...progressSource,
            });
          }
          runner.store.setCursor(roomId, bot.id, lastMessageId(roomId, runner.store));

          if (!res.ok) {
            log(
              `【${room.name}】${bot.name} 最终没跑成（试了 ${attempt} 次）：${lastError}`,
            );
            runner.store.appendMessage({
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

            if (leadId && bot.id !== leadId && !runner.aborting.has(roomId)) {
              runner.escalate({
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
          if (isPass) {
            runner.store.deleteMessage(roomId, res.messageId);
            log(`${bot.name} PASS`);
            return;
          }

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
          runner.dispatching.delete(dispatchKey);
        }
      })().catch((err) =>
        log(`【${room.name}】${bot.name} 这一轮异常：`, err?.message || err),
      ),
    );
  }
  await awaitPending(pending, stale);

  if (stale()) {
    log(`【${room.name}】用户插话 → 旧轮收手，改为按新要求重新开始`);
    return;
  }

  if (!runner.aborting.has(roomId) && leadId) {
    const lead = runner.store.getBot(leadId);
    const closing = lead
      ? planClosing({
          leadSpokeThisRound: isStrictlyAfter(roomId, roundStartMsgId, lastDoneIdOf(roomId, [leadId], runner.store), runner.store),
          memberSpokeAfterLead: isStrictlyAfter(
            roomId,
            lastDoneIdOf(roomId, [leadId], runner.store),
            lastDoneIdOf(roomId, participants, runner.store),
            runner.store,
          ),
        })
      : { needed: false, why: '找不到老大' };

    let closingResult = null;
    if (lead && closing.needed) {
      const leadKey = sessionKey(roomId, lead.id);
      runner.dispatching.add(leadKey);
      try {
        log(`【${room.name}】🗣 ${closing.why} → 叫 ${lead.name} 收尾`);
        const prompt = composeGroupPrompt(room, lead, transcriptFor(roomId, leadId, undefined, { store: runner.store }), {
          isLead: true,
          reason: '大家交完了，给用户一个最终结论',
          members,
          leadId,
          closing: true,
        });
        const res = await runner.run(roomId, lead.id, prompt, { groupTurn: true });
        closingResult = res;
        if (res.ok && res.text.trim()) {
          log(`【${room.name}】✅ 收尾完成（${res.text.trim().length} 字）`);
          const { found } = parseMentions(res.text, members, { selfId: lead.id });
          if (found.length) {
            log(
              `【${room.name}】⚠️ 收尾轮又 @ 了 ${found
                .map((id) => runner.store.getBot(id)?.name ?? id)
                .join('、')}，但本轮已收口，这些活留到下次`,
            );
          }
        } else {
          log(`【${room.name}】收尾没跑成：${res.error ?? '空回复'}`);
        }
        runner.store.setCursor(roomId, lead.id, lastMessageId(roomId, runner.store));
      } catch (err) {
        log(`【${room.name}】收尾异常：`, err?.message || err);
      } finally {
        runner.dispatching.delete(leadKey);
      }
    }
  }

  // ★ 主控总汇总：部门这一轮收口了，把负责人的结论回填到批次里。
  //   没有 summary 参数（用户在部门群直接派活）就什么都不做 —— 规格 §0 硬规矩 5。
  if (summary?.batchId) {
    try {
      const lead = leadId ? runner.store.getBot(leadId) : null;
      const target = {
        key: summary.targetKey || `group:${roomId}:${openerMessageId || ''}`,
        departmentId: roomId,
        departmentName: room.name,
        kind: 'group',
        refId: openerMessageId || '',
        status: closingResult?.ok ? 'done' : 'failed',
        leadSummary: String(closingResult?.text ?? ''),
        artifacts: [],
        sourceMsgId: closingResult?.messageId ?? null,
        error: closingResult?.ok ? '' : String(closingResult?.error || '收尾没跑成'),
      };
      const batch = runner.store.chiefSummary(summary.batchId);
      const main = runner.store.mainBot();
      const mainBusy = batch && main ? isMainChatBusy(runner, batch.originRoomId, main.id) : false;
      runner.store.noteChiefSummaryTarget(summary.batchId, target, { mainBusy });
      void runner.drainChiefSummaries?.().catch?.(() => {});
      log(`【${room.name}】📮 已回填主控汇总（${target.status}）`);
    } catch (err) {
      log(`【${room.name}】回填主控汇总失败：`, err?.message || err);
    }
  }

  const lastId = lastMessageId(roomId, runner.store);
  for (const m of members) {
    if (used.has(m.id) || called.has(m.id)) continue;
    runner.store.setCursor(roomId, m.id, lastId);
  }

  if (roundStartIndex >= 0 && runner.store.lessonsEnabled()) {
    void runner.reflect?.({ roomId, sinceIndex: roundStartIndex }).catch((err) =>
      log(`【${room.name}】复盘异常：`, err?.message || err),
    );
  }
}
