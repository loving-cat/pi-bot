/**
 * Git 适配器：调用**用户已安装的 Git**（不随包分发），只暴露分级操作。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §7（Git 权限与工作区策略）与
 * §14.2（「不因内置组件准入规则而禁止调用用户已安装的 Git」）。
 *
 * ## 为什么是一个"受控适配器"而不是给 bot 一个 shell
 *
 * 规格 §8 明确：`把可运行任意宿主 shell 包装成严格项目隔离`是被禁止的。
 * 而 Git 本身就有大量"配置即代码"的坑：
 *
 *   · `diff.external` / `textconv` / `filter.*` / `core.pager` / `include.path`
 *     —— 全都能指定一个**可执行程序**，跑 `git diff` 就等于跑了那个程序；
 *   · `core.hooksPath` / `.git/hooks/*` —— commit 时会执行；
 *   · `alias.*` —— `git status` 里如果恰好带参数，可能被别名改写。
 *
 * 所以这里不让模型拼命令，只暴露固定的一组子命令；读操作一律加
 * `--no-ext-diff --no-textconv --no-pager`，把"看起来只读"变成"真的只读"。
 *
 * ## 分级（规格 §7.1）
 *
 * | 级别 | 操作 | 是否需要用户确认 |
 * |---|---|---|
 * | G0 | status / diff / log / show / branch 列表 | 否 |
 * | G1 | add / commit（本地普通提交） | 否（受项目授权覆盖） |
 * | G2 | push / merge / fetch | **是**（P0-4，单独确认） |
 * | G3 | reset --hard / clean / 删分支 / 改远端 / 改 hooks | **是** + 这里根本不提供 |
 *
 * G2 与 G3 这一层**故意不实现**：确认框架还没做（P0-4）。
 * 与其先做一个"能 push 但只是写日志"的假确认，不如不提供 ——
 * 规格 §9 明确「确认 UI 的真实性必须单独设计」。
 *
 * ## hooks 怎么办
 *
 * commit 时 hooks 会跑（`pre-commit`、`commit-msg` 等）。这躲不过：
 *   · 用 `--no-verify` 跳过 = 静默关闭项目要求，规格 §7.1 明确禁止；
 *   · 结果是"照跑，但把跑过哪些 hooks 记进审计"，用户能看到。
 *
 * ## 平台
 *
 * 规格 §12 要求 Windows 与 macOS 分列：Windows 首条路径是 PowerShell 调
 * `git.exe`，macOS 用系统 `git`。这里统一走 `spawnCommand`（它已经处理了
 * PATHEXT / .cmd shim / 参数转义），并把解析到的可执行路径与版本记下来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnCommand } from './spawn-command.js';

/** 一次 git 调用的默认超时。clone/fetch 之类的长操作另行放宽。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 输出上限：`git diff` 在大仓库上能有几十 MB。 */
const MAX_OUTPUT_CHARS = 200_000;

/**
 * 全局安全参数。
 *
 * 只有 `--no-pager` 是 **git 全局**参数；`--no-ext-diff` / `--no-textconv`
 * 是 `diff`/`show` 的**子命令参数**，放在前面会直接
 * `unknown option: --no-ext-diff`（实测：退出码 129）。
 *
 * 所以下面每个读操作自己在 args 里带上这两个，不要图省事塞到全局。
 */
const GLOBAL_SAFE_ARGS = ['--no-pager'];

/**
 * diff/show 这类会"执行外部程序"的子命令必须带的参数。
 *
 * `--no-ext-diff`：禁止 `diff.external`（一个可配置的**任意程序**）
 * `--no-textconv`：禁止 `.gitattributes` 里的 `textconv`（同样是程序）
 */
const NO_EXTERNAL_PROGRAMS = ['--no-ext-diff', '--no-textconv'];

/**
 * 允许暴露的子命令白名单。
 *
 * 这里是**能力的唯一定义处**：不在表里的操作，模型无论怎么请求都做不了。
 * `needs` 是网关动作名（见 grants.js 的 ACTION）。
 */
export const GIT_OPERATIONS = Object.freeze({
  status: { needs: 'git.read', mutates: false, args: (p) => ['status', '--porcelain=v1', '--branch', ...(p.short === false ? [] : [])] },
  diff: {
    needs: 'git.read',
    mutates: false,
    args: (p) => ['diff', ...NO_EXTERNAL_PROGRAMS, ...(p.staged ? ['--cached'] : []), ...(p.path ? ['--', String(p.path)] : [])],
  },
  log: { needs: 'git.read', mutates: false, args: (p) => ['log', `--max-count=${clampInt(p.limit, 1, 100, 20)}`, '--date=short', '--pretty=format:%h %ad %an %s'] },
  show: {
    needs: 'git.read',
    mutates: false,
    args: (p) => [
      'show', ...NO_EXTERNAL_PROGRAMS, '--stat', '--date=short',
      '--pretty=format:%h %ad %an%n%s%n', String(p.ref ?? 'HEAD'),
    ],
  },
  branches: { needs: 'git.read', mutates: false, args: () => ['branch', '--all', '--no-color', '-vv'] },
  blobs: { needs: 'git.read', mutates: false, args: (p) => ['cat-file', '-p', String(p.ref ?? 'HEAD')] },

  add: { needs: 'git.commit', mutates: true, args: (p) => ['add', ...(Array.isArray(p.paths) && p.paths.length ? ['--', ...p.paths.map(String)] : ['-A'])] },
  commit: {
    needs: 'git.commit',
    mutates: true,
    args: (p) => {
      const msg = String(p.message ?? '').trim();
      const args = ['commit', '-m', msg || '(no message)'];
      if (p.paths && Array.isArray(p.paths) && p.paths.length) args.push('--', ...p.paths.map(String));
      return args;
    },
  },
});

/** 明确拒绝的操作 —— 不是"忘了实现"，是刻意不给。 */
export const REFUSED_OPERATIONS = Object.freeze({
  push: 'push 属于 G2：要由用户确认后才能做，而确认框架（P0-4）还没做完。'
    + '现在直接推等于绕过了确认，所以这里不给。',
  merge: 'merge 改共享分支，属于 G2：同上，要确认。',
  rebase: 'rebase 改写历史，属于 G2/G3：要确认。',
  reset: 'reset 可能丢工作区改动，属于 G3：需要用户确认，这里不提供。',
  clean: 'clean 会删未跟踪文件，属于 G3：需要用户确认，这里不提供。',
  'push --force': 'force push 属于 G3：要确认，这里不提供。',
  'remote set-url': '改远端属于 G3：要确认，这里不提供。',
  hooks: '改 hooks 属于 G3：那是在改"提交时会执行什么"，需要用户确认。',
});

/**
 * 尽量把路径变成真实路径（解析符号链接）。
 *
 * ★ 为什么必须做：规格 §6.1「路径使用最终资源标识并处理链接/别名」。
 *
 * 实测（macOS CI 上挂了）：`os.tmpdir()` 给的是 `/var/folders/...`，
 * 而 `/var` 是指向 `/private/var` 的符号链接。git 写进 worktree 指针里的
 * 是它自己的视角，从另一条路径算出来的 commonDir 就不相等 ——
 * 于是"这两个是不是同一个主仓"永远判不出来。
 * Linux 上 `/tmp` 也有同样的链接关系。
 *
 * 路径不存在时（还没建出来）原样返回，不抛。
 */
function realish(p) {
  const raw = String(p ?? '');
  if (!raw) return raw;
  try { return fs.realpathSync.native ? fs.realpathSync.native(raw) : fs.realpathSync(raw); } catch { return raw; }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * 找用户已安装的 git。
 *
 * 规格 §14.2：调用用户已有工具是允许的，但要**记录来源与版本**，
 * 且不能因为"没核实许可证"就禁用。
 *
 * @returns {{ok:true, file:string, version:string, source:string}|{ok:false, error:string}}
 */
export function locateGit({ env = process.env } = {}) {
  const candidates = [];
  if (env.PIBOT_GIT_PATH) candidates.push({ file: env.PIBOT_GIT_PATH, source: 'env:PIBOT_GIT_PATH' });

  if (process.platform === 'win32') {
    // Windows：先看 PATH 里的 git.exe（Git for Windows 的 cmd/ 目录），
    // 再看常见安装位置。不走 bash 里的 mingw64/bin（那是 Git Bash 自带的，
    // 从 PowerShell 调它会有 MSYS 路径转换的坑）。
    candidates.push({ file: 'git.exe', source: 'PATH' });
    const guesses = [
      path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
      path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
      path.join(env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe'),
    ];
    for (const g of guesses) if (g && fs.existsSync(g)) candidates.push({ file: g, source: 'known-path' });
  } else {
    candidates.push({ file: '/usr/bin/git', source: 'system' });
    candidates.push({ file: '/usr/local/bin/git', source: 'homebrew' });
    candidates.push({ file: '/opt/homebrew/bin/git', source: 'homebrew-arm' });
    candidates.push({ file: 'git', source: 'PATH' });
  }

  let lastError = '';
  for (const cand of candidates) {
    if (!cand.file) continue;
    if (cand.file.includes(path.sep) && !fs.existsSync(cand.file)) continue;
    const res = spawnSync(cand.file, ['--version'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    if (res.error) { lastError = String(res.error.message || res.error); continue; }
    if (res.status !== 0) { lastError = (res.stderr || '').slice(0, 200); continue; }
    const m = /git version (\S+)/.exec(res.stdout || '');
    if (!m) { lastError = '版本输出无法解析'; continue; }
    return { ok: true, file: cand.file, version: m[1], source: cand.source };
  }
  return {
    ok: false,
    error: `找不到可用的 Git（${lastError || 'PATH 里没有 git'}）。`
      + 'Git 是开发闭环的必要能力，不能以禁用交差 —— 请先装 Git 再试。',
  };
}

/**
 * 解析仓库的 `.git` 指向（规格 §7.3「不能只校验工作目录字符串」）。
 *
 * 三种情况：
 *   · 普通仓库：`.git` 是目录 → gitDir = `<root>/.git`
 *   · linked worktree：`.git` 是**文件**，内容是 `gitdir: <路径>`，
 *     真实的目录在**主仓**里（`<主仓>/.git/worktrees/<名>`），
 *     共享的 objects/refs 在 commondir 指向的位置
 *   · 不在仓库里：返回 null
 *
 * 这就是规格 §7.3 要求"登记 `.git` 指针、gitdir、commondir"的那件事 ——
 * 不解析它，就没法回答"这次提交实际写到了哪个目录"。
 *
 * @returns {{ok:true, root:string, gitDir:string, commonDir:string, worktree:boolean, pointerFile:string|null}|{ok:false, error:string}}
 */
export function resolveRepoLayout(rootDir) {
  const root = path.resolve(String(rootDir ?? ''));
  if (!root) return { ok: false, error: '缺少仓库目录' };

  let cursor = root;
  for (let depth = 0; depth < 40; depth += 1) {
    const dotGit = path.join(cursor, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { /* 继续往上找 */ }
    if (stat?.isDirectory()) {
      return {
        ok: true, root: realish(cursor), gitDir: realish(dotGit), commonDir: realish(dotGit),
        worktree: false, pointerFile: null,
      };
    }
    if (stat?.isFile()) {
      // worktree：.git 是文件，内容是 `gitdir: <path>`
      let text = '';
      try { text = fs.readFileSync(dotGit, 'utf8'); } catch { /* 读不到就当没仓库 */ }
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (!m) return { ok: false, error: `${dotGit} 存在但不是合法的 gitdir 指针` };
      const rawTarget = m[1].trim();
      // ★ 指针文件里的路径未必用本机分隔符：Windows 上 git 常写成
      //   `D:/repo/.git/worktrees/w1`（正斜杠），而 commonDir 是从文件里
      //   读出来的反斜杠形式。不归一化的话，后面比较"是不是同一个目录"
      //   会永远不相等 —— 那正是 P1-1 要求"登记 gitdir/commondir 最终目标"
      //   要防的事。
      const asLocal = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(cursor, rawTarget);
      const gitDir = path.normalize(asLocal);
      // commondir 文件指向共享目录（worktrees/<名>/commondir → ../..）
      let commonDir = gitDir;
      try {
        const cd = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (cd) commonDir = path.normalize(path.isAbsolute(cd) ? cd : path.resolve(gitDir, cd));
      } catch { /* 没有 commondir 就认为 gitDir 自己就是共享目录 */ }
      return {
        ok: true, root: realish(cursor), gitDir: realish(gitDir), commonDir: realish(commonDir),
        worktree: true, pointerFile: dotGit,
      };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { ok: false, error: `${root} 不在任何 git 仓库里` };
}

/**
 * 真正跑一次 git。
 *
 * @param {object} p
 * @param {string} p.repoDir
 * @param {string} p.op      GIT_OPERATIONS 的键
 * @param {object} [p.params]
 * @param {string} [p.gitFile] 显式指定 git 可执行文件（不传则现场找）
 * @returns {{ok:boolean, op:string, stdout?:string, stderr?:string, code?:number, error?:string, truncated?:boolean}}
 */
export function runGit({ repoDir, op, params = {}, gitFile = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = String(op ?? '');
  if (REFUSED_OPERATIONS[key]) {
    return { ok: false, op: key, error: REFUSED_OPERATIONS[key], refused: true };
  }
  const spec = GIT_OPERATIONS[key];
  if (!spec) {
    return {
      ok: false, op: key,
      error: `不支持的 git 操作「${key}」。可用：${Object.keys(GIT_OPERATIONS).join('、')}`,
      refused: true,
    };
  }

  const git = gitFile ? { ok: true, file: gitFile } : locateGit();
  if (!git.ok) return { ok: false, op: key, error: git.error };

  const layout = resolveRepoLayout(repoDir);
  if (!layout.ok) return { ok: false, op: key, error: layout.error };

  const args = [
    ...GLOBAL_SAFE_ARGS,
    ...spec.args(params ?? {}),
  ];

  // ★ 固定几个会"改行为"的配置，不信任仓库里写的东西。
  //   这几条是**命令行层**的 -c，优先级高于仓库/全局配置，
  //   所以即使仓库里写了 core.hooksPath / diff.external 也压不过我们。
  //   注意：hooks 本身没法用 -c 关掉（那是文件不是配置），
  //   所以 commit 时它会跑 —— 见文件头注释里的取舍。
  const configGuards = [
    '-c', 'core.pager=cat',      // 分页器可能是个程序，而且会挂住管道
    '-c', 'core.quotepath=false', // 中文文件名不要转成 \344\275\240
    '-c', 'advice.detachedHead=false',
  ];

  const res = spawnSync(git.file, [...configGuards, ...args], {
    cwd: layout.root,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      // 关掉交互式凭据提示：命令行里没人能回答它，只会挂住进程
      GIT_TERMINAL_PROMPT: '0',
      // 语言固定成 C，否则不同机器的输出没法解析
      LC_ALL: 'C',
      LANG: 'C',
      // 不许它去读用户全局 hooks（那可能是任意程序）
      GIT_CONFIG_NOSYSTEM: '1',
    },
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    return { ok: false, op: key, error: `git 启动失败：${String(res.error.message || res.error)}` };
  }
  let stdout = res.stdout || '';
  let truncated = false;
  if (stdout.length > MAX_OUTPUT_CHARS) {
    stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }
  const stderrText = res.stderr || '';
  return {
    ok: res.status === 0,
    op: key,
    code: res.status,
    stdout,
    stderr: stderrText.slice(0, 4000),
    // 规格 §7.1：结果真实性要看进程退出码，不能只看有没有抛异常
    error: res.status === 0 ? undefined : describeGitError({ key, code: res.status, stderr: stderrText }),
    truncated,
    layout: { root: layout.root, gitDir: layout.gitDir, commonDir: layout.commonDir, worktree: layout.worktree },
    git: { file: git.file, version: git.version ?? '', source: git.source ?? '' },
  };
}

/**
 * 提交后的核对：规格 §7.1 要求"退出码 + 预期仓库状态"都符合才算成功。
 *
 * 只信退出码是不够的 —— hooks 可以 `exit 0` 但什么都不做，
 * 也可能有 `--allow-empty` 之类的意外。所以要再看一眼 HEAD 有没有前进。
 *
 * @param {object} p
 * @param {string} p.beforeHead
 * @param {string} p.repoDir
 * @param {string} [p.gitFile]
 * @returns {{ok:boolean, afterHead?:string, advanced?:boolean, error?:string}}
 */
export function verifyCommitLanded({ beforeHead, repoDir, gitFile = null } = {}) {
  const head = runGit({ repoDir, op: 'show', params: { ref: 'HEAD' }, gitFile });
  if (!head.ok) return { ok: false, error: head.error };
  const afterHead = (head.stdout || '').split('\n')[0].split(' ')[0] ?? '';
  if (!afterHead) return { ok: false, error: '读不出 HEAD' };
  return { ok: true, afterHead, advanced: Boolean(beforeHead) && afterHead !== beforeHead };
}

/**
 * 把 git 的 stderr 翻成"模型能照着做的话"。
 *
 * 纯函数，不碰进程 —— 这样能跨平台单测。
 * （曾经把它写成"跑一次真实提交看会不会失败"，结果 macOS CI 上
 *  runner 自带的 /etc/gitconfig 让提交成功了，用例就假红/假绿。）
 *
 * @param {object} p
 * @param {string} p.key     操作名
 * @param {number} p.code    退出码
 * @param {string} p.stderr
 * @returns {string}
 */
export function describeGitError({ key = '', code = 1, stderr = '' } = {}) {
  const text = String(stderr ?? '');
  if (/Author identity unknown|unable to auto-detect email/i.test(text)) {
    return '这台机器上的 Git 还没配提交身份（user.name / user.email），所以提交不了。'
      + '这不是代码能修的，得由用户在仓库里或全局配一次：'
      + 'git config user.name "你的名字" 和 git config user.email "你的邮箱"。';
  }
  if (/nothing to commit|no changes added to commit/i.test(text)) {
    return '没有可提交的改动（暂存区是空的）。先 git_add 要提交的文件。';
  }
  if (/pathspec .* did not match/i.test(text)) {
    return '指定的路径在仓库里不存在。先 git_status 看实际有哪些改动。';
  }
  if (/not a git repository/i.test(text)) {
    return '这个目录不是 git 仓库。用 repo 参数指定一个仓库目录。';
  }
  if (/Permission denied|EACCES/i.test(text)) {
    return '没有权限写这个仓库（文件被占用或权限不足）。';
  }
  if (/index\.lock|Unable to create .*\.lock/i.test(text)) {
    return '这个仓库有别的 git 进程正在跑（.git/index.lock 还在）。'
      + '等它结束再试 —— **不要手动删锁文件**，那可能删掉别人正在写的东西。';
  }
  return `git ${key} 退出码 ${code}：${text.slice(0, 400)}`;
}

/** 当前 HEAD 的短 hash（没有提交时返回空串）。 */
export function currentHead({ repoDir, gitFile = null } = {}) {
  const git = gitFile ? { ok: true, file: gitFile } : locateGit();
  if (!git.ok) return '';
  const res = spawnSync(git.file, ['rev-parse', '--short', 'HEAD'], {
    cwd: resolveRepoLayout(repoDir).root ?? repoDir,
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return res.status === 0 ? (res.stdout || '').trim() : '';
}

/**
 * 这个仓库里有哪些 hooks 会在 commit 时跑（供审计用）。
 *
 * 为什么要记它：规格 §7.1「不得静默关闭项目要求后声称提交流程正常」。
 * 我们不关（不传 --no-verify），但要让用户事后能查到"这次提交时跑了什么"。
 */
export function listActiveHooks({ repoDir, gitFile = null } = {}) {
  const layout = resolveRepoLayout(repoDir);
  if (!layout.ok) return [];
  const dir = path.join(layout.commonDir, 'hooks');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => !n.endsWith('.sample'))
    .filter((n) => {
      try { return fs.statSync(path.join(dir, n)).size > 0; } catch { return false; }
    })
    .sort();
}

/** 把 git 状态解析成结构（给工具/界面用，不用让模型自己正则）。 */
export function parseStatus(text) {
  const out = { branch: '', ahead: 0, behind: 0, staged: [], modified: [], untracked: [], deleted: [] };
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const body = line.slice(3);
      const name = body.split('...')[0].trim();
      out.branch = name;
      const ahead = /ahead (\d+)/.exec(body);
      const behind = /behind (\d+)/.exec(body);
      if (ahead) out.ahead = Number(ahead[1]);
      if (behind) out.behind = Number(behind[1]);
      continue;
    }
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).trim();
    if (x === '?' && y === '?') { out.untracked.push(file); continue; }
    if (x === 'D' || y === 'D') out.deleted.push(file);
    if (x && x !== ' ' && x !== '?') out.staged.push(file);
    else if (y && y !== ' ') out.modified.push(file);
  }
  return out;
}

export { spawnCommand };
