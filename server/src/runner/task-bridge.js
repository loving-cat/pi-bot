/**
 * 任务上下文、请求作用域、阶段报告核验与看门狗升级桥接。
 *
 * 负责将 `PiRunner` 的底层运行执行体接入：
 *   1. 心跳看门狗与失败升级（优先回原受管任务负责人，普通调用走 escalator）；
 *   2. 首次接单不可变请求信封（`withRequestEnvelope` / 排队防串轮）；
 *   3. 受管执行报告通道（`activateReportScope` / `releaseReportScope` / 等待对象真实性核验）。
 */
import { log } from '../util.js';
import { createWatchdog, stallCleanup } from '../watchdog.js';
import { createEscalator } from '../escalation.js';
import { deliverDirectInput } from '../direct-message-delivery.js';
import { requestIdentityKey } from '../tasks/task-request-result.js';
import { modelFailure } from '../model-reply.js';
import { sessionKey } from './runner-utils.js';

/** 启动或恢复心跳看门狗 */
export function startWatchdog(runner) {
  runner.watchdog ??= createWatchdog({
    sessions: runner.sessions,
    heartbeatMs: runner.config.heartbeatMs,
    stallMs: runner.config.stallMs,
    emit: (ev) => runner.bus.emit('event', ev),
    onStall: (info) => {
      const cleaned = stallCleanupEntry(runner, info);
      if (!cleaned) return;
      runner.escalate({
        roomId: cleaned.roomId,
        fromBotId: cleaned.botId,
        reason: `心跳断了：已经 ${cleaned.secs} 秒没动静，这一轮中断了`,
        prefer: 'lead',
      }).catch((err) => log('上报中断失败：', err?.message || err));
    },
  });
  runner.watchdog.start();
}

/** 收尾：捣掉这一轮 + 把它正在写的消息结掉（不收的话客户端永远转圈） */
export function stallCleanupEntry(runner, info) {
  info.entry?.turnController?.abort();
  return stallCleanup({ store: runner.store })(info);
}

/** 出事了往上抬：受管任务回原任务负责人，普通执行走 escalator（调 runner.run） */
export function escalateFailure(runner, args) {
  const runtime = runner.taskRuntime;
  if (runtime?.onEscalation) {
    // 身份来自这次失败执行自己的受管上下文；没有上下文才走旧逻辑
    const ctx = args?.roomId && args?.fromBotId
      ? runner.currentTaskContext(args.roomId, args.fromBotId)
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
  runner.__escalator ??= createEscalator({
    store: runner.store,
    run: (roomId, botId, text, opts) => runner.run(roomId, botId, text, opts),
    onError: (what, err) => log(`${what}：`, err?.message || err),
  });
  return runner.__escalator(args);
}

export function beginRequestScope(runner, roomId, botId, scope) {
  if (!scope) return null;
  runner.requestScopes.set(sessionKey(roomId, botId), scope);
  return scope;
}

export function endRequestScope(runner, roomId, botId, requestId = null) {
  const key = sessionKey(roomId, botId);
  const current = runner.requestScopes.get(key);
  if (!current) return;
  if (requestId && current.requestId !== requestId) return;
  runner.requestScopes.delete(key);
}

export function currentRequestScope(runner, roomId, botId) {
  return runner.requestScopes.get(sessionKey(roomId, botId)) ?? null;
}

export function setRequestDecision(runner, _roomId, _botId, scope, kind, extra = null) {
  if (!scope?.requestId) return;
  runner.requestDecisions.set(requestIdentityKey(scope.requesterId, scope.requestId), { kind, ...(extra ?? {}) });
}

export function requestDecisionOf(runner, scope) {
  return scope ? runner.requestDecisions.get(requestIdentityKey(scope.requesterId, scope.requestId)) ?? null : null;
}

export function queueAdmittedTask(runner, taskRunId) {
  if (taskRunId) runner.admittedQueue.push(taskRunId);
}

export function flushAdmitted(runner) {
  for (const id of runner.admittedQueue.splice(0)) {
    try {
      const runtime = runner.taskRuntime;
      if (runtime?.notifyAdmitted) runtime.notifyAdmitted(id).catch(() => {});
      else if (runtime?.supervisor?.notify) Promise.resolve(runtime.supervisor.notify(id)).catch(() => {});
    } catch {}
  }
}

/** 不可变信封形状校验；不合格直接拒绝，不退回 legacy 执行。 */
export function assertRequestEnvelope(request) {
  if (!request?.scope?.requesterId || !request.scope.requestId || !request.scope.fingerprint) {
    throw Object.assign(new Error('请求信封不完整'), { code: 'BAD_REQUEST_ENVELOPE' });
  }
}

/** 理解轮真正取得执行权后激活；该轮真正结束后收尾。 */
export async function withRequestEnvelope(runner, request, roomId, botId, fn) {
  const scope = request.scope;
  const active = currentRequestScope(runner, roomId, botId);
  if (active && requestIdentityKey(active.requesterId, active.requestId) !== requestIdentityKey(scope.requesterId, scope.requestId)) {
    throw Object.assign(new Error('同一会话已有另一个请求身份在执行'), { code: 'REQUEST_SCOPE_CONFLICT' });
  }
  // ★ 关闭接单开关时不建立请求作用域，保持默认普通聊天放行组织能力。
  if (runner.taskIntakeEnabled) beginRequestScope(runner, roomId, botId, scope);
  let failure = null;
  let verdict = null;
  try {
    await fn();
    verdict = requestDecisionOf(runner, scope);
    return verdict;
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    endRequestScope(runner, roomId, botId, scope.requestId);
    runner.requestDecisions.delete(requestIdentityKey(scope.requesterId, scope.requestId));
    // ★ 日常私聊与 Jarvis 即时控制零额外轮次延迟：没调 accept_task 时默认按 'answer' 收口，
    //   若本轮已落盘权威 TaskRun，closeRequest 内部会自动保住 stage='accepted'。
    const closeKind = verdict?.kind ?? 'answer';
    runner.requestLifecycle?.close?.(scope, failure, closeKind);
    // 首次准入与自然改版都等本轮理解释放后再启动受管执行，不抢当前会话。
    flushAdmitted(runner);
  }
}

/** 忙时排队：只存信封本身，等真正空闲再单独跑一轮。 */
export function enqueueRequest(runner, roomId, item) {
  const list = runner.requestQueues.get(roomId) ?? [];
  const identity = requestIdentityKey(item.request.scope.requesterId, item.request.scope.requestId);
  if (!list.some((x) => requestIdentityKey(x.request.scope.requesterId, x.request.scope.requestId) === identity)) list.push(item);
  runner.requestQueues.set(roomId, list);
}

/** 排空该房间待执行请求（一次一封，避免身份串轮）。 */
export async function drainRequestQueue(runner, roomId, botId) {
  const list = runner.requestQueues.get(roomId);
  if (!list?.length || runner.isBusy(roomId, botId)) return;
  const item = list.shift();
  if (!item) return;
  try {
    const result = await deliverDirectInput({
      prepare: () => runner.buildInput(item.text, item.files, roomId),
      run: ({ promptText }) => withRequestEnvelope(runner, item.request, roomId, botId, () =>
        runner.run(roomId, botId, promptText, { skipUserMessage: true, attachments: item.files, human: true })),
      getEntry: () => runner.sessions.get(sessionKey(roomId, botId)),
      isCancelled: () => runner.aborting.has(roomId),
      queue: async () => { throw Object.assign(new Error('请求已在队列中'), { code: 'REQUEST_QUEUED' }); },
      accepted: () => {},
    });
    if (result?.ok !== false) {
      const msg = runner.store.updateMessage(roomId, item.messageId, { meta: { queued: false } });
      if (msg) runner.bus.emit('event', { t: 'msg.updated', roomId, msg });
    }
  } catch (err) {
    const error = modelFailure(err).error;
    const msg = runner.store.updateMessage(roomId, item.messageId, { status: 'error', error });
    runner.bus.emit('event', { t: 'msg.error', roomId, msgId: item.messageId, error, msg });
  } finally {
    if ((runner.requestQueues.get(roomId)?.length ?? 0) > 0) {
      setTimeout(() => { void drainRequestQueue(runner, roomId, botId); }, 0);
    }
  }
}

export function abortManagedTask(runner, taskRunId) {
  const entry = runner.managedInflight.get(taskRunId);
  if (!entry) return { ok: false, code: 'not_inflight' };
  const session = entry.session ?? runner.sessions.get(entry.key)?.session ?? null;
  if (!session?.abort) return { ok: false, code: 'no_session' };
  try {
    session.abort();
  } catch {}
  return { ok: true, attemptId: entry.attemptId ?? null };
}

/** 激活报告 scope（只能在真正取得会话执行权之后调用） */
export function activateReportScope(runner, key, collector) {
  if (!collector) return false;
  const stale = runner.reportScopes.get(key);
  if (stale) {
    log('报告收集器键被占用，替换掉上一轮残留：', key);
    runner.reportScopes.delete(key);
  }
  runner.reportScopes.set(key, collector);
  return true;
}

/** 释放报告 scope：只摘自己那份 */
export function releaseReportScope(runner, key, collector) {
  if (!collector) return;
  if (runner.reportScopes.get(key) === collector) {
    runner.reportScopes.delete(key);
  }
}

/** 从宿主盘点可交接的部门候选 */
export function candidateDepartmentIds(runner, roomId, _botId) {
  const current = runner.store.getRoom(roomId);
  const departmentId = current?.departmentId ?? null;
  const ids = [];
  for (const room of runner.store.listRooms?.() ?? []) {
    if (room.kind !== 'group') continue;
    if (room.id === roomId) continue;
    if (departmentId && room.departmentId === departmentId) continue;
    const lead = room.leadBotId ? runner.store.getBot(room.leadBotId) : null;
    if (!lead) continue;
    ids.push(room.id);
  }
  return ids.slice(0, 50);
}

/** 当前受管执行的上下文（身份必须来自宿主，不能从模型输出读） */
export function currentTaskContext(runner, roomId, botId) {
  const entry = runner.sessions.get(sessionKey(roomId, botId));
  return entry?.managedContext ?? null;
}

/** 策略钩子报告的真实阻塞：记到当前活跃的受管执行上 */
export function notePolicyBlocked(runner, roomId, botId, approval, info = {}) {
  const collector = runner.reportScopes.get(roomId + ':' + botId);
  if (!collector) return;
  collector.noteBlocked?.(approval, info);
}

/** 报告工具 execute 的落点 —— 唯一被验证的收集入口 */
export function collectReport(runner, roomId, botId, input) {
  const collector = runner.reportScopes.get(roomId + ':' + botId);
  if (!collector) {
    return { ok: false, why: '这次执行没有报告通道（不是受管轮次，或已经结束）' };
  }

  const verdict = verifyReportWait(runner, roomId, botId, input);
  if (!verdict.ok) {
    return verdict;
  }
  return collector.accept(input);
}

/** 核对一条报告里的等待对象是否真实、且属于这次执行 */
export function verifyReportWait(runner, roomId, botId, input) {
  const phase = String(input?.phase ?? input?.kind ?? '').trim();
  if (!phase.startsWith('need_') && phase !== 'waiting_dependency') return { ok: true };

  const waitFor = input?.waitFor;
  if (!waitFor || typeof waitFor !== 'object') {
    return { ok: false, why: phase + ' 必须说明在等什么（缺 waitFor）' };
  }

  if (phase === 'need_approval') {
    const id = String(waitFor.approvalId ?? waitFor.ref ?? '').trim();
    if (!id) return { ok: false, why: 'need_approval 缺少 approvalId' };

    const approval = (runner.store.state.approvals ?? []).find((a) => a.id === id);
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

    const collector = runner.reportScopes.get(roomId + ':' + botId);
    if (!collector?.sawBlocked?.(id)) {
      return {
        ok: false,
        why: '审批 ' + id + ' 不是这次执行实际遇到的操作阻塞 —— 不能借来当等待',
      };
    }
    return { ok: true };
  }

  if (phase === 'need_input') {
    const key = String(waitFor.inputKey ?? waitFor.ref ?? '').trim();
    if (!key) return { ok: false, why: 'need_input 缺少 inputKey' };
    return { ok: true };
  }

  if (phase === 'waiting_dependency') {
    const depId = String(waitFor.dependencyTaskId ?? waitFor.ref ?? '').trim();
    if (!depId) return { ok: false, why: 'waiting_dependency 缺少 dependencyTaskId' };
    const loaded = runner.store.taskRuns.read(depId);
    if (loaded.status !== 'found' || !loaded.taskRun) {
      return { ok: false, why: '找不到依赖任务 ' + depId + ' —— 不能凭空生成等待' };
    }
    return { ok: true };
  }

  return { ok: true };
}
