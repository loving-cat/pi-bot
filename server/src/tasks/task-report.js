/**
 * 受管阶段的**报告收集**（不完成任务）。
 *
 * ## 为什么需要这一层
 *
 * 模型说「我完成了」这件事必须能被运行器**结构化地**收到，
 * 而不是从正文里找「完成」两个字。后者等于猜，而且模型随时可能
 * 在描述里顺口说「已完成」而实际什么都没产出。
 *
 * 所以给受管执行开一个报告入口：模型调用 `task_report`，
 * 这里只**收集**它的声明，交给上层随 AttemptResult 一起报出去。
 *
 * ## 它不能做什么
 *
 *   · 不能把任务标完成 —— 那要经过验收（`task-verification`）；
 *   · 不能写归约器 —— 本批不落库；
 *   · 不能凭正文推断 —— 只认这一条显式调用。
 *
 * ## 与「运行事实」的分界
 *
 * 报告里的一切都是**模型声明**：
 *
 *   · `claimedDone` / `claimedEvidence` 只是它自己说做了什么；
 *   · 真正的成果由运行层收集（附件、变更），验收时另行核对；
 *   · 两者在 AttemptResult 里分开存放，不混为一谈。
 */

/** 报告工具名。 */
export const REPORT_TOOL = 'task_report';

/** 合法阶段种类（与契约 PHASE 的键一致）。 */
const PHASE_KINDS = new Set([
  'progress',
  'apply_completion',
  'need_approval',
  'need_input',
  'waiting_dependency',
  'blocked',
]);

/**
 * 一次执行期间收集到的报告。
 *
 * 用对象而非数组，是因为**最后一次报告覆盖前面的**：
 * 模型可能先说进展、再说完成，最终生效的应该是最新那条。
 */
export function createReportCollector() {
  let latest = null;
  let count = 0;

  /**
   * 本次执行**真实观察到的策略阻塞**：审批 ID → 观察记录。
   *
   * 这是判断「模型说它在等 ap_x」是否成立的唯一依据 ——
   * 审批表里有这条记录、房间和 Bot 也对，都不能证明**这次执行**被它挡住过。
   */
  const blocked = new Map();

  return {
    /**
     * 记下一次真实阻塞（由策略钩子在判定 block 时调用）。
     */
    noteBlocked(approval, { created = false } = {}) {
      if (!approval || typeof approval.id !== 'string' || !approval.id) return;
      const prev = blocked.get(approval.id);
      blocked.set(approval.id, {
        id: approval.id,
        created: created === true || prev?.created === true,
        firstAt: prev?.firstAt ?? Date.now(),
        count: (prev?.count ?? 0) + 1,
      });
    },

    /** 这条审批是否被本次执行真实观察到过。 */
    sawBlocked(approvalId) {
      return blocked.has(approvalId);
    },

    /** 本次执行观察到过的阻塞 ID 列表（排查用）。 */
    blockedIds() {
      return [...blocked.keys()];
    },

    /** 收一条报告。非法输入忽略并记下来由，不抛错打断执行。 */
    accept(input) {
      if (!input || typeof input !== 'object') {
        return { ok: false, why: '报告必须是对象' };
      }
      const kind = String(input.phase ?? input.kind ?? '').trim();
      if (!PHASE_KINDS.has(kind)) {
        return { ok: false, why: `未知阶段：${kind || '(空)'}` };
      }
      const strList = (v, limit) =>
        Array.isArray(v)
          ? v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, limit)
          : [];

      count += 1;
      latest = {
        kind,
        // 模型声明：它认为做完了什么
        claimedDone: strList(input.done ?? input.claimedDone, 50),
        // 模型声明：它认为有哪些证据（只是线索，不是证明）
        claimedEvidence: Array.isArray(input.evidence)
          ? input.evidence
              .filter((e) => e && typeof e === 'object' && typeof e.ref === 'string' && e.ref.trim())
              .map((e) => ({ ref: e.ref.trim(), note: String(e.note ?? '').trim().slice(0, 300) }))
              .slice(0, 50)
          : [],
        // 模型声明：它认为还缺什么
        unmet: strList(input.unmet, 50),
        note: String(input.note ?? '').slice(0, 600),
        // 等待类阶段必须带「在等什么」
        // ★ 等用户输入时，把模型给的问题本身作为可信引用。
        //
        //   不能只判「有没有填」。模型编一个字符串就能把任务永久停进
        //   waiting_input，且永远没人会来提供那个 key。
        //   这里把引用绑定到**它实际提出的问题**：没有具体问题就不算等待成立，
        //   上层会按「没有可信等待」处理，任务不会静默卡死。
        waitFor: normalizeWaitFor(kind, input.waitFor, {
          hostRef: kind === 'need_input'
            ? String(input.waitFor?.question ?? input.question ?? input.waitFor?.ref ?? '').trim()
            : null,
        }),
        at: Date.now(),
        seq: count,
      };
      return { ok: true, report: latest };
    },

    /** 最新一条报告（没有则 null）。 */
    latest() {
      return latest;
    },

    /** 是否收到过「申请完成」。 */
    appliedCompletion() {
      return latest?.kind === 'apply_completion';
    },

    /** 收了几条。 */
    count() {
      return count;
    },
  };
}

/**
 * 等待类阶段必须能说清「在等什么」。
 *
 * 不合法就返回 null —— 让上层按「没有可信等待」处理，
 * 而不是伪造一个引用。
 */
function normalizeWaitFor(kind, waitFor, { hostRef = null } = {}) {
  const spec = {
    need_approval: 'approvalId',
    need_input: 'inputKey',
    waiting_dependency: 'dependencyTaskId',
  }[kind];
  if (!spec) return null;
  if (!waitFor || typeof waitFor !== 'object') return null;
  const raw = String(waitFor[spec] ?? waitFor.ref ?? '').trim();
  if (!raw) return null;
  // ★ 等「用户输入」时，引用必须指向宿主真实存在的东西。
  //
  //   原来只判非空：模型随便编一个字符串就能把任务永久停进 waiting_input，
  //   而永远不会有人来提供那个 key —— 任务既跑不动也关不掉，
  //   用户只看到「等待输入」却不知道该输什么。
  //   这里要求宿主给出真实引用；宿主没给就说明这次等待不成立。
  if (kind === 'need_input') {
    // 协议字段就是 inputKey。要挡的不是「字段名」，而是**空壳等待**：
    // 模型填一个没有实际含义的占位（比如 "?"、"-"、单字符）就能把任务
    // 永久停在 waiting_input，而没有人知道该输入什么。
    // 底线：必须是一句能看懂在问什么的话（>= 4 个字符）。
    const key = String(raw ?? '').trim();
    const question = String(hostRef ?? '').trim();
    const effective = question || key;
    if (effective.length < 4) return null;
    return { kind: 'input', inputKey: effective };
  }
  return { kind: kind.replace('need_', '').replace('waiting_', ''), [spec]: raw };
}
