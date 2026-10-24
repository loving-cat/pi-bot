/**
 * 跨平台启动一条**用户填写的命令**（MCP 本地服务、外部 CLI 探测都走这里）。
 *
 * ## 为什么需要单独一层
 *
 * Windows 上 `npx` / `npm` / `pnpm` / `uvx` 落地的是 `.cmd` 批处理 shim，
 * 真正的可执行文件名字带扩展名。这里有两个坑叠在一起：
 *
 *   1. `shell: false` 直接 spawn 无扩展名的 `npx`：Node 22 起对 `.bat/.cmd`
 *      有安全限制（CVE-2024-27980），不同小版本的行为不一致 —— 有的抛
 *      `EINVAL`，有的能跑。用户看到的就是"明明装了 npx，点了测试说找不到"。
 *   2. `shell: true` 省事，但参数会被拼进一条命令串：用户填的 MCP 参数里
 *      只要带空格、引号、`&`，就会被 cmd 重新解释（甚至执行别的命令）。
 *
 * 所以这里显式做两件事：先按 PATHEXT 解析出真实文件；如果它是 `.cmd/.bat`，
 * 就用 `cmd.exe /d /s /c` 传一条**逐参数转义过**的命令行（与 cross-spawn 同款规则），
 * 既绕开版本差异，又不会让参数漏进 shell。
 *
 * 非 Windows 平台：原样 `spawn`，不引入任何行为变化。
 */
import './child-env.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from './child-env.js';

const isWindows = process.platform === 'win32';

/** `cmd.exe` 里有特殊含义的字符；不转义就会被当成控制符。 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * 在 PATH 里按 PATHEXT 查找命令（纯 Windows 语义，任何主机上都能测）。
 *
 * @param {string} command 用户填的命令（`npx` / `npx.cmd` / `C:\x\y.exe`）
 * @param {Record<string,string>} [env] 一般是 process.env
 * @returns {string|null} 找到的真实文件绝对路径
 */
export function whichOnWindows(command, env = process.env) {
  const raw = String(command ?? '').trim();
  if (!raw) return null;

  const pathext = (env.PATHEXT || '.com;.exe;.bat;.cmd')
    .split(';')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const hasExtension = path.win32.extname(raw) !== '';
  const exts = hasExtension ? [''] : pathext;

  const candidates = [];
  if (/[\\/]/.test(raw)) {
    // 已经带了路径：只按原样（或补扩展名）检查
    for (const ext of exts) candidates.push(raw + ext);
  } else {
    const dirs = String(env.PATH || '').split(';').filter(Boolean);
    for (const dir of dirs) {
      // 按目录自己的分隔符拼：Windows 的 PATH 里也可能出现 `/c/...` 这种
      // Git Bash / MSYS 风格路径，一律 path.win32.join 会拼成 `\c\...`，找不到。
      const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
      const base = dir.endsWith(sep) ? dir : dir + sep;
      for (const ext of exts) candidates.push(base + raw + ext);
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在就继续
    }
  }
  return null;
}

/** 转义命令行里的可执行文件名（`&` 之类要加 `^`）。 */
export function escapeCmdCommand(value) {
  return String(value).replace(CMD_META, '^$1');
}

/**
 * 转义单个参数：先按 CreateProcess 的引号规则包一层，再对 cmd 的元字符加 `^`。
 *
 * `doubleEscape` 用于 npm 生成的 `.cmd` shim —— 那类 shim 里面会再走一次
 * `%*` 展开，不多转一次引号就会被吃掉（cross-spawn 也是这么处理的）。
 */
export function escapeCmdArgument(value, doubleEscape = false) {
  let out = String(value);
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(CMD_META, '^$1');
  return doubleEscape ? out.replace(CMD_META, '^$1') : out;
}

/**
 * 拼出 `cmd.exe /d /s /c` 需要的那一条命令行。
 * 单独导出是为了能单测：这段一旦转义错了，表现是"命令能起但参数变了"，极难查。
 *
 * 只有 npm/pnpm 生成的 `node_modules/.bin/*.cmd` shim 需要双转义 ——
 * 那类 shim 内部会再展开一次 `%*`；普通 `.cmd` 单次就够，多转一层会让
 * 参数里凭空多出引号和 `^`（`echo %~1` 会打印 `"hello world"`）。
 */
export function buildCmdLine(command, args = []) {
  const isShim = /node_modules[\\/]\.bin[\\/][^\\/]+\.(cmd|bat)$/i.test(command);
  return [escapeCmdCommand(command), ...args.map((a) => escapeCmdArgument(a, isShim))].join(' ');
}

/**
 * 结束探测进程。
 *
 * 为什么不在这里调 taskkill：在装了实时防护的 Windows 上，
 * `CreateProcessW(taskkill)` 会同步阻塞数秒（交替出现，不是偶发）。
 * 服务端是单进程 Node，这一下会把 HTTP/WS 全卡住 —— 为了收一个探测进程
 * 冻住整个服务端，不划算。
 *
 * 改用「关 stdin（MCP 的 EOF 退出信号）+ 结束直接子进程」：
 *   · 直启的命令（node / python / .exe）一次就死；
 *   · `.cmd` wrapper 底下真正的服务收到 stdin EOF 后自己退（MCP 协议就这样）。
 * 真实 session 关闭时仍走 pi 自己的 taskkill /T，那里不在服务端主线程热路径上。
 */
export function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    child.stdin?.end();
  } catch {
    // 已经关了
  }
  try {
    child.kill();
  } catch {
    // 已经退了
  }
}

/**
 * 启动命令。Windows 上自动解析 `.cmd/.bat` 并走 cmd.exe；其它平台直接 spawn。
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {import('node:child_process').SpawnOptions} [options]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnCommand(command, args = [], options = {}) {
  const base = {
    windowsHide: true,
    ...options,
    env: childEnv(options.env ?? process.env),
  };
  if (!isWindows) return spawn(command, args, base);

  const env = options.env ?? process.env;
  const resolved = whichOnWindows(command, env) ?? String(command);
  if (!/\.(cmd|bat)$/i.test(resolved)) {
    return spawn(resolved, args, base);
  }

  const line = buildCmdLine(resolved, args);
  const comspec = env.ComSpec || process.env.ComSpec || 'cmd.exe';
  return spawn(comspec, ['/d', '/s', '/c', `"${line}"`], {
    ...base,
    windowsVerbatimArguments: true,
  });
}
