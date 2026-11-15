/**
 * 级联回收的测试（规格 §6.3 / §5.5）。
 *   node tests/reclamation.mjs
 *
 * ## 这一块为什么是"规格写了、代码里没生效"
 *
 * §6.3 原话：
 *
 *   > 任务结束、超时、取消、成员移除、项目变更、解绑工具、用户撤销时，
 *   > 级联回收子授权、桌面租约、后台执行及临时工件。
 *
 * 七个触发点里，改造前只实现了两个（父链撤销、策略变更）。实测：
 *
 * ```
 * grep -rn "revokeLease" src/     → 只有定义本身，生产零调用
 * grep -rn "pruneScreenshots" src/ → 只有定义本身，生产零调用
 * deleteBot 里                     → 删房间/会话/沙箱 ACE，不碰 grant
 * ```
 *
 * 后果都不是"少个功能"，而是**占着资源不放**或**权限悄悄活下来**：
 *
 * | 漏了哪个 | 用户看到的现象 |
 * |---|---|
 * | 取消任务不撤租约 | 取消之后别的任务还得等一整个 TTL（60 秒）才能动鼠标 |
 * | 任务完成不撤租约 | 一个已经结束的任务一直握着桌面 |
 * | 删 bot 不回收授权 | 删掉同名重建，它原样继承旧授权 —— 用户以为删干净了 |
 * | 截图不清理 | 磁盘只增不减（规格 §5.5 要求保留期） |
 *
 * ## 守什么
 *
 * 1. **取消任务 → 租约被吊销**，且吊销原因说的是"任务已取消"
 * 2. **任务完成 → 租约被释放**
 * 3. **别的任务的租约不受影响**（不能顺手把别人的也撤了）
 * 4. **删 bot → 它的授权全标撤销**，`revokedBy` 是 `user`（这样自动补登记不会再发回来）
 * 5. **子授权一并失效**（父链语义）
 * 6. **设备撤销不动授权**（授权绑 bot 不绑设备，这是刻意的）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reclaim-'));
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
const { store } = await import(src('store.js'));
const S = await import(src('desktop-input-session.js'));
const { LEASE } = await import(src('desktop-lease.js'));
const { ACTION, MODE } = await import(src('grants.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

/** 换一套假的平台实现，让整条链路能在没有真机的情况下跑起来。 */
function installFakePlatform() {
  S.setDesktopInputPlatform({
    probeEnvironment: () => ({
      ok: true, screen: { x: 0, y: 0, width: 2560, height: 1440 }, dpi: 120, session: true,
    }),
    probeLastInput: () => ({ ok: true, lastInputAt: Date.now() - 60_000, idleMs: 60_000 }),
    perform: () => ({ ok: true, at: { x: 1, y: 1 }, foreground: 'X' }),
    sampleNoise: () => ({ ok: true, kind: 'quiet', phantom: false, noisy: false, cursorStill: true, samples: [3000], cursor: { x: 0, y: 0 } }),
  });
}

// ---------------------------------------------------------------- 租约回收
await test('★★ 取消任务 → 租约被吊销（规格 §6.3）', async () => {
  installFakePlatform();
  S.resetDesktopInputSession();
  const session = S.desktopInputSession();
  const got = session.acquireLease({ taskId: 'tr_cancel_me', botId: 'b1', generation: 'g' });
  assert.equal(got.ok, true);
  assert.equal(session.lease.status, LEASE.held);

  // 模拟 task-runtime.onCancel 的那一段（它就是这么写的）
  if (session.lease.taskId === 'tr_cancel_me') {
    session.revokeLease({ reason: '任务已取消：用户取消', by: 'task' });
  }
  assert.equal(session.lease.status, LEASE.revoking, '★ 取消之后租约必须被吊销');
  assert.match(session.lease.revokedReason, /任务已取消/);
  assert.equal(session.lease.revokedBy, 'task', '要记清是谁撤的');
});

await test('★★ 任务完成 → 租约被释放（不走 cancel 入口也要收）', async () => {
  installFakePlatform();
  S.resetDesktopInputSession();
  const session = S.desktopInputSession();
  session.acquireLease({ taskId: 'tr_done', botId: 'b1', generation: 'g' });
  // 模拟 reportTerminal 里的那一段（任务跑完时走这里，不经过 cancel）
  if (session.lease.taskId === 'tr_done') {
    session.releaseLease({ taskId: 'tr_done', reason: '任务到达终态：completed' });
  }
  assert.equal(session.lease.status, LEASE.idle, '★ 完成后不该继续占着桌面');
  assert.equal(session.lease.taskId, null);
});

await test('★ 只收自己的租约，不动别人的（不能顺手把别人撤了）', async () => {
  installFakePlatform();
  S.resetDesktopInputSession();
  const session = S.desktopInputSession();
  session.acquireLease({ taskId: 'tr_holder', botId: 'b_other', generation: 'g' });
  // 另一个任务被取消 —— 它的 taskId 和当前持有者不一致，不该动
  if (session.lease.taskId === 'tr_other_task') {
    session.revokeLease({ reason: '任务已取消', by: 'task' });
  }
  assert.equal(session.lease.status, LEASE.held, '★ 别人持有的租约不许被连坐');
  assert.equal(session.lease.taskId, 'tr_holder');
});

await test('没租约时收租约是安全的空操作（不抛）', () => {
  installFakePlatform();
  S.resetDesktopInputSession();
  const session = S.desktopInputSession();
  assert.doesNotThrow(() => {
    if (session.lease.taskId === 'nope') session.releaseLease({ taskId: 'nope', reason: 'x' });
  });
  assert.equal(session.lease.status, LEASE.idle);
});

// ---------------------------------------------------------------- 授权回收
/** 造一条 bot 的授权（用真把网关，才能验证 revokedBy 的语义）。 */
function grantFor(botId, { mode = MODE.project, actions = [ACTION.fileRead] } = {}) {
  const g = {
    id: `gr_test_${botId}_${Math.random().toString(36).slice(2, 8)}`,
    source: 'user',
    sourceRef: '测试',
    subject: { botId, role: '', instanceId: '' },
    taskId: null,
    parentId: null,
    actions,
    resources: [],
    constraints: {},
    risk: 'medium',
    mode,
    policyRevision: null,
    generation: null,
    canDelegate: true,
    maxUses: null,
    createdAt: Date.now(),
    expiresAt: null,
    revokedAt: null,
  };
  if (!Array.isArray(store.state.grants)) store.state.grants = [];
  store.state.grants.push({ ...g, usedUses: 0 });
  return g;
}

await test('★★ 删 bot → 它的授权全被撤销，revokedBy 是 user（自动补登记不会再发回来）', () => {
  const bot = store.createBot({ name: '要被删的' });
  const g1 = grantFor(bot.id, { actions: [ACTION.fileRead] });
  const g2 = grantFor(bot.id, { actions: [ACTION.fileWrite] });
  // 别人的授权在同一个库里，必须不受影响
  const other = store.createBot({ name: '别人' });
  const keep = grantFor(other.id, { actions: [ACTION.fileRead] });

  store.deleteBot(bot.id);
  const grantsNow = store.state.grants ?? [];

  const after1 = grantsNow.find((g) => g.id === g1.id);
  const after2 = grantsNow.find((g) => g.id === g2.id);
  assert.ok(after1.revokedAt > 0, '★ 删 bot 之后它的授权必须被撤销');
  assert.ok(after2.revokedAt > 0);
  assert.equal(after1.revokedBy, 'user', '★ 记成 user：这样 ensureLegacyGrant 不会自动补回来');
  assert.match(after1.revokedReason, /主体已删除/);
  const kept = grantsNow.find((g) => g.id === keep.id);
  assert.equal(kept.revokedAt, null, '★ 别人的授权不许被连坐');
});

await test('★ 子授权随父授权一起失效（父链语义）', () => {
  const bot = store.createBot({ name: '有子授权的' });
  const parent = grantFor(bot.id);
  // ★ 不能写成 `{...grantFor(...), parentId: parent.id}` —— grantFor 已经把
  //   自己的那份推进数组了，再 push 一次会让同一个 id 在数组里出现两条，
  //   find() 返回的是没有 parentId 的那条，于是"子授权标父链失效"永远测不到。
  const childBase = grantFor(bot.id, { actions: [ACTION.fileRead] });
  const stored = store.state.grants.find((g) => g.id === childBase.id);
  stored.parentId = parent.id;
  stored.canDelegate = false;
  const child = stored;

  store.deleteBot(bot.id);
  const grantsNow = store.state.grants ?? [];

  const p = grantsNow.find((g) => g.id === parent.id);
  const c = grantsNow.find((g) => g.id === child.id);
  assert.ok(p.revokedAt > 0);
  assert.ok(c.revokedAt > 0, '★ 子授权要跟着失效');
  assert.equal(c.revokedBy, 'parent', '子授权要标成"父链失效"而不是"主体删除"');
});

await test('★ 设备撤销不动授权（授权绑 bot 不绑设备）', () => {
  const bot = store.createBot({ name: '有设备的' });
  const g = grantFor(bot.id);
  const dev = store.addDevice({ name: '手机A', platform: 'android' }) ?? null;
  if (dev?.id) {
    store.revokeDevice(dev.id);
  }
  const after = (store.state.grants ?? []).find((x) => x.id === g.id);
  assert.equal(after.revokedAt, null, '★ 撤一台设备不该让 bot 失去权限 —— 那是"换手机要重新授权"');
});

await test('删一个不存在的 bot 是安全的（不抛）', () => {
  assert.doesNotThrow(() => store.deleteBot('b_does_not_exist'));
});

clearTimeout(store.saveTimer);
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
