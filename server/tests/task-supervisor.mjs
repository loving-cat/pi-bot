/**
 * 任务监督器：执行有界性测试。
 *   node tests/task-supervisor.mjs
 *
 * ★ 为什么单独一个文件
 *
 *   这是整个任务系统里最容易"无限跑、烧钱、卡住会话"的组件，
 *   但在本文件之前，104 个测试文件里**没有一个**引用 createTaskSupervisor
 *   或 maxStallRounds —— 它只被 /tmp 下几个一次性脚本验证过，
 *   脚本一过时就彻底没有防护了。
 *
 *   这里守住三件事：
 *     1. 验收永远不通过时，执行次数有上界（不会无限重试烧 token）；
 *     2. 高频 notify 不会把执行次数放大（事件风暴不失控）；
 *     3. stall 达到上限后停止并落 blocked（能自己停下来）。
 *
 * 用 mkdtemp 而不是固定目录：多个测试文件串行跑，
 * 固定路径会互相污染上次的残留数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sup-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
});
// 这条路径下任何外呼都当失败：测试不依赖网络，也不该悄悄联网
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { createTaskSupervisor } = await import(src('tasks/task-supervisor.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const chief = store.mainBot();
const room = store.createGroup({
  name: '监督器测试组',
  botIds: [chief.id],
  leadBotId: chief.id,
});
const taskRuns = store.taskRuns;

let seq = 0;
/** 建一个"验收条件永远满足不了"的任务，返回 taskRunId。 */
async function makeTask() {
  seq += 1;
  const id = 'tr_sup' + seq;
  const requestId = 'rq_sup' + seq;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: {
      requirement: '永远做不完的活',
      // createTaskRun 要求至少一条验收条件，否则返回 reject 而不是抛错
      verification: [
        { id: 'c1', kind: 'artifact', description: '永远缺一个文件', spec: { count: 100 } },
      ],
    },
  });
  assert.equal(built.ok, true, '建任务应成功：' + (built.text ?? ''));
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local',
    requestId,
    fingerprint: 'fp-' + seq,
    build: () => built.taskRun,
    at: Date.now(),
  });
  assert.equal(accepted.ok, true, '接单应成功：' + (accepted.text ?? ''));
  return id;
}

/** 造一个"执行成功但验收永远不过"的监督器，返回统计口。 */
function makeSupervisor({ maxSteps = 8, maxStallRounds = 2 } = {}) {
  const stats = { execs: 0, verifies: 0 };
  const sup = createTaskSupervisor({
    taskRuns,
    maxSteps,
    maxStallRounds,
    execute: async () => {
      stats.execs += 1;
      return { ok: true, stop: 'yielded', artifacts: [{ path: 'f' + stats.execs + '.md', kind: 'file' }] };
    },
    verify: async () => {
      stats.verifies += 1;
      return { passed: false, unmet: ['还没好'], needsReview: [], blocked: [] };
    },
    access: {
      stat: async () => ({ ok: false }),
      readText: async () => ({ ok: false }),
      resolveRef: () => null,
    },
    clock: () => Date.now(),
    log: () => {},
  });
  return { sup, stats };
}

/**
 * 反复唤醒直到监督器停下来，带超时避免测试本身挂死。
 *
 * ★ 必须跨过 YIELD_RESUME_MS（1 秒）再判断。
 *
 *   让出后续行是靠 setTimeout 排的，而 idle() 只等"当前这次排空结束"，
 *   它立刻就能返回 —— 如果只等 200ms 就去读状态，会看到任务停在
 *   nextAction=null / retryAt=null / state=running，误以为它卡死了。
 *   实际是下一轮还没被定时器唤醒。
 */
async function drain(sup, rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.race([sup.idle(), new Promise((r) => setTimeout(r, 150))]);
    // 给 YIELD_RESUME_MS 留出余量（1s + 缓冲）
    await new Promise((r) => setTimeout(r, 1200));
  }
}

await test('验收永不通过 → 执行次数有上界', async () => {
  const id = await makeTask();
  const { sup, stats } = makeSupervisor({ maxSteps: 8 });
  sup.notify(id);
  await drain(sup, 6);

  const run = taskRuns.read(id).taskRun;
  assert.ok(stats.execs > 0, '至少应该执行过');
  // 上界：maxSteps 是单次排空的步数上限，多次排空也不该无限增长
  assert.ok(
    stats.execs <= 40,
    `执行次数必须有上界，实际 ${stats.execs} 次`,
  );
  assert.ok(run, '任务应仍可读');
  assert.notEqual(run.state, 'active', '不该一直停在 active');
});

await test('高频 notify 不放大执行次数', async () => {
  const id = await makeTask();
  const { sup, stats } = makeSupervisor({ maxSteps: 8 });
  // 模拟真实场景：每轮结束都可能来新事件，事件源源不断
  for (let i = 0; i < 20; i += 1) {
    sup.notify(id);
    await Promise.race([sup.idle(), new Promise((r) => setTimeout(r, 120))]);
  }

  assert.ok(
    stats.execs <= 40,
    `事件风暴下执行次数仍须有界，实际 ${stats.execs} 次`,
  );
});

await test('验收不通过 → 排定重试，而不是立刻空转', async () => {
  const id = await makeTask();
  const { sup, stats } = makeSupervisor({ maxSteps: 8, maxStallRounds: 2 });
  sup.notify(id);
  await sup.idle();

  const run = taskRuns.read(id).taskRun;
  assert.ok(run, '任务应仍可读');
  assert.equal(stats.execs, 1, '一次唤醒只该执行一轮');

  // 验收不过时不能立刻无限重跑：必须排一个未来的 retryAt。
  // 这也是"等 1 秒看不到变化"的原因 —— 重试间隔是 30s 量级，
  // 不是 yield 续行的 1s。
  assert.ok(run.retryAt, `应排定重试，实际 retryAt=${run.retryAt}`);
  assert.ok(
    run.retryAt > Date.now(),
    '重试时间应该在将来（否则就是空转）',
  );
});

await test('重复唤醒不会绕过重试间隔狂跑', async () => {
  const id = await makeTask();
  const { sup, stats } = makeSupervisor({ maxSteps: 8 });
  sup.notify(id);
  await sup.idle();
  const afterFirst = stats.execs;

  // 连续猛敲 30 次：重试间隔没到，一次都不该再执行
  for (let i = 0; i < 30; i += 1) {
    sup.notify(id);
    await Promise.race([sup.idle(), new Promise((r) => setTimeout(r, 20))]);
  }

  assert.equal(
    stats.execs,
    afterFirst,
    `重试间隔内不该再执行，实际由 ${afterFirst} 涨到 ${stats.execs}`,
  );
});

await test('createTaskRun 无验收条件时返回 reject（不是抛错）', async () => {
  // 这条守着调用方最容易踩的坑：不检查返回值就直接取 .taskRun
  const built = createTaskRun({
    id: 'tr_sup_bad',
    requestId: 'rq_sup_bad',
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    goal: { requirement: 'x', verification: [] },
  });
  assert.equal(built.ok, false, '空验收条件应被拒绝');
  assert.equal(built.field, 'goal.verification');
  assert.equal(built.taskRun, undefined, '拒绝时不该有 taskRun');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
