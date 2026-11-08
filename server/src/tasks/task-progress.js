/**
 * 运行结果的**分类与执行上下文校验**（纯逻辑：无 IO、无时钟）。
 *
 * ## 这一层要解决的问题
 *
 * `pi-runner.js` 现在的 `run()` 返回 `{ ok, text, ms, messageId }`。
 * 但 `ok: true` 只是「这一轮说完了」，它同时覆盖了：
 *
 *   · 正常返回；
 *   · 步数到上限被收住（`stepCapHit`）；
 *   · 群里来回轮数到上限；
 *   · 模型空回复后重试成功。
 *
 * 拿 `ok: true` 去推进任务状态，会把「让出」当成「完成」——这正是
 * 批次 01 里 `res.ok` 不得决定任务完成的同一条约束。
 *
 * 所以这里把「这一轮怎么结束的」独立成 `STOP`，并给出**唯一**的映射函数。
 *
 * ## 另一个问题：不能凭 taskRunId 非空就认定受管
 *
 * `pi-runner.js` 的 `taskRunId` 默认是 `newId('run_')` —— 那是**统计关联 ID**，
 * 不是持久 TaskRun。凭它非空就判断「这个任务由持久层管理」会把所有旧调用
 * 都误认成受管任务，进而绕过 `finishTask` 的旧语义。
 *
 * 所以受管判定必须要求一份**经过校验的执行上下文**：任务、版本、尝试、Bot
 * 都合法且互相自洽。缺一项就当作旧路径。
 */
import {
  STOP,
  ALL_STOPS,
  PHASE,
  EVENT,
  isCompletionEligibleStop,
  COMPLETION_ELIGIBLE_STOPS,
} from './task-contract.js';
import { createAttemptResult } from './task-attempt.js';
// ★ 占位/执行授权的阶段（reserved/started/settled/refunded）与
//   阶段报告种类（progress/apply_completion/...）是**两套不同的枚举**，
//   都叫 PHASE 会静默取到 undefined。这里给授权阶段一个明确别名。
import { PHASE as GRANT_PHASE } from './task-attempt-lifecycle.js';

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const isTime = (v) => Number.isFinite(v) && v > 0;

/**
 * 一轮执行的结束原因。
 *
 * 与 `run()` 返回形状的对应关系（这是**唯一**映射，别处不许再判断）：
 *
 * | 运行器事实 | STOP |
 * |---|---|
 * | 正常说完正文 | `returned` |
 * | 步数 / 轮数到上限被收住 | `yielded` |
 * | 在等审批 / 等输入 / 等子任务 | `waiting` |
 * | 出错、放弃重试 | `failed` |
 * | 用户终止 / 插话 | `cancelled` |
 * | 模型空回复且没恢复 | `failed` |
 * | 被跳过（比如没有任何可执行内容） | `skipped` |
 */
export function classifyStop({ ok, error, aborted, stepCapHit, roundCapHit, cancelled, empty } = {}) {
  // 终止优先：用户明确喊停，不管有没有正文
  if (cancelled || aborted) return STOP.cancelled;

  // 让出：达到上限被收住。**这不是完成**。
  if (stepCapHit || roundCapHit) return STOP.yielded;

  if (empty) return STOP.failed;

  if (!ok) return STOP.failed;

  return STOP.returned;
}

/**
 * 这次结束有没有资格成为「完成候选」。
 *
 * ★ 只有 `returned` 且**模型明确申请完成**才算候选。
 *   让出、失败、等待、跳过全都不算 —— 与批次 01 的
 *   `COMPLETION_ELIGIBLE_STOPS` 保持一致。
 *
 * @param {{stop:string, appliedCompletion?:boolean}} p
 */
export function isCompletionCandidate({ stop, appliedCompletion } = {}) {
  // ★ 复用契约里那份**唯一**的候选集合，不另写一套判断。
  //   批次 01 审查 R04 实测过两处各判一套的后果：
  //   辅助函数说「不算候选」，归约器却把任务推进了 verifying。
  if (!isCompletionEligibleStop(stop)) {
    return { candidate: false, why: whyNotCandidate(stop) };
  }
  if (!appliedCompletion) {
    return { candidate: false, why: '模型没有申请完成' };
  }
  return { candidate: true, why: '模型申请完成，进入验收' };
}

function whyNotCandidate(stop) {
  const map = {
    [STOP.yielded]: '达到执行段上限，已让出（不等于完成）',
    [STOP.failed]: '执行失败',
    [STOP.waiting]: '在等待外部条件',
    [STOP.cancelled]: '已取消',
    [STOP.skipped]: '这一轮没有真正执行',
  };
  return map[stop] ?? `结束原因 ${stop} 不能算完成`;
}

// ---------------------------------------------------------------------------
// 受管执行上下文
// ---------------------------------------------------------------------------

/** 受管上下文的解析结果。 */
export const MANAGED = Object.freeze({
  /** 调用方没提供上下文：旧调用，走旧路径 */
  legacy: 'legacy',
  /** 提供了且核对通过：受管执行 */
  managed: 'managed',
  /** 提供了但不合法：必须执行前拒绝，不能静默降级 */
  invalid: 'invalid',
});

/**
 * 解析并核对受管执行上下文。
 *
 * ## 三态，不是两态
 *
 *   · **没提供** → 旧调用，正常执行，不产生受管事件；
 *   · **提供了且核对通过** → 受管执行；
 *   · **提供了但不合法** → **执行前拒绝**。
 *
 * 第三种是关键：显式传了一份错的上下文却静默退回旧路径，
 * 会让调用方以为任务被托管了，实际什么也没记下。
 *
 * ## 存在 TaskRun 不等于存在有效执行授权
 *
 * 只核对「记录存在 + ID/revision/Bot 相符」不够 —— 那只能证明**有这么个任务**，
 * 不能证明**这一次执行被授权了**。还必须核对：
 *
 *   · 任务处于可执行状态（取消/完成/阻塞都不行）；
 *   · 这次 `attemptId` 在账本里**真的登记过**，且尚未结算；
 *   · 根预算上存在属于**这个任务+尝试+执行者+版本**的冻结授权，且已开始。
 *
 * 之所以要看根授权：执行必须花掉一份已经预留的额度。
 * 只有 queued 记录、没有任何授权就开跑，等于免额度执行。
 *
 * @param {object|null|undefined} ctx
 * @param {object} [opts]
 * @param {(id:string)=>({status:string, taskRun?:object})} [opts.loadTaskRun] 读真实记录
 * @param {(id:string)=>({status:string, taskRun?:object})} [opts.loadRootTaskRun] 读根记录
 * @param {string} [opts.actualBotId] 这次实际要执行的 Bot
 * @returns {{kind:string, context?:object, code?:string, text?:string}}}
 */
export function resolveManagedContext(ctx, {
  loadTaskRun = null,
  loadRootTaskRun = null,
  actualBotId = null,
} = {}) {
  // ---- 没提供：旧调用
  if (ctx === null || ctx === undefined) {
    return { kind: MANAGED.legacy, text: '没有受管上下文，按旧调用执行' };
  }

  const invalid = (code, text) => ({ kind: MANAGED.invalid, code, text });

  if (typeof ctx !== 'object' || Array.isArray(ctx)) {
    return invalid('bad_context', '受管上下文必须是对象');
  }

  const { taskRunId, revision, attemptId, botId } = ctx;

  if (!isId(taskRunId)) return invalid('bad_task_run_id', '受管上下文缺少合法的 taskRunId');
  if (!Number.isInteger(revision) || revision < 1) {
    return invalid('bad_revision', `受管上下文的 revision 不合法：${JSON.stringify(revision)}`);
  }
  if (!isId(attemptId)) return invalid('bad_attempt_id', '受管上下文缺少合法的 attemptId');
  if (!isId(botId)) return invalid('bad_bot_id', '受管上下文缺少合法的 botId');

  // ---- 执行者必须就是这次要跑的 Bot
  //   否则会出现「实际跑 A、事件署名 B」
  if (isId(actualBotId) && botId !== actualBotId) {
    return invalid(
      'bot_mismatch',
      `受管上下文署名给 ${botId}，这次实际执行的是 ${actualBotId} —— 不能替他人记账`,
    );
  }

  if (typeof loadTaskRun !== 'function') {
    return invalid('no_store_check', '无法访问任务存储，不能确认这份上下文属于真实任务');
  }

  let loaded;
  try {
    loaded = loadTaskRun(taskRunId);
  } catch (err) {
    return invalid('store_error', `读取任务失败：${err?.message || err}`);
  }

  const status = loaded?.status;
  if (status !== 'found' || !loaded?.taskRun) {
    return invalid(
      'task_not_found',
      `存储里没有可用的任务 ${taskRunId}（${status ?? '未知状态'}）—— 不能虚构一次受管执行`,
    );
  }

  const stored = loaded.taskRun;
  if (stored.id !== taskRunId) {
    return invalid('identity_mismatch', `记录 ${taskRunId} 里装的是任务 ${stored.id}`);
  }
  if (stored.revision !== revision) {
    return invalid(
      'revision_mismatch',
      `上下文说第 ${revision} 版目标，存储里是第 ${stored.revision} 版`,
    );
  }

  // ---- 任务状态必须允许执行
  if (stored.state === 'cancelled' || stored.state === 'completed') {
    return invalid(
      'task_not_executable',
      `任务当前是「${stored.state}」，不能再执行新的尝试`,
    );
  }
  if (stored.state === 'blocked') {
    return invalid('task_not_executable', '任务当前是「blocked」，不能再执行新的尝试');
  }

  // ---- 这次尝试必须真的登记过，且尚未结算
  const record = (stored.attempts ?? []).find((a) => a.attemptId === attemptId);
  if (!record) {
    return invalid(
      'attempt_not_registered',
      `账本里没有登记尝试 ${attemptId} —— 不能执行一次没有登记的执行`,
    );
  }
  if (record.taskRunId !== taskRunId) {
    return invalid(
      'attempt_owned_elsewhere',
      `尝试 ${attemptId} 属于任务 ${record.taskRunId}，不是 ${taskRunId}`,
    );
  }
  if (record.revision !== revision) {
    return invalid(
      'attempt_revision_mismatch',
      `尝试 ${attemptId} 属于第 ${record.revision} 版目标，上下文说第 ${revision} 版`,
    );
  }
  if (record.botId !== botId) {
    return invalid(
      'attempt_bot_mismatch',
      `尝试 ${attemptId} 登记的执行者是 ${record.botId}，不是 ${botId}`,
    );
  }
  if (record.state !== 'registered') {
    return invalid(
      'attempt_not_active',
      `尝试 ${attemptId} 当前是「${record.state}」，不是可执行的在途状态`,
    );
  }

  // ---- 必须有一份已开始的有效授权（不能用「重复扣款」来验证已预留的额度）
  const rootId = stored.rootTaskId ?? stored.id;
  if (typeof loadRootTaskRun === 'function') {
    let rootLoaded;
    try {
      rootLoaded = loadRootTaskRun(rootId);
    } catch (err) {
      return invalid('root_store_error', `读取根任务失败：${err?.message || err}`);
    }
    if (rootLoaded?.status !== 'found' || !rootLoaded?.taskRun) {
      return invalid('root_not_found', `找不到根任务 ${rootId}，无法确认执行授权`);
    }
    const grant = findGrant(rootLoaded.taskRun, { taskRunId, attemptId });
    if (!grant) {
      return invalid(
        'no_root_grant',
        `根上找不到「${taskRunId}::${attemptId}」的执行授权 —— 不能免额度执行`,
      );
    }
    if (grant.botId !== botId) {
      return invalid(
        'grant_bot_mismatch',
        `根授权给执行者 ${grant.botId}，上下文说 ${botId}`,
      );
    }
    if (grant.revision !== revision) {
      return invalid(
        'grant_revision_mismatch',
        `根授权属于第 ${grant.revision} 版目标，上下文说第 ${revision} 版`,
      );
    }
    if (grant.phase !== GRANT_PHASE.started) {
      return invalid(
        'grant_not_started',
        `根授权当前是「${grant.phase}」，必须已开始才算真正在跑`,
      );
    }
  }

  return {
    kind: MANAGED.managed,
    context: { taskRunId, revision, attemptId, botId, rootTaskId: rootId },
    text: '受管上下文核对通过',
  };
}

/** 在根记录里找一份属于指定任务+尝试的授权。 */
function findGrant(rootTaskRun, { taskRunId, attemptId }) {
  for (const slot of Object.values(rootTaskRun?.attemptSlots ?? {})) {
    if (!slot || slot.attemptId !== attemptId) continue;
    const owner = slot.taskRunId ?? rootTaskRun.id;
    if (owner === taskRunId) return slot;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 运行结果 → 契约字段的完整适配
// ---------------------------------------------------------------------------

/**
 * 把**运行器真实持有的事实**适配成 AttemptResult 需要的字段。
 *
 * ## 为什么不能只传 stop
 *
 * 只传停止原因的话，任务拿不到用量、产物和阶段 ——
 * 后续验收没东西可核，等待也没有门槛可引用。
 *
 * ## 未知就是未知
 *
 * 用量缺失时**不给**编一个 0，保持 null（契约允许），
 * 免得把「没测到」显示成「用了 0」。
 *
 * ## 审批就是 waiting
 *
 * 真实创建了 pending 审批时，这一轮不是「正常说完」，
 * 而是停在等待用户批准 —— 要带上门槛引用，否则任务不知道在等什么。
 */
export function adaptRunOutcome({
  ok = false,
  cancelled = false,
  aborted = false,
  timedOut = false,
  stepCapHit = false,
  empty = false,
  usage = null,
  artifacts = [],
  appliedCompletion = false,
  needsApproval = null,
  needsInput = null,
  waitingDependency = null,
  /** 本次结构化阶段报告（完整对象）。给了就按它构造 phase，不重建。 */
  report = null,
} = {}) {
  // ---- 停止原因
  let stop;
  if (cancelled || aborted) {
    // 用户明确停止才是 cancelled。
    // 超时不是用户取消 —— 那是运行失败，要能被重试。
    stop = STOP.cancelled;
  } else if (timedOut) {
    stop = STOP.failed;
  } else if (needsApproval || needsInput || waitingDependency) {
    // 真实等待：不是完成，也不是失败
    stop = STOP.waiting;
  } else if (stepCapHit) {
    stop = STOP.yielded;
  } else if (empty) {
    stop = STOP.failed;
  } else if (!ok) {
    stop = STOP.failed;
  } else {
    stop = STOP.returned;
  }

  // ---- 用量：按契约映射，未知保持 null
  const usageOut = mapUsage(usage);

  // ---- 产物：只认运行层收集到的真实文件
  const artifactList = Array.isArray(artifacts)
    ? artifacts.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()).slice(0, 200)
    : [];

  // ---- 阶段与等待引用
  //   等待类阶段必须带 waitFor（归约器靠它登记 pendingWait），
  //   不带会被契约拒绝 —— 也就无法形成真正的「在等什么」。
  let phase = null;
  let waiting = null;

  // ★ 合并顺序：**运行层真实等待事实优先**，模型声明只补充字段。
  //
  //   原来 report 分支排在最前并无条件用 report.kind 重建 phase，于是
  //   真实 policy 阻塞产生了 pending 审批、stop 已是 waiting，
  //   但模型报一句 progress/apply_completion 就把门槛抹掉 ——
  //   reduce/save 之后任务变 queued、openGates=[]，审批还挂在那儿。
  //
  //   现在：谁决定 kind 与等待引用，由运行事实说了算；
  //   模型只提供 claimedDone / claimedEvidence / unmet / note 这些声明字段。
  const runtimeWait = needsApproval
    ? { kind: 'approval', field: 'approvalId', ref: String(needsApproval) }
    : needsInput
      ? { kind: 'input', field: 'inputKey', ref: String(needsInput) }
      : waitingDependency
        ? { kind: 'dependency', field: 'dependencyTaskId', ref: String(waitingDependency) }
        : null;

  /** 模型声明字段（不是已验证成果）。 */
  const declarations = report && typeof report === 'object'
    ? {
        claimedDone: Array.isArray(report.claimedDone) ? report.claimedDone : [],
        claimedEvidence: Array.isArray(report.claimedEvidence) ? report.claimedEvidence : [],
        unmet: Array.isArray(report.unmet) ? report.unmet : [],
        note: typeof report.note === 'string' ? report.note : '',
      }
    : null;

  if (runtimeWait) {
    // ---- 真实等待优先：kind 与引用由运行事实决定
    const phaseKind = {
      approval: PHASE.need_approval,
      input: PHASE.need_input,
      dependency: PHASE.waiting_dependency,
    }[runtimeWait.kind];
    waiting = { kind: runtimeWait.kind, ref: runtimeWait.ref };
    phase = {
      kind: phaseKind,
      waitFor: { kind: runtimeWait.kind, [runtimeWait.field]: runtimeWait.ref },
      ...(declarations ?? {}),
    };
  } else if (report && typeof report === 'object' && report.kind) {
    // ---- 没有运行等待：按模型报告的阶段走，保留声明字段
    phase = {
      kind: report.kind,
      ...(declarations ?? {}),
    };
    const waitField = {
      need_approval: 'approvalId',
      need_input: 'inputKey',
      waiting_dependency: 'dependencyTaskId',
    }[report.kind];
    if (waitField) {
      const ref = report.waitFor?.[waitField];
      if (typeof ref === 'string' && ref.trim()) {
        waiting = { kind: report.kind.replace('need_', '').replace('waiting_', ''), ref: ref.trim() };
        phase.waitFor = { kind: waiting.kind, [waitField]: ref.trim() };
      }
    }
  } else if (stop === STOP.returned && appliedCompletion) {
    phase = { kind: PHASE.apply_completion };
  } else if (stop === STOP.returned || stop === STOP.yielded) {

    phase = { kind: PHASE.progress };
  }

  return { stop, usage: usageOut, artifacts: artifactList, phase, waiting };
}

/**
 * 运行器的 RunUsage 快照 → 契约 usage。
 *
 * 运行器给的是 { input, output, cacheRead, cacheWrite, inputTotal, calls,
 *              missingUsage, missingCacheUsage }，
 * 契约要的是 { runs, inputTokens, outputTokens, ms, unknown }。
 *
 * ## 保留原有的不确定性
 *
 *   · `inputTotal` 已经有值就直接用（它是运行器算好的总输入，别丢掉）；
 *   · 缓存缺失时**不当作 0** —— 那会把「未知」说成确定数字；
 *   · `missingUsage > 0` 时在 `unknown` 里如实标注部分缺失。
 *
 * ## runs 是执行次数，不是回复次数
 *
 * 运行器的 `calls` 是「一次执行里 assistant 回复了几次」，
 * 而契约的 `runs` 是「执行了几次」。两者单位不同，不能互填 ——
 * 所以 `runs` 由调用方给出，这里不传就保持 null。
 */
export function mapUsage(raw, { runs = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const unknown = [];

  // ---- 输入侧：优先用运行器算好的 inputTotal
  let inputTokens = numberOrNull(raw.inputTotal);
  if (inputTokens === null) {
    const input = numberOrNull(raw.input);
    const cacheRead = numberOrNull(raw.cacheRead);
    const cacheWrite = numberOrNull(raw.cacheWrite);

    if (input === null) {
      unknown.push('inputTokens');
    } else if (cacheRead === null || cacheWrite === null) {
      // 缓存未知：只报已知的 input，并标明缓存未计入
      inputTokens = input;
      unknown.push('cacheRead', 'cacheWrite');
    } else {
      inputTokens = input + cacheRead + cacheWrite;
    }
  }

  // ---- 输出侧
  const outputTokens = numberOrNull(raw.output);
  if (outputTokens === null) unknown.push('outputTokens');

  // ---- 运行器自己报告的部分缺失
  if (Number.isInteger(raw.missingUsage) && raw.missingUsage > 0) {
    if (!unknown.includes('inputTokens')) unknown.push('inputTokens(部分缺失)');
    if (!unknown.includes('outputTokens')) unknown.push('outputTokens(部分缺失)');
  }

  // ---- runs 只认调用方给的执行次数
  const runsOut = Number.isInteger(runs) && runs >= 0 ? runs : null;
  if (runsOut === null) unknown.push('runs');

  if (inputTokens === null && outputTokens === null && runsOut === null) return null;

  return { runs: runsOut, inputTokens, outputTokens, ms: null, unknown };
}

function numberOrNull(v) {
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// ---------------------------------------------------------------------------
// 与归约器的桥

// ---------------------------------------------------------------------------

/**
 * 把一轮运行结果翻译成「要不要向归约器发 attempt_finished，发什么」。
 *
 * ★ 这里**不**产生 `verification_finished`。
 *   验收通过必须由 `task-verification.js` 的可信验收产生，
 *   模型的 `apply_completion` 只是**申请**。
 *
 * @param {object} p
 * @param {string} p.stop 结束原因
 * @param {object} [p.context] 受管上下文（来自 resolveManagedContext）
 * @param {number} p.revision
 * @param {string} p.attemptId
 * @param {string} p.botId
 * @param {number} p.at
 * @param {object} [p.usage]
 * @param {string[]} [p.artifacts]
 * @param {object|null} [p.phase] 模型报的阶段
 * @returns {{emit:false, reason:string}|{emit:true, event:object}}
 */
export function planAttemptEvent({
  stop,
  context = null,
  revision,
  attemptId,
  botId,
  at,
  usage = null,
  artifacts = [],
  phase = null,
  waiting = null,
} = {}) {
  if (!context) {
    return { emit: false, reason: '不是受管执行，不向归约器发事件' };
  }
  if (!ALL_STOPS.includes(stop)) {
    return { emit: false, reason: `未知结束原因：${stop}` };
  }

  // ★ 复用已冻结的 `createAttemptResult`（批次 01），不自己拼字段。
  //   它才是 AttemptResult 形状的权威 —— 自己拼会漏校验、也会跟归约器错位。
  const built = createAttemptResult({
    taskRunId: context.taskRunId,
    revision,
    attemptId,
    botId,
    stop,
    usage,
    artifacts,
    phase,
    at,
  });
  if (!built.ok) {
    return { emit: false, reason: `尝试结果不合法：${built.text}` };
  }

  return {
    emit: true,
    event: {
      type: EVENT.attempt_finished,
      revision,
      attempt: built.attempt,
    },
    // 等待引用随计划带出：调用方据此建立等待门槛
    ...(waiting ? { waiting } : {}),
  };
}

/**
 * 旧路径兼容判定：这一轮该不该走 `finishTask(res.ok)`。
 *
 * ★ 审查要求「两处 finishTask(res.ok) 区分受管与旧路径」。
 *
 *   · 受管 TaskRun → **不**用 ok 判完成，交给归约器 + 验收；
 *   · 旧路径（部门任务 / 手工任务板 / 无任务）→ 保持原样。
 */
export function shouldUseLegacyFinishTask({ managed, hasLegacyTask }) {
  if (managed) return { legacy: false, reason: '受管 TaskRun 不走 finishTask(res.ok)' };
  if (!hasLegacyTask) return { legacy: false, reason: '没有旧任务，无需收尾' };
  return { legacy: true, reason: '旧路径保持 finishTask 语义' };
}

export { STOP, PHASE };