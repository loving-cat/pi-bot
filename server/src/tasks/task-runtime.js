/**
 * 推进器的运行器接线：把 PiRunner 的受管执行接到推进器上。
 *
 * ## 职责
 *
 *   · 提供执行器：负责人/成员各跑一次受管 `runRound`，返回真实 attemptEvent；
 *   · 把外部事件（执行结束、审批决定、输入补齐、取消、改版）转成推进器调用；
 *   · 启动时扫描持久待执行动作与未结算占位。
 *
 * 这里只做翻译与生命周期接线，不含判定、创建、验收规则。
 */
import { createTaskSupervisor } from './task-supervisor.js';
import { createChildTask } from './task-subtasks.js';
import { planMentionDispatch, leadConfirmVerification } from './task-mentions.js';
import { createManagedBridges } from './task-bridge.js';
import { bus } from '../bus.js';
import { projectTaskRun } from './task-transport.js';
import { normalizeDecision } from './task-controls.js';
import { createTaskRun } from './task-run-factory.js';
import { admissionBudget } from '../coordination/task-admission.js';
import { newId } from '../util.js';
import { resumeAdmission } from '../coordination/task-admission.js';

/**
 * 建一个运行时接线。
 *
 * @param {object} p
 * @param {object} p.taskRuns TaskRunStore
 * @param {object} p.runner PiRunner
 * @param {(taskRun:object)=>{roomId:string,botId:string}} p.routeOf 任务 → 房间/执行者
 * @param {Function} [p.verify] 验收器
 * @param {object} [p.access] 验收访问器
 * @param {()=>number} [p.clock]
 * @param {Function} [p.log]
 * @returns {object}
 */
export function createTaskRuntime({
  taskRuns,
  runner,
  routeOf,
  verify = null,
  access = null,
  clock = () => Date.now(),
  log = () => {},
  emit = (event) => bus.emit('event', event),
} = {}) {
  if (!runner) throw new Error('运行时需要 runner');

  /** 执行器：跑一次受管执行；负责人轮次额外把正文里的 @ 落成子任务。 */
  const runOne = async ({ taskRun, attemptId, botId, revision, prompt, phase }) => {
    const route = routeOf(taskRun);
    const managedContext = { taskRunId: taskRun.id, revision, attemptId, botId };
    // DM 真实受管执行：复用 run() 的租约/报告/产物/用量；group 保留 runRound
    const roomKind = route.kind ?? taskRun.owner?.roomKind ?? 'group';
    if (roomKind === 'dm') {
      if (typeof runner.roomHasBot === 'function' && !runner.roomHasBot(route.roomId, route.botId)) {
        return { ok: false, stop: 'failed', code: 'DM_BOT_NOT_IN_ROOM', error: '受管目标 Bot 不属于该私聊' };
      }
      return runner.run(route.roomId, route.botId, prompt, { managedContext, skipUserMessage: true });
    }
    const result = await runner.runRound(route.roomId, {
      openerText: prompt,
      openerBotId: null,
      kickoff: true,
      taskPrompt: prompt,
      managedContext,
    });
    // 负责人的这一轮：把他 @ 的人落成持久子任务。
    // 成员轮次不解析（否则会裂变），只看 phase。
    if (phase === 'lead' && taskRun && !taskRun.parentTaskId) {
      try {
        const dispatch = await dispatchByMentions({ taskRun, text: String(result?.text ?? '') });
        if (dispatch) return { ...result, mentionDispatch: dispatch };
      } catch (err) {
        log('@ 派工异常（不影响本轮）：' + String(err?.message ?? err));
      }
    }
    return result;
  };

  /**
   * 任务进入终态/阻塞时，往**原会话**补一条系统可见结论。
   *
   * 团队可能在群里已经跑完并发过言，但用户是从私聊/任务卡进来的；
   * 不回报的话他只看到「受阻」红字，不知道后续到底有没有做完。
   * 只在状态真的变化后发一次，按 taskRunId + state + revision 去重。
   */
  const terminalReported = new Set();
  const reportTerminal = (run) => {
    if (!run) return;
    // ★ 取消不回报。
    //
    //   cancelTask 会**级联**取消所有子孙任务（task-controls.js 里
    //   对 descendants 逐个 settle），每个子任务都算到达终态 ——
    //   于是一次取消会在群里刷出 N 条「任务「…」已取消。」，
    //   把真正的对话内容全顶上去。
    //
    //   而且取消是用户自己点的，他当然知道它停了；
    //   级联出来的子任务更不该逐个报。
    //
    //   保留回报的是三种"用户需要知道但未必看得见"的终态：
    //   completed（结果要交付）、blocked（卡住了要处理）、
    //   paused_budget（额度用尽，要用户决定）。
    if (run.state === 'cancelled') return;
    const terminalStates = new Set(['completed', 'blocked', 'paused_budget']);
    if (!terminalStates.has(run.state)) return;
    // 验收通过后还要走一次交付：等 delivery 落盘再报，否则用户收到的是没有结论的那条。
    if (run.state === 'completed' && !run.delivery) return;
    const key = [run.id, run.state, run.revision].join('|');
    if (terminalReported.has(key)) return;
    terminalReported.add(key);
    const roomId = run.origin?.roomId ?? run.owner?.departmentId ?? null;
    if (!roomId) return;
    try {
      const store = runner.store;
      if (!store || typeof store.getRoom !== 'function' || !store.getRoom(roomId)) return;
      const label = {
        completed: '已完成',
        blocked: '受阻',
        paused_budget: '额度用尽已暂停',
      }[run.state] ?? run.state;
      const requirement = String(run.goal?.requirement ?? run.id).slice(0, 60);
      const lines = ['任务「' + requirement + '」' + label + '。'];
      const delivery = String(run.delivery?.summary ?? '').trim();
      if (delivery) lines.push(delivery.slice(0, 400));
      if (run.state === 'blocked' && run.flags?.blockedReason) {
        lines.push('原因：' + String(run.flags.blockedReason).slice(0, 200));
      }
      store.appendMessage({
        roomId,
        authorType: 'system',
        authorName: '任务状态',
        text: lines.join('\n'),
        status: 'done',
        meta: { via: 'task_terminal', taskRunId: run.id, state: run.state, revision: run.revision },
      });
    } catch (err) {
      log('任务终态回报失败：', err?.message || err);
    }
  };

  const notifyTaskChanged = (taskRunId) => {
    try {
      const loaded = taskRuns.read(taskRunId);
      const run = loaded?.status === 'found' ? loaded.taskRun : null;
      if (!run) return;
      reportTerminal(run);
      const rootId = run.rootTaskId ?? run.id;
      const rootLoaded = rootId === run.id ? loaded : taskRuns.read(rootId);
      const root = rootLoaded?.status === 'found' ? rootLoaded.taskRun : null;
      // ★ 只扫一次，两个 kidsOf 查询共用。
      //
      //   原来 kidsOf(run) 和 kidsOf(root) 各调一次 listAll()，
      //   每次都是全量 readFileSync + JSON.parse + 契约校验。
      //   而每次 settle 成功都会触发这个通知，所以是热路径。
      let scanned = null;
      try {
        const scan = taskRuns.listAll?.();
        scanned = scan?.taskRuns ?? scan ?? [];
      } catch { scanned = null; }
      const kidsOf = (target) => (scanned
        ? scanned.filter((r) => r.parentTaskId === target.id
            && (r.parentRevision ?? r.revision) === target.revision)
        : null);
      const nameOf = (botId) => runner.store?.getBot?.(botId)?.name ?? '';
      emit({ t: 'taskRun.updated', taskRun: projectTaskRun(run, { root, children: kidsOf(run), nameOf }) });
      if (root && root.id !== run.id) emit({ t: 'taskRun.updated', taskRun: projectTaskRun(root, { root, children: kidsOf(root), nameOf }) });
    } catch {}
  };

  /**
   * 负责人这一轮正文里的 @ → 建持久子任务。
   *
   * ## 为什么放在这里
   *
   * 受管执行是单目标的：一次唤醒只跑负责人本人，@ 不会像旧群聊那样
   * 把成员顺次叫起来。不把 @ 落成子任务，负责人就等于对空气喊话 ——
   * 账面只有一个任务、没有成员在做任何事。
   *
   * ## 只做三件事
   *
   *   1. 解析正文里的 @（纯函数，见 task-mentions.js）；
   *   2. 对每个目标调用既有 createChildTask（自带指纹去重）；
   *   3. 记一笔可观测结果，失败不影响主流程。
   *
   * 不判定成员该做什么细节 —— 成员读群消息就能看到负责人的完整原文。
   */
  const dispatchByMentions = async ({ taskRun, text }) => {
    const route = routeOf(taskRun);
    const room = route?.roomId ? runner.store?.getRoom?.(route.roomId) : null;
    if (!room || room.kind !== 'group') return null;
    const leadBotId = taskRun.owner?.leadBotId ?? null;
    if (!leadBotId) return null;

    const members = (room.botIds ?? [])
      .map((id) => runner.store.getBot(id))
      .filter((b) => b && b.id && b.name)
      .map((b) => ({ id: b.id, name: b.name }));

    // 本版本已有子任务（含终态）—— 未终态的会被 plan 跳过
    let existing = [];
    try {
      const scan = taskRuns.listAll?.();
      const all = scan?.taskRuns ?? scan ?? [];
      existing = all
        .filter((r) => r.parentTaskId === taskRun.id
          && (r.parentRevision ?? r.revision) === taskRun.revision)
        .map((r) => ({ botId: r.owner?.leadBotId ?? null, state: r.state }));
    } catch {}

    const plan = planMentionDispatch({ text, members, leadBotId, existingChildren: existing });
    if (!plan.targets.length && !plan.skipped.length) return null;

    const created = [];
    const failures = [];
    for (const target of plan.targets) {
      try {
        const out = await createChildTask({
          taskRuns,
          parentTaskRun: taskRun,
          goal: {
            requirement: '完成负责人在群里交代给你的部分：' + target.excerpt,
            scope: '',
            deliverables: [],
            verification: leadConfirmVerification(),
          },
          botId: target.botId,
          clock,
          // 负责人正文里排在前面的成员先跑
          priority: target.priority ?? 0,
        });
        if (out.ok) created.push({ botId: target.botId, childTaskRunId: out.child?.id ?? null });
        else failures.push({ botId: target.botId, code: out.code ?? null });
      } catch (err) {
        failures.push({ botId: target.botId, code: String(err?.message ?? err) });
      }
    }
    if (created.length) {
      log('@ 派工：新建子任务 ' + created.length + ' 个', taskRun.id);
      for (const c of created) notifyTaskChanged(c.childTaskRunId);
    }
    return { planned: plan.targets.length, created: created.length, skipped: plan.skipped, failures };
  };

  /**
   * 这个任务所在部门有几个人 → 同时能跑几份活。
   *
   * 部门里有 6 个人就是 6 路并行：每个成员会话独立，
   * 人越多越该同时干，固定上限只会让人干等。
   */
  const concurrencyOf = () => {
    try {
      const runs = taskRuns.listAll?.();
      const all = runs?.taskRuns ?? runs ?? [];
      const rooms = new Set(all.map((r) => r.owner?.departmentId).filter(Boolean));
      let best = 1;
      for (const roomId of rooms) {
        const room = runner.store?.getRoom?.(roomId);
        best = Math.max(best, (room?.botIds ?? []).length);
      }
      return Math.max(1, best);
    } catch {
      return 1;
    }
  };

  /**
   * 上游健康度：有熔断开着的比例越高，越该少开并发。
   *
   * key 失效时所有执行都会失败，这时并发只会放大失败 —— 降到 1。
   */
  const healthOf = () => {
    try {
      const bots = (runner.store?.listBots?.() ?? []);
      if (!bots.length) return 1;
      let open = 0;
      let probed = 0;
      for (const bot of bots) {
        const found = runner.breakerFor?.(bot.id);
        if (!found) continue;
        probed += 1;
        if (found.breaker?.state === 'open') open += 1;
      }
      if (!probed) return 1;
      // 全开 → 0（降到 1 个并发）；一半开 → 0.5
      return 1 - open / probed;
    } catch {
      return 1;
    }
  };

  const supervisor = createTaskSupervisor({
    taskRuns,
    onChanged: notifyTaskChanged,
    execute: (ctx) => runOne({ ...ctx, phase: 'lead' }),
    executeMember: (ctx) => runOne({ ...ctx, phase: 'member' }),
    abortInflight: async ({ taskRunId }) => {
      // 任务级取消：终止本任务及其有效子树的在途执行，不动同房间其他目标
      const ids = [taskRunId];
      try {
        for (const childId of supervisor.descendants(taskRunId)) ids.push(childId);
      } catch {}
      for (const id of ids) runner.abortManagedTask?.(id);
    },
    verify,
    access,
    // 只读：受管执行与用户聊天共用会话，忙时让出而不是撞失败。
    isExecutorBusy: ({ botId, taskRun }) => {
      try {
        const route = routeOf(taskRun);
        if (!route?.roomId || !botId) return false;
        return runner.isBusy?.(route.roomId, botId) === true;
      } catch {
        return false;
      }
    },
    /**
     * 只读核验「结果未知」的那次执行到底发生了什么。
     *
     * ★ 生产装配从不注入它，于是任何一次崩溃/超时产生的「结果未知」
     *   都会把任务永久钉死在 blocked：用户点「解除阻塞」，系统核验不了
     *   就立刻判回同一个 blocked —— 死循环，任务永远救不回来。
     *
     *   这里给出一个真实可用的核验入口：查那次尝试有没有落结果。
     *   查得到就把结果交回去让状态机结算；查不到也明确说「查不到」，
     *   让调用方给出可理解的结论，而不是无限重试同一状态。
     */
    inspectOutcome: async ({ taskRun, attemptId }) => {
      try {
        const loaded = taskRuns.read(taskRun.id);
        const current = loaded?.status === 'found' ? loaded.taskRun : null;
        if (!current) return { resolved: false, reason: '任务已不存在' };
        const rec = (current.attempts ?? []).find((a) => a.attemptId === attemptId);
        if (!rec) return { resolved: false, reason: '账本里没有这次执行' };
        // 已经结算过：不需要再核验
        if (rec.state === 'settled') return { resolved: true, alreadySettled: true };
        // 有结果记录就直接结算
        if (rec.result) {
          return {
            resolved: true,
            attemptEvent: {
              type: 'attempt_finished',
              revision: rec.revision ?? current.revision,
              at: clock(),
              attempt: {
                attemptId,
                taskRunId: current.id,
                botId: rec.botId,
                revision: rec.revision ?? current.revision,
                stop: rec.result.stop ?? 'returned',
                phaseKind: rec.phaseKind ?? 'lead',
              },
            },
          };
        }
        // 没有结果：这次执行确实没留下可核验的产出
        return { resolved: false, reason: '这次执行没有留下结果记录' };
      } catch (err) {
        return { resolved: false, reason: String(err?.message ?? err) };
      }
    },
    clock,
    log,
    // 并发数按部门人数走；key 不稳时按健康度自动降级。
    maxConcurrency: concurrencyOf,
    upstreamHealth: healthOf,
  });

  const api = {
    supervisor,
    /** 一次执行结束：推进对应任务。 */
    onAttemptFinished({ taskRunId }) {
      supervisor.notify(taskRunId);
    },
    /** 审批决定：回到原任务。 */
    onApprovalDecided({ taskRunId, approvalId, decision, revision, attemptId = null }) {
      // 只看真实决定；不明确就拒绝，不猜成批准
      const normalized = normalizeDecision('approval_granted', decision);
      if (normalized === 'unknown') {
        return Promise.resolve({ ok: false, code: 'unknown_decision', text: '审批决定不明确，已拒绝' });
      }
      return supervisor.onControl(taskRunId, {
        type: normalized === 'rejected' ? 'approval_rejected' : 'approval_granted',
        decision: normalized,
        approvalId,
        revision,
        attemptId,
      });
    },
    /** 必要输入补齐。 */
    async onInputProvided({ taskRunId, inputKey, revision, text = null }) {
      // 校验与写入落在同一当前记录：入口预检只做早拒绝，不能代替提交校验
      const accepted = await taskRuns.mutate(taskRunId, {
        mutate: (c) => {
          if (!c) return { __reject: { ok: false, code: 'task_not_found', text: '任务不存在' } };
          const currentRevision = revision ?? c.revision;
          if (c.revision !== currentRevision) {
            return { __reject: { ok: false, code: 'stale_revision', text: '目标已更新，输入未写入' } };
          }
          const gate = (c.openGates ?? []).find((g) => g.kind === 'input' && g.ref === String(inputKey ?? ''));
          if (!gate) {
            return { __reject: { ok: false, code: 'input_scope_mismatch', text: '输入与当前门槛不匹配' } };
          }
          const entry = {
            key: String(inputKey ?? ''), text: String(text ?? '').slice(0, 4000),
            at: Date.now(), revision: c.revision, acceptedAt: Date.now(),
          };
          return { ...c, inputs: [ ...(c.inputs ?? []), entry ], updatedAt: Date.now() };
        },
      });
      if (!accepted?.ok) return { ok: false, code: accepted?.code ?? 'input_persist_failed', text: accepted?.text ?? '输入内容未被接受' };
      return supervisor.onControl(taskRunId, { type: 'input_provided', inputKey, revision: revision ?? accepted.taskRun?.revision });
    },

    /** 用户暂停（不绕过预算暂停与门槛）。 */
    onPause({ taskRunId }) {
      return supervisor.onControl(taskRunId, { type: 'pause' });
    },
    /** 用户继续（预算暂停需先追加额度）。 */
    onResume({ taskRunId }) {
      return supervisor.onControl(taskRunId, { type: 'resume' });
    },
    /** 追加根额度：只在根上加一次，并唤醒同根的预算暂停任务。 */
    async onExtendBudget({ taskRunId, extraRuns = 1 }) {
      // ★ 已结束的任务不能再加额度：追加是给「还要继续跑」的任务用的。
      //   不拦的话，用户会给一个已完成/已取消的任务凭空加预算，账面看起来还能跑。
      const loaded = taskRuns.read(taskRunId);
      const current = loaded?.status === 'found' ? loaded.taskRun : null;
      if (!current) return { ok: false, code: 'not_found', text: '任务不存在' };
      if (current.state === 'completed' || current.state === 'cancelled') {
        return { ok: false, code: 'terminal', text: '任务已结束，不能再追加额度' };
      }
      if (!Number.isInteger(Number(extraRuns)) || Number(extraRuns) <= 0) {
        return { ok: false, code: 'bad_extra', text: '追加额度必须是正整数' };
      }
      return supervisor.onBudgetExtended(taskRunId, { extraRuns: Number(extraRuns) });
    },
    /** 解除受阻：清掉阻塞事实并重新推进（不动门槛/暂停/预算/版本）。 */
    onUnblock({ taskRunId, reason = '手动解除阻塞' }) {
      return supervisor.onControl(taskRunId, { type: 'unblock', reason });
    },
    /**
     * 用户在任务板里直接加一条任务。
     *
     * ★ 这是「加一条任务」与执行引擎之间缺失的那座桥。
     *   以前这条输入只写进 /api/tasks 备忘清单，永远不会被派去执行。
     *
     * 走的是和模型接单完全相同的准入链路（createTaskRun + acceptRequest +
     * resumeAdmission），只是路由固定为 direct：不另建部门，交给主控在这个
     * 会话里执行。这样用户手建的任务和模型接的任务在数据上完全同构，
     * 推进/验收/受阻/完成全都走同一套逻辑，不需要特殊分支。
     */
    async onUserCreate({ requesterId, requestId, roomId, goal, fingerprint, title = '' }) {
      const at = clock();
      const id = newId('tr_');
      const appStore = runner.store ?? null;
      if (!appStore) {
        return { ok: false, code: 'no_store', text: '运行时缺少应用存储，无法建任务' };
      }
      const built = createTaskRun({
        id, requestId, requesterId,
        goal,
        origin: { roomId, messageId: null, requesterId },
        budget: admissionBudget(process.env, runner.store?.groupLimits?.() ?? null),
        at,
      });
      if (!built.ok) return { ok: false, code: 'bad_goal', text: built.text };

      // 任务该派给谁：看这个会话是什么。
      //
      // 部门群里必须派给该部门的负责人；派给主控会直接失败 ——
      // 主控不在那个群里，受管执行的身份校验会拒绝
      // （实测报「上下文授权给 chief，但这次部门里没有它」）。
      // 私聊里才走 direct（交给主控在该会话执行）。
      const room = appStore.getRoom?.(roomId) ?? null;
      const deptLead = room?.kind === 'group' ? (room.leadBotId ?? null) : null;
      const route = deptLead ? 'existing' : 'direct';
      const routeSpec = deptLead
        ? { route: 'existing', departmentId: roomId, execute: true, createOnly: false }
        : { route: 'direct', execute: true, createOnly: false };
      const admissionIntent = {
        status: 'pending_handoff',
        requesterId, requestId, fingerprint, roomId, revision: 1,
        operationId: newId('hop_'),
        route,
        routeSpec,
        createOnly: false, execute: true,
        mode: 'user_task', at,
      };
      const accepted = await taskRuns.acceptRequest({
        requesterId, requestId, fingerprint,
        build: () => ({ ...built.taskRun, admission: admissionIntent }),
        at,
      });
      if (!accepted.ok && accepted.created !== false) return accepted;
      const taskRun = accepted.taskRun ?? built.taskRun;
      if (accepted.created === false) {
        // 同一请求已存在：幂等返回，不重复建
        return { ok: true, taskRunId: taskRun.id, duplicate: true };
      }
      // 走真实准入：绑定主控为执行者并置为可调度
      //   store 来自 runner（task-host 装配时注入），顶层没有裸 store 变量。
      const out = await resumeAdmission({
        store: appStore, taskRuns, taskRun: taskRuns.read(taskRun.id)?.taskRun ?? taskRun, clock,
      });
      if (!out?.ok) {
        return { ok: false, code: out?.code ?? 'admission_failed', text: out?.text ?? '任务准入失败', taskRunId: taskRun.id };
      }
      // 立刻唤醒推进器，别等下一轮扫描
      supervisor.notify(taskRun.id);
      return { ok: true, taskRunId: out.taskRunId ?? taskRun.id, leadBotId: out.leadBotId ?? null };
    },
    /** 取消某个目标（只影响它和它的子任务）。 */
    onCancel({ taskRunId, reason }) {
      return supervisor.cancelTask(taskRunId, { reason });
    },
    /** 改目标：升版本，保留成果待重验。 */
    onRevision({ taskRunId, goal, reason, expectedRevision, deferNotify = false }) {
      return supervisor.bumpRevision(taskRunId, { goal, reason, expectedRevision, deferNotify });
    },
    /** 启动扫描：恢复持久待执行动作。 */
    recover() {
      return supervisor.recover();
    },
    /** 找回房间里的受管任务（升级桥用）。 */
    findManagedTask({ roomId, botId = null }) {
      const scan = taskRuns.listAll?.();
      const all = scan?.taskRuns ?? scan ?? [];
      const live = all.filter((run) => run.state !== 'completed'
        && run.state !== 'cancelled'
        && (run.owner?.departmentId === roomId || run.origin?.roomId === roomId)
        && (!botId || run.owner?.leadBotId === botId));
      if (!live.length) return null;
      live.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return { taskRunId: live[0].id, revision: live[0].revision };
    },
    /** 失败升级：回到原任务，由负责人继续或明确阻塞。 */
    async onEscalation({ taskRunId, revision = null, attemptId = null, botId = null, reason = '' }) {
      // 与 04 相同的完整身份字段：缺任一项都是 invalid，不借用其他目标、不降级 legacy
      const loaded = taskRuns.read(taskRunId);
      const run = loaded?.status === 'found' ? loaded.taskRun : null;
      if (!run) return { ok: false, code: 'task_not_found' };
      if (!Number.isInteger(revision) || !attemptId || !botId) {
        return { ok: false, code: 'invalid_context', text: '升级上下文不完整（缺版本/尝试/执行者）' };
      }
      if (revision !== run.revision) {
        return { ok: false, code: 'stale_revision', text: '升级事件属于旧版本目标，不能放到新目标上' };
      }
      // ★ 升级允许「负责人」和「实际执行这次尝试的成员」，但不能是无关 Bot。
      //
      //   原来只允许负责人发起，而升级的语义恰恰是「我干不了，交回负责人」——
      //   最需要发起的正是成员。于是成员的升级一律被 invalid_context 拒掉，
      //   既不回落到负责人、也不重试、更不产生任何消息：
      //   用户那边就是「这个任务悄无声息地停了」，群里什么都没发生。
      const attempt = (run.attempts ?? []).find((a) => a.attemptId === attemptId);
      if (!attempt || attempt.state !== 'registered') {
        return { ok: false, code: 'invalid_context', text: '升级引用的执行不属于该任务' };
      }
      const isLead = Boolean(run.owner?.leadBotId) && run.owner.leadBotId === botId;
      const isExecutor = attempt.botId === botId;
      if (!isLead && !isExecutor) {
        return { ok: false, code: 'invalid_context', text: '升级只能由该任务负责人或这次执行者发起' };
      }
      return supervisor.onControl(taskRunId, { type: 'escalated', reason, attemptId }).catch(() => null);
    },
    idle() {
      return supervisor.idle();
    },
  };

  // 可装配点：生产 HTTP/升级路径通过 runner.taskRuntime 找到桥；
  // 没有装配时旧路径完全不变。
  runner.taskRuntime = api;
  runner.taskBridges = createManagedBridges({ runtime: api, taskRuns });
  return api;
}
