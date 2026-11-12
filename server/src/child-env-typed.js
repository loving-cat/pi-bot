/**
 * 子进程环境的**类型化白名单**：默认什么都不继承，只注入明确列出的键。
 *
 * ## 为什么从"全局黑名单"改成"按类型白名单"
 *
 * 早先的实现是"继承宿主环境，然后屏蔽一些危险变量"。这条路走不通：
 *   · 屏蔽清单永远补不完（PATH 能换可执行文件、HOME 决定加载哪个 rc…）
 *   · 同一套规则套在所有子进程上是错的 —— bash 需要 PATH 和 HOME，
 *     MCP 子进程只需要极少的东西，probe 更是什么都不该有
 *
 * 现在是反过来：**从空白开始**，按子进程类型注入该类型需要的那几个键。
 *
 * ## 三类子进程
 *
 *   'mcp'   —— MCP server 子进程。只给 PATH / HOME / LANG / TMPDIR。
 *   'bash'  —— bash / powershell 工具跑的命令。同上，但 HOME 指向实例目录。
 *   'probe' —— MCP 探测进程。和 mcp 一样，而且**不继承调用方给的 env**。
 *
 * ## 一律不传
 *
 *   PI_BOT_TOKEN / PI_BOT_SECRET_KEY / 任何 *_TOKEN / *_KEY / *_SECRET
 *   SSH_AUTH_SOCK / GPG_AGENT_INFO / DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR
 *   UV_* / PIP_* / NODE_OPTIONS / DYLD_* / LD_*
 *
 * 这些要么是凭据，要么能改变"加载什么代码"，要么是通往外部代理的socket。
 *
 * ## PATH 用固定安全值
 *
 * **不继承宿主 PATH**。否则攻击者只要在自己进程里改 PATH，
 * 子进程里的 `r2mcp` 就会解析到他放的假可执行文件。
 * 固定值只含系统目录。
 */

import { mkdirSync } from 'node:fs';
import { CHILD_ENV_MARKER, childEnvMarker } from './child-env.js';
import os from 'node:os';
import path from 'node:path';

/** 子进程类型。 */
export const CHILD_KIND = {
  MCP: 'mcp',
  BASH: 'bash',
  PROBE: 'probe',
};

/**
 * 固定的安全 PATH —— **不继承宿主 PATH**。
 *
 * 宿主 PATH 可被同用户进程改写；继承它等于让"命令解析到哪个可执行文件"
 * 变成一个外部可控的输入。这里只列系统目录。
 */
function computeSafePath() {
  // ★ 两个平台都要追加 pi-bot 自己运行时所在的目录。
  //
  //   Windows 上 CI runner / 用户机器上的 node 通常在
  //   C:\Program Files\nodejs 或 nvm 的版本目录下，**不在** System32 里。
  //   不追加的话，后台 shell 里执行 `node xxx.js` 会报
  //   "'node' is not recognized" —— 这是个真实的功能回归。
  const selfDir = (() => {
    try { return path.dirname(process.execPath); } catch { return ''; }
  })();

  if (process.platform === 'win32') {
    const parts = [
      'C:\\Windows\\System32',
      'C:\\Windows',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    ];
    if (selfDir && !parts.includes(selfDir)) parts.unshift(selfDir);
    return parts.join(';');
  }

  const parts = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  // 服务端可能跑在 nvm / volta / pyenv 这类版本管理器下（如
  // ~/.nvm/versions/node/v24/bin）。只用系统目录的话，子进程里
  // 连 node / python 都找不到 —— bash 工具会大面积坏掉。
  //
  // 这个目录是**我们自己进程的可执行文件所在处**，不是任意可变的
  // PATH 环境变量，所以相对可信：攻击者要利用它，得先能替换掉
  // 正在运行的 pi-bot 所用的 node 二进制本身（那已经等同于完全控制）。
  if (selfDir && !parts.includes(selfDir)) parts.unshift(selfDir);
  return parts.join(':');
}

const SAFE_PATH = computeSafePath();

/**
 * 一律不传给任何子进程的变量（精确名）。
 *
 * ★ 这里只是"显式拦一遍"的第二道防线 —— 真正的保证是"从空白开始"，
 *   这些名字根本不会被注入。列出来是为了让读代码的人一眼看到红线在哪。
 */
export const NEVER_PASS = new Set([
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'NODE_OPTIONS',
  'PI_BOT_TOKEN',
  'PI_BOT_SECRET_KEY',
  'PI_BOT_PORT',
  'PI_BOT_HOST',
  'PI_BOT_HOME',
  'PI_BOT_WORKSPACE',
]);

/** 一律不传的前缀。 */
const NEVER_PASS_PREFIXES = [
  'UV_',
  'PIP_',
  'DYLD_',
  'LD_',
  'LC_', // 下面单独按白名单放行常见 locale
];

/** 允许透传的 locale 变量（只这几个，不放开整个 LC_*）。 */
const LOCALE_KEYS = new Set(['LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES']);

/**
 * 允许透传的代理变量。
 *
 * 为什么放行：企业内网的机器通常只有经代理才能出网，把这些丢了会让
 * 用户本来能用的命令（curl / pip / npm）全部连不上 —— 那是个功能回归，
 * 不是安全收益。代理地址本身不是凭据（凭据在代理的认证头里，
 * 而那些走的是 *_PROXY 之外的通道）。
 */
const PROXY_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

/** 看起来像凭据的名字。 */
function looksSensitive(name) {
  const upper = String(name ?? '').toUpperCase();
  if (NEVER_PASS.has(upper)) return true;
  if (upper.endsWith('_TOKEN') || upper.endsWith('_KEY') || upper.endsWith('_SECRET')) return true;
  if (upper.endsWith('_API_KEY') || upper.endsWith('_PASSWORD')) return true;
  for (const prefix of NEVER_PASS_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 造一份子进程环境。
 *
 * @param {object} opts
 * @param {'mcp'|'bash'|'probe'} opts.kind 子进程类型
 * @param {string} [opts.homeDir] HOME 指向哪（实例自己的目录）
 * @param {string} [opts.tmpDir] TMPDIR 指向哪（实例私有 tmp）
 * @param {Record<string,string>} [opts.extra]  该类型额外需要注入的键（如 MCP 配置里的 env）
 * @param {Record<string,string>} [opts.locale] 从宿主继承的 locale（只取白名单里的）
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv({ kind, homeDir = '', tmpDir = '', extra = null, locale = null } = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};

  // 1) PATH 固定值，不继承
  env.PATH = SAFE_PATH;

  // 2) HOME 指向实例自己的目录（隔离，不暴露真实 HOME）
  if (homeDir) env.HOME = homeDir;
  if (process.platform === 'win32') {
    if (homeDir) {
      env.USERPROFILE = homeDir;
      env.HOMEDRIVE = path.parse(homeDir).root.replace(/\\$/, '');
      env.HOMEPATH = homeDir.slice(env.HOMEDRIVE.length);
    }
    env.SYSTEMROOT = process.env.SYSTEMROOT ?? 'C:\\Windows';
    env.WINDIR = env.SYSTEMROOT;
    env.COMSPEC = process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
    env.PATHEXT = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  }

  // 3) TMPDIR 指向实例私有 tmp
  if (tmpDir) {
    env.TMPDIR = tmpDir;
    env.TMP = tmpDir;
    env.TEMP = tmpDir;
  }

  // 4) locale：只放行明确列出的几个
  const srcLocale = locale ?? {};
  for (const [key, value] of Object.entries(srcLocale)) {
    if (value == null) continue;
    const upper = String(key).toUpperCase();
    if (!LOCALE_KEYS.has(upper)) continue;
    env[upper] = String(value);
  }
  // 兜底：没有 LANG 时给一个，避免程序输出编码异常
  if (!env.LANG) env.LANG = 'en_US.UTF-8';

  // 5) 代理：企业内网常用，丢了会让用户的命令连不上网
  const srcProxy = locale ?? {};
  for (const [key, value] of Object.entries(srcProxy)) {
    if (value == null) continue;
    if (!PROXY_KEYS.has(key) && !PROXY_KEYS.has(String(key).toLowerCase())) continue;
    env[key] = String(value);
  }

  // 6) 显式传入的额外键。
  //
  //   ★ 这里**不能**套用"看名字像凭据就丢"的规则。
  //     显式传入意味着调用方明确要求子进程拿到它 —— 典型场景是
  //     MCP 配置里用户自己写的 API key（`SPECIAL_API_KEY` 之类），
  //     那是那个 MCP 正常工作的必要条件，丢掉等于功能坏掉。
  //
  //     要挡的是**服务端自己的**凭据和**通往用户其它进程的通道**，
  //     这两类不论谁显式传都不给：
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (value == null) continue;
      const upper = String(key).toUpperCase();
      // 服务端凭据：绝不出服务端进程
      if (upper.startsWith('PI_BOT_')) continue;
      // 通往用户 agent / 会话总线的 socket
      if (NEVER_PASS.has(upper)) continue;
      // 能改变"加载什么代码"的
      if (/^(DYLD_|LD_|NODE_OPTIONS$|PYTHONPATH$|PYTHONHOME$)/.test(upper)) continue;
      env[key] = String(value);
    }
  }

  // kind 目前不改变注入集合（三类需要的键相同），
  // 但保留参数是为了将来"某类要额外注入什么"时有地方落，
  // 也让调用方必须显式声明类型 —— 漏传会立刻看出来。
  void kind;

  // ★ 打上标记，列出我们注入的每一个键。
  //
  //   服务端的 spawn 补丁（child-env.js）默认会用"从 process.env 挑白名单"
  //   重建环境 —— 那会把我们精心设的固定 PATH / 实例 HOME / 私有 TMPDIR
  //   全部冲掉。带上标记后补丁只保留这里列出的键，一个不多一个不少。
  env[CHILD_ENV_MARKER] = childEnvMarker(Object.keys(env));
  return env;
}

/** PATH 是否就是那个固定安全值（测试与诊断用）。 */
export function isSafePath(value) {
  return String(value ?? '') === SAFE_PATH;
}

/** 固定安全 PATH 的值（测试用）。 */
export function safePath() {
  return SAFE_PATH;
}

/**
 * 实例私有的临时目录路径。
 *
 * ★ 必须在实例自己的目录下，不能用宿主 TMPDIR —— 宿主的 /tmp 是所有用户共享的，
 *   而且沙箱要把它挂成 tmpfs（Linux）或限制写入（macOS）。
 */
export function instanceTmpDir(instanceDir) {
  return instanceDir ? path.join(instanceDir, 'tmp') : '';
}

/** 实例自己的 HOME 目录。 */
export function instanceHomeDir(instanceDir) {
  return instanceDir ? path.join(instanceDir, 'home') : '';
}

/**
 * 宿主 locale + 代理的副本（只取白名单里的键，供 buildChildEnv 使用）。
 *
 * 名字保留 hostLocale 是为了不改所有调用点；它返回的键都会被
 * buildChildEnv 按 locale / 代理两类分别处理。
 */
export function hostLocale(source = process.env) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const key of LOCALE_KEYS) {
    const value = source?.[key];
    if (value != null) out[key] = String(value);
  }
  for (const key of PROXY_KEYS) {
    const value = source?.[key];
    if (value != null) out[key] = String(value);
  }
  return out;
}

/** 建出实例目录及它的 home / tmp 子目录（幂等）。 */
export function ensureInstanceDirs(instanceDir) {
  if (!instanceDir) return;
  for (const dir of [instanceDir, instanceHomeDir(instanceDir), instanceTmpDir(instanceDir)]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // 建不出来就让子进程自己报错；这里不抛（启动路径上不该炸）
    }
  }
}

/** 默认实例目录（数据目录下按 bot/房间分的子目录）。 */
export function defaultInstanceDir(dataDir, key) {
  if (!dataDir) return '';
  const safe = String(key ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return path.join(dataDir, 'instances', safe || 'default');
}
