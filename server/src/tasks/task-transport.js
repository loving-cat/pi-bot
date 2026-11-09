/**
 * TaskRun 传输 DTO（只做形状转换，不持状态机）。
 *
 * revision/sequence/storeVersion 原样保留；根预算统一在这里解析。
 */
import { remainingRuns } from './task-budget.js';

const TRANSPORT_STATE_TEXT = Object.freeze({
  queued: '准备中', running: '执行中', verifying: '验收中',
  waiting_approval: '等待批准', waiting_input: '等待补充', waiting_dependency: '等待子任务',
  paused_user: '已暂停', paused_budget: '额度用尽', blocked: '受阻', completed: '已完成', cancelled: '已取消',
});

/** 用户可理解的状态。 */
export function userStateOf(taskRun) {
  if (!taskRun) return 'unknown';
  return taskRun.state ?? 'unknown';
}

/**
 * 投影成客户端形状。
 *
 * @param {object} taskRun
 * @param {object} [p]
 * @param {object} [p.root] 根任务（预算展示）
 * @param {number} [p.commandVersion] 当前命令回执版本（可选）
 */
/**
 * 对外只暴露四类阶段：用户不需要理解 11 个内部状态。
 *
 *   active     进行中（排队/执行/验收/等子任务）
 *   needs_user 需要用户处理（等批准/等输入/受阻/预算用尽）
 *   paused     用户主动暂停
 *   done       已结束（完成或取消）
 *
 * 内部状态机不动，这里只做投影折叠。
 */
/**
 * 子任务进度摘要：用户关心「几份交了、几份还在跑」，不关心内部状态名。
 *
 * @param {Array<object>|null} children 本版本的子任务列表
 */
export function summarizeChildren(children, { nameOf = null, limit = 8 } = {}) {
  if (!Array.isArray(children) || !children.length) return null;
  const total = children.length;
  let done = 0, running = 0, waiting = 0;
  // 参与者名单：用户要能看出「这份活是谁在跟」。
  // nameOf 由调用方注入（纯函数里不碰 store）。
  const participants = [];
  // 被名单长度挡掉的参与者数量。
  //
  // ★ 原来静默截断：部门超过 limit 人时，详情页的名单就是缺人的，
  //   用户以为只有这几个人在跟 —— 而实际有一整个部门在跑。
  const seenBots = new Set();
  let truncated = 0;
  for (const child of children) {
    const state = String(child?.state ?? '');
    if (state === 'completed') done += 1;
    else if (state === 'cancelled') done += 1;
    else if (['waiting_approval', 'waiting_input', 'blocked', 'paused_budget', 'paused_user'].includes(state)) waiting += 1;
    else running += 1;
    const botId = child?.owner?.leadBotId ?? null;
    if (!botId || seenBots.has(botId)) continue;
    seenBots.add(botId);
    if (participants.length < limit) {
      participants.push({
        botId,
        name: typeof nameOf === 'function' ? (nameOf(botId) ?? '') : '',
        state,
        done: state === 'completed' || state === 'cancelled',
      });
    } else {
      truncated += 1;
    }
  }
  return {
    total, done, running, waiting, participants,
    // 名单之外还有人（前端必须显示「还有 N 人」而不是假装只有这几个）
    participantsTruncated: truncated,
    participantTotal: seenBots.size,
  };
}

export const USER_PHASE = Object.freeze({
  active: 'active',
  needsUser: 'needs_user',
  paused: 'paused',
  done: 'done',
});

const PHASE_OF_STATE = Object.freeze({
  queued: USER_PHASE.active,
  running: USER_PHASE.active,
  verifying: USER_PHASE.active,
  waiting_dependency: USER_PHASE.active,
  waiting_approval: USER_PHASE.needsUser,
  waiting_input: USER_PHASE.needsUser,
  blocked: USER_PHASE.needsUser,
  paused_budget: USER_PHASE.needsUser,
  paused_user: USER_PHASE.paused,
  completed: USER_PHASE.done,
  cancelled: USER_PHASE.done,
});

export function userPhaseOf(state) {
  return PHASE_OF_STATE[state] ?? USER_PHASE.active;
}

export function projectTaskRun(taskRun, { root = null, children = null, nameOf = null } = {}) {
  if (!taskRun) return null;
  const childrenSummary = summarizeChildren(children, { nameOf });
  const leadBotId = taskRun.owner?.leadBotId ?? null;
  const leadBotName = leadBotId && typeof nameOf === 'function' ? (nameOf(leadBotId) ?? '') : '';
  const budgetRoot = root ?? (taskRun.rootTaskId === taskRun.id || !taskRun.rootTaskId ? taskRun : null);
  const budget = taskRun.budget ?? {};
  const remaining = budgetRoot?.budget
    ? remainingRuns(budgetRoot.budget)
    : (Number.isFinite(budget.maxRuns) ? Math.max(0, budget.maxRuns - Number(budget.usedRuns ?? 0)) : null);
  const gate = (taskRun.openGates ?? [])[0] ?? null;
  return {
    id: taskRun.id,
    roomId: taskRun.origin?.roomId ?? taskRun.request?.roomId ?? null,
    rootTaskId: taskRun.rootTaskId ?? taskRun.id,
    parentTaskId: taskRun.parentTaskId ?? null,
    revision: taskRun.revision,
    sequence: taskRun.sequence,
    storeVersion: taskRun.storeVersion ?? 0,
    state: userStateOf(taskRun),
    // 对外四类阶段：客户端用它决定显示什么、给哪些按钮。
    phase: userPhaseOf(taskRun.state),
    stateText: TRANSPORT_STATE_TEXT[taskRun.state] ?? taskRun.state,
    title: taskRun.goal?.requirement ?? '',
    scope: taskRun.goal?.scope ?? '',
    deliverables: (taskRun.goal?.deliverables ?? []).slice(0, 20),
    verificationCount: (taskRun.goal?.verification ?? []).length,
    unmet: (taskRun.progress?.unmet ?? []).slice(0, 20),
    // 受阻原因要给人看：用户得知道为什么停了、能不能解除。
    blockedReason: taskRun.state === 'blocked' ? String(taskRun.flags?.blockedReason ?? '') : '',
    waiting: gate ? { kind: gate.kind, ref: gate.ref, describe: gate.describe ?? '' } : null,
    budget: {
      maxRuns: budgetRoot?.budget?.maxRuns ?? null,
      usedRuns: budgetRoot?.budget?.usedRuns ?? null,
      extraRuns: budgetRoot?.budget?.extraRuns ?? 0,
      remaining,
    },
    // 结果已准备 = 服务端验收通过并有交付摘要；送达确认由客户端回执另行处理
    result: taskRun.delivery
      ? { prepared: true, delivered: false, summary: String(taskRun.delivery.summary ?? '').slice(0, 500), at: taskRun.delivery.at ?? null }
      : { prepared: false, delivered: false },
    admission: taskRun.admission
      ? { status: taskRun.admission.status ?? null, outcome: taskRun.admission.outcome ?? null }
      : null,
    // 谁在负责这个任务（负责人 Bot）。
    leadBotId,
    leadBotName,
    // 子任务进度（谁在做什么）：由调用方传入本版本子任务，缺省为空。
    childrenSummary,
    // ★ 负责人列的分工计划。
    //
    //   计划一直存在 taskRun.plan.steps 里，但从来没投影出去 ——
    //   用户根本看不出「模型到底有没有先列计划」，这一项等于不可验证。
    //   带上 steps 与生成时间，界面才能把它显示出来。
    plan: Array.isArray(taskRun.plan?.steps) && taskRun.plan.steps.length
      ? {
          steps: taskRun.plan.steps.slice(0, 20).map((s, i) => ({
            index: i + 1,
            title: String(s?.title ?? s?.text ?? s ?? '').slice(0, 200),
            owner: String(s?.owner ?? s?.botName ?? '').slice(0, 80),
            status: String(s?.status ?? 'pending'),
          })),
          at: taskRun.plan.at ?? null,
          revision: taskRun.plan.revision ?? null,
        }
      : null,
    updatedAt: taskRun.updatedAt ?? null,
  };
}

/** 列表投影：默认只列未终态 + 最近完成的（避免旧清单淹没）。 */
export function projectTaskRunList(taskRuns, { includeDone = true, limit = 50, rootOf = null, childrenOf = null } = {}) {
  const list = taskRuns
    .map((run) => projectTaskRun(run, { root: typeof rootOf === 'function' ? rootOf(run) : null, children: typeof childrenOf === 'function' ? childrenOf(run) : null }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const visible = includeDone ? list : list.filter((t) => t.state !== 'completed' && t.state !== 'cancelled');
  return visible.slice(0, limit);
}

