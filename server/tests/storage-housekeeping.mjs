/**
 * 运行数据清理的端到端测试（真实临时目录，不碰用户数据）。
 *   node tests/storage-housekeeping.mjs
 *
 * ## 这个文件守什么（对应四条红线）
 *
 * 1. **dryRun 真的不删**：只统计条数与字节，文件一个不少；
 * 2. **活跃任务整树免疫**：同根树里有一个 `running`，两个文件都不动；
 * 3. **在跑 bot 的实例目录不删**；
 * 4. **孤儿附件走 `deleteAttachments`**：留墓碑 + 版本号变化 + 文件消失，
 *    被引用的附件一个字节都不动；
 * 5. **`workspace/` / `state.json` 零触碰**；
 * 6. `store.deleteBot` 跨平台清掉 `instances/<botId>`；
 * 7. `cleanup_storage`（经 `buildChiefTools`）默认 `dryRun`，显式传 false 才动手。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-storage-hk-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.ORBIS_HOME = root;
process.env.ORBIS_WORKSPACE = path.join(root, 'workspace');
process.env.ORBIS_PROBE = '0';
process.env.ORBIS_LESSON_REFLECT = '0';
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const { store } = await import('../src/store.js');
const attachments = await import('../src/attachments.js');
const { runStorageHousekeeping, STORAGE_SCOPES, STORAGE_AUTO_SCOPES } = await import(
  '../src/storage-housekeeping.js'
);
const { buildChiefTools } = await import('../src/tools.js');
const { PiRunner } = await import('../src/pi-runner.js');

const DATA = store.dataDir;
const DAY = 24 * 60 * 60 * 1000;

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(file, text = 'x') {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, text);
  return file;
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const NOW = Date.now();
const instancesDir = mkdirp(path.join(DATA, 'instances'));
const old = new Date(NOW - 10 * DAY);

const busyBot = store.createBot({ name: '正在干活的' });
const idleBot = store.createBot({ name: '闲着的' });
// 用真实 bot id 建目录（executor 用 defaultInstanceDir 做同一套安全化）
mkdirp(path.join(DATA, 'instances', idleBot.id));
mkdirp(path.join(DATA, 'instances', busyBot.id));
writeFile(path.join(DATA, 'instances', idleBot.id, 'a.txt'), 'idle-instance');
writeFile(path.join(DATA, 'instances', busyBot.id, 'a.txt'), 'busy-instance');
fs.utimesSync(path.join(DATA, 'instances', idleBot.id), old, old);
fs.utimesSync(path.join(DATA, 'instances', busyBot.id), old, old);

const runner = {
  isBusy: (roomId, botId) => botId === busyBot.id,
  store,
};

// 接单回执：老的 accepted（对应已终结任务）/ running / 新 accepted / 指向活任务
const receiptsDir = mkdirp(path.join(DATA, 'task-requests'));
const writeReceipt = (name, receipt) =>
  writeFile(path.join(receiptsDir, `${name}.json`), JSON.stringify({ version: 1, receipt }));
writeReceipt('old-done', {
  requesterId: 'u1', requestId: 'r1', fingerprint: 'fp', stage: 'accepted',
  taskRunId: 'run_done', finishedAt: NOW - 40 * DAY,
});
writeReceipt('old-running', {
  requesterId: 'u1', requestId: 'r2', fingerprint: 'fp', stage: 'running',
  startedAt: NOW - 40 * DAY, at: NOW - 40 * DAY,
});
writeReceipt('fresh-done', {
  requesterId: 'u1', requestId: 'r3', fingerprint: 'fp', stage: 'accepted',
  taskRunId: 'run_done', finishedAt: NOW - 1 * DAY,
});
writeReceipt('old-live', {
  requesterId: 'u1', requestId: 'r4', fingerprint: 'fp', stage: 'accepted',
  taskRunId: 'tree_live_child', finishedAt: NOW - 40 * DAY,
});

// 任务记录：一棵超期的终态树（2 个文件）+ 一棵"超期但还活着"的树
const taskRunsDir = mkdirp(path.join(DATA, 'taskruns'));
for (const id of ['tree_done_root', 'tree_done_child', 'tree_live_root', 'tree_live_child']) {
  writeFile(path.join(taskRunsDir, `${id}.json`), JSON.stringify({ id }));
}
const syntheticRuns = [
  { id: 'tree_done_root', state: 'completed', finishedAt: NOW - 60 * DAY },
  { id: 'tree_done_child', state: 'completed', rootTaskId: 'tree_done_root', finishedAt: NOW - 60 * DAY },
  { id: 'tree_live_root', state: 'completed', finishedAt: NOW - 60 * DAY },
  { id: 'tree_live_child', state: 'running', rootTaskId: 'tree_live_root' },
];
// executor 只读 listAll()：用桩把"契约校验"这一层让开，专测选择 + 删除
const realListAll = store.taskRuns.listAll.bind(store.taskRuns);
store.taskRuns.listAll = () => ({ taskRuns: syntheticRuns, skipped: 0, problems: [], complete: true });

// 截图
const shotsDir = mkdirp(path.join(DATA, 'desktop-shots'));
writeFile(path.join(shotsDir, 'old.png'), 'png');
fs.utimesSync(path.join(shotsDir, 'old.png'), old, old);

// 附件：一个被消息引用、一个孤儿
const referenced = attachments.saveBuffer(Buffer.from('referenced'), { name: 'ref.txt', mime: 'text/plain' });
const orphan = attachments.saveBuffer(Buffer.from('orphan'), { name: 'orphan.txt', mime: 'text/plain' });
const dm = store.ensureDm(store.mainBot().id);
store.appendMessage({
  roomId: dm.id,
  authorType: 'user',
  authorName: '我',
  text: '带附件',
  attachments: [{ id: referenced.id, name: 'ref.txt', mime: 'text/plain' }],
});
const revisionBefore = attachments.attachmentDeletionRevision();

// workspace 与 state.json 的哨兵
const workspaceSentinel = writeFile(path.join(store.config.workspace, 'keep-me.txt'), 'user data');
store.saveNow(); // 把内存状态落盘，下面才有东西可以比
const stateSentinel = path.join(DATA, 'state.json');
assert.ok(fs.existsSync(stateSentinel), 'state.json 应该已由 store 写出');
const stateBefore = fs.statSync(stateSentinel).size;

// 清理时可复用的"未来 now"：让刚建的附件看起来已经超过 TTL
const FUTURE = NOW + 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1. dryRun
// ---------------------------------------------------------------------------
await test('dryRun：只统计不删（实例 / 回执 / 任务 / 截图全部保留）', () => {
  const summary = runStorageHousekeeping({
    store, runner, dataDir: DATA, scopes: STORAGE_SCOPES, dryRun: true, now: NOW,
  });
  assert.equal(summary.dryRun, true);
  assert.ok(summary.removed.instanceTmp >= 1, `应能算出实例目录：${JSON.stringify(summary.removed)}`);
  assert.ok(summary.removed.taskRequests >= 1);
  assert.ok(summary.removed.taskRuns >= 1);
  assert.ok(summary.reclaimedBytes > 0, '预演也要给出可回收字节数');
  assert.ok(fs.existsSync(path.join(instancesDir, idleBot.id)), 'dryRun 不许删实例目录');
  assert.ok(fs.existsSync(path.join(taskRunsDir, 'tree_done_root.json')), 'dryRun 不许删任务记录');
  assert.ok(fs.existsSync(path.join(receiptsDir, 'old-done.json')), 'dryRun 不许删回执');
  assert.equal(summary.removed.screenshots, 0, '截图没有预演实现，dryRun 下不能假装删了');
  assert.ok(summary.problems.some((p) => p.includes('截图')),
    '截图不能预演这件事必须写进 problems，别让人误会"0 张 = 不用清"');
});

// ---------------------------------------------------------------------------
// 2. 真实清理（安全四项）
// ---------------------------------------------------------------------------
await test('真实清理：实例（跳过在跑 bot）/ 回执（保 running 与活任务）/ 任务（整树）', () => {
  const summary = runStorageHousekeeping({
    store, runner, dataDir: DATA, scopes: STORAGE_AUTO_SCOPES, dryRun: false, now: NOW,
  });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.removed.instanceTmp, 1, '只有闲着的那个老目录该删，在跑的不算');
  assert.equal(summary.removed.taskRequests, 1, '只有 old-done 超期且指向已终结任务');
  assert.equal(summary.removed.taskRuns, 2, 'tree_done_root + child 两个文件');
  assert.ok(summary.reclaimedBytes > 0);

  // 实例：在跑的不动，闲的删掉

  assert.ok(!fs.existsSync(path.join(DATA, 'instances', idleBot.id)), '闲着 bot 的老实例目录该删');
  assert.ok(fs.existsSync(path.join(DATA, 'instances', busyBot.id)), '在跑 bot 的实例目录不许删');

  // 回执
  assert.ok(!fs.existsSync(path.join(receiptsDir, 'old-done.json')), '超期的已终结回执该删');
  for (const keep of ['old-running.json', 'fresh-done.json', 'old-live.json']) {
    assert.ok(fs.existsSync(path.join(receiptsDir, keep)), `${keep} 不该删`);
  }

  // 任务：整棵超期终态树都删；活着的树一个不删
  assert.ok(!fs.existsSync(path.join(taskRunsDir, 'tree_done_root.json')));
  assert.ok(!fs.existsSync(path.join(taskRunsDir, 'tree_done_child.json')), '整树一起删');
  assert.ok(fs.existsSync(path.join(taskRunsDir, 'tree_live_root.json')));
  assert.ok(fs.existsSync(path.join(taskRunsDir, 'tree_live_child.json')), '树里还有 running，整树免疫');

  // 用户产物与核心账本
  assert.ok(fs.existsSync(workspaceSentinel), 'workspace 一个字节都不许动');
  assert.equal(fs.statSync(stateSentinel).size, stateBefore, 'state.json 不许被改');
});

await test('截图：真实清理删掉超期 png', () => {
  const summary = runStorageHousekeeping({
    store, runner, dataDir: DATA, scopes: ['screenshots'], dryRun: false, now: NOW,
  });
  assert.equal(summary.removed.screenshots, 1);
  assert.equal(fs.existsSync(path.join(shotsDir, 'old.png')), false);
});

// ---------------------------------------------------------------------------
// 3. 孤儿附件（必须走 deleteAttachments）
// ---------------------------------------------------------------------------
await test('孤儿附件：默认 scope 不含；显式请求才清，且留墓碑 + 版本号变化', () => {
  // 安全四项不含孤儿附件
  const safe = runStorageHousekeeping({
    store, runner, dataDir: DATA, scopes: STORAGE_AUTO_SCOPES, dryRun: false, now: FUTURE,
  });
  assert.equal(safe.removed.orphanUploads, 0);
  assert.ok(fs.existsSync(attachments.pathFor(orphan.id)), '安全档不许碰上传目录');

  const summary = runStorageHousekeeping({
    store, runner, dataDir: DATA, scopes: ['orphanUploads'], dryRun: false,
    now: FUTURE, limits: { orphanUploadTtlMs: 0 },
  });
  assert.equal(summary.removed.orphanUploads, 1);
  assert.equal(attachments.isAttachmentDeleted(orphan.id), true, '必须有墓碑');
  assert.equal(fs.existsSync(attachments.pathFor(orphan.id)), false, '文件应该已删');
  assert.notEqual(attachments.attachmentDeletionRevision(), revisionBefore, '删除版本号要变（客户端靠它刷新）');
  assert.equal(attachments.isAttachmentDeleted(referenced.id), false, '被消息引用的附件不许删');
  assert.ok(fs.existsSync(attachments.pathFor(referenced.id)));
});

await test('孤儿附件：引用扫不全时整项跳过（宁可不删）', () => {
  // 不能 ：导出的 store 是 Proxy，写属性会穿透到真实例上。
  const broken = {
    listRooms: () => {
      throw new Error('房间读不出来');
    },
  };
  const summary = runStorageHousekeeping({
    store: broken, runner, dataDir: DATA, scopes: ['orphanUploads'], dryRun: false,
    now: FUTURE, limits: { orphanUploadTtlMs: 0 },
  });
  assert.equal(summary.removed.orphanUploads, 0);
  assert.ok(summary.problems.some((p) => p.includes('引用')));
});

// ---------------------------------------------------------------------------
// 4. deleteBot 跨平台清实例目录
// ---------------------------------------------------------------------------
await test('store.deleteBot：删 bot 时把 instances/<botId> 一起清掉', () => {
  const doomed = store.createBot({ name: '待删除' });
  const dir = mkdirp(path.join(DATA, 'instances', doomed.id));
  writeFile(path.join(dir, 'junk.bin'), 'junk');
  store.deleteBot(doomed.id);
  assert.equal(fs.existsSync(dir), false, '实例目录应该跟着 bot 一起消失');
  assert.ok(fs.existsSync(instancesDir), 'instances 根目录不能删');
});

// ---------------------------------------------------------------------------
// 5. cleanup_storage 工具（经 buildChiefTools）
// ---------------------------------------------------------------------------
await test('cleanup_storage：默认 dryRun（只汇报），显式 false 才动手', async () => {
  const main = store.mainBot();
  writeFile(path.join(DATA, 'instances', 'tool_probe', 'x.bin'), 'x');
  fs.utimesSync(path.join(DATA, 'instances', 'tool_probe'), old, old);

  const tools = buildChiefTools({ runner: new PiRunner(), health: null, roomId: dm.id, botId: main.id, store });
  const tool = tools.find((t) => t?.name === 'cleanup_storage');
  assert.ok(tool, 'buildChiefTools 里必须有 cleanup_storage');

  const preview = await tool.execute('call-1', { scope: 'tmp' });
  const previewText = preview.content.map((c) => c.text).join('\n');
  assert.match(previewText, /预演/, `默认必须是预演：${previewText}`);
  assert.ok(fs.existsSync(path.join(DATA, 'instances', 'tool_probe')), '预演不许删');

  const applied = await tool.execute('call-2', { scope: 'tmp', dryRun: false });
  const appliedText = applied.content.map((c) => c.text).join('\n');
  assert.match(appliedText, /已清理/, `显式 dryRun=false 才执行：${appliedText}`);
  assert.equal(fs.existsSync(path.join(DATA, 'instances', 'tool_probe')), false);
});

// ---------------------------------------------------------------------------
// 6. 收尾与不变量
// ---------------------------------------------------------------------------
await test('任务记录读不完整时不做任何任务/回执清理（保守失败）', () => {
  store.taskRuns.listAll = () => ({
    taskRuns: [], skipped: 1, problems: [{ id: 'x', status: 'bad' }], complete: false,
  });
  const summary = runStorageHousekeeping({
    store, runner, dataDir: DATA, scopes: ['taskRuns', 'taskRequests'], dryRun: false, now: FUTURE,
  });
  assert.equal(summary.removed.taskRuns, 0);
  assert.equal(summary.removed.taskRequests, 0);
  assert.ok(summary.problems.length >= 1);
  store.taskRuns.listAll = () => ({ taskRuns: syntheticRuns, skipped: 0, problems: [], complete: true });
});

store.taskRuns.listAll = realListAll;

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 上可能还有句柄
}

console.log(`\nstorage-housekeeping: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
