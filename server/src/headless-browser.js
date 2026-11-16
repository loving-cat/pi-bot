/**
 * **无头浏览器**：调研用（规格 `spec-intent-and-habits-v1.md` §1 的"后台"那一档）。
 *
 * ## 它补的是哪一档
 *
 * | 需求 | 之前能用什么 | 结果 |
 * |---|---|---|
 * | 只要 HTML | `web_fetch` | 好，无窗口 |
 * | 要 JS 渲染 **且** 要登录态 | 只有 ego | **窗口弹在用户屏幕上**，而且拿走控制权 |
 *
 * 中间那一档一直缺着，所以 bot 只能选 ego —— 这就是"调研把浏览器弹到前台"的根因。
 * 现在补上：**无头 Chromium + 用户配置快照 + CDP**。无窗口，所以零打扰；
 * 有快照，所以带着登录态。
 *
 * ## 为什么不是"岛 + 窗口消息"
 *
 * 岛里的浏览器有窗口（用户看不见，但仍在合成），而驱动 Chromium 只能靠
 * 窗口消息 —— 对现代网页基本不可靠（实测：只有经典 Win32 控件吃得进消息）。
 * 无头模式下没有任何窗口，一切走 CDP 协议，可靠得多。
 *
 * ## 登录态从哪来
 *
 * 复用 `island-login.js` 的那份快照（Cookies / Login Data / Local State…）。
 * 它是**复制品**：无头浏览器里的登录/退出不会同步回用户正在用的浏览器。
 *
 * ## 生命周期
 *
 * 一个进程一份会话（按 bot 名索引）。空闲 5 分钟自动收，`close()` 显式收。
 * 收的时候**先杀进程再删临时目录**，否则 Windows 上 profile 会被占着删不掉。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { connectCdp, evaluate, navigate, screenshot } from './cdp-client.js';
import { planLoginSnapshot, copyLoginSnapshot } from './island-login.js';
import { isSupported as islandSupported, launchOnIsland, closeIsland } from './desktop-island-win.js';

/** 认得出"这个可执行体能当浏览器用"。 */
const BROWSER_APPS = Object.freeze({
  'chrome.exe': 'chrome',
  'msedge.exe': 'edge',
  'google-chrome': 'chrome',
  'chromium': 'chromium',
});

/** 空闲多久自动收（毫秒）。 */
const IDLE_CLOSE_MS = 5 * 60_000;

/** 起进程等多久才算就绪。 */
const READY_TIMEOUT_MS = 20_000;

/** 试图给一个空闲端口（Windows 上 `--remote-debugging-port=0` 也能用，但我们想提前知道端口）。 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 定位浏览器可执行文件。
 *
 * 只认**常见安装位置**，不做 `where`（那会命中一堆同名东西）。
 * 找不到就如实报 —— 让调用方退回 web_fetch，而不是我们猜一个。
 */
export function locateBrowser({ app = 'chrome.exe', env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const key = String(app ?? '').toLowerCase();
  if (!BROWSER_APPS[key]) return { ok: false, error: `不认识的浏览器：${app}` };
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    const candidates = key === 'msedge.exe'
      ? [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : key === 'chrome.exe'
        ? [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
           path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
           path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')]
        : [];
    const hit = candidates.find((p) => exists(p));
    return hit ? { ok: true, file: hit } : { ok: false, error: `没找到 ${app}（常见位置都没有）` };
  }
  if (platform === 'darwin') {
    const base = '/Applications';
    const hit = [
      path.join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      path.join(base, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    ].find((p) => exists(p));
    return hit ? { ok: true, file: hit } : { ok: false, error: `没找到 ${app}（/Applications 里没有）` };
  }
  const hit = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
    .find((p) => exists(p));
  return hit ? { ok: true, file: hit } : { ok: false, error: '没找到 chrome/chromium/edge' };
}

/**
 * 无头浏览器的启动参数。
 *
 * 逐条都有理由（少一条就多一类"能开但用不了"）：
 *
 * | 参数 | 作用 |
 * |---|---|
 * | `--headless=new` | **不建窗口**（这就是"调研不弹窗"的本体） |
 * | `--remote-debugging-port` | CDP 的大门 |
 * | `--user-data-dir` | 指向登录态**快照**（复制品，不碰用户正在用的那份） |
 * | `--no-first-run` / `--no-default-browser-check` | 否则首次启动会弹"设为默认浏览器"横幅（截图上那条就是） |
 * | `--disable-gpu` | 无头环境里 GPU 合成经常失败（黑图） |
 * | `--window-size` | 无头也有视口尺寸，小视口会让响应式页面渲染成手机版 |
 */
export function headlessArgs({
  port,
  userDataDir,
  width = 1280,
  height = 900,
  /**
   * `headless` = 无窗口；`island` = **在另一张桌面上开真窗口**（用户看不见）。
   *
   * 两种都零打扰，区别在兼容性：无头会被一部分站点识别（Cloudflare 之类），
   * 岛里的是有头真浏览器 —— 只是它的窗口在你看不见的那张桌面上。
   */
  mode = 'headless',
} = {}) {
  const args = [
    ...(mode === 'island' ? [] : ['--headless=new']),
    `--remote-debugging-port=${Number(port) || 0}`,
    `--window-size=${Number(width) || 1280},${Number(height) || 900}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
  ];
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
  return args;
}

/** 进程级会话表：botKey → session */
const sessions = new Map();

async function fetchJson(url, { timeout = 1000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 起一个无头浏览器（已存在就复用）。
 *
 * @param {object} p
 * @param {string} p.key 会话键（按 bot 分，避免两个 bot 抢同一个）
 * @param {string} [p.app] `chrome.exe` / `msedge.exe`
 * @param {boolean} [p.shareLogin] 带登录态快照（默认 true）
 * @param {string} p.dataDir 服务器数据目录（快照落这里）
 * @returns {Promise<{ok:true, session:object} | {ok:false, code:string, text:string}>}
 */
export async function openHeadless({ key, app = 'chrome.exe', shareLogin = true, dataDir, platform = process.platform } = {}) {
  const id = String(key ?? '').trim();
  if (!id) return { ok: false, code: 'no_key', text: '需要一个会话键（按 bot 分）' };
  const existing = sessions.get(id);
  if (existing && !existing.closed) {
    existing.lastUsed = Date.now();
    return { ok: true, session: existing, reused: true };
  }

  const found = locateBrowser({ app, platform });
  if (!found.ok) return { ok: false, code: 'no_browser', text: found.error };

  // 登录态快照（复制品）。拿不到也照起 —— 只是没有登录态。
  let profileDir = null;
  let login = null;
  if (shareLogin && dataDir) {
    const plan = planLoginSnapshot({ app, dataDir, platform });
    if (plan.ok) {
      const copied = copyLoginSnapshot({ sourceRoot: plan.sourceRoot, destRoot: plan.destRoot, entries: plan.entries });
      if (copied.ok) {
        profileDir = plan.destRoot;
        login = { browser: plan.browser, copied: copied.copied, skipped: copied.skipped };
      }
    }
  }
  if (!profileDir) {
    profileDir = path.join(os.tmpdir(), `pi-headless-${id}-${Date.now().toString(36)}`);
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const port = await freePort();
  const child = spawn(found.file, headlessArgs({ port, userDataDir: profileDir }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr = `${stderr}${d}`.slice(-4000);
  });

  const session = {
    key: id,
    app,
    port,
    profileDir,
    login,
    proc: child,
    cdp: null,
    closed: false,
    lastUsed: Date.now(),
    startedAt: Date.now(),
  };
  sessions.set(id, session);

  // 等 `/json/version` 起来 —— 那是"浏览器真的在听了"的唯一证据。
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let version = null;
  while (Date.now() < deadline) {
    try {
      version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!version) {
    session.closed = true;
    sessions.delete(id);
    try { child.kill(); } catch { /* 已经退了 */ }
    return {
      ok: false,
      code: 'not_ready',
      text: `无头浏览器没起来（${stderr.slice(-300) || '端口没响应'}）`,
    };
  }

  // 建一个空白页并把 Cdp 会话连到它身上
  let target = null;
  try {
    target = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, { timeout: 3000 });
  } catch {
    // 新版 Chrome 要求 PUT 才能建页；退而求其次用现成的第一个 page
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, { timeout: 3000 });
    target = (list ?? []).find((t) => t.type === 'page') ?? null;
  }
  if (!target?.webSocketDebuggerUrl) {
    session.closed = true;
    sessions.delete(id);
    try { child.kill(); } catch { /* 已经退了 */ }
    return { ok: false, code: 'no_target', text: '浏览器起来了但没有可用的页面目标' };
  }
  session.page = await connectCdp({ wsUrl: target.webSocketDebuggerUrl });
  session.browserVersion = version['Browser'] ?? '';
  session.navigate = (url, opts) => navigate(session.page, url, opts);
  session.evaluate = (expr, opts) => evaluate(session.page, expr, opts);
  session.screenshot = (opts) => screenshot(session.page, opts);
  return { ok: true, session };
}

/**
 * 统一入口：`mode: 'island'`（默认，另一张桌面里开真窗口）或 `'headless'`（无窗口）。
 *
 * ★ 为什么默认岛而不是无头：**兼容性**。
 *   无头浏览器会被相当一部分站点识别成机器人（Cloudflare、部分登录流程）；
 *   岛里的就是一台普通的 Chromium，只不过窗口在用户看不见的桌面上。
 *   需要更省资源、且站点不检测时，传 `mode: 'headless'`。
 *
 * @param {object} p
 * @param {string} p.key 会话键（按 bot 分）
 * @param {'island'|'headless'} [p.mode]
 * @param {string} [p.app]
 * @param {boolean} [p.shareLogin]
 * @param {string} p.dataDir
 */
export async function openBrowser({ key, mode = 'island', app = 'chrome.exe', shareLogin = true, dataDir, platform = process.platform } = {}) {
  if (mode === 'headless' || !islandSupported()) {
    return openHeadless({ key, app, shareLogin, dataDir, platform });
  }
  return openIslandBrowser({ key, app, shareLogin, dataDir, platform });
}

/**
 * 在**独立桌面**里开一个有头的 Chromium，然后从服务端用 CDP 驱动它。
 *
 * 链路：岛里 CreateProcess（带 `--remote-debugging-port`）→ 服务端连
 * `127.0.0.1:port` 拿 ws 端点 → 之后所有操作走协议。
 * **CDP 走 TCP，跟桌面无关** —— 这就是"窗口在另一张桌子、控制在服务端"能成立的原因。
 */
async function openIslandBrowser({ key, app, shareLogin, dataDir, platform }) {
  const id = String(key ?? '').trim();
  if (!id) return { ok: false, code: 'no_key', text: '需要一个会话键（按 bot 分）' };
  const existing = sessions.get(id);
  if (existing && !existing.closed) {
    existing.lastUsed = Date.now();
    return { ok: true, session: existing, reused: true };
  }

  const found = locateBrowser({ app, platform });
  if (!found.ok) return { ok: false, code: 'no_browser', text: found.error };

  let profileDir = null;
  let login = null;
  if (shareLogin && dataDir) {
    const plan = planLoginSnapshot({ app, dataDir, platform });
    if (plan.ok) {
      const copied = copyLoginSnapshot({ sourceRoot: plan.sourceRoot, destRoot: plan.destRoot, entries: plan.entries });
      if (copied.ok) {
        profileDir = plan.destRoot;
        login = { browser: plan.browser, copied: copied.copied, skipped: copied.skipped };
      }
    }
  }
  if (!profileDir) {
    profileDir = path.join(os.tmpdir(), `pi-island-browser-${id}-${Date.now().toString(36)}`);
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const port = await freePort();
  const args = headlessArgs({ port, userDataDir: profileDir, mode: 'island' });
  const commandLine = [`"${found.file}"`, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
  const islandName = `browser-${id}`;
  const launched = await launchOnIsland({ name: islandName, commandLine });
  if (!launched.ok) {
    return { ok: false, code: 'island_launch_failed', text: `岛上没起来：${launched.text}` };
  }

  const session = {
    key: id,
    mode: 'island',
    app,
    port,
    profileDir,
    login,
    island: islandName,
    pid: launched.pid,
    closed: false,
    lastUsed: Date.now(),
    startedAt: Date.now(),
  };
  sessions.set(id, session);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let version = null;
  while (Date.now() < deadline) {
    try {
      version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!version) {
    session.closed = true;
    sessions.delete(id);
    await closeIsland({ name: islandName, pids: launched.pid ? [launched.pid] : [] }).catch(() => {});
    return { ok: false, code: 'not_ready', text: '岛上的浏览器起来了但 CDP 端口没响应' };
  }

  let target = null;
  try {
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, { timeout: 3000 });
    target = (list ?? []).find((t) => t.type === 'page') ?? null;
  } catch { target = null; }
  if (!target?.webSocketDebuggerUrl) {
    session.closed = true;
    sessions.delete(id);
    await closeIsland({ name: islandName, pids: launched.pid ? [launched.pid] : [] }).catch(() => {});
    return { ok: false, code: 'no_target', text: '浏览器起来了但没有可用的页面目标' };
  }
  session.page = await connectCdp({ wsUrl: target.webSocketDebuggerUrl });
  session.browserVersion = version['Browser'] ?? '';
  session.navigate = (url, opts) => navigate(session.page, url, opts);
  session.evaluate = (expr, opts) => evaluate(session.page, expr, opts);
  session.screenshot = (opts) => screenshot(session.page, opts);
  return { ok: true, session };
}

/** 收掉一个无头会话：先杀进程，再删临时 profile（顺序反了 Windows 上删不掉）。 */
export async function closeHeadless({ key } = {}) {
  const id = String(key ?? '').trim();
  const session = sessions.get(id);
  if (!session) return { ok: true, alreadyClosed: true };
  session.closed = true;
  sessions.delete(id);
  try { session.page?.close(); } catch { /* 已经断了 */ }
  if (session.mode === 'island') {
    // 岛上的浏览器：连桌面一起收（进程 + 岛）
    await closeIsland({ name: session.island, pids: session.pid ? [session.pid] : [] }).catch(() => {});
  } else if (session.proc?.pid) {
    // ★ Windows 上要**杀整棵树**：chrome 会派生渲染进程，只杀父进程会留下孤儿，
    //   而孤儿还占着 profile 目录 —— 下一次同一个 bot 就起不来。
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/PID', String(session.proc.pid), '/T', '/F'], { windowsHide: true }); } catch { /* 已经退了 */ }
    }
    try { session.proc.kill(); } catch { /* 已经退了 */ }
  }
  await new Promise((r) => setTimeout(r, 300));
  // 只有"我们自己造的临时目录"才删；登录态快照要留着（下次复用，且有保留期管理）
  if (session.login == null) {
    try { fs.rmSync(session.profileDir, { recursive: true, force: true }); } catch { /* 占着就下次再删 */ }
  }
  return { ok: true };
}

/** 收掉所有会话（进程退出/测试清理用）。 */
export async function closeAllHeadless() {
  for (const key of [...sessions.keys()]) {
    await closeHeadless({ key });
  }
}

/** 空闲回收（`server-main` 的 housekeeping 调）。 */
export async function sweepHeadless({ now = Date.now(), idleMs = IDLE_CLOSE_MS } = {}) {
  const closed = [];
  for (const [key, session] of [...sessions]) {
    if (now - session.lastUsed < idleMs) continue;
    await closeHeadless({ key });
    closed.push(key);
  }
  return { closed };
}

/** 现有会话（诊断用）。 */
export function listHeadless() {
  return [...sessions.values()].map((s) => ({
    key: s.key, app: s.app, port: s.port, login: s.login,
    idleMs: Date.now() - s.lastUsed, browser: s.browserVersion,
  }));
}

export { BROWSER_APPS };
