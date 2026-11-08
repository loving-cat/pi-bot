/**
 * 可信验收（纯逻辑 + 显式注入的文件访问）。
 *
 * ## 证据的唯一来源：账本
 *
 * 一份证据算不算数，只由 `taskRun.attempts` 这个账本决定：
 *
 *   · 必须存在对应的尝试记录（任务身份 + 尝试 + 版本 + 执行者都对得上）；
 *   · 该尝试必须已 `settled`；
 *   · 引用必须出现在那条记录的 `result.artifacts` 里。
 *
 * `progress.evidence` 只是**投影/线索**，不是信任来源。
 * 用它自己生成白名单再拿它验收，等于自举 —— 任何塞进来的字符串都能通过。
 *
 * ## 每条条件的 spec 是封闭的
 *
 * 每种条件只认明确的字段。没有适用对象、访问失败、缺少可信回执、
 * 或用了没实现的规格时，一律 `blocked` / `needs_review`，**不默认通过**。
 *
 *   · `artifact`：`count`（正整数，默认 1）；真去 stat 每个引用
 *   · `format`  ：`mustContain`（非空字符串数组）或 `requiredFields` + 解析器；都没有 → blocked
 *   · `count`   ：`count`（正整数），逐条真实 stat，不数登记的字符串
 *   · `test`    ：`spec.id`，必须走注入的 runTest
 *   · `receipt` ：`count` + 可信回执登记，普通产物**不算**回执
 *   · `expert`  ：不机械判定，交负责人
 *
 * ## 权限
 *
 * 验收器不自己读磁盘，全部经注入的 `access`。入口缺失或抛错 = `blocked`。
 */
import { VERIFY_KIND, PHASE, isMechanical } from './task-contract.js';
import { completionSelectionOfResult } from './attempt-ledger.js';
import { childrenOf } from './task-subtasks.js';

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/** 验收结论。 */
export const VERDICT = Object.freeze({
  passed: 'passed',
  failed: 'failed',
  /** 需要专业判断，机械检查给不出结论 */
  needsReview: 'needs_review',
  /** 条件本身无法机械判定（外部结果不可达、规格未实现、入口缺失） */
  blocked: 'blocked',
});

function reject(code, text) {
  return { ok: false, code, text };
}

// ---------------------------------------------------------------------------
// 证据归属：以账本为准
// ---------------------------------------------------------------------------

/**
 * 由**账本**算出可信证据集合。
 *
 * 这是白名单的唯一来源 —— 不从 `progress.evidence` 取。
 *
 * @param {object} taskRun
 * @param {{attemptId?:string|null}} [opts] 显式限定只看某次尝试
 * @returns {{refs:Set<string>, attempts:object[], rejected:object[]}}
 */
export function collectLedgerEvidence(taskRun, { attemptId = null } = {}) {
  const refs = new Set();
  const used = [];
  const rejected = [];

  const revision = taskRun?.revision;
  const taskId = taskRun?.id;

  for (const record of taskRun?.attempts ?? []) {
    // ---- 必须已结算：未结算的尝试没有可核对的产物
    if (record.state !== 'settled') {
      rejected.push({ attemptId: record.attemptId, why: `尝试未结算（${record.state}）` });
      continue;
    }

    // ---- 归属：任务身份必须就是当前任务
    if (record.taskRunId !== taskId) {
      rejected.push({
        attemptId: record.attemptId,
        why: `账本记录属于任务 ${record.taskRunId}，不是当前任务 ${taskId}`,
      });
      continue;
    }

    // ---- 版本：目标改版后旧尝试的产物不算当前版本成果
    if (!Number.isInteger(record.revision)) {
      rejected.push({ attemptId: record.attemptId, why: '账本记录没有版本' });
      continue;
    }
    if (record.revision !== revision) {
      rejected.push({
        attemptId: record.attemptId,
        why: `尝试属于第 ${record.revision} 版目标，当前是第 ${revision} 版`,
      });
      continue;
    }

    // ---- 显式限定尝试时，只认那一次
    if (attemptId && record.attemptId !== attemptId) continue;

    const artifacts = Array.isArray(record.result?.artifacts) ? record.result.artifacts : [];
    for (const ref of artifacts) {
      if (typeof ref === 'string' && ref.trim()) refs.add(ref.trim());
    }
    used.push(record);
  }

  return { refs, attempts: used, rejected };
}

/**
 * 核对一条证据条目的归属。
 *
 * ★ 与 `collectLedgerEvidence` 配套：白名单来自账本，这条只做单条解释。
 *   `source === 'claim'` 的永远不算证明，模型声明与运行层登记始终分离。
 */
/**
 * 可信候选证据：本任务当前/历史已结算产物 + 当前版本真实关联且完成的子任务产物。
 * 来源只取宿主持久账本；子产物不复制成父 attempt，验证时按当前条件重新 stat/read。
 */
function requiredDeliveryCount(taskRun) {
  let need = 0;
  for (const c of taskRun?.goal?.verification ?? []) {
    if (c?.kind !== 'artifact' && c?.kind !== 'count') continue;
    const raw = c?.spec?.count;
    if (Number.isInteger(raw) && raw > 0) need = Math.max(need, raw);
    else need = Math.max(need, 1);
  }
  return need || 1;
}

function latestSettledWithArtifacts(attempts, { taskRunId, revision }) {
  const matched = (attempts ?? []).filter((a) => a?.state === 'settled'
    && a.taskRunId === taskRunId
    && a.revision === revision
    && Array.isArray(a.result?.artifacts)
    && a.result.artifacts.length);
  return matched.length ? matched[matched.length - 1] : null;
}

function latestCompletionAttempt(attempts, { taskRunId, revision }) {
  const matched = (attempts ?? []).filter((a) => a?.state === 'settled'
    && a.taskRunId === taskRunId
    && a.revision === revision
    && a.result?.phaseKind === PHASE.apply_completion);
  return matched.length ? matched[matched.length - 1] : null;
}

/**
 * 可信候选与本次选定交付分开：
 *   · 候选池保留来源全集（当前版本、真实子交付、最近历史交付），只读账本；
 *   · 正式完成申请 phase.claimedEvidence 的 refs 若能在候选池中找到（或显式给出
 *     不存在的 artifact 形态 ref），就是这次要核验的选择集合；claim 只做选择，
 *     不作为证明，验证仍逐条 stat/read。
 *   · 没有明确选择时才用清楚的默认规则：最近一次真实登记交付；数量不足按
 *     “同版本更早 attempt → 当前子交付 → 最近历史交付”补足，且同一集合逐条
 *     count/format 核验。显式 attemptId 只取该 attempt，不允许补位。
 */
export function collectTrustedEvidence(taskRun, { taskRuns = null, attemptId = null, resolveRef = null } = {}) {
  const revision = taskRun?.revision;
  const ledger = collectLedgerEvidence(taskRun, { attemptId });
  const candidatePool = [];
  const addCandidate = (ref, meta) => {
    if (typeof ref !== 'string' || !ref.trim()) return;
    const clean = ref.trim();
    if (!candidatePool.some((e) => e.ref === clean && e.sourceTaskId === meta.sourceTaskId && e.attemptId === meta.attemptId)) {
      candidatePool.push({ ref: clean, ...meta });
    }
  };

  // 显式范围：唯一来源就是这次真实已结算 attempt；不存在则空，绝不扩大。
  if (attemptId !== null && attemptId !== undefined) {
    const record = (taskRun?.attempts ?? []).find((a) => a.attemptId === attemptId
      && a.taskRunId === taskRun?.id
      && a.state === 'settled'
      && a.revision === revision);
    if (!record) return { refs: new Set(), entries: [], candidatePool, ledger, scope: 'explicit_missing' };
    for (const ref of record.result?.artifacts ?? []) addCandidate(ref, { sourceTaskId: taskRun.id, sourceRevision: record.revision, attemptId: record.attemptId, source: 'current' });
    return { refs: new Set(candidatePool.map((e) => e.ref)), entries: candidatePool, candidatePool, ledger, scope: 'explicit_attempt' };
  }

  // 候选池：当前版本全部已结算产物、同版本更早 attempt、当前子交付、最近历史交付。
  for (const record of taskRun?.attempts ?? []) {
    if (record?.state !== 'settled' || record.taskRunId !== taskRun?.id || record.revision !== revision) continue;
    for (const ref of record.result?.artifacts ?? []) addCandidate(ref, { sourceTaskId: taskRun.id, sourceRevision: record.revision, attemptId: record.attemptId, source: 'current' });
  }
  if (taskRuns) {
    for (const kid of childrenOf(taskRuns, taskRun) ?? []) {
      if (kid?.state !== 'completed' || kid.parentTaskId !== taskRun.id) continue;
      const loaded = taskRuns.read?.(kid.id);
      const fresh = loaded?.status === 'found' ? loaded.taskRun : kid;
      const record = latestSettledWithArtifacts(fresh.attempts, { taskRunId: fresh.id, revision: fresh.revision });
      for (const ref of record?.result?.artifacts ?? []) addCandidate(ref, { sourceTaskId: fresh.id, sourceRevision: record.revision, attemptId: record.attemptId, source: 'child', parentRevision: kid.parentRevision ?? null });
    }
  }
  const priorRecords = (taskRun?.attempts ?? [])
    .filter((a) => a?.state === 'settled' && a.taskRunId === taskRun?.id && Number.isInteger(a.revision) && a.revision < revision)
    .sort((a, b) => b.revision - a.revision);
  if (priorRecords.length) {
    const latestRev = priorRecords[0].revision;
    const record = latestSettledWithArtifacts(priorRecords, { taskRunId: taskRun?.id, revision: latestRev });
    for (const ref of record?.result?.artifacts ?? []) addCandidate(ref, { sourceTaskId: taskRun.id, sourceRevision: record.revision, attemptId: record.attemptId, source: 'historical' });
  }
  const byRef = new Map();
  for (const item of candidatePool) if (!byRef.has(item.ref)) byRef.set(item.ref, item);

  // 正式完成申请的选择集合来自**结算结果持久字段**，不是模型会话里的 phase 投影。
  // 最新 apply_completion 的 present 空选择表示“这次没有选择”，不继承更早选择。
  const completionRecord = latestCompletionAttempt(taskRun?.attempts, { taskRunId: taskRun?.id, revision });
  if (completionRecord) {
    const selection = completionSelectionOfResult(completionRecord.result);
    if (selection.invalid) {
      return { refs: new Set(), entries: [], candidatePool, ledger, claimErrors: [{ ref: '(completionSelection)', reason: '完成选择字段损坏' }], scope: 'claim_rejected' };
    }
    if (selection.present && (selection.refs ?? []).length) {
      const claimed = selection.refs;
      const resolved = [];
      const errors = [];
      for (const raw of claimed) {
        let ref = raw;
        if (!byRef.has(ref) && typeof resolveRef === 'function') {
          const mapped = resolveRef(raw);
          if (mapped && byRef.has(mapped)) ref = mapped;
        }
        if (!byRef.has(ref)) { errors.push({ ref: raw, reason: '未登记的完成申请证据（不在本次可信候选池）' }); continue; }
        resolved.push(byRef.get(ref));
      }
      if (errors.length) return { refs: new Set(), entries: [], candidatePool, ledger, claimErrors: errors, scope: 'claim_rejected' };
      const entries = [];
      const refs = new Set();
      for (const item of resolved) { refs.add(item.ref); entries.push({ ...item }); }
      return { refs, entries, candidatePool, ledger, scope: 'claimed_selection', claimAttemptId: completionRecord.attemptId };
    }
  }

  // 默认：最近一次真正登记产物的 attempt；数量不足才按固定顺序补足。
  const need = requiredDeliveryCount(taskRun);
  const primaryRecord = latestSettledWithArtifacts(taskRun?.attempts, { taskRunId: taskRun?.id, revision });
  const primary = primaryRecord
    ? primaryRecord.result.artifacts.map((ref) => ({ ref: ref.trim(), meta: { sourceTaskId: taskRun.id, sourceRevision: primaryRecord.revision, attemptId: primaryRecord.attemptId, source: 'current' } }))
    : [];
  const sameRevisionPrior = (taskRun?.attempts ?? [])
    .filter((a) => a?.state === 'settled' && a.taskRunId === taskRun?.id && a.revision === revision && a !== primaryRecord)
    .flatMap((a) => (a.result?.artifacts ?? []).map((ref) => ({ ref: ref.trim(), meta: { sourceTaskId: taskRun.id, sourceRevision: a.revision, attemptId: a.attemptId, source: 'current_prior' } })));
  const childItems = candidatePool.filter((e) => e.source === 'child');
  const historicalItems = candidatePool.filter((e) => e.source === 'historical');
  const pool = primary.length ? primary : (childItems.length ? childItems : historicalItems);
  const selected = [];
  const selectedRefs = new Set();
  const push = (item) => {
    if (!item?.ref || selectedRefs.has(item.ref)) return;
    selectedRefs.add(item.ref);
    const meta = item.meta ?? item;
    selected.push({ ...meta, ref: item.ref });
  };
  for (const item of pool) push(item);
  for (const item of [...sameRevisionPrior, ...childItems, ...historicalItems]) {
    if (selectedRefs.size >= need) break;
    push(item);
  }
  return { refs: selectedRefs, entries: selected, candidatePool, ledger, scope: selectedRefs.size ? (primary.length ? 'default_delivery' : 'fallback_delivery') : 'empty', requiredCount: need };
}
export function checkEvidenceProvenance(evidence, { taskRun, attemptId = null, revision, allowedRefs }) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, why: '证据条目不是对象' };
  }
  if (evidence.source !== 'attempt') {
    return { ok: false, why: `证据来源是「${evidence.source ?? '(未知)'}」，不是运行层登记的实际产物` };
  }
  if (!isId(evidence.attemptId)) {
    return { ok: false, why: '证据没有绑定执行尝试' };
  }
  if (attemptId && evidence.attemptId !== attemptId) {
    return { ok: false, why: `证据来自执行 ${evidence.attemptId}，不是指定的 ${attemptId}` };
  }

  // ★ 必须能在账本里找到这条尝试
  if (taskRun) {
    const found = (taskRun.attempts ?? []).find((a) => a.attemptId === evidence.attemptId);
    if (!found) {
      return { ok: false, why: `账本里没有尝试 ${evidence.attemptId}` };
    }
    if (found.taskRunId !== taskRun.id) {
      return { ok: false, why: `尝试 ${evidence.attemptId} 属于别的任务` };
    }
    if (found.state !== 'settled') {
      return { ok: false, why: `尝试 ${evidence.attemptId} 未结算` };
    }
    if (Number.isInteger(revision) && found.revision !== revision) {
      return { ok: false, why: `尝试属于第 ${found.revision} 版，当前第 ${revision} 版` };
    }
  }

  if (allowedRefs && !allowedRefs.has(evidence.ref)) {
    return { ok: false, why: `引用 ${evidence.ref} 不在账本登记的产物里` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 机械验收
// ---------------------------------------------------------------------------

async function safeAccess(access, method, arg) {
  const fn = access?.[method];
  if (typeof fn !== 'function') return { ok: false, text: `没有可用的 ${method} 入口` };
  try {
    return { ok: true, value: await fn(arg) };
  } catch (err) {
    return { ok: false, text: err?.message || String(err) };
  }
}

/** 逐条真实 stat，返回确实存在的引用。 */
async function existingRefs(refs, access) {
  const existing = [];
  const denied = [];
  for (const ref of refs) {
    const result = await safeAccess(access, 'stat', ref);
    if (!result.ok) {
      denied.push({ ref, why: result.text });
    } else if (result.value?.exists) {
      existing.push(ref);
    }
  }
  return { existing, denied };
}

/**
 * 跑一条机械验收条件。
 *
 * 必须在**有适用对象**时才可能通过；没有对象、访问失败、规格未实现一律不通过。
 */
export async function checkMechanical(condition, ctx) {
  const { kind, spec = {} } = condition ?? {};
  const access = ctx?.access;
  const refs = [...(ctx?.allowedRefs ?? [])];

  if (kind === VERIFY_KIND.expert) {
    const review = [...(ctx?.expertReviews ?? [])].reverse().find((r) => r.conditionId === condition.id && r.revision === ctx?.revision && r.taskRunId === ctx?.taskRunId);
    if (review && review.verdict === VERDICT.passed) {
      return { verdict: VERDICT.passed, detail: '负责人专业判断：通过（' + String(review.note ?? '').slice(0, 120) + '）', source: 'lead_review' };
    }
    if (review && review.verdict === VERDICT.failed) {
      return { verdict: VERDICT.failed, detail: '负责人专业判断：不通过（' + String(review.note ?? '').slice(0, 120) + '）', source: 'lead_review' };
    }
    return { verdict: VERDICT.needsReview, detail: '需要专业判断：当前没有同任务/同版本/同条件的负责人判断记录' };
  }
  if (!isMechanical(kind)) {
    return {
      verdict: VERDICT.needsReview,
      detail: '「' + kind + '」需要专业判断，机械检查给不出结论',
    };
  }

  // ---- 产物存在
  if (kind === VERIFY_KIND.artifact) {
    const need = spec.count === undefined ? 1 : spec.count;
    if (!isPositiveInt(need)) {
      return { verdict: VERDICT.blocked, detail: `artifact.count 必须是正整数，收到 ${JSON.stringify(spec.count)}` };
    }
    if (!refs.length) {
      return { verdict: VERDICT.failed, detail: `需要 ${need} 个产物，账本里没有登记任何产物` };
    }
    const { existing, denied } = await existingRefs(refs, access);
    if (existing.length >= need) {
      return { verdict: VERDICT.passed, detail: `产物 ${existing.length} 个，满足 ${need} 个` };
    }
    const why = denied.length ? `；不可访问：${denied[0].ref}（${denied[0].why}）` : '';
    return {
      verdict: VERDICT.failed,
      detail: `需要 ${need} 个产物，实际可访问 ${existing.length} 个${why}`,
    };
  }

  // ---- 数量：逐条真实核对，不数登记字符串
  if (kind === VERIFY_KIND.count) {
    const need = spec.count === undefined ? 1 : spec.count;
    if (!isPositiveInt(need)) {
      return { verdict: VERDICT.blocked, detail: `count.count 必须是正整数，收到 ${JSON.stringify(spec.count)}` };
    }
    if (!refs.length) {
      return { verdict: VERDICT.failed, detail: `需要 ${need} 个成果，账本里没有登记` };
    }
    const { existing, denied } = await existingRefs(refs, access);
    if (existing.length >= need) {
      return { verdict: VERDICT.passed, detail: `实际成果 ${existing.length} 个，满足 ${need} 个` };
    }
    const why = denied.length ? `；不可访问：${denied[0].ref}（${denied[0].why}）` : '';
    return { verdict: VERDICT.failed, detail: `需要 ${need} 个成果，实际可访问 ${existing.length} 个${why}` };
  }

  // ---- 格式：必须有明确规格，且**全部要求同时满足**
  if (kind === VERIFY_KIND.format) {
    const mustContain = Array.isArray(spec.mustContain)
      ? spec.mustContain.filter((s) => typeof s === 'string' && s)
      : [];
    const requiredFields = Array.isArray(spec.requiredFields)
      ? spec.requiredFields.filter((s) => typeof s === 'string' && s)
      : [];
    // ★ 声明了 format 就必须按它解析 —— 不能因为同时有 mustContain 就跳过解析。
    const declaredFormat = spec.format === undefined ? null : spec.format;

    if (!mustContain.length && !requiredFields.length && !declaredFormat) {
      return {
        verdict: VERDICT.blocked,
        detail:
          '这一条格式要求没有可执行的规格（需要 mustContain、requiredFields 或 format），' +
          '不能当作「没有要求」而通过',
      };
    }

    // 未知格式明确不支持，不猜
    if (declaredFormat !== null && !SUPPORTED_FORMATS.includes(declaredFormat)) {
      return {
        verdict: VERDICT.blocked,
        detail: `未支持的格式 spec.format=${declaredFormat}（已支持：${SUPPORTED_FORMATS.join('、')}）`,
      };
    }

    if (!refs.length) {
      return { verdict: VERDICT.failed, detail: '格式要求没有可检查的产物（账本里没有登记）' };
    }

    const problems = [];
    let checkedAny = false;

    for (const ref of refs) {
      const result = await safeAccess(access, 'readText', ref);
      if (!result.ok) {
        problems.push(`${ref} 读不到（${result.text}）`);
        continue;
      }
      checkedAny = true;
      const text = String(result.value?.text ?? '');

      // 要求 1：必含片段
      for (const piece of mustContain) {
        if (!text.includes(piece)) problems.push(`${ref} 缺「${piece}」`);
      }

      // 要求 2：能按声明的格式解析
      let parsed = null;
      if (declaredFormat !== null) {
        const out = parseDeclaredFormat(text, declaredFormat);
        if (!out.ok) {
          problems.push(`${ref} 不是合法的 ${declaredFormat}（${out.why}）`);
        } else {
          parsed = out.value;
        }
      }

      // 要求 3：必含字段
      if (requiredFields.length) {
        if (!parsed) {
          // 没声明格式却要字段：按 JSON 试解析（明确记下这个约定）
          const fallback = parseDeclaredFormat(text, 'json');
          if (!fallback.ok) {
            problems.push(`${ref} 无法解析出字段（${fallback.why}）`);
          } else {
            for (const field of requiredFields) {
              if (!Object.hasOwn(fallback.value, field)) problems.push(`${ref} 缺字段「${field}」`);
            }
          }
        } else {
          for (const field of requiredFields) {
            if (!Object.hasOwn(parsed, field)) problems.push(`${ref} 缺字段「${field}」`);
          }
        }
      }
    }

    if (checkedAny && !problems.length) {
      const what = [
        ...mustContain,
        declaredFormat ? `合法 ${declaredFormat}` : '',
        ...requiredFields.map((f) => `字段 ${f}`),
      ].filter(Boolean);
      return { verdict: VERDICT.passed, detail: `全部满足：${what.join('、')}` };
    }
    if (!checkedAny) {
      return { verdict: VERDICT.blocked, detail: `格式无法核对：${problems[0]}` };
    }
    return { verdict: VERDICT.failed, detail: problems.slice(0, 5).join('；') };
  }

  // ---- 测试结果
  if (kind === VERIFY_KIND.test) {
    if (!spec.id) {
      return { verdict: VERDICT.blocked, detail: '测试条件缺少 spec.id，无法定位要跑哪一项' };
    }
    if (!access?.runTest) {
      return { verdict: VERDICT.blocked, detail: '没有可用的测试执行入口' };
    }
    const result = await safeAccess(access, 'runTest', spec);
    if (!result.ok) return { verdict: VERDICT.blocked, detail: `测试无法执行：${result.text}` };
    const passed = result.value?.passed === true;
    return {
      verdict: passed ? VERDICT.passed : VERDICT.failed,
      detail: passed ? '测试通过' : `测试未通过：${result.value?.detail ?? ''}`,
    };
  }

  // ---- 确认回执：按身份核对归属、状态与适用范围，并按 ID 去重
  if (kind === VERIFY_KIND.receipt) {
    const need = spec.count === undefined ? 1 : spec.count;
    if (!isPositiveInt(need)) {
      return {
        verdict: VERDICT.blocked,
        detail: `receipt.count 必须是正整数，收到 ${JSON.stringify(spec.count)}`,
      };
    }
    if (!access?.listReceipts) {
      return { verdict: VERDICT.blocked, detail: '没有可用的回执查询入口，无法确认真实回执' };
    }

    // ★ 必须把当前身份传下去：只有查询方知道「这次要给谁核对」，
    //   光靠返回列表的来源标签无法建立归属。
    // ★ 未显式限定 attempt 时，回执仍必须属于**当前任务已结算的尝试**：
    //   取账本里本次验收认可的尝试集合，而不是「不核对」。
    const ledgerAttemptIds = (ctx?.ledger?.attempts ?? []).map((a) => a.attemptId);
    const identity = {
      taskRunId: ctx?.taskRunId ?? null,
      revision: ctx?.revision ?? null,
      attemptId: ctx?.scopedAttemptId ?? null,
      attemptIds: ledgerAttemptIds,
      kind: spec.receiptKind ?? null,
    };
    const result = await safeAccess(access, 'listReceipts', { spec, identity });
    if (!result.ok) return { verdict: VERDICT.blocked, detail: `回执查询失败：${result.text}` };

    const raw = Array.isArray(result.value?.receipts) ? result.value.receipts : [];

    // 按稳定 ID 去重：同一条回执出现两次只算一份
    const byId = new Map();
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      if (!isId(r.id)) continue;
      if (r.source !== 'runtime') continue;
      if (byId.has(r.id)) continue;
      byId.set(r.id, r);
    }

    const trusted = [];
    const rejected = [];
    for (const r of byId.values()) {
      // 归属：必须指向当前任务/版本/尝试（查询方给了哪几项就核哪几项）
      if (identity.taskRunId && r.taskRunId !== identity.taskRunId) {
        rejected.push(`${r.id} 属于任务 ${r.taskRunId}`);
        continue;
      }
      if (identity.revision !== null && r.revision !== identity.revision) {
        rejected.push(`${r.id} 属于第 ${r.revision} 版`);
        continue;
      }
      // ★ 归属必须落在**账本认可集合**里。
      //   空集合不是「不限制」，而是「没有任何被认可的尝试」—— 不能放行。
      //
      //   ★ 显式限定 attempt 时也要先确认它**真的在账本里**：
      //     限定一个从未登记过的尝试，等于给自己开一个新集合。
      const accepted = identity.attemptId ? [identity.attemptId] : identity.attemptIds;
      if (!accepted.length) {
        rejected.push(`${r.id} 无法归属：账本没有认可任何尝试`);
        continue;
      }
      if (identity.attemptId && !identity.attemptIds.includes(identity.attemptId)) {
        rejected.push(`${r.id} 无法归属：限定尝试 ${identity.attemptId} 未在账本登记`);
        continue;
      }
      if (!accepted.includes(r.attemptId)) {
        rejected.push(`${r.id} 属于未认可的尝试 ${r.attemptId ?? '(未标注)'}`);
        continue;
      }
      // ★ 状态必须**明确**是 confirmed。
      //   缺 status 不是「不限制」，是「没有证明」。
      if (r.status !== 'confirmed') {
        rejected.push(`${r.id} 状态是 ${r.status ?? '(未标注)'}`);
        continue;
      }
      // ★ 要求了种类就必须**明确**匹配；缺 kind 不是匹配。
      if (identity.kind && r.kind !== identity.kind) {
        rejected.push(`${r.id} 种类是 ${r.kind ?? '(未标注)'}`);
        continue;
      }
      trusted.push(r);
    }

    if (trusted.length >= need) {
      return {
        verdict: VERDICT.passed,
        detail: `可信回执 ${trusted.length} 份（已按 ID 去重），满足 ${need} 份`,
      };
    }
    const dedupNote = raw.length > byId.size ? `（原始 ${raw.length} 份，按 ID 去重后 ${byId.size} 份）` : '';

    const why = rejected.length ? `；不适用：${rejected.slice(0, 3).join('、')}` : '';
    return {
      verdict: VERDICT.failed,
      detail: `需要 ${need} 份可信回执，实际 ${trusted.length} 份${dedupNote}${why}`,
    };
  }

  return { verdict: VERDICT.needsReview, detail: `未实现的验收种类：${kind}` };
}

/** 明确支持的格式。未列出的格式不猜，直接 blocked。 */
export const SUPPORTED_FORMATS = Object.freeze(['json', 'markdown', 'text']);

/** 按声明的格式解析。 */
function parseDeclaredFormat(text, format) {
  if (format === 'json') {
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, why: 'JSON 顶层不是对象' };
      }
      return { ok: true, value };
    } catch (err) {
      return { ok: false, why: err.message };
    }
  }
  if (format === 'markdown') {
    // markdown 没有机器可查的结构，只确认不是空文本
    if (!String(text).trim()) return { ok: false, why: '内容是空的' };
    return { ok: true, value: { text: String(text) } };
  }
  if (format === 'text') {
    if (typeof text !== 'string') return { ok: false, why: '内容不是文本' };
    return { ok: true, value: { text } };
  }
  return { ok: false, why: `未支持的格式 ${format}` };
}

// ---------------------------------------------------------------------------
// 整体验收
// ---------------------------------------------------------------------------

/**
 * 对一个 TaskRun 跑一遍验收。
 *
 * @param {object} taskRun
 * @param {object} opts
 * @param {object} opts.access 权限入口
 * @param {string|null} [opts.attemptId] 显式限定只认某次尝试的成果
 */
export async function verifyTaskRun(taskRun, { access, attemptId = null, taskRuns = null } = {}) {
  const revision = taskRun?.revision;
  const conditions = taskRun?.goal?.verification ?? [];

  // ★ 白名单来自可信账本：本任务当前/历史产物 + 真实关联的已完成子交付。
  //   子产物来源仍记在 sourceTaskId/attemptId 上，不复制成父 attempt。
  const trusted = collectTrustedEvidence(taskRun, { taskRuns, attemptId, resolveRef: typeof access?.resolveRef === 'function' ? (ref) => access.resolveRef(ref) : null });
  const ledger = trusted.ledger;
  const allowedRefs = trusted.refs;
  const expertReviews = (taskRun?.expertReviews ?? []).filter((r) => r && r.taskRunId === taskRun?.id && r.revision === revision && (attemptId === null || attemptId === undefined || r.attemptId === attemptId));

  const verdicts = [];
  const unmet = [];
  const needsReview = [];
  const blocked = [];

  // 显式 attempt 是总入口范围：不存在/归属或版本不符/未结算/无账本，
  // 所有条件（含 expert）都拒绝，不能只让文件条件碰巧挡住。
  if (attemptId !== null && attemptId !== undefined && trusted.scope !== 'explicit_attempt') {
    for (const condition of conditions) {
      verdicts.push({ id: condition.id, kind: condition.kind, verdict: VERDICT.blocked, detail: '显式指定的执行 ' + attemptId + ' 不存在、不属于当前任务/版本或未结算' });
      blocked.push(condition.description + '：显式执行范围无效（' + attemptId + '）');
    }
    return {
      passed: false, verdicts, unmet, needsReview, blocked,
      ledger: { attempts: [], rejected: [] },
      evidenceSources: [], explicitAttemptInvalid: true,
      scopedAttemptId: attemptId,
    };
  }

  if (trusted.claimErrors?.length) {
    const why = trusted.claimErrors.map((e) => e.ref + '：' + e.reason).join('；');
    for (const condition of conditions) {
      verdicts.push({ id: condition.id, kind: condition.kind, verdict: VERDICT.blocked, detail: '完成申请引用了不可信证据：' + why });
      blocked.push(condition.description + '：完成申请引用了不可信证据（' + why + '）');
    }
    return {
      passed: false, verdicts, unmet, needsReview, blocked,
      ledger: { attempts: trusted.ledger.attempts.map((a) => a.attemptId), rejected: trusted.ledger.rejected },
      evidenceSources: [], claimErrors: trusted.claimErrors,
      scopedAttemptId: attemptId,
    };
  }

  for (const condition of conditions) {
    const result = await checkMechanical(condition, {
      revision,
      allowedRefs,
      ledger,
      access,
      evidenceSources: trusted.entries,
      expertReviews,
      // ★ 回执核对需要知道「这是给哪个任务/版本/尝试核对」
      taskRunId: taskRun?.id ?? null,
      scopedAttemptId: attemptId,
    });

    verdicts.push({ id: condition.id, kind: condition.kind, ...result });

    if (result.verdict === VERDICT.failed) {
      unmet.push(`${condition.description}：${result.detail}`);
    } else if (result.verdict === VERDICT.needsReview) {
      needsReview.push({ id: condition.id, description: condition.description, detail: result.detail });
    } else if (result.verdict === VERDICT.blocked) {
      blocked.push({ id: condition.id, description: condition.description, detail: result.detail });
    }
  }

  const passed = unmet.length === 0 && needsReview.length === 0 && blocked.length === 0;

  return {
    passed,
    verdicts,
    unmet,
    needsReview,
    blocked,
    // 便于排查：账本里实际认了哪些尝试、拒了哪些
    ledger: { attempts: ledger.attempts.map((a) => a.attemptId), rejected: ledger.rejected },
    evidenceSources: trusted.entries,
    scopedAttemptId: attemptId,
  };
}

// ---------------------------------------------------------------------------
// 用户接受部分成果
// ---------------------------------------------------------------------------

export function recordPartialAcceptance(taskRun, { acceptedBy, at, note = '' } = {}) {
  if (!taskRun) return reject('no_task', '没有任务');
  if (!isId(acceptedBy)) return reject('bad_acceptor', '接受人必须是合法身份');

  const unmet = taskRun?.progress?.unmet ?? [];

  return {
    ok: true,
    patch: {
      progress: {
        ...(taskRun.progress ?? {}),
        unmet: [...unmet],
        partialAcceptance: {
          acceptedBy,
          at,
          note: String(note ?? '').slice(0, 300),
          unmetAtAcceptance: [...unmet],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 证据在目标变更后的重判
// ---------------------------------------------------------------------------

export function revalidateEvidenceForRevision(taskRun) {
  const revision = taskRun?.revision;
  const evidence = taskRun?.progress?.evidence ?? [];

  const next = evidence.map((e) => {
    if (e.revision === revision) return e;
    return { ...e, verdict: 'pending', verifiedAt: null, staleForRevision: true };
  });

  return {
    ok: true,
    evidence: next,
    staleCount: next.filter((e) => e.staleForRevision).length,
  };
}

/**
 * 验收结论能不能写成「通过」。
 *
 * ★ 这是唯一允许产生 `verification_finished(passed:true)` 的判定点。
 */
export function canMarkCompleted(verification) {
  if (!verification) return { ok: false, why: '没有验收结论' };
  if (verification.unmet?.length) return { ok: false, why: `还有 ${verification.unmet.length} 项未满足` };
  if (verification.needsReview?.length) return { ok: false, why: `还有 ${verification.needsReview.length} 项需要专业判断` };
  if (verification.blocked?.length) return { ok: false, why: `还有 ${verification.blocked.length} 项无法机械判定` };
  if (verification.passed !== true) return { ok: false, why: '验收未通过' };
  return { ok: true, why: '全部机械条件通过' };
}

export { VERIFY_KIND, isMechanical };