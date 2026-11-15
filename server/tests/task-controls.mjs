/**
 * 任务控制的测试（W4b 第 5 步）：撤销不续命、早到事实、重复消费。
 *   node tests/task-controls.mjs
 *
 * ## 为什么这块必须单独测
 *
 * `task-controls.js` 管三件事，每件写错都是安全问题或数据事故：
 *
 * 1. **控制事实的匹配**：审批/输入必须「引用相同且版本相同」才能解除门槛。
 *    写松了 = 拿旧批准的 ID 就能放行新动作（规格 §6.1「不能复用旧批准」）。
 * 2. **重复到达只消费一次**：同一条批准不能解两次门槛。
 * 3. **取消只影响本任务及其子任务**，不动同房间其他任务 —— 写宽了就是
 *    "点一下取消，别人干的活全没了"。
 *
 * 之前的测试情况：`task-controls.js` 407 行，**零引用**（见 `docs/taskrun-gaps.md`）。
 *
 * ## 守什么
 *
 * - 决定只认封闭集合：`denied/rejected/deny` → rejected，`granted/approved/allow` → granted，
 *   其余（含 `pending`、拼写错误、空）**一律不许当成批准**
 * - 事实的身份是 `{type, ref, revision}`：ref 或 revision 变一个就不匹配
 * - 已消费的事实不会再消费一次
 * - 取消会级联到子任务，但不会碰同房间的兄弟任务
 * - 取消之后旧的后台句柄（pendingDispatch）被标记为 cancelled，不能续接
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-controls-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const C = await import(src('tasks/task-controls.js'));
const { STATE } = await import(src('tasks/task-contract.js'));

const {
  CONTROL, normalizeDecision, controlFactOf, isConsumed, withFact, markConsumed,
  matchGate, cancelTask, descendants,
} = C;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const T = 1_700_000_000_000;

/** 一个带审批门槛的任务。 */
function runWithGate({ ref = 'ap_1', revision = 1, state = STATE.waiting_approval, extra = {} } = {}) {
  return {
    id: 'tr_1',
    revision,
    state,
    openGates: [{ kind: 'approval', ref, describe: '要批准', openedAt: T }],
    controlFacts: [],
    pendingDispatch: [],
    ...extra,
  };
}

// ---------------------------------------------------------------- 决定归一化
await test('★★ 决定只认封闭集合：拼错的、pending、空串都不许当成批准', () => {
  assert.equal(normalizeDecision(CONTROL.approvalGranted, 'granted'), 'granted');
  assert.equal(normalizeDecision(CONTROL.approvalGranted, 'approved'), 'granted');
  assert.equal(normalizeDecision(CONTROL.approvalGranted, 'allow'), 'granted');
  assert.equal(normalizeDecision(CONTROL.approvalRejected, 'denied'), 'rejected');
  // ★ 注意：允许集里是 'rejected'，不是 'reject'。
  //   'reject' 落进 unknown —— 方向是保守的（不猜成批准），所以不算 bug；
  //   这条断言就是把这个边界写下来，免得有人"顺手补一个同义词"时以为在修 bug。
  assert.equal(normalizeDecision(CONTROL.approvalRejected, 'reject'), 'unknown');
  assert.equal(normalizeDecision(CONTROL.approvalRejected, 'deny'), 'rejected');
  // ★ 这几个是关键：不能因为"看起来像同意"就变成 granted
  for (const bad of ['pending', 'aprove', 'ok?', 'yes please', '同意', '1']) {
    assert.equal(normalizeDecision(CONTROL.approvalGranted, bad), 'unknown', `${bad} 不许当成批准`);
    assert.equal(normalizeDecision(CONTROL.approvalRejected, bad), 'unknown', `${bad} 不许当成拒绝`);
  }
  // ★ 没给 decision 时的方向：**回落到类型**（approval_granted → granted）。
  //
  //   这是刻意的：命令入口 `task-commands.js` 已经先校验过
  //   「decision 必须明确」（否则 400 BAD_DECISION），能走到这里
  //   说明"用户点了那个按钮"本身就是决定；类型就是选择。
  //   所以这里不是 bug —— 但它意味着**入口那道校验不能去掉**，
  //   否则"客户端漏传字段"会变成"默认批准"。这条断言就是钉住这个依赖。
  assert.equal(normalizeDecision(CONTROL.approvalGranted, ''), 'granted');
  assert.equal(normalizeDecision(CONTROL.approvalRejected, ''), 'rejected');
  assert.equal(normalizeDecision(CONTROL.approvalGranted, undefined), 'granted');
  // 类型本身不代表决定时（input_provided）没有回落，只能是 unknown
  assert.equal(normalizeDecision(CONTROL.inputProvided, ''), 'unknown');
  // 而"给了但不认识"的值一律 unknown —— 这一条不受回落影响
  assert.equal(normalizeDecision(CONTROL.approvalGranted, 'pending'), 'unknown');
});

// ---------------------------------------------------------------- 事实身份
await test('★ 事实的身份是 {type, ref, revision}：改任何一个都不再是同一件事实', () => {
  const run = runWithGate();
  const fact = controlFactOf({ type: CONTROL.approvalGranted, approvalId: 'ap_1', revision: 1 }, run, T);
  assert.equal(fact.ref, 'ap_1');
  assert.equal(fact.revision, 1);
  // ref 不同 → 不匹配
  const otherRef = { ...fact, ref: 'ap_2' };
  assert.notDeepEqual([otherRef.type, otherRef.ref, otherRef.revision], [fact.type, fact.ref, fact.revision]);
  // revision 不同 → 不匹配（这是"不能复用旧批准"的落点）
  const otherRev = { ...fact, revision: 2 };
  assert.notDeepEqual([otherRev.type, otherRev.ref, otherRev.revision], [fact.type, fact.ref, fact.revision]);
});

await test('★★ 旧版本的批准匹配不上新版本的门槛（规格 §6.1）', () => {
  // 门槛在第 2 版，但事实报的是第 1 版
  const run = runWithGate({ ref: 'ap_1', revision: 2 });
  const oldFact = { type: CONTROL.approvalGranted, decision: 'granted', ref: 'ap_1', revision: 1, at: T };
  const m = matchGate(run, oldFact);
  assert.equal(m.ok, false, '★ 旧版本的批准不许解开新版本的门槛');
  assert.equal(m.code, 'stale_revision');
  // 同版本同引用才放行
  const good = matchGate(run, { ...oldFact, revision: 2 });
  assert.equal(good.ok, true);
  assert.equal(good.gate?.ref, 'ap_1');
});

await test('错引用的批准匹配不上（不能拿别的审批 ID 放行）', () => {
  const run = runWithGate({ ref: 'ap_1' });
  const m = matchGate(run, { type: CONTROL.approvalGranted, decision: 'granted', ref: 'ap_OTHER', revision: 1, at: T });
  assert.equal(m.ok, false);
  assert.equal(m.code, 'gate_mismatch');
});

await test('没有门槛时匹配返回 gate:null（不是"不匹配"）', () => {
  const run = { ...runWithGate(), openGates: [] };
  const m = matchGate(run, { type: CONTROL.approvalGranted, ref: 'ap_1', revision: 1, at: T });
  assert.equal(m.ok, true);
  assert.equal(m.gate, null);
});

// ---------------------------------------------------------------- 重复消费
await test('★★ 已消费的事实不会再消费一次（点了两次批准只解一次门槛）', () => {
  const run = runWithGate();
  const fact = controlFactOf({ type: CONTROL.approvalGranted, approvalId: 'ap_1', revision: 1 }, run, T);
  assert.equal(isConsumed(run, fact), false, '还没消费');
  const consumed = { ...run, controlFacts: markConsumed(run, fact) };
  assert.equal(isConsumed(consumed, fact), true, '消费之后必须认得出来');
  // 引用一样、版本一样 → 认作同一条（重复到达）
  assert.equal(isConsumed(consumed, { ...fact, at: T + 5000 }), true, '时间不同也还是同一条事实');
  // 版本不同 → 那是另一条事实
  assert.equal(isConsumed(consumed, { ...fact, revision: 2 }), false);
});

await test('withFact 去重而不是无限追加（facts 数组不会爆）', () => {
  let run = runWithGate();
  const fact = controlFactOf({ type: CONTROL.approvalGranted, approvalId: 'ap_1', revision: 1 }, run, T);
  for (let i = 0; i < 5; i += 1) {
    run = { ...run, controlFacts: withFact(run, fact) };
  }
  assert.equal(run.controlFacts.length, 1, '同一件事只在数组里占一格');
  // 不同的 ref 会新增
  const other = { ...fact, ref: 'ap_2' };
  run = { ...run, controlFacts: withFact(run, other) };
  assert.equal(run.controlFacts.length, 2);
});

// ---------------------------------------------------------------- 取消与级联
/** 假存储：读 → 一个固定集合；settle/patch 记调用。 */
function makeCascadeStore(runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const settled = [];
  const patched = [];
  const store = {
    read(id) {
      const run = byId.get(id);
      return run ? { status: 'found', taskRun: run } : { status: 'missing' };
    },
    listAll() {
      return [...byId.values()];
    },
  };
  return {
    store,
    settled,
    patched,
    settle: async (id, event) => {
      settled.push({ id, event });
      return { ok: true, taskRun: byId.get(id) };
    },
    patch: async (id, patch) => { patched.push({ id, patch }); return { ok: true }; },
    clock: () => T,
  };
}

await test('★★ 取消级联到子任务，但不碰同房间的兄弟任务', async () => {
  const env = makeCascadeStore([
    { id: 'tr_root', revision: 1, state: STATE.running, pendingDispatch: [], openGates: [] },
    { id: 'tr_child', parentTaskId: 'tr_root', revision: 1, state: STATE.running, pendingDispatch: [], openGates: [] },
    { id: 'tr_grand', parentTaskId: 'tr_child', revision: 1, state: STATE.running, pendingDispatch: [], openGates: [] },
    { id: 'tr_sibling', parentTaskId: null, revision: 1, state: STATE.running, pendingDispatch: [], openGates: [] },
  ]);
  const r = await cancelTask({
    taskRuns: env.store, taskRunId: 'tr_root', control: { reason: '用户取消' },
    settle: env.settle, patch: env.patch, clock: env.clock,
  });
  assert.equal(r.ok, true);
  const cancelledIds = env.settled.map((s) => s.id).sort();
  assert.deepEqual(cancelledIds, ['tr_child', 'tr_grand', 'tr_root'], '★ 只取本任务这条链');
  assert.equal(cancelledIds.includes('tr_sibling'), false, '★ 兄弟任务不许被连坐');
});

await test('★ 取消之后旧的后台句柄被标记 cancelled（不能续接）', async () => {
  const env = makeCascadeStore([{
    id: 'tr_root', revision: 1, state: STATE.running, openGates: [],
    pendingDispatch: [
      { id: 'd1', status: 'pending', botId: 'bot_a' },
      { id: 'd2', status: 'running', botId: 'bot_b' },
      { id: 'd3', status: 'done', botId: 'bot_c' },
    ],
  }]);
  await cancelTask({
    taskRuns: env.store, taskRunId: 'tr_root', control: {},
    settle: env.settle, patch: env.patch, clock: env.clock,
  });
  const patch = env.patched.find((p) => p.id === 'tr_root')?.patch;
  assert.ok(patch, '取消后应当 patch 一次');
  const pending = patch.pendingDispatch;
  assert.equal(pending.find((d) => d.id === 'd1').status, 'cancelled', '★ 待派的句柄要标取消');
  assert.equal(pending.find((d) => d.id === 'd2').status, 'running', '已经在跑的不改状态（要靠 abort 停）');
  assert.equal(pending.find((d) => d.id === 'd3').status, 'done', '已完成的不动');
  assert.equal(patch.nextAction, null, '取消之后不该还留着下一步动作');
});

await test('已终态的任务再取消是幂等成功（不是错误）', async () => {
  for (const state of [STATE.cancelled, STATE.completed]) {
    const env = makeCascadeStore([{ id: 'tr_x', revision: 1, state, pendingDispatch: [], openGates: [] }]);
    const r = await cancelTask({
      taskRuns: env.store, taskRunId: 'tr_x', control: {},
      settle: env.settle, patch: env.patch, clock: env.clock,
    });
    assert.equal(r.ok, true);
    assert.equal(r.already, true);
    assert.equal(env.settled.length, 0, '终态任务不该被再取消一次');
  }
});

await test('取消一个不存在的任务 → not_found（不是静默成功）', async () => {
  const env = makeCascadeStore([]);
  const r = await cancelTask({
    taskRuns: env.store, taskRunId: 'tr_nope', control: {},
    settle: env.settle, patch: env.patch, clock: env.clock,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

// ---------------------------------------------------------------- 后代计算
await test('descendants：只沿 parentTaskId 走，不认房间/部门', () => {
  const runs = [
    { id: 'a' }, { id: 'b', parentTaskId: 'a' }, { id: 'c', parentTaskId: 'b' },
    { id: 'd', parentTaskId: 'zzz' }, { id: 'e' },
  ];
  const store = { listAll: () => runs };
  assert.deepEqual(descendants(store, 'a').sort(), ['b', 'c']);
  assert.deepEqual(descendants(store, 'b'), ['c']);
  assert.deepEqual(descendants(store, 'e'), []);
  // listAll 返回外包装时也要能处理
  const wrapped = { listAll: () => ({ taskRuns: runs }) };
  assert.deepEqual(descendants(wrapped, 'a').sort(), ['b', 'c']);
});

await test('descendants 不会因为环而死循环', () => {
  // 数据被改坏成一个环：a → b → a
  const runs = [
    { id: 'a', parentTaskId: 'b' },
    { id: 'b', parentTaskId: 'a' },
  ];
  const store = { listAll: () => runs };
  const out = descendants(store, 'a');
  assert.ok(Array.isArray(out), '环形数据也要能返回（不是卡死）');
  assert.ok(out.length <= 2, `不该无限增长，实际 ${out.length}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
