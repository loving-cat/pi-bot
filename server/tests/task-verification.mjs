/**
 * 任务产出验收门禁测试（W4b 第 8 步）。
 *   node tests/task-verification.mjs
 *
 * ## 为什么这块必须单独测
 *
 * `tasks/task-verification.js`（795 行）此前零直接单测，它守住两条上线底线：
 *   1. `expert` 专业验收必须有同任务/同版本/同条件的负责人审核记录；普通完成文本不能蒙混过关（输出 `needs_review`）；
 *   2. 缺失或不可读文件必须阻断/不通过（`blocked` 或 `failed`），绝不把“文件不存在”当成合法交付内容。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-w4b-verify-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  VERDICT,
  verifyTaskRun,
  checkMechanical,
  canMarkCompleted,
  revalidateEvidenceForRevision,
} = await import(src('tasks/task-verification.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

function makeRun({ id = 'tr_v1', revision = 1, verification = [], attempts = [], expertReviews = [], delivery = null } = {}) {
  return {
    id,
    revision,
    goal: { requirement: '交付测试报告', verification },
    attempts,
    expertReviews,
    delivery,
  };
}

function makeAttempt({ attemptId = 'att_1', taskRunId = 'tr_v1', revision = 1, state = 'settled', artifacts = [], phase = null } = {}) {
  return {
    attemptId,
    taskRunId,
    revision,
    botId: 'b_lead',
    state,
    result: {
      status: 'returned',
      artifacts,
      ...(phase ? { completionSelection: phase.selection, phase } : {}),
    },
  };
}

function makeFsAccess(files = {}) {
  return {
    async stat(ref) {
      return Object.prototype.hasOwnProperty.call(files, ref)
        ? { exists: true, size: String(files[ref]).length }
        : { exists: false };
    },
    async readText(ref) {
      if (!Object.prototype.hasOwnProperty.call(files, ref)) {
        const err = new Error(`文件不存在：${ref}`);
        err.code = 'B07_FILE_MISSING';
        throw err;
      }
      return { text: String(files[ref]) };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. expert 专业验收：没有判断记录 → needs_review，普通文本无效
// ---------------------------------------------------------------------------

await test('1. ★ expert 条件没有负责人审核记录 → needs_review（普通交付文本无效）', async () => {
  const run = makeRun({
    verification: [{ id: 'c_exp', kind: 'expert', description: '负责人确认结论质量', required: true }],
    attempts: [makeAttempt({ artifacts: ['report.md'] })],
    delivery: { summary: '模型自称已经全部审核通过！' },
  });
  const res = await verifyTaskRun(run, { access: makeFsAccess({ 'report.md': 'ok' }) });
  assert.equal(res.passed, false);
  assert.equal(res.verdicts[0].verdict, VERDICT.needsReview);
  assert.equal(res.needsReview.length, 1);
  assert.equal(canMarkCompleted(res).ok, false);
});

await test('2. expert 条件有同任务/同版本/同条件 passed 记录才能通过', async () => {
  const cond = { id: 'c_exp', kind: 'expert', description: '负责人专业验收', required: true };
  const wrongRev = makeRun({
    revision: 2,
    verification: [cond],
    expertReviews: [{ taskRunId: 'tr_v1', revision: 1, conditionId: 'c_exp', verdict: 'passed', note: '旧版通过' }],
  });
  assert.equal((await verifyTaskRun(wrongRev, { access: makeFsAccess() })).verdicts[0].verdict, VERDICT.needsReview);

  const failedRev = makeRun({
    revision: 2,
    verification: [cond],
    expertReviews: [{ taskRunId: 'tr_v1', revision: 2, conditionId: 'c_exp', verdict: 'failed', note: '数据口径不对' }],
  });
  const failedRes = await verifyTaskRun(failedRev, { access: makeFsAccess() });
  assert.equal(failedRes.passed, false);
  assert.equal(failedRes.verdicts[0].verdict, VERDICT.failed);
  assert.equal(failedRes.unmet.length, 1);

  const okRev = makeRun({
    revision: 2,
    verification: [cond],
    expertReviews: [{ taskRunId: 'tr_v1', revision: 2, conditionId: 'c_exp', verdict: 'passed', note: '口径已修正' }],
  });
  const okRes = await verifyTaskRun(okRev, { access: makeFsAccess() });
  assert.equal(okRes.passed, true);
  assert.equal(canMarkCompleted(okRes).ok, true);
});

// ---------------------------------------------------------------------------
// 2. 缺失文件与不可信证据声明：绝不放行
// ---------------------------------------------------------------------------

await test('3. ★ kind=format 缺失文件 → blocked（不把「文件不存在」当正文）', async () => {
  const run = makeRun({
    verification: [
      { id: 'c_fmt', kind: 'format', description: 'JSON 结构报告', spec: { format: 'json', requiredFields: ['summary'] }, required: true },
    ],
    attempts: [makeAttempt({ artifacts: ['missing-report.json'] })],
  });
  const res = await verifyTaskRun(run, { access: makeFsAccess({}) });
  assert.equal(res.passed, false);
  assert.equal(res.verdicts[0].verdict, VERDICT.blocked);
  assert.equal(res.blocked.length, 1);
  assert.equal(canMarkCompleted(res).ok, false);
});

await test('4. kind=artifact 与 count 缺失产物文件或账本为空 → failed（unmet）', async () => {
  const run = makeRun({
    verification: [
      { id: 'c_art', kind: 'artifact', description: '输出报告文件', spec: { count: 1 }, required: true },
    ],
    attempts: [makeAttempt({ artifacts: ['nonexistent.md'] })],
  });
  const res = await verifyTaskRun(run, { access: makeFsAccess({}) });
  assert.equal(res.passed, false);
  assert.equal(res.verdicts[0].verdict, VERDICT.failed);
  assert.equal(res.unmet.length, 1);
});

await test('5. kind=format 同时校验 format(json) + requiredFields + mustContain，通过与否严格区分', async () => {
  const cond = {
    id: 'c_json',
    kind: 'format',
    description: '有效汇总 JSON',
    spec: { format: 'json', requiredFields: ['total', 'status'], mustContain: ['ok'] },
    required: true,
  };
  const goodRun = makeRun({
    verification: [cond],
    attempts: [makeAttempt({ artifacts: ['out.json'] })],
  });
  const passRes = await verifyTaskRun(goodRun, {
    access: makeFsAccess({ 'out.json': JSON.stringify({ total: 5, status: 'ok' }) }),
  });
  assert.equal(passRes.passed, true);

  const missingFieldRes = await verifyTaskRun(goodRun, {
    access: makeFsAccess({ 'out.json': JSON.stringify({ total: 5 }) }),
  });
  assert.equal(missingFieldRes.passed, false);
  assert.equal(missingFieldRes.verdicts[0].verdict, VERDICT.failed);
});

await test('6. ★ 完成申请引用不在可信账本池中的产物 → 全部条件判 blocked（claimErrors）', async () => {
  const run = makeRun({
    verification: [{ id: 'c_art', kind: 'artifact', description: '有产物', required: true }],
    attempts: [
      makeAttempt({
        attemptId: 'att_done',
        artifacts: ['real.md'],
        phase: {
          kind: 'apply_completion',
          selection: { present: true, refs: ['fake-unregistered.md'] },
        },
      }),
    ],
  });
  // 让 latestCompletionAttempt 认出 apply_completion：需 result.phase='apply_completion' 且 completionSelection
  run.attempts[0].result = {
    status: 'returned',
    artifacts: ['real.md'],
    phaseKind: 'apply_completion',
    completionSelection: { present: true, refs: ['fake-unregistered.md'] },
  };
  const res = await verifyTaskRun(run, { access: makeFsAccess({ 'real.md': 'hi', 'fake-unregistered.md': 'fake' }) });
  assert.equal(res.passed, false);
  assert.equal(res.verdicts[0].verdict, VERDICT.blocked);
  assert.ok(res.claimErrors?.length >= 1);
});

await test('7. 显式指定无效或未结算 attemptId → 全部条件（含 expert）判 blocked', async () => {
  const run = makeRun({
    verification: [{ id: 'c_exp', kind: 'expert', description: '审阅', required: true }],
    attempts: [makeAttempt({ attemptId: 'att_open', state: 'registered', artifacts: [] })],
    expertReviews: [{ taskRunId: 'tr_v1', revision: 1, conditionId: 'c_exp', attemptId: 'att_open', verdict: 'passed' }],
  });
  const res = await verifyTaskRun(run, { access: makeFsAccess(), attemptId: 'att_open' });
  assert.equal(res.passed, false);
  assert.equal(res.explicitAttemptInvalid, true);
  assert.equal(res.verdicts[0].verdict, VERDICT.blocked);
});

await test('8. checkMechanical 空格式规格或不支持格式直接 blocked', async () => {
  const emptySpec = await checkMechanical({ id: 'c1', kind: 'format', spec: {} }, { allowedRefs: ['a.txt'], access: makeFsAccess({ 'a.txt': 'x' }) });
  assert.equal(emptySpec.verdict, VERDICT.blocked);

  const badFmt = await checkMechanical({ id: 'c2', kind: 'format', spec: { format: 'xml' } }, { allowedRefs: ['a.txt'], access: makeFsAccess({ 'a.txt': 'x' }) });
  assert.equal(badFmt.verdict, VERDICT.blocked);
});

await test('9. revalidateEvidenceForRevision 将旧版本证据标记为 pending / staleForRevision', () => {
  const run = {
    ...makeRun({ revision: 2 }),
    progress: {
      evidence: [
        { ref: 'old.md', revision: 1, verdict: 'passed', verifiedAt: 1000 },
        { ref: 'cur.md', revision: 2, verdict: 'passed', verifiedAt: 2000 },
      ],
    },
  };
  const out = revalidateEvidenceForRevision(run);
  assert.equal(out.ok, true);
  assert.equal(out.staleCount, 1);
  assert.equal(out.evidence[0].verdict, 'pending');
  assert.equal(out.evidence[0].staleForRevision, true);
  assert.equal(out.evidence[1].verdict, 'passed');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
