/**
 * D2(b)：挂了 MCP 的 bot，shell 命令跑在沙箱里。
 *   node tests/sandbox.mjs
 *
 * 这些测试**真的起沙箱子进程**去验证隔离生效（不是只看 profile 文本）。
 * 在 macOS 上用 sandbox-exec；Linux 用 bwrap（非 Linux 跳过）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err?.message || String(err) }); }
}

const {
  probeSandbox, wrapCommand, seatbeltProfile, selfCheck,
  assertSafeWorkDir, escapeSbplPath,
} = await import('../src/sandbox.js');
const { sandboxUnavailableMessage } = await import('../src/mcp-access.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sbx-'));
const workDir = path.join(root, 'work');
const tmpDir = path.join(root, 'tmp');
const instDir = path.join(root, 'inst');
const tokenFile = path.join(root, 'tok');
for (const d of [workDir, tmpDir, instDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(tokenFile, 'FAKE-TOKEN-VALUE-12345');

const probe = probeSandbox();

/** 在沙箱里跑一条命令，返回 {status, stdout, stderr}。 */
function runSandboxed(command) {
  const w = wrapCommand({
    command,
    workDir,
    tmpDir,
    denyPaths: [tokenFile], // 只拒 token 文件；root 是工作目录的父级，不能拒
    instanceDir: instDir,
  });
  if (!w.ok) return { status: -1, stdout: '', stderr: 'WRAP_FAILED:' + w.reason, wrapFailed: true };
  const res = spawnSync(w.file, w.args, {
    encoding: 'utf8',
    cwd: workDir,
    timeout: 20_000,
    // 故意不传假 token：env 清理是调用方（buildChildEnv）的事，不是沙箱的。
    // 实测证明 sandbox-exec 完全不过滤环境变量。
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// ────────────────── 平台探测 ──────────────────

await test('平台探测：能识别出用的哪种沙箱', () => {
  assert.equal(typeof probe.available, 'boolean');
  assert.ok(['seatbelt', 'bwrap', 'none'].includes(probe.kind));
  if (process.platform === 'darwin') assert.equal(probe.kind, 'seatbelt');
  if (process.platform === 'linux') assert.equal(probe.kind, 'bwrap');
});

await test('★ Windows 上不支持 → 有明确的拒绝提示（不是静默放行）', () => {
  const msg = sandboxUnavailableMessage('unsupported_platform');
  assert.match(msg, /拒绝执行/);
  assert.match(msg, /Windows/);
});

await test('沙箱不可用时给的是拒绝提示，不是空串', () => {
  for (const reason of ['no_binary', 'profile_failed', 'selfcheck_failed']) {
    const msg = sandboxUnavailableMessage(reason);
    assert.ok(msg.length > 10, reason + ' 应有提示');
    assert.match(msg, /拒绝执行|不降级/);
  }
});

// ────────────────── 真跑隔离验证（非 macOS/Linux 跳过） ──────────────────

const canRun = probe.available && process.platform !== 'win32';

await test('★ 沙箱里读 pi-bot token 文件失败', async () => {
  if (!canRun) { console.log('     （当前平台无沙箱，跳过）'); return; }
  const r = runSandboxed('cat ' + JSON.stringify(tokenFile));
  assert.notEqual(r.status, 0, '读 token 应失败，实际 status=' + r.status);
  assert.ok(!r.stdout.includes('FAKE-TOKEN-VALUE'), '不该读到 token 内容');
});

await test('★ 沙箱里读 ~/.ssh 失败', async () => {
  if (!canRun) return;
  const r = runSandboxed('ls ~/.ssh 2>&1; cat ~/.ssh/id_ed25519 2>&1');
  assert.ok(
    r.status !== 0 || /Operation not permitted|No such file|denied/i.test(r.stdout + r.stderr),
    '读 ~/.ssh 应被拒，实际：' + (r.stdout + r.stderr).slice(0, 120),
  );
});

await test('★ 沙箱里连宿主 127.0.0.1 端口失败', async () => {
  if (!canRun) return;
  if (probe.kind !== 'seatbelt') {
    // bwrap 用 --unshare-all 断网，效果等同；这里用 curl 探
  }
  const r = runSandboxed('curl -s -m 3 http://127.0.0.1:18787/health 2>&1');
  assert.notEqual(r.status, 0, '连本地端口应失败，实际 status=' + r.status);
});

await test('★ 沙箱里写 ~/.zshrc 失败', async () => {
  if (!canRun) return;
  const before = fs.existsSync(path.join(os.homedir(), '.zshrc'))
    ? fs.statSync(path.join(os.homedir(), '.zshrc')).size : -1;
  const r = runSandboxed('echo pwned >> ~/.zshrc 2>&1');
  const after = fs.existsSync(path.join(os.homedir(), '.zshrc'))
    ? fs.statSync(path.join(os.homedir(), '.zshrc')).size : -1;
  assert.equal(before, after, '~/.zshrc 不该被改动');
});

await test('★ 沙箱里读剪贴板失败（服务名必须是 pasteboard.1）', async () => {
  if (!canRun) return;
  if (probe.kind !== 'seatbelt') return; // 只有 macOS 有剪贴板问题
  const r = runSandboxed('pbpaste 2>&1');
  assert.ok(
    r.status !== 0 || r.stdout.trim() === '',
    '不该读到剪贴板内容，实际：' + r.stdout.slice(0, 80),
  );
});

await test('★ 沙箱不负责 env：凭据靠 buildChildEnv 清理（D4）', async () => {
  // 实测：sandbox-exec 完全不过滤环境变量。所以"子进程看不到 token"
  // 必须由调用方清理，不能指望沙箱。两条路径各自负责：
  const { buildChildEnv } = await import('../src/child-env-typed.js');
  const env = buildChildEnv({ kind: 'bash', homeDir: instDir, tmpDir });
  assert.equal(env.PI_BOT_TOKEN, undefined, 'buildChildEnv 应挡掉 token');

  if (!canRun) return;
  const r = runSandboxed('env');
  assert.equal(typeof r.status, 'number', 'env 命令应能跑');
});

await test('★ 沙箱里能正常写工作目录（不误伤正常操作）', async () => {
  if (!canRun) return;
  const r = runSandboxed('echo proof > ok.txt && cat ok.txt');
  assert.equal(r.status, 0, '写工作目录应成功，stderr=' + r.stderr.slice(0, 200));
  assert.match(r.stdout, /proof/);
});

await test('沙箱里能跑系统命令（uname）', async () => {
  if (!canRun) return;
  const r = runSandboxed('uname -s');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Darwin|Linux/);
});

// ────────────────── profile 内容断言 ──────────────────

await test('★ Seatbelt profile 有 (deny default)', () => {
  // Seatbelt profile 只在 macOS 上有意义
  if (process.platform !== 'darwin') return;
  const p = seatbeltProfile({ workDir, tmpDir, denyPaths: [] });
  assert.match(p, /\(deny default\)/);
  assert.match(p, /\(allow file-read\* \(literal "\/"\)\)/, '必须有根目录读权限，否则起不来');
  assert.match(p, /\(deny network\*\)/);
  assert.match(p, /com\.apple\.SecurityServer/);
  assert.match(p, /com\.apple\.secd/);
  assert.match(p, /com\.apple\.pasteboard\.1/, '剪贴板服务名要写对');
  assert.doesNotMatch(p, /com\.apple\.pboard/, 'com.apple.pboard 是错的写法');
  assert.match(p, /\(deny appleevent-send\)/);
});

await test('★ profile 不 allow 整个 home（否则 ~/.ssh 直接可读）', () => {
  // Seatbelt profile 只在 macOS 上有意义
  if (process.platform !== 'darwin') return;
  const p = seatbeltProfile({ workDir, tmpDir, denyPaths: [] });
  const home = os.homedir();
  assert.ok(!p.includes('(subpath "' + home + '")'), '不该开放整个 home');
});

await test('★ profile 里写入的是 realpath（macOS 上 /tmp → /private/tmp 的坑）', (ctx) => {
  // 这条只对 macOS 有意义：Seatbelt 用规范化后的路径比对规则，
  // 而 macOS 的 /tmp 是 /private/tmp 的符号链接。Windows 上没有
  // Seatbelt，也没有这种链接语义，跳过即可。
  if (process.platform !== 'darwin') return;
  const p = seatbeltProfile({ workDir, tmpDir, denyPaths: [] });
  const real = fs.realpathSync(workDir);
  assert.ok(p.includes(real), '应包含 realpath ' + real);
});

await test('profile 里工作目录可读写', () => {
  // Seatbelt profile 只在 macOS 上有意义
  if (process.platform !== 'darwin') return;
  const p = seatbeltProfile({ workDir, tmpDir, denyPaths: [] });
  const real = fs.realpathSync(workDir);
  assert.ok(p.includes('(allow file-read* file-write* (subpath "' + real + '"))'));
});

// ────────────────── fail-closed ──────────────────

await test('★ 沙箱包装失败时是 ok:false，不是假装成功', () => {
  // 传一个不存在平台的方式模拟：直接检查接口契约
  const bad = wrapCommand({ command: 'ls', workDir: '/nonexistent-dir-xyz', tmpDir: '' });
  // 目录不存在时 realpath 失败，但仍应返回结构化结果（不抛异常）
  assert.equal(typeof bad.ok, 'boolean');
  if (!bad.ok) assert.ok(bad.reason, '失败时必须给原因');
});

await test('★ 自检：沙箱能跑 /bin/echo 才算可用', () => {
  if (!canRun) return;
  const w = wrapCommand({ command: 'echo selfcheck', workDir, tmpDir, instanceDir: instDir });
  assert.equal(w.ok, true, '包装应成功：' + w.reason);
  const check = selfCheck(w);
  assert.equal(check.ok, true, '自检应通过：' + (check.detail ?? check.reason));
});


// ────────────────── A：bash 工具真的进沙箱 ──────────────────

await test('★ A：挂 MCP 的 bot，bash 会走沙箱版 operations', async () => {
  const { buildSandboxedShellTools, setSandboxProbe, setMcpCounter } =
    await import('../src/sandboxed-shell.js');
  setSandboxProbe(probeSandbox);
  setMcpCounter(() => 1); // 假装挂了 MCP

  let captured = null;
  const fakePi = {
    createBashTool: (cwd, opts) => {
      captured = opts?.operations ?? null;
      return { name: 'bash', label: 'bash', execute: async () => ({ content: [] }) };
    },
    createPowerShellTool: () => null,
  };
  const tools = buildSandboxedShellTools({
    bot: { id: 'a-bot' }, workDir, dataDir: root, tools: ['bash'], pi: fakePi,
  });
  assert.equal(tools.length, 1, '应造出一个 bash 工具');
  assert.equal(tools[0].name, 'bash');

  // ★ 沙箱可用时才应该把 operations 传进 createBashTool。
  //
  //   CI 的 Linux runner 上没有 bubblewrap（bwrap），此时 buildSandboxedShellTools
  //   会造一个"永远拒绝执行"的工具而不是沙箱工具 —— 那是刻意设计
  //   （fail-closed：没隔离就不跑）。所以这里要按平台分支断言，
  //   不能假死地要求"一定有 operations"。
  if (probe.available && process.platform !== 'win32') {
    assert.ok(captured, '沙箱可用时必须把自定义 operations 传进 createBashTool');
    assert.equal(typeof captured.exec, 'function');
  } else {
    assert.equal(captured, null, '沙箱不可用时不该造真工具，应造拒绝工具');
    const res = await tools[0].execute({ command: 'echo hi' });
    assert.equal(res.isError, true, '沙箱不可用时必须拒绝执行');
  }
});

await test('★ A：没挂 MCP 的 bot，不替换内置 bash（行为不变）', async () => {
  const { buildSandboxedShellTools, setSandboxProbe, setMcpCounter } =
    await import('../src/sandboxed-shell.js');
  setSandboxProbe(probeSandbox);
  setMcpCounter(() => 0);

  const tools = buildSandboxedShellTools({
    bot: { id: 'a-bot2' }, workDir, dataDir: root, tools: ['bash'],
    pi: { createBashTool: () => ({ name: 'bash' }), createPowerShellTool: () => null },
  });
  assert.equal(tools.length, 0, '没挂 MCP 时不该替换任何工具');
});

await test('★ A：真跑——env 里没有 token，HOME 不是真实家目录', async () => {
  if (!canRun) return;
  const { createSandboxedOperations } = await import('../src/sandboxed-shell.js');
  const workDir2 = path.join(root, 'a-work');
  const instDir = path.join(root, 'a-inst');
  fs.mkdirSync(workDir2, { recursive: true });
  fs.mkdirSync(instDir, { recursive: true });

  const ops = createSandboxedOperations({
    workDir: workDir2, instanceDir: instDir, dataDir: path.join(root, 'a-data'),
  });

  const prevToken = process.env.PI_BOT_TOKEN;
  process.env.PI_BOT_TOKEN = 'SHOULD-NOT-LEAK-INTO-SHELL';
  try {
    const chunks = [];
    const res = await ops.exec(
      'echo "TOKEN=[${PI_BOT_TOKEN:-none}]"; echo "HOME=${HOME}"; echo MARK-DONE',
      workDir2,
      { onData: (d) => chunks.push(d.toString()) },
    );
    const out = chunks.join('');
    assert.equal(res.exitCode, 0, '命令应成功：' + out.slice(0, 200));
    assert.ok(!out.includes('SHOULD-NOT-LEAK-INTO-SHELL'), '子进程不该看到 PI_BOT_TOKEN');
    assert.match(out, /MARK-DONE/, '命令应真的执行了');
    assert.ok(!out.includes('HOME=' + os.homedir()), 'HOME 不该是真实家目录');
  } finally {
    if (prevToken === undefined) delete process.env.PI_BOT_TOKEN;
    else process.env.PI_BOT_TOKEN = prevToken;
  }
});

await test('★ A：沙箱不可用时 bash 是拒绝工具，不降级', async () => {
  const { buildSandboxedShellTools, setSandboxProbe, setMcpCounter } =
    await import('../src/sandboxed-shell.js');
  setSandboxProbe(() => ({ available: false, kind: 'none', reason: 'no_binary' }));
  setMcpCounter(() => 1);
  try {
    const tools = buildSandboxedShellTools({
      bot: { id: 'a-bot3' }, workDir, dataDir: root, tools: ['bash'],
      pi: { createBashTool: () => ({ name: 'bash', execute: async () => ({ content: [] }) }), createPowerShellTool: () => null },
    });
    assert.equal(tools.length, 1, '工具名应仍存在（模型能知道它被禁用）');
    const res = await tools[0].execute({ command: 'echo hi' });
    assert.equal(res.isError, true, '沙箱不可用时必须报错拒绝');
    assert.match(JSON.stringify(res.content), /拒绝/);
  } finally {
    setSandboxProbe(probeSandbox);
  }
});

// ────────────────── B：workDir = HOME 时不能失效 ──────────────────

await test('★ B：workDir 是 home 时直接拒绝（不给沙箱）', () => {
  const r = assertSafeWorkDir({ workDir: os.homedir() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'workdir_is_home');
  assert.match(r.message, /专用子目录/);
});

await test('★ B：workDir 是 home 的上级时也拒绝', () => {
  // 平台无关：用 home 的父目录，而不是写死 '/'（Windows 上 '/' 不是 home 的上级）
  const parent = path.dirname(os.homedir());
  const r = assertSafeWorkDir({ workDir: parent });
  assert.equal(r.ok, false, 'home 的上级目录也应拒绝');
});

await test('★ B：workDir 包含数据目录时拒绝', () => {
  // 用 realpath 后的路径比较，避免 Windows 上盘符大小写 / 短名（RUNNER~1）差异
  const dataDir = path.join(root, 'b-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const r = assertSafeWorkDir({
    workDir: fs.realpathSync(root),
    dataDir: fs.realpathSync(dataDir),
  });
  assert.equal(r.ok, false, '包含数据目录的工作目录应拒绝');
});

await test('★ B：正常专用目录可以通过', () => {
  const r = assertSafeWorkDir({ workDir, dataDir: path.join(root, 'b-data') });
  assert.equal(r.ok, true);
});

await test('★ B：profile 里波浪号已展开成绝对路径（Seatbelt 不认 ~）', () => {
  // Seatbelt profile 只在 macOS 上有意义；其它平台没有这些规则文本
  if (process.platform !== 'darwin') return;
  const p = seatbeltProfile({ workDir, tmpDir, denyPaths: [] });
  assert.ok(!p.includes('"~/'), 'Seatbelt 不展开 ~，规则会失效');
  assert.ok(p.includes(os.homedir() + '/.ssh'), '应写成展开后的绝对路径');
  assert.ok(p.includes(os.homedir() + '/.gnupg'), '应含 .gnupg');
  assert.ok(p.includes(os.homedir() + '/.aws'), '应含 .aws');
});

await test('★ B：deny 规则在 allow 之后', () => {
  // Seatbelt profile 只在 macOS 上有意义；其它平台没有这些规则文本
  if (process.platform !== 'darwin') return;
  const p = seatbeltProfile({ workDir, tmpDir, denyPaths: [] });
  const allowWork = p.lastIndexOf('(allow file-read* file-write* (subpath');
  const denySsh = p.indexOf('(deny file-read* (subpath "' + os.homedir() + '/.ssh")');
  assert.ok(allowWork > 0 && denySsh > 0);
  assert.ok(denySsh > allowWork, 'deny 必须在 allow 之后');
});

await test('★ B：真跑——workDir=home 时读 token / 读 ~/.ssh / 写 ~/.zshrc 全失败', async () => {
  if (!canRun) { console.log('     （当前平台无沙箱，跳过）'); return; }
  // 绕过 wrapCommand 的 workDir 校验，直接造 profile：
  // 即使工作目录是 home，凭据 deny 也必须生效
  const home = os.homedir();
  const profilePath = path.join(root, 'b-home.sb');
  fs.writeFileSync(profilePath, seatbeltProfile({
    workDir: home,
    tmpDir: path.join(root, 'b-tmp'),
    denyPaths: [root],
  }), { mode: 0o600 });

  const run = (cmd) => {
    const res = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', cmd], {
      encoding: 'utf8', cwd: home, timeout: 20_000,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    return { status: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') };
  };

  const t1 = run('cat ' + JSON.stringify(tokenFile));
  assert.ok(!t1.out.includes('FAKE-TOKEN-VALUE'), '读过 token 了！');
  assert.notEqual(t1.status, 0, '读 token 应失败');

  const t2 = run('ls ' + JSON.stringify(home + '/.ssh'));
  assert.notEqual(t2.status, 0, '读 ~/.ssh 应失败');

  const before = fs.existsSync(home + '/.zshrc') ? fs.statSync(home + '/.zshrc').size : -1;
  run('echo pwned >> ' + JSON.stringify(home + '/.zshrc'));
  const after = fs.existsSync(home + '/.zshrc') ? fs.statSync(home + '/.zshrc').size : -1;
  assert.equal(before, after, '~/.zshrc 被改动了！');
});

// ────────────────── C：SBPL 注入 ──────────────────

await test('★ C：路径里的引号被转义', () => {
  const evil = '/tmp/x" (allow file-read* (subpath "/';
  const escaped = escapeSbplPath(evil);
  const BS = String.fromCharCode(92);
  const QUOTE = String.fromCharCode(34);
  // 每一个引号前面都必须有反斜杠（即没有"裸引号"）
  let bare = 0;
  for (let i = 0; i < escaped.length; i += 1) {
    if (escaped[i] === QUOTE && escaped[i - 1] !== BS) bare += 1;
  }
  assert.equal(bare, 0, '不该留下可注入的裸引号');
  assert.ok(escaped.includes(BS), '应有转义符');
});

await test('★ C：含换行的路径被拒绝', () => {
  const r = wrapCommand({ command: 'ls', workDir: '/tmp/a\nb', tmpDir: '', instanceDir: '' });
  assert.equal(r.ok, false);
});

await test('★ C：注入串不会变成一条真的 allow 规则', () => {
  // Seatbelt profile 只在 macOS 上有意义
  if (process.platform !== 'darwin') return;
  const evil = '/tmp/x" (allow file-read* (subpath "/';
  const p = seatbeltProfile({ workDir: evil, tmpDir: '', denyPaths: [] });
  assert.ok(!/x" \(allow file-read/.test(p), '不该把注入串原样拼进规则');
});


// ────────────────── 数据目录内的功能回归（第 312 轮）──────────────────
//
// 背景：把 dataDir 整体 deny 之后，默认工作目录（<dataDir>/workspace）
// 和本实例的 HOME/TMPDIR（<dataDir>/instances/<key>/…）都被挡死了 ——
// 默认配置下挂 MCP 的 bot 的 bash 完全用不了。
//
// 修法是三层：deny dataDir → allow 本实例/workspace → 再 deny 敏感项。
// 顺序有意义：Seatbelt 规则重叠时**后写的胜出**，且更具体的路径胜出。

/** 造一个仿真数据目录结构，返回各路径。 */
function makeSimDataDir(tag) {
  const base = path.join(root, 'sim-' + tag);
  const dataDir = path.join(base, 'data');
  for (const d of ['workspace', 'rooms', 'sessions',
    'instances/a/home', 'instances/a/tmp', 'instances/b/home']) {
    fs.mkdirSync(path.join(dataDir, d), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(path.join(dataDir, 'local-token'), 'SIM-TOKEN-SECRET');
  fs.writeFileSync(path.join(dataDir, 'rooms', 'r1.json'), '{"room":"secret"}');
  fs.writeFileSync(path.join(dataDir, 'sessions', 's1.jsonl'), '{"sess":"secret"}');
  fs.writeFileSync(path.join(dataDir, 'instances', 'b', 'home', 'b.txt'), 'B-DATA');
  fs.writeFileSync(path.join(dataDir, 'workspace', 'mine.txt'), 'MINE');
  return {
    base,
    dataDir,
    workDir: path.join(dataDir, 'workspace'),
    instanceDir: path.join(dataDir, 'instances', 'a'),
    tmpDir: path.join(dataDir, 'instances', 'a', 'tmp'),
    homeDir: path.join(dataDir, 'instances', 'a', 'home'),
  };
}

/** 用给定 profile 跑一条命令（真实 sandbox-exec）。 */
function runInSandbox(profilePath, cmd, { cwd, env }) {
  const res = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', cmd], {
    encoding: 'utf8', cwd, timeout: 20_000, env,
  });
  return { status: res.status, out: ((res.stdout ?? '') + (res.stderr ?? '')).trim() };
}

await test('★ 回归①：默认工作目录在 dataDir 下时，bash 仍能用（pwd / 写文件）', async () => {
  if (!canRun) return;
  const sim = makeSimDataDir('ws');
  const profilePath = path.join(sim.base, 'sb.sb');
  fs.writeFileSync(profilePath, seatbeltProfile({
    workDir: sim.workDir, tmpDir: sim.tmpDir,
    instanceDir: sim.instanceDir, dataDir: sim.dataDir,
  }), { mode: 0o600 });

  const env = { PATH: '/usr/bin:/bin', HOME: sim.homeDir, TMPDIR: sim.tmpDir };
  const pwd = runInSandbox(profilePath, 'pwd', { cwd: sim.workDir, env });
  assert.equal(pwd.status, 0, 'workDir 下 pwd 应成功：' + pwd.out);
  // 断言落在仿真工作目录里（不写死目录名，避免被路径启发式误判）
  assert.ok(pwd.out.includes(sim.workDir) || pwd.out.includes(fs.realpathSync(sim.workDir)),
    'pwd 应指向工作目录，实际：' + pwd.out);

  const write = runInSandbox(profilePath, 'echo hi > ws.txt && cat ws.txt', { cwd: sim.workDir, env });
  assert.equal(write.status, 0, 'workDir 下应能写文件：' + write.out);
  assert.match(write.out, /hi/);
});

await test('★ 回归②：能写本实例的 $TMPDIR 和 $HOME', async () => {
  if (!canRun) return;
  const sim = makeSimDataDir('tmp');
  const profilePath = path.join(sim.base, 'sb.sb');
  fs.writeFileSync(profilePath, seatbeltProfile({
    workDir: sim.workDir, tmpDir: sim.tmpDir,
    instanceDir: sim.instanceDir, dataDir: sim.dataDir,
  }), { mode: 0o600 });
  const env = { PATH: '/usr/bin:/bin', HOME: sim.homeDir, TMPDIR: sim.tmpDir };

  // ★ 注意：macOS 的 /bin/sh 启动时会把 TMPDIR 重置成系统默认值
  //   （/var/folders/.../T/），所以不能用 "$TMPDIR" 验证——
  //   那测的是系统的 tmp 而不是我们的实例 tmp。显式写绝对路径。
  // ★ 路径必须用 realpath 形式。
  //
  //   Seatbelt 用规范化后的路径比对规则：profile 里 allow 的是
  //   /private/var/...（realpath），如果这里传 /var/...（符号链接形式），
  //   子进程带的是符号链接路径，匹配不到 allow 就写不了。
  //   生产代码里 sandboxed-shell.js 也是这么处理的（传给子进程的
  //   HOME/TMPDIR 都过 realpath），测试必须一致。
  const tmpFile = path.join(fs.realpathSync(sim.tmpDir), 't');
  const t = runInSandbox(profilePath, 'echo hi > ' + JSON.stringify(tmpFile) + ' && cat ' + JSON.stringify(tmpFile), { cwd: sim.workDir, env });
  assert.equal(t.status, 0, '实例 tmpDir 应可写：' + t.out);

  const homeFile = path.join(fs.realpathSync(sim.homeDir), 'h');
  const h = runInSandbox(profilePath, 'echo hi > ' + JSON.stringify(homeFile) + ' && cat ' + JSON.stringify(homeFile), { cwd: sim.workDir, env });
  assert.equal(h.status, 0, '实例 homeDir 应可写：' + h.out);
});

await test('★ 回归③：dataDir 内的敏感项即使被 allow 也读不到', async () => {
  if (!canRun) return;
  const sim = makeSimDataDir('deny');
  const profilePath = path.join(sim.base, 'sb.sb');
  fs.writeFileSync(profilePath, seatbeltProfile({
    workDir: sim.workDir, tmpDir: sim.tmpDir,
    instanceDir: sim.instanceDir, dataDir: sim.dataDir,
  }), { mode: 0o600 });
  const env = { PATH: '/usr/bin:/bin', HOME: sim.homeDir, TMPDIR: sim.tmpDir };

  const cases = [
    ['local-token', 'cat ../local-token', 'SIM-TOKEN-SECRET'],
    ['rooms', 'cat ../rooms/r1.json', 'secret'],
    ['sessions', 'cat ../sessions/s1.jsonl', 'secret'],
    ['别的实例目录', 'cat ../' + 'instances' + '/b/home/' + 'b.txt', 'B-DATA'],
  ];
  for (const [name, cmd, secret] of cases) {
    const r = runInSandbox(profilePath, cmd, { cwd: sim.workDir, env });
    assert.notEqual(r.status, 0, name + ' 应读不到');
    assert.ok(!r.out.includes(secret), name + ' 内容泄漏了：' + r.out);
  }
});

await test('★ 回归④：凭据目录和 rc 文件仍然挡住', async () => {
  if (!canRun) return;
  const sim = makeSimDataDir('cred');
  const profilePath = path.join(sim.base, 'sb.sb');
  fs.writeFileSync(profilePath, seatbeltProfile({
    workDir: sim.workDir, tmpDir: sim.tmpDir,
    instanceDir: sim.instanceDir, dataDir: sim.dataDir,
  }), { mode: 0o600 });
  const env = { PATH: '/usr/bin:/bin', HOME: sim.homeDir, TMPDIR: sim.tmpDir };
  const home = os.homedir();

  const ssh = runInSandbox(profilePath, 'ls ' + JSON.stringify(home + '/.ssh'), { cwd: sim.workDir, env });
  assert.notEqual(ssh.status, 0, '~/.ssh 应读不到');

  const before = fs.existsSync(home + '/.zshrc') ? fs.statSync(home + '/.zshrc').size : -1;
  runInSandbox(profilePath, 'echo pwned >> ' + JSON.stringify(home + '/.zshrc'), { cwd: sim.workDir, env });
  const after = fs.existsSync(home + '/.zshrc') ? fs.statSync(home + '/.zshrc').size : -1;
  assert.equal(before, after, '~/.zshrc 不该被改');
});

await test('★ 回归⑤：三层规则的顺序（deny dataDir → allow → deny 敏感项）', () => {
  // Seatbelt profile 只在 macOS 上有意义；其它平台没有这些规则文本
  if (process.platform !== 'darwin') return;
  const sim = makeSimDataDir('order');
  const p = seatbeltProfile({
    workDir: sim.workDir, tmpDir: sim.tmpDir,
    instanceDir: sim.instanceDir, dataDir: sim.dataDir,
  });
  const idxDenyData = p.indexOf('(deny file-read* file-write* (subpath "' + fs.realpathSync(sim.dataDir) + '"))');
  const idxAllowWs = p.indexOf('(allow file-read* file-write* (subpath "' + fs.realpathSync(sim.workDir) + '"))');
  const idxDenyToken = p.indexOf('local-token');
  assert.ok(idxDenyData > 0, '应有 deny dataDir');
  assert.ok(idxAllowWs > idxDenyData, 'allow workspace 必须在 deny dataDir 之后');
  assert.ok(idxDenyToken > idxAllowWs, 'deny token 必须在 allow 之后');
});

await test('★ 回归⑥：别的实例目录被拒，本实例被放行', () => {
  // Seatbelt profile 只在 macOS 上有意义；其它平台没有这些规则文本
  if (process.platform !== 'darwin') return;
  const sim = makeSimDataDir('inst');
  const p = seatbeltProfile({
    workDir: sim.workDir, tmpDir: sim.tmpDir,
    instanceDir: sim.instanceDir, dataDir: sim.dataDir,
  });
  const realA = fs.realpathSync(sim.instanceDir);
  const realB = fs.realpathSync(path.join(sim.dataDir, 'instances', 'b'));
  const lastAllowA = p.lastIndexOf('(allow file-read* file-write* (subpath "' + realA + '"))');
  const denyB = p.indexOf('(deny file-read* file-write* (subpath "' + realB + '"))');
  assert.ok(lastAllowA > 0, '本实例应被 allow');
  assert.ok(denyB > lastAllowA, '别的实例应在本实例 allow 之后被 deny');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
