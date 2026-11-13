/**
 * Windows 沙箱：Node 侧封装的单测。
 *   node tests/sandbox-win.mjs
 *
 * 这些用例**不需要**真的跑起沙箱（非 Windows 也全过）：
 * 它们验证的是参数构造、错误码映射、拒绝规则、profile 派生。
 * 真机 12 项验收见 docs/WINDOWS-SANDBOX.md 的「验收」一节，
 * 需要 Windows + 编译好的 pibot-sandbox.exe。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, err: err?.message || String(err) }); }
}

const {
  LAUNCHER_VERSION, launcherCandidates, launcherPath, verifyLauncher,
  profileNameFor, probeWindowsSandbox, wrapWindowsCommand, windowsSandboxMessage,
  defaultWindowsInstanceDir, revokeWindowsGrant, deleteWindowsProfile, teardownWindowsInstance,
} = await import('../src/sandbox-win.js');
const { probeSandbox, wrapCommand, SANDBOX_UNAVAILABLE } = await import('../src/sandbox.js');
const { sandboxUnavailableMessage } = await import('../src/mcp-access.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sbx-win-'));
const workDir = path.join(root, 'work');
const instDir = path.join(root, 'inst');
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(instDir, { recursive: true });

// ────────────────── 探测与校验 ──────────────────

await test('探测：非 Windows 上明确说 unsupported_platform', () => {
  if (process.platform === 'win32') return;
  const p = probeWindowsSandbox();
  assert.equal(p.available, false);
  assert.equal(p.kind, 'appcontainer');
  assert.equal(p.reason, 'unsupported_platform');
});

await test('探测：启动器候选路径包含发行包与开发目录两种布局', () => {
  const list = launcherCandidates();
  assert.ok(list.length >= 2);
  assert.ok(list.some((p) => p.includes('resources')), '发行包布局');
  assert.ok(list.some((p) => p.includes(path.join('native', 'pibot-sandbox'))), '开发布局');
});

await test('★ 启动器不存在时 verifyLauncher 返回 no_binary（fail-closed，不猜）', () => {
  assert.equal(verifyLauncher('').reason, 'no_binary');
  assert.equal(verifyLauncher(null).reason, 'no_binary');
  assert.equal(verifyLauncher(path.join(root, 'nope.exe')).reason, 'launcher_broken');
});

await test('★ 已装的启动器与 native 源码同步（防止改 Rust 忘重装，测试假过）', async () => {
  // review 踩过：改了 native/pibot-sandbox/src/main.rs 却没重新跑
  // scripts/build-sandbox-win.ps1，server/resources 里还是旧 exe，
  // 于是新加的拒绝规则测不出来、测试"通过"但实际是旧的。
  if (process.platform !== 'win32') return;
  const crateExe = path.join(import.meta.dirname, '..', '..', 'native', 'pibot-sandbox', 'target', 'release', 'pibot-sandbox.exe');
  const shippedExe = path.join(import.meta.dirname, '..', 'resources', 'pibot-sandbox.exe');
  if (!fs.existsSync(crateExe) || !fs.existsSync(shippedExe)) return; // 没编译过就跳过
  const a = fs.statSync(crateExe);
  const b = fs.statSync(shippedExe);
  assert.equal(a.size, b.size,
    `server/resources/pibot-sandbox.exe 与编译产物大小不同（${b.size} vs ${a.size}）——`
    + ' 改了 Rust 就重跑 scripts/build-sandbox-win.ps1');
  // 内容哈希也要一致（大小相同但内容不同同样是旧件）
  const crypto = await import('node:crypto');
  const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.equal(h(shippedExe), h(crateExe), 'server/resources 里的启动器不是最新编译产物');
});

await test('★ 默认工作目录（<dataDir>/workspace）必须能授权', () => {
  // 这条是打开发行包时抓到的：review 时把 `%LOCALAPPDATA%\pi-bot` 列进敏感
  // 目录，结果每一个默认配置的 bot 都是 WORKDIR_IS_SENSITIVE —— 而
  // config.js 的默认 workspace 就是 <dataDir>/workspace。
  if (process.platform !== 'win32') return;
  const exe = launcherPath();
  if (!exe) return;
  const dataDir = path.join(root, 'data');
  const ws = path.join(dataDir, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  const ok = spawnSync(exe, ['grant', '--profile', 'pi-bot.sbx.test.default-ws',
    '--path', ws, '--mode', 'rw', '--data-dir', dataDir],
  { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(ok.status, 0, `默认工作目录被拒了：${(ok.stderr || '').slice(0, 160)}`);

  // dataDir 本身仍然必须拒（用混写分隔符验证归一化）
  const mixed = dataDir.replace(/\\/g, '/');
  const bad = spawnSync(exe, ['grant', '--profile', 'pi-bot.sbx.test.default-ws',
    '--path', mixed, '--mode', 'rw', '--data-dir', mixed],
  { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.notEqual(bad.status, 0, 'dataDir 本身不该被授权');
  assert.match(bad.stderr || '', /PROTECTED/,
    `混写斜杠绕过了 dataDir 保护：${(bad.stderr || '').slice(0, 160)}`);
});

await test('★ 版本号常量与启动器 Cargo.toml 一致', () => {
  // 版本不一致会让 Node 与 exe 的约束悄悄漂移，所以两边必须同一个值。
  const cargo = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'native', 'pibot-sandbox', 'Cargo.toml'), 'utf8',
  );
  const m = /^version\s*=\s*"([^"]+)"/m.exec(cargo);
  assert.ok(m, 'Cargo.toml 里应有 version');
  assert.equal(m[1], LAUNCHER_VERSION);
});

await test('探测：Windows 上没有 exe 时 available=false + no_binary', () => {
  if (process.platform !== 'win32') return;
  const saved = process.env.PIBOT_SANDBOX_EXE;
  // 指向不存在的路径，模拟"发行包里缺启动器"
  process.env.PIBOT_SANDBOX_EXE = path.join(root, 'missing.exe');
  try {
    // 注意：launcherCandidates 里还有开发/发行两条兜底，机器上真装了
    // 启动器时这条会拿到真路径 —— 这里只要求"结果自洽"。
    const p = probeWindowsSandbox();
    assert.equal(typeof p.available, 'boolean');
    if (!p.available) assert.ok(p.reason);
  } finally {
    if (saved === undefined) delete process.env.PIBOT_SANDBOX_EXE;
    else process.env.PIBOT_SANDBOX_EXE = saved;
  }
});

// ────────────────── profile 与实例目录 ──────────────────

await test('★ 每实例一个 profile：两个实例名不同', () => {
  const a = profileNameFor(defaultWindowsInstanceDir(root, 'a'));
  const b = profileNameFor(defaultWindowsInstanceDir(root, 'b'));
  assert.notEqual(a, b);
});

await test('★ profile 名稳定（同一实例重启后不变，否则 ACE 会重授）', () => {
  const dir = defaultWindowsInstanceDir(root, 'a');
  assert.equal(profileNameFor(dir), profileNameFor(dir));
});

await test('profile 名只含安全字符，带 12 位哈希后缀', () => {
  const weird = 'C:\\data\\instances\\房 间/bot#1';
  const p = profileNameFor(weird);
  assert.match(p, /^pi-bot\.sbx\.[A-Za-z0-9_-]+\.[0-9a-f]{12}$/);
  // 实测：CreateAppContainerProfile 对 56 字符的名字也能成功，
  // 但为了留余量还是把 key 部分限到 40 字符（见 profileNameFor）。
  assert.ok(p.length <= 'pi-bot.sbx.'.length + 40 + 13, `AppContainer 名太长：${p.length}`);
});

await test('实例目录落在 dataDir/instances/<key>', () => {
  const dir = defaultWindowsInstanceDir(root, 'bot-1');
  assert.equal(dir, path.join(root, 'instances', 'bot-1'));
  // key 里的路径分隔符不能带进目录名
  assert.ok(!defaultWindowsInstanceDir(root, 'a/b').includes('/b'));
});

// ────────────────── 命令包装 ──────────────────

await test('★ 包装出来的命令走 run 子命令，参数齐全', () => {
  if (process.platform !== 'win32') return;
  const w = wrapWindowsCommand({
    command: 'echo hi', workDir, instanceDir: instDir, dataDir: root,
  });
  if (!w.ok) {
    // 机器上没有启动器 —— 必须是明确拒绝，不能返回一个假的 ok
    assert.ok(w.reason, '失败必须带 reason');
    return;
  }
  try {
    assert.ok(w.args.includes('run'));
    for (const flag of ['--profile', '--workdir', '--instance', '--shell', '--cmd-file']) {
      assert.ok(w.args.includes(flag), `缺 ${flag}`);
    }
    assert.equal(w.args[w.args.indexOf('--shell') + 1], 'powershell', 'v0 只交付 powershell');
    const cmdFile = w.args[w.args.indexOf('--cmd-file') + 1];
    assert.equal(fs.readFileSync(cmdFile, 'utf8'), 'echo hi', '命令要原样写进文件');
  } finally {
    w.cleanup?.();
  }
});

await test('★ 命令文件用完能被清理（cleanup 幂等）', () => {
  if (process.platform !== 'win32') return;
  const w = wrapWindowsCommand({ command: 'x', workDir, instanceDir: instDir });
  if (!w.ok) return;
  const cmdFile = w.args[w.args.indexOf('--cmd-file') + 1];
  assert.ok(fs.existsSync(cmdFile));
  w.cleanup();
  assert.equal(fs.existsSync(cmdFile), false);
  w.cleanup(); // 再调一次不能抛
});

await test('★ 命令里的引号 / 换行不会跑到命令行上（走文件传递）', () => {
  if (process.platform !== 'win32') return;
  const nasty = 'Write-Output "a b"; Write-Output \'c"d\'\nWrite-Output `n';
  const w = wrapWindowsCommand({ command: nasty, workDir, instanceDir: instDir });
  if (!w.ok) return;
  try {
    const cmdFile = w.args[w.args.indexOf('--cmd-file') + 1];
    assert.equal(fs.readFileSync(cmdFile, 'utf8'), nasty);
    assert.ok(!w.args.some((a) => a.includes('Write-Output')), '命令不该出现在 argv 里');
  } finally {
    w.cleanup?.();
  }
});

await test('★ 没有 instanceDir 时明确失败（不默默用临时目录）', () => {
  if (process.platform !== 'win32') return;
  const w = wrapWindowsCommand({ command: 'x', workDir, instanceDir: '' });
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'no_instance_dir');
});

await test('dataDir 通过 --data-dir 传给启动器（拒绝规则要用它）', () => {
  if (process.platform !== 'win32') return;
  const w = wrapWindowsCommand({ command: 'x', workDir, instanceDir: instDir, dataDir: root });
  if (!w.ok) return;
  try {
    assert.ok(w.args.includes('--env'));
    assert.ok(w.args.some((a) => a.startsWith('PIBOT_DATA_DIR=')));
  } finally {
    w.cleanup?.();
  }
});

// ────────────────── 错误码文案 ──────────────────

await test('★ 启动器错误码都有可读文案（不含"undefined"/占位符）', () => {
  const codes = [
    'no_binary', 'launcher_broken', 'launcher_version_mismatch', 'launcher_hash_mismatch',
    'PROFILE_FAILED', 'ACE_READ_FAILED', 'ACE_WRITE_FAILED', 'ACE_BUILD_FAILED', 'ACE_PROTECT_FAILED',
    'WORKDIR_IS_DRIVE_ROOT', 'WORKDIR_IS_UNC', 'PATH_MISSING', 'PATH_INVALID',
    'JOB_FAILED', 'JOB_LIMIT_FAILED', 'JOB_ASSIGN_FAILED', 'CREATE_FAILED', 'ATTR_FAILED',
    'BAD_SHELL', 'CMD_FILE_FAILED', 'INSTANCE_MKDIR_FAILED', 'UNSUPPORTED_PLATFORM',
  ];
  for (const code of codes) {
    const msg = windowsSandboxMessage(code);
    assert.ok(msg.length > 8, `${code} 文案太短：${msg}`);
    assert.ok(!/undefined|\[object/.test(msg), `${code} 文案里漏了变量：${msg}`);
  }
});

await test('未知错误码也给兜底文案，并带上原始码', () => {
  const msg = windowsSandboxMessage('WEIRD_NEW_CODE');
  assert.match(msg, /WEIRD_NEW_CODE/);
  assert.match(msg, /拒绝执行/);
});

await test('★ mcp-access 的文案：Windows 码走 Windows 文案', () => {
  assert.match(sandboxUnavailableMessage('WORKDIR_IS_DRIVE_ROOT'), /盘符根/);
  assert.match(sandboxUnavailableMessage('PROFILE_FAILED'), /AppContainer/);
  // 非 Windows 的老码仍然能翻
  assert.match(sandboxUnavailableMessage('unsupported_platform'), /拒绝执行/);
  assert.match(sandboxUnavailableMessage('no_binary'), /bubblewrap|sandbox-exec|pibot-sandbox/);
});

// ────────────────── sandbox.js 的接线 ──────────────────

await test('★ probeSandbox 在 Windows 上返回 appcontainer（不是 none）', () => {
  if (process.platform !== 'win32') return;
  const p = probeSandbox();
  assert.equal(p.kind, 'appcontainer');
  assert.equal(typeof p.available, 'boolean');
  if (!p.available) assert.ok(p.reason);
});

await test('★ wrapCommand 在 Windows 上走 AppContainer 分支（不再返回 unsupported_platform）', () => {
  if (process.platform !== 'win32') return;
  const w = wrapCommand({ command: 'echo hi', workDir, tmpDir: path.join(instDir, 'tmp'), instanceDir: instDir });
  if (!w.ok) {
    assert.notEqual(w.reason, SANDBOX_UNAVAILABLE.UNSUPPORTED_PLATFORM, 'Windows 不该再报平台不支持');
    assert.ok(w.reason);
    return;
  }
  try {
    assert.ok(w.args.includes('run'), '应转到 pibot-sandbox run');
    assert.equal(typeof w.cleanup, 'function');
  } finally {
    w.cleanup?.();
  }
});

await test('★ 工作目录不安全时，Windows 分支同样先拒绝（共用 assertSafeWorkDir）', () => {
  if (process.platform !== 'win32') return;
  const w = wrapCommand({ command: 'echo hi', workDir: os.homedir(), tmpDir: instDir, instanceDir: instDir });
  assert.equal(w.ok, false, 'home 当工作目录必须拒绝');
  assert.match(w.reason, /workdir_/);
});

await test('★ 实例收尾：revoke + 删 profile 两步都走到（幂等）', () => {
  if (process.platform !== 'win32') {
    assert.equal(teardownWindowsInstance({ instanceDir: instDir, workDir }).skipped, true);
    return;
  }
  const r = teardownWindowsInstance({ instanceDir: instDir, workDir });
  assert.equal(typeof r.ok, 'boolean');
  assert.deepEqual(r.steps.map((s) => s.step), ['revoke', 'delete-profile']);
  // 再跑一次不能因为 profile 已删而失败（卸载脚本会重跑）
  const again = teardownWindowsInstance({ instanceDir: instDir, workDir });
  assert.equal(again.steps.at(-1).ok, true, '重复删除 profile 应当仍然成功');
});

await test('删 profile：没有启动器时返回 no_binary 而不是抛', () => {
  if (process.platform !== 'win32') {
    assert.equal(deleteWindowsProfile({ instanceDir: instDir }).skipped, true);
    return;
  }
  const r = deleteWindowsProfile({ instanceDir: instDir });
  assert.equal(typeof r.ok, 'boolean');
  if (!r.ok) assert.ok(r.reason);
});

await test('撤销授权：没有启动器时返回 no_binary 而不是抛', () => {
  if (process.platform !== 'win32') {
    assert.equal(revokeWindowsGrant({ instanceDir: instDir, workDir }).skipped, true);
    return;
  }
  const r = revokeWindowsGrant({ instanceDir: instDir, workDir });
  assert.equal(typeof r.ok, 'boolean');
  if (!r.ok) assert.ok(r.reason);
});

// ────────────────── review 补的回归用例 ──────────────────

await test('★ 小写错误码走 Windows 专属文案，不落进通用兜底', () => {
  // review 发现的：mcp-access 只把全大写码转给 windowsSandboxMessage，
  // launcher_broken / cmd_file_failed 这些落进了"沙箱启动失败（code）"。
  const lower = [
    'launcher_broken', 'launcher_version_mismatch', 'launcher_hash_mismatch',
    'cmd_file_failed', 'instance_mkdir_failed', 'no_instance_dir', 'selfcheck_failed',
  ];
  for (const code of lower) {
    const msg = windowsSandboxMessage(code);
    assert.ok(!/^沙箱启动失败（/.test(msg), `${code} 落进了通用兜底：${msg}`);
    assert.ok(msg.length > 10, `${code} 文案太短`);
  }
});

await test('★ selfcheck 结果有缓存（避免每条命令都付一次进程启动）', async () => {
  if (process.platform !== 'win32') return;
  const { clearSelfcheckCache } = await import('../src/sandbox-win.js');
  clearSelfcheckCache();
  const dir = path.join(root, 'cache-probe');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  probeWindowsSandbox({ instanceDir: dir });
  const cold = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 3; i++) probeWindowsSandbox({ instanceDir: dir });
  const warm = Date.now() - t1;
  assert.ok(warm < cold + 50, `缓存没生效：cold=${cold}ms warm(3x)=${warm}ms`);
});

await test('★ 敏感目录连子目录一起拒（~/.ssh 不能当工作目录）', () => {
  if (process.platform !== 'win32') return;
  // 拒绝规则的**权威实现在启动器里**（要按 canonical 路径判），
  // 所以这条直接调 `grant` 验证，而不是看 wrapWindowsCommand（它不做这个判断）。
  const exe = launcherPath();
  if (!exe) return; // 机器上没编译启动器，跳过
  const sshSub = path.join(os.homedir(), '.ssh', 'nested');
  try { fs.mkdirSync(sshSub, { recursive: true }); } catch { /* 可能无权 */ }
  const res = spawnSync(exe, ['grant', '--profile', 'pi-bot.sbx.test.sensitive', '--path', sshSub, '--mode', 'rw'],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.notEqual(res.status, 0, '~/.ssh 的子目录不该被授权');
  assert.match(res.stderr || '', /SENSITIVE|PROTECTED/,
    `实际 stderr=${(res.stderr || '').slice(0, 120)}`);
});

await test('★ 正常子目录仍放行（~/xxx 不该被敏感规则误伤）', () => {
  if (process.platform !== 'win32') return;
  const exe = launcherPath();
  if (!exe) return;
  const ok = path.join(os.homedir(), '.pi-bot-test-workdir');
  fs.mkdirSync(ok, { recursive: true });
  try {
    const res = spawnSync(exe, ['grant', '--profile', 'pi-bot.sbx.test.normal', '--path', ok, '--mode', 'rw'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    // 成功，或者失败原因**不是**敏感目录（可能是权限等其它原因）
    if (res.status !== 0) {
      assert.doesNotMatch(res.stderr || '', /SENSITIVE/, `误伤了正常目录：${res.stderr}`);
    }
  } finally {
    try { fs.rmSync(ok, { recursive: true }); } catch { /* 忽略 */ }
  }
});

await test('★ worktree 的 .git 是文件时不能崩（这是 bot 隔离要用的机制）', () => {
  // 实测踩过：protect_git_metadata 把 `.git` 当目录处理，
  // worktree 里 `.git` 是文件（内容 "gitdir: ..."），于是建 hooks 失败、
  // 整个 run 直接 fail-closed —— 而 worktree 正是文件隔离的首选方案。
  if (process.platform !== 'win32') return;
  const exe = launcherPath();
  if (!exe) return;
  const { spawnSync: run } = { spawnSync };
  const repo = path.join(root, 'wt-repo');
  const wt = path.join(root, 'wt-child');
  fs.mkdirSync(repo, { recursive: true });
  const git = (a, c) => run('git', a, { cwd: c, encoding: 'utf8', windowsHide: true });
  git(['init', '-q', '.'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  git(['add', '-A'], repo);
  git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo);
  const add = git(['worktree', 'add', '-q', wt, '-b', 'bot/test-wt'], repo);
  if (add.status !== 0) return; // 机器上没有 git，跳过
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), '.git 应该是文件');

  const inst = path.join(root, 'wt-inst');
  fs.mkdirSync(inst, { recursive: true });
  const script = path.join(inst, 'c.ps1');
  fs.writeFileSync(script, [
    "Set-Content -LiteralPath 'a.txt' -Value 'changed' -ErrorAction Stop",
    "Write-Output 'WT_OK'",
  ].join(String.fromCharCode(10)));
  const r = run(exe, ['run', '--profile', 'pi-bot.sbx.wt-test', '--workdir', wt, '--instance', inst,
    '--shell', 'powershell', '--cmd-file', script], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.doesNotMatch(out, /GIT_HOOKS_MKDIR_FAILED/, 'worktree 的 .git 文件被当目录了');
  assert.match(out, /WT_OK/, 'worktree 里写文件失败：' + out.slice(0, 200));
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8').trim(), 'changed');
  git(['worktree', 'remove', '--force', wt], repo);
});

// ────────────────── 结果 ──────────────────

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exitCode = 1;
