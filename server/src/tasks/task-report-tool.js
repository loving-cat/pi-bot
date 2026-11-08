/**
 * 受管执行的**阶段报告工具**（真正注册给 SDK 的那一个）。
 *
 * ## 为什么必须是真的工具
 *
 * 只在 runner 里监听同名 `tool_execution_start` 事件是不够的：
 * 模型根本就没有这个工具可调，那条监听永远不会被真实触发。
 * 一份「能收集报告」的监听器 + 一份没注册的工具定义，
 * 只能被手工 emit 的事件骗过去 —— 那证明不了模型能调用。
 *
 * 所以这里给出 `defineTool` 定义与 `execute`，由 `session-factory`
 * 在**受管轮次**里注册进 SDK 的 customTools。
 *
 * ## 作用域
 *
 * 只有受管执行才注册：普通无任务调用拿到这个工具，
 * 报告了也没有消费者，反而让模型误以为能推动任务状态。
 *
 * ## 它不做什么
 *
 *   · 不完成任务（那要经过验收）；
 *   · 不写归约器；
 *   · 不把 claimedEvidence 变成真实产物 —— 那始终是模型声明。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** 工具名。runner 侧按同名事件收集。 */
export const REPORT_TOOL = 'task_report';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

/**
 * 造一个报告工具实例。
 *
 * @param {object} p
 * @param {(input:object)=>{ok:boolean, why?:string}} p.collect 收集回调（由 runner 提供）
 */
export function buildReportTool({ collect }) {
  return defineTool({
    name: REPORT_TOOL,
    label: '★ 报告这次执行的阶段与结果',
    description:
      '把这次执行的阶段告诉系统。' +
      '**这不是宣布完成** —— 完成要经过验收，验收会自己去核对你实际产出的东西。' +
      '用它报告：还在推进（progress）、认为可以交付验收了（apply_completion）、' +
      '在等批准/等输入/等别的任务（need_approval / need_input / waiting_dependency）、' +
      '或者被挡住了（blocked）。' +
      'done 写你自认为做完的事，evidence 写你认为可作证的文件引用，' +
      'unmet 写你认为还缺什么。这些都会被记成**你的声明**，不会被当成已验证事实。',
    parameters: Type.Object({
      phase: Type.Union(
        [
          Type.Literal('progress'),
          Type.Literal('apply_completion'),
          Type.Literal('need_approval'),
          Type.Literal('need_input'),
          Type.Literal('waiting_dependency'),
          Type.Literal('blocked'),
        ],
        { description: '这次执行处于什么阶段' },
      ),
      done: Type.Optional(
        Type.Array(Type.String({ description: '你自认为做完的一件事' }), {
          description: '自认为做完的事（声明，不是已验证成果）',
        }),
      ),
      evidence: Type.Optional(
        Type.Array(
          Type.Object({
            ref: Type.String({ description: '文件引用或可定位的标识' }),
            note: Type.Optional(Type.String({ description: '一句话说明它证明什么' })),
          }),
          { description: '你自认为可作证的东西（声明）' },
        ),
      ),
      unmet: Type.Optional(
        Type.Array(Type.String({ description: '还缺什么' }), { description: '自认为还缺的事' }),
      ),
      note: Type.Optional(Type.String({ description: '一段补充说明' })),
      waitFor: Type.Optional(
        Type.Object({
          approvalId: Type.Optional(Type.String({ description: '在等的审批 ID' })),
          inputKey: Type.Optional(Type.String({ description: '在等的输入标识' })),
          dependencyTaskId: Type.Optional(Type.String({ description: '在等的任务 ID' })),
        }),
        { description: '等待类阶段必须说明在等什么' },
      ),
    }),
    execute: async (_toolCallId, input) => {
      if (typeof collect !== 'function') {
        return {
          content: [{ type: 'text', text: '这次执行没有接报告通道，报告未被记录。' }],
          details: {},
          isError: true,
        };
      }
      const result = collect(input);
      if (!result?.ok) {
        return {
          content: [{ type: 'text', text: `报告未被接受：${result?.why ?? '未知原因'}` }],
          details: {},
          isError: true,
        };
      }
      const waiting = result.report?.waitFor
        ? '已记下你在等的事，停下来等就行。'
        : '';
      return ok(
        `报告已记录（${result.report?.kind}）。` +
          '注意：这只是你的声明，系统会另行核对你实际产出的东西；' +
          `宣布完成也不等于已经通过验收。${waiting}`,
        { phase: result.report?.kind },
      );
    },
  });
}
