/**
 * Windows 沙箱：Node 侧对 `pibot-sandbox.exe` 的封装。
 *
 * Mac/Linux 的隔离由系统自带的 `sandbox-exec` / `bwrap` 提供，Node 直接
 * 拼参数就行。Windows 没有等价物：AppContainer 只认
 * `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`，而那个扩展属性块
 * `child_process` 填不了。所以仓库里带一个 Rust 启动器
 * （`native/pibot-sandbox/`），这里只负责：
 *
 *   · 找到它、校验版本与哈希（发版清单）
 *   · 把命令写进 cmd 文件（避免 Windows 命令行转义注入）
 *   · 拼 `run --profile ... --workdir ...` 参数
 *   · 把启动器的机读错误码翻成人话
 *
 * ## fail-closed
 *
 * 启动器缺失、版本不符、哈希不对、selfcheck 失败 —— 一律返回不可用，
 * 上层拒绝执行命令。**绝不**退回无沙箱执行。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 这份 Node 代码期望的启动器版本（与 native/pibot-sandbox/Cargo.toml 一致）。 */
export const LAUNCHER_VERSION = '0.1.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 启动器可能的位置，按优先级。 */
export function launcherCandidates() {
  const env = process.env.PIBOT_SANDBOX_EXE;
  const list = [];
  if (env) list.push(env);
  // 发行包：server/resources/pibot-sandbox.exe（pack 脚本拷进来）
  list.push(path.join(HERE, '..', 'resources', 'pibot-sandbox.exe'));
  // 开发仓库：native/pibot-sandbox/target/release/
  list.push(path.join(HERE, '..', '..', 'native', 'pibot-sandbox', 'target', 'release', 'pibot-sandbox.exe'));
  return list;
}

/** 找到启动器；找不到返回 null。 */
export function launcherPath() {
  for (const p of launcherCandidates()) {
    try {
      if (p && fs.statSync(p).isFile()) return p;
    } catch { /* 换下一个 */ }
  }
  return null;
}

/**
 * 版本与哈希校验。
 *
 * 版本不匹配 = 仓库里 Node 代码升级了、exe 没重编译，这种状态跑起来行为
 * 会是"看起来没事、其实约束少了"。所以宁可拒绝，也不猜。
 *
 * @returns {{ok: true, version: string} | {ok: false, reason: string, detail?: string}}
 */
export function verifyLauncher(exePath) {
  if (!exePath) return { ok: false, reason: 'no_binary' };
  let out;
  try {
    out = spawnSync(exePath, ['version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  } catch (err) {
    return { ok: false, reason: 'launcher_broken', detail: String(err?.message || err) };
  }
  if (out.status !== 0) {
    return { ok: false, reason: 'launcher_broken', detail: (out.stderr || '').slice(0, 200) };
  }
  const m = /pibot-sandbox\s+(\S+)/.exec(out.stdout || '');
  if (!m) return { ok: false, reason: 'launcher_broken', detail: '版本输出无法解析' };
  if (m[1] !== LAUNCHER_VERSION) {
    return {
      ok: false,
      reason: 'launcher_version_mismatch',
      detail: `期望 ${LAUNCHER_VERSION}，实际 ${m[1]}`,
    };
  }
  // 发版清单里的哈希（可选）。有就必须对得上。
  const manifest = path.join(path.dirname(exePath), 'pibot-sandbox.sha256');
  try {
    if (fs.statSync(manifest).isFile()) {
      const want = fs.readFileSync(manifest, 'utf8').trim().split(/\s+/)[0].toLowerCase();
      const got = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
      if (want && want !== got) {
        return { ok: false, reason: 'launcher_hash_mismatch', detail: `${want} != ${got}` };
      }
    }
  } catch { /* 没有清单就不校验 */ }
  return { ok: true, version: m[1] };
}

/** 每个实例一个 AppContainer profile 名（spec §6.1）。 */
export function profileNameFor(instanceKey) {
  const raw = String(instanceKey ?? 'default');
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  // 名字要稳定（同一实例重启后还是同一个 profile，ACE 才能复用）
  return `pi-bot.sbx.${safe}.${hash}`;
}

/**
 * 探测 Windows 沙箱是否可用。
 *
 * @param {{instanceDir?: string, dataDir?: string, forceCheck?: boolean}} [o]
 * @returns {{available: boolean, kind: string, reason?: string, binary?: string}}
 */
export function probeWindowsSandbox({ instanceDir = '', forceCheck = false } = {}) {
  if (process.platform !== 'win32') {
    return { available: false, kind: 'appcontainer', reason: 'unsupported_platform' };
  }
  const exe = launcherPath();
  if (!exe) return { available: false, kind: 'appcontainer', reason: 'no_binary' };
  const ver = verifyLauncher(exe);
  if (!ver.ok) return { available: false, kind: 'appcontainer', reason: ver.reason, detail: ver.detail };

  if (instanceDir) {
    // ★ selfcheck 要自建 profile + 授 ACE，实测一次约 200ms（含两次进程 spawn）。
    //   每条命令都跑一遍的话，一个 10 条命令的任务白花 2 秒以上。
    //
    //   结果缓存 60 秒：selfcheck 失败的原因（企业策略禁用 AppContainer、
    //   路径不可写）都是**稳定**的，不需要每条命令重测；同时
    //   · 缓存过期后会重新探测（不会永久粘住旧的"可用"）；
    //   · forceCheck=true 可强制重测（启动 / 诊断用）；
    //   · 真正的 ACE 授权不依赖这里的缓存 —— run 每次都会重授，
    //     所以"profile 被外部删了"这类情况还是会在 run 阶段暴露。
    const cached = selfcheckCache.get(instanceDir);
    const now = Date.now();
    if (!forceCheck && cached && now - cached.at < SELFCHECK_TTL_MS) {
      return cached.result;
    }
    const profile = profileNameFor(instanceDir);
    const res = spawnSync(
      exe,
      ['selfcheck', '--profile', profile, '--instance', instanceDir],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    let result;
    if (res.status !== 0) {
      const code = /PIBOT_SANDBOX_ERR\s+(\S+)/.exec(res.stderr || '')?.[1] ?? 'selfcheck_failed';
      result = { available: false, kind: 'appcontainer', reason: code, detail: (res.stderr || '').slice(0, 200) };
    } else {
      result = { available: true, kind: 'appcontainer', binary: exe };
    }
    selfcheckCache.set(instanceDir, { at: now, result });
    return result;
  }
  return { available: true, kind: 'appcontainer', binary: exe };
}

/** selfcheck 结果缓存（实例目录 → {at, result}）。 */
const selfcheckCache = new Map();

/** 缓存有效期：60 秒。见 probeWindowsSandbox 里的注释。 */
const SELFCHECK_TTL_MS = 60_000;

/** 清掉缓存（实例目录变化 / 测试用）。 */
export function clearSelfcheckCache() {
  selfcheckCache.clear();
}

/**
 * 把一条命令包装成"在 Windows 沙箱里跑"。
 *
 * @param {object} o
 * @param {string} o.command   原始命令（PowerShell 语法）
 * @param {string} o.workDir   工作目录（rw）
 * @param {string} o.instanceDir 实例目录（HOME / TEMP / cmd-file 落点）
 * @param {string} [o.dataDir] pi-bot 数据目录（启动器会拒绝把它当工作目录）
 * @param {string[]} [o.extraEnv] 额外 `KEY=VALUE`
 * @returns {{ok: true, file: string, args: string[], cleanup: Function} | {ok: false, reason: string, detail?: string}}
 */
export function wrapWindowsCommand({
  command, workDir, instanceDir, dataDir = '', extraEnv = [],
}) {
  const probe = probeWindowsSandbox();
  if (!probe.available) return { ok: false, reason: probe.reason, detail: probe.detail };

  if (!instanceDir) return { ok: false, reason: 'no_instance_dir' };
  try {
    fs.mkdirSync(instanceDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'instance_mkdir_failed', detail: String(err?.message || err) };
  }

  // 命令写文件再传（spec §5）：Windows 命令行引号转义规则和 POSIX 不同，
  // 直接把用户命令拼进命令行会在 `"` / `^` / `%` 这些字符上出错。
  const cmdFile = path.join(instanceDir, `cmd-${process.pid}-${Date.now()}.ps1`);
  try {
    fs.writeFileSync(cmdFile, command, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    return { ok: false, reason: 'cmd_file_failed', detail: String(err?.message || err) };
  }

  const args = [
    'run',
    '--profile', profileNameFor(instanceDir),
    '--workdir', path.resolve(workDir),
    '--instance', path.resolve(instanceDir),
    '--shell', 'powershell',
    '--cmd-file', cmdFile,
  ];
  if (dataDir) args.push('--env', `PIBOT_DATA_DIR=${dataDir}`);
  for (const kv of extraEnv) {
    if (typeof kv === 'string' && kv.includes('=')) args.push('--env', kv);
  }
  return {
    ok: true,
    file: probe.binary,
    args,
    // 启动器读入内存后会自己删；这里再兜一次，防止启动器没起来
    cleanup: () => { try { fs.unlinkSync(cmdFile); } catch { /* 已删 */ } },
  };
}

/**
 * 启动器错误码 → 用户能看懂的话（spec §9 的 `sandboxUnavailableMessage` 补位）。
 */
export function windowsSandboxMessage(reason, detail = '') {
  const tail = detail ? `（${detail}）` : '';
  switch (reason) {
    // 小写码：sandbox-win.js 自己产生的（探测器 / 包装器）
    case 'launcher_broken':
      return `Windows 沙箱启动器无法运行${tail}，拒绝执行`;
    case 'launcher_version_mismatch':
      return `Windows 沙箱启动器版本与服务器不匹配${tail}，拒绝执行。请重新编译 native/pibot-sandbox`;
    case 'launcher_hash_mismatch':
      return `Windows 沙箱启动器校验失败${tail}，拒绝执行（可能被替换）`;
    case 'cmd_file_failed':
      return `写沙箱命令文件失败${tail}，拒绝执行（检查实例目录是否可写）`;
    case 'instance_mkdir_failed':
      return `创建实例目录失败${tail}，拒绝执行`;
    case 'no_instance_dir':
      return '没有实例目录，无法建立沙箱实例，拒绝执行';
    case 'selfcheck_failed':
      return `沙箱自检未通过${tail}，拒绝执行`;
    case 'revoke_failed':
    case 'profile_delete_failed':
      return `沙箱实例清理失败${tail}`;
    case 'no_binary':
      return '找不到 Windows 沙箱启动器（pibot-sandbox.exe）。这个 bot 挂了 MCP，'
        + '为安全起见拒绝执行 shell 命令。请重装或重新打包（需要 Rust 工具链编译 native/pibot-sandbox）';
    case 'launcher_version_mismatch':
      return `Windows 沙箱启动器版本与服务器不匹配${tail}，拒绝执行。请重新编译 native/pibot-sandbox`;
    case 'launcher_hash_mismatch':
      return `Windows 沙箱启动器校验失败${tail}，拒绝执行（可能被替换）`;
    case 'launcher_broken':
      return `Windows 沙箱启动器无法运行${tail}，拒绝执行`;
    case 'PROFILE_FAILED':
      return '创建 AppContainer 配置失败（部分企业策略会禁用 AppContainer），拒绝执行 shell 命令';
    case 'ACE_WRITE_FAILED':
    case 'ACE_READ_FAILED':
    case 'ACE_BUILD_FAILED':
    case 'ACE_PROTECT_FAILED':
      return `给工作目录加访问控制失败${tail}，拒绝执行。`
        + '请把工作目录放在你有写权限的位置，或换一个目录';
    case 'WORKDIR_IS_DRIVE_ROOT':
      return '工作目录不能是盘符根（例如 C:\\），请指定一个子目录';
    case 'WORKDIR_IS_UNC':
      return '工作目录不能是网络路径（UNC / 映射盘），沙箱无法为它加访问控制';
    case 'WORKDIR_IS_PROTECTED':
      return '工作目录不能是用户主目录 / AppData / Program Files / Windows 目录本身，请指定专用子目录';
    case 'WORKDIR_CONTAINS_PROTECTED':
      return '工作目录不能是用户主目录或系统目录的上级，请指定专用子目录';
    case 'JOB_FAILED':
    case 'JOB_LIMIT_FAILED':
    case 'JOB_ASSIGN_FAILED':
      return `创建进程作业对象失败${tail}，拒绝执行`;
    case 'CREATE_FAILED':
      return `在沙箱里启动进程失败${tail}，拒绝执行`;
    case 'ATTR_FAILED':
      return `设置 AppContainer 启动属性失败${tail}，拒绝执行`;
    case 'BAD_ENV':
      return `沙箱环境变量参数非法${tail}，拒绝执行`;
    case 'PATH_MISSING':
      return `工作目录不存在${tail}，拒绝执行。请先把目录建出来`;
    case 'PATH_INVALID':
      return `工作目录路径无法解析${tail}（可能是损坏的 junction / 断开的映射盘），拒绝执行`;
    case 'BAD_SHELL':
      return '当前版本 Windows 沙箱只支持 PowerShell（bash 请用 Git Bash 里的 sh 脚本或换平台）';
    case 'UNSUPPORTED_PLATFORM':
      return '这个构建的平台不支持 Windows 沙箱启动器';
    default:
      return `Windows 沙箱不可用（${reason}${detail ? `，${detail}` : ''}），为安全起见拒绝执行，不降级成无沙箱运行`;
  }
}

/** 默认实例目录（与 child-env-typed 的规则保持一致）。 */
export function defaultWindowsInstanceDir(dataDir, key) {
  const base = dataDir || os.tmpdir();
  const safe = String(key ?? 'bot').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(base, 'instances', safe);
}

/** 撤销某个工作目录的授权（bot 删除 / 工作目录变更时调用）。 */
export function revokeWindowsGrant({ instanceDir, workDir }) {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  const exe = launcherPath();
  if (!exe) return { ok: false, reason: 'no_binary' };
  const res = spawnSync(
    exe,
    ['revoke', '--profile', profileNameFor(instanceDir), '--path', path.resolve(workDir), '--mode', 'rw'],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  if (res.status !== 0) {
    return { ok: false, reason: 'revoke_failed', detail: (res.stderr || '').slice(0, 200) };
  }
  return { ok: true };
}

/**
 * 删掉实例的 AppContainer profile。
 *
 * spec §6.1：删实例时 revoke 并删 profile。幂等 —— profile 已经不在时
 * 启动器也返回成功，卸载脚本可以放心重跑。
 *
 * @returns {{ok: boolean, skipped?: boolean, reason?: string, detail?: string}}
 */
export function deleteWindowsProfile({ instanceDir }) {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  const exe = launcherPath();
  if (!exe) return { ok: false, reason: 'no_binary' };
  const res = spawnSync(
    exe,
    ['delete-profile', '--profile', profileNameFor(instanceDir)],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  if (res.status !== 0) {
    return { ok: false, reason: 'profile_delete_failed', detail: (res.stderr || '').slice(0, 200) };
  }
  return { ok: true };
}

/**
 * 实例收尾：撤销工作目录授权 + 删除 profile。
 *
 * 调用点：bot 删除、解绑 MCP、工作目录变更（spec §6.2 / §16 ACE 自愈）。
 * 任何一步失败都返回 ok:false，由调用方决定是提示还是记录 ——
 * 但**不**影响"这个实例下次启动仍然要过 selfcheck"，所以泄漏的 ACE
 * 不会变成"看起来能用其实没隔离"。
 */
export function teardownWindowsInstance({ instanceDir, workDir = '' }) {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  const steps = [];
  if (workDir) {
    const r = revokeWindowsGrant({ instanceDir, workDir });
    steps.push({ step: 'revoke', ...r });
  }
  const d = deleteWindowsProfile({ instanceDir });
  steps.push({ step: 'delete-profile', ...d });
  return { ok: steps.every((s) => s.ok), steps };
}
