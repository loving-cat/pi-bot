/**
 * 派活时的文件占用（file claims）测试。
 *   node tests/task-file-claims.mjs
 *
 * 守的是三件事：
 *   1. 路径规范化与"目录覆盖其下所有文件"的判定（撞车要真的判出来）；
 *   2. 声明会落进子任务，且**不参与**业务身份指纹（同一份活补一句文件清单不该变成新任务）；
 *   3. 调度器把撞车的活排开：后者排到将来重试，而不是两份同时开跑。
 *
 * 第 3 条用真实 TaskRunStore + supervisor 跑，不 mock 存储 ——
 * 这一层最容易"看起来拦住了、实际读到的是过期快照"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claims-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
});
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const claimsMod = await import(src('tasks/task-file-claims.js'));
const { store } = await import(src('store.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { createChildTask } = await import(src('tasks/task-subtasks.js'));
const { createTaskSupervisor } = await import(src('tasks/task-supervisor.js'));
const { planMentionDispatch } = await import(src('tasks/task-mentions.js'));

const {
  normalizeClaimPath, fileClaimList, claimsOverlap, findClaimConflicts, filesInText,
} = claimsMod;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------- 纯逻辑
await test('规范化：反斜杠/./结尾斜杠/大小写都归一', () => {
  const opts = { caseInsensitive: true };
  assert.equal(normalizeClaimPath('./src/Auth//x.js', opts), 'src/auth/x.js');
  assert.equal(normalizeClaimPath('src\\Auth\\x.js', opts), 'src/auth/x.js');
  assert.equal(normalizeClaimPath('src/auth/*', opts), 'src/auth');
  assert.equal(normalizeClaimPath('src/auth/**', opts), 'src/auth');
  assert.equal(normalizeClaimPath('  ', opts), '', '空白是无效声明');
  assert.equal(normalizeClaimPath('///', opts), '', '只剩分隔符是无效声明');
});

await test('规范化：大小写敏感平台不折叠', () => {
  assert.equal(normalizeClaimPath('src/Auth/x.js', { caseInsensitive: false }), 'src/Auth/x.js');
  assert.ok(claimsOverlap(
    fileClaimList(['src/Auth'], { caseInsensitive: false }).files,
    fileClaimList(['src/auth/x.js'], { caseInsensitive: false }).files,
  ) === null, '大小写敏感时两条不同路径不该判成冲突');
});

await test('目录覆盖其下所有文件（双向）', () => {
  assert.ok(claimsOverlap(['src/auth'], ['src/auth/login.js']));
  assert.ok(claimsOverlap(['src/auth/login.js'], ['src/auth']));
  assert.ok(claimsOverlap(['src/auth'], ['src/auth']));
  assert.equal(claimsOverlap(['src/auth'], ['src/authz/x.js']), null, '同前缀但不是子目录不算冲突');
  assert.equal(claimsOverlap(['src/a.js'], ['src/b.js']), null);
});

await test('列表规范化：去重、限量、丢无效', () => {
  const { files, dropped } = fileClaimList(['a/b.dart', './a/b.dart', '', '../..', 'a/c.dart']);
  assert.deepEqual(files, ['a/b.dart', 'a/c.dart']);
  assert.equal(dropped, 2, '空串与只剩 .. 的两条应记为丢弃');

  const many = Array.from({ length: 80 }, (_, i) => `f/${i}.js`);
  const limited = fileClaimList(many);
  assert.equal(limited.files.length, 50, '超过上限的部分丢弃');
  assert.ok(limited.dropped >= 30);
});

await test('冲突定位：返回第一对撞上的路径', () => {
  const hits = findClaimConflicts({
    candidate: { id: 'me', files: ['src/auth'] },
    claimed: [
      { id: 'a', files: ['docs/x.md'] },
      { id: 'b', files: ['src/auth/login.js'] },
    ],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'b');
  assert.equal(hits[0].path, 'src/auth');
  assert.equal(hits[0].other, 'src/auth/login.js');
});

await test('冲突定位：excludeIds 跳过自己那棵树', () => {
  const hits = findClaimConflicts({
    candidate: { id: 'me', files: ['src/auth'] },
    claimed: [{ id: 'parent', files: ['src/auth'] }],
    excludeIds: ['parent'],
  });
  assert.equal(hits.length, 0);
});

await test('从正文挑路径：路径/文件名认，URL 与纯词不认', () => {
  assert.deepEqual(
    filesInText('@小明 改 app/lib/foo.dart 和 server/src/x.js，看 https://a.b/c.js'),
    ['app/lib/foo.dart', 'server/src/x.js'],
  );
  assert.deepEqual(filesInText('把 README.md 更新一下'), ['README.md']);
  assert.deepEqual(filesInText('结果写进 out/'), ['out']);
  assert.deepEqual(filesInText('今天天气不错'), []);
});

// ---------------------------------------------------------------- 落进子任务
const chief = store.mainBot();
const memberA = store.createBot({ name: '甲', persona: '写代码' });
const memberB = store.createBot({ name: '乙', persona: '写代码' });
const room = store.createGroup({
  name: '文件互斥测试组',
  botIds: [chief.id, memberA.id, memberB.id],
  leadBotId: chief.id,
});
const taskRuns = store.taskRuns;

let seq = 0;
async function makeParent() {
  seq += 1;
  const id = 'tr_claim' + seq;
  const requestId = 'rq_claim' + seq;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: {
      requirement: '父目标 ' + seq,
      verification: [{ id: 'c1', kind: 'expert', description: '负责人确认' }],
    },
  });
  assert.equal(built.ok, true, '建父任务应成功：' + (built.text ?? ''));
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local',
    requestId,
    fingerprint: 'fp-parent-' + seq,
    build: () => built.taskRun,
    at: Date.now(),
  });
  assert.equal(accepted.ok, true, '接单应成功：' + (accepted.text ?? ''));
  return built.taskRun;
}

const childGoal = (n) => ({
  requirement: '子活 ' + n,
  verification: [{ id: 'v1', kind: 'expert', description: '负责人确认' }],
});

await test('子任务带上 fileClaims', async () => {
  const parent = await makeParent();
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    goal: childGoal('A'),
    botId: memberA.id,
    files: ['./claim/lib/login.dart', 'claim/lib/'],
  });
  assert.equal(out.ok, true, out.text ?? '');
  // 规范化只做「去 ./ 与结尾斜杠」，大小写按宿主平台（Linux 敏感、Windows/macOS 折叠）
  assert.deepEqual(out.child.fileClaims, ['claim/lib/login.dart', 'claim/lib']);
});

await test('同一份活重派时文件清单合并，不新建任务', async () => {
  const parent = await makeParent();
  const first = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('B'), botId: memberA.id, files: ['a/b.dart'],
  });
  const again = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('B'), botId: memberA.id, files: ['c/d.dart'],
  });
  assert.equal(again.ok, true, again.text ?? '');
  assert.equal(again.child.id, first.child.id, '内容相同的派工应复用同一条');
  const reread = taskRuns.read(first.child.id).taskRun;
  assert.deepEqual(reread.fileClaims, ['a/b.dart', 'c/d.dart'], '新声明的文件应并进去');
});

await test('文件清单不参与业务身份：加文件后仍是同一条子任务', async () => {
  const parent = await makeParent();
  const a = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('C'), botId: memberA.id, files: [],
  });
  const b = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('C'), botId: memberA.id, files: ['x/y.js'],
  });
  assert.equal(b.child.id, a.child.id, '补一句文件清单不该变成另一条任务');
});

await test('@ 派工时从那一句里带出文件声明', () => {
  const plan = planMentionDispatch({
    text: '@甲 改 app/lib/a.dart\n@乙 改 app/lib/b.dart',
    members: [
      { id: chief.id, name: chief.name },
      { id: memberA.id, name: '甲' },
      { id: memberB.id, name: '乙' },
    ],
    leadBotId: chief.id,
  });
  assert.equal(plan.targets.length, 2);
  const byName = new Map(plan.targets.map((t) => [t.name, t]));
  assert.deepEqual(byName.get('甲').files, ['app/lib/a.dart']);
  assert.deepEqual(byName.get('乙').files, ['app/lib/b.dart']);
});

// ---------------------------------------------------------------- 调度互斥
/**
 * 造一个"执行即成功"的监督器，记录谁真的跑起来了。
 *
 * 不需要真的挂住某个执行：要验的是"另一份活已经在跑/占着文件时，
 * 这一份会不会被拦在 doLeadStep 之前"，用一个处于持有状态的记录即可
 * （见 markHolding）。
 */
function makeSupervisor({ maxSteps = 2, log = () => {} } = {}) {
  const order = [];
  const sup = createTaskSupervisor({
    taskRuns,
    maxSteps,
    maxStallRounds: 2,
    execute: async ({ taskRun: run }) => {
      order.push(run.id);
      return { ok: true, stop: 'yielded', artifacts: [] };
    },
    executeMember: async ({ taskRun: run }) => {
      order.push(run.id);
      return { ok: true, stop: 'yielded', artifacts: [] };
    },
    verify: async () => ({ passed: false, unmet: ['还没好'], needsReview: [], blocked: [] }),
    access: {
      stat: async () => ({ ok: false }),
      readText: async () => ({ ok: false }),
      resolveRef: () => null,
    },
    clock: () => Date.now(),
    log,
    botNameOf: (botId) => store.getBot(botId)?.name ?? '',
  });
  return { sup, order };
}

/**
 * 把一份子任务置成"正在持有文件占用"。
 *
 * 用 verifying：它既是持有状态（下一步就是验收/继续写），
 * 又不要求在途尝试 —— 直接写 running 会被契约判成非法记录（running 必须有在途执行）。
 * 状态字段和派生值必须一起改，否则 validateTaskRun 会拒绝这条记录。
 */
async function markHolding(taskRunId) {
  const at = Date.now();
  const out = await taskRuns.mutate(taskRunId, {
    mutate: (cur) => (cur ? {
      ...cur,
      state: 'verifying',
      flags: { ...(cur.flags ?? {}), verifyingAt: at },
    } : null),
  });
  assert.equal(out.ok, true, '置持有状态失败：' + (out.text ?? out.code));
  const reread = taskRuns.read(taskRunId).taskRun;
  assert.equal(reread.state, 'verifying', '持有状态应落盘');
  return reread;
}

await test('撞车的子任务会被排到将来重试，而不是立刻开跑', async () => {
  const parent = await makeParent();
  const holder = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('H1'), botId: memberA.id, files: ['clash/lib/same.dart'],
  });
  const waiting = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('H2'), botId: memberB.id, files: ['clash/lib'],
  });
  await markHolding(holder.child.id);

  const logs = [];
  const { sup, order } = makeSupervisor({ log: (m) => logs.push(String(m)) });
  sup.notify(waiting.child.id);
  await sup.idle();

  assert.ok(!order.includes(waiting.child.id), '文件被占时不该执行');
  const after = taskRuns.read(waiting.child.id).taskRun;
  assert.ok(after.retryAt && after.retryAt > Date.now(), `应排到将来，实际 retryAt=${after.retryAt}`);
  assert.ok(!(after.attempts ?? []).some((a) => a.state === 'registered'), '不该登记尝试（不扣额度）');
  assert.ok(
    logs.some((m) => m.includes('文件占用排到后面')),
    '要在日志里说明被什么挡住：' + logs.join(' | '),
  );
});

await test('没人占同一批文件时不排队（不误伤并行）', async () => {
  const parent = await makeParent();
  const holder = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('H3'), botId: memberA.id, files: ['free/docs/x.md'],
  });
  const free = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('H4'), botId: memberB.id, files: ['free/app/other.js'],
  });
  await markHolding(holder.child.id);

  const { sup, order } = makeSupervisor();
  sup.notify(free.child.id);
  await sup.idle();
  assert.ok(order.includes(free.child.id), '不冲突的活应当立刻跑起来');
});

await test('同树的兄弟改了别的文件：照样能并行', async () => {
  const parent = await makeParent();
  const a = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('T1'), botId: memberA.id, files: ['sib/lib'],
  });
  const b = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('T2'), botId: memberB.id, files: ['sib/other'],
  });
  await markHolding(a.child.id);

  const { sup, order } = makeSupervisor();
  sup.notify(b.child.id);
  await sup.idle();
  assert.ok(order.includes(b.child.id), '不同文件应当可以并行');
});

await test('祖先不算占用：父任务等子任务时子任务仍能跑', async () => {
  // 父任务声明了子任务要改的那个目录 —— 若把祖先算成占用，子任务永远排不到。
  const parent = await makeParent();
  const kid = await createChildTask({
    taskRuns, parentTaskRun: parent, goal: childGoal('P1'), botId: memberA.id, files: ['tree/lib/a.dart'],
  });
  await taskRuns.mutate(parent.id, {
    mutate: (cur) => (cur ? { ...cur, fileClaims: ['tree/lib'] } : null),
  });
  await markHolding(parent.id);

  const { sup, order } = makeSupervisor();
  sup.notify(kid.child.id);
  await sup.idle();
  assert.ok(order.includes(kid.child.id), '自己的祖先不该把自己锁死');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
