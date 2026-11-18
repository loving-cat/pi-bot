/**
 * 请求闸门与持久回执测试（W4b 第 7 步）。
 *   node tests/task-request-gate.mjs
 *
 * ## 为什么这块必须单独测
 *
 * 协议要求：
 *   1. 同 `(requesterId, requestId)` 在租约期内并发到达时不得重入理解轮（返回 `inflight`）；
 *   2. 租约过期且无权威 `TaskRun` 时可抢占重试；同 ID 不同内容指纹必须 409 冲突；
 *   3. 回执损坏（非 `ENOENT` 的读错、JSON 损坏、缺字段）必须 fail-closed 返回 `corrupt`，绝不伪装成 `absent` 重开一轮。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-w4b-gate-'));
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
const { createRequestReceipts, receiptKey } = await import(src('tasks/task-request-receipts.js'));
const { openRequest, closeRequest, createRequestLifecycle, resumeAdmitted } = await import(src('coordination/task-request-gate.js'));
const { TaskRunStore } = await import(src('tasks/task-run-store.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

let dirSeq = 0;
function makeEnv({ leaseMs = 60_000, nowStart = 1_700_000_000_000 } = {}) {
  let now = nowStart;
  const clock = () => now;
  const dir = path.join(fixture, `case-${++dirSeq}`);
  const receiptsDir = path.join(dir, 'receipts');
  const taskRunsDir = path.join(dir, 'taskruns');
  const receipts = createRequestReceipts({ dir: receiptsDir, clock, leaseMs });
  const taskRuns = new TaskRunStore({ dir: taskRunsDir, now: clock });
  return { dir, receiptsDir, receipts, taskRuns, clock, advance: (ms) => { now += ms; } };
}

await test('1. 首次 openRequest 生成 running 回执与租约，缺参数被拒', () => {
  const { receipts } = makeEnv();
  const bad = openRequest({ receipts, requesterId: '', requestId: 'r1', roomId: 'dm_1', text: 'hi' });
  assert.equal(bad.status, 'corrupt');
  assert.equal(bad.code, 'bad_request_identity');

  const opened = openRequest({ receipts, requesterId: 'u1', requestId: 'r1', roomId: 'dm_1', text: '整理仓库' });
  assert.equal(opened.status, 'new');
  assert.ok(opened.leaseId);
  assert.equal(opened.scope.requesterId, 'u1');
  const stored = receipts.read('u1', 'r1');
  assert.equal(stored.status, 'ok');
  assert.equal(stored.receipt.stage, 'running');
});

await test('2. ★ 租约期内同键并发到达返回 inflight，不发新租约', () => {
  const { receipts, clock } = makeEnv({ leaseMs: 10_000 });
  const first = openRequest({ receipts, requesterId: 'u1', requestId: 'r_conc', roomId: 'dm_1', text: '查日志', clock });
  assert.equal(first.status, 'new');

  const second = openRequest({ receipts, requesterId: 'u1', requestId: 'r_conc', roomId: 'dm_1', text: '查日志', clock });
  assert.equal(second.status, 'inflight');
  assert.equal(second.receipt.leaseId, first.leaseId);
});

await test('3. ★ 租约过期且无 TaskRun 时允许抢占恢复（签发新 leaseId）', () => {
  const { receipts, clock, advance } = makeEnv({ leaseMs: 5_000 });
  const first = openRequest({ receipts, requesterId: 'u1', requestId: 'r_exp', roomId: 'dm_1', text: '查日志', clock });
  advance(6_000);
  const reclaimed = openRequest({ receipts, requesterId: 'u1', requestId: 'r_exp', roomId: 'dm_1', text: '查日志', clock });
  assert.equal(reclaimed.status, 'new');
  assert.notEqual(reclaimed.leaseId, first.leaseId);
  assert.equal(receipts.read('u1', 'r_exp').receipt.leaseId, reclaimed.leaseId);
});

await test('4. ★ 同 requestId 不同内容指纹返回 request_conflict（回执层与 TaskRun 层双重阻断）', async () => {
  const { receipts, receiptsDir, taskRuns, clock } = makeEnv();
  const opened = openRequest({ receipts, taskRuns, requesterId: 'u1', requestId: 'r_conf', roomId: 'dm_1', text: '任务A', clock });
  assert.equal(opened.status, 'new');

  const diffReceipt = openRequest({ receipts, taskRuns, requesterId: 'u1', requestId: 'r_conf', roomId: 'dm_1', text: '任务B', clock });
  assert.equal(diffReceipt.status, 'conflict');
  assert.equal(diffReceipt.code, 'request_conflict');

  // 清除回执后仅留权威 TaskRun，仍必须冲突拒绝
  fs.rmSync(receiptsDir, { recursive: true, force: true });
  const built = createTaskRun({
    id: 'tr_conf_1', requestId: 'r_conf', requesterId: 'u1', at: clock(),
    goal: { requirement: '任务A', verification: [{ id: 'v1', kind: 'artifact', description: '有产出', required: true }] },
  });
  await taskRuns.acceptRequest({ requesterId: 'u1', requestId: 'r_conf', fingerprint: opened.scope.fingerprint, build: () => built.taskRun });

  const diffTaskRun = openRequest({ receipts, taskRuns, requesterId: 'u1', requestId: 'r_conf', roomId: 'dm_1', text: '任务B', clock });
  assert.equal(diffTaskRun.status, 'conflict');
  assert.equal(diffTaskRun.code, 'request_conflict');
});

await test('5. ★ 回执 corrupt 判定：仅 ENOENT 为 absent；EISDIR / 坏 JSON / 残缺字段全部 fail-closed', () => {
  const { receiptsDir, receipts } = makeEnv();
  assert.equal(receipts.read('u1', 'missing_req').status, 'absent');

  // 非 ENOENT：目标位置是个目录 → EISDIR → receipt_read_failed
  fs.mkdirSync(path.join(receiptsDir, `${receiptKey('u1', 'dir_req')}.json`), { recursive: true });
  const dirRead = receipts.read('u1', 'dir_req');
  assert.equal(dirRead.status, 'corrupt');
  assert.equal(dirRead.code, 'receipt_read_failed');
  assert.equal(openRequest({ receipts, requesterId: 'u1', requestId: 'dir_req', roomId: 'dm_1', text: 'x' }).status, 'corrupt');

  // 坏 JSON
  fs.writeFileSync(path.join(receiptsDir, `${receiptKey('u1', 'bad_json')}.json`), '{broken json');
  const jsonRead = receipts.read('u1', 'bad_json');
  assert.equal(jsonRead.status, 'corrupt');
  assert.equal(jsonRead.code, 'receipt_bad_json');

  // accepted 缺 taskRunId / failed 缺 error / 缺 receipt 对象 / bad version
  fs.writeFileSync(
    path.join(receiptsDir, `${receiptKey('u1', 'no_tid')}.json`),
    JSON.stringify({ version: 1, receipt: { requesterId: 'u1', requestId: 'no_tid', fingerprint: 'abc', stage: 'accepted', at: 1 } }),
  );
  assert.equal(receipts.read('u1', 'no_tid').code, 'receipt_accepted_missing_task');

  fs.writeFileSync(
    path.join(receiptsDir, `${receiptKey('u1', 'no_err')}.json`),
    JSON.stringify({ version: 1, receipt: { requesterId: 'u1', requestId: 'no_err', fingerprint: 'abc', stage: 'failed', at: 1 } }),
  );
  assert.equal(receipts.read('u1', 'no_err').code, 'receipt_failed_missing_error');

  fs.writeFileSync(
    path.join(receiptsDir, `${receiptKey('u1', 'missing_rec')}.json`),
    JSON.stringify({ version: 1 }),
  );
  assert.equal(receipts.read('u1', 'missing_rec').code, 'receipt_missing');

  fs.writeFileSync(
    path.join(receiptsDir, `${receiptKey('u1', 'bad_ver')}.json`),
    JSON.stringify({ version: 99, receipt: { requesterId: 'u1', requestId: 'bad_ver', fingerprint: 'abc', stage: 'answered', at: 1 } }),
  );
  assert.equal(receipts.read('u1', 'bad_ver').code, 'receipt_bad_version');
});

await test('6. ★ closeRequest：权威 TaskRun 胜过 verdict=answer、无结构拒绝、failed 允许重试', async () => {
  const { receipts, taskRuns, clock } = makeEnv();
  const events = [];
  const lifecycle = createRequestLifecycle({
    receipts, taskRuns,
    onTerminal: (scope, out) => events.push({ requestId: scope.requestId, out }),
  });

  // Case A: 普通 answer 收口 + onTerminal + 同 ID 返回 done
  const sAns = openRequest({ receipts, taskRuns, requesterId: 'u1', requestId: 'r_ans', roomId: 'dm_1', text: '你好', clock });
  const closedAns = lifecycle.close(sAns.scope, null, 'answer');
  assert.equal(closedAns.ok, true);
  assert.equal(closedAns.receipt.stage, 'answered');
  assert.equal(events.length, 1);
  assert.equal(openRequest({ receipts, taskRuns, requesterId: 'u1', requestId: 'r_ans', roomId: 'dm_1', text: '你好', clock }).status, 'done');

  // Case B: 无 error 且 verdict 非 answer/clarification → NO_INTAKE_VERDICT
  const sNo = openRequest({ receipts, taskRuns, requesterId: 'u1', requestId: 'r_noverdict', roomId: 'dm_1', text: '模糊', clock });
  const closedNo = closeRequest({ receipts, taskRuns, scope: sNo.scope, verdict: null });
  assert.equal(closedNo.receipt.stage, 'failed');
  assert.equal(closedNo.receipt.error, 'NO_INTAKE_VERDICT');
  // failed 允许同 ID 重试
  assert.equal(openRequest({ receipts, taskRuns, requesterId: 'u1', requestId: 'r_noverdict', roomId: 'dm_1', text: '模糊', clock }).status, 'new');

  // Case C: TaskRun 已落盘时，即使 close(answer) 也保住 stage=accepted 权威事实
  const sAuth = openRequest({ receipts, taskRuns, requesterId: 'u1', requestId: 'r_auth', roomId: 'dm_1', text: '干活', clock });
  const built = createTaskRun({
    id: 'tr_auth_1', requestId: 'r_auth', requesterId: 'u1', at: clock(),
    goal: { requirement: '干活', verification: [{ id: 'v1', kind: 'artifact', description: '产出', required: true }] },
  });
  await taskRuns.acceptRequest({ requesterId: 'u1', requestId: 'r_auth', fingerprint: sAuth.scope.fingerprint, build: () => built.taskRun });
  const closedAuth = closeRequest({ receipts, taskRuns, scope: sAuth.scope, verdict: 'answer' });
  assert.equal(closedAuth.authoritative, true);
  assert.equal(receipts.read('u1', 'r_auth').receipt.stage, 'accepted');
  assert.equal(receipts.read('u1', 'r_auth').receipt.taskRunId, 'tr_auth_1');
});

await test('7. taskRuns.findByRequest indeterminate 时 openRequest 与 resumeAdmitted 均 fail-closed', () => {
  const { receipts } = makeEnv();
  const brokenTaskRuns = {
    findByRequest: () => ({ status: 'indeterminate', problems: [{ id: 'bad', status: 'corrupt' }] }),
  };
  const opened = openRequest({
    receipts, taskRuns: brokenTaskRuns, requesterId: 'u1', requestId: 'r_ind', roomId: 'dm_1', text: 'x',
  });
  assert.equal(opened.status, 'corrupt');
  assert.equal(opened.code, 'lookup_indeterminate');

  return resumeAdmitted({
    store: null,
    taskRuns: brokenTaskRuns,
    scope: { requesterId: 'u1', requestId: 'r_ind', fingerprint: 'fp' },
  }).then((res) => {
    assert.equal(res.ok, false);
    assert.equal(res.code, 'lookup_indeterminate');
  });
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
