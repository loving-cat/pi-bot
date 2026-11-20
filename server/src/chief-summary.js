/**
 * 主控总汇总（chief summary）—— 纯逻辑：批次状态机、汇聚就绪判定、三选一动作。
 *
 * 规格：`docs/SPEC-CHIEF-SUMMARY.md`（v1.0）§2。
 *
 * ## 一句话
 *
 * 用户在 **主控私聊** 派活 → 各部门各自收口 → 批次就绪后由 `mainBot` 回到私聊做**统一汇总**；
 * 撞上主控正忙就先阻塞、**懒生成**（绝不提前调模型），界面右上角三选一：
 * **是（发送）/ 否（留角标稍后）/ 忽略（放弃汇总，结果留在各部门群）**。
 *
 * ## 为什么这些要写成纯函数
 *
 * 状态字面量一旦散在 HTTP 路由、前端和 runner 里各拼一份，就会出现"界面显示已发送、
 * 后台其实还在 queued"这类幽灵状态。所以：
 *   · 所有状态流转只在 `resolveSummary()` / `advanceSummary()` 里发生；
 *   · 别处只允许**读**状态，不许写字符串。
 *
 * 本文件零 IO：不 import store / config / fs，时钟与忙碌态都从参数进来。
 */

/** 批次状态（顺序即生命周期，终态是最后两个） */
export const SUMMARY_STATES = Object.freeze([
  'collecting',
  'ready_blocked',
  'deferred',
  'queued_send',
  'sending',
  'sent',
  'ignored',
]);

/**
 * 汇总交卷轮里被硬拦的工具（规格 §3.3「硬防循环派活」）。
 *
 * 汇总轮的任务是**如实汇报**：缺什么说什么、问用户要不要返工。
 * 如果允许它自己再 `dispatch_to_department` / 建部门 / 接新任务，就会无限套娃
 * —— 汇总 → 再派活 → 再汇总 → 再派活。
 */
export const SUMMARY_TURN_BLOCKED_TOOLS = Object.freeze([
  'dispatch_to_department',
  'create_department',
  'accept_task',
]);

/** 这句会在被拦时原样返回给模型 —— 要能指导它下一步该干什么，而不是只说"不行" */
export const SUMMARY_TURN_BLOCK_MESSAGE =
  '当前是**汇总交卷轮**：请直接面向用户汇报各部门的交付结果与缺口，' +
  '缺项如实说明并询问用户是否需要返工。禁止在本轮自行建组、再派活或接新任务。';

/** 这轮是不是汇总轮 + 这个工具要不要拦（纯函数，工具入口统一调它） */
export function isToolBlockedInSummaryTurn(toolName, { summaryTurn = false } = {}) {
  return summaryTurn === true && SUMMARY_TURN_BLOCKED_TOOLS.includes(String(toolName ?? ''));
}

/** 用户能做的三个动作 */
export const SUMMARY_ACTIONS = Object.freeze(['send', 'defer', 'ignore']);

/** 单个派活目标的状态 */
export const TARGET_STATUSES = Object.freeze(['running', 'done', 'failed']);

/** 上限（改这里就等于改预算，别在别处写魔法数字） */
export const CHIEF_SUMMARY_LIMITS = Object.freeze({
  /** 账本最多留几条（超了先清终态） */
  total: 50,
  /** 终态（sent / ignored）保留多久，过期自动清 */
  terminalTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** 部门负责人结论截断 */
  leadSummary: 2000,
  /** 浮窗标题截断 */
  title: 28,
  /** 单个目标最多留几个产物 */
  artifacts: 20,
  /** URL / id 类字段 */
  id: 64,
});

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** 终态：不再需要用户操作，也不会再调模型 */
export function isTerminalState(state) {
  return state === 'sent' || state === 'ignored';
}

/** 需要用户在界面上决定的状态（浮窗 / 角标要展示的） */
export function isPendingState(state) {
  return state === 'ready_blocked' || state === 'deferred';
}

/** 正排队等主控空闲 */
export function isQueuedState(state) {
  return state === 'queued_send' || state === 'sending';
}

function normalizeArtifacts(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || item === undefined) continue;
    const value = typeof item === 'string' ? item : item?.path ?? item?.name ?? '';
    const text = str(value, 400);
    if (!text) continue;
    out.push(text);
    if (out.length >= CHIEF_SUMMARY_LIMITS.artifacts) break;
  }
  return out;
}

/** 规范化一个派活目标 */
export function normalizeSummaryTarget(raw = {}) {
  const departmentId = str(raw.departmentId, CHIEF_SUMMARY_LIMITS.id);
  const refId = str(raw.refId, CHIEF_SUMMARY_LIMITS.id);
  const kind = raw.kind === 'taskRun' ? 'taskRun' : 'group';
  if (!departmentId && !refId) return null;
  const status = TARGET_STATUSES.includes(raw.status) ? raw.status : 'running';
  return {
    key: str(raw.key, 160) || `${kind}:${departmentId}:${refId}`,
    departmentId,
    departmentName: str(raw.departmentName, 60),
    kind,
    refId,
    status,
    leadSummary: str(raw.leadSummary, CHIEF_SUMMARY_LIMITS.leadSummary),
    artifacts: normalizeArtifacts(raw.artifacts),
    sourceMsgId: raw.sourceMsgId ? str(raw.sourceMsgId, CHIEF_SUMMARY_LIMITS.id) : null,
    error: str(raw.error, 400),
    finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : 0,
  };
}

/** 规范化一个批次（形状固定；没有 id 或没有目标就丢掉） */
export function normalizeSummaryBatch(raw = {}, now = 0) {
  const id = str(raw.id, CHIEF_SUMMARY_LIMITS.id);
  if (!id) return null;
  const targets = [];
  for (const item of Array.isArray(raw.targets) ? raw.targets : []) {
    const target = normalizeSummaryTarget(item);
    if (target) targets.push(target);
  }
  if (!targets.length) return null;
  const state = SUMMARY_STATES.includes(raw.state) ? raw.state : 'collecting';
  return {
    id,
    originTurnKey: str(raw.originTurnKey, 160),
    originRoomId: str(raw.originRoomId, CHIEF_SUMMARY_LIMITS.id),
    originMessageId: raw.originMessageId ? str(raw.originMessageId, CHIEF_SUMMARY_LIMITS.id) : null,
    taskTitle: str(raw.taskTitle, CHIEF_SUMMARY_LIMITS.title),
    dispatchOpen: raw.dispatchOpen !== false, // 缺省视为"还在派活"，宁可晚一点就绪
    targets,
    state,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    readyAt: Number.isFinite(raw.readyAt) ? raw.readyAt : 0,
    resolvedAt: Number.isFinite(raw.resolvedAt) ? raw.resolvedAt : 0,
    summaryMessageId: raw.summaryMessageId ? str(raw.summaryMessageId, CHIEF_SUMMARY_LIMITS.id) : null,
    // 上一次发送失败的原因（只给人看，不参与状态机）；不保留的话退回 ready_blocked 后就查不到了
    lastError: raw.lastError ? str(raw.lastError, 200) : '',
    lastErrorAt: Number.isFinite(raw.lastErrorAt) ? raw.lastErrorAt : 0,
  };
}

/** 规范化整个账本：去无效、按 id 去重、按保留策略清理 */
export function normalizeSummaryBatchList(list = [], now = 0) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const batch = normalizeSummaryBatch(item, now);
    if (!batch || seen.has(batch.id)) continue;
    seen.add(batch.id);
    out.push(batch);
  }
  out.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)); // 新 → 旧
  return selectSummaryRetention(out, { now });
}

/** 同轮聚合键：主控这一轮的 liveMsgId 或根 taskRunId */
export function turnKeyFor({ liveMsgId = '', taskRunId = '' } = {}) {
  if (liveMsgId) return `msg:${liveMsgId}`;
  if (taskRunId) return `task:${taskRunId}`;
  return '';
}

/**
 * 批次是否就绪。
 *
 * 三条规则（规格 §2.2）：
 *   1. 发起轮必须封口（`dispatchOpen === false`）—— 否则部门 A 回得比派活快，
 *      会在还有部门没派出去时就"就绪"，汇总漏掉后面那个部门；
 *   2. 至少有一个目标；
 *   3. **任意一个失败立刻就绪**，或者**全部完成**才就绪。
 *
 * ⚠️ 第 3 条不能写成"所有目标都到终态"：A 部门 10 秒就 `failed`、B 部门还要跑
 * 10 分钟时，那条写法会让 A 的失败被 B 活生生拖满 10 分钟 —— 正是规格里
 * 「失败 / 受阻不傻等」要禁止的。已经失败的部门没必要再等别人。
 */
export function isBatchReady(batch) {
  if (!batch || batch.dispatchOpen !== false) return false;
  if (!Array.isArray(batch.targets) || !batch.targets.length) return false;
  if (batch.targets.some((t) => t.status === 'failed')) return true;
  return batch.targets.every((t) => t.status === 'done');
}

/**
 * 根据「当前进度 + 主控忙不忙」推进状态（只在非终态、且用户还没做选择时生效）。
 *
 * - 没就绪 → `collecting`
 * - 就绪 + 用户已 defer / 已排队 → 保持（用户的意思不该被自动改掉）
 * - 就绪 + 主控忙 → `ready_blocked`（懒汇总：不调模型）
 * - 就绪 + 主控闲 → `sending`（调用方负责真的发）
 */
export function advanceSummary(batch, { mainBusy = false, now = 0 } = {}) {
  if (!batch) return batch;
  if (isTerminalState(batch.state)) return batch;
  if (!isBatchReady(batch)) {
    return batch.state === 'collecting' ? batch : { ...batch, state: 'collecting', readyAt: 0 };
  }
  if (batch.state === 'deferred' || batch.state === 'queued_send' || batch.state === 'sending') {
    return batch;
  }
  const readyAt = batch.readyAt || now;
  return { ...batch, readyAt, state: mainBusy ? 'ready_blocked' : 'sending' };
}

/**
 * 用户三选一（规格 §2.3）。**幂等**：已在终态的批次再点也不会变。
 *
 * @param {object} batch
 * @param {'send'|'defer'|'ignore'} action
 * @param {{ mainBusy?: boolean, now?: number }} [opts]
 */
export function resolveSummary(batch, action, { mainBusy = false, now = 0 } = {}) {
  if (!batch) return batch;
  if (isTerminalState(batch.state)) return batch;
  if (!SUMMARY_ACTIONS.includes(action)) return batch;

  if (action === 'ignore') {
    return { ...batch, state: 'ignored', resolvedAt: now };
  }
  if (action === 'defer') {
    // 正在发不许拉回"待看"（那会让已经发出的汇总在界面上复活成待确认）；
    // 但**已排队**的允许改主意 —— 用户反悔不该被锁死。
    if (batch.state === 'sending') return batch;
    // 没到就绪就别让它进"待看"：否则用户点开只看到一堆还没跑完的部门
    if (!isBatchReady(batch)) return batch;
    return { ...batch, state: 'deferred' };
  }
  // send：主控空闲就立即发，忙就排队等这一轮结束（绝不打断当前对话）
  // ★ 幂等：已在发送 / 已排队时**原样返回同一个对象**。
  //   返回新对象会让 store 的 `next === current` 判假，Stage 2 接线后会**发第二条汇总**；
  //   而 mainBusy=true 时再算一次还会把 sending 倒退回 queued_send。
  if (batch.state === 'sending' || batch.state === 'queued_send') return batch;
  if (!isBatchReady(batch)) return batch;
  return { ...batch, readyAt: batch.readyAt || now, state: mainBusy ? 'queued_send' : 'sending' };
}

/** 汇总真的发出去了（调用方拿到消息 id 后回填） */
export function markSummarySent(batch, { messageId = null, now = 0 } = {}) {
  if (!batch) return batch;
  return {
    ...batch,
    state: 'sent',
    resolvedAt: now,
    summaryMessageId: messageId ? str(messageId, CHIEF_SUMMARY_LIMITS.id) : batch.summaryMessageId,
  };
}

/**
 * 汇总轮自己失败了（429 / 超时 / 异常）：从 `sending` 退回 `ready_blocked`。
 *
 * 不退的话批次会永久卡在 `sending` 这个"幽灵态" —— 用户既看不到浮窗（不是 ready_blocked），
 * 也永远等不到发送结果。退回后用户还能再点「是」重试或「忽略」。
 * 其它状态（尤其已 `sent` / `ignored`）一律不动。
 */
export function markSummarySendFailed(batch, { reason = '', now = 0 } = {}) {
  if (!batch || batch.state !== 'sending') return batch;
  return {
    ...batch,
    state: 'ready_blocked',
    lastError: str(reason, 200),
    lastErrorAt: now,
  };
}

/** 往批次里加/更新一个目标（同 `key` 覆盖，避免重复部门刷屏） */
export function upsertSummaryTarget(batch, rawTarget, { now = 0 } = {}) {
  if (!batch) return batch;
  const target = normalizeSummaryTarget(rawTarget);
  if (!target) return batch;
  if (isTerminalState(batch.state) && batch.state === 'sent') {
    // 已交卷：晚到的部门回报只落库，不再影响状态（规格 §2.2 晚到刷新）
    const exists = batch.targets.some((t) => t.key === target.key);
    const targets = exists
      ? batch.targets.map((t) => (t.key === target.key ? target : t))
      : [...batch.targets, target];
    return { ...batch, targets };
  }
  const finishedAt = target.status === 'running' ? 0 : target.finishedAt || now;
  const exists = batch.targets.some((t) => t.key === target.key);
  const targets = exists
    ? batch.targets.map((t) => (t.key === target.key ? { ...target, finishedAt } : t))
    : [...batch.targets, target];
  return { ...batch, targets };
}

/** 发起轮封口：此后才会参与就绪判定 */
export function sealDispatch(batch, { mainBusy = false, now = 0 } = {}) {
  if (!batch) return batch;
  return advanceSummary({ ...batch, dispatchOpen: false }, { mainBusy, now });
}

/**
 * 从一个部门这一轮的产出里挑出"交付包"（规格 §3.1 群收尾回传）。
 *
 * ★ 关键：`closing.needed === false` 是**很常见的正常成功**
 *   （单人部门、负责人直接答完没人再被 @）。这时没有独立收尾轮，
 *   不能因此把整个部门记成 `failed` —— 要回落到负责人本轮发言、再回落到最后一条成员发言。
 *
 * @param {{ closingResult?: object, leadResult?: object, lastResult?: object }} input
 * @returns {{ status: 'done'|'failed', leadSummary: string, artifacts: string[],
 *            sourceMsgId: string|null, error: string }}
 */
export function pickDepartmentDelivery({ closingResult = null, leadResult = null, lastResult = null } = {}) {
  const okResult = (r) => (r && r.ok === true && String(r.text ?? '').trim() ? r : null);
  const pick = okResult(closingResult) ?? okResult(leadResult) ?? okResult(lastResult) ?? null;
  if (!pick) {
    return {
      status: 'failed',
      leadSummary: '',
      artifacts: [],
      sourceMsgId: null,
      error: String(closingResult?.error || '本轮没有任何成功产出'),
    };
  }
  return {
    status: 'done',
    leadSummary: String(pick.text ?? ''),
    artifacts: Array.isArray(pick.artifacts) ? pick.artifacts : [],
    sourceMsgId: pick.messageId ?? null,
    error: '',
  };
}

/**
 * 受管任务里「还在跑」的状态集合。
 *
 * ⚠️ 不能包含 `blocked` / `paused_budget`：它们在 `reportTerminal` 里已经上报过终态，
 * 留在集合里会让批次永远封不了口（永久死锁）。
 */
export const TASK_RUN_ACTIVE_STATES = Object.freeze(['queued', 'running', 'waiting_approval']);

/**
 * 同一根任务下是否还有**兄弟部门子任务**在跑。
 *
 * 两个必须的过滤：
 *   ① 只数**带 `departmentId` 的**子任务 —— 根任务 R 自己也在 listAll 里，
 *      把它算进来就等于"永远还有一个在跑"；
 *   ② 排除自己（本次正在上报的那个）。
 */
export function hasRunningSiblingTask(allRuns = [], { runId = '', rootId = '' } = {}) {
  const active = new Set(TASK_RUN_ACTIVE_STATES);
  return (Array.isArray(allRuns) ? allRuns : []).some(
    (r) =>
      r &&
      r.id !== runId &&
      Boolean(r.owner?.departmentId) &&
      (r.rootTaskId ?? r.id) === rootId &&
      active.has(r.state),
  );
}

/**
 * 受管任务这次终态上报后，要不要封口这个汇总批次。
 *
 * - 还有兄弟在跑 → 不封（等它们）；
 * - 本次不是 `completed`（受阻/额度暂停/失败）→ **立刻封**，快速失败（规格 §2.2「不傻等」）。
 */
export function shouldSealTaskRunBatch({ run = null, allRuns = [], rootId = '' } = {}) {
  if (!run) return false;
  const siblings = hasRunningSiblingTask(allRuns, { runId: run.id, rootId });
  return !siblings || run.state !== 'completed';
}

/**
 * 从本轮成功产出里挑负责人的**最后一条**发言。
 *
 * 负责人一轮里可能说两次（开头派活 `@A @B`、末尾结论），
 * 取第一条会把派活话当成交付结论回传给主控。
 */
export function pickLeadResult(successes = [], leadId = '') {
  if (!leadId) return null;
  const list = Array.isArray(successes) ? successes : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.botId === leadId) return list[i].res ?? null;
  }
  return null;
}

/** 给浮窗用的进度文案数据（纯计算，不做文案拼接以外的判断） */
export function summarizeProgress(batch) {
  const targets = Array.isArray(batch?.targets) ? batch.targets : [];
  const done = targets.filter((t) => t.status === 'done');
  const failed = targets.filter((t) => t.status === 'failed');
  const running = targets.filter((t) => t.status === 'running');
  return {
    total: targets.length,
    done: done.length,
    failed: failed.length,
    running: running.length,
    ready: isBatchReady(batch),
    failedNames: failed.map((t) => t.departmentName || t.departmentId),
    runningNames: running.map((t) => t.departmentName || t.departmentId),
  };
}

/**
 * 保留策略（规格 §2.1）：终态过期清掉；超过上限先清终态、再清最老的。
 *
 * 返回**保留**的列表（已排序：新 → 旧）。调用方负责落盘。
 */
export function selectSummaryRetention(list = [], { now = 0, max = CHIEF_SUMMARY_LIMITS.total, ttlMs = CHIEF_SUMMARY_LIMITS.terminalTtlMs } = {}) {
  const batches = (Array.isArray(list) ? list : []).filter(Boolean);
  const alive = batches.filter((b) => {
    if (!isTerminalState(b.state)) return true;
    const at = Number(b.resolvedAt || b.readyAt || b.createdAt) || 0;
    return now - at <= ttlMs;
  });
  if (alive.length <= max) return alive;

  // 先丢终态（从最老的开始），还不够再丢未终结里最老的 —— 宁可丢记录也不能让账本无限长
  const terminal = alive
    .filter((b) => isTerminalState(b.state))
    .sort((a, b) => (Number(a.resolvedAt || a.createdAt) || 0) - (Number(b.resolvedAt || b.createdAt) || 0));
  const keep = new Set(alive);
  let overflow = alive.length - max;
  for (const batch of terminal) {
    if (overflow <= 0) break;
    keep.delete(batch);
    overflow -= 1;
  }
  if (overflow > 0) {
    const rest = [...keep].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    for (const batch of rest) {
      if (overflow <= 0) break;
      keep.delete(batch);
      overflow -= 1;
    }
  }
  return alive.filter((b) => keep.has(b));
}
