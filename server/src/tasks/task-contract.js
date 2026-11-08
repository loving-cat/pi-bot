/**
 * 持续任务的**契约常量与迁移表**（纯数据，无 IO、无状态）。
 *
 * 本文件只放"定义"：状态、事件、停止原因、验收种类、迁移边。
 * 校验在 `task-goal.js` / `task-attempt.js`，归约在 `task-reduce.js`，
 * 界面投影在 `task-projection.js` —— 分开是为了让每层能单独测，
 * 也避免一个文件里同时有"定义"和"判定"时改一处漏一处。
 *
 * ## 三层结束含义（本轮核心）
 *
 *   | 对象      | 结束含义                              |
 *   |-----------|---------------------------------------|
 *   | Message   | `msg.done`：这条输出写完              |
 *   | Attempt   | 一次**有界**执行结束（返回/让出/失败） |
 *   | TaskRun   | 目标达成 / 明确阻塞 / 预算耗尽 / 取消  |
 *
 * 模型只能**申请**完成并提交证据；`completed` 只能由验收通过写入。
 */

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export const STATE = Object.freeze({
  queued: 'queued',
  running: 'running',
  verifying: 'verifying',
  waiting_approval: 'waiting_approval',
  waiting_input: 'waiting_input',
  waiting_dependency: 'waiting_dependency',
  paused_user: 'paused_user',
  paused_budget: 'paused_budget',
  blocked: 'blocked',
  completed: 'completed',
  cancelled: 'cancelled',
});

export const ALL_STATES = Object.freeze(Object.values(STATE));

export const TERMINAL_STATES = Object.freeze([STATE.completed, STATE.cancelled]);

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * 三种"等待"状态：它们在等一个**具体的**外部条件。
 *
 * 单独归类是因为它们必须能承受暂停再恢复 —— 见 `PAUSE_CARRIES_WAITING`。
 */
export const WAITING_STATES = Object.freeze([
  STATE.waiting_approval,
  STATE.waiting_input,
  STATE.waiting_dependency,
]);

export function isWaiting(state) {
  return WAITING_STATES.includes(state);
}

/**
 * 等待状态 ↔ 它要求的等待种类。
 *
 * 用来在恢复时校验"解除的等待"和"原来在等的"是不是同一件事 ——
 * 否则用户批准了 A 动作，任务却把 B 动作的等待也一起解除了。
 */
export const WAIT_KIND = Object.freeze({
  approval: 'approval',
  input: 'input',
  dependency: 'dependency',
});

export const WAIT_STATE_OF = Object.freeze({
  [WAIT_KIND.approval]: STATE.waiting_approval,
  [WAIT_KIND.input]: STATE.waiting_input,
  [WAIT_KIND.dependency]: STATE.waiting_dependency,
});

export const WAIT_KIND_OF_STATE = Object.freeze({
  [STATE.waiting_approval]: WAIT_KIND.approval,
  [STATE.waiting_input]: WAIT_KIND.input,
  [STATE.waiting_dependency]: WAIT_KIND.dependency,
});

/**
 * 每种状态的**恢复条件**。null 表示终态，无恢复。
 *
 * 推进器只认这张表：不该出现"这个状态该等什么"散落在几个 if 分支里。
 */
export const RECOVERY = Object.freeze({
  [STATE.queued]: 'supervisor_dispatch',
  [STATE.running]: 'attempt_finished',
  [STATE.verifying]: 'verification_finished',
  [STATE.waiting_approval]: 'approval_decided',
  [STATE.waiting_input]: 'input_provided',
  [STATE.waiting_dependency]: 'dependency_settled',
  [STATE.paused_user]: 'user_resumed',
  [STATE.paused_budget]: 'budget_extended',
  [STATE.blocked]: 'blocker_cleared',
  [STATE.completed]: null,
  [STATE.cancelled]: null,
});

export const STATE_TEXT = Object.freeze({
  [STATE.queued]: '排队中',
  [STATE.running]: '执行中',
  [STATE.verifying]: '验收中',
  [STATE.waiting_approval]: '等待批准',
  [STATE.waiting_input]: '等待补充信息',
  [STATE.waiting_dependency]: '等待子任务',
  [STATE.paused_user]: '已暂停',
  [STATE.paused_budget]: '预算用尽，已暂停',
  [STATE.blocked]: '阻塞',
  [STATE.completed]: '已完成',
  [STATE.cancelled]: '已取消',
});

// ---------------------------------------------------------------------------
// 状态迁移边（只表示"状态之间能不能走"，不代表任何事件都能走）
// ---------------------------------------------------------------------------

/**
 * 状态可达性表。
 *
 * ★ 这张表**只**回答"A 状态能不能变成 B 状态"。
 *   它不回答"这个事件能不能触发这次变化" —— 那由 task-reduce.js 的
 *   EVENT_SOURCES 单独约束。两者都通过才允许。
 *
 * 当初只留这一张表的后果（审查 R01 实测）：
 *   `waiting_approval → dispatch → running` 能走通，
 *   因为"waiting_approval 能到 running"本来是给 approval_granted 留的边。
 *   存在一条边 ≠ 任何事件都能走。
 *
 * 几条特意写死的边界：
 *   · `cancelled` / `completed` 没有出边 —— 取消不可复活，完成只能新开任务；
 *   · `paused_budget` 不到 `running` —— 额度没追加就直接跑等于绕过上限；
 *   · `paused_*` 不到 `running` —— 恢复必须先回到 `queued` 走统一调度入口，
 *     这样预算、并发、取消检查一个都不会漏。
 */
/**
 * 状态可达性表。
 *
 * ★ 第四轮起，它**不再是约束**，只是文档：状态由 `deriveState()` 从
 *   `openGates` / `flags` / `attempts` 派生，没有任何路径能手工指定状态。
 *   保留它是因为：
 *
 *   · 阅读时能一眼看出哪些状态能互相到达；
 *   · 测试可以断言"派生结果落在合法集合内"；
 *   · 将来若引入手工状态（如人工归档），有现成的表可查。
 *
 * 派生方式见 task-reduce.js 的 `deriveState`。
 */
export const TRANSITIONS = Object.freeze({
  [STATE.queued]: [
    STATE.running,
    STATE.verifying,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.cancelled,
  ],
  [STATE.running]: [
    STATE.queued,
    STATE.verifying,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
    STATE.cancelled,
  ],
  [STATE.verifying]: [
    STATE.queued,
    STATE.running,
    STATE.completed,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
    STATE.cancelled,
  ],
  [STATE.waiting_approval]: [
    STATE.queued,
    STATE.running,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
    STATE.cancelled,
  ],
  [STATE.waiting_input]: [
    STATE.queued,
    STATE.running,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
    STATE.cancelled,
  ],
  [STATE.waiting_dependency]: [
    STATE.queued,
    STATE.running,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
    STATE.cancelled,
  ],
  [STATE.paused_user]: [
    STATE.queued,
    STATE.blocked,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.cancelled,
  ],
  [STATE.paused_budget]: [
    STATE.queued,
    STATE.blocked,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.cancelled,
  ],
  [STATE.blocked]: [
    STATE.queued,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.paused_user,
    // ★ 受阻的任务可能因为额度用尽而转成预算暂停。
    //
    //   归约器允许这条路径（blocked --budget_exhausted--> paused_budget），
    //   但可达性表里漏了 —— 表与实现不一致，任何按表判可达的调用方
    //   都会认为这条合法路径不合法。以实现为准补上。
    STATE.paused_budget,
    STATE.cancelled,
  ],
  [STATE.completed]: [],
  [STATE.cancelled]: [],
});

export function canTransition(from, to) {
  if (!ALL_STATES.includes(from) || !ALL_STATES.includes(to)) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function nextStates(from) {
  return [...(TRANSITIONS[from] ?? [])];
}

// ---------------------------------------------------------------------------
// 角色与接单意图
// ---------------------------------------------------------------------------

export const ROLE = Object.freeze({
  chief: 'chief',
  lead: 'lead',
  member: 'member',
  verifier: 'verifier',
});

export const INTAKE = Object.freeze({
  answer: 'answer',
  clarification: 'clarification',
  accept_task: 'accept_task',
});

export const ALL_INTAKE = Object.freeze(Object.values(INTAKE));

// ---------------------------------------------------------------------------
// 阶段报告与停止原因
// ---------------------------------------------------------------------------

/**
 * 模型这一轮"汇报了什么"。全部是**声明**，不是权威状态。
 */
export const PHASE = Object.freeze({
  progress: 'progress',
  apply_completion: 'apply_completion',
  need_approval: 'need_approval',
  need_input: 'need_input',
  waiting_dependency: 'waiting_dependency',
  blocked: 'blocked',
});

export const ALL_PHASES = Object.freeze(Object.values(PHASE));

/**
 * 一次有界执行**为什么结束**（运行器判定，不是模型自报）。
 *
 * 只有 `returned` 才有资格成为完成候选 —— 让出、失败、跳过、等待都不算。
 */
export const STOP = Object.freeze({
  returned: 'returned',
  failed: 'failed',
  yielded: 'yielded',
  waiting: 'waiting',
  cancelled: 'cancelled',
  skipped: 'skipped',
});

export const ALL_STOPS = Object.freeze(Object.values(STOP));

/**
 * 有资格成为"完成候选"的停止原因集合。
 *
 * ★ 单独导出成常量，是因为归约器（task-reduce）和辅助判定
 *   （isCompletionCandidate）**必须**用同一份 —— 审查 R04 实测到两处
 *   各判一套：辅助函数说"不算候选"，归约器却把任务推进了 verifying。
 */
export const COMPLETION_ELIGIBLE_STOPS = Object.freeze([STOP.returned]);

export function isCompletionEligibleStop(stop) {
  return COMPLETION_ELIGIBLE_STOPS.includes(stop);
}

// ---------------------------------------------------------------------------
// 验收条件种类
// ---------------------------------------------------------------------------

export const VERIFY_KIND = Object.freeze({
  artifact: 'artifact',
  format: 'format',
  count: 'count',
  test: 'test',
  receipt: 'receipt',
  expert: 'expert',
});

export const ALL_VERIFY_KINDS = Object.freeze(Object.values(VERIFY_KIND));

/** 机械可判的验收种类（其余需要专业判断，界面要区分开）。 */
export const MECHANICAL_VERIFY_KINDS = Object.freeze([
  VERIFY_KIND.artifact,
  VERIFY_KIND.format,
  VERIFY_KIND.count,
  VERIFY_KIND.test,
  VERIFY_KIND.receipt,
]);

export function isMechanical(kind) {
  return MECHANICAL_VERIFY_KINDS.includes(kind);
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export const EVENT = Object.freeze({
  dispatch: 'dispatch',
  attempt_finished: 'attempt_finished',
  verification_finished: 'verification_finished',
  approval_granted: 'approval_granted',
  approval_rejected: 'approval_rejected',
  input_provided: 'input_provided',
  dependency_settled: 'dependency_settled',
  paused: 'paused',
  resumed: 'resumed',
  budget_exhausted: 'budget_exhausted',
  budget_extended: 'budget_extended',
  revision_bumped: 'revision_bumped',
  blocked: 'blocked',
  // 阻塞的正常解除入口（G06）。不能靠"暂停再继续"绕一圈绕回去。
  unblocked: 'unblocked',
  // 确认某次执行已经停止、且不会再有结果（G02）。
  // 这不是"作废"（作废只是不再推进状态，执行可能还在跑）。
  attempt_closed: 'attempt_closed',
  cancelled: 'cancelled',
});

export const ALL_EVENTS = Object.freeze(Object.values(EVENT));

/**
 * **每个事件允许从哪些状态触发。**
 *
 * ★ 这是 R01 的修复点：光有 TRANSITIONS（状态可达性）不够。
 *   可达性表里 `waiting_approval → running` 那条边是给 `approval_granted`
 *   留的，但 `dispatch` 也能顺着它走过去 —— 等于"等批准"形同虚设。
 *
 *   所以再加一层：事件先查自己能从哪来，再查状态边。两层都过才放行。
 */
export const EVENT_SOURCES = Object.freeze({
  // 派发只在排队状态发生 —— 统一调度入口，所有门槛检查都在这一道
  [EVENT.dispatch]: [STATE.queued],
  // 结算已登记的执行不受这里限制（归约器单独放行），
  // 这里只约束"没有登记过的 attempt_finished"—— 那才是异常
  [EVENT.attempt_finished]: [STATE.running],
  [EVENT.attempt_closed]: [
    STATE.queued,
    STATE.running,
    STATE.verifying,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
  ],
  [EVENT.verification_finished]: [STATE.verifying],
  [EVENT.approval_granted]: [STATE.waiting_approval],
  [EVENT.approval_rejected]: [STATE.waiting_approval],
  [EVENT.input_provided]: [STATE.waiting_input],
  [EVENT.dependency_settled]: [STATE.waiting_dependency],
  // 暂停：任何未终态都能暂停
  //
  // ★ 包含 paused_budget：因额度停住的任务，用户仍然可以要求「别跑了」。
  //   漏掉它的后果是——一个已经停住的任务点暂停被拒（illegal_source），
  //   用户只会认为按钮坏了。两种暂停原因不同，可以同时成立。
  [EVENT.paused]: [
    STATE.queued,
    STATE.running,
    STATE.verifying,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.paused_budget,
    STATE.blocked,
  ],
  // 恢复只从暂停来
  [EVENT.resumed]: [STATE.paused_user, STATE.paused_budget],
  [EVENT.budget_exhausted]: [
    STATE.queued,
    STATE.running,
    STATE.verifying,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.blocked,
  ],
  [EVENT.budget_extended]: [STATE.paused_budget],
  [EVENT.revision_bumped]: [
    STATE.queued,
    STATE.running,
    STATE.verifying,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
  ],
  [EVENT.blocked]: [
    STATE.queued,
    STATE.running,
    STATE.verifying,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.paused_user,
    STATE.paused_budget,
  ],
  // 阻塞的正常出口（G06）
  [EVENT.unblocked]: [STATE.blocked],
  [EVENT.cancelled]: [
    STATE.queued,
    STATE.running,
    STATE.verifying,
    STATE.waiting_approval,
    STATE.waiting_input,
    STATE.waiting_dependency,
    STATE.paused_user,
    STATE.paused_budget,
    STATE.blocked,
  ],
});

/**
 * 这个事件能从当前状态触发吗？
 * @returns {{ok:true}|{ok:false, text:string}}
 */
export function allowedFrom(eventType, state) {
  const sources = EVENT_SOURCES[eventType];
  if (!sources) return { ok: false, text: `未知事件：${eventType}` };
  if (!sources.includes(state)) {
    return {
      ok: false,
      text: `${STATE_TEXT[state] ?? state} 状态不接受「${eventType}」（允许的来源：${sources
        .map((s) => STATE_TEXT[s] ?? s)
        .join('、')}）`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 拒绝原因
// ---------------------------------------------------------------------------

export const REJECT = Object.freeze({
  staleSequence: 'stale_sequence',
  staleRevision: 'stale_revision',
  futureRevision: 'future_revision',
  illegalTransition: 'illegal_transition',
  illegalSource: 'illegal_source',
  missingField: 'missing_field',
  badField: 'bad_field',
  terminalState: 'terminal_state',
  revisionMismatch: 'revision_mismatch',
  attemptMismatch: 'attempt_mismatch',
  noActiveAttempt: 'no_active_attempt',
  waitMismatch: 'wait_mismatch',
  budgetNotExtended: 'budget_not_extended',
  tooManyPending: 'too_many_pending',
  conflictSettlement: 'conflict_settlement',
});

export const REJECT_TEXT = Object.freeze({
  [REJECT.staleSequence]: '事件序号不新于当前状态，已丢弃（迟到事件）',
  [REJECT.staleRevision]: '事件针对的是旧版本的目标，已丢弃',
  [REJECT.futureRevision]: '事件版本比当前任务更新，不能应用到旧状态',
  [REJECT.illegalTransition]: '状态之间不允许这种迁移',
  [REJECT.illegalSource]: '当前状态不接受这个事件',
  [REJECT.missingField]: '缺少必填字段',
  [REJECT.badField]: '字段值不合法',
  [REJECT.terminalState]: '任务已结束（完成或取消），不再接受变更',
  [REJECT.revisionMismatch]: '事件的目标版本与当前版本不一致',
  [REJECT.attemptMismatch]: '这次尝试不属于当前任务的活动尝试',
  [REJECT.noActiveAttempt]: '当前没有在途尝试，不能接收尝试结果',
  [REJECT.waitMismatch]: '解除的等待与当前等待的不是同一件事',
  [REJECT.budgetNotExtended]: '预算未实际追加，不能解除预算暂停',
  [REJECT.tooManyPending]: '未结算的执行太多，先等它们回来或确认已停止',
  [REJECT.conflictSettlement]: '这次执行已经结算过，不能用一个不同的结果覆盖',
});

// ---------------------------------------------------------------------------
// 状态不变量（F02 / F06 的修复基础）
// ---------------------------------------------------------------------------

/**
 * 每个状态**必须**有哪些字段、**禁止**有哪个字段。
 *
 * ## 为什么要有这张表
 *
 * 审查 F02 实测到两条矛盾状态：
 *
 *   · `queued` 里还挂着 `activeAttempt` → 新 dispatch 被 attempt_mismatch 拒绝；
 *   · `running` 里 `activeAttempt` 为空 → 旧结果因不在 running 被拒，新 dispatch 也进不来。
 *
 * 两者都是"状态说的是这样，字段说的是那样"。靠每个分支各自小心翼翼没用，
 * 得有一条**统一的不变量**，创建、加载、归约出口都查它。
 *
 * ## 字段语义
 *
 *   · `activeAttempt`：真的有一次执行在途，等它报结果。
 *   · `pendingWait`：正在等一个具体外部条件（批准/输入/依赖）。
 *   · `abandonedAttempts`：已作废但仍可能报结果的尝试（改目标/暂停/取消时产生）。
 *     它们的迟到结果**被接受但归为 noop**，不推进状态 —— 这样旧操作不会
 *     "报结果时报错"，也不会"用旧结果改新目标"。
 *
 * 暂停态允许两者同时存在：暂停只是不再调度，在途的东西还在发生。
 */
export const STATE_FIELDS = Object.freeze({
  [STATE.queued]: { requireActive: false, allowActive: false },
  [STATE.running]: { requireActive: true, allowActive: true },
  [STATE.verifying]: { requireActive: false, allowActive: false },
  [STATE.waiting_approval]: { requireActive: false, allowActive: false },
  [STATE.waiting_input]: { requireActive: false, allowActive: false },
  [STATE.waiting_dependency]: { requireActive: false, allowActive: false },
  [STATE.paused_user]: { requireActive: false, allowActive: true },
  [STATE.paused_budget]: { requireActive: false, allowActive: true },
  [STATE.blocked]: { requireActive: false, allowActive: true },
  [STATE.completed]: { requireActive: false, allowActive: false },
  [STATE.cancelled]: { requireActive: false, allowActive: false },
});

// ---------------------------------------------------------------------------
// 校验结果助手（被 task-goal / task-attempt / task-reduce 共用）
// ---------------------------------------------------------------------------

/**
 * 造一个拒绝结果。
 *
 * 有具体 detail 时用它当文案 —— 泛泛的"状态不允许"对排查没帮助。
 */
export function reject(code, field = '', detail = '') {
  return { ok: false, code, field, detail, text: detail || REJECT_TEXT[code] || code };
}

export const ok = (extra = {}) => ({ ok: true, ...extra });