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
 *   SystemRoot、windir、SystemDrive、ComSpec、PATHEXT、
 *   USERPROFILE、APPDATA、LOCALAPPDATA、HOMEDRIVE、HOMEPATH、
 *   以及名字以 `_PROXY` 结尾的代理变量。
 *
 * `PI_BOT_TOKEN`、`*_API_KEY`、`*_TOKEN`、`*_SECRET` 一律不继承。
 * 调用方显式给的变量（MCP 配置里的 env、后台命令的 extra）原样保留，
 * 哪怕名字看起来像 key。显式名单写在内部标记里，真正 spawn 之前删掉。
 *
 * `Worker` 不走这条路，调用方用 `childEnvDirect` 传入已经收过的环境。
 */
import crypto from 'node:crypto';
import cp from 'node:child_process';

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
  if (isSensitive(upper)) return false;
  if (EXACT.has(upper)) return true;
  if (upper.startsWith('LC_')) return true;
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
 * @returns {string[]}
 */
function scrubPairs(pairs) {
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
    return entries
      .filter((entry) => isAllowed(entry.name))
      .map((entry) => `${entry.name}=${entry.value}`);
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const [name, value] of Object.entries(pickWhitelist(process.env))) {
    seen.add(name);
    out.push(`${name}=${value}`);
  }
  for (const name of names) {
    const found = entries.find((entry) => entry.name === name);
    if (!found) continue;
    const line = `${found.name}=${found.value}`;
    if (seen.has(found.name)) {
      const idx = out.findIndex((item) => item.startsWith(`${found.name}=`));
      if (idx >= 0) out[idx] = line;
    } else {
      seen.add(found.name);
      out.push(line);
    }
  }
  return out;
}

/**
 * @param {{envPairs?: string[]}|undefined|null} options
 */
function scrubSpawnOptions(options) {
  if (!options || !Array.isArray(options.envPairs)) return;
  options.envPairs = scrubPairs(options.envPairs);
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
  const binding = process.binding('spawn_sync');
  const origSync = binding.spawn;
  binding.spawn = function patchedSyncSpawn(options) {
    scrubSpawnOptions(options);
    return origSync.call(this, options);
  };
}

installChildEnvScrub();
