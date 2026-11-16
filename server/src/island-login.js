/**
 * 把浏览器的登录态带进独立桌面（规格 §5.6 T1 的"可用性"那一半）。
 *
 * ## 为什么需要
 *
 * 岛上默认是**干净实例**：一打开就要重新登录、收验证码。而那台机器上
 * 用户明明已经登录好了 —— 他要的是"帮我干这件事"，不是"再登一次"。
 *
 * ## 怎么做（以及为什么只做"复制一份"）
 *
 * 浏览器的登录态 = 用户配置目录（`User Data`）里的几个文件：
 * Cookies、Login Data、Local State、Preferences、Web Data。把这些**复制一份**
 * 到服务器的数据目录，然后让岛上的浏览器用 `--user-data-dir=<这一份>` 启动。
 *
 * 三条不做的原因，都要写清楚：
 *
 *   · **不直接指向用户正在用的那份**：Chrome/Edge 会在目录里放锁文件，
 *     两个进程用同一份会互相破坏（最坏是用户自己的登录态被清掉）。
 *   · **不复制整个目录**：动辄几个 GB（缓存、扩展、IndexedDB），而登录只需要
 *     上面那几个文件。复制大的那部分只会让"开个浏览器"变成等半分钟。
 *   · **不做实时同步**：快照就是快照。用户在岛上登录了新站点，本机看不到；
 *     反过来也一样。这一点必须告诉用户，否则他会以为"我在岛上退出了"是全局的。
 *
 * ## 边界（安全）
 *
 * 这一份复制品里**含可用的登录凭据**。所以：
 *   · 它只能落在服务器数据目录（不是 workspace，不会被当附件发出去）；
 *   · 用完由 `pruneLoginSnapshots` 按保留期清掉；
 *   · 不进群、不进记忆、不进审计摘要。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 认得出"这个 app 是浏览器"的 basename。 */
export const BROWSER_APPS = Object.freeze({
  'chrome.exe': 'chrome',
  'msedge.exe': 'edge',
  'firefox.exe': 'firefox',
});

/**
 * 各个浏览器的用户配置根目录（宿主平台）。
 *
 * 找不到就返回空数组 —— **不猜**。猜错的结果是把一份不存在的目录复制成空壳，
 * 然后用户看到"打开是登录状态吗？不，还是没登录"，而日志里一切正常。
 */
export function browserProfileRoots({ app, platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const base = String(app ?? '').toLowerCase();
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    if (base === 'chrome.exe') return [path.join(local, 'Google', 'Chrome', 'User Data')];
    if (base === 'msedge.exe') return [path.join(local, 'Microsoft', 'Edge', 'User Data')];
    // Firefox 不按 "User Data" 组织：profile 在 Profiles/<随机名>/ 下
    if (base === 'firefox.exe') return [path.join(roaming, 'Mozilla', 'Firefox')];
    return [];
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    if (base === 'chrome.exe') return [path.join(support, 'Google', 'Chrome')];
    if (base === 'msedge.exe') return [path.join(support, 'Microsoft Edge')];
    if (base === 'firefox.exe') return [path.join(support, 'Firefox')];
    return [];
  }
  if (base === 'chrome.exe') return [path.join(home, '.config', 'google-chrome')];
  if (base === 'msedge.exe') return [path.join(home, '.config', 'microsoft-edge')];
  if (base === 'firefox.exe') return [path.join(home, '.mozilla', 'firefox')];
  return [];
}

/**
 * 登录快照里**要**的东西（相对 profile 根）。相对路径是相对 `<root>/Default`，
 * 除了 `Local State` 在根的上一层。
 */
export const SNAPSHOT_ENTRIES = Object.freeze([
  'Local State',            // 加密密钥的包装（Windows DPAPI、mac Keychain）
  'Default/Cookies',        // 登录态本体
  'Default/Network/Cookies',// 新版 Chromium 把 cookie 挪到这里了
  'Default/Login Data',     // 保存的密码（有些站点自动填要用）
  'Default/Web Data',       // 自动填充/表单
  'Default/Preferences',    // 语言、时区、站点设置
  'Default/Local Storage',  // 一些站的 token 存在这里
]);

/** 单个文件上限：超过就不复制（多半是缓存，不是登录态）。 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * 算一份"登录快照"该怎么落地。
 *
 * 纯函数：只算路径和该复制哪些，不动文件系统。
 *
 * @param {object} p
 * @param {string} p.app 可执行体 basename
 * @param {string} p.dataDir 服务器数据目录
 * @param {object} [p.exists] 注入的"存在吗"判断（测试用），默认 fs.existsSync
 * @param {string} [p.platform]
 * @returns {{ok:true, browser:string, sourceRoot:string, destRoot:string, entries:string[]}
 *   | {ok:false, code:string, text:string}}
 */
export function planLoginSnapshot({
  app,
  dataDir,
  exists = fs.existsSync,
  platform = process.platform,
} = {}) {
  const base = String(app ?? '').toLowerCase();
  const browser = BROWSER_APPS[base];
  if (!browser) {
    return { ok: false, code: 'not_a_browser', text: '只有浏览器的登录态有这层处理；别的程序没有可共享的登录态' };
  }
  const roots = browserProfileRoots({ app: base, platform }).filter((p) => exists(p));
  if (!roots.length) {
    return {
      ok: false,
      code: 'no_profile',
      text: `没找到 ${browser} 的用户配置目录 —— 可能没装、没用过，或者装在非默认位置。这次就不共享登录态了。`,
    };
  }
  const sourceRoot = roots[0];
  const safe = String(dataDir ?? '').trim();
  if (!safe) return { ok: false, code: 'no_data_dir', text: '没有数据目录，不敢往别处写登录凭据' };
  const destRoot = path.join(safe, 'island-login', browser);
  const entries = SNAPSHOT_ENTRIES.filter((rel) => exists(path.join(sourceRoot, rel)));
  if (!entries.length) {
    return {
      ok: false,
      code: 'empty_profile',
      text: `找到了 ${browser} 的配置目录，但里面没有可复制的登录文件（是不是刚装还没登录过？）`,
    };
  }
  return { ok: true, browser, sourceRoot, destRoot, entries };
}

/**
 * 真正复制。返回值只说"复制了几个、跳过了几个"，**不列文件名** ——
 * 文件名本身就是"这台机器装了什么"的信息。
 *
 * @param {object} p
 * @param {string} p.sourceRoot
 * @param {string} p.destRoot
 * @param {string[]} p.entries 相对 sourceRoot 的路径
 * @param {object} [p.fsImpl] 测试注入
 * @param {number} [p.maxBytes]
 */
export function copyLoginSnapshot({ sourceRoot, destRoot, entries = [], fsImpl = fs, maxBytes = MAX_FILE_BYTES } = {}) {
  let copied = 0;
  const skipped = [];
  for (const rel of entries) {
    const from = path.join(sourceRoot, rel);
    const to = path.join(destRoot, rel);
    try {
      const st = fsImpl.statSync(from);
      if (st.size > maxBytes) {
        skipped.push(rel);
        continue;
      }
      fsImpl.mkdirSync(path.dirname(to), { recursive: true });
      fsImpl.copyFileSync(from, to);
      copied += 1;
    } catch {
      // ★ 单个文件复制失败不影响整体：浏览器正在跑的时候 Cookies 可能被锁着，
      //   但 Login Data / Preferences 还是能读。少一个文件最多是"某个站要重登"，
      //   比整体失败有用得多。
      skipped.push(rel);
    }
  }
  return { ok: copied > 0, copied, skipped: skipped.length };
}

/**
 * 浏览器在岛上启动时该带的参数。
 *
 * `--user-data-dir` 指给我们那一份快照，`--no-first-run` 跳过引导页。
 * 注意：**不加** `--headless` —— 我们要的是"有窗口、能截图"，无头模式那是另一条路。
 */
export function islandBrowserArgs({ app, userDataDir, extra = [] } = {}) {
  const base = String(app ?? '').toLowerCase();
  const args = [...(Array.isArray(extra) ? extra : [])];
  if (!userDataDir) return args;
  args.unshift(
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  );
  // Firefox 用它自己的 profile 机制；这里只对 Chromium 系生效
  if (BROWSER_APPS[base] === 'firefox') {
    return [...(Array.isArray(extra) ? extra : []), '-profile', path.join(userDataDir, 'Default')];
  }
  return args;
}

/**
 * 清掉过期的登录快照（由 housekeeping 定时调）。
 *
 * 为什么要清：那是**可用的登录凭据**。留在磁盘上不动，等于把用户的
 * 浏览器登录态复制了一份永久放在数据目录里。
 */
export function pruneLoginSnapshots({ dataDir, maxAgeMs = 7 * 24 * 3600_000, now = Date.now(), fsImpl = fs } = {}) {
  const root = path.join(String(dataDir ?? ''), 'island-login');
  let removed = 0;
  try {
    if (!fsImpl.existsSync(root)) return { ok: true, removed: 0 };
    for (const name of fsImpl.readdirSync(root)) {
      const dir = path.join(root, name);
      try {
        const st = fsImpl.statSync(dir);
        if (now - Number(st.mtimeMs ?? 0) > maxAgeMs) {
          fsImpl.rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch { /* 单个目录失败就跳过 */ }
    }
  } catch {
    return { ok: false, removed };
  }
  return { ok: true, removed };
}
