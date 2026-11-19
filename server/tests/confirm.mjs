/**
 * 危险动作确认的测试（规格 P0-4）。
 *   node tests/confirm.mjs
 *
 * 守的核心一句是规格 §9：
 *   「同机任意宿主执行可自动化用户界面，因此确认 UI 的真实性必须单独设计，
 *     不能假设同用户随机 nonce 足以防止恶意代码伪造确认。」
 *
 * 落到实现上就是：本机桌面的"批准"只能放行可恢复动作；
 * 不可恢复动作必须在**已配对的独立设备**上确认。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-confirm-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
});

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const C = await import(src('confirm.js'));
const { store } = await import(src('store.js'));

const {
  REVERSIBILITY, CHANNEL, reversibilityOf, channelSuffices, ttlFor,
  digestOf, buildConfirmation, checkConfirmation, describeConfirmation,
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

// ---------------------------------------------------------------- 分级
await test('不可恢复动作清单：push / 删除 / 对外发送 / 改策略', () => {
  for (const a of ['git.push', 'file.delete', 'net.send', 'secret.use', 'policy.change', 'mcp.add']) {
    assert.equal(reversibilityOf(a), REVERSIBILITY.irreversible, a + ' 应当是不可恢复');
  }
});

await test('可恢复动作：写文件 / 跑命令 / 本地提交 / 读', () => {
  for (const a of ['file.write', 'cmd.exec', 'git.commit', 'git.read', 'file.read', 'desktop.observe']) {
    assert.equal(reversibilityOf(a), REVERSIBILITY.reversible, a + ' 应当是可恢复');
  }
});

await test('★ 本机桌面只能确认可恢复动作（主 Bot 能自己点它）', () => {
  assert.equal(channelSuffices(CHANNEL.local, 'file.write').ok, true);
  assert.equal(channelSuffices(CHANNEL.local, 'git.commit').ok, true);

  const bad = channelSuffices(CHANNEL.local, 'git.push');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /手机/);
  assert.match(bad.reason, /主 Bot/, '理由要说清为什么本机桌面不算数');
});

await test('★ 已配对的独立设备能确认不可恢复动作', () => {
  for (const a of ['git.push', 'file.delete', 'net.send']) {
    assert.equal(channelSuffices(CHANNEL.device, a).ok, true, a);
  }
});

await test('不可恢复动作的确认有效期更短', () => {
  assert.ok(ttlFor('git.push') < ttlFor('file.write'));
});

// ---------------------------------------------------------------- 摘要
await test('目标摘要：键顺序无关（不然每次都被要求重新确认）', () => {
  const a = digestOf({ remote: 'origin', ref: 'main', files: ['a', 'b'] });
  const b = digestOf({ files: ['a', 'b'], ref: 'main', remote: 'origin' });
  assert.equal(a, b);
});

await test('目标摘要：数组顺序有关（顺序变了就是不同的目标）', () => {
  assert.notEqual(digestOf({ files: ['a', 'b'] }), digestOf({ files: ['b', 'a'] }));
});

await test('目标摘要：值变了摘要就变', () => {
  assert.notEqual(
    digestOf({ remote: 'origin', ref: 'main' }),
    digestOf({ remote: 'origin', ref: 'main2' }),
  );
});

// ---------------------------------------------------------------- 判定
const mk = (over = {}) => buildConfirmation({
  id: 'cf_1',
  action: 'git.push',
  target: { remote: 'origin', ref: 'main' },
  summary: '推 3 个提交到 origin/main',
  now: 1_000_000,
  ...over,
});

await test('等待确认时不能用', () => {
  const c = mk();
  const r = checkConfirmation({ confirmation: c, target: { remote: 'origin', ref: 'main' }, now: 1_000_001 });
  assert.equal(r.code, 'not_approved');
});

await test('★ 目标变了就不能用（规格 §9「目标变化则重新确认」）', () => {
  const c = { ...mk(), decision: 'approved', channel: CHANNEL.device };
  const r = checkConfirmation({
    confirmation: c,
    target: { remote: 'origin', ref: 'other-branch' },
    now: 1_000_001,
  });
  assert.equal(r.code, 'target_changed');
});

await test('★ 过了有效期不能用', () => {
  const c = { ...mk(), decision: 'approved', channel: CHANNEL.device };
  const r = checkConfirmation({
    confirmation: c,
    target: { remote: 'origin', ref: 'main' },
    now: c.expiresAt + 1,
  });
  assert.equal(r.code, 'expired');
});

await test('★ 用完一次就不能再用（不做 10 分钟窗口）', () => {
  const c = { ...mk(), decision: 'approved', channel: CHANNEL.device, consumedAt: 1_000_002 };
  const r = checkConfirmation({ confirmation: c, target: { remote: 'origin', ref: 'main' }, now: 1_000_003 });
  assert.equal(r.code, 'consumed');
});

await test('★ 只有弱通道批准也不放行不可恢复动作', () => {
  // 就算 store 里被标成 approved，通道不够也过不去 —— 双保险
  const c = { ...mk(), decision: 'approved', channel: CHANNEL.local };
  const r = checkConfirmation({ confirmation: c, target: { remote: 'origin', ref: 'main' }, now: 1_000_001 });
  assert.equal(r.code, 'weak_channel');
});

await test('策略版本变了，确认作废', () => {
  const c = { ...mk({ policyRevision: 'p1' }), decision: 'approved', channel: CHANNEL.device };
  const r = checkConfirmation({
    confirmation: c,
    target: { remote: 'origin', ref: 'main' },
    now: 1_000_001,
    policyRevision: 'p2',
  });
  assert.equal(r.code, 'policy_changed');
});

await test('被拒绝后不许换渠道再来', () => {
  const c = { ...mk(), decision: 'denied', channel: CHANNEL.device };
  const r = checkConfirmation({ confirmation: c, target: { remote: 'origin', ref: 'main' } });
  assert.equal(r.code, 'denied');
  assert.match(r.text, /不要换渠道/);
});

await test('全部条件满足才通过', () => {
  const c = { ...mk(), decision: 'approved', channel: CHANNEL.device };
  const r = checkConfirmation({ confirmation: c, target: { remote: 'origin', ref: 'main' }, now: 1_000_001 });
  assert.equal(r.ok, true, r.text ?? '');
});

// ---------------------------------------------------------------- store
await test('store：同一个动作+目标不重复建卡片', () => {
  store.state.confirmations = [];
  // 去重只对**还有效**的卡片成立，所以这里用当前时间（mk 默认 now 是 1970，早就过期了）
  const now = Date.now();
  const a = mk({ id: 'cf_a', now });
  const b = mk({ id: 'cf_b', now });
  const first = store.requestConfirmation(a);
  const again = store.requestConfirmation(b);
  assert.equal(first.id, 'cf_a');
  assert.equal(again.id, 'cf_a', '重复请求应复用同一条');
  assert.equal(store.pendingConfirmations().length, 1);
});

await test('★ store：过期的旧卡片不能挡住新卡片（否则同一目标永久死锁）', () => {
  store.state.confirmations = [];
  store.requestConfirmation(mk({ id: 'cf_stale', now: 1_000_000 }));  // expiresAt 早在 1970
  const fresh = store.requestConfirmation(mk({ id: 'cf_fresh', now: Date.now() }));
  assert.equal(fresh.id, 'cf_fresh', '过期那条不该被当成重复');
});

await test('store：不同目标各建一条', () => {
  store.state.confirmations = [];
  store.requestConfirmation(mk({ id: 'cf_1', target: { remote: 'origin', ref: 'main' } }));
  store.requestConfirmation(mk({ id: 'cf_2', target: { remote: 'origin', ref: 'dev' } }));
  assert.equal(store.pendingConfirmations().length, 2);
});

await test('store：决定是幂等的（重复点不会改结果）', () => {
  store.state.confirmations = [];
  store.requestConfirmation(mk({ id: 'cf_x' }));
  const first = store.decideConfirmation('cf_x', { approved: true, channel: CHANNEL.device, device: { id: 'd1', name: '手机' } });
  assert.equal(first.decision, 'approved');
  const again = store.decideConfirmation('cf_x', { approved: false, channel: CHANNEL.local });
  assert.equal(again.decision, 'approved', '已决过的不能被改成拒绝');
});

await test('store：记下是哪台设备批的（审计要看）', () => {
  store.state.confirmations = [];
  store.requestConfirmation(mk({ id: 'cf_y' }));
  const c = store.decideConfirmation('cf_y', {
    approved: true, channel: CHANNEL.device, device: { id: 'd_phone', name: '我的手机' },
  });
  assert.equal(c.decidedByDeviceId, 'd_phone');
  assert.equal(c.decidedByDeviceName, '我的手机');
  assert.match(describeConfirmation(c), /我的手机/);
});

await test('store：消费后从待确认列表消失', () => {
  store.state.confirmations = [];
  store.requestConfirmation(mk({ id: 'cf_z' }));
  store.decideConfirmation('cf_z', { approved: true, channel: CHANNEL.device });
  assert.equal(store.pendingConfirmations().length, 1, '批准但未消费时仍可见');
  store.consumeConfirmation('cf_z');
  assert.equal(store.pendingConfirmations().length, 0, '消费后应消失');
});

await test('store：过期的会被标出来（而不是静默消失）', () => {
  store.state.confirmations = [];
  const old = buildConfirmation({
    id: 'cf_old', action: 'git.push', target: { x: 1 }, now: Date.now() - 10 * 60_000,
  });
  store.requestConfirmation(old);
  const list = store.pendingConfirmations();
  assert.equal(list.length, 1);
  assert.equal(list[0].expired, true);
});

await test('确认记录里不含凭据字段', () => {
  const c = mk();
  const raw = JSON.stringify(c).toLowerCase();
  for (const bad of ['password', 'token', 'secret', 'api_key', 'apikey']) {
    assert.ok(!raw.includes(bad), `确认记录不该出现 ${bad}`);
  }
});

// ---------------------------------------------------------------- 本机批准开关
await test('★ 没打开「允许本机批准」时：本机批准不可恢复动作必须被拒', () => {
  const built = buildConfirmation({
    action: 'git.push',
    target: { branches: ['main'] },
    summary: '推一下 main',
  });
  const approved = {
    ...built,
    channel: 'local',
    decision: 'approved',
    decidedAt: Date.now(),
    channelWeakened: true,
  };
  const verdict = checkConfirmation({ confirmation: approved, target: { branches: ['main'] } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'weak_channel');
});

await test('★ 打开了「允许本机批准」：执行边界也要认这个开关（否则设置等于没开）', () => {
  const built = buildConfirmation({
    action: 'git.push',
    target: { branches: ['main'] },
    summary: '推一下 main',
  });
  const approved = {
    ...built,
    channel: 'local',
    decision: 'approved',
    decidedAt: Date.now(),
    channelWeakened: true,
  };
  const relaxed = checkConfirmation({
    confirmation: approved, target: { branches: ['main'] }, allowLocal: true,
  });
  assert.equal(relaxed.ok, true, '设置打开 + 记录标了 weakened 就该放行');

  // 只传 allowLocal 不够：记录里必须真的标过 weakened，否则等于给所有确认开后门
  const notWeakened = checkConfirmation({
    confirmation: { ...approved, channelWeakened: false },
    target: { branches: ['main'] },
    allowLocal: true,
  });
  assert.equal(notWeakened.ok, false, '记录没标 weakened 时不许借这个开关放行');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
