/**
 * TaskRun 首次准入与三模式测试（W4b 第 6 步）。
 *   node tests/task-admission.mjs
 *
 * ## 为什么这块必须单独测
 *
 * `coordination/task-admission.js`（376 行）和 `coordination/intake.js`（212 行）
 * 在开启 `TASK_INTAKE` 前长期零直接测试覆盖。这里守住三条核心契约：
 *   1. `discussion` 模式优先于模型提案：即便模型给出 `accept_task`，也不建任务/不建部门；
 *   2. 三条准入模式（`direct` / `createOnly` / `new` & `existing`）各自严格落盘并终结；
 *   3. `expert` 专业验收不误放行到无负责人的 `direct` 路线，同键重放幂等、异内容 409 冲突。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-w4b-admit-'));
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
  admissionFingerprint,
  createRequestScope,
  admissionBudget,
  admissionAuthorize,
  admitFirstTask,
} = await import(src('coordination/task-admission.js'));
const { handleIntake, ACTION, INTAKE_OUTCOME } = await import(src('coordination/intake.js'));
const { createRequestReceipts } = await import(src('tasks/task-request-receipts.js'));
const { TaskRunStore } = await import(src('tasks/task-run-store.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { createStore } = await import(src('store.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

let seq = 0;
function makeEnv() {
  const dir = path.join(fixture, `case-${++seq}`);
  const store = createStore({ dataDir: dir });
  const taskRuns = new TaskRunStore({ dir: path.join(dir, 'taskruns') });
  const receipts = createRequestReceipts({ dir: path.join(dir, 'receipts') });
  const prepareSpec = (raw = {}) => ({
    ok: true,
    spec: {
      name: raw.name || `新部门_${seq}`,
      topic: raw.topic || '工程交付',
      members: Array.isArray(raw.members) && raw.members.length
        ? raw.members
        : [{ name: '组长甲', persona: '统筹交付' }, { name: '研发乙', persona: '编码测试' }],
      lead: raw.lead || '组长甲',
      warnings: [],
    },
  });
  return { dir, store, taskRuns, receipts, prepareSpec };
}

const sampleGoal = (kind = 'artifact') => ({
  requirement: '完成服务模块拆分并补充单测',
  deliverables: ['server/src/runner/turn-executor.js'],
  verification: [{ id: 'v1', kind, description: '交付文件存在并通过测试', required: true }],
});

// ---------------------------------------------------------------------------
// 1. 基础纯函数：指纹 / RequestScope / 预算 / 交接授权校验
// ---------------------------------------------------------------------------

await test('1. createRequestScope 与 admissionFingerprint 附件顺序无关', () => {
  const fp1 = admissionFingerprint({ roomId: 'r1', text: '做调研', attachments: ['a2', 'a1'], mode: 'auto' });
  const fp2 = admissionFingerprint({ roomId: 'r1', text: '做调研', attachments: [{ id: 'a1' }, { id: 'a2' }], mode: 'auto' });
  assert.equal(fp1, fp2);
  assert.equal(createRequestScope({ requesterId: '', requestId: 'req1', roomId: 'r1', at: 1000 }), null);
  const scope = createRequestScope({ requesterId: 'dev_1', requestId: 'req_1', roomId: 'r1', text: '做调研', at: 1000 });
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(scope.fingerprint.length, 64);
});

await test('2. admissionBudget 取全局环境变量与部门上限的更紧者，都不配时不限额', () => {
  assert.deepEqual(admissionBudget({}, null), { maxRuns: null, concurrencyLimit: 1 });
  assert.deepEqual(admissionBudget({ PI_BOT_TASK_MAX_RUNS: '10' }, { maxRuns: 4 }), { maxRuns: 4, concurrencyLimit: 1 });
  assert.deepEqual(admissionBudget({ PI_BOT_TASK_MAX_RUNS: '3' }, { maxRuns: 8 }), { maxRuns: 3, concurrencyLimit: 1 });
});

await test('3. admissionAuthorize 拦住错误任务、终态取消、篡改身份/指纹与旧版本', () => {
  const auth = admissionAuthorize({
    taskRunId: 'tr_1', revision: 2, requesterId: 'u1', requestId: 'req1', fingerprint: 'fp1',
  });
  assert.equal(auth({ id: 'tr_other' }).code, 'admission_invalid');
  assert.equal(auth({ id: 'tr_1', state: 'cancelled' }).code, 'admission_terminal');
  assert.equal(auth({ id: 'tr_1', state: 'queued', request: { requesterId: 'u2', requestId: 'req1', fingerprint: 'fp1' } }).code, 'admission_invalid');
  assert.equal(auth({ id: 'tr_1', state: 'queued', request: { requesterId: 'u1', requestId: 'req1', fingerprint: 'fp_bad' } }).code, 'admission_invalid');
  assert.equal(auth({ id: 'tr_1', state: 'queued', revision: 1, request: { requesterId: 'u1', requestId: 'req1', fingerprint: 'fp1' } }).code, 'admission_stale');
  assert.equal(auth({ id: 'tr_1', state: 'queued', revision: 2, request: { requesterId: 'u1', requestId: 'req1', fingerprint: 'fp1' } }), null);
});

// ---------------------------------------------------------------------------
// 2. 非执行与 discussion 模式
// ---------------------------------------------------------------------------

await test('4. ★ discussion 模式优先于模型提案：模型给出 accept_task 也不建任务不建部门', async () => {
  const { store, taskRuns, receipts, prepareSpec } = makeEnv();
  try {
    const scope = createRequestScope({ requesterId: 'u1', requestId: 'req_disc', roomId: 'dm_1', text: '先聊聊架构', mode: 'discussion', at: 1000 });
    const out = await admitFirstTask({
      store, taskRuns, receipts, scope, prepareSpec, clock: () => 2000,
      proposal: { kind: 'accept_task', goal: sampleGoal(), routing: { type: 'new', departmentSpec: { name: '架构组' } } },
    });
    assert.equal(out.ok, true);
    assert.equal(out.accepted, false);
    assert.equal(out.kind, 'discussion');
    assert.equal(taskRuns.listAll().taskRuns.length, 0);
    assert.equal(store.listRooms().filter((r) => r.kind === 'group').length, 0);
    assert.equal(receipts.read('u1', 'req_disc').receipt.stage, 'answered');
  } finally {
    clearTimeout(store.saveTimer);
  }
});

await test('5. answer 与 clarification 不创建 TaskRun，直接写 answered 回执', async () => {
  const { store, taskRuns, receipts } = makeEnv();
  try {
    const scope = createRequestScope({ requesterId: 'u1', requestId: 'req_ans', roomId: 'dm_1', text: '你是谁', at: 1000 });
    const out = await admitFirstTask({
      store, taskRuns, receipts, scope, clock: () => 2000,
      proposal: { kind: 'answer', text: '我是 Orbis 助手' },
    });
    assert.equal(out.ok, true);
    assert.equal(out.accepted, false);
    assert.equal(out.kind, 'answer');
    assert.equal(taskRuns.listAll().taskRuns.length, 0);
    assert.equal(receipts.read('u1', 'req_ans').receipt.stage, 'answered');
  } finally {
    clearTimeout(store.saveTimer);
  }
});

// ---------------------------------------------------------------------------
// 3. 准入三模式（direct / createOnly / new & existing）
// ---------------------------------------------------------------------------

await test('6. ★ 准入模式 direct：归属主控私聊且保持 queued', async () => {
  const { store, taskRuns, receipts } = makeEnv();
  try {
    const dm = store.ensureDm(store.mainBot().id);
    const scope = createRequestScope({ requesterId: 'u1', requestId: 'req_dir', roomId: dm.id, text: '帮我整理当前目录', at: 1000 });
    const out = await admitFirstTask({
      store, taskRuns, receipts, scope, clock: () => 2000,
      proposal: { kind: 'accept_task', goal: sampleGoal('artifact'), routing: { type: 'direct' } },
    });
    assert.equal(out.ok, true);
    assert.equal(out.accepted, true);
    assert.equal(out.outcome, 'direct');
    assert.equal(out.leadBotId, store.mainBot().id);
    const run = taskRuns.read(out.taskRunId).taskRun;
    assert.equal(run.state, 'queued');
    assert.equal(run.owner.roomKind, 'dm');
    assert.equal(run.admission.outcome, 'direct');
    assert.equal(receipts.read('u1', 'req_dir').receipt.stage, 'accepted');
  } finally {
    clearTimeout(store.saveTimer);
  }
});

await test('7. ★ 准入模式 createOnly：自动补容器目标、建完部门即以主机收据 completed 终结', async () => {
  const { store, taskRuns, receipts, prepareSpec } = makeEnv();
  try {
    const scope = createRequestScope({ requesterId: 'u1', requestId: 'req_co', roomId: 'dm_1', text: '建一个测试部门先别开工', at: 1000 });
    const out = await admitFirstTask({
      store, taskRuns, receipts, scope, prepareSpec, clock: () => 2000,
      proposal: { kind: 'accept_task', routing: { type: 'new', departmentOnly: true, departmentSpec: { name: 'QA部门' } } },
    });
    assert.equal(out.ok, true);
    assert.equal(out.accepted, true);
    assert.equal(out.createOnly, true);
    assert.equal(out.outcome, 'created');
    assert.equal(out.queueRef, null);
    assert.ok(out.departmentId);
    const run = taskRuns.read(out.taskRunId).taskRun;
    assert.equal(run.state, 'completed');
    assert.equal(run.delivery.source, 'host_department_receipt');
    assert.ok(store.getRoom(out.departmentId));
  } finally {
    clearTimeout(store.saveTimer);
  }
});

await test('8. ★ 准入模式 new 部门与 existing 部门：真建群/接现有群并保持 queued 待调度', async () => {
  const { store, taskRuns, receipts, prepareSpec } = makeEnv();
  try {
    const scopeNew = createRequestScope({ requesterId: 'u1', requestId: 'req_new', roomId: 'dm_1', text: '新建科研组来做评测', at: 1000 });
    const newOut = await admitFirstTask({
      store, taskRuns, receipts, scope: scopeNew, prepareSpec, clock: () => 2000,
      proposal: { kind: 'accept_task', goal: sampleGoal('expert'), routing: { type: 'new', departmentSpec: { name: '科研组' } } },
    });
    assert.equal(newOut.ok, true);
    assert.equal(newOut.outcome, 'created');
    assert.equal(newOut.createOnly, false);
    const runNew = taskRuns.read(newOut.taskRunId).taskRun;
    assert.equal(runNew.state, 'queued');
    assert.equal(runNew.owner.roomKind, 'group');
    assert.equal(runNew.owner.departmentId, newOut.departmentId);

    const scopeExisting = createRequestScope({ requesterId: 'u1', requestId: 'req_ext', roomId: 'dm_1', text: '交给科研组做第二期', at: 3000 });
    const extOut = await admitFirstTask({
      store, taskRuns, receipts, scope: scopeExisting, clock: () => 4000,
      proposal: { kind: 'accept_task', goal: sampleGoal('expert'), routing: { type: 'existing', departmentId: newOut.departmentId } },
    });
    assert.equal(extOut.ok, true);
    assert.equal(extOut.outcome, 'existing');
    assert.equal(extOut.departmentId, newOut.departmentId);
  } finally {
    clearTimeout(store.saveTimer);
  }
});

// ---------------------------------------------------------------------------
// 4. 守门与幂等：expert 拒绝 / 重复幂等 / 内容冲突 / handleIntake
// ---------------------------------------------------------------------------

await test('9. ★ expert 验收禁止落入无部门的 direct 路线（失败并终结回执）', async () => {
  const { store, taskRuns, receipts } = makeEnv();
  try {
    const scope = createRequestScope({ requesterId: 'u1', requestId: 'req_exp', roomId: 'dm_1', text: '你自己做并专家验收', at: 1000 });
    const out = await admitFirstTask({
      store, taskRuns, receipts, scope, clock: () => 2000,
      proposal: { kind: 'accept_task', goal: sampleGoal('expert'), routing: { type: 'direct' } },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'expert_route_unsupported');
    assert.equal(taskRuns.listAll().taskRuns.length, 0);
    assert.equal(receipts.read('u1', 'req_exp').receipt.stage, 'failed');
  } finally {
    clearTimeout(store.saveTimer);
  }
});

await test('10. 同 requestId 重复准入幂等返回原任务，不同内容返回 request_conflict', async () => {
  const { store, taskRuns, receipts } = makeEnv();
  try {
    const scope1 = createRequestScope({ requesterId: 'u1', requestId: 'req_dup', roomId: 'dm_1', text: '内容A', at: 1000 });
    const first = await admitFirstTask({
      store, taskRuns, receipts, scope: scope1, clock: () => 2000,
      proposal: { kind: 'accept_task', goal: sampleGoal('artifact'), routing: { type: 'direct' } },
    });
    assert.equal(first.ok, true);

    const replay = await admitFirstTask({
      store, taskRuns, receipts, scope: scope1, clock: () => 2100,
      proposal: { kind: 'accept_task', goal: sampleGoal('artifact'), routing: { type: 'direct' } },
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.taskRunId, first.taskRunId);
    assert.equal(taskRuns.listAll().taskRuns.length, 1);

    const scopeDiff = createRequestScope({ requesterId: 'u1', requestId: 'req_dup', roomId: 'dm_1', text: '内容B', at: 2200 });
    const conflict = await admitFirstTask({
      store, taskRuns, receipts, scope: scopeDiff, clock: () => 2300,
      proposal: { kind: 'accept_task', goal: sampleGoal('artifact'), routing: { type: 'direct' } },
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'request_conflict');
  } finally {
    clearTimeout(store.saveTimer);
  }
});

await test('11. handleIntake：未受管拒绝、讨论模式跳过、direct 返回已受理目标', async () => {
  const { store, taskRuns } = makeEnv();
  try {
    const denied = await handleIntake({ action: { type: ACTION.accept }, submission: { kind: 'legacy' }, store, taskRuns });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'not_managed');

    const built = createTaskRun({
      id: 'tr_intake_1', requestId: 'req_i1', requesterId: 'u1', at: 1000, goal: sampleGoal('artifact'),
    });
    assert.equal(built.ok, true);
    const submission = {
      kind: 'managed', taskRunId: built.taskRun.id, revision: 1, botId: store.mainBot().id,
      candidateDepartmentIds: [], acceptedGoal: built.taskRun.goal,
    };

    const discussed = await handleIntake({
      action: { type: ACTION.accept, intake: { kind: 'accept_task', goal: sampleGoal('artifact'), routing: { type: 'direct' } }, userWantsDiscussion: true },
      submission, store, taskRuns,
    });
    assert.equal(discussed.ok, true);
    assert.equal(discussed.outcome, INTAKE_OUTCOME.skipped);

    const directOut = await handleIntake({
      action: { type: ACTION.accept, intake: { kind: 'accept_task', goal: { requirement: '模型另写目标', verification: [{ id: 'x', kind: 'artifact', description: 'y', required: true }] }, routing: { type: 'direct' } } },
      submission, store, taskRuns,
    });
    assert.equal(directOut.ok, true);
    assert.equal(directOut.outcome, INTAKE_OUTCOME.direct);
    assert.equal(directOut.goal.requirement, '完成服务模块拆分并补充单测');
  } finally {
    clearTimeout(store.saveTimer);
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
