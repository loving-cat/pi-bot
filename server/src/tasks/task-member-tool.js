/**
 * 成员派活工具：负责人把工作拆成持久子任务。
 *
 * ## 职责
 *
 * 只做编排：复用 04 的可信提交与统一 guard 核对身份，核对部门职责与成员资格，
 * 再交给子任务契约落盘。子任务契约、预算归属、验收条件都复用既有模块。
 *
 * ## 边界
 *
 *   · 只有**这个部门**的负责人能派活（不是"owner 恰好是我"）；
 *   · 成员必须属于本部门；
 *   · 取消/改版/旧尝试在写入前后各核一次；
 *   · 不启动执行 —— 由推进器在持久化之后调度。
 */
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { createChildTask } from './task-subtasks.js';
import { readManagedSubmission, revalidateManaged, SUBMISSION } from '../coordination/task-context.js';
import { isLeadOfRoom } from '../role-tools.js';

const error = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * 构造「派给成员」工具。
 *
 * @param {object} p
 * @param {object} p.runner
 * @param {object} p.store 应用 store
 * @param {string} p.roomId
 * @param {string} p.botId
 */
export function buildMemberTaskTool({ runner, store, roomId, botId }) {
  const taskRuns = store.taskRuns;
  return defineTool({
    name: 'assign_member_task',
    label: '把活派给成员',
    description:
      '把当前目标拆出一份可独立完成的小任务，派给部门里的某个成员去做。' +
      '每份小任务都要写清目标与验收条件；派出去之后成员会自己执行，结果回来你再继续。' +
      '如果两份活要改同一批文件，填 files 声明一下——撞车的会排队，不会两个人同时改坏同一份文件。' +
      '不要替成员做它们自己的工作。',
    parameters: Type.Object({
      memberBotId: Type.String({ description: '指派给哪个成员（部门成员 id）' }),
      requirement: Type.String({ description: '这份小任务要达成什么' }),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            '这份活会碰的文件或目录路径（仓库内相对路径）。'
            + '填了就与其它正在跑的活互斥：别人也在改同一批文件时，这份会排队而不是同时写坏。不填表示不知道/不冲突。',
        }),
      ),
      deliverables: Type.Optional(Type.Array(Type.String(), { description: '交付物清单' })),
      verification: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String()),
          kind: Type.Union([
            Type.Literal('artifact'),
            Type.Literal('format'),
            Type.Literal('count'),
            Type.Literal('test'),
            Type.Literal('receipt'),
            Type.Literal('expert'),
          ]),
          description: Type.String({ description: '怎么算做完' }),
          spec: Type.Optional(Type.Any()),
          required: Type.Optional(Type.Boolean()),
        }),
        { description: '验收条件，至少一条' },
      ),
    }),
    execute: async (_toolCallId, params) => {
      // 1) 复用 04 可信提交与统一 guard
      const submission = readManagedSubmission({ runner, taskRuns, roomId, botId });
      if (submission.kind === SUBMISSION.invalid) {
        return error(`这次执行不能派活：${submission.text}`);
      }
      if (submission.kind !== SUBMISSION.managed) {
        return error('当前没有受管任务，不能派活。');
      }

      // 2) 部门职责：必须是这个部门的负责人
      const room = store.getRoom(roomId);
      if (!room || room.kind !== 'group' || !isLeadOfRoom(room, botId)) {
        return error('只有部门负责人可以派活。');
      }

      // 3) 成员必须是本部门成员
      const memberBotId = String(params.memberBotId ?? '');
      if (!(room.botIds ?? []).includes(memberBotId)) {
        return error('这个成员不在当前部门里。');
      }

      const loaded = taskRuns.read(submission.taskRunId);
      const parent = loaded?.status === 'found' ? loaded.taskRun : null;
      if (!parent) return error('找不到当前任务。');

      // 4) 写入前再核：取消/改版/旧尝试都拦住
      const stale = revalidateManaged(parent, {
        taskRuns,
        expectRevision: submission.revision,
        attemptId: submission.attemptId,
        botId,
        // 派活只能发生在任务自己的会话里（防跨部门串台）
        roomId,
      });
      if (stale) return error(`这次派工已失效：${stale.text}`);

      const goal = {
        requirement: String(params.requirement ?? '').slice(0, 600),
        scope: '',
        deliverables: (params.deliverables ?? []).map((x) => String(x)).slice(0, 20),
        verification: (params.verification ?? []).map((v, i) => ({
          id: String(v.id ?? 'vc' + (i + 1)),
          kind: String(v.kind),
          description: String(v.description ?? ''),
          spec: v.spec && typeof v.spec === 'object' ? v.spec : {},
          required: v.required !== false,
        })),
      };

      const created = await createChildTask({
        taskRuns,
        parentTaskRun: parent,
        goal,
        botId: memberBotId,
        files: params.files ?? [],
      });
      if (!created.ok) return error(`没派出去：${created.text ?? created.code}`);

      // 5) 写入后再核父版本：期间被改版就不算这次派工生效
      const after = taskRuns.read(submission.taskRunId);
      const stillSame = after?.status === 'found' && after.taskRun?.revision === submission.revision;
      if (!stillSame) return error('派工期间父目标已改版，这次派工不生效。');

      const claims = created.child?.fileClaims ?? [];
      return {
        content: [{
          type: 'text',
          text: `已派给成员，子任务 ${created.child?.id} 已登记。`
            + (claims.length ? `\n占用的文件：${claims.join('、')}（撞车的活会排队）` : ''),
        }],
        details: { childTaskRunId: created.child?.id ?? null, reused: created.reused === true, files: claims },
      };
    },
  });
}
