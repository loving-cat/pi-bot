/**
 * 负责人持续推进器：事件驱动的内部推进、子任务调度与恢复。
 *
 * 编排顺序（每次从持久记录重新检查）：
 *   祖先/本任务取消或暂停 → 版本 → 结果未知核验 → 在途子任务 → 权限/根预算 →
 *   验收（仅合法状态）→ 下一步/等待 → 执行一步（预留/启动/登记/调用/结算）。
 *
 * 复用：判定在 task-next-action，控制在 task-controls，提示在 task-prompts，
 * 执行一步在 run-managed-attempt，恢复分类用 TaskRunStore 既有静态方法。
 */
import { EVENT, STATE, STOP } from './task-contract.js';
import { reduceTaskRun } from './task-reduce.js';
import { NEXT, planNextAction, progressSignature } from './task-next-action.js';
import { verifyTaskRun } from './task-verification.js';
import { remainingRuns } from './task-budget.js';
import { TaskRunStore } from './task-run-store.js';
import { runManagedAttempt } from './run-managed-attempt.js';
import { decideRetry } from '../retry-policy.js';
import {
  CONTROL, applyControl, reconcileEarlyControls, descendants as descendantsOf,
} from './task-controls.js';
import { childrenOf } from './task-subtasks.js';
import { decideRecovery, RECOVERY_STAGE } from './task-recovery.js';
import { LEAD_PHASE, buildLeadPrompt, buildMemberPrompt, buildDeliverySummary } from './task-prompts.js';
import { reserveRootBudget, refundRootBudget, settleRootBudget, extendRootBudget } from './task-budget-coordinator.js';

const PAUSED = new Set([STATE.paused_user, STATE.paused_budget]);
/** 与既有 retry-policy 的瞬时故障上限一致。 */
const MAX_TRANSIENT_ATTEMPTS = 10;
/**
 * 自主任务连续失败多少次后停下来。
 *
 * 用户说「一直干到有结果」不等于「无限重试」：同一个错误反复重试只会烧时间。
 */
/** 没配置时的并发默认值：保守取 4，实际会按部门人数覆盖。 */
const DEFAULT_CONCURRENCY = 4;

const AUTONOMY_RETRY_LIMIT = 3;

/** 自主重试之间的间隔：给执行器一点时间从上次失败里恢复。 */
const AUTONOMY_RETRY_MS = 5_000;

/** 会话忙时的等待基数：执行器可能还在同房间跑上一波，等它空出来。 */
const BUSY_RETRY_MS = 15_000;

/** 这次失败是不是「目标会话还在忙」——受管执行可以等，不能判成永久失败。 */
function isBusyOutcome(raw) {
  if (!raw) return false;
  const text = String(raw.error ?? raw.text ?? '');
  return raw.code === 'SESSION_BUSY' || /already processing|正在处理|在忙|会话正在忙/i.test(text);
}

/**
 * @param {object} p
 * @param {object} p.taskRuns
 * @param {Function} p.execute
 * @param {Function} [p.executeMember]
 * @param {Function} [p.inspectOutcome] 只读核验未知结果
 * @param {Function} [p.verify]
 * @param {object} [p.access]
 * @param {Function} [p.abortInflight] 取消本任务在途执行（必须按任务/版本定位）
 * @param {()=>number} [p.clock]
 * @param {Function} [p.log]
 * @param {number} [p.maxStallRounds]
 * @param {number} [p.maxSteps] 单次排空的步数上限；用尽是让出，不是停住
 */
export function createTaskSupervisor({
  taskRuns,
  execute,
  executeMember = null,
  /** 只读探测：目标执行者当前是否还在跑（宿主注入）。 */
  isExecutorBusy = null,
  inspectOutcome = null,
  verify = null,
  access = null,
  abortInflight = null,
  clock = () => Date.now(),
  log = () => {},
  maxStallRounds = 2,
  maxSteps = 32,
  /**
   * 同时最多推进几个任务。
   *
   * 传数字就是硬上限；传函数则按「这个部门有多少人」现算 ——
   * 一个 6 人部门本来就能同时跑 6 份活，固定 4 会白白吊着 2 个人。
   */
  maxConcurrency = null,
  /**
   * 上游健康度探针：返回 0..1，1 表示这条路完全正常。
   * key 失效/限流时为 0，此时并发降到 1，避免失败也并发。
   */
  upstreamHealth = null,
  /** 持久变化后通知宿主（用于客户端投影）；不参与任何判定。 */
  onChanged = null,
} = {}) {
  if (!taskRuns) throw new Error('推进器需要 TaskRunStore');
  if (typeof execute !== 'function') throw new Error('推进器需要执行器');

  const queue = new Set();
  let draining = null;
  const running = new Set();
  const inflight = new Map(); // taskRunId → 本次进程内正在执行的标识

  function notify(taskRunId) {
    if (!taskRunId) return;
    queue.add(taskRunId);
    schedule();
  }

  /**
   * 调度循环：**按 Bot 负载均衡地并行**。
   *
   * ## 为什么不是严格串行
   *
   * 一个部门同时有 4 份子任务、每份由不同成员做，严格串行时它们只能一个
   * 接一个跑 —— 用户看到的是「4 个人排队干各自的活」，而实际每个成员的
   * 会话是独立的，本来就能同时跑。
   *
   * ## 为什么不能无脑并行
   *
   * 同一个 Bot 只有一个会话。两个任务同时派给它，第二个会撞
   * 「Agent is already processing」。所以**同一个 Bot 同时只跑一个**，
   * 不同 Bot 各跑各的 —— 这正好就是按执行者做的负载均衡。
   *
   * 上限：maxConcurrency（默认 4），避免一次叫起太多把机器/额度打满。
   */
  /**
   * 本轮允许同时跑几个。
   *
   * 默认按「部门人数」走：部门里有几个人，就能同时有几份活在跑。
   * 理由很直接 —— 每个成员的会话互相独立，人越多能并行的事越多；
   * 固定 4 会让 6 人部门里 2 个人干等着。
   */
  /**
   * 任务的调度优先级：数字越小越先跑。
   *
   * 来源是负责人派活时的先后（子任务的 dispatchPriority）。
   * 没排过的按 0 处理，保证「没指定顺序」不会比「明确排第一」更优先。
   */
  function priorityOf(taskRun) {
    const raw = Number(taskRun?.dispatchPriority ?? 0);
    return Number.isFinite(raw) ? raw : 0;
  }

  function concurrencyBudget() {
    const raw = typeof maxConcurrency === 'function' ? maxConcurrency() : maxConcurrency;
    const n = Number(raw);
    const want = Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CONCURRENCY;
    // ★ key 不稳定时自动降级：上游被熔断还继续开新并发，
    //   只会让更多执行一起撞墙。降到 1 让排最前的先试，成功了再加回来。
    return Math.max(1, Math.floor(want * degradeFactor()));
  }

  /**
   * 上游健康度系数（1 = 正常，0 = 完全不可用）。
   *
   * 由宿主注入探针；没注入就当作正常 —— 不让可选观测卡住主流程。
   */
  function degradeFactor() {
    if (typeof upstreamHealth !== 'function') return 1;
    try {
      const v = Number(upstreamHealth());
      if (!Number.isFinite(v)) return 1;
      return Math.min(1, Math.max(0, v));
    } catch {
      return 1;
    }
  }

  function schedule() {
    if (draining) return;
    draining = Promise.resolve()
      .then(async () => {
        // 本轮正在跑的，按 Bot 登记：同一个 Bot 不并行。
        const active = new Map(); // taskRunId → Promise
        const busyBots = new Set();

        const canRun = (id, taskRun) => {
          if (running.has(id)) return false;
          const botId = taskRun?.owner?.leadBotId ?? null;
          if (botId && busyBots.has(botId)) return false;
          return true;
        };

        const launch = (id, taskRun) => {
          if (active.size >= concurrencyBudget()) return false;
          const botId = taskRun?.owner?.leadBotId ?? null;
          queue.delete(id);
          running.add(id);
          if (botId) busyBots.add(botId);
          const p = (async () => {
            try {
              await runTask(id);
            } catch (err) {
              log('推进任务失败：', id, err?.message || err);
            } finally {
              running.delete(id);
              if (botId) busyBots.delete(botId);
              active.delete(id);
              // 有人空出来就继续排，不用等整批做完。
              setImmediate(() => schedule());
            }
          })();
          active.set(id, p);
          return true;
        };

        while (queue.size) {
          let launched = false;
          // ★ 按负责人安排的优先级取下一批：数字小的先跑。
          //   负责人用 assign_member_task / @ 派活时的先后就是优先级 ——
          //   他说「先交首批，别等全量」，这个顺序必须真的影响调度。
          const ordered = [...queue]
            .map((id) => ({ id, taskRun: read(id) }))
            .filter((it) => it.taskRun)
            .sort((a, b) => priorityOf(a.taskRun) - priorityOf(b.taskRun));
          for (const { id } of ordered) {
            if (active.size >= concurrencyBudget()) break;
            const taskRun = read(id);
            if (!taskRun) { queue.delete(id); continue; }
            if (!canRun(id, taskRun)) continue;
            if (launch(id, taskRun)) launched = true;
          }
          // 读不到的（已被删/损坏）清出队列，别卡住循环
          for (const id of [...queue]) if (!read(id)) queue.delete(id);
          if (!launched) {
            // 剩下的都被「同 Bot 在跑」或并发上限挡住：等有执行结束再说。
            if (!active.size) break;
            await Promise.race([...active.values()]);
          }
        }
        // 让还在跑的收尾，保证 idle() 语义不变
        if (active.size) await Promise.allSettled([...active.values()]);
      })
      .finally(() => {
        draining = null;
        if (queue.size) schedule();
      });
  }

  async function idle() {
    while (draining) await draining.catch(() => {});
    return true;
  }

  function read(taskRunId) {
    const loaded = taskRuns.read(taskRunId);
    return loaded?.status === 'found' ? loaded.taskRun : null;
  }

  function allRuns() {
    const scan = taskRuns.listAll?.();
    return scan?.taskRuns ?? scan ?? [];
  }

  /** 事务内归约。旧版本结果按它自己的版本归档，不改新目标。 */
  async function settle(taskRunId, event) {
    const out = await taskRuns.mutate(taskRunId, {
      mutate: (current) => {
        if (!current) return { __reject: { ok: false, code: 'not_found', text: '任务不存在' } };
        const reduced = reduceTaskRun(current, { ...event, sequence: current.sequence + 1 });
        if (!reduced.ok) return { __reject: reduced };
        return reduced.taskRun;
      },
    });
    if (out.ok && typeof onChanged === 'function') onChanged(taskRunId);
    return out.ok ? { ok: true, taskRun: out.taskRun } : { ok: false, code: out.code, text: out.text };
  }

  async function patch(taskRunId, fields) {
    const out = await taskRuns.mutate(taskRunId, {
      mutate: (current) => (current ? { ...current, ...fields, updatedAt: clock() } : null),
    });
    if (out.ok && typeof onChanged === 'function') onChanged(taskRunId);
    return out.ok ? { ok: true } : { ok: false, text: out.text ?? out.code };
  }

  /** 明确阻塞；可恢复原因单独记，便于恢复时解除。 */
  async function block(taskRunId, why, recoverable = null) {
    const current = read(taskRunId);
    if (!current || [STATE.blocked, STATE.completed, STATE.cancelled].includes(current.state)) return;
    await settle(taskRunId, {
      type: EVENT.blocked, revision: current.revision, at: clock(),
      reason: String(why).slice(0, 300),
    });
    await patch(taskRunId, { nextAction: null, retryAt: null, ...(recoverable ? { recoverableBlock: recoverable } : {}) });
  }

  function remainingOf(taskRun) {
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    const root = rootId === taskRun.id ? taskRun : read(rootId);
    if (!root?.budget) return Number.POSITIVE_INFINITY;
    if (root.budget.maxRuns === null || root.budget.maxRuns === undefined) return Number.POSITIVE_INFINITY;
    return remainingRuns(root.budget);
  }

  /**
   * 分配未用过的执行身份。
   *
   * 本任务已用 ID = 本任务账本 + 本任务本地槽 + **根上归属本任务的全部历史槽**
   * （含 refunded/settled）。已退款身份绝不复活；别的子任务的 ID 不参与互斥。
   */
  function usedAttemptIds(taskRun) {
    const used = new Set();
    for (const attempt of taskRun.attempts ?? []) used.add(attempt.attemptId);
    for (const slot of Object.values(taskRun.attemptSlots ?? {})) used.add(slot.attemptId);
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    const root = rootId === taskRun.id ? taskRun : read(rootId);
    for (const slot of Object.values(root?.attemptSlots ?? {})) {
      if (slot.taskRunId === taskRun.id) used.add(slot.attemptId);
    }
    return used;
  }

  function nextAttemptId(taskRun) {
    const used = usedAttemptIds(taskRun);
    const prefix = 'a_' + taskRun.id + '_r' + taskRun.revision + '_';
    let n = 1;
    while (used.has(prefix + n)) n += 1;
    return prefix + n;
  }

  /** 祖先暂停/取消/改版：任何下游启动前先看。 */
  function ancestorBlocked(taskRun) {
    let cur = taskRun;
    const seen = new Set();
    while (cur?.parentTaskId && !seen.has(cur.parentTaskId)) {
      seen.add(cur.parentTaskId);
      const parent = read(cur.parentTaskId);
      if (!parent) break;
      if (parent.state === STATE.cancelled) return { blocked: true, paused: false, why: '祖先任务已取消' };
      if (PAUSED.has(parent.state)) return { blocked: true, paused: true, why: '祖先任务已暂停' };
      if ((cur.parentRevision ?? parent.revision) !== parent.revision) {
        return { blocked: true, paused: false, why: '祖先目标已改版' };
      }
      cur = parent;
    }
    return { blocked: false };
  }

  /** 重启后「在途」= 已登记但本进程没有执行；这类要核验，不能当正常在途等。 */
  function isRestartUnknown(taskRun) {
    if (inflight.has(taskRun.id)) return false;
    const active = (taskRun.attempts ?? []).filter((a) => a.state === 'registered');
    if (!active.length) return false;
    return true;
  }

  async function runTask(taskRunId) {
    let yielded = false;
    for (let step = 0; step < maxSteps; step += 1) {
      const taskRun = read(taskRunId);
      if (!taskRun) return { status: 'missing' };
      if (taskRun.state === STATE.cancelled) return { status: 'cancelled' };
      if (taskRun.state === STATE.completed && taskRun.delivery) return { status: 'completed' };

      // 本人暂停：直接等待，不遍历/推进任何子任务
      if (PAUSED.has(taskRun.state)) return { status: 'wait', why: '任务暂停' };

      const ancestor = ancestorBlocked(taskRun);
      if (ancestor.blocked) {
        await patch(taskRunId, { nextAction: null });
        return ancestor.paused
          ? { status: 'wait', why: ancestor.why }
          : { status: 'cancelled', why: ancestor.why };
      }

      // 结果未知（重启后 / 已 started 未结算）：先核验
      const unknown = inflight.has(taskRun.id) ? [] : unknownOf(taskRun);
      if (unknown.length || (!inflight.has(taskRun.id) && isRestartUnknown(taskRun) && taskRun.state !== STATE.running)) {
        const resolved = await inspectAndSettle(taskRun, {
          attemptId: unknown[0]?.attemptId ?? (taskRun.attempts ?? []).find((a) => a.state === 'registered')?.attemptId,
          slot: unknown[0] ?? null,
        });
        if (!resolved) return { status: 'blocked', why: 'unknown' };
        continue;
      }

      // 子任务
      const kids = childrenOf(taskRuns, taskRun);
      const liveKids = kids.filter((k) => !terminal(k));
      if (liveKids.length) {
        let progressed = false;
        for (const kid of liveKids) {
          const out = await runTask(kid.id);
          if (out.status === 'blocked' || out.status === 'wait') {
            return { status: 'wait', why: '子任务未完成', child: kid.id };
          }
          if (out.status === 'completed' || out.status === 'done' || out.status === 'cancelled') {
            progressed = true;
          }
        }
        if (!progressed) return { status: 'wait', why: '子任务推进中' };
        continue;
      }

      const action = planNextAction(taskRun, {
        now: clock(), remainingRuns: remainingOf(taskRun), maxStallRounds, restartUnknown: false,
      });

      if (action.kind === NEXT.done) return { status: 'done', why: action.why };
      if (action.kind === NEXT.blocked) {
        await block(taskRunId, action.why);
        return { status: 'blocked', why: action.why };
      }
      if (action.kind === NEXT.wait) {
        const applied = await reconcileEarlyControls({ taskRuns, taskRunId, settle, patch, notify, clock });
        if (applied) continue;
        if (action.gate?.kind === 'dependency') {
          const released = await releaseDependencyFor(taskRun);
          if (released) continue;
        }
        // 等待外部条件是事件驱动，不算「没有新进展」的停滞
        return { status: 'wait', gate: action.gate ?? null, why: action.why };
      }
      if (action.kind === NEXT.pausedBudget) {
        const paused = await settle(taskRun.id, { type: EVENT.budget_exhausted, revision: taskRun.revision, at: clock() });
        if (paused.ok) {
          await patch(taskRun.id, { nextAction: null });
          return { status: 'paused_budget' };
        }
        await block(taskRunId, '根预算不足且无法进入预算暂停');
        return { status: 'blocked', why: 'budget' };
      }
      if (action.kind === NEXT.deliver) {
        await deliver(taskRun);
        continue;
      }
      if (action.kind === NEXT.restore) {
        const resolved = await inspectAndSettle(taskRun, { attemptId: action.attemptId, slot: null });
        if (!resolved) return { status: 'blocked', why: 'unknown' };
        continue;
      }
      if (action.kind === NEXT.verify) {
        const out = await doVerify(taskRun);
        if (out === 'rejected') {
          // 归约拒绝：不循环硬撞，按未验收继续推进
          await recordStall(taskRun);
          continue;
        }
        continue;
      }

      // 重试到期但状态仍是 blocked：先按既有解除协议解除，再执行
      if (action.retry && taskRun.state === STATE.blocked) {
        const unblocked = await settle(taskRun.id, {
          type: EVENT.unblocked, revision: taskRun.revision, at: clock(), reason: '重试到期',
        });
        if (!unblocked.ok) return { status: 'blocked', why: 'unblock_failed' };
        continue;
      }

      const beforeRun = read(taskRunId) ?? taskRun;
      const beforeProgress = progressSignature(beforeRun);
      const out = await doLeadStep(taskRun, action);
      if (out.status === 'retry_scheduled' || out.status === 'paused_budget') return out;
      if (out.status !== 'ok') return out;

      // ★ 这一步没有可观察的进展（没有新交付、没有新子任务、没有完成申请）。
      //
      //   原来会立刻 continue 再跑一次模型 —— 一次「解除阻塞」于是在同一个唤醒里
      //   连跑两三次，每次都往群里发一条完整的派工/汇报：用户看到的就是
      //   「点一次解除，群里连发三条一模一样的消息」，而且每跑一次都扣一次额度，
      //   最后才被停滞判定打回受阻。
      //
      //   这里交回事件驱动：本轮如实收手，等真实事件（用户指令、子任务交付、
      //   新工具结果）再推进。停滞计数已在 doLeadStep 里累计，所以反复无进展
      //   仍会被既有上限挡住，不会无限重试。
      const afterRun = read(taskRunId) ?? taskRun;
      const afterProgress = progressSignature(afterRun);
      // 状态发生了推进（例如刚结算完进入 verifying / 拿到新门槛）也算变化：
      // 那种情况下必须继续走验收/等待分支，不能停在这里。
      const stateChanged = afterRun.state !== taskRun.state;
      if (afterProgress === beforeProgress && !stateChanged) {
        const hasKids = childrenOf(taskRuns, afterRun).some((k) => !terminal(k));
        // 有在途子任务：等它们交付，这不算停滞。
        if (hasKids) return { status: 'wait', why: '等待子任务交付' };
        // ★ 否则**明确停下**，不能返回一个「等待」了事。
        //
        //   返回 wait 会把记录留在 queued + next=dispatch，界面上就是「准备中」，
        //   可实际没有任何人会再唤醒它 —— 正是用户说的「一直卡住」。
        //   而继续原地重跑同一个指令只会再发一条一模一样的群消息、再扣一次额度。
        //
        //   所以把真实情况说清楚：这一步没有可核验的产出，等用户补充要求或明确继续。
        // 说明「下一步该做什么」，而不是只说「没有产出」。
        // 最常见的原因就是：负责人只在群里 @ 了成员，但没有建出持久子任务。
        const reason = '负责人这一轮没有产出可核验的交付（没有建子任务、没有登记文件，也没有完成申请）';
        await block(taskRunId, reason);
        return { status: 'blocked', why: 'no_progress' };
      }
    }

    // 步数用尽 = 让出：持久续行并重新入队，不是静默停住
    yielded = true;
    await patch(taskRunId, { nextAction: null });
    const current = read(taskRunId);
    await recordStall(current ?? { id: taskRunId });
    notify(taskRunId);
    log('步数用尽，让出后继续', taskRunId);
    return { status: 'yielded', why: '步数上限，已持久续行' };
  }

  function terminal(run) {
    return run.state === STATE.completed || run.state === STATE.cancelled;
  }

  function unknownOf(taskRun) {
    // 占位记在根上；子任务按自己的 taskRunId 过滤。
    // 只有「已启动且结果没有落盘」才算未知；已结算的只是预算待结算。
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    const root = rootId === taskRun.id ? taskRun : read(rootId);
    return Object.values(root?.attemptSlots ?? {})
      .filter((s) => s.phase !== 'settled' && s.phase !== 'refunded' && s.startedAt)
      .filter((s) => !s.taskRunId || s.taskRunId === taskRun.id)
      .filter((s) => s.taskRunId === taskRun.id || taskRun.id === rootId)
      .filter((slot) => {
        const owner = slot.taskRunId ? read(slot.taskRunId) : taskRun;
        const attempt = (owner?.attempts ?? []).find((a) => a.attemptId === slot.attemptId);
        return attempt?.state !== 'settled';
      })
      .map((s) => ({ attemptId: s.attemptId, taskRunId: s.taskRunId, botId: s.botId ?? null, revision: s.revision ?? taskRun.revision }));
  }

  /**
   * 执行者现在忙吗 —— 由宿主注入的只读探测。
   *
   * 为什么要在**执行前**问：受管执行和用户聊天共用同一个会话；
   * 直接跑会撞上「会话正在忙」，那会被记成一次失败尝试，
   * 任务随即被判阻塞（用户看到的正是「刚开始就受阻」，而团队其实在群里正常干活）。
   */
  function executorBusy(botId, taskRun) {
    if (typeof isExecutorBusy !== 'function' || !botId) return false;
    try {
      return isExecutorBusy({ ...(taskRun?.owner ?? {}), botId, taskRun }) === true;
    } catch {
      return false;
    }
  }

  /** 执行一步：先持久（失败即止）→ 预算 → 执行 → 结算。 */
  async function doLeadStep(taskRun, action) {
    const attemptId = nextAttemptId(taskRun);
    const botId = taskRun.owner?.leadBotId ?? null;
    const isChild = Boolean(taskRun.parentTaskId);
    const parentTask = isChild ? read(taskRun.parentTaskId) : null;
    const stepExecutor = isChild && typeof executeMember === 'function' ? executeMember : execute;

    if (!botId) {
      await block(taskRun.id, '没有可执行的负责人');
      return { status: 'blocked', why: 'no_lead' };
    }

    // ★ 会话还在忙：让出一轮再来，不登记本次尝试。
    //   登记了再失败会消耗额度并落一条 failed 尝试，任务直接被判阻塞。
    if (executorBusy(botId, taskRun)) {
      const dueAt = clock() + BUSY_RETRY_MS;
      await patch(taskRun.id, { nextAction: null, retryAt: dueAt, retry: { count: (read(taskRun.id)?.retry?.count ?? 0) + 1, at: clock() } });
      setTimer(dueAt);
      return { status: 'retry_scheduled', dueAt, why: '执行者还在忙，稍后重派' };
    }

    // 先持久下一步；写不进去就不许产生副作用
    const persisted = await patch(taskRun.id, {
      nextAction: {
        kind: action.kind, botId, attemptId, revision: taskRun.revision,
        phase: isChild ? 'member' : LEAD_PHASE.plan, status: 'running', at: clock(),
      },
    });
    if (!persisted.ok) {
      await block(taskRun.id, `下一步未能持久：${persisted.text}`);
      return { status: 'blocked', why: 'next_persist_failed' };
    }

    const prompt = isChild
      ? buildMemberPrompt({ childTaskRun: taskRun, parentTaskRun: parentTask })
      : buildLeadPrompt({ phase: LEAD_PHASE.plan, taskRun });

    inflight.set(taskRun.id, { attemptId, revision: taskRun.revision });
    let out;
    let rawResult = null;
    try {
      out = await runManagedAttempt({
        taskRuns, taskRun, taskRunId: taskRun.id, attemptId, botId, revision: taskRun.revision, clock,
        settleEvent: (event) => settle(taskRun.id, { ...event, revision: event.revision ?? taskRun.revision }),
        execute: async ({ restoreOnly }) => {
          if (restoreOnly) return { unknown: true };
          rawResult = await stepExecutor({
            taskRun, action, attemptId, botId, revision: taskRun.revision,
            phase: isChild ? 'member' : LEAD_PHASE.plan, prompt,
          });
          return rawResult;
        },
      });
    } finally {
      inflight.delete(taskRun.id);
    }

    if (!out.ok) return handleStepFailure(taskRun, out);

    // 执行失败但属于可恢复的暂时故障：按既有决策排有界重试，不写成永久阻塞
    const failedStop = rawResult?.stop === STOP.failed || rawResult?.ok === false;
    // ★ 会话忙不是「做不成」：执行器可能还在同房间跑上一波。
    //   直接判阻塞会让任务在团队还在干活时就死在「受阻」，用户只能看到红字。
    if (failedStop && isBusyOutcome(rawResult) && (read(taskRun.id)?.retry?.count ?? taskRun.retry?.count ?? 0) < MAX_TRANSIENT_ATTEMPTS) {
      const dueAt = clock() + BUSY_RETRY_MS;
      await patch(taskRun.id, {
        nextAction: null,
        retryAt: dueAt,
        retry: { count: (read(taskRun.id)?.retry?.count ?? taskRun.retry?.count ?? 0) + 1, at: clock() },
      });
      setTimer(dueAt);
      return { status: 'retry_scheduled', dueAt, why: '执行者还在忙，稍后重派' };
    }
    if (failedStop) {
      // ★ attempt 必须取**真实已重试次数**。
      //
      //   原来读的是 nextAction.retryCount —— 那个字段全仓库没有任何地方写过，
      //   所以 attempt 恒等于 1，decideRetry 对普通失败恒返回 retry:true：
      //     · 本来只想给一次机会的失败被重试到上限（10 次），烧时间烧额度；
      //     · 后面的自主重试上限、autonomyMisses、「自主重试 N 次仍未成功」
      //       这些提示全部变成死代码 —— 用户永远看不到那句解释。
      //   retry.count 才是真正在累加的计数，用它。
      const triedTimes = (read(taskRun.id)?.retry?.count ?? taskRun.retry?.count ?? 0) + 1;
      const decision = decideRetry({
        error: String(rawResult?.error ?? rawResult?.text ?? ''),
        status: rawResult?.status ?? null,
        attempt: triedTimes,
      });
      if (decision.retry && (taskRun.retry?.count ?? 0) < MAX_TRANSIENT_ATTEMPTS) {
        const dueAt = clock() + (decision.delayMs ?? 30_000);
        await patch(taskRun.id, {
          nextAction: null,
          retryAt: dueAt,
          retry: { count: (read(taskRun.id)?.retry?.count ?? taskRun.retry?.count ?? 0) + 1, at: clock() },
        });
        setTimer(dueAt);
        return { status: 'retry_scheduled', dueAt };
      }
      // 不再重试：清掉到期标记，交给状态机判定为明确失败
      await patch(taskRun.id, { retryAt: null, nextAction: null });
    }

    // ★ 自主模式：这一轮被判定失败时，自动把它再推起来，而不是等用户点「继续」。
    //   放在这里（归约之后）是因为归约必须如实记录「这次失败了」——
    //   篡改归约结果会让账本撒谎。这里做的是**善后**：清掉阻塞事实、再排一次。
    //   上限 AUTONOMY_RETRY_LIMIT：同一个错误反复重试只会烧时间。
    {
      const nowRun = read(taskRun.id);
      if (nowRun?.flags?.autonomous === true
        && nowRun.state === STATE.blocked
        && nowRun.recoverableBlock == null
        && !nowRun.flags?.blockedByUser) {
        const misses = (nowRun.autonomyMisses ?? 0) + 1;
        if (misses < AUTONOMY_RETRY_LIMIT) {
          await patch(taskRun.id, { autonomyMisses: misses });
          // ★ 必须走 unblock 事件把状态迁回去。
          //   只清 flags.blockedAt 是不够的：state 仍是 blocked，
          //   下一轮 planNextAction 第 93 行照样判阻塞，重试永远不会发生。
          const released = await settle(taskRun.id, {
            type: EVENT.unblocked, revision: nowRun.revision, at: clock(),
            reason: '自主推进：自动解除本轮失败阻塞',
          });
          if (!released.ok) {
            log('自主重试解除阻塞失败：', taskRun.id, released.text ?? released.code);
            return { status: 'blocked', why: released.code ?? 'unblock_failed' };
          }
          await patch(taskRun.id, {
            retryAt: clock() + AUTONOMY_RETRY_MS,
            nextAction: null,
          });
          setTimer(clock() + AUTONOMY_RETRY_MS);
          log('自主模式：第 ' + misses + ' 次失败，自动重试', taskRun.id);
          return { status: 'retry_scheduled', why: 'autonomous_retry_' + misses };
        }
        // ★ 重试用尽：把真正的原因写给用户看。
        //   直接调 block() 是不行的 —— 任务此刻已经是 blocked 状态，
        //   block() 见到 blocked 会提前 return，用户看到的还是通用的
        //   「执行失败」，不知道是自主重试了三轮才放弃。
        const why = '自主重试 ' + misses + ' 次仍未成功，需要你确认下一步：'
          + String(nowRun.flags?.blockedReason ?? '').slice(0, 80);
        await patch(taskRun.id, {
          autonomyMisses: misses,
          flags: { ...(nowRun.flags ?? {}), blockedAt: clock(), blockedReason: why },
        });
        return { status: 'blocked', why: 'autonomy_exhausted', misses };
      }
    }

    const after = read(taskRun.id);
    if (after && (after.state === STATE.cancelled || after.state === STATE.paused_user)) {
      await patch(taskRun.id, { nextAction: null });
      return { status: 'cancelled', why: '执行期间被取消/暂停' };
    }

    await patch(taskRun.id, { nextAction: null, retryAt: null, retry: null, stall: bumpStall(after ?? taskRun) });
    await reconcileEarlyControls({ taskRuns, taskRunId: taskRun.id, settle, patch, notify, clock });
    await releaseDependencyFor(read(taskRun.id) ?? taskRun);
    for (const kid of childrenOf(taskRuns, read(taskRun.id) ?? taskRun)) {
      notify(kid.id);
      notify(taskRun.id);
    }
    return { status: 'ok' };
  }

  /** 把一次执行失败接到既有状态机：预算暂停 / 有界重试 / 结果未知 / 阻塞。 */
  async function handleStepFailure(taskRun, out) {
    const id = taskRun.id;
    if (out.code === 'unknown_outcome') {
      await patch(id, {
        nextAction: { ...(read(id)?.nextAction ?? {}), status: 'unknown' },
        stall: bumpStall(read(id) ?? taskRun),
      });
      await block(id, '执行结果未知，需要先核验外部副作用', 'unknown_outcome');
      return { status: 'unknown' };
    }
    if (out.phase === 'settled_budget') {
      await patch(id, { nextAction: null, recoverableBlock: 'budget_settle' });
      await block(id, `根结算未落盘：${out.text ?? out.code}`);
      return { status: 'blocked', why: 'budget_settle' };
    }
    // 只有真实的额度耗尽才进入预算暂停；身份/版本/存储拒绝如实失败
    if (out.code === 'budget_exhausted' && out.phase === 'reserved') {
      await patch(id, { nextAction: null });
      const paused = await settle(id, { type: EVENT.budget_exhausted, revision: taskRun.revision, at: clock() });
      if (paused.ok) return { status: 'paused_budget' };
    }
    // 预留/登记阶段的生命周期拒绝（如 already_refunded）：立即明确失败，不安排重试
    if (['reserved', 'started', 'dispatched'].includes(out.phase)) {
      await patch(id, { nextAction: null, retryAt: null });
      await block(id, out.text ?? out.code ?? '执行身份不被接受');
      return { status: 'blocked', why: out.code };
    }
    // 有界重试：只有明确 transient 才排重试；结果未知不在此列
    const decision = decideRetry({ error: String(out.text ?? out.code ?? ''), status: out.status ?? null, attempt: (read(id)?.retry?.count ?? 0) + 1 });
    if (decision.retry && (taskRun.retry?.count ?? 0) < MAX_TRANSIENT_ATTEMPTS) {
      const dueAt = clock() + (decision.delayMs ?? 30_000);
      await patch(id, {
        nextAction: null, retryAt: dueAt,
        retry: { count: (taskRun.retry?.count ?? 0) + 1, at: clock() },
      });
      await patch(id, { stall: bumpStall(read(id) ?? taskRun) });
      setTimer(dueAt);
      return { status: 'retry_scheduled', dueAt };
    }
    await patch(id, { nextAction: null, retryAt: null });
    await block(id, out.text ?? out.code ?? '执行失败');
    return { status: 'blocked', why: out.code };
  }

  /** 到期重试的唤醒（事件驱动）；由运行时按最早到期时间调度。 */
  const timers = new Map();
  function setTimer(dueAt) {
    const delay = Math.max(0, dueAt - clock());
    const key = 'retry';
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      for (const run of allRuns()) {
        if (run.retryAt && run.retryAt <= clock()) notify(run.id);
      }
    }, Math.min(delay, 2_147_483_647)));
    timers.get(key).unref?.();
  }

  /** 纯代码验收：只有状态机允许时才归约；拒绝时按未验收继续。 */
  async function doVerify(taskRun) {
    const checker = verify ?? defaultVerify;
    const verification = await checker(taskRun, { access, attemptId: null });
    const out = await settle(taskRun.id, {
      type: EVENT.verification_finished, revision: taskRun.revision, at: clock(),
      passed: verification?.passed === true,
      unmet: verification?.unmet ?? [],
      reason: verification?.reason ?? '',
    });
    const after = read(taskRun.id);
    if (after) await patch(taskRun.id, { stall: bumpStall(after) });
    if (!out.ok) {
      log('验收归约被拒：', taskRun.id, out.text ?? out.code);
      return 'rejected';
    }
    log('验收', taskRun.id, 'passed=', verification?.passed === true);
    return 'ok';
  }

  async function defaultVerify(taskRun, opts) {
    const verification = await verifyTaskRun(taskRun, { access, taskRuns, attemptId: opts?.attemptId ?? null });
    const passed = verification.passed === true
      && (verification.unmet ?? []).length === 0
      && (verification.needsReview ?? []).length === 0
      && (verification.blocked ?? []).length === 0;
    return { ...verification, passed };
  }

  /** 结果未知：只读核验 → 归档结果 → 根结算 → 清未知；核验不了就阻塞。 */
  async function inspectAndSettle(taskRun, { attemptId, slot }) {
    if (typeof inspectOutcome !== 'function') {
      await block(taskRun.id, '执行结果未知且没有核验入口，需人工确认', 'unknown_outcome');
      return false;
    }
    const found = await inspectOutcome({ taskRun, attemptId }).catch(() => null);
    if (!found?.resolved || !found.attemptEvent) {
      await block(taskRun.id, '执行结果未知且无法核验，需人工确认', 'unknown_outcome');
      return false;
    }
    const event = found.attemptEvent;
    const attempt = event.attempt ?? event;
    const finishEvent = {
      type: EVENT.attempt_finished,
      revision: attempt.revision ?? taskRun.revision,
      at: clock(),
      attempt,
    };
    // 已登记尝试的结算不受来源限制；没登记过的才需要先按合法迁移解除阻塞
    let settled = await settle(taskRun.id, finishEvent);
    if (!settled.ok && read(taskRun.id)?.state === STATE.blocked) {
      await settle(taskRun.id, {
        type: EVENT.unblocked, revision: taskRun.revision, at: clock(), reason: '核验到结果，解除阻塞',
      });
      if (read(taskRun.id)?.state === STATE.queued) {
        await settle(taskRun.id, { type: EVENT.dispatch, attemptId: attempt.attemptId, botId: attempt.botId ?? null, revision: taskRun.revision, at: clock() });
      }
      settled = await settle(taskRun.id, finishEvent);
    }
    if (!settled.ok) {
      await block(taskRun.id, '核验结果无法结算');
      return false;
    }
    const filled = await settleRootBudget({
      store: taskRuns,
      rootTaskId: taskRun.rootTaskId ?? taskRun.id,
      taskRunId: slot?.taskRunId ?? attempt.taskRunId ?? taskRun.id,
      attemptId: attempt.attemptId ?? attemptId,
      botId: slot?.botId ?? attempt.botId ?? null,
      revision: attempt.revision ?? taskRun.revision,
      at: clock(),
    });
    if (!filled.ok) {
      await block(taskRun.id, '结果已核验但根结算未落盘，等待恢复补齐', 'budget_settle');
      return false;
    }
    await patch(taskRun.id, { nextAction: null, recoverableBlock: null, unknownBlock: null });
    const fresh = read(taskRun.id);
    if (fresh?.state === STATE.blocked) {
      await settle(taskRun.id, { type: EVENT.unblocked, revision: fresh.revision, at: clock(), reason: '结果已核验并结算' });
      await patch(taskRun.id, { recoverableBlock: null, recoveryTries: 0 });
    }
    notify(taskRun.id);
    return true;
  }

  /**
   * 核对并解除依赖门槛（共用交回路径）。
   *
   * 只认：真实子任务、parentTaskId 一致、父目标版本一致、子任务已验收完成（有交付），
   * 门槛 ref 精确等于该子任务 id。通过既有 dependency_settled 归约解除后唤醒父任务。
   */
  async function releaseDependencyFor(parentTaskRun, childId = null) {
    const parent = parentTaskRun ? read(parentTaskRun.id) ?? parentTaskRun : null;
    if (!parent) return false;
    let released = false;
    for (const gate of [...(parent.openGates ?? [])]) {
      if (gate.kind !== 'dependency') continue;
      if (!gate.ref) continue;
      if (childId && gate.ref !== childId) continue;
      const child = read(gate.ref);
      if (!child) continue;
      if (child.parentTaskId !== parent.id) continue;
      if ((child.parentRevision ?? child.revision) !== parent.revision) continue;
      if (child.state !== STATE.completed || !child.delivery) continue;
      const out = await settle(parent.id, {
        type: EVENT.dependency_settled,
        revision: parent.revision,
        at: clock(),
        dependencyTaskId: child.id,
      });
      if (!out.ok) {
        log('依赖解除被拒：', parent.id, out.text ?? out.code);
        continue;
      }
      released = true;
    }
    if (released) notify(parent.id);
    return released;
  }

  /** 子任务交付时：解除父任务对应依赖门槛，再唤醒父任务。 */
  async function releaseParentDependency(childTaskRun) {
    const parent = childTaskRun?.parentTaskId ? read(childTaskRun.parentTaskId) : null;
    if (!parent) return false;
    return releaseDependencyFor(parent, childTaskRun.id);
  }

  async function deliver(taskRun) {
    const summary = buildDeliverySummary(taskRun);
    await patch(taskRun.id, { delivery: { summary, at: clock(), revision: taskRun.revision }, nextAction: null });
    log('交付', taskRun.id, summary.slice(0, 60));
    // 共用交回事件：先按真实证据解除父的依赖门槛，再唤醒父任务
    await releaseParentDependency(taskRun);
    notifyParent(taskRun);
    return summary;
  }

  /** 子任务进入终态后唤醒父任务；父任务会按自己的判定继续汇总/验收。 */
  function notifyParent(taskRun) {
    const parentId = taskRun?.parentTaskId;
    if (!parentId) return;
    notify(parentId);
  }

  async function recordStall(taskRun) {
    const current = read(taskRun.id) ?? taskRun;
    await patch(current.id, { stall: bumpStall(current) });
  }

  /** 控制入口：类型封闭、决定归一化、到达/早到/重放同一规则。 */
  async function onControl(taskRunId, control = {}) {
    return applyControl({ taskRuns, taskRunId, control, settle, patch, notify, block, clock });
  }

  async function cancelTask(taskRunId, control = {}) {
    // 在途取消：先终止本任务真实执行，再落取消状态（不用整房间 abort）
    if (typeof abortInflight === 'function') {
      await abortInflight({ taskRunId, revision: read(taskRunId)?.revision ?? null }).catch(() => {});
    }
    return onControl(taskRunId, { ...control, type: CONTROL.cancel });
  }

  async function bumpRevision(taskRunId, control = {}) {
    return onControl(taskRunId, { ...control, type: CONTROL.revision });
  }

  /** 扩额恢复：沿用既有扩展协议，唤醒等待中的任务。 */
  /**
   * 扩额恢复：额度只在根上加一次（预算协调器是唯一写入源）。
   *
   *   · 根自身预算暂停 → 用既有 resumed 协议解除；
   *   · 共享子任务不拥有独立额度，按根已追加的事实恢复；
   *   · 只解除预算暂停，不覆盖用户暂停/其他门槛。
   */
  /**
   * 扩额恢复（root 与 child 入口共用同一协议）：
   *
   *   1. 解析根，额度只在根上加一次；
   *   2. 找到共享该根、父版本有效、且处于预算暂停的等待者；
   *   3. 同步「根已追加」事实 → 各自走既有 resumed 协议解除预算暂停；
   *   4. 保留用户暂停与其他门槛；门槛之后解除时直接可用已加额度。
   */
  async function onBudgetExtended(taskRunId, { extraRuns = 1 } = {}) {
    const run = read(taskRunId);
    if (!run) return { ok: false, code: 'not_found' };
    const rootId = run.rootTaskId ?? run.id;

    const extended = await extendRootBudget({ store: taskRuns, rootTaskId: rootId, extraRuns, at: clock() });
    if (!extended.ok) return extended;
    const rootNow = read(rootId) ?? extended.taskRun;
    const sharedExtra = Number(rootNow?.budget?.extraRuns ?? extraRuns);

    const results = [];
    const resumeBudgetPaused = async (candidate) => {
      const current = read(candidate.id);
      if (!current || current.state !== STATE.paused_budget) return null;
      if (current.id !== rootId) {
        // 父版本必须仍然有效，子任务才属于当前这一版目标
        const parent = current.parentTaskId ? read(current.parentTaskId) : null;
        if (!parent || current.parentRevision !== parent.revision) return null;
        await patch(current.id, {
          budget: { ...(current.budget ?? {}), sharedExtraRuns: sharedExtra },
        });
      }
      const resumed = await settle(current.id, {
        type: EVENT.resumed, revision: current.revision, at: clock(),
      });
      results.push({ taskRunId: current.id, ok: resumed.ok, code: resumed.code ?? null });
      if (resumed.ok) notify(current.id);
      return resumed;
    };

    // 共享这个根的所有任务（含根本身）
    const candidates = allRuns().filter((item) => (item.rootTaskId ?? item.id) === rootId);
    for (const candidate of candidates) await resumeBudgetPaused(candidate);
    // 本次目标若不在候选里（例如自身就是 root 但尚未建立 rootTaskId），兜底一次
    if (!candidates.some((c) => c.id === taskRunId)) await resumeBudgetPaused(run);

    notify(rootId);
    const failed = results.find((r) => r.ok !== true);
    if (failed) return { ok: false, code: failed.code ?? 'resume_failed', results };
    return { ok: true, budget: read(rootId)?.budget ?? null, resumed: results.map((r) => r.taskRunId) };
  }

  /**
   * 重启恢复：对每个任务只按 decideRecovery 给出的一个阶段推进，逐步闭合。
   *
   * 结果未知 → 只读核验一次；结果已知 → 只补根结算；结算完成 → 清对应阻塞并唤醒。
   * 任何写入失败都累计恢复尝试并停止本轮，不反复 inspect/写盘。
   */
  async function recover() {
    const report = { released: [], unknown: [], resumed: [], settleFilled: [], blocked: [] };
    const all = allRuns();
    const MAX_TRIES = 3;

    for (const snapshot of all) {
      if (terminal(snapshot)) continue;
      let failed = null;
      for (let i = 0; i < 8; i += 1) {
        const run = read(snapshot.id);
        if (!run || terminal(run)) break;
        const rootId = run.rootTaskId ?? run.id;
        const root = read(rootId) ?? run;
        const { stages } = decideRecovery(run, { root, load: read });
        if (!stages.length) break;
        const st = stages[0];

        if (st.stage === RECOVERY_STAGE.releaseReserved) {
          // 先保存恢复意图，再在事务内释放占位（不删唯一依据，也不用无条件 save 覆盖）
          // 顺序固定：先保存恢复意图 → 再退款（占位还在）→ 最后事务内释放占位
          await patch(run.id, { resumeIntent: 'reserved_released' });
          const refunded = await refundRootBudget({
            store: taskRuns, rootTaskId: rootId, taskRunId: st.ownerRunId ?? run.id,
            attemptId: st.attemptId, botId: st.slot?.botId ?? null,
            revision: st.slot?.revision ?? run.revision, at: clock(),
          });
          if (!refunded.ok && refunded.code !== 'nothing_to_refund') {
            failed = refunded.text ?? refunded.code;
            break;
          }
          const released = await taskRuns.mutate(run.id, {
            mutate: (current) => {
              if (!current) return null;
              const plan = TaskRunStore.releaseNotStarted(current, { at: clock() });
              return plan.changed ? plan.taskRun : null;
            },
          });
          if (!released.ok) { failed = released.text ?? released.code ?? 'release_failed'; break; }
          report.released.push({ taskRunId: st.ownerRunId ?? run.id, attemptId: st.attemptId });
          continue;
        }

        if (st.stage === RECOVERY_STAGE.inspectUnknown) {
          if (typeof inspectOutcome !== 'function') {
            await block(run.id, '执行结果未知且没有核验入口，需人工确认', 'unknown_outcome');
            report.blocked.push({ taskRunId: run.id, attemptId: st.attemptId, reason: 'no_inspector' });
            break;
          }
          const found = await inspectOutcome({ taskRun: run, attemptId: st.attemptId }).catch(() => null);
          if (!found?.resolved || !found.attemptEvent) {
            await block(run.id, '执行结果未知且无法核验，需人工确认', 'unknown_outcome');
            report.blocked.push({ taskRunId: run.id, attemptId: st.attemptId, reason: 'unverifiable' });
            break;
          }
          const attempt = found.attemptEvent.attempt ?? found.attemptEvent;
          const finishEvent = {
            type: EVENT.attempt_finished,
            revision: attempt.revision ?? run.revision,
            at: clock(),
            attempt,
          };
          let settled = await settle(run.id, finishEvent);
          if (!settled.ok && read(run.id)?.state === STATE.blocked) {
            await settle(run.id, {
              type: EVENT.unblocked, revision: run.revision, at: clock(), reason: '核验到结果，解除阻塞',
            });
            if (read(run.id)?.state === STATE.queued) {
              await settle(run.id, { type: EVENT.dispatch, attemptId: attempt.attemptId, botId: attempt.botId ?? null, revision: run.revision, at: clock() });
            }
            settled = await settle(run.id, finishEvent);
          }
          if (!settled.ok) { failed = settled.text ?? settled.code; break; }
          report.unknown.push({ taskRunId: run.id, attemptId: st.attemptId });
          continue;
        }

        if (st.stage === RECOVERY_STAGE.settleBudget) {
          const filled = await settleRootBudget({
            store: taskRuns, rootTaskId: rootId, taskRunId: st.ownerRunId ?? run.id,
            attemptId: st.attemptId, botId: st.slot?.botId ?? null,
            revision: st.slot?.revision ?? run.revision, at: clock(),
          });
          if (!filled.ok) { failed = filled.text ?? filled.code; break; }
          report.settleFilled.push({ taskRunId: st.ownerRunId ?? run.id, attemptId: st.attemptId });
          continue;
        }

        if (st.stage === RECOVERY_STAGE.clearBlocked) {
          const unblocked = await settle(run.id, {
            type: EVENT.unblocked, revision: run.revision, at: clock(), reason: '恢复补齐后解除阻塞',
          });
          if (!unblocked.ok) { failed = unblocked.text ?? unblocked.code; break; }
          await patch(run.id, { recoverableBlock: null, unknownBlock: null, recoveryTries: 0 });
          report.resumed.push(run.id);
          notify(run.id);
          continue;
        }

        if (st.stage === RECOVERY_STAGE.firstDispatch) {
          // 持久 next.action=dispatch + 完整 owner 证据；只唤醒既有 supervisor，不手工造 attempt。
          report.resumed.push(run.id);
          notify(run.id);
          break;
        }

        if (st.stage === RECOVERY_STAGE.resume) {
          if (run.resumeIntent) await patch(run.id, { resumeIntent: null });
          if (Number.isFinite(run.retryAt) && run.retryAt > clock()) setTimer(run.retryAt);
          report.resumed.push(run.id);
          notify(run.id);
          break;
        }
      }

      // 等待依赖的任务：恢复时唤醒一次，走共用依赖核对（child 已完成则解除并继续）
      const waiting = read(snapshot.id);
      if (waiting?.state === STATE.waiting_dependency && !failed
          && (waiting.openGates ?? []).some((g) => g.kind === 'dependency')) {
        report.resumed.push(waiting.id);
        notify(waiting.id);
      }

      if (failed) {
        const fresh = read(snapshot.id) ?? snapshot;
        const tries = (fresh.recoveryTries ?? 0) + 1;
        await patch(snapshot.id, { recoveryTries: tries });
        if (tries >= MAX_TRIES) {
          await block(snapshot.id, '恢复多次写盘失败，暂停自动恢复，需人工确认（不重放外部动作）', 'recovery_exhausted');
        }
        report.blocked.push({ taskRunId: snapshot.id, reason: 'recovery_write_failed', tries, detail: String(failed).slice(0, 120) });
      }
    }
    return report;
  }

  return {
    notify, idle, runTask, onControl, cancelTask, bumpRevision, onBudgetExtended, recover, read,
    descendants: (id) => descendantsOf(taskRuns, id),
    dispose() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}

/** 停滞计数：签名没变 +1，变了清零。 */
function bumpStall(taskRun) {
  const sig = progressSignature(taskRun);
  const prev = taskRun?.stall ?? { rounds: 0, lastSignature: null };
  if (prev.lastSignature === sig) return { rounds: (prev.rounds ?? 0) + 1, lastSignature: sig };
  return { rounds: 0, lastSignature: sig };
}

export { NEXT, LEAD_PHASE, buildLeadPrompt, buildMemberPrompt, buildDeliverySummary };
