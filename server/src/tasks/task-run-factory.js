/**
 * TaskRun 的工厂与接单意图解析（纯逻辑）。
 *
 * ## 创建时就守住的规则（审查 R05 / R07）
 *
 *   · 目标必须过 `validateGoal`（同一套，四个入口共用）；
 *   · **接单必须带验收条件** —— 只问方案的话那是 `answer`，不是 TaskRun；
 *   · 子任务必须显式给 rootTaskId，不能默认"自己就是根"：
 *     那会造出第二个根，把"所有子任务共享根预算"直接废掉。
 */
import {
  STATE,
  INTAKE,
  ALL_INTAKE,
  REJECT,
  reject,
  ok,
} from './task-contract.js';
import { validateGoal } from './task-goal.js';
import { validateTaskRun } from './task-reduce.js';

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isTime = (v) => Number.isFinite(v) && v > 0;

/**
 * 创建一个 TaskRun。
 *
 * 所有时间与 ID 由调用方传入（这一层不看时钟、不生成随机数），
 * 测试才能"回到某个时刻"复现。
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} [p.rootTaskId] 根任务 ID；根任务时必须省略或等于 id
 * @param {string|null} [p.parentTaskId] 父任务；根任务必须为 null
 * @param {string} p.requestId
 * @param {number} p.at
 * @param {object} [p.origin] { roomId, messageId }
 * @param {string} p.requesterId 由服务端认证取得
 * @param {object} p.goal { requirement, scope, deliverables, verification }
 * @param {object} [p.owner] { departmentId, leadBotId, reportToBotId }
 * @param {object} [p.budget] { maxRuns, deadlineAt }（不接收 usedRuns —— 它从账本派生）
 * @returns {{ok:true, taskRun:object}|{ok:false, ...}}
 */
export function createTaskRun({
  id,
  rootTaskId,
  parentTaskId = null,
  requestId,
  at,
  origin = {},
  requesterId,
  goal = {},
  owner = {},
  budget = null,
  autonomous = null,
  autonomyReason = '',
} = {}) {
  if (!isId(id)) return reject(REJECT.badField, 'id', '任务 ID 形如 tr_xxx');
  if (!isId(requestId)) return reject(REJECT.badField, 'requestId', 'requestId 必须是稳定标识');
  if (!isTime(at)) return reject(REJECT.badField, 'at', 'at 必须是毫秒时间戳');
  if (!isText(requesterId)) {
    return reject(REJECT.missingField, 'requesterId', '发起人由服务端认证取得，必填');
  }

  // ★ 根/子任务参数组合（R07）
  const isSubtask = parentTaskId !== null && parentTaskId !== undefined;
  if (isSubtask) {
    if (!isId(parentTaskId)) {
      return reject(REJECT.badField, 'parentTaskId', 'parentTaskId 不合法');
    }
    if (!isId(rootTaskId)) {
      return reject(
        REJECT.missingField,
        'rootTaskId',
        '子任务必须显式给出根任务 ID（子任务不能自成根，否则根预算会被绕过）',
      );
    }
    if (rootTaskId === id) {
      return reject(REJECT.badField, 'rootTaskId', '子任务的根不能是它自己');
    }
    if (parentTaskId === id) {
      return reject(REJECT.badField, 'parentTaskId', '任务不能是自己的父任务');
    }
  } else {
    if (rootTaskId !== undefined && rootTaskId !== null && rootTaskId !== id) {
      return reject(REJECT.badField, 'rootTaskId', '根任务的 rootTaskId 必须等于自身 ID');
    }
  }

  // ★ 目标校验走统一入口；接单必须有验收条件（R05）
  const validated = validateGoal(goal, { requireVerification: true });
  if (!validated.ok) return validated;

  const budgetOut = normalizeBudget(budget, { isSubtask });
  if (!budgetOut.ok) return budgetOut;

  const taskRun = {
    // ---- 身份
    id,
    rootTaskId: isSubtask ? rootTaskId : id,
    parentTaskId: isSubtask ? parentTaskId : null,
    requestId,
    // ---- 版本（迁移不混用）
    revision: 1,
    sequence: 0,
    // ---- 来源
    origin: {
      roomId: origin.roomId ?? null,
      messageId: origin.messageId ?? null,
      requesterId,
    },
    // ---- 目标
    goal: validated.goal,
    // ---- 归属
    owner: {
      departmentId: owner.departmentId ?? null,
      leadBotId: owner.leadBotId ?? null,
      reportToBotId: owner.reportToBotId ?? null,
    },
    // ---- 进度（都是"已确认"的，不是模型自称的）
    progress: { confirmedSteps: [], unmet: [], evidence: [], checkpoint: '' },
    // ---- 下一步
    next: { action: 'dispatch', actor: null, waitingFor: null },
    // ---- 状态
    state: STATE.queued,
    reason: '刚接单，等待调度',
    // ---- 执行账本（唯一权威：谁在跑、跑了几次、结算了没有）
    //   ★ 不单独存 activeAttempt / usedRuns —— 都是派生的（G02）
    attempts: [],
    // ---- 未解除的等待门槛（唯一存放处）
    //   ★ 暂停/阻塞只改 flags，碰不到这里 —— 组合多少次都不会丢（H04）
    openGates: [],
    // ---- 约束标记：暂停 / 预算暂停 / 阻塞 / 验收中
    //   状态由 deriveState() 派生，不手工维护
    flags: {
      pausedAt: null,
      budgetPausedAt: null,
      blockedAt: null,
      blockedReason: '',
      verifyingAt: null,
      // 用户是否授权「自己搞定、别问我」（见 task-autonomy.js）。
      //   true 时任务不因「等确认」停下，验收不过自己重试。
      autonomous: autonomous === true,
      autonomyReason: String(autonomyReason ?? '').slice(0, 200),
    },
    // ---- 预算
    budget: budgetOut.budget,
    createdTaskAt: at,
    lastEffectiveAt: at,
    createdAt: at,
    updatedAt: at,
  };

  // 自检：造出来的东西必须能通过加载校验
  const check = validateTaskRun(taskRun);
  if (!check.ok) return check;

  return ok({ taskRun });
}

/**
 * 预算规范化。
 *
 * 批次 01 只守输入契约：根任务可以设上限，子任务**不自己设**
 * （共享根额度由批次 02 的存储层实现）。
 */
function normalizeBudget(budget, { isSubtask }) {
  if (budget === undefined || budget === null) return ok({ budget: null });
  if (typeof budget !== 'object' || Array.isArray(budget)) {
    return reject(REJECT.badField, 'budget', '预算必须是对象或 null');
  }
  const out = {};
  if (budget.maxRuns !== undefined) {
    // ★ F04：只有显式 null 表示"不限额"。其余必须是正整数 ——
    //   小数会让上限检查和额度累计同时失效（都是按整数判的）。
    if (budget.maxRuns === null) {
      out.maxRuns = null;
    } else {
      const n = Number(budget.maxRuns);
      if (!Number.isInteger(n) || n <= 0) {
        return reject(REJECT.badField, 'budget.maxRuns', 'maxRuns 必须是正整数，或用 null 表示不限额');
      }
      // 子任务不设自己的上限：传了就忽略（共享根额度）
      if (!isSubtask) out.maxRuns = n;
    }
  }
  out.extraRuns = 0;
  // ★ 第五轮清理：不再写 usedRuns。
  //   累计执行量从账本派生（attempts.length），存一份必然与账本不同步 ——
  //   那正是第三轮 G02 的根因。留着这个字段只会让诊断视图读到假数据。
  // 子任务共享根额度：批次 02 由存储层查根记录填真实上限
  if (isSubtask) out.sharedWithRoot = true;
  if (budget.deadlineAt !== undefined && budget.deadlineAt !== null) {
    const d = Number(budget.deadlineAt);
    if (!Number.isFinite(d) || d <= 0) {
      return reject(REJECT.badField, 'budget.deadlineAt', 'deadlineAt 必须是毫秒时间戳');
    }
    out.deadlineAt = d;
  }
  return ok({ budget: out });
}

/**
 * 解析一次理解轮的输出。
 *
 * 三种出口，只有 `accept_task` 建任务；接单必须带目标 + 至少一条验收条件。
 * 缺结构化结果时返回可纠正错误 —— **不能把一段计划文本当接单**。
 *
 * @returns {{ok:true, intake:object}|{ok:false, ...}}
 */
export function parseIntake(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject(REJECT.missingField, 'intake', '缺少接单意图');
  }
  const kind = String(raw.kind ?? '').trim();
  if (!ALL_INTAKE.includes(kind)) {
    return reject(REJECT.badField, 'intake.kind', `未知接单意图：${kind || '(空)'}`);
  }
  if (kind !== INTAKE.accept_task) {
    return ok({ intake: { kind, text: String(raw.text ?? '').trim() } });
  }

  // ★ 接单：目标 + 验收条件都必须过统一校验（R05）
  const validated = validateGoal(raw.goal, { requireVerification: true });
  if (!validated.ok) return validated;

  return ok({
    intake: {
      kind,
      goal: validated.goal,
      routing: normalizeRouting(raw.routing),
    },
  });
}

function normalizeRouting(routing) {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return { type: 'auto' };
  }
  const type = String(routing.type ?? 'auto').trim();
  const out = { type };
  if (routing.departmentId) out.departmentId = String(routing.departmentId).slice(0, 80);
  // 只建组：建成即结束，不派研究任务。这是**用户意图限制**，不能被归一化丢掉。
  if (routing.departmentOnly === true) out.departmentOnly = true;
  if (routing.departmentSpec && typeof routing.departmentSpec === 'object') {
    out.departmentSpec = { ...routing.departmentSpec };
  }
  return out;
}