/**
 * 接单工具：把这一轮已有理解结果提交为正式接单。
 *
 * ## 两条固定来源，各自校验、互不降级
 *
 *   · 受管执行（已有 TaskRun 的负责人）：走 04 的统一交接入口，读可信受管提交；
 *   · 首次接单（用户原始请求的理解轮）：走本轮请求作用域 + 宿主准入，
 *     由宿主建首个 TaskRun 并执行组织交接，不伪造 attempt / root grant。
 *
 * 残缺的受管上下文直接拒绝，**不回退**到首次准入或 legacy。
 *
 * ## 关闭状态
 *
 * 功能开关默认关闭（PI_BOT_TASK_INTAKE=1 才注册），真实用户路径不受影响。
 */
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { parseIntake } from '../tasks/task-run-factory.js';
import { handleIntake, ACTION, INTAKE_OUTCOME } from './intake.js';
import { makeSpecPreparer } from './department-spec.js';
import { readManagedSubmission, SUBMISSION } from './task-context.js';
import { admitFirstTask, admissionBudget } from './task-admission.js';
import { createRequestReceipts } from '../tasks/task-request-receipts.js';
import { config } from '../config.js';

/** 环境开关：默认关闭，避免未完成闭环影响真实用户。 */
export function intakeEnabled(env = process.env) {
  return env.PI_BOT_TASK_INTAKE === '1';
}

/** 请求回执目录（小文件，原子写；不引入数据库）。 */
export function requestReceipts() {
  return createRequestReceipts({ dir: path.join(config.dataDir, 'task-requests') });
}

/**
 * 构造接单工具定义。
 *
 * @param {object} p
 * @param {object} p.runner
 * @param {object} p.store
 * @param {string} p.roomId
 * @param {string} p.botId
 * @param {object} [p.health]
 * @param {(scope:object)=>object|null} [p.requestScopeOf] 当前理解轮请求作用域
 * @param {object} [p.receipts]
 */
export function buildIntakeTools({
  runner, store, roomId, botId, health = null, requestScopeOf = null, receipts = null,
}) {
  const wanted = [
    defineTool({
      name: 'accept_task',
      description:
        '把用户这次的要求登记成任务并交给合适的执行者。' +
        '\n\n' +
        '· kind=answer：普通问答，不进入执行；\n' +
        '· kind=clarification：需要先问清楚；目标、交付物、验收标准、执行对象或授权不明确，或用户只是在描述想法/问方案/随口一句时，先用一个具体问题澄清，不要猜着建任务；\n' +
        '· kind=accept_task：确实要做的事，需给出目标与验收条件。\n' +
        '\nrouting.type 决定去向：direct（你自己做）、existing（交给已有部门，需 departmentId）、' +
        'new（新建部门，需 departmentSpec）。' +
        '如果用户只是要你建个部门、不要立刻开工，用 routing.departmentOnly=true。',
      parameters: Type.Object({
        kind: Type.Union(
          [Type.Literal('answer'), Type.Literal('clarification'), Type.Literal('accept_task')],
          { description: '接单意图' },
        ),
        text: Type.Optional(Type.String({ description: 'answer/clarification 时给用户的话' })),
        goal: Type.Optional(
          Type.Object({
            requirement: Type.String({ description: '要达成什么' }),
            scope: Type.Optional(Type.String()),
            deliverables: Type.Optional(Type.Array(Type.String())),
            verification: Type.Optional(
              Type.Array(
                Type.Object({
                  id: Type.Optional(Type.String({ description: '可省，自动生成' })),
                  kind: Type.Union(
                    [
                      Type.Literal('artifact'),
                      Type.Literal('format'),
                      Type.Literal('count'),
                      Type.Literal('test'),
                      Type.Literal('receipt'),
                      Type.Literal('expert'),
                    ],
                    { description: '验收种类' },
                  ),
                  description: Type.String({ description: '怎么算做完，必须写清楚' }),
                  spec: Type.Optional(Type.Any()),
                  required: Type.Optional(Type.Boolean()),
                }),
              ),
            ),
          }),
        ),
        routing: Type.Optional(
          Type.Object({
            type: Type.Union([Type.Literal('direct'), Type.Literal('existing'), Type.Literal('new')]),
            departmentId: Type.Optional(Type.String()),
            departmentOnly: Type.Optional(Type.Boolean()),
            departmentSpec: Type.Optional(
              Type.Object({
                name: Type.String(),
                topic: Type.Optional(Type.String()),
                lead: Type.Optional(Type.String()),
                members: Type.Optional(Type.Array(Type.Any())),
              }),
            ),
          }),
        ),
      }),
      execute: async (_id, params) => {
        const submission = readManagedSubmission({ runner, taskRuns: store.taskRuns, roomId, botId });

        // 受管上下文残缺：明确拒绝，不降级
        if (submission.kind === SUBMISSION.invalid) {
          return { content: [{ type: 'text', text: `这次执行不能接单：${submission.text}` }], isError: true };
        }

        // ---- 来源一：受管执行（已有 TaskRun）
        if (submission.kind === SUBMISSION.managed) {
          const parsed = parseIntake(params);
          if (!parsed.ok) {
            return { content: [{ type: 'text', text: `接单结构不合法：${parsed.text}` }], isError: true };
          }
          const out = await handleIntake({
            action: { type: ACTION.accept, intake: parsed.intake },
            submission,
            store,
            taskRuns: store.taskRuns,
            prepareSpec: makeSpecPreparer({ store, runner, health }),
          });
          if (!out.ok) {
            return { content: [{ type: 'text', text: `接单未完成：${out.text ?? out.code}` }], isError: true };
          }
          const say = {
            [INTAKE_OUTCOME.direct]: '这一件由你自己做。',
            [INTAKE_OUTCOME.existing]: '已交给部门负责人。',
            [INTAKE_OUTCOME.created]: out.createOnly ? '部门已建好，没有派发任务。' : '部门已就绪，目标已交给负责人。',
            [INTAKE_OUTCOME.skipped]: '这次不进执行。',
          }[out.outcome] ?? '已登记。';
          return {
            content: [{ type: 'text', text: say }],
            details: { outcome: out.outcome, departmentId: out.departmentId ?? null, leadBotId: out.leadBotId ?? null, createOnly: out.createOnly === true },
          };
        }

        // ---- 来源二：首次接单（本轮请求作用域）
        const scope = typeof requestScopeOf === 'function' ? requestScopeOf() : null;
        if (!scope) {
          return {
            content: [{ type: 'text', text: '这次没有可信的接单作用域，不能创建任务（不会改用其它执行身份）。' }],
            isError: true,
          };
        }

        const out = await admitFirstTask({
          store,
          taskRuns: store.taskRuns,
          receipts: receipts ?? requestReceipts(),
          scope,
          proposal: params,
          prepareSpec: makeSpecPreparer({ store, runner, health }),
        });
        if (!out.ok) {
          return {
            content: [{ type: 'text', text: `接单未完成：${out.text ?? out.code}` }],
            isError: true,
            details: { code: out.code ?? null, taskRunId: out.taskRunId ?? null },
          };
        }
        if (!out.accepted) {
          runner.setRequestDecision?.(roomId, botId, scope, out.kind === 'clarification' ? 'clarification' : 'answer');
          return {
            content: [{ type: 'text', text: out.text || '这次不需要执行。' }],
            details: { accepted: false, kind: out.kind, outcome: out.outcome },
          };
        }
        runner.setRequestDecision?.(roomId, botId, scope, 'accepted', { taskRunId: out.taskRunId });
        if (!out.createOnly && (out.outcome === 'created' || out.outcome === 'existing' || out.outcome === 'direct')) {
          runner.queueAdmittedTask?.(out.taskRunId);
        }
        const say = out.outcome === 'created'
          ? (out.createOnly ? '部门已建好，没有派发任务。' : '部门已就绪，目标已交给负责人。')
          : out.outcome === 'existing'
            ? '已交给部门负责人。'
            : out.outcome === 'direct'
              ? '这一件由你自己做。'
              : '已登记。';
        return {
          content: [{ type: 'text', text: out.duplicate ? '这个请求之前已经受理过，沿用它。' : say }],
          details: {
            accepted: true, duplicate: out.duplicate === true, taskRunId: out.taskRunId,
            outcome: out.outcome, departmentId: out.departmentId ?? null,
            leadBotId: out.leadBotId ?? null, createOnly: out.createOnly === true,
            budget: admissionBudget(),
          },
        };
      },
    }),
  ];
  return wanted;
}

export { INTAKE_OUTCOME };
