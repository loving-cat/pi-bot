/**
 * 任务阶段提示词与交付摘要（纯文本，无 IO）。
 *
 * 负责人分三个阶段：规划派活、验收补派、最终交付。提示词只说阶段职责、
 * 目标与已有成果，不泄露内部实现细节；交付摘要用确定性文本，不调用模型。
 */
export const LEAD_PHASE = Object.freeze({
  plan: 'plan',
  verify: 'verify',
  deliver: 'deliver',
});

/**
 * 负责人阶段提示词。
 *
 * @param {object} p
 * @param {string} p.phase 见 LEAD_PHASE
 * @param {object} p.taskRun
 * @param {string} [p.extra]
 * @returns {string}
 */
export function buildLeadPrompt({ phase, taskRun, extra = '' } = {}) {
  const goal = taskRun?.goal ?? {};
  const lines = [
    `任务目标：${goal.requirement ?? ''}`,
    goal.scope ? `范围：${goal.scope}` : '',
    (goal.deliverables ?? []).length ? `交付物：${goal.deliverables.join('、')}` : '',
    (taskRun?.inputs ?? []).length ? '用户补充：' + taskRun.inputs.slice(-3).map((x) => String(x.text ?? '')).filter(Boolean).join('；') : '',
    // 已有计划：每轮都读一遍，按它对齐全场，而不是每轮重新想。
    (taskRun?.plan?.steps ?? []).length
      ? '已经定下的分工（按这个执行，缺哪条补哪条）：\n'
        + taskRun.plan.steps
          .map((s, i) => (i + 1) + '. ' + (s.memberName ?? '') + '：' + (s.task ?? ''))
          .join('\n')
      : '',
    (taskRun?.progress?.unmet ?? []).length
      ? `还缺：${[].concat(taskRun.progress.unmet).slice(0, 6).join('；')}`
      : '',
  ].filter(Boolean);

  if (phase === LEAD_PHASE.plan) {
    lines.push('把这件事拆成可执行的小任务，派给部门成员，交给他们去做。');
    // ★ 没有计划才催列计划；已有计划就该照着推进，不能每轮重列一遍。
    if (!(taskRun?.plan?.steps ?? []).length) {
      lines.push(
        '先把分工写成计划（用 task_plan：谁做什么、交付什么、按什么顺序），'
          + '再照着它一个一个派出去；没列计划就直接派，容易漏人或重复派。',
      );
    } else {
      lines.push('按上面这份分工推进：还没派出去的补齐，派出去的等它交回来再核对。');
    }
    // ★ @ 就是派活：系统会把正文里的 @ 解析成持久子任务，成员随后被唤醒。
    //   所以鼓励用 @ 一个一个交代；需要精确验收条件时才用 assign_member_task。
    lines.push(
      '派活方式：在正文里 @成员 一次一个，写清要它做什么、交付什么；' +
        '系统会为它建子任务并唤醒它。',
    );
    lines.push(
      '需要给出精确验收条件（格式/数量/必须附回执）时，改用 assign_member_task 建子任务。',
    );
    lines.push('不要向用户确认是否继续，也不要只给计划就停下。');
  } else if (phase === LEAD_PHASE.verify) {
    lines.push('核对已有产物是否满足验收条件：缺什么补派什么，不要直接宣布完成。');
  } else if (phase === LEAD_PHASE.deliver) {
    lines.push('验收已通过。用一两句话向主控汇报这个部门交付了什么。');
  }
  // ★ 用户授权「自己搞定」时，明确告诉负责人不要停下来问。
  //   不说这一句的话，模型会在「要不要继续」上打转，一件事变成十次对话。
  if (taskRun?.flags?.autonomous === true) {
    lines.push(
      '用户已经授权你自主推进（' + String(taskRun.flags.autonomyReason || '一直做到有结果') + '）：' +
        '不要停下来问用户要不要继续、也不要等确认；' +
        '验收没过就自己补做再交，直到有可核验的结果。' +
        '只有真的缺外部信息（要账号、要授权、要原始数据）才停下来说明。',
    );
  }
  if (extra) lines.push(extra);
  return lines.join('\n');
}
/**
 * 成员执行提示词：只拿被派的那份工作，不越权改目标。
 *
 * @param {object} p
 * @param {object} p.childTaskRun
 * @param {object} [p.parentTaskRun]
 * @returns {string}
 */
export function buildMemberPrompt({ childTaskRun, parentTaskRun } = {}) {
  const goal = childTaskRun?.goal ?? {};
  const lines = [
    `你被分配的子任务：${goal.requirement ?? ''}`,
    goal.scope ? `范围：${goal.scope}` : '',
    (goal.deliverables ?? []).length ? `交付物：${goal.deliverables.join('、')}` : '',
  ].filter(Boolean);
  if (parentTaskRun?.goal?.requirement) {
    lines.push(`所属目标：${parentTaskRun.goal.requirement}`);
  }
  lines.push('做完把结果交回给负责人；不要改上级目标。');
  return lines.join('\n');
}

/** 交付摘要：确定性文本，不调用模型。 */
export function buildDeliverySummary(taskRun) {
  const goal = taskRun?.goal ?? {};
  const evidence = (taskRun.progress?.evidence ?? []).map((e) => e.ref).filter(Boolean);
  const lines = [`任务「${goal.requirement ?? taskRun?.id}」已验收通过。`];
  if (evidence.length) lines.push(`交付物：${evidence.slice(0, 10).join('、')}`);
  if (taskRun?.owner?.departmentId) lines.push(`交付部门：${taskRun.owner.departmentId}`);
  return lines.join('\n');
}
