/**
 * 子进程环境：只从本进程带白名单里的普通变量。
 *
 * bash / powershell（pi 的 shell 工具会把整份 `process.env` 拷给 spawn）、
 * run_background、MCP stdio（pi-mcp 默认再并上 `process.env`）最终都走到
 * `child_process`。ESM 的具名导入拿不到事后替换的 exports，所以补丁打在
 * `ChildProcess.prototype.spawn` 和同步的 `spawn_sync` 上，exec / fork 也经过这里。
 *
 * 白名单（大小写不敏感，保留原来的名字）：
 *   PATH、HOME、USER、USERNAME、LOGNAME、SHELL、TERM、
 *   TMPDIR、TEMP、TMP、LANG、LC_*、
 *   PI_CODING_AGENT_DIR、XDG_*、SSH_AUTH_SOCK、GIT_SSH*、
 *   NODE_EXTRA_CA_CERTS、SSL_CERT_*、DISPLAY、
 *   SystemRoot、windir、SystemDrive、ComSpec、PATHEXT、
 *   USERPROFILE、APPDATA、LOCALAPPDATA、HOMEDRIVE、HOMEPATH、
 *   ProgramFiles、ProgramFiles(x86)、ProgramData、PSModulePath、
 *   NUMBER_OF_PROCESSORS、PROCESSOR_ARCHITECTURE、OS、PUBLIC、
 *   PI_BOT_*（除外名单见下）、
 *   以及名字以 `_PROXY` 结尾的代理变量。
 *
 * `PI_BOT_TOKEN`、`PI_BOT_SECRET_KEY`、`*_API_KEY`、`*_TOKEN`、`*_SECRET`
 * 一律不继承。以后新增敏感的 `PI_BOT_` 变量，加进 `PI_BOT_BLOCKED`。
 * 云凭证不在白名单里，也没有运行时放行接口。
 * 调用方显式给的变量（MCP 配置里的 env、后台命令的 extra、
 * runPiCli 按当前模型塞进来的 provider key）原样保留。
 * 显式名单写在内部标记里，真正 spawn 之前删掉。
 * 只有可执行文件是当前 node、脚本正好是本包的 index.js 时，才补当前 provider 的 key。
 * 别的 index.js（例如 MCP）即使带了 --mode 也拿不到。
 *
 * `Worker` 不走这条路，调用方用 `childEnvDirect` 传入已经收过的环境。
 */
import crypto from 'node:crypto';
import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerKeys } from './provider-keys.js';

/** pi-bot 自己的入口。和别的 index.js 比的是绝对路径，不是文件名。 */
const PI_BOT_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

/**
 * @param {string[]|undefined|null} args
 * @returns {boolean}
 */
function isPiBotEntry(args) {
  if (!Array.isArray(args) || args.length < 2) return false;
  if (String(args[0]) !== process.execPath) return false;
  const script = path.resolve(String(args[1]));
  if (process.platform === 'win32') {
    return script.toLowerCase() === PI_BOT_ENTRY.toLowerCase();
  }
  return script === PI_BOT_ENTRY;
}

/** 内部标记。值是本进程随机前缀加显式变量名，不是秘密。 */
export const CHILD_ENV_MARKER = 'PI_BOT_ENV_ALLOW';

const token = crypto.randomBytes(16).toString('hex');
const markerPrefix = `v1:${token}:`;

const EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'PI_CODING_AGENT_DIR',
  // ★ SSH_AUTH_SOCK 已移出白名单：它是通往用户 ssh-agent 的 socket，
  //   子进程拿到就能用用户的密钥签名。任何子进程都不该有它。
  'NODE_EXTRA_CA_CERTS',
  'DISPLAY',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'PSMODULEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'PUBLIC',
]);

/**
 * `PI_BOT_*` 默认放行。这两项除外。
 * 以后新增敏感的 PI_BOT_ 变量，加进这里（后缀规则盖不住 PI_BOT_SECRET_KEY）。
 */
const PI_BOT_BLOCKED = new Set([
  'PI_BOT_TOKEN',
  'PI_BOT_SECRET_KEY',
  // ★ 这三项本身不是密钥，但会告诉子进程"服务端在哪个端口、数据目录在哪"。
  //   bash 工具跑的命令、MCP 子进程、后台任务都能看到进程环境 ——
  //   拿到它们就能直接往服务端发请求、甚至去读数据目录。
  //   配合本机 token 机制（local-token.js），攻破成本会从
  //   "需要读用户的私有文件" 降成 "读一个环境变量"，所以必须挡住。
  'PI_BOT_PORT',
  'PI_BOT_HOST',
  'PI_BOT_HOME',
  // PI_BOT_WORKSPACE 同属"服务端部署信息"：它暴露 bot 的工作目录在哪，
  // 子进程拿到就能直接去读写那些文件，不必再猜路径。
  'PI_BOT_WORKSPACE',
]);

/**
 * @param {string} name
 * @returns {boolean}
 */
function isSensitive(name) {
  const upper = String(name ?? '').toUpperCase();
  return upper === 'PI_BOT_TOKEN'
    || upper.endsWith('_API_KEY')
    || upper.endsWith('_TOKEN')
    || upper.endsWith('_SECRET');
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isAllowed(name) {
  const upper = String(name ?? '').toUpperCase();
  if (!upper || upper === CHILD_ENV_MARKER) return false;
  if (PI_BOT_BLOCKED.has(upper)) return false;
  if (isSensitive(upper)) return false;
  if (EXACT.has(upper)) return true;
  if (upper.startsWith('LC_')) return true;
  // ★ XDG_* 里只有缓存/配置目录是无害的，但 XDG_RUNTIME_DIR 是**用户会话的
  //   运行时目录** —— 里面有其它进程的 socket（dbus、ssh-agent、pulseaudio 等），
  //   拿到它就等于能跟用户其它进程通信。Linux 上这个变量几乎是必设的，
  //   所以不能整体放行 XDG_。
  if (upper === 'XDG_RUNTIME_DIR') return false;
  if (upper.startsWith('XDG_')) return true;
  if (upper.startsWith('GIT_SSH')) return true;
  if (upper.startsWith('SSL_CERT_')) return true;
  if (upper.startsWith('PI_BOT_')) return true;
  if (upper.endsWith('_PROXY')) return true;
  return false;
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>} src
 * @returns {NodeJS.ProcessEnv}
 */
function pickWhitelist(src) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const [key, value] of Object.entries(src)) {
    if (value == null || !isAllowed(key)) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * 认得出本进程写的标记才返回显式名单；伪造的标记当没看见。
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>|undefined|null} source
 * @returns {string[]|null}
 */
function explicitNames(source) {
  if (!source || typeof source !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(source, CHILD_ENV_MARKER)) return null;
  const raw = String(source[CHILD_ENV_MARKER] ?? '');
  if (!raw.startsWith(markerPrefix)) return null;
  return raw.slice(markerPrefix.length).split(',').filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} names
 * @param {Record<string, string|undefined|null>|undefined|null} extra
 */
function applyExtra(env, names, extra) {
  if (!extra || typeof extra !== 'object') return;
  for (const [key, value] of Object.entries(extra)) {
    if (value == null || key === CHILD_ENV_MARKER || String(key).includes(',')) continue;
    env[key] = String(value);
    if (!names.includes(key)) names.push(key);
  }
}

/**
 * @param {string[]} names
 * @returns {string}
 */
function markerValue(names) {
  return `${markerPrefix}${names.join(',')}`;
}

/**
 * 给类型化白名单模块用：造一个"这些键都保留"的标记。
 *
 * @param {string[]} names
 * @returns {string}
 */
export function childEnvMarker(names) {
  return markerValue(Array.isArray(names) ? names : []);
}

/**
 * 给会再被 spawn 补丁看一眼的调用方。结果里带内部标记。
 *
 * @param {NodeJS.ProcessEnv} [base]
 * @param {Record<string, string|undefined|null>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(base = process.env, extra) {
  const existing = explicitNames(base);
  const env = existing ? { ...base } : pickWhitelist(base);
  const names = existing ? [...existing] : [];
  applyExtra(env, names, extra);
  if (existing) {
    for (const key of Object.keys(env)) {
      if (key === CHILD_ENV_MARKER) continue;
      if (names.includes(key) || isAllowed(key)) continue;
      delete env[key];
    }
  }
  env[CHILD_ENV_MARKER] = markerValue(names);
  return env;
}

/**
 * 只留下显式变量和标记，不把白名单抄进配置。
 * pi 会把配置里的 `$` / `!` 再解释一遍，白名单的值不该走那一层；
 * 真正启动时由 spawn 补丁从本进程补上白名单。
 *
 * @param {Record<string, string|undefined|null>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function explicitChildEnv(extra) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  const names = [];
  applyExtra(env, names, extra);
  env[CHILD_ENV_MARKER] = markerValue(names);
  return env;
}

/**
 * 交给子进程的最终环境：白名单 + 显式项，没有内部标记。
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>} [source]
 * @returns {NodeJS.ProcessEnv}
 */
function scrubEnv(source) {
  const env = source && typeof source === 'object' ? source : process.env;
  const names = explicitNames(env);
  if (!names) return pickWhitelist(env);
  const out = pickWhitelist(process.env);
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) continue;
    const value = env[name];
    if (value == null) continue;
    out[name] = String(value);
  }
  return out;
}

/**
 * 不走 spawn 补丁的调用（execFile、Worker）用这个。
 *
 * @param {NodeJS.ProcessEnv} [base]
 * @param {Record<string, string|undefined|null>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnvDirect(base = process.env, extra) {
  return scrubEnv(childEnv(base, extra));
}

/**
 * 真正传给操作系统的是 `envPairs`（`KEY=value`），不是 `options.env`。
 * `import { spawn } from 'node:child_process'` 绑定的是原函数，改 exports 它看不见。
 * 所以改最后一跳：异步走 `ChildProcess.prototype.spawn`，同步走 `spawn_sync`。
 *
 * @param {string[]|undefined|null} pairs
 * @param {string[]|undefined|null} args
 * @returns {string[]}
 */
function upsertPair(pairs, name, value) {
  const line = `${name}=${value}`;
  const idx = pairs.findIndex((item) => {
    const cut = item.indexOf('=');
    return (cut === -1 ? item : item.slice(0, cut)) === name;
  });
  if (idx >= 0) pairs[idx] = line;
  else pairs.push(line);
}

/**
 * @param {string[]} pairs
 * @param {string[]|undefined|null} args
 * @returns {string[]}
 */
function withEntryProviderKeys(pairs, args) {
  if (!isPiBotEntry(args)) return pairs;
  const argv = args.slice(2).map((item) => String(item));
  const extra = providerKeys(process.env, argv);
  for (const [name, value] of Object.entries(extra)) {
    if (value == null || value === '') continue;
    upsertPair(pairs, name, String(value));
  }
  return pairs;
}

/**
 * @param {string[]|undefined|null} pairs
 * @param {string[]|undefined|null} [args]
 * @returns {string[]}
 */
function scrubPairs(pairs, args) {
  const entries = [];
  for (const pair of pairs || []) {
    const text = String(pair);
    const cut = text.indexOf('=');
    entries.push({
      name: cut === -1 ? text : text.slice(0, cut),
      value: cut === -1 ? '' : text.slice(cut + 1),
    });
  }
  const marker = entries.find((entry) => entry.name === CHILD_ENV_MARKER);
  const names = marker && marker.value.startsWith(markerPrefix)
    ? marker.value.slice(markerPrefix.length).split(',').filter(Boolean)
    : null;
  if (!names) {
    return withEntryProviderKeys(
      entries
        .filter((entry) => isAllowed(entry.name))
        .map((entry) => `${entry.name}=${entry.value}`),
      args,
    );
  }
  // ★ Windows 上环境变量名**不区分大小写**。
  //
  //   这里必须按不区分大小写比对，否则会出这种事故：
  //   宿主环境块里是 `Path`，我们显式传的是 `PATH`，
  //   用 Set 精确比字符串就判为"两个不同的键"——于是我们精心构造的安全
  //   PATH 被**追加**成第二条，而 Windows 取第一条（宿主的），
  //   结果安全 PATH 完全没生效（CI 上亲眼看到 /tmp/evil-bin 赢了）。
  const caseInsensitive = process.platform === 'win32';
  const keyOf = (name) => (caseInsensitive ? String(name).toUpperCase() : String(name));

  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const [name, value] of Object.entries(pickWhitelist(process.env))) {
    // 本进程这一侧同样按平台规则去重，避免自己先放进去两个同义键
    if (caseInsensitive && seen.has(keyOf(name))) {
      const idx = out.findIndex((item) => keyOf(item.slice(0, item.indexOf('='))) === keyOf(name));
      if (idx >= 0) {
        out[idx] = `${name}=${value}`;
        continue;
      }
    }
    seen.add(keyOf(name));
    out.push(`${name}=${value}`);
  }
  withEntryProviderKeys(out, args);
  seen.clear();
  for (const item of out) {
    const cut = item.indexOf('=');
    seen.add(keyOf(cut === -1 ? item : item.slice(0, cut)));
  }
  for (const name of names) {
    const found = entries.find((entry) => keyOf(entry.name) === keyOf(name));
    if (!found) continue;
    const line = `${found.name}=${found.value}`;
    if (seen.has(keyOf(found.name))) {
      const idx = out.findIndex((item) => keyOf(item.slice(0, item.indexOf('='))) === keyOf(found.name));
      if (idx >= 0) out[idx] = line;
      continue;
    }
    seen.add(keyOf(found.name));
    out.push(line);
  }
  return out;
}

/**
 * @param {{envPairs?: string[]}|undefined|null} options
 */
function scrubSpawnOptions(options) {
  if (!options || !Array.isArray(options.envPairs)) return;
  options.envPairs = scrubPairs(options.envPairs, options.args);
}

/**
 * 包住同步 spawn。拿不到 binding 时警告，不静默放过。
 *
 * @param {{spawn?: Function}|undefined|null} binding
 * @returns {boolean}
 */
export function attachSpawnSyncScrub(binding) {
  if (!binding || typeof binding.spawn !== 'function') {
    console.warn('拿不到 spawn_sync，同步子进程环境不会按白名单过滤');
    return false;
  }
  if (binding.spawn.name === 'patchedSyncSpawn') return true;
  const origSync = binding.spawn;
  binding.spawn = function patchedSyncSpawn(options) {
    scrubSpawnOptions(options);
    return origSync.call(this, options);
  };
  return true;
}

let installed = false;

/** 包住所有 spawn / spawnSync / exec / fork。重复调用无效果。 */
export function installChildEnvScrub() {
  if (installed) return;
  installed = true;
  const origSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function patchedChildSpawn(options) {
    scrubSpawnOptions(options);
    return origSpawn.call(this, options);
  };
  let binding = null;
  try {
    binding = process.binding('spawn_sync');
  } catch {
    binding = null;
  }
  attachSpawnSyncScrub(binding);
}

installChildEnvScrub();
