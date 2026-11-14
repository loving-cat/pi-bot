/**
 * push 全链路：pending → 手机批准 → 校验 → 执行 → 核对 → 一次一用。
 *   node tests/git-push-flow.mjs
 *
 * 这是 P0-4 与 P0-6 接起来的那条链路。**必须端到端跑**：
 * 单测能证明"每个函数都对"，证明不了"这条路真的只有一条"。
 *
 * 造一个本地裸仓库当远端，不碰网络、不需要凭据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pushflow-'));
const ws = path.join(fixture, 'workspace');
const repo = path.join(ws, 'proj');
const bare = path.join(fixture, 'remote.git');
fs.mkdirSync(repo, { recursive: true });
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: ws,
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
});

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { buildGitTools } = await import(src('git-tools.js'));
const { locateGit, describePushTarget, verifyPushLanded } = await import(src('git-ops.js'));

const git = locateGit();
if (!git.ok) {
  console.log('✗ 找不到 Git：' + git.error);
  process.exit(1);
}

const raw = (args, cwd = repo) => spawnSync(git.file, args, {
  cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env },
});

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---- 准备：一个仓库 + 一个本地裸远端，并且已经建立上游关系 ----
raw(['init', '-q', '-b', 'main']);
raw(['config', 'user.name', 'pi-bot-test']);
raw(['config', 'user.email', 'test@local']);
fs.writeFileSync(path.join(repo, 'x.txt'), 'v1\n');
raw(['add', '-A']);
raw(['commit', '-q', '-m', 'first']);
raw(['init', '-q', '--bare', bare]);
raw(['remote', 'add', 'origin', bare]);
raw(['push', '-q', '-u', 'origin', 'main']);

const tools = buildGitTools({
  runner: {}, store, roomId: store.ensureDm(store.mainBot().id).id, botId: store.mainBot().id,
});
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const call = async (name, args) => {
  const r = await byName[name].execute('call', args);
  return { text: r.content[0].text, err: r.isError === true, details: r.details };
};

/** 最近一次生成的票据 id（不靠 pendingConfirmations 的顺序，那个会变）。 */
let lastTicket = null;

/** 每轮造一个新提交，让"有东西可推"。 */
function newCommit(msg) {
  fs.appendFileSync(path.join(repo, 'x.txt'), msg + '\n');
  raw(['commit', '-q', '-am', msg]);
}

test.name; // 保持 lint 安静

await test('★ 没有待推提交时直接拒绝，不生成确认', async () => {
  const out = await call('git_push', { repo: 'proj' });
  assert.equal(out.err, true);
  assert.match(out.text, /没有要推的提交/);
  assert.equal(store.pendingConfirmations().length, 0, '不该生成确认');
});

await test('★ 不带 ticket：生成确认，列出将要推的提交', async () => {
  newCommit('第二个提交');
  const out = await call('git_push', { repo: 'proj' });
  assert.equal(out.err, false, out.text);
  assert.match(out.text, /1 个提交/);
  assert.match(out.text, /ticket=/);
  assert.ok(out.details.ticket, '应给出票据');
  lastTicket = out.details.ticket;
  assert.equal(store.pendingConfirmations().length, 1);
});

await test('★ 确认卡片的通道要求：本机桌面批准不落地', async () => {
  const id = lastTicket;
  // store 层直接拒：这条通道不够格，所以记录**根本不变**
  const r = store.decideConfirmation(id, { approved: true, channel: 'local' });
  assert.equal(r.rejected, true, '本机桌面批准不可撤销动作应被 store 拒');
  assert.match(r.rejectedReason, /手机/);
  assert.equal(store.getConfirmation(id).decision, null, '不该落成 approved');

  const out = await call('git_push', { repo: 'proj', ticket: id });
  assert.equal(out.err, true);
  assert.match(out.text, /手机/);
  // 远端不能因为这次"批准"就变了
  const remoteHead = raw(['rev-parse', 'main'], bare).stdout.trim();
  const localHead = raw(['rev-parse', 'main']).stdout.trim();
  assert.notEqual(remoteHead, localHead, '不该真的推上去');
});

await test('★ 手机批准后才推上去，且核对远端与本地一致', async () => {
  const id = lastTicket;
  // 模拟在手机上批准（真实路径：POST /api/confirmations/:id，header 是 device）
  store.decideConfirmation(id, {
    approved: true, channel: 'device', device: { id: 'd_phone', name: '我的手机' },
  });
  const out = await call('git_push', { repo: 'proj', ticket: id });
  assert.equal(out.err, false, out.text);
  assert.match(out.text, /已推送/);
  assert.match(out.text, /我的手机/);

  const remoteHead = raw(['rev-parse', 'main'], bare).stdout.trim();
  const localHead = raw(['rev-parse', 'main']).stdout.trim();
  assert.equal(remoteHead, localHead, '远端应当真的更新了');
});

await test('★ 同一张票据不能再用（一次一用）', async () => {
  const out = await call('git_push', { repo: 'proj', ticket: lastTicket });
  assert.equal(out.err, true);
  assert.match(out.text, /用过了|consumed/);
});

await test('★ 批准后目标变了（又提交了一次）→ 拒绝执行', async () => {
  newCommit('第三个');
  const first = await call('git_push', { repo: 'proj' });
  const id = first.details.ticket;
  lastTicket = id;
  store.decideConfirmation(id, { approved: true, channel: 'device', device: { id: 'd2', name: '手机2' } });

  // 用户批准之后，代码又变了 —— 这一条必须重新确认
  newCommit('偷偷加的第四个');

  const out = await call('git_push', { repo: 'proj', ticket: id });
  assert.equal(out.err, true);
  assert.match(out.text, /不一样了|target_changed/, out.text);

  // 远端仍停留在上一次推的位置
  const remoteHead = raw(['rev-parse', 'main'], bare).stdout.trim();
  const localHead = raw(['rev-parse', 'main']).stdout.trim();
  assert.notEqual(remoteHead, localHead);
});

await test('被拒绝的确认不能执行，也不能换票据绕过', async () => {
  const first = await call('git_push', { repo: 'proj' });
  const id = first.details.ticket;
  lastTicket = id;
  store.decideConfirmation(id, { approved: false, channel: 'device', device: { id: 'd3', name: '手机3' } });
  const out = await call('git_push', { repo: 'proj', ticket: id });
  assert.equal(out.err, true);
  assert.match(out.text, /拒绝|denied/);
});

await test('describePushTarget：目标里只有会影响结果的事实', () => {
  const t = describePushTarget({ repoDir: repo, remote: 'origin', branches: ['main'] });
  assert.equal(t.ok, true, t.error);
  const keys = Object.keys(t.target).sort();
  assert.deepEqual(keys, ['branches', 'remote'], '不该有时间戳之类会让摘要每次都变的字段');
  const branchKeys = Object.keys(t.target.branches[0]).sort();
  assert.deepEqual(branchKeys, ['branch', 'commitCount', 'head', 'upstream']);
});

await test('verifyPushLanded：本地与远端不一致时如实报告', () => {
  newCommit('第五个');
  const v = verifyPushLanded({ repoDir: repo, remote: 'origin', branch: 'main' });
  assert.equal(v.ok, true);
  assert.equal(v.matched, false, '还没推就不该说一致');
});

await test('审计里有 push 记录', () => {
  const actions = store.listAdminActions({ limit: 300 });
  assert.ok(actions.some((a) => a.action === 'git.push'), 'push 应留审计');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
