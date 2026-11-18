/**
 * TaskRun 存储并发事务与根授权不变量测试（W4b 第 9 步）。
 *   node tests/task-run-store.mjs
 *
 * ## 为什么这块必须单独测
 *
 * `tasks/task-run-store.js`（961 行）负责整个引擎的持久化一致性：
 *   1. `mutate` / `save` / `acceptRequest` 经单写者事务串行，高并发改同一个任务不丢更新；
 *   2. CAS 版本守卫（`storeVersion` / `expectSequence` / 终态禁回退 / 损坏文件 fail-closed）；
 *   3. 子任务在槽位占位或账本登记前必须在根任务 `attemptSlots` 中拥有匹配 `(botId, revision, alive/started)` 的授权。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-w4b-store-'));
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
const { TaskRunStore, ATTEMPT_SLOT, slotKey } = await import(src('tasks/task-run-store.js'));
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
const makeStore = () => new TaskRunStore({ dir: path.join(fixture, `case-${++dirSeq}`, 'taskruns') });

function buildRoot(id = 'tr_root_1', requestId = 'req_r1') {
  const out = createTaskRun({
    id,
    requestId,
    requesterId: 'u1',
    at: 1_700_000_000_000,
    goal: { requirement: '根任务', verification: [{ id: 'v1', kind: 'artifact', description: '产物', required: true }] },
  });
  assert.equal(out.ok, true);
  return {
    ...out.taskRun,
    request: { requesterId: 'u1', requestId, fingerprint: `fp_${requestId}`, acceptedAt: 1_700_000_000_000 },
  };
}

function buildChild(id = 'tr_child_1', rootTaskId = 'tr_root_1', requestId = 'req_c1') {
  const out = createTaskRun({
    id,
    rootTaskId,
    parentTaskId: rootTaskId,
    requestId,
    requesterId: 'u1',
    at: 1_700_000_000_100,
    goal: { requirement: '子任务', verification: [{ id: 'v1', kind: 'artifact', description: '子产物', required: true }] },
  });
  assert.equal(out.ok, true);
  return {
    ...out.taskRun,
    request: { requesterId: 'u1', requestId, fingerprint: `fp_${requestId}`, acceptedAt: 1_700_000_000_100 },
  };
}

// ---------------------------------------------------------------------------
// 1. 单写者事务串行与并发落盘
// ---------------------------------------------------------------------------

await test('1. ★ 10 路并发 mutate(id) 全部串行落盘，零丢失更新且 storeVersion 单调 +10', async () => {
  const store = makeStore();
  const root = buildRoot();
  const saved = await store.save(root);
  assert.equal(saved.ok, true);
  const startVer = saved.taskRun.storeVersion;

  const outcomes = await Promise.all(
    Array.from({ length: 10 }, (_, idx) =>
      store.mutate(root.id, {
        mutate: (cur) => ({
          ...cur,
          sequence: cur.sequence + 1,
          progress: {
            ...cur.progress,
            confirmedSteps: [...cur.progress.confirmedSteps, `step_${idx}`],
          },
          updatedAt: 1_700_000_001_000 + idx,
        }),
      }),
    ),
  );
  assert.equal(outcomes.every((o) => o.ok && o.changed), true);
  const loaded = store.read(root.id);
  assert.equal(loaded.status, 'found');
  assert.equal(loaded.taskRun.progress.confirmedSteps.length, 10);
  assert.equal(loaded.taskRun.sequence, 10);
  assert.equal(loaded.taskRun.storeVersion, startVer + 10);
});

await test('2. ★ 并发同键 acceptRequest 只创建 1 个 TaskRun（其余命中 existing）', async () => {
  const store = makeStore();
  let buildCalls = 0;
  const resultsAll = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      store.acceptRequest({
        requesterId: 'u1',
        requestId: 'req_race',
        fingerprint: 'fp_same',
        build: () => {
          buildCalls++;
          return buildRoot(`tr_race_${i}`, 'req_race');
        },
        at: 1_700_000_000_000,
      }),
    ),
  );
  assert.equal(resultsAll.every((r) => r.ok), true);
  assert.equal(resultsAll.filter((r) => r.created).length, 1);
  assert.equal(resultsAll.filter((r) => r.existing).length, 4);
  assert.equal(buildCalls, 1);
  assert.equal(store.listAll().taskRuns.length, 1);
});

// ---------------------------------------------------------------------------
// 2. CAS / 版本 / 终态 / 损坏目录防线
// ---------------------------------------------------------------------------

await test('3. expectSequence 不符、旧 storeVersion 与终态回退均被拒', async () => {
  const store = makeStore();
  const root = buildRoot();
  const v1 = await store.save(root);
  assert.equal(v1.ok, true);

  const staleSeq = await store.mutate(root.id, {
    expectSequence: 99,
    mutate: (cur) => ({ ...cur, sequence: 100 }),
  });
  assert.equal(staleSeq.ok, false);
  assert.equal(staleSeq.code, 'stale_write');

  // 旧快照并发写：先用 save 升到 storeVersion=2，再用旧 v1 快照 save 必须拒绝
  const v2 = await store.save({ ...v1.taskRun, reason: '更新Reason' });
  assert.equal(v2.ok, true);
  const oldSave = await store.save({ ...v1.taskRun, reason: '旧快照覆盖' });
  assert.equal(oldSave.ok, false);
  assert.equal(oldSave.code, 'stale_write');

  // 终态回退拒绝
  const done = await store.save({
    ...v2.taskRun,
    state: 'completed',
    delivery: { summary: 'done', at: 1_700_000_002_000, revision: 1 },
  });
  assert.equal(done.ok, true);
  const regress = await store.save({ ...done.taskRun, state: 'queued', delivery: null });
  assert.equal(regress.ok, false);
  assert.equal(regress.code, 'terminal_regression');

  // request 身份不可篡改
  const hijack = await store.save({
    ...done.taskRun,
    request: { ...done.taskRun.request, requestId: 'req_other' },
  });
  assert.equal(hijack.ok, false);
  assert.equal(hijack.code, 'identity_mismatch');
});

await test('4. ★ 目录存在损坏记录时 listAll().complete=false，acceptRequest fail-closed 返回 lookup_indeterminate', async () => {
  const store = makeStore();
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'tr_corrupt.json'), '{not json');

  const scan = store.listAll();
  assert.equal(scan.complete, false);
  assert.equal(scan.skipped, 1);

  const res = await store.acceptRequest({
    requesterId: 'u1',
    requestId: 'req_new_on_corrupt',
    fingerprint: 'fp_1',
    build: () => buildRoot('tr_ok_1', 'req_new_on_corrupt'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'lookup_indeterminate');
});

// ---------------------------------------------------------------------------
// 3. 子任务 ↔ 根授权不变量（#assertRootGranted）
// ---------------------------------------------------------------------------

await test('5. ★ 子任务必须在根 attemptSlots 拥有匹配且未结束的授权，缺授权/不匹配/未开始均拒', async () => {
  const store = makeStore();
  const root = buildRoot('tr_r_grant', 'req_rg');
  const savedRoot = await store.save(root);
  assert.equal(savedRoot.ok, true);

  const childBase = buildChild('tr_c_grant', root.id, 'req_cg');
  const savedChild = await store.save(childBase);
  assert.equal(savedChild.ok, true);

  const makeSlot = (phase = ATTEMPT_SLOT.reserved, { botId = 'b1', revision = 1 } = {}) => ({
    [slotKey(childBase.id, 'att_1')]: {
      taskRunId: childBase.id,
      attemptId: 'att_1',
      botId,
      revision,
      phase,
    },
  });

  // (a) 根无授权 → no_root_grant
  const noGrant = await store.mutate(childBase.id, {
    mutate: (cur) => ({ ...cur, attemptSlots: makeSlot(ATTEMPT_SLOT.reserved) }),
  });
  assert.equal(noGrant.ok, false);
  assert.equal(noGrant.code, 'no_root_grant');

  // 在根写一条 botId='b1', revision=1, phase='reserved' 的授权
  await store.mutate(root.id, {
    mutate: (cur) => ({ ...cur, attemptSlots: makeSlot(ATTEMPT_SLOT.reserved, { botId: 'b1', revision: 1 }) }),
  });

  // (b) 执行者不符 → grant_bot_mismatch
  const wrongBot = await store.mutate(childBase.id, {
    mutate: (cur) => ({ ...cur, attemptSlots: makeSlot(ATTEMPT_SLOT.reserved, { botId: 'b_other', revision: 1 }) }),
  });
  assert.equal(wrongBot.ok, false);
  assert.equal(wrongBot.code, 'grant_bot_mismatch');

  // (c) 版本不符 → grant_revision_mismatch
  const wrongRev = await store.mutate(childBase.id, {
    mutate: (cur) => ({ ...cur, attemptSlots: makeSlot(ATTEMPT_SLOT.reserved, { botId: 'b1', revision: 2 }) }),
  });
  assert.equal(wrongRev.ok, false);
  assert.equal(wrongRev.code, 'grant_revision_mismatch');

  // (d) 子已 started 但根仍是 reserved → grant_not_started
  const notStarted = await store.mutate(childBase.id, {
    mutate: (cur) => ({ ...cur, attemptSlots: makeSlot(ATTEMPT_SLOT.started, { botId: 'b1', revision: 1 }) }),
  });
  assert.equal(notStarted.ok, false);
  assert.equal(notStarted.code, 'grant_not_started');

  // (e) 根推进到 started → 子带 started 占位与 registered 账本成功落盘
  await store.mutate(root.id, {
    mutate: (cur) => ({ ...cur, attemptSlots: makeSlot(ATTEMPT_SLOT.started, { botId: 'b1', revision: 1 }) }),
  });
  const okChild = await store.mutate(childBase.id, {
    mutate: (cur) => ({
      ...cur,
      state: 'running',
      attemptSlots: makeSlot(ATTEMPT_SLOT.started, { botId: 'b1', revision: 1 }),
      attempts: [{ attemptId: 'att_1', taskRunId: childBase.id, revision: 1, botId: 'b1', state: 'registered', startedAt: 1_700_000_000_500 }],
    }),
  });
  assert.equal(okChild.ok, true);

  // (f) 根授权已 ended/refunded，再写入新执行占位 → grant_ended
  await store.mutate(root.id, {
    mutate: (cur) => ({
      ...cur,
      attemptSlots: {
        ...cur.attemptSlots,
        [slotKey(childBase.id, 'att_2')]: {
          taskRunId: childBase.id, attemptId: 'att_2', botId: 'b1', revision: 1, phase: ATTEMPT_SLOT.refunded,
        },
      },
    }),
  });
  const ended = await store.mutate(childBase.id, {
    mutate: (cur) => ({
      ...cur,
      attemptSlots: {
        ...cur.attemptSlots,
        [slotKey(childBase.id, 'att_2')]: {
          taskRunId: childBase.id, attemptId: 'att_2', botId: 'b1', revision: 1, phase: ATTEMPT_SLOT.reserved,
        },
      },
    }),
  });
  assert.equal(ended.ok, false);
  assert.equal(ended.code, 'grant_ended');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
