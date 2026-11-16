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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.js';
import { repoTrustVerdict } from './repo-trust.js';
import { acquireRepoWrite, releaseRepoWrite } from './repo-lock.js';
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

  /**
   * G2：push。**必须**先过用户确认（confirm.js 会要求手机通道）。
   *
   * `requiresConfirmation: true` 不是给调用方看的提示 —— runGit 会直接拒绝
   * 没有确认票据的调用。这样可以保证"能执行 push 的唯一路径"是先确认。
   *
   * 参数固定成 `push <remote> <ref>`：
   *   · 不给 `--force` / `--force-with-lease`（那是 G3，表里没有）
   *   · 不给 `--all` / `--tags` / `--mirror`（一次推一堆引用没法确认"推了什么"）
   */
  /**
   * G2/G3：会改共享分支或丢代码的四个操作。
   *
   * ★ 参数全部**固定成模板**，不接自由 argv。理由和 push 一样：
   *   确认票据绑的是"用户到底在批什么"，参数一旦自由，那张票描述的对象
   *   模型可以自己改（用户批了"合并到 main"，执行时变成"reset --hard"）。
   *
   * ★ `roles: ['main','lead']` —— 产品决定：这四个只给主 Bot 和负责人。
   *   执行 Bot（member）连工具都拿不到，拿到了也会被 runGit 挡下。
   */
  merge: {
    needs: 'git.destructive',
    mutates: true,
    requiresConfirmation: true,
    roles: Object.freeze(['main', 'lead']),
    args: (p) => ['merge', '--no-edit', String(p.ref ?? '')].filter(Boolean),
  },
  rebase: {
    needs: 'git.destructive',
    mutates: true,
    requiresConfirmation: true,
    roles: Object.freeze(['main', 'lead']),
    args: (p) => ['rebase', String(p.ref ?? '')].filter(Boolean),
  },
  reset: {
    needs: 'git.destructive',
    mutates: true,
    requiresConfirmation: true,
    roles: Object.freeze(['main', 'lead']),
    // 只接受 --soft / --mixed；`--hard` 会丢工作区改动，表里根本不提供。
    // 调用方传了别的值也在这里**夹回去**，不给"参数拼错的自由"。
    args: (p) => {
      const mode = ['soft', 'mixed'].includes(String(p.mode)) ? String(p.mode) : 'mixed';
      return ['reset', `--${mode}`, String(p.ref ?? 'HEAD')];
    },
  },
  clean: {
    needs: 'git.destructive',
    mutates: true,
    requiresConfirmation: true,
    roles: Object.freeze(['main', 'lead']),
    // 永远先 -n（只说会删什么），真删要显式 apply。
    args: (p) => (p.apply === true ? ['clean', '-fd'] : ['clean', '-nd']),
  },

  push: {
    needs: 'git.push',
    mutates: true,
    requiresConfirmation: true,
    args: (p) => {
      const remote = String(p.remote ?? 'origin').trim();
      const branches = Array.isArray(p.branches) ? p.branches.map(String) : [String(p.branch ?? '')].filter(Boolean);
      return ['push', remote, ...branches];
    },
  },
});

/** 明确拒绝的操作 —— 不是"忘了实现"，是刻意不给。 */
export const REFUSED_OPERATIONS = Object.freeze({
  // push / merge / rebase / reset / clean 都可用了，但**都要确认**，
  // 而且后四个只给主 Bot 与负责人（见 GIT_OPERATIONS 里的 roles）。
  //
  // 下面这几个仍然不给，理由各不相同、都不是"忘了实现"：
  'push --force': 'force push 属于 G3：它会覆盖别人的提交，且本地无法核对远端被推掉了什么。'
    + '要改远端历史，只能用普通 push + 明确的分支操作，不提供这一步。',
  'remote set-url': '改远端等于改"代码去哪儿"：需要用户确认，而这里没有一条能绑住目的地的确认。',
  hooks: '改 hooks 属于 G3：那是在改"提交时会执行什么"，等于改执行链本身。',
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
 * 读 `objects/info/alternates` —— 这个仓库会不会去读**别的目录**的对象库。
 *
 * 规格 §7.3 原话：
 *
 *   > 解析并登记 `.git` 指针、gitdir、commondir、objects alternates…
 *   > 所有目标都要属于明确授予的信任域，否则拒绝该操作并提出授权差异。
 *
 * ## 为什么这条不能只看工作目录
 *
 * `alternates` 是 Git 的"对象库复用"机制：里面写了另一个仓库的 objects
 * 路径之后，本仓库能直接读到那个仓库的**全部对象**（提交内容、历史、tag）。
 * `git clone --shared` / `--reference` 会生成它。
 *
 * 后果：一个看起来只在 `/proj/a` 里干活的仓库，可以读到
 * `<别人的>` 仓库的全部历史。只校验工作目录字符串的话，
 * 这条路完全看不见。
 *
 * ## 这个函数只负责"读出来"，不负责"允许不允许"
 *
 * 判"在不在信任域里"需要授权的资源表 —— 那是 `grants.js` 的事。
 * 这里把目标**如实登记**（含它指向的具体路径），由网关在判 `git.*` 动作时
 * 把这些路径算进目标集合。
 *
 * 相对路径按 Git 的规矩解析：相对于 `<commonDir>/objects`，不是仓库根。
 *
 * @param {string} commonDir
 * @returns {string[]} 绝对路径列表；没有 alternates 文件时是空数组
 */
/** 换行切分（用 RegExp 构造，避免源码里的转义被再解释一次）。 */
const SPLIT_RE = new RegExp('\r?\n');
export function readAlternates(commonDir) {
  if (!commonDir) return [];
  const file = path.join(commonDir, 'objects', 'info', 'alternates');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const base = path.join(commonDir, 'objects');
  const out = [];
  for (const raw of String(text).split(SPLIT_RE)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Git 支持 C 风格引号的路径；这里只取引号内的内容，不做转义展开 ——
    // 猜错一条转义规则比老实不做更危险。
    const quoted = /^"(.*)"$/.exec(line);
    const value = quoted ? quoted[1] : line;
    const abs = path.isAbsolute(value) ? value : path.resolve(base, value);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
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
        alternates: readAlternates(dotGit),
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
        alternates: readAlternates(commonDir),
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
export function runGit({
  repoDir, op, params = {}, gitFile = null, timeoutMs = DEFAULT_TIMEOUT_MS,
  /** 确认票据：只有 requiresConfirmation 的操作需要它。 */
  confirmation = null,
  /** 发起者角色（`{role: 'main'|'lead'|'member'}`）—— 角色门要用。 */
  actor = null,
  /**
   * 信任域（绝对路径数组）。默认 = 当前工作目录。
   *
   * 为什么会变成参数：单测要在临时目录里建仓库，而"工作目录"是进程级的；
   * 把信任域做成显式参数，测试才不必伪造全局状态。
   */
  trustRoots = null,
  /** 谁在写（写锁按它判重入/冲突）。脚本调用可以不传，那就是 `anon`。 */
  taskId = null,
} = {}) {
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

  // ★ requiresConfirmation 的操作**在这里**就拦住没有票据的调用。
  //
  //   为什么拦在这一层而不是工具层：这样"能执行 push 的唯一路径"是
  //   `先确认 → 再调用`，而不是靠每个调用点自己记得检查。
  //   票据的校验（目标摘要、通道、过期、一次一用）在 confirm.js 里，
  //   这里只确认"你带了票据且它自称已批准" —— 真正的校验由调用方
  //   在更外层做完（它知道当前策略版本）。
  // ★ 角色门：有些操作只给主 Bot 与负责人（规格 §7.1 的 G2/G3）。
  //
  //   为什么不只靠工具层藏工具：藏起来的工具挡不住"直接调 runGit"的内部调用，
  //   而"能执行这条路"应该只有一条。这里的判定也不信自称的角色字符串 ——
  //   调用方给的是它从 store 查出来的实际 role。
  if (Array.isArray(spec.roles) && spec.roles.length) {
    const role = String(actor?.role ?? '');
    if (!spec.roles.includes(role)) {
      return {
        ok: false, op: key, refused: true,
        error: `${key} 只给主 Bot 与负责人（当前角色：${role || '未知'}）。`
          + '执行 Bot 不能改写共享分支或丢代码 —— 需要的话请负责人来做。',
      };
    }
  }

  if (spec.requiresConfirmation) {
    if (!confirmation) {
      return {
        ok: false, op: key, refused: true,
        error: `${key} 属于不可撤销动作，必须在手机上确认后才能执行。`
          + '先生成确认请求，用户批准后再带着票据调用。',
      };
    }
    if (confirmation.decision !== 'approved') {
      return {
        ok: false, op: key, refused: true,
        error: `${key} 的确认还没被批准（当前：${confirmation.decision ?? '等待中'}）。`,
      };
    }
  }

  const git = gitFile ? { ok: true, file: gitFile } : locateGit();
  if (!git.ok) return { ok: false, op: key, error: git.error };

  const layout = resolveRepoLayout(repoDir);
  if (!layout.ok) return { ok: false, op: key, error: layout.error };

  // ★ 规格 §7.3：所有目标必须属于授予的信任域，否则拒绝。
  //
  //   为什么放在这里、而不是在工具层：`resolveRepoLayout` 是**所有** git 操作的
  //   共同入口，而越界的写法（worktree 的 commondir、外部 alternates、符号链接）
  //   在任何一条操作上都会出现。放在这里等于"没有一条路能绕过"。
  //
  // ★ 信任域也要**解析成真实路径**再比。macOS CI 上就这么挂过一次：
  //   `os.tmpdir()` 给的是 `/var/folders/...`，而 `/var` 是指向 `/private/var`
  //   的符号链接 —— layout 里是解析后的，roots 里是没解析的，两边永远不相等，
  //   于是"合法仓库"被判成"越界"。（同一条坑 `resolveRepoLayout` 早就踩过。）
  const rawRoots = Array.isArray(trustRoots) && trustRoots.length ? trustRoots : [config.workspace];
  const trust = repoTrustVerdict({
    layout,
    roots: rawRoots.map((r) => realish(r)),
  });
  if (!trust.ok) {
    return { ok: false, op: key, refused: true, error: trust.text, code: trust.code, outside: trust.outside };
  }

  const args = [
    ...GLOBAL_SAFE_ARGS,
    ...spec.args(params ?? {}),
  ];

  // ★ 固定几个会"改行为"的配置，不信任仓库里写的东西。
  //   这几条是**命令行层**的 -c，优先级高于仓库/全局配置，
  //   所以即使仓库里写了 diff.external 也压不过我们。
  //
  //   ⚠ 但 hooks **不在**这个保护范围内：core.hooksPath 就是一条配置，
  //   它把 hook 目录整个换掉（很多人写在 ~/.gitconfig 里集中管理）。
  //   我们不加 --no-verify，所以 git 该跑哪个目录就跑哪个目录 ——
  //   这是对的（用户的配置归用户）。但**审计必须照实报**，
  //   所以 listActiveHooks 会去问 git 真实的 hooksPath，而不是想当然
  //   读 .git/hooks。见 resolveHooksDir 的注释。
  const configGuards = [
    '-c', 'core.pager=cat',      // 分页器可能是个程序，而且会挂住管道
    '-c', 'core.quotepath=false', // 中文文件名不要转成 \344\275\240
    '-c', 'advice.detachedHead=false',
  ];

  // ★ 规格 §7.3：同一公共目录的 Git **写入**按公共目录协调。
  //
  //   只对 mutates 的操作拿锁：读操作并发没有坏处（而且经常并行读）。
  //   拿不到就**拒绝**而不是排队 —— runGit 是同步的，等只能变成"模型干等"。
  let lockToken = null;
  if (spec.mutates) {
    const got = acquireRepoWrite({ commonDir: layout.commonDir, taskId: String(taskId ?? 'anon') });
    if (!got.ok) return { ok: false, op: key, refused: true, code: got.code, error: got.text };
    lockToken = { commonDir: layout.commonDir, taskId: String(taskId ?? 'anon') };
  }

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

  // ★ 写锁必须放：这里不用 try/finally 包整个函数（那会改动太大），
  //   而是在**每一条返回路径**上都放。三处返回，都要有。
  const dropLock = () => {
    if (lockToken) {
      releaseRepoWrite(lockToken);
      lockToken = null;
    }
  };

  if (res.error) {
    dropLock();
    return { ok: false, op: key, error: `git 启动失败：${String(res.error.message || res.error)}` };
  }
  let stdout = res.stdout || '';
  let truncated = false;
  if (stdout.length > MAX_OUTPUT_CHARS) {
    stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }
  const stderrText = res.stderr || '';
  dropLock();
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
 * 这个仓库**实际**会用哪个目录的 hooks。
 *
 * ★ 默认是 `$GIT_DIR/hooks`，但 `core.hooksPath` 一设就换成它 —— 而
 *   `core.hooksPath` 常常写在**用户的 ~/.gitconfig** 里（很多人用它把
 *   hooks 集中到 ~/.githooks）。本机就是这种配置。
 *
 *   不加这一步的后果：审计把 ".git/hooks 里有哪些 hook" 当成
 *   "这次提交跑了哪些 hook" 报给用户 —— 而实际一个都没跑。规格 §7.1
 *   要的是"让用户事后能查到真实发生了什么"，报错目录等于没报。
 *
 *   注意 `GIT_CONFIG_NOSYSTEM` 只屏蔽系统级（/etc/gitconfig），
 *   用户全局的 ~/.gitconfig 照样生效，所以这条必须照 git 的真实解析来。
 *
 * 相对路径按 git 的规则解析：相对**工作树根**（githooks(5) 的 DESCRIPTION）。
 */
function resolveHooksDir(layout) {
  const fallback = path.join(layout.commonDir, 'hooks');
  const git = locateGit();
  if (!git.ok) return fallback;
  const res = spawnSync(git.file, ['config', '--get', 'core.hooksPath'], {
    cwd: layout.root,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    // 与 runGit 保持同一视野：提交时怎么解析，这里就怎么解析
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  });
  const value = String(res.stdout ?? '').trim();
  if (res.status !== 0 || !value) return fallback;
  // ~ 开头：git 自己会展开，但我们这边要自己来
  const expanded = value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(1))
    : value;
  return path.isAbsolute(expanded) ? expanded : path.resolve(layout.root, expanded);
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
  const dir = resolveHooksDir(layout);
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

/**
 * push 的**确认目标**：用户到底在批准什么。
 *
 * 规格 §9：「确认绑定具体对象、内容/差异、金额（如适用）、目的地、有效期」。
 * 对 push 来说，目的地 = 远端 + 分支，内容 = 将要推上去的那些提交。
 *
 * 所以要先把 diff 摘要算进来 —— 只绑 remote+ref 不够：用户在确认时看到的
 * 是"推这 3 个提交"，如果之后又提交了一次，那 3 个就变成 4 个，
 * 摘要必须跟着变，逼他重新看。
 *
 * @param {object} p
 * @param {string} p.repoDir
 * @param {string} [p.remote]
 * @param {string[]} [p.branches]
 * @param {string} [p.gitFile]
 * @returns {{ok:true, target:object, display:object}|{ok:false, error:string}}
 */
export function describePushTarget({ repoDir, remote = 'origin', branches = [], gitFile = null } = {}) {
  const git = gitFile ? { ok: true, file: gitFile } : locateGit();
  if (!git.ok) return { ok: false, error: git.error };
  const layout = resolveRepoLayout(repoDir);
  if (!layout.ok) return { ok: false, error: layout.error };

  /** 跑一条只读命令拿文本（不走 runGit，避免 push 自己又要求确认）。 */
  const read = (args) => {
    const res = spawnSync(git.file, ['--no-pager', ...args], {
      cwd: layout.root, encoding: 'utf8', timeout: 15_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return { ok: res.status === 0, text: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
  };

  const refs = (Array.isArray(branches) && branches.length ? branches : [currentBranchName(git.file, layout.root) ?? '']);
  const names = refs.filter(Boolean);
  if (!names.length) return { ok: false, error: '不知道要推哪个分支' };

  const details = [];
  for (const name of names) {
    // 上游：origin/main 之类。没有上游时远端分支名就是本地名。
    const up = read(['rev-parse', '--abbrev-ref', `${name}@{upstream}`]);
    const upstream = up.ok ? up.text : `${remote}/${name}`;
    const upstreamRef = upstream.includes('/') ? upstream.split('/').slice(1).join('/') : name;

    // 将要推上去的提交（远端没有的一侧）
    const range = read(['log', '--oneline', '--date=short', '--pretty=format:%h %ad %s', `${upstream}..${name}`]);
    const commits = range.ok ? range.text.split('\n').filter(Boolean) : [];
    const head = read(['rev-parse', '--short', 'HEAD']);

    details.push({
      branch: name,
      upstream,
      upstreamRef,
      head: head.ok ? head.text : '',
      commitCount: commits.length,
      commits: commits.slice(0, 20),
    });
  }

  // ★ 目标里只放**会影响结果**的事实：远端、分支、每个分支的 HEAD。
  //   不放时间戳之类 —— 那会让每次生成的摘要都不同，用户被反复要求确认。
  const target = {
    remote,
    branches: details.map((d) => ({ branch: d.branch, upstream: d.upstream, head: d.head, commitCount: d.commitCount })),
  };
  return {
    ok: true,
    target,
    display: {
      remote,
      branches: details.map((d) => ({
        branch: d.branch,
        upstream: d.upstream,
        commitCount: d.commitCount,
        commits: d.commits,
      })),
    },
  };
}

/** 当前分支名（detached HEAD 时返回 null）。 */
function currentBranchName(gitFile, cwd) {
  const res = spawnSync(gitFile, ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  if (res.status !== 0) return null;
  const name = (res.stdout || '').trim();
  return name && name !== 'HEAD' ? name : null;
}

/**
 * push 之后的核对：规格 §7.1 要求"退出码 + 预期仓库状态"同时满足。
 *
 * push 的"仓库状态"= 本地分支的 HEAD 与远端引用一致。
 * 只信退出码不够 —— 有些 hook / 远端配置会让 push"成功但不生效"。
 *
 * @returns {{ok:boolean, remoteHead?:string, localHead?:string, matched?:boolean, error?:string}}
 */
export function verifyPushLanded({ repoDir, remote = 'origin', branch, gitFile = null } = {}) {
  const git = gitFile ? { ok: true, file: gitFile } : locateGit();
  if (!git.ok) return { ok: false, error: git.error };
  const layout = resolveRepoLayout(repoDir);
  if (!layout.ok) return { ok: false, error: layout.error };

  const run = (args) => spawnSync(git.file, ['--no-pager', ...args], {
    cwd: layout.root, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });

  const local = run(['rev-parse', branch]);
  if (local.status !== 0) return { ok: false, error: `读不出本地 ${branch}` };
  const localHead = (local.stdout || '').trim();

  // 远端引用在本地仓库里有一份缓存（refs/remotes/<remote>/<branch>），
  // push 成功后它会更新。这正是"预期仓库状态"的可用证据。
  const branchName = String(branch).includes('/') ? String(branch).split('/').slice(1).join('/') : String(branch);
  const remoteRef = run(['rev-parse', `refs/remotes/${remote}/${branchName}`]);
  const remoteHead = remoteRef.status === 0 ? (remoteRef.stdout || '').trim() : '';

  return {
    ok: true,
    localHead,
    remoteHead,
    matched: Boolean(remoteHead) && remoteHead === localHead,
  };
}
