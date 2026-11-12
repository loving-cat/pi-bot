/**
 * 挂了 MCP 的 bot，shell 类工具要跑在沙箱里。
 *
 * ## 为什么
 *
 * 审批只能控制"这条命令要不要人点同意"，控制不住**命令能碰到什么**。
 * 一个被批准的 `curl 内网地址`、`cat ~/.ssh/id_rsa`、`rm -rf ~`
 * 都还是能造成实际损害 —— 用户点"同意"时未必意识到参数是那个。
 *
 * 所以对"这只 bot 具有外部执行能力（挂了 MCP）"的情况，命令本身也要受限。
 *
 * ## 平台差异
 *
 *   macOS  —— sandbox-exec + 自写 Seatbelt profile（默认 deny）
 *   Linux  —— bwrap（bubblewrap）
 *   Windows —— **不实现**：直接拒绝执行，提示"沙箱未就绪"。
 *              宁可不能跑，也不能在没隔离的情况下跑一条已经被判定为
 *              "需要额外防护"的命令。
 *
 * ## fail-closed
 *
 * 需要沙箱但沙箱不可用（二进制不存在、profile 写不出、启动失败）时
 * **一律拒绝**，绝不降级成无沙箱执行。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 沙箱不可用的原因。 */
export const SANDBOX_UNAVAILABLE = {
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  NO_BINARY: 'no_binary',
  NO_INSTANCE_DIR: 'no_instance_dir',
  PROFILE_FAILED: 'profile_failed',
  BAD_PATH: 'bad_path',
  UNSAFE_WORKDIR: 'unsafe_workdir',
};

/**
 * macOS 的 Seatbelt profile。
 *
 * ★ 关键约束（都是实测出来的坑，见 test/sandbox-*.mjs 里的验证）：
 *   · 必须有 (allow file-read* (literal "/")) —— dyld 解析任何绝对路径
 *     前要先 stat("/")，缺了会 SIGABRT，连 /bin/echo 都起不来。
 *   · 剪贴板的服务名是 com.apple.pasteboard.1，不是 com.apple.pboard
 *     （后者是流传很广的错误写法，deny 了也不报错，等于没设）。
 *   · 不 allow 整个 home —— 那样 ~/.ssh 会直接可读。只给系统目录和工作目录。
 *
 * @param {object} o
 * @param {string} o.workDir  允许读写的工作目录
 * @param {string} o.tmpDir   允许读写的私有临时目录
 * @param {string[]} [o.denyPaths] 额外要显式拒绝的路径（如 pi-bot 数据目录）
 */
/**
 * 把路径展开成"原样 + 符号链接解析后"两种。
 *
 * ★ macOS 上 /tmp 是 /private/tmp 的符号链接。Seatbelt 的 subpath 匹配用的是
 *   **内核看到的真实路径**，所以只写 /tmp/... 会一条都不生效（实测：写工作目录
 *   被 deny，内核日志里是 /private/tmp/...）。
 */
function expandPath(p) {
  if (!p) return [];
  const out = new Set();
  // ★ realpath 形式必须放在**前面**，而且必须存在。
  //
  //   实测（见 tests/sandbox.mjs 的回归用例）：Seatbelt 用规范化后的路径
  //   比对规则。deny 一旦写成 /private/var/... 形式，allow 只写 /var/...
  //   就匹配不上（前缀不同），于是 allow 被 deny 吞掉 —— 症状是
  //   "workspace 能写、实例目录写不了"。
  //
  //   所以两种情况都要写，但 realpath 那条是真正生效的那条。
  try {
    // 目录可能还没建（如 workspace 首次使用）：先建出来，
    // 这样 realpath 一定能拿到规范形式。建不出来就退回原路径。
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  } catch {
    // 没权限建就保持原样，realpath 会失败，下面只剩原路径
  }
  try {
    out.add(fs.realpathSync(p));
  } catch {
    // 真的不存在时只能写原路径
  }
  out.add(p);
  return [...out];
}

/**
 * 把路径转义成可以安全塞进 SBPL 字符串字面量的形式。
 *
 * ★ 不转义的话，workDir 里含一个引号就能注入任意规则 ——
 *   比如目录名里塞 `" (allow file-read* (subpath "/` 就能把整个文件系统放开。
 *   SBPL 字符串里的反斜杠和双引号都必须转义。
 */
export function escapeSbplPath(p) {
  const BS = String.fromCharCode(92);
  return String(p ?? '')
    .split(BS).join(BS + BS)
    .split('"').join(BS + '"');
}

/**
 * 路径能不能安全用。
 *
 * 除了引号和反斜杠，还要挡住控制字符（换行、NUL 等）——
 * 它们能切断规则行，效果等同于注入。
 */
export function isSafeSbplPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return true;
}

/** 列出一个目录下的子目录（不存在时返回空）。 */
function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export function seatbeltProfile({ workDir, tmpDir, denyPaths = [], instanceDir = '', dataDir = '' }) {
  const lines = [
    '(version 1)',
    '',
    ';; ---- 默认拒绝一切 ----',
    '(deny default)',
    '',
    ';; ---- 进程基础能力 ----',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target self))',
    '(allow process-info* (target self))',
    '(allow sysctl-read)',
    '',
    ';; ---- 根目录自身必须可读（dyld 的前置 stat） ----',
    '(allow file-read* (literal "/"))',
    '',
    ';; ---- 系统目录只读（运行库、标准命令） ----',
    '(allow file-read*',
    '    (subpath "/usr/lib")',
    '    (subpath "/usr/share")',
    '    (subpath "/usr/bin")',
    '    (subpath "/usr/sbin")',
    '    (subpath "/usr/local/lib")',
    '    (subpath "/opt/homebrew/lib")',
    '    (subpath "/System")',
    '    (subpath "/Library")',
    '    (subpath "/bin")',
    '    (subpath "/sbin")',
    '    (subpath "/private/var/db/dyld"))',
    '',
    ';; ---- 设备与标准流 ----',
    '(allow file-read* (literal "/dev/null") (literal "/dev/zero")',
    '                   (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero")',
    '                    (literal "/dev/stdout") (literal "/dev/stderr"))',
    '',
    ';; ---- shell 启动需要的最小元数据节点 ----',
    '(allow file-read*',
    '    (literal "/private")',
    '    (literal "/private/var")',
    '    (literal "/private/var/select")',
    '    (literal "/private/var/select/sh")',
    '    (literal "/private/etc")',
    '    (literal "/tmp")',
    '    (literal "/private/tmp")',
    '    (subpath "/private/etc"))',
    '',
    ';; ---- 工作目录：读写（这是命令唯一允许落地的地方） ----',
  ];

  lines.push(
    '',
    ';; ---- 网络：全禁（含 TCP/UDP/unix socket） ----',
    '(deny network*)',
    '',
    ';; ---- 敏感 mach 服务 ----',
    '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
    '(deny mach-lookup (global-name "com.apple.secd"))',
    ';; 剪贴板：服务名必须是 com.apple.pasteboard.1',
    '(deny mach-lookup (global-name "com.apple.pasteboard.1"))',
    '(deny mach-lookup (global-name "com.apple.replayd"))',
    '(deny mach-lookup (global-name "com.apple.windowserver.active"))',
    '(deny mach-lookup (global-name "com.apple.CGSession.fb"))',
    '',
    ';; ---- AppleEvents 与截屏 ----',
    '(deny appleevent-send)',
  );

  // ═══════════════════════════════════════════════════════════════════════
  //  路径规则分三层（顺序有意义！）
  // ═══════════════════════════════════════════════════════════════════════
  //
  //  Seatbelt 的实际语义（实测确认，与调研报告里的"deny 绝对优先"说法不同）：
  //
  //    · 规则**重叠时后写的胜出**（同一路径，先 allow 后 deny → 拒；
  //      先 deny 后 allow → 放）。所以顺序就是优先级。
  //    · 前缀不同时，**更具体的规则胜出**：deny 一个子目录可以覆盖
  //      对父目录的 allow（实测：allow dataDir + deny dataDir/rooms → rooms 拒）。
  //
  //  正因为顺序有意义，才不会出现"deny 整个 dataDir 把 workspace 也挡死"
  //  的功能回归 —— 只要在 deny 之后再把该放行的子目录 allow 回来。
  //
  //  三层：
  //    (a) deny 整个 dataDir
  //    (b) allow 本实例目录 + workspace
  //    (c) 再 deny 敏感项（token、rooms/、sessions/、别的 instances/、凭据目录…）
  //
  const home = os.homedir();
  /** 展开 + realpath + 转义，返回可安全写进 profile 的路径列表。 */
  const denyTargets = (p) => {
    if (!p || !isSafeSbplPath(p)) return [];
    const out = new Set();
    const raw = String(p);
    // 显式支持 ~ 开头：Seatbelt 不认，我们自己换掉
    const expanded = raw === '~' || raw.startsWith('~/')
      ? path.join(home, raw.slice(1))
      : raw;
    out.add(expanded);
    try {
      out.add(fs.realpathSync(expanded));
    } catch {
      // 路径不存在（如没装 .gnupg）时只留原样
    }
    return [...out].filter(isSafeSbplPath);
  };
  const pushAllowRW = (dir) => {
    for (const d of expandPath(dir)) {
      lines.push(`(allow file-read* file-write* (subpath "${escapeSbplPath(d)}"))`);
    }
  };
  const pushDenyRead = (p) => {
    for (const real of denyTargets(p)) {
      lines.push(`(deny file-read* (subpath "${escapeSbplPath(real)}"))`);
    }
  };
  const pushDenyReadWrite = (p, literal = false) => {
    for (const real of denyTargets(p)) {
      const kind = literal ? 'literal' : 'subpath';
      lines.push(`(deny file-read* file-write* (${kind} "${escapeSbplPath(real)}"))`);
    }
  };

  // ── (a) deny 整个数据目录 ──
  //
  // 数据目录里有 local-token、一切房间/会话记录、MCP 凭据。默认全拒。
  lines.push('', ';; ===== (a) 数据目录整体拒绝 =====');
  const dataDirReal = dataDir && isSafeSbplPath(dataDir)
    ? (() => { try { return fs.realpathSync(dataDir); } catch { return String(dataDir); } })()
    : '';
  if (dataDirReal) {
    lines.push(`(deny file-read* file-write* (subpath "${escapeSbplPath(dataDirReal)}"))`);
  }

  // ── (b) 放行工作目录与本实例私有目录 ──
  //
  // 这几项**必须排在 (a) 之后** —— 它们大多就在数据目录里面：
  // 默认工作目录是 <dataDir>/workspace，实例目录是 <dataDir>/instances/<key>。
  // 不在这层 allow 回来，默认配置下挂 MCP 的 bot 连 getcwd 都失败。
  lines.push('', ';; ===== (b) 工作目录 / 本实例目录：读写放行 =====');
  pushAllowRW(workDir);
  pushAllowRW(tmpDir);
  if (instanceDir) {
    // 本实例的整个目录（含 home / tmp）；别的 instances/<other> 在 (c) 再拒
    pushAllowRW(instanceDir);
  }

  // ── (c) 最后再拒敏感项 ──
  //
  // 这一层排在 (b) 之后，所以即使某项落在刚放行的范围内也会被拒。
  lines.push('', ';; ===== (c) 数据目录内的敏感项：即使被 (b) 放行也拒 =====');
  if (dataDirReal) {
    // token 文件本身
    pushDenyReadWrite(path.join(dataDirReal, 'local-token'), true);
    pushDenyReadWrite(path.join(dataDirReal, 'secret.key'), true);
    // 会话 / 房间 / 上传记录（bot 不该从文件系统读别人的对话）
    for (const sub of ['rooms', 'sessions', 'taskruns', 'uploads', 'task-requests', 'task-commands']) {
      pushDenyReadWrite(path.join(dataDirReal, sub));
    }
    // 其它 bot 的实例目录：本实例已 allow，其余的显式拒。
    //
    // ★ 比较必须用 realpath：listDirs 读出来的是真实路径（/private/tmp/...），
    //   而 instanceDir 可能是符号链接形式（/tmp/...）。不用 realpath 就会
    //   认不出"这就是本实例"，把本实例也 deny 掉 —— 那样 $HOME 和 $TMPDIR
    //   全都写不了。
    const instancesRoot = path.join(dataDirReal, 'instances');
    const realOrSelf = (p) => {
      try { return fs.realpathSync(p); } catch { return String(p); }
    };
    const myInstanceReal = instanceDir ? realOrSelf(instanceDir) : '';
    for (const entry of listDirs(instancesRoot)) {
      const entryReal = realOrSelf(entry);
      if (myInstanceReal && entryReal === myInstanceReal) continue;
      pushDenyReadWrite(entryReal);
    }
    // state.json 里有全部房间/会话索引
    pushDenyReadWrite(path.join(dataDirReal, 'state.json'), true);
  }

  // ── (c') 用户凭据目录：任何情况下都不许读 ──
  const READ_DENY = [
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.azure',
    '~/.config/gcloud',
    '~/.kube',
    '~/.docker/config.json',
    '~/.netrc',
    '~/.npmrc',
    '~/.pypirc',
    '~/.config/gh/hosts.yml',
    '~/Library/Keychains',
    '~/Library/Cookies',
    '~/Library/Safari',
    '~/Library/Messages',
  ];
  // shell rc 与自启动：读写都拒（里面常有人手写的 token）
  const WRITE_DENY = [
    '~/.zshrc',
    '~/.zshenv',
    '~/.zprofile',
    '~/.bashrc',
    '~/.bash_profile',
    '~/.bash_login',
    '~/.profile',
    '~/.config/fish/config.fish',
    '~/Library/LaunchAgents',
    '~/Library/LaunchDaemons',
  ];

  lines.push('', ';; ---- 凭据目录：始终只读拒绝（排在所有 allow 之后） ----');
  for (const p of READ_DENY) pushDenyRead(p);

  lines.push('', ';; ---- shell rc / 自启动：读写都拒 ----');
  for (const p of WRITE_DENY) pushDenyReadWrite(p, true);

return lines.join('\n');
}

/**
 * 工作目录是否安全到可以开沙箱。
 *
 * ★ 工作目录 = $HOME 时，沙箱几乎没有意义：home 下就是 .ssh、凭据、
 *   数据目录。Seatbelt 是 deny 优先，理论上还能挡住，但一旦漏一条
 *   就是全裸。与其依赖"每条 deny 都写对"，不如直接拒绝这种配置并
 *   让用户换一个专用目录。
 *
 * @returns {{ok: true} | {ok: false, reason: string, message: string}}
 */
export function assertSafeWorkDir({ workDir, dataDir = '' }) {
  const home = os.homedir();
  const real = (p) => {
    try { return fs.realpathSync(p); } catch { return String(p ?? ''); }
  };
  const w = real(workDir);
  const h = real(home);
  const d = dataDir ? real(dataDir) : '';

  // ★ 比较要按平台处理。
  //
  //   Windows 上：路径分隔符是 ，且**大小写不敏感**（盘符尤其常见大小写不同，
  //   还有 8.3 短名如 RUNNER~1 和长名指向同一目录）。用 POSIX 的 "/" 拼接
  //   和 === 比较会让父目录判断永远为 false —— 于是"workDir 是 home 的上级"
  //   这种危险配置被当成安全放过去。
  const norm = (p) => {
    const s = String(p ?? '').replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const sep = process.platform === 'win32' ? '\\' : '/';
  const isSame = (a, b) => {
    const x = norm(a);
    const y = norm(b);
    return Boolean(x) && x === y;
  };
  const isAncestorOf = (a, b) => {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    return y.startsWith(x.endsWith(sep) ? x : x + sep);
  };

  if (!w) {
    return { ok: false, reason: 'no_workdir', message: '没有工作目录，拒绝在沙箱里执行。' };
  }
  // 根路径按平台取：Windows 上是盘符根（C:），POSIX 上是 /
  const rootOf = (p) => {
    try {
      return path.parse(p).root;
    } catch {
      return process.platform === 'win32' ? '' : '/';
    }
  };
  if (isSame(w, rootOf(w)) || isAncestorOf(w, h)) {
    return {
      ok: false,
      reason: 'workdir_is_home_or_ancestor',
      message: `工作目录 ${workDir} 是家目录（或它的上级），沙箱在这种配置下挡不住凭据目录。`
        + '请把 bot 的工作目录设成一个专用子目录（例如 ~/pi-bot-work）再试。',
    };
  }
  if (isSame(w, h)) {
    return {
      ok: false,
      reason: 'workdir_is_home',
      message: '工作目录就是家目录，沙箱挡不住 ~/.ssh 等凭据目录。'
        + '请把 bot 的工作目录设成一个专用子目录（例如 ~/pi-bot-work）再试。',
    };
  }
  if (d && (isSame(w, d) || isAncestorOf(w, d))) {
    return {
      ok: false,
      reason: 'workdir_contains_datadir',
      message: `工作目录 ${workDir} 包含 pi-bot 的数据目录（token 就在里面）。`
        + '请把工作目录移出数据目录再试。',
    };
  }
  return { ok: true };
}

/**
 * 探测某个平台上的沙箱是否可用。
 *
 * @returns {{available: boolean, kind: string, reason?: string}}
 */
export function probeSandbox() {
  if (process.platform === 'darwin') {
    const bin = '/usr/bin/sandbox-exec';
    if (!fs.existsSync(bin)) {
      return { available: false, kind: 'seatbelt', reason: SANDBOX_UNAVAILABLE.NO_BINARY };
    }
    return { available: true, kind: 'seatbelt' };
  }
  if (process.platform === 'linux') {
    const found = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find((p) => fs.existsSync(p));
    if (!found) {
      return { available: false, kind: 'bwrap', reason: SANDBOX_UNAVAILABLE.NO_BINARY };
    }
    return { available: true, kind: 'bwrap', binary: found };
  }
  return { available: false, kind: 'none', reason: SANDBOX_UNAVAILABLE.UNSUPPORTED_PLATFORM };
}

/**
 * 把一条命令包装成"在沙箱里跑"。
 *
 * @param {object} o
 * @param {string} o.command  原始命令（shell 语法的字符串）
 * @param {string} o.workDir  工作目录（允许读写）
 * @param {string} o.tmpDir   私有临时目录
 * @param {string[]} [o.denyPaths]
 * @param {string} [o.instanceDir] 实例目录（放 profile 文件）
 * @returns {{ok: true, file: string, args: string[]} | {ok: false, reason: string}}
 */
export function wrapCommand({ command, workDir, tmpDir, denyPaths = [], instanceDir = '', dataDir = '' }) {
  const probe = probeSandbox();
  if (!probe.available) return { ok: false, reason: probe.reason };

  // ★ 先拒绝"工作目录是 home / 包含数据目录"这种配置。
  //   沙箱在这种布局下挡不住凭据目录，与其依赖每条 deny 都写对，不如不让跑。
  const safe = assertSafeWorkDir({ workDir, dataDir });
  if (!safe.ok) {
    return { ok: false, reason: safe.reason, message: safe.message };
  }

  // 路径里有引号/控制字符时也不玩 —— 拼进 SBPL 是注入面
  for (const p of [workDir, tmpDir, instanceDir, ...denyPaths]) {
    if (p && !isSafeSbplPath(p)) {
      return { ok: false, reason: SANDBOX_UNAVAILABLE.BAD_PATH, message: '路径里含控制字符，拒绝。' };
    }
  }

  if (probe.kind === 'seatbelt') {
    const dir = instanceDir || tmpDir || os.tmpdir();
    const profilePath = path.join(dir, 'sandbox.sb');
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        profilePath,
        seatbeltProfile({ workDir, tmpDir, denyPaths, instanceDir, dataDir }),
        { mode: 0o600 },
      );
    } catch {
      return { ok: false, reason: SANDBOX_UNAVAILABLE.PROFILE_FAILED };
    }
    return {
      ok: true,
      file: '/usr/bin/sandbox-exec',
      args: ['-f', profilePath, '/bin/sh', '-c', command],
    };
  }

  // Linux: bwrap
  const args = [
    '--unshare-all',
    '--unshare-pid',
    '--proc', '/proc',
    '--dev', '/dev',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    // 系统目录只读绑定
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/sbin', '/sbin',
    '--ro-bind-try', '/etc', '/etc',
    // 私有 tmp（tmpfs，不挂宿主 /tmp）
    '--tmpfs', '/tmp',
    // 工作目录可写
    '--bind', workDir, workDir,
  ];
  if (tmpDir) args.push('--tmpfs', tmpDir);
  args.push('--chdir', workDir, '/bin/sh', '-c', command);
  return { ok: true, file: probe.binary || 'bwrap', args };
}

/**
 * 沙箱里的命令是否能跑起来（自检）。
 *
 * 只跑一次 `/bin/echo` —— 如果连这个都不行，说明 profile 有问题，
 * 后面的命令都会失败。**失败就拒绝**，不降级。
 */
export function selfCheck(wrapped) {
  if (!wrapped?.ok) return { ok: false, reason: wrapped?.reason ?? 'not_wrapped' };
  try {
    const res = spawnSync(wrapped.file, wrapped.args, {
      timeout: 15_000,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    if (res.status !== 0) {
      return { ok: false, reason: 'selfcheck_failed', detail: (res.stderr || '').slice(0, 300) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'selfcheck_error', detail: String(err?.message || err) };
  }
}
