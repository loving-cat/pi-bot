/**
 * 运行数据保留策略（纯函数）的边界测试。
 *   node tests/storage-retention.mjs
 *
 * ## 这个文件守什么
 *
 * "哪些可以删"是整条清理链路上唯一有判断的地方，所以每个 red line 都要有反例：
 *   · TaskRun **按整棵根树**裁决：树里有一个还在跑，整棵都不能选；
 *   · 终态树按 TTL 与**数量上限**双重裁剪，上限按最老的裁；
 *   · `running` / `received` 回执、以及仍指向活任务的回执永远不选；
 *   · 在跑 bot 的实例目录永远不选；
 *   · 仍被引用的附件、已有墓碑的附件、未到 TTL 的附件都不选。
 */
import assert from 'node:assert/strict';

import {
  STORAGE_RETENTION_DEFAULTS,
  TERMINAL_TASK_STATES,
  isTerminalTaskRun,
  taskRunRootId,
  taskRunStamp,
  selectExpiredTaskRunTrees,
  requestReceiptStamp,
  selectExpiredRequestReceipts,
  selectExpiredTmpEntries,
  selectOrphanUploads,
} from '../src/storage-retention.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const run = (id, state, extra = {}) => ({ id, state, ...extra });

// ---------------------------------------------------------------------------
// 1. 阈值与基础判定
// ---------------------------------------------------------------------------
test('默认阈值是冻结的常量（别处不许再写魔法数字）', () => {
  assert.equal(Object.isFrozen(STORAGE_RETENTION_DEFAULTS), true);
  assert.equal(STORAGE_RETENTION_DEFAULTS.instanceTmpTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(STORAGE_RETENTION_DEFAULTS.requestReceiptTtlMs, 14 * DAY);
  assert.equal(STORAGE_RETENTION_DEFAULTS.taskRunTtlMs, 30 * DAY);
  assert.equal(STORAGE_RETENTION_DEFAULTS.taskRunMaxTerminal, 500);
  assert.equal(STORAGE_RETENTION_DEFAULTS.orphanUploadTtlMs, 30 * DAY);
});

test('终态只有 completed / cancelled；未知状态一律**不算**终态（fail-closed）', () => {
  assert.deepEqual([...TERMINAL_TASK_STATES], ['completed', 'cancelled']);
  assert.equal(isTerminalTaskRun({ state: 'completed' }), true);
  assert.equal(isTerminalTaskRun({ state: 'cancelled' }), true);
  for (const state of ['queued', 'running', 'verifying', 'waiting_approval', 'waiting_input',
    'waiting_dependency', 'paused_budget', 'paused_user', 'blocked', 'weird', '', undefined]) {
    assert.equal(isTerminalTaskRun({ state }), false, `${String(state)} 不该算终态`);
  }
});

test('根 id / 时间戳的取值规则', () => {
  assert.equal(taskRunRootId({ id: 'a' }), 'a');
  assert.equal(taskRunRootId({ id: 'a', rootTaskId: 'root' }), 'root');
  assert.equal(taskRunStamp({ finishedAt: 5, updatedAt: 9 }), 5, '完工时间优先');
  assert.equal(taskRunStamp({ updatedAt: 9, createdAt: 3 }), 9);
  assert.equal(taskRunStamp({ createdAt: 3 }), 3);
  assert.equal(taskRunStamp({}), 0);
});

// ---------------------------------------------------------------------------
// 2. TaskRun 整树裁剪
// ---------------------------------------------------------------------------
test('整棵根树免疫：树里只要有一个非终态节点，一个文件都不选', () => {
  const runs = [
    run('root1', 'completed', { finishedAt: NOW - 400 * DAY }),
    run('child1', 'running', { rootTaskId: 'root1' }),
    run('child2', 'completed', { rootTaskId: 'root1', finishedAt: NOW - 400 * DAY }),
    run('solo', 'completed', { finishedAt: NOW - 400 * DAY }),
  ];
  const picked = selectExpiredTaskRunTrees(runs, { now: NOW });
  assert.deepEqual(picked.taskRunIds, ['solo'], '有活着的子任务 → 整棵树都不能删');
  assert.deepEqual(picked.rootIds, ['solo']);
});

test('终态树按 TTL 裁：只有最老时间戳超期才选（子树比根新也不影响整树）', () => {
  const runs = [
    run('old-root', 'completed', { finishedAt: NOW - 40 * DAY }),
    run('old-child', 'cancelled', { rootTaskId: 'old-root', finishedAt: NOW - 1 * DAY }),
    run('fresh-root', 'completed', { finishedAt: NOW - 1 * DAY }),
  ];
  const picked = selectExpiredTaskRunTrees(runs, { now: NOW });
  assert.deepEqual(picked.taskRunIds.sort(), ['old-child', 'old-root']);
  assert.equal(picked.expiredRoots, 1);
  assert.equal(picked.overflowRoots, 0);
});

test('数量上限按"最老"裁：超过 maxTerminal 时先删最老的终态树', () => {
  const runs = [];
  for (let i = 0; i < 6; i += 1) {
    runs.push(run(`t${i}`, 'completed', { finishedAt: NOW - (100 - i) * DAY }));
  }
  // TTL 足够大 → 不触发 TTL 分支，只剩数量上限
  const picked = selectExpiredTaskRunTrees(runs, { now: NOW, ttlMs: 10_000 * DAY, maxTerminal: 4 });
  assert.deepEqual(picked.rootIds, ['t0', 't1'], 't0/t1 最老，先删');
  assert.equal(picked.overflowRoots, 2);
  assert.equal(picked.expiredRoots, 0);
});

test('TTL 与上限同时生效时取并集；时间戳缺失的终态树排最前但仍受上限保护', () => {
  const runs = [
    run('no-stamp', 'completed'), // stamp = 0
    run('old', 'completed', { finishedAt: NOW - 100 * DAY }),
    run('mid', 'completed', { finishedAt: NOW - 20 * DAY }),
    run('new', 'completed', { finishedAt: NOW - 1 * DAY }),
  ];
  const picked = selectExpiredTaskRunTrees(runs, { now: NOW, ttlMs: 30 * DAY, maxTerminal: 3 });
  assert.deepEqual(picked.rootIds, ['no-stamp', 'old'], 'no-stamp 排最前，old 超 TTL');
  // maxTerminal=3 → 剩下的 mid/new 两棵不超过上限，不该被裁
  assert.equal(picked.taskRunIds.length, 2);
});

test('空输入 / 垃圾输入不抛（清理工具不能因为脏数据崩）', () => {
  assert.deepEqual(selectExpiredTaskRunTrees([], { now: NOW }), {
    rootIds: [], taskRunIds: [], expiredRoots: 0, overflowRoots: 0,
  });
  assert.deepEqual(selectExpiredTaskRunTrees(null, { now: NOW }).taskRunIds, []);
  const weird = selectExpiredTaskRunTrees([{ }, { id: '' }, null], { now: NOW });
  assert.deepEqual(weird.taskRunIds, []);
});

// ---------------------------------------------------------------------------
// 3. 接单回执
// ---------------------------------------------------------------------------
test('received / running 阶段的回执永远不选（删了等于让同一请求重跑）', () => {
  const old = NOW - 60 * DAY;
  const receipts = [
    { name: 'a.json', stage: 'received', at: old },
    { name: 'b.json', stage: 'running', startedAt: old },
    { name: 'c.json', stage: 'accepted', at: old, taskRunId: 'run-done' },
  ];
  const picked = selectExpiredRequestReceipts(receipts, { now: NOW });
  assert.deepEqual(picked.map((r) => r.name), ['c.json']);
});

test('仍指向活任务的回执不选（宿主靠它找回任务）', () => {
  const old = NOW - 60 * DAY;
  const receipts = [
    { name: 'live.json', stage: 'accepted', at: old, taskRunId: 'run-live' },
    { name: 'dead.json', stage: 'accepted', at: old, taskRunId: 'run-done' },
    { name: 'answered.json', stage: 'answered', finishedAt: old },
    { name: 'failed.json', stage: 'failed', finishedAt: old },
  ];
  const picked = selectExpiredRequestReceipts(receipts, {
    now: NOW,
    activeTaskRunIds: new Set(['run-live']),
  });
  assert.deepEqual(picked.map((r) => r.name).sort(), ['answered.json', 'dead.json', 'failed.json']);
});

test('未到 TTL / 没有时间戳的回执不选；`requestReceiptStamp` 完工优先', () => {
  assert.equal(requestReceiptStamp({ finishedAt: 5, at: 9 }), 5);
  assert.equal(requestReceiptStamp({ at: 9 }), 9);
  assert.equal(requestReceiptStamp({}), 0);
  const picked = selectExpiredRequestReceipts(
    [
      { name: 'young.json', stage: 'accepted', at: NOW - 1 * DAY },
      { name: 'stamp-less.json', stage: 'accepted' },
    ],
    { now: NOW, ttlMs: 14 * DAY },
  );
  assert.deepEqual(picked, []);
});

// ---------------------------------------------------------------------------
// 4. 实例临时目录
// ---------------------------------------------------------------------------
test('在跑 bot 的实例目录永远不选；其余按 mtime 越过 TTL 才选', () => {
  const entries = [
    { name: 'bot_busy', mtimeMs: NOW - 100 * DAY },
    { name: 'bot_old', mtimeMs: NOW - 2 * DAY },
    { name: 'bot_new', mtimeMs: NOW - 1 * 60 * 1000 },
    { name: 'no_mtime' },
  ];
  const picked = selectExpiredTmpEntries(entries, {
    now: NOW,
    busyBotKeys: new Set(['bot_busy']),
  });
  assert.deepEqual(picked.map((e) => e.name), ['bot_old']);
});

test('实例目录：busy 集合支持数组；TTL 可覆盖', () => {
  const entries = [{ name: 'a', mtimeMs: NOW - 10_000 }, { name: 'b', mtimeMs: NOW - 10_000 }];
  assert.deepEqual(
    selectExpiredTmpEntries(entries, { now: NOW, busyBotKeys: ['a'], ttlMs: 1_000 }).map((e) => e.name),
    ['b'],
  );
  assert.deepEqual(selectExpiredTmpEntries(entries, { now: NOW, ttlMs: 1_000_000 }), []);
});

// ---------------------------------------------------------------------------
// 5. 孤儿附件
// ---------------------------------------------------------------------------
test('孤儿附件：被引用 / 已墓碑 / 未到 TTL 都不选', () => {
  const uploads = [
    { id: 'used', createdAt: NOW - 100 * DAY },
    { id: 'tomb', createdAt: NOW - 100 * DAY, deletedAt: NOW - 99 * DAY },
    { id: 'young', createdAt: NOW - 1 * DAY },
    { id: 'orphan', createdAt: NOW - 40 * DAY },
    { id: 'no-stamp' },
  ];
  const picked = selectOrphanUploads(uploads, {
    now: NOW,
    referencedIds: new Set(['used']),
  });
  assert.deepEqual(picked.map((u) => u.id), ['orphan']);
  assert.equal(picked[0].size, undefined, '选择函数不改输入、也不编字段');
});

test('孤儿附件：referencedIds 支持数组；返回原对象（调用方要拿 size）', () => {
  const orphan = { id: 'orphan', createdAt: NOW - 40 * DAY, size: 1234 };
  const picked = selectOrphanUploads(
    [orphan, { id: 'kept', createdAt: NOW - 40 * DAY, size: 1 }],
    { now: NOW, referencedIds: ['kept'] },
  );
  assert.equal(picked.length, 1);
  assert.equal(picked[0], orphan, '原样返回，执行层要用 size 统计');
  assert.equal(selectOrphanUploads([orphan], { now: NOW, ttlMs: 365 * DAY }).length, 0);
});

console.log(`\nstorage-retention: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
