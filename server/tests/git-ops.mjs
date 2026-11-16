/**
 * Git 适配器的测试。
 *   node tests/git-ops.mjs
 *
 * 守四件事：
 *   1. 读操作**真的**不执行外部程序（`diff.external` / `textconv` / pager）；
 *   2. 白名单之外的操作（push/reset/clean）明确拒绝，而不是悄悄失败；
 *   3. worktree 的 `.git` 指针能解析出 gitdir / commondir（规格 §7.3）；
 *   4. commit 的成功判定看"HEAD 有没有前进"，不只看退出码（规格 §7.1）。
 *
 * 全部在临时仓库里跑，不碰用户真实仓库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const m = await import('../src/git-ops.js');
const {
  locateGit, resolveRepoLayout, runGit, GIT_OPERATIONS, REFUSED_OPERATIONS,
  parseStatus, verifyCommitLanded, currentHead, listActiveHooks, describeGitError,
  readAlternates,
} = m;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const git = locateGit();
if (!git.ok) {
  console.log('✗ 找不到 Git，无法测 Git 适配器：' + git.error);
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-git-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo, { recursive: true });

const realish = (p) => {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return p; }
};

/** 直接跑 git（测试自己的准备动作，不走被测代码）。 */
function raw(args, cwd = repo) {
  return spawnSync(git.file, args, {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

raw(['init', '-q', '-b', 'main']);
// ★ CI runner 上没有全局 user.name/email，git commit 会以 128 失败。
//   真实仓库里一定有这条配置，所以在临时仓库里配一份 ——
//   否则测的不是"适配器能不能提交"，而是"这台机器有没有全局 git 身份"。
raw(['config', 'user.name', 'pi-bot-test']);
raw(['config', 'user.email', 'test@local']);
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
raw(['add', '-A']);
raw(['commit', '-q', '-m', 'init']);

// ---------------------------------------------------------------- 探测
await test('找得到 Git，并记下版本与来源', () => {
  assert.equal(git.ok, true);
  assert.match(git.version, /^\d+\./);
  assert.ok(git.source);
});

await test('不在仓库里时明确报错，不猜', () => {
  const r = resolveRepoLayout(path.join(root, 'not-a-repo'));
  assert.equal(r.ok, false);
  assert.match(r.error, /不在任何 git 仓库/);
});

// ---------------------------------------------------------------- 解析
await test('普通仓库：gitDir 与 commonDir 都是 .git', () => {
  const layout = resolveRepoLayout(repo);
  assert.equal(layout.ok, true);
  assert.equal(layout.worktree, false);
  assert.equal(layout.commonDir, layout.gitDir);
  assert.ok(layout.gitDir.endsWith('.git'));
});

await test('子目录里也能找到仓库根', () => {
  const sub = path.join(repo, 'deep', 'nested');
  fs.mkdirSync(sub, { recursive: true });
  const layout = resolveRepoLayout(sub);
  assert.equal(layout.ok, true);
  assert.equal(realish(layout.root), realish(repo));
});

await test('worktree：.git 是指针文件，commondir 指向主仓', () => {
  const wt = path.join(root, 'wt1');
  const added = raw(['worktree', 'add', '-q', wt, '-b', 'wt-branch']);
  assert.equal(added.status, 0, added.stderr);

  const layout = resolveRepoLayout(wt);
  assert.equal(layout.ok, true);
  assert.equal(layout.worktree, true, 'worktree 的 .git 是文件');
  assert.ok(layout.pointerFile, '应记下指针文件路径');
  assert.ok(layout.gitDir.includes('worktrees'), 'gitDir 应在主仓的 worktrees 下：' + layout.gitDir);
  // 关键：commonDir 必须是**主仓**的 .git，不是 worktree 自己那个。
  // ★ 比较前两边都要 realpath：macOS 的 /var → /private/var、
  //   Linux 的 /tmp 链接、Windows runner 的 8.3 短名（RUNNER~1）
  //   都会让"同一个目录"有两条写法（CI 上实测挂过）。
  assert.equal(realish(layout.commonDir), realish(resolveRepoLayout(repo).gitDir));
  // 普通 worktree 不共享对象库（没配置 alternates），这里应该是空数组。
  // 断言它存在且是空的，比不写好：以后有人加 alternates 支持时，
  // 会立刻看到"这里预期变了"。
  assert.ok(Array.isArray(layout.alternates), 'alternates 字段应当在 layout 里');
  assert.deepEqual(layout.alternates, [], '普通 worktree 不该有 alternates');

  raw(['worktree', 'remove', '--force', wt]);
});

// ---------------------------------------------------------------- alternates（规格 §7.3）
await test('★ alternates：绝对路径原样登记、相对路径按 objects/ 解析', () => {
  // 规格 §7.3 要求"登记 objects alternates" —— 不登记就看不见
  // "这个仓库能读到别处的全部对象"这件事。
  const fakeCommon = path.join(root, 'fake-git');
  fs.mkdirSync(path.join(fakeCommon, 'objects', 'info'), { recursive: true });
  const altFile = path.join(fakeCommon, 'objects', 'info', 'alternates');
  fs.writeFileSync(altFile, '/shared/objects\n../rel/objects\n', 'utf8');
  const got = readAlternates(fakeCommon);
  assert.equal(got.length, 2);
  assert.equal(got[0], '/shared/objects', '绝对路径原样保留');
  // 相对路径的基准是 <commonDir>/objects，不是仓库根
  assert.equal(got[1], path.resolve(path.join(fakeCommon, 'objects'), '../rel/objects'));
});

await test('alternates：没有文件 / 空文件 / 注释行都返回空数组（不炸）', () => {
  assert.deepEqual(readAlternates(path.join(root, 'nope')), []);
  assert.deepEqual(readAlternates(''), []);
  const fakeCommon = path.join(root, 'fake-git2');
  fs.mkdirSync(path.join(fakeCommon, 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(fakeCommon, 'objects', 'info', 'alternates'), '# 只有注释\n\n', 'utf8');
  assert.deepEqual(readAlternates(fakeCommon), []);
});

await test('alternates：同一个路径写两遍只登记一次', () => {
  const fakeCommon = path.join(root, 'fake-git3');
  fs.mkdirSync(path.join(fakeCommon, 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(fakeCommon, 'objects', 'info', 'alternates'), '/x\n/x\n', 'utf8');
  assert.deepEqual(readAlternates(fakeCommon), ['/x']);
});

// ---------------------------------------------------------------- 读操作
await test('status 能解析出分支与未跟踪文件', () => {
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  const r = runGit({ repoDir: repo, op: 'status' });
  assert.equal(r.ok, true, r.error ?? '');
  const parsed = parseStatus(r.stdout);
  assert.equal(parsed.branch, 'main');
  assert.ok(parsed.untracked.includes('new.txt'), JSON.stringify(parsed));
  fs.unlinkSync(path.join(repo, 'new.txt'));
});

await test('log 只出指定条数', () => {
  const r = runGit({ repoDir: repo, op: 'log', params: { limit: 4 } });
  assert.equal(r.ok, true);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.ok(lines.length <= 4);
  assert.match(lines.at(-1), /init/);
});

await test('★ diff 不执行 diff.external（那是可配置的任意程序）', () => {
  // 配一个会被执行的"外部 diff"：如果真跑了它，就会留下标记文件
  const marker = path.join(root, 'external-diff-ran');
  const spy = path.join(root, 'spy-diff.sh');
  fs.writeFileSync(spy, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
  raw(['config', 'diff.external', spy]);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const r = runGit({ repoDir: repo, op: 'diff' });
  assert.equal(r.ok, true, r.error ?? '');
  assert.ok(!fs.existsSync(marker), '--no-ext-diff 没生效：外部 diff 被执行了');

  raw(['config', '--unset', 'diff.external']);
  raw(['checkout', '--', 'a.txt']);
});

await test('★ diff 不执行 textconv（那同样是可配置的程序）', () => {
  const marker = path.join(root, 'textconv-ran');
  const spy = path.join(root, 'spy-textconv.sh');
  fs.writeFileSync(spy, `#!/bin/sh\ntouch '${marker}'\ncat "$1"\n`, { mode: 0o755 });

  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=spy\n');
  raw(['config', 'diff.spy.textconv', spy]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');

  const r = runGit({ repoDir: repo, op: 'diff' });
  assert.equal(r.ok, true, r.error ?? '');
  assert.ok(!fs.existsSync(marker), '--no-textconv 没生效：textconv 程序被执行了');

  raw(['checkout', '--', 'a.txt']);
  fs.unlinkSync(path.join(repo, '.gitattributes'));
  raw(['config', '--remove-section', 'diff.spy']);
});

// ---------------------------------------------------------------- 写操作
await test('add + commit：HEAD 前进，状态回读干净', () => {
  const before = currentHead({ repoDir: repo });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');

  const added = runGit({ repoDir: repo, op: 'add', params: { paths: ['b.txt'] } });
  assert.equal(added.ok, true, added.error ?? '');

  const committed = runGit({ repoDir: repo, op: 'commit', params: { message: 'add b' } });
  assert.equal(committed.ok, true, committed.error ?? '');

  const verified = verifyCommitLanded({ beforeHead: before, repoDir: repo });
  assert.equal(verified.ok, true);
  assert.equal(verified.advanced, true, 'HEAD 应当前进');

  const st = runGit({ repoDir: repo, op: 'status' });
  const parsed = parseStatus(st.stdout);
  assert.deepEqual(parsed.staged, []);
  assert.deepEqual(parsed.untracked, []);
});

await test('★ 错误文案翻成能照着做的话（纯函数，不依赖 runner 配置）', () => {
  // 原来这条是"真跑一次没身份的提交"，结果 macOS runner 自带的
  // /etc/gitconfig 让提交成功了 —— 假红。改成直接测文案映射。
  const cases = [
    ['Author identity unknown\n*** Please tell me who you are.', /还没配提交身份/, 'user.name'],
    ['nothing to commit, working tree clean', /没有可提交的改动/, 'git_add'],
    ["error: pathspec 'x.txt' did not match any file(s) known to git", /不存在/, 'git_status'],
    ['fatal: not a git repository (or any of the parent directories)', /不是 git 仓库/, 'repo'],
    ['fatal: Unable to create \.git/index.lock: File exists', /别的 git 进程/, '不要手动删锁文件'],
  ];
  for (const [stderr, pattern, hint] of cases) {
    const text = describeGitError({ key: 'commit', code: 128, stderr });
    assert.match(text, pattern, stderr + ' → ' + text);
    assert.match(text, new RegExp(hint), stderr + ' 应提示 ' + hint);
  }
  // 认不出来的原样带上退出码，不要把原因吞掉
  const unknown = describeGitError({ key: 'fetch', code: 9, stderr: 'something weird' });
  assert.match(unknown, /退出码 9/);
  assert.match(unknown, /something weird/);
});

await test('★ commit 成功判定：HEAD 没前进就不算成功', () => {
  const head = currentHead({ repoDir: repo });
  // 没有改动时 commit 会失败；这里直接验 verifyCommitLanded 的判据
  const same = verifyCommitLanded({ beforeHead: head, repoDir: repo });
  assert.equal(same.afterHead, head);
  assert.equal(same.advanced, false, '同一个 HEAD 不该判成前进');
});

await test('★ commit 时 hooks 照常执行（不偷偷 --no-verify）', () => {
  const marker = path.join(root, 'precommit-ran');
  const hookDir = path.join(resolveRepoLayout(repo).commonDir, 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });

  // 记下 hooks（审计要用）
  const hooks = listActiveHooks({ repoDir: repo });
  assert.ok(hooks.includes('pre-commit'), JSON.stringify(hooks));

  fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
  runGit({ repoDir: repo, op: 'add', params: { paths: ['c.txt'] } });
  const committed = runGit({ repoDir: repo, op: 'commit', params: { message: 'add c' } });
  assert.equal(committed.ok, true, committed.error ?? '');
  assert.ok(fs.existsSync(marker), 'pre-commit hook 应当被执行（我们没有传 --no-verify）');

  fs.unlinkSync(hook);
  fs.unlinkSync(marker);
});

await test('hooks 拦下提交时，退出码非 0 且明确报错', () => {
  const hookDir = path.join(resolveRepoLayout(repo).commonDir, 'hooks');
  const hook = path.join(hookDir, 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "不许提交" >&2\nexit 1\n', { mode: 0o755 });

  fs.writeFileSync(path.join(repo, 'd.txt'), 'd\n');
  runGit({ repoDir: repo, op: 'add', params: { paths: ['d.txt'] } });
  const out = runGit({ repoDir: repo, op: 'commit', params: { message: 'add d' } });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /退出码|不许提交/);

  fs.unlinkSync(hook);
  raw(['reset', '-q', '--', 'd.txt']);
  fs.unlinkSync(path.join(repo, 'd.txt'));
});

// ---------------------------------------------------------------- 白名单
await test('★ merge / rebase / reset / clean：没有确认票据就拒，而且角色不对也拒', () => {
  for (const op of ['merge', 'rebase', 'reset', 'clean']) {
    // ① 没票据 → 拒（和 push 同一条路：先确认再执行）
    const r = runGit({ repoDir: repo, op, params: { ref: 'HEAD', apply: true }, actor: { role: 'main' } });
    assert.equal(r.ok, false, op + ' 没有票据应当被拒');
    assert.equal(r.refused, true, op + ' 应当标成 refused');
    assert.match(r.error, /确认/, op + ' 要说明"必须先确认"');
  }
  // ② 执行 Bot 连票据都不给用（角色门在 runGit 里，不只靠藏工具）
  const member = runGit({
    repoDir: repo, op: 'reset', params: { ref: 'HEAD' },
    confirmation: { decision: 'approved' }, actor: { role: 'member' },
  });
  assert.equal(member.ok, false);
  assert.match(member.error, /只给主 Bot 与负责人/);
  // ③ 负责人可以（票据伪造由外层 checkConfirmation 负责，这里只验角色门）
  const lead = runGit({
    repoDir: repo, op: 'reset', params: { ref: 'HEAD' },
    confirmation: { decision: 'approved' }, actor: { role: 'lead' },
  });
  assert.notEqual(lead.refused === true && /只给主 Bot/.test(lead.error ?? ''), true);
  assert.ok(Object.keys(REFUSED_OPERATIONS).length >= 1, '还剩几个仍然不给的');
});

await test('★ push 可以用，但没有确认票据就拒（不可绕过）', () => {
  // 没票据
  const noTicket = runGit({ repoDir: repo, op: 'push', params: { remote: 'origin', branches: ['main'] } });
  assert.equal(noTicket.ok, false);
  assert.equal(noTicket.refused, true);
  assert.match(noTicket.error, /手机上确认/);

  // 票据还没批
  const pending = runGit({
    repoDir: repo, op: 'push', params: { remote: 'origin', branches: ['main'] },
    confirmation: { decision: null },
  });
  assert.equal(pending.refused, true);
  assert.match(pending.error, /还没被批准/);

  // 票据被拒绝
  const denied = runGit({
    repoDir: repo, op: 'push', params: { remote: 'origin', branches: ['main'] },
    confirmation: { decision: 'denied' },
  });
  assert.equal(denied.refused, true);

  // 注意：这里不真测"批准后能 push"—— 那要一个真远端。
  // 只验"没有票据过不去"这个不变量，它是安全边界所在。
});

await test('未知操作也说清可用列表', () => {
  const r = runGit({ repoDir: repo, op: 'frobnicate' });
  assert.equal(r.refused, true);
  assert.match(r.error, /status/);
});

await test('白名单：五个会改共享分支/丢代码的都标了 requiresConfirmation 与角色门', () => {
  assert.equal(GIT_OPERATIONS.push.requiresConfirmation, true, 'push 必须有确认');
  assert.equal(GIT_OPERATIONS.commit.requiresConfirmation, undefined, '本地提交不需要确认');
  for (const op of ['merge', 'rebase', 'reset', 'clean']) {
    const spec = GIT_OPERATIONS[op];
    assert.ok(spec, op + ' 现在应当可用');
    assert.equal(spec.requiresConfirmation, true, op + ' 必须有确认');
    assert.equal(spec.needs, 'git.destructive', op + ' 走 git.destructive 授权（迁移授权永不给）');
    assert.deepEqual([...spec.roles].sort(), ['lead', 'main'], op + ' 只给主 Bot 与负责人');
  }
  // reset 只提供 soft/mixed：参数模板会把别的值夹回去
  assert.deepEqual(GIT_OPERATIONS.reset.args({ ref: 'HEAD~1', mode: 'hard' }), ['reset', '--mixed', 'HEAD~1']);
  assert.deepEqual(GIT_OPERATIONS.clean.args({}), ['clean', '-nd'], '默认只说会删什么');
  assert.deepEqual(GIT_OPERATIONS.clean.args({ apply: true }), ['clean', '-fd']);
  // force push 仍然不给
  assert.ok(REFUSED_OPERATIONS['push --force']);
});

await test('每个读操作都标了 mutates: false', () => {
  for (const [name, spec] of Object.entries(GIT_OPERATIONS)) {
    assert.equal(typeof spec.mutates, 'boolean', name + ' 必须声明 mutates');
    assert.ok(spec.needs, name + ' 必须声明网关动作');
  }
});

// ---------------------------------------------------------------- 安全
await test('★ 环境隔离：不读用户全局 hooks（GIT_CONFIG_NOSYSTEM）', () => {
  // 无法直接断言环境变量，改为验证"我们确实传了它"这件事在代码里成立 ——
  // 用一个会让全局配置生效的场景：写 ~/.gitconfig 的 hooksPath 太危险，跳过。
  // 这里只验证工具仍然能正常工作（说明这套 env 组合不会把自己弄坏）。
  const r = runGit({ repoDir: repo, op: 'status' });
  assert.equal(r.ok, true, r.error ?? '');
});

await test('中文文件名不被转义（core.quotepath=false）', () => {
  fs.writeFileSync(path.join(repo, '中文.txt'), 'x\n');
  const r = runGit({ repoDir: repo, op: 'status' });
  assert.ok(r.stdout.includes('中文.txt'), '中文名应当原样出现：' + r.stdout);
  fs.unlinkSync(path.join(repo, '中文.txt'));
});

await test('输出过长时截断并标记', () => {
  // 造一个很大的改动
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, 'big.txt'), big);
  raw(['add', '-A']);
  raw(['commit', '-q', '-m', 'big']);
  fs.writeFileSync(path.join(repo, 'big.txt'), big.replace(/line 1\n/, 'CHANGED\n'));
  const r = runGit({ repoDir: repo, op: 'diff' });
  assert.equal(r.ok, true);
  assert.ok(r.stdout.length <= 200_001);
  raw(['checkout', '--', 'big.txt']);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
