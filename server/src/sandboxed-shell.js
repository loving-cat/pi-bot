/**
 * 挂了 MCP 的 bot：把 pi 自带的 bash / powershell 换成沙箱版。
 *
 * ## 为什么必须替换而不是"审批时拦一下"
 *
 * 审批只能决定"这条命令要不要人点同意"，管不住命令能碰到什么。
 * 一个被批准的 `cat ~/.ssh/id_ed25519` 照样能读到私钥 —— 用户点同意时
 * 未必意识到参数是那个。所以对"有外部执行能力"的 bot，命令本身要受限。
 *
 * ## 怎么换
 *
 * pi 的 bash 工具支持注入 `BashOperations`（见 pi-coding-agent 的
 * core/tools/bash.d.ts）。我们用 `createBashTool(cwd, { operations })`
 * 造一个同名工具，塞进会话的 customTools —— 同名会覆盖内置实现。
 *
 * operations 里做两件事：
 *   1. 用 wrapCommand 把命令包进 sandbox-exec（macOS）/ bwrap（Linux）
 *   2. 用 buildChildEnv 造一份干净的子进程环境（不含 token / 宿主 PATH）
 *
 * ## fail-closed
 *
 * 沙箱不可用、工作目录不安全、平台不支持 —— 一律返回失败，**不降级**
 * 成无沙箱执行。宁可这条命令跑不了，也不能在没有隔离的情况下跑它。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildChildEnv, hostLocale } from './child-env-typed.js';

/** 解析成真实路径；失败时原样返回（目录可能还没建）。 */
function realPath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
import { wrapCommand } from './sandbox.js';
import { windowsSandboxMessage } from './sandbox-win.js';

/**
 * 造一个 BashOperations：每条命令都在沙箱里跑。
 *
 * @param {object} o
 * @param {string} o.workDir    bot 的工作目录
 * @param {string} o.instanceDir 实例私有目录（HOME / TMPDIR / profile 落点）
 * @param {string} o.dataDir    pi-bot 数据目录（含 token，必须拒绝）
 * @returns {{exec: Function}}
 */
export function createSandboxedOperations({ workDir, instanceDir, dataDir }) {
  const tmpDir = path.join(instanceDir, 'tmp');
  const homeDir = path.join(instanceDir, 'home');
  try {
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  } catch {
    // 建不出来就让下面的 wrapCommand 报错
  }

  return {
    async exec(command, cwd, options = {}) {
      const onData = typeof options.onData === 'function' ? options.onData : () => {};
      const effectiveCwd = cwd || workDir;

      const wrapped = wrapCommand({
        command,
        workDir: effectiveCwd,
        tmpDir,
        // 数据目录（token 所在）始终拒绝；实例目录是它的一部分，
        // 但 wrapCommand 内部会排除"工作目录/临时目录包含它"的场景，
        // 而实例目录本来就不在允许列表里，所以直接拒掉整个数据目录即可。
        denyPaths: dataDir ? [dataDir] : [],
        instanceDir,
        dataDir,
      });
      if (!wrapped.ok) {
        const reason = wrapped.message || wrapped.reason || 'unknown';
        onData(Buffer.from(`[沙箱不可用，已拒绝执行] ${reason}\n`, 'utf8'));
        return { exitCode: 1 };
      }

      // ★ 传给子进程的 HOME / TMPDIR 必须是 realpath 形式。
      //
      //   实测：Seatbelt 用规范化后的路径比对规则。沙箱 profile 里 allow 的是
      //   /private/var/... （realpath），如果这里把 /var/... （符号链接形式）
      //   交给子进程，子进程写 $TMPDIR 时带的是符号链接路径，匹配不到 allow，
      //   于是 "写不了自己的 tmp"。统一用 realpath 之后两边一致。
      const env = buildChildEnv({
        kind: 'bash',
        homeDir: realPath(homeDir),
        tmpDir: realPath(tmpDir),
        locale: hostLocale(),
        // 调用方（pi）给的 env 只在没有沙箱时才有意义；沙箱里一律用我们这份
        extra: null,
      });

      // ★ Windows 分支有两处不同：
      //   · 启动器自己设 cwd（AppContainer 的 AC 目录）和整份环境变量，
      //     Node 再传一份会和它打架（尤其 cwd 一传就又回到"用户目录不可进"）。
      //   · 启动器读走 cmd 文件后会删；Node 在收尾时再删一次兜底。
      const isWindowsWrap = process.platform === 'win32';
      const spawnCwd = isWindowsWrap ? undefined : effectiveCwd;
      const spawnEnv = isWindowsWrap ? undefined : env;

// 注意：Windows 分支的 stdout 由启动器接管，stdin 必须给 pipe 而不是 ignore。
      //
      // ★ 为什么不能给 'ignore'（实测）：/
      //   'ignore' 会让子进程的 fd0 变成无效句柄。MSYS2 的 git 启动期做
      //   sanitize_stdfds()：发现 0/1/2 无效就去开 /dev/null 补上，
      //   而 AppContainer 里打开 NUL 被拒 → 每条 git 命令都死在
      //   "could not open '/dev/null'"。
      //   给 'pipe' 之后 fd0 有效，git 不再走那条路（同一台机器实测）。
      //
      //   代价：管道需要有人读。这里让它自然关闭（不写 stdin），
      //   子进程读 stdin 会得到 EOF。Node 侧在 close 时 destroy。
      return new Promise((resolve) => {
        let child;
        try {
          child = spawn(wrapped.file, wrapped.args, {
            cwd: spawnCwd,
            env: spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            // 沙箱包装已经带了 shell，不能再套一层
            shell: false,
          });
          // 我们从不往 stdin 写东西；立即结束它，让子进程读到 EOF。
          // 'error' 必须吞掉：进程已经退出时 write 会抛 EPIPE。
          child.stdin?.on('error', () => {});
          child.stdin?.end();
        } catch (err) {
          onData(Buffer.from(`[沙箱启动失败] ${err?.message || err}\n`, 'utf8'));
          try { wrapped.cleanup?.(); } catch { /* 已删 */ }
          resolve({ exitCode: 1 });
          return;
        }

        const onAbort = () => {
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout?.on('data', (d) => onData(d));
        child.stderr?.on('data', (d) => onData(d));

        child.on('error', (err) => {
          onData(Buffer.from(`[沙箱进程错误] ${err?.message || err}\n`, 'utf8'));
          options.signal?.removeEventListener('abort', onAbort);
          try { wrapped.cleanup?.(); } catch { /* 已删 */ }
          resolve({ exitCode: 1 });
        });
        child.on('close', (code, signal) => {
          options.signal?.removeEventListener('abort', onAbort);
          // Windows 的 cmd 文件由启动器读走后自己删；这里兜一次底，
          // 防止启动器根本没起来（CreateProcess 失败之类）时留下临时文件。
          try { wrapped.cleanup?.(); } catch { /* 已删 */ }
          if (options.signal?.aborted) resolve({ exitCode: 130 });
          // 契约：被信号杀掉报 128 + signal 号
          else if (code === null && signal) resolve({ exitCode: 128 + (os.constants.signals[signal] ?? 0) });
          else resolve({ exitCode: code ?? 1 });
        });
      });
    },
  };
}

/**
 * 需要时造出沙箱版 shell 工具；不需要时返回空数组。
 *
 * 何时需要：这个 bot 挂了任何外部 MCP —— 它已经具备"驱动外部程序"的能力，
 * 那么它自己的 shell 也不该能碰到用户凭据。
 *
 * 平台处理：
 *   · macOS / Linux —— 正常造沙箱版
 *   · Windows      —— **不实现隔离**，造一个"永远拒绝"的工具：
 *                    宁可跑不了，也不在无隔离的情况下跑。
 *
 * @param {object} o
 * @param {object} o.bot
 * @param {string} o.workDir
 * @param {string} o.dataDir
 * @param {string[]} o.tools 该会话的内置工具名（只替换实际启用了的）
 * @param {object} o.pi      { createBashTool, createPowerShellTool }
 * @returns {object[]}
 */
export function buildSandboxedShellTools({ bot, workDir, dataDir, tools, pi }) {
  const wantsBash = Array.isArray(tools) && tools.includes('bash');
  const wantsPowerShell = Array.isArray(tools) && tools.includes('powershell');
  if (!wantsBash && !wantsPowerShell) return [];

  // 没挂 MCP → 不改变任何行为
  let hasMcp = false;
  try {
    hasMcp = storeMcpCount(bot?.id) > 0;
  } catch {
    hasMcp = false;
  }
  if (!hasMcp) return [];

  const instanceDir = path.join(
    dataDir || os.tmpdir(),
    'instances',
    String(bot?.id ?? 'bot').replace(/[^A-Za-z0-9_-]/g, '_'),
  );
  const out = [];

  if (wantsBash) {
    // spec §18：v0 只交付 PowerShell。Git Bash 在 AppContainer 里能起
    // （实测 `bash -c 'pwd'` 有输出），但 MSYS2 的 /dev/null、/tmp、/etc/passwd
    // 生成都没验证过，git 在 bash 里也会退化。宁可明确拒绝，不留半坏状态。
    if (process.platform === 'win32') {
      out.push(refusingTool(
        'bash',
        'Windows 上这个 bot 的 bash 工具暂不提供（沙箱 v0 只交付 PowerShell）。'
        + '请改用 powershell 工具；需要 sh 语法时显式调用 bash.exe。',
      ));
    } else {
      const tool = createRefusingOrSandboxed('bash', pi.createBashTool, {
        workDir, instanceDir, dataDir, pi,
      });
      if (tool) out.push(tool);
    }
  }
  if (wantsPowerShell) {
    // powershell 只在 Windows 存在；非 Windows 上 pi 就算有工厂也不该用
    if (process.platform !== 'win32') {
      out.push(refusingTool('powershell', '当前平台没有 PowerShell，这个 bot 挂了 MCP，工具已禁用。'));
    } else {
      const tool = createRefusingOrSandboxed('powershell', pi.createPowerShellTool, {
        workDir, instanceDir, dataDir, pi,
      });
      if (tool) out.push(tool);
    }
  }
  return out;
}

/**
 * 造一个"永远拒绝执行"的工具。
 *
 * 用于两种情况：沙箱真的不可用（启动器缺失 / 平台不支持 / selfcheck 失败），
 * 以及 Windows 上的 bash（v0 只交付 PowerShell，见 spec §18）。
 * 保持工具名存在（模型能看到它、知道它被禁用了），
 * 但任何调用都返回明确的拒绝，而不是悄悄退回无沙箱执行。
 */
function refusingTool(name, message) {
  return {
    name,
    label: name,
    description: `【已禁用】${message}`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '超时（毫秒）' },
      },
      required: ['command'],
    },
    async execute() {
      return {
        isError: true,
        content: [{ type: 'text', text: `[拒绝执行] ${message}` }],
      };
    },
  };
}

/** 沙箱可用就造沙箱工具；不可用（或平台不支持）就造拒绝工具。 */
function createRefusingOrSandboxed(name, factory, { workDir, instanceDir, dataDir, pi }) {
  if (typeof factory !== 'function') {
    return refusingTool(name, `pi 没有提供 ${name} 工具工厂。`);
  }
  // ★ 把 instanceDir 传进去：Windows 侧 probe 会对这个实例跑 selfcheck
  //   （建 profile + 授 ACE），失败就 fail-closed。
  const probe = probeSandboxForShell({ instanceDir });
  if (!probe.available) {
    return refusingTool(
      name,
      process.platform === 'win32'
        ? windowsSandboxMessage(probe.reason, probe.detail)
        : `沙箱不可用（${probe.reason}），这个 bot 挂了 MCP，为安全起见禁止执行 shell 命令。`,
    );
  }
  const operations = createSandboxedOperations({ workDir, instanceDir, dataDir });
  try {
    return factory(workDir, { operations });
  } catch {
    return refusingTool(name, '沙箱版 shell 工具构造失败，已禁用。');
  }
}

/** 简化包装，避免在模块顶层 import store（会造成循环依赖）。 */
let _probeSandbox = null;
function probeSandboxForShell(opts) {
  return _probeSandbox(opts);
}

/** 由 index.js 在启动时注入，避免循环依赖。 */
export function setSandboxProbe(fn) {
  _probeSandbox = fn;
}

/** 由 index.js 注入 store 计数函数（避免循环依赖）。 */
let _storeMcpCount = () => 0;
export function setMcpCounter(fn) {
  _storeMcpCount = fn;
}

function storeMcpCount(botId) {
  return _storeMcpCount(botId);
}

/**
 * 造沙箱版的 bash 工具（同名覆盖 pi 内置的）。
 *
 * @returns {object|null} 工具定义；平台不支持时返回一个"永远拒绝"的工具
 */
export function createSandboxedBashTool({ pi, workDir, instanceDir, dataDir }) {
  const operations = createSandboxedOperations({ workDir, instanceDir, dataDir });
  try {
    return pi.createBashTool(workDir, { operations });
  } catch {
    return null;
  }
}

/** 造沙箱版的 powershell 工具（仅 Windows 有意义）。 */
export function createSandboxedPowerShellTool({ pi, workDir, instanceDir, dataDir }) {
  if (typeof pi.createPowerShellTool !== 'function') return null;
  const operations = createSandboxedOperations({ workDir, instanceDir, dataDir });
  try {
    return pi.createPowerShellTool(workDir, { operations });
  } catch {
    return null;
  }
}
