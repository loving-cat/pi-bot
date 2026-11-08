/**
 * 主控自然语言任务入口：进度查询 / 要求修订。
 *
 * 只读或薄提交，不新起 TaskRun：
 *   · 进度：读 TaskRunStore + 用户投影，回答当前事实，不取消/重建/加预算；
 *   · 修订：稳定操作身份（认证请求 → commandId）+ 既有命令应用事实 + request 结果收口，
 *     沿原 taskRunId 升一次 revision，保留旧成果待重验，不覆盖 TaskRun.request。
 */
import crypto from 'node:crypto';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { projectForUser } from '../tasks/task-projection.js';
import { remainingRuns } from '../tasks/task-budget.js';
import { projectTaskRun } from '../tasks/task-transport.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const error = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function roomTasks(taskRuns, roomId) {
  const scan = taskRuns.listAll?.();
  const all = scan?.taskRuns ?? scan ?? [];
  return all
    .filter((t) => t.origin?.roomId === roomId || t.owner?.departmentId === roomId)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function liveOf(list) {
  return list.filter((t) => t.state !== 'completed' && t.state !== 'cancelled');
}

/** 解析唯一目标：显式 id 优先；没有 id 且同 room 多目标时澄清，不按最新时间猜。 */
function resolveTarget(taskRuns, roomId, explicitId) {
  const all = roomTasks(taskRuns, roomId);
  if (explicitId) {
    const found = all.find((t) => t.id === explicitId) ?? null;
    if (!found) return { ok: false, code: 'task_not_found', text: `房间内找不到任务 ${explicitId}` };
    return { ok: true, taskRun: found };
  }
  const live = liveOf(all);
  if (live.length === 1) return { ok: true, taskRun: live[0] };
  if (live.length === 0 && all.length === 1) return { ok: true, taskRun: all[0] };
  if (live.length === 0 && all.length === 0) return { ok: false, code: 'no_task', text: '这个会话里还没有任务。' };
  return {
    ok: false, code: 'ambiguous_task',
    text: '会话里有多项任务，指代不明确。请明确要处理哪一个：' + live.map((t) => t.id).join('、'),
    candidates: live.map((t) => t.id),
  };
}

function summary(run, taskRuns) {
  const root = (run.rootTaskId && run.rootTaskId !== run.id) ? (taskRuns?.load?.(run.rootTaskId) ?? run) : run;
  const user = projectForUser(run) ?? {};
  const budget = root.budget ?? run.budget ?? {};
  const remaining = remainingRuns(budget);
  return [
    `任务 ${run.id}`,
    `状态：${run.state}（${user.stateText ?? run.state}）`,
    `版本：第 ${run.revision} 版`,
    `目标：${run.goal?.requirement ?? ''}`,
    `预算：已用 ${budget.usedRuns ?? 0}/${budget.maxRuns ?? '?'}，剩余 ${remaining}` + (root.id !== run.id ? '（共享根 ' + root.id + '）' : ''),
    run.state === 'completed' || run.state === 'cancelled' ? '已结束' : '仍在推进',
  ].join('\n');
}

function commandIdOf(scope) {
  const hash = crypto.createHash('sha256')
    .update(String(scope.requesterId) + '\u0000' + String(scope.requestId))
    .digest('hex');
  return ('rev_' + hash).slice(0, 54);
}

export function buildTaskInsightTools({ runner, store, roomId, botId }) {
  const taskRuns = store.taskRuns;
  const currentScope = () => runner.currentRequestScope?.(roomId, botId) ?? null;
  const answerCurrent = (reason) => {
    const scope = currentScope();
    if (scope) runner.setRequestDecision?.(roomId, botId, scope, 'answer', { reason });
  };

  const statusTool = defineTool({
    name: 'task_status',
    label: '查看任务进度',
    description: '用户问“进度怎样/做到哪了”时，读取这个会话里原任务的权威状态。只读，不取消、不重建、不追加预算。',
    parameters: Type.Object({
      taskRunId: Type.Optional(Type.String({ description: '明确指定的任务 id；不填且会话只有一个目标时自动定位' })),
    }),
    execute: async (_id, params) => {
      const target = resolveTarget(taskRuns, roomId, params?.taskRunId?.trim() || null);
      if (!target.ok) {
        if (target.code === 'ambiguous_task') {
          const scope = currentScope();
          if (scope) runner.setRequestDecision?.(roomId, botId, scope, 'clarification', { reason: 'task_ambiguous' });
        } else {
          answerCurrent('task_status_none');
        }
        return text(target.text);
      }
      answerCurrent('task_status');
      return text(summary(target.taskRun, taskRuns));
    },
  });

  const reviseTool = defineTool({
    name: 'task_revise',
    label: '修改原任务要求',
    description: '用户补充或改变原任务要求时，沿原任务升一个版本（不新起任务）。必须明确目标任务；同一次用户请求重试不会重复升版。',
    parameters: Type.Object({
      taskRunId: Type.Optional(Type.String({ description: '明确指定的任务 id；不填且会话只有一个目标时自动定位' })),
      requirement: Type.Optional(Type.String({ description: '修改后的完整目标要求' })),
      scope: Type.Optional(Type.String({ description: '修改后的范围/边界' })),
      deliverables: Type.Optional(Type.Array(Type.String(), { description: '修改后的交付物清单' })),
      verification: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String()),
        kind: Type.Union([
          Type.Literal('artifact'), Type.Literal('format'), Type.Literal('count'),
          Type.Literal('test'), Type.Literal('receipt'), Type.Literal('expert'),
        ]),
        description: Type.String(),
        spec: Type.Optional(Type.Any()),
        required: Type.Optional(Type.Boolean()),
      }), { description: '修改后的验收条件' })),
      expectedRevision: Type.Optional(Type.Integer({ description: '用户看到的目标版本；不填则用当前版本' })),
      reason: Type.Optional(Type.String({ description: '修改原因（给任务记录用）' })),
    }),
    execute: async (_id, params) => {
      const scope = currentScope();
      if (!scope) return error('这次修改没有用户请求身份，不能安全地生成可重试操作。');
      const commands = runner.taskCommands;
      if (!commands?.handle) return error('任务命令服务未就绪，不能安全改版。');
      const commandId = commandIdOf(scope);
      const requesterId = scope.requesterId;
      const runCommand = async (taskRunId, envelope) => commands.handle({
        taskRunId,
        body: {
          commandId, type: 'revision',
          expectedRevision: envelope.expectedRevision,
          goal: envelope.goal,
          reason: envelope.reason,
          deferNotify: envelope.deferNotify === true,
        },
        device: { id: requesterId },
        findRun: (id) => store.taskRuns.read(id)?.taskRun ?? null,
        snapshotOf: (run) => projectTaskRun(run),
      });

      // 重放：先读原操作信封与应用事实，不按当前版本/当前 Goal 重新解释
      let existing = null;
      try { existing = commands.getCommand?.(requesterId, commandId) ?? null; } catch {}
      if (existing?.status === 'corrupt') return error('原修改操作回执损坏，不能重试（未重新改版）。');
      if (existing?.status === 'ok') {
        const record = existing.command;
        const envelope = record?.envelope ?? {};
        if (!record?.taskRunId || !envelope.goal || !Number.isInteger(envelope.expectedRevision)) {
          return error('原修改操作信封不完整，不能重试（未重新改版）。');
        }
        const out = await runCommand(record.taskRunId, envelope);
        if (!out || out.status >= 400) {
          const code = out?.body?.code ?? 'UNKNOWN';
          const suffix = code === 'COMMAND_INDETERMINATE' ? '原操作可能已生效但无法确认，请查任务当前版本，未再次改版。' : (out?.body?.text ?? '改版未生效');
          return error(suffix);
        }
        answerCurrent('task_revised');
        runner.queueAdmittedTask?.(record.taskRunId);
        const replay = out.body?.replayed === true;
        return text(replay
          ? '同一次修改请求已经生效过，本次按原操作事实回放，没有再次升版。'
          : '已沿原任务升到新版本；旧成果保留待重新核验，新目标继续推进。');
      }

      // 首次：冻结目标任务、原版本与完整修改方案，之后交给命令服务持久
      const target = resolveTarget(taskRuns, roomId, params?.taskRunId?.trim() || null);
      if (!target.ok) return error(target.text);
      const task = target.taskRun;
      if (task.state === 'completed' || task.state === 'cancelled') {
        return error(`任务 ${task.id} 已${task.state === 'completed' ? '完成' : '取消'}，不能直接改版。`);
      }
      const expectedRevision = params?.expectedRevision ?? task.revision;
      if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) {
        return error(`目标版本已变化（当前第 ${task.revision} 版），请基于最新版本重新确认修改。`);
      }
      const patch = {};
      if (typeof params?.requirement === 'string' && params.requirement.trim()) patch.requirement = params.requirement.trim();
      if (typeof params?.scope === 'string' && params.scope.trim()) patch.scope = params.scope.trim();
      if (Array.isArray(params?.deliverables) && params.deliverables.length) patch.deliverables = params.deliverables;
      if (Array.isArray(params?.verification) && params.verification.length) patch.verification = params.verification;
      if (!Object.keys(patch).length) return error('没有提供要修改的目标字段。');
      const goal = { ...(task.goal ?? {}), ...patch };
      const envelope = { expectedRevision, goal, reason: params?.reason ?? '用户补充/修改要求', deferNotify: true };
      const out = await runCommand(task.id, envelope);
      if (!out || out.status >= 400) {
        return error(`改版未生效：${out?.body?.text ?? out?.body?.code ?? '未知错误'}`);
      }
      answerCurrent('task_revised');
      runner.queueAdmittedTask?.(task.id);
      return text(`已沿原任务 ${task.id} 升到第 ${out.body?.taskRun?.revision ?? task.revision + 1} 版；旧成果保留待重新核验，新目标继续推进。`);
    },
  });

  const unblockTool = defineTool({
    name: 'task_unblock',
    label: '解除任务受阻',
    description:
      '任务被判定为「受阻」后，若外部原因已消失、或你已确认可以继续，用这个解除阻塞，'
      + '让它按原目标继续推进。只清阻塞事实：不改目标、不绕过验收、不动暂停与预算。'
      + '如果用户要求换目标，用 task_revise；要放弃则用取消。',
    parameters: Type.Object({
      taskRunId: Type.Optional(Type.String({ description: '明确指定的任务 id；不填且会话只有一个目标时自动定位' })),
      reason: Type.Optional(Type.String({ description: '为什么可以继续（给任务记录用）' })),
    }),
    execute: async (_id, params) => {
      const scope = currentScope();
      if (!scope) return error('这次操作没有用户请求身份，不能安全地生成可重试操作。');
      const commands = runner.taskCommands;
      if (!commands?.handle) return error('任务命令服务未就绪，不能安全解除阻塞。');
      const target = resolveTarget(taskRuns, roomId, params?.taskRunId?.trim() || null);
      if (!target.ok) return error(target.text);
      const task = target.taskRun;
      if (task.state !== 'blocked' && !task.flags?.blockedAt) {
        return text('任务当前没有受阻，不需要解除。');
      }
      const commandId = commandIdOf(scope);
      const out = await commands.handle({
        taskRunId: task.id,
        body: {
          commandId,
          type: 'unblock',
          expectedRevision: task.revision,
          reason: String(params?.reason ?? '已确认可以继续').slice(0, 200),
        },
        device: { id: scope.requesterId },
        findRun: (id) => store.taskRuns.read(id)?.taskRun ?? null,
        snapshotOf: (run) => projectTaskRun(run),
      });
      if (!out || out.status >= 400) {
        return error('解除阻塞未生效：' + (out?.body?.text ?? out?.body?.code ?? '未知错误'));
      }
      answerCurrent('task_unblocked');
      runner.queueAdmittedTask?.(task.id);
      return text(out.body?.replayed === true
        ? '同一次解除请求已经生效过，本次按原操作回放，没有重复解除。'
        : '已解除任务 ' + task.id + ' 的阻塞，它会按原目标继续推进；完成与否仍由验收决定。');
    },
  });

  const extendTool = defineTool({
    name: 'task_extend_budget',
    label: '追加任务额度',
    description:
      '用户要求「再加几次额度 / 让它继续跑」时，给任务追加执行次数。'
      + '额度只在根任务上加一次，共享这个根的所有任务都会恢复；已用次数不会清零。'
      + '不接受负数和 0。',
    parameters: Type.Object({
      taskRunId: Type.Optional(Type.String({ description: '明确指定的任务 id；不填且会话只有一个目标时自动定位' })),
      extraRuns: Type.Integer({ description: '要增加多少次执行（正整数）' }),
      reason: Type.Optional(Type.String({ description: '为什么加（给任务记录用）' })),
    }),
    execute: async (_id, params) => {
      const scope = currentScope();
      if (!scope) return error('这次操作没有用户请求身份，不能安全地生成可重试操作。');
      const commands = runner.taskCommands;
      if (!commands?.handle) return error('任务命令服务未就绪，不能安全追加额度。');
      const extra = Number(params?.extraRuns ?? 0);
      if (!Number.isInteger(extra) || extra <= 0) return error('追加额度必须是正整数。');
      const target = resolveTarget(taskRuns, roomId, params?.taskRunId?.trim() || null);
      if (!target.ok) return error(target.text);
      const task = target.taskRun;
      if (task.state === 'completed' || task.state === 'cancelled') {
        return error('任务已结束，不能再追加额度。');
      }
      const commandId = commandIdOf(scope);
      const out = await commands.handle({
        taskRunId: task.id,
        body: {
          commandId,
          type: 'extend',
          expectedRevision: task.revision,
          extraRuns: extra,
          reason: String(params?.reason ?? '用户追加额度').slice(0, 200),
        },
        device: { id: scope.requesterId },
        findRun: (id) => store.taskRuns.read(id)?.taskRun ?? null,
        snapshotOf: (run) => projectTaskRun(run),
      });
      if (!out || out.status >= 400) {
        return error('追加额度未生效：' + (out?.body?.text ?? out?.body?.code ?? '未知错误'));
      }
      answerCurrent('task_budget_extended');
      runner.queueAdmittedTask?.(task.id);
      const budget = out.body?.taskRun?.budget;
      return text(out.body?.replayed === true
        ? '同一次追加请求已经生效过，本次按原操作回放，没有重复加额度。'
        : '已为任务 ' + task.id + ' 追加 ' + extra + ' 次额度'
          + (budget?.maxRuns != null ? '（当前上限 ' + budget.maxRuns + '，已用 ' + (budget.usedRuns ?? 0) + '）' : '')
          + '。原目标不变，继续按既有验收推进。');
    },
  });

  return [statusTool, reviseTool, unblockTool, extendTool];
}
