/**
 * 负责人专业验收判断：只有真实部门负责人在受管验收回合可记一条
 * 与任务/版本/条件/来源绑定的事实；机械验收消费它，普通完成文本不能代替。
 */
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readManagedSubmission, SUBMISSION } from '../coordination/task-context.js';
import { isRoomLead } from '../role-tools.js';
import { VERIFY_KIND } from './task-contract.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const error = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

export function buildExpertReviewTool({ runner, store, roomId, botId }) {
  const taskRuns = store.taskRuns;
  return defineTool({
    name: 'task_expert_review',
    label: '负责人专业验收',
    description:
      '负责人对当前受管任务的 expert 验收条件作专业判断（通过/不通过并说明理由）。' +
      '这是判断记录，不是机械证明；机械条件仍由系统另行核对。',
    parameters: Type.Object({
      conditionId: Type.String({ description: '目标里 expert 验收条件的 id' }),
      verdict: Type.Union([Type.Literal('passed'), Type.Literal('failed')]),
      note: Type.String({ description: '判断依据（为什么通过/不通过）' }),
      expectedRevision: Type.Optional(Type.Integer({ description: '负责人看到的目标版本；不填用当前版本' })),
    }),
    execute: async (_id, params) => {
      const submission = readManagedSubmission({ runner, taskRuns, roomId, botId });
      if (submission.kind !== SUBMISSION.managed) return error(submission.kind === SUBMISSION.invalid ? submission.text : '当前不是受管验收回合。');
      const room = store.getRoom(roomId);
      if (!room || !isRoomLead(room, botId)) return error('只有本部门真实负责人可以作专业验收判断。');
      const conditionId = String(params?.conditionId ?? '').trim();
      const verdict = params?.verdict;
      const note = String(params?.note ?? '').trim();
      if (!conditionId || !note) return error('专业判断需要条件 id 和判断依据。');
      if (verdict !== 'passed' && verdict !== 'failed') return error('专业判断必须明确通过或不通过。');
      const expectedRevision = params?.expectedRevision ?? submission.revision;
      let result = null;
      const written = await taskRuns.mutate(submission.taskRunId, {
        mutate: (c) => {
          if (!c) return { __reject: { ok: false, code: 'task_not_found', text: '任务不存在' } };
          if (c.revision !== expectedRevision || c.revision !== submission.revision) {
            return { __reject: { ok: false, code: 'stale_revision', text: '专业判断针对的目标版本已过期' } };
          }
          const condition = (c.goal?.verification ?? []).find((x) => x.id === conditionId);
          if (!condition || condition.kind !== VERIFY_KIND.expert) {
            return { __reject: { ok: false, code: 'review_scope_mismatch', text: '这个条件不是当前版本的专业验收条件' } };
          }
          // 同一受管执行内的重复工具调用是操作重放；新的执行轮次是新的合法审查，
          // 不能把 conditionId+revision 当成永久幂等键。审查历史 append，消费者取当前有效结论。
          const sameAttempt = (c.expertReviews ?? []).find((r) => r.conditionId === conditionId
            && r.revision === c.revision
            && r.attemptId === submission.attemptId);
          if (sameAttempt) {
            if (sameAttempt.verdict !== verdict || sameAttempt.note !== note.slice(0, 600)) {
              return { __reject: { ok: false, code: 'review_conflict', text: '同一执行同一条件已有不同判断，不能覆盖原操作' } };
            }
            result = { replay: true };
            return null;
          }
          const review = {
            taskRunId: c.id, revision: c.revision, conditionId,
            verdict, note: note.slice(0, 600),
            leadBotId: botId, attemptId: submission.attemptId,
            source: 'lead_review', at: Date.now(),
          };
          result = review;
          return { ...c, expertReviews: [ ...(c.expertReviews ?? []), review ].slice(-50), updatedAt: Date.now() };
        },
      });
      if (!written?.ok) return error(written?.text ?? '专业判断没有落盘');
      if (!result) return error('专业判断没有落盘');
      return text(result.replay ? '该版本该条件已有相同专业判断，已复用。' : '专业判断已记录；系统会把它与机械条件分开核对。');
    },
  });
}
