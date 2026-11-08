/**
 * 负责人**先列计划、再按计划派活**的工具。
 *
 * ## 为什么需要它
 *
 * 正常团队是这么运作的：先有一份分工方案（谁做什么、先后、交付什么），
 * 然后照着分发。没有这份方案的「派活」是一次性的、不可复核的 ——
 * 出了偏差没人知道该对齐到哪里。
 *
 * 有了计划之后：
 *   · 用户能在任务详情里看到「这件事打算怎么做」；
 *   · 负责人自己每一轮都能读到这份计划，按它对齐而不是每轮重新想；
 *   · 派活时可以标明属于计划里的哪一条，缺了哪条一目了然。
 *
 * ## 边界
 *
 *   · 只写计划，不派活、不改目标、不动验收；
 *   · 计划存在 progress.checkpoint（受版本保护，改版会重建）；
 *   · 同一轮重复调用是覆盖，不是追加（负责人可以修订自己的计划）。
 */
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readManagedSubmission, SUBMISSION } from '../coordination/task-context.js';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const error = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** 计划最多几条分工：够表达一个部门的分工，又不会变成没人看的清单。 */
const MAX_STEPS = 12;

/** 单条分工的文本上限。 */
const MAX_STEP_CHARS = 300;

/**
 * 把负责人给的分工整理成可存的结构。
 *
 * @param {Array<object>} steps
 * @param {Array<object>} members 部门成员（用于解析 assignee）
 * @returns {{ok:boolean, steps?:Array, text?:string}}
 */
export function normalizePlan(steps, members = []) {
  if (!Array.isArray(steps) || !steps.length) return { ok: false, text: '计划至少要有一条分工。' };
  const byName = new Map(members.map((m) => [String(m.name ?? '').trim(), m.id]));
  const byId = new Set(members.map((m) => m.id));
  const out = [];
  for (const raw of steps.slice(0, MAX_STEPS)) {
    const task = String(raw?.task ?? raw?.requirement ?? '').trim().slice(0, MAX_STEP_CHARS);
    if (!task) continue;
    const who = String(raw?.member ?? raw?.assignee ?? '').trim();
    const botId = byId.has(who) ? who : (byName.get(who) ?? null);
    out.push({
      task,
      memberName: who || '未指定',
      memberBotId: botId,
      deliverable: String(raw?.deliverable ?? '').trim().slice(0, MAX_STEP_CHARS),
    });
  }
  if (!out.length) return { ok: false, text: '没有可用的分工条目（每条要有 task）。' };
  return { ok: true, steps: out };
}

/** 把计划渲染成给模型/用户看的一段文本。 */
export function renderPlan(steps) {
  if (!Array.isArray(steps) || !steps.length) return '';
  return steps
    .map((s, i) => (i + 1) + '. ' + s.memberName + '：' + s.task + (s.deliverable ? '（交付：' + s.deliverable + '）' : ''))
    .join('\n');
}

/**
 * 构造「列出计划」工具。
 *
 * @param {object} p
 * @param {object} p.runner
 * @param {object} p.store
 * @param {string} p.roomId
 * @param {string} p.botId
 */
export function buildPlanTool({ runner, store, roomId, botId }) {
  const taskRuns = store.taskRuns;
  return defineTool({
    name: 'task_plan',
    label: '★ 列出这次的分工计划',
    description:
      '在派活**之前**先写出这件事怎么做：每条写清交给谁、要做什么、交付什么。'
      + '写好之后再照它一个一个派出去；之后每一轮你都会读到这份计划，按它对齐。'
      + '同一轮重复调用是修订计划（覆盖），不是追加。',
    parameters: Type.Object({
      steps: Type.Array(
        Type.Object({
          member: Type.String({ description: '交给谁（成员名字或 id）' }),
          task: Type.String({ description: '这个人要做什么' }),
          deliverable: Type.Optional(Type.String({ description: '交付什么' })),
        }),
        { description: '分工清单：按你希望的执行先后排列' },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const submission = readManagedSubmission({ runner, taskRuns, roomId, botId });
      if (submission.kind === SUBMISSION.invalid) return error('现在不能写计划：' + submission.text);
      if (submission.kind !== SUBMISSION.managed) return error('当前没有受管任务，不能写计划。');
      // ★ 受管提交里没有 taskRun 对象，只有身份字段。
      //   原来读 submission.taskRun 恒为 undefined，这个工具一调用就崩
      //   （Cannot read properties of undefined），等于完全不可用。
      const loaded = taskRuns.read(submission.taskRunId);
      const run = loaded?.status === 'found' ? loaded.taskRun : null;
      if (!run) return error('找不到当前任务，不能写计划。');

      const room = store.getRoom(roomId);
      const members = (room?.botIds ?? [])
        .map((id) => store.getBot(id))
        .filter(Boolean)
        .map((b) => ({ id: b.id, name: b.name, role: b.role }));

      const normalized = normalizePlan(params?.steps, members);
      if (!normalized.ok) return error(normalized.text);

      const text = renderPlan(normalized.steps);
      const updated = await taskRuns.mutate(run.id, {
        mutate: (current) => {
          if (!current) return null;
          if (current.revision !== submission.revision) return null;
          return {
            ...current,
            progress: { ...(current.progress ?? {}), checkpoint: text },
            plan: { steps: normalized.steps, at: Date.now(), revision: current.revision },
          };
        },
      });
      if (!updated?.ok) return error('计划没写进去：任务已被改动，重新读一次再写。');

      const missing = normalized.steps.filter((s) => !s.memberBotId);
      return ok(
        '计划已登记，共 ' + normalized.steps.length + ' 条：\n' + text
          + (missing.length
            ? '\n注意：这些条目没对上部门成员：' + missing.map((s) => s.memberName).join('、')
            : '')
          + '\n接下来按这个顺序用 assign_member_task 或 @ 一个一个派出去。',
        { steps: normalized.steps },
      );
    },
  });
}