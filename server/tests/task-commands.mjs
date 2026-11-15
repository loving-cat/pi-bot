/**
 * 任务命令服务的幂等测试（W4b 第 1 步）。
 *   node tests/task-commands.mjs
 *
 * ## 为什么这块必须单独测
 *
 * `docs/TASK-RUN-PROTOCOL.md` 写了一套很完整的「命令应用事实」机制：
 *
 *   > 命令信封（commandId/type/ref/decision/text/原 expectedRevision）先写 pending；
 *   > 副作用成功后把 commandId 与领域变更一起写进 TaskRun.appliedCommands，
 *   > 再写 applied 回执。重放只认应用事实：已应用 → 回放不重复；
 *   > 未应用且任务 sequence 已变化 → 不确定拒绝；从未变动才允许重试。
 *
 * 但在这份测试之前，`task-commands.js` 的 **0 条**测试引用（见
 * `docs/taskrun-gaps.md`）。而它管的是「用户点一次继续，会不会执行两次」——
 * 写错就是重复付钱、重复改文件。
 *
 * ## 守的四件事
 *
 * 1. **已应用 → 回放**：同一 commandId 重发不再次产生副作用，且回执带 `replayed`。
 * 2. **同 ID 不同内容 → 409**：不能拿一个 ID 伪装成多条命令。
 * 3. **可能已生效但事实没落盘 → 不确定拒绝**：`sequence` 变了就是证据，
 *    宁可让用户重读也不能重放。
 * 4. **身份不符不能用别人的成功事实**：requesterId 必须一起匹配。
 *
 * 这一层全是磁盘与字符串判定，不需要真 TaskRun 状态机 —— 所以用假 runtime，
 * 只依赖真实的 `createTaskCommands` 与真实的 `taskRuns.mutate`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cmd-'));
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
const { createTaskCommands } = await import(src('tasks/task-commands.js'));
const { config } = await import(src('config.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

/**
 * ★ 每个用例一份独立的命令回执目录。
 *
 * 第一次跑这组测试时踩到了自己：所有用例共用一份目录，于是用例 2 的"首次命令"
 * 撞上了用例 1 写下的同 ID 回执，直接变成回放 —— 断言全红。这本身就说明
 * 幂等机制是生效的（同一 commandId 不会执行两次），但测试必须隔离。
 */
let dirSeq = 0;
const freshDir = () => path.join(config.dataDir, 'task-commands', `case-${++dirSeq}`);

/**
 * 假的任务存储 + 假 runtime。
 *
 * `mutate` 的语义与真的 `task-run-store` 一致：读最新 → 调 mutate → 写回，
 * 返回 `{ok:true, taskRun, changed}`；`next` 为空表示"不用改"（幂等成功）。
 */
function makeHarness({ state = 'running', revision = 1, sequence = 0 } = {}) {
  const runs = new Map();
  const effects = [];
  const seed = {
    id: 'tr_cmd_test',
    revision,
    sequence,
    state,
    flags: {},
    openGates: [],
    appliedCommands: [],
    attempts: [],
    updatedAt: 1,
  };
  runs.set(seed.id, seed);

  const taskRuns = {
    async mutate(taskRunId, { mutate }) {
      const current = runs.get(taskRunId) ?? null;
      const next = await mutate(current, { read: { status: current ? 'found' : 'missing' } });
      if (next === null || next === undefined) return { ok: true, taskRun: current, changed: false };
      runs.set(taskRunId, next);
      return { ok: true, taskRun: next, changed: true };
    },
  };
  /** 每次真正产生副作用就记一笔 —— 这就是"执行了几次"的权威来源。 */
  const runtime = {
    async onPause({ taskRunId }) {
      effects.push('pause');
      // 真的改状态（sequence +1，与真实归约一致）
      await taskRuns.mutate(taskRunId, { mutate: (c) => ({ ...c, state: 'paused_user', sequence: (c.sequence ?? 0) + 1 }) });
      return { ok: true, applied: true };
    },
    async onResume({ taskRunId }) {
      effects.push('resume');
      await taskRuns.mutate(taskRunId, { mutate: (c) => ({ ...c, state: 'running', sequence: (c.sequence ?? 0) + 1 }) });
      return { ok: true, applied: true };
    },
    async onInputProvided({ taskRunId, inputKey }) {
      effects.push(`input:${inputKey}`);
      await taskRuns.mutate(taskRunId, {
        mutate: (c) => ({
          ...c,
          sequence: (c.sequence ?? 0) + 1,
          openGates: (c.openGates ?? []).filter((g) => !(g.kind === 'input' && g.ref === inputKey)),
        }),
      });
      return { ok: true, applied: true };
    },
  };
  const commandDir = freshDir();
  const commands = createTaskCommands({
    store: { getApproval: () => null },
    runner: { taskRuntime: runtime },
    taskRuns,
    commandDir,
  });
  const findRun = (id) => runs.get(id) ?? null;
  /** 调一次命令；`device` 用来验身份。 */
  const call = (body, { deviceId = 'dev_a', taskRunId = 'tr_cmd_test', rev = null } = {}) => commands.handle({
    taskRunId,
    body: { expectedRevision: rev ?? runs.get(taskRunId)?.revision ?? 1, ...body },
    device: { id: deviceId },
    snapshotOf: (run) => (run ? { id: run.id, state: run.state, revision: run.revision, sequence: run.sequence } : null),
    findRun,
  });
  return { taskRuns, runtime, commands, call, runs, effects, seed, commandDir };
}

const CMD = 'cmd_pause_0001';

await test('第一次命令生效，记下应用事实与回执', async () => {
  const h = makeHarness();
  const res = await h.call({ commandId: CMD, type: 'pause' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.applied, true);
  assert.equal(h.effects.length, 1, '副作用应当只发生一次');
  assert.equal(h.runs.get('tr_cmd_test').state, 'paused_user');
  // 应用事实落在 TaskRun 里（重放只认它）
  const facts = h.runs.get('tr_cmd_test').appliedCommands ?? [];
  assert.equal(facts.length, 1);
  assert.equal(facts[0].commandId, CMD);
  assert.equal(facts[0].requesterId, 'dev_a');
});

await test('★ 同一命令重发 → 回放，不再产生副作用', async () => {
  const h = makeHarness();
  await h.call({ commandId: CMD, type: 'pause' });
  const again = await h.call({ commandId: CMD, type: 'pause' });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true, '第二次必须是回放');
  assert.equal(h.effects.length, 1, '★ 回放不许再执行一次（这是"点一次执行两次"的防线）');
});

await test('★ 同 commandId 不同内容 → 409 冲突（不能拿一个 ID 伪装多条命令）', async () => {
  const h = makeHarness();
  await h.call({ commandId: CMD, type: 'pause' });
  const conflict = await h.call({ commandId: CMD, type: 'resume' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'COMMAND_CONFLICT');
  assert.equal(h.effects.length, 1, '冲突时也不许产生副作用');
});

await test('缺 commandId / 未知类型 / 缺 revision 都是 400（不是 500）', async () => {
  const h = makeHarness();
  const noId = await h.call({ type: 'pause' });
  assert.equal(noId.status, 400);
  assert.equal(noId.body.code, 'BAD_COMMAND_ID');
  const badType = await h.call({ commandId: 'cmd_xxxxxxxx', type: 'teleport' });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.code, 'BAD_COMMAND_TYPE');
  const noRev = await h.commands.handle({
    taskRunId: 'tr_cmd_test',
    body: { commandId: 'cmd_yyyyyy', type: 'pause' },
    device: { id: 'dev_a' },
    snapshotOf: () => null,
    findRun: () => null,
  });
  assert.equal(noRev.status, 400);
  assert.equal(noRev.body.code, 'BAD_REVISION');
});

await test('版本过期 → 409 STALE_REVISION（命令针对的是旧目标版本）', async () => {
  const h = makeHarness({ revision: 3 });
  const res = await h.call({ commandId: 'cmd_stale_001', type: 'pause' }, { rev: 2 });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'STALE_REVISION');
  assert.equal(h.effects.length, 0);
});

await test('任务不存在 → 404（不是"不确定"）', async () => {
  const h = makeHarness();
  const res = await h.call({ commandId: 'cmd_missing1', type: 'pause' }, { deviceId: 'dev_a', taskRunId: 'tr_nope' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'TASK_RUN_NOT_FOUND');
});

await test('runtime 没启用 → 503（不假装成功）', async () => {
  const h = makeHarness();
  const cmds = createTaskCommands({
    store: { getApproval: () => null },
    runner: { taskRuntime: null },
    taskRuns: h.taskRuns,
    commandDir: path.join(fixture, 'cmds-off'),
  });
  const res = await cmds.handle({
    taskRunId: 'tr_cmd_test',
    body: { commandId: 'cmd_off_0001', type: 'pause', expectedRevision: 1 },
    device: { id: 'dev_a' },
    snapshotOf: () => null,
    findRun: (id) => h.runs.get(id) ?? null,
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'TASK_RUNTIME_OFF');
});

await test('★ 可能已生效但事实没落盘（sequence 变了）→ 拒绝重放', async () => {
  const h = makeHarness();
  await h.call({ commandId: 'cmd_after_001', type: 'pause' });
  // 手工把应用事实抹掉，模拟"副作用成功但 App 事实写失败"那种半截状态。
  // 这时回执是 applied，但 TaskRun 里的 appliedCommands 没了。
  await h.taskRuns.mutate('tr_cmd_test', {
    mutate: (c) => ({ ...c, appliedCommands: [], sequence: (c.sequence ?? 0) + 1 }),
  });
  // 把回执也退回到 pending（模拟回执写失败后重写的是 pending）
  const file = path.join(h.commandDir, Buffer.from('dev_a::cmd_after_001').toString('base64url') + '.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.command.stage = 'pending';
  record.command.beforeSequence = 0; // 执行前是 0
  record.command.result = null;
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  const res = await h.call({ commandId: 'cmd_after_001', type: 'pause' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'COMMAND_INDETERMINATE');
  assert.equal(h.effects.length, 1, '★ 不确定时绝不能重放副作用');
});

await test('★ 未生效且任务从未变动 → 允许重试（这是"重试一次就好"的合法情况）', async () => {
  const h = makeHarness();
  // 先造一条 pending（模拟上次执行中途进程被杀，副作用没发生）
  const cmds = createTaskCommands({
    store: { getApproval: () => null },
    runner: { taskRuntime: { onPause: async () => ({ ok: false, code: 'boom' }) } },
    taskRuns: h.taskRuns,
    commandDir: path.join(fixture, 'cmds-retry'),
  });
  const pendingDir = path.join(fixture, 'cmds-retry');
  const args = {
    taskRunId: 'tr_cmd_test',
    body: { commandId: 'cmd_retry_001', type: 'pause', expectedRevision: 1 },
    device: { id: 'dev_a' },
    snapshotOf: (run) => (run ? { id: run.id, sequence: run.sequence } : null),
    findRun: (id) => h.runs.get(id) ?? null,
  };
  const failed = await cmds.handle(args);
  assert.equal(failed.status, 500, 'runtime 返回 not ok 且没生效 → 不许报成功');
  // 回执应为 failed，且 beforeSequence 记录了执行前序号
  const file = path.join(pendingDir, Buffer.from('dev_a::cmd_retry_001').toString('base64url') + '.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.command.stage, 'failed');
  assert.equal(rec.command.beforeSequence, 0);
  // 任务没变动 → 用真 runtime 重试应当成功
  const ok = createTaskCommands({
    store: { getApproval: () => null },
    runner: {
      taskRuntime: {
        onPause: async ({ taskRunId }) => {
          await h.taskRuns.mutate(taskRunId, { mutate: (c) => ({ ...c, state: 'paused_user', sequence: (c.sequence ?? 0) + 1 }) });
          return { ok: true, applied: true };
        },
      },
    },
    taskRuns: h.taskRuns,
    commandDir: pendingDir,
  });
  const retried = await ok.handle({ ...args, body: { ...args.body } });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(h.runs.get('tr_cmd_test').state, 'paused_user');
});

await test('★ 命令身份是 requesterId + commandId：两台设备撞同一个 ID 不该互相吞掉', async () => {
  // 协议的「统一请求身份（R6）」原话：规范键是认证 requesterId + requestId，
  // **A/B 同 ID 是两条独立请求**。所以：
  //   · 不能把 B 的命令当成 A 的回放答掉（那会把用户的操作悄悄吞了）；
  //   · 也不能让 B 复用 A 的应用事实（那是两件不同的操作）。
  //
  // 这条用例一开始被写成了"B 不许执行" —— 那是错的期望，被测试自己抓出来。
  const h = makeHarness();
  const a = await h.call({ commandId: 'cmd_shared_01', type: 'pause' }, { deviceId: 'dev_a' });
  assert.equal(a.status, 200);
  assert.equal(a.body.replayed, undefined);
  const b = await h.call({ commandId: 'cmd_shared_01', type: 'pause' }, { deviceId: 'dev_b' });
  assert.notEqual(b.body.replayed, true, 'B 不能被当成 A 的回放');
  // 各自都有自己的回执（不同键），A 的回执不会因为 B 而被改写
  const fileA = path.join(h.commandDir, Buffer.from('dev_a::cmd_shared_01').toString('base64url') + '.json');
  const fileB = path.join(h.commandDir, Buffer.from('dev_b::cmd_shared_01').toString('base64url') + '.json');
  assert.equal(fs.existsSync(fileA), true);
  assert.equal(fs.existsSync(fileB), true);
  const recA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  const recB = JSON.parse(fs.readFileSync(fileB, 'utf8'));
  assert.equal(recA.command.requesterId, 'dev_a');
  assert.equal(recB.command.requesterId, 'dev_b');
  // 但**应用事实**是按 commandId+requesterId+fingerprint 三者匹配的，
  // 所以 A 的事实不能被 B 用来跳过执行。
  const facts = h.runs.get('tr_cmd_test').appliedCommands ?? [];
  assert.equal(facts.filter((f) => f.requesterId === 'dev_a').length, 1);
  assert.equal(facts.filter((f) => f.requesterId === 'dev_b').length, 1);
});

await test('坏回执 → 明确失败，不当新命令', async () => {
  const h = makeHarness();
  fs.mkdirSync(h.commandDir, { recursive: true });
  const file = path.join(h.commandDir, Buffer.from('dev_a::cmd_badrec_1').toString('base64url') + '.json');
  fs.writeFileSync(file, '{ 这不是 JSON');
  const res = await h.call({ commandId: 'cmd_badrec_1', type: 'pause' });
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'command_bad_json');
  assert.equal(h.effects.length, 0, '坏回执不能顺手执行一次');
});

await test('回执身份被篡改 → corrupt（不认别人的回执）', async () => {
  const h = makeHarness();
  fs.mkdirSync(h.commandDir, { recursive: true });
  const file = path.join(h.commandDir, Buffer.from('dev_a::cmd_tamper1').toString('base64url') + '.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    command: { requesterId: 'dev_other', commandId: 'cmd_tamper1', stage: 'applied', result: { ok: true } },
  }));
  const res = await h.call({ commandId: 'cmd_tamper1', type: 'pause' });
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'command_identity_mismatch');
});

await test('applied 回执缺 result → 不算成功，也不重复执行', async () => {
  // 先正常跑一次拿到正确的 fingerprint，再把回执的 result 抹掉
  const h2 = makeHarness();
  const first = await h2.call({ commandId: 'cmd_noresult2', type: 'pause' });
  assert.equal(first.status, 200);
  const f2 = path.join(h2.commandDir, Buffer.from('dev_a::cmd_noresult2').toString('base64url') + '.json');
  const rec2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
  rec2.command.result = null;
  fs.writeFileSync(f2, JSON.stringify(rec2, null, 2));
  const res = await h2.call({ commandId: 'cmd_noresult2', type: 'pause' });
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'COMMAND_RECORD_INVALID');
  assert.equal(h2.effects.length, 1, '回执坏了也不能再执行一次');
});

await test('输入命令：ref 必须匹配当前门槛（否则不给副作用）', async () => {
  const h = makeHarness();
  await h.taskRuns.mutate('tr_cmd_test', {
    mutate: (c) => ({ ...c, openGates: [{ kind: 'input', ref: 'q1' }] }),
  });
  const mismatch = await h.call({ commandId: 'cmd_input_001', type: 'input', ref: 'q2', text: '答案' });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'INPUT_SCOPE_MISMATCH');
  assert.equal(h.effects.length, 0, '门槛不匹配时不许产生副作用');
  const ok = await h.call({ commandId: 'cmd_input_002', type: 'input', ref: 'q1', text: '答案' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(h.effects, ['input:q1']);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
