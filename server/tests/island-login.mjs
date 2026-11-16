/**
 * 登录态共享（规格 §5.6 T1 的可用性那一半）：纯逻辑测试。
 *   node tests/island-login.mjs
 *
 * ## 守什么
 *
 * 这一层会**把用户的浏览器登录凭据复制到另一个目录**。错任何一条都不是小问题：
 *
 *   1. 指错目录 → 复制了个空壳，用户以为共享了、实际没有（最坏：他自己去看
 *      "为什么还要我登录"而不知道是我们搞错了）；
 *   2. 直接指向用户正在用的那份 → 两个进程抢同一份 Chrome 配置，可能把
 *      用户自己的登录态弄坏；
 *   3. 复制整个目录 → 几个 GB，开个浏览器等半分钟；
 *   4. 复制失败当成成功 → 界面上说"已带上登录态"，实际是干净实例；
 *   5. 快照永久留着不清 → 数据目录里长期躺着一份可用的登录凭据。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  BROWSER_APPS, SNAPSHOT_ENTRIES, MAX_FILE_BYTES,
  browserProfileRoots, planLoginSnapshot, copyLoginSnapshot, islandBrowserArgs, pruneLoginSnapshots,
} = await import(src('island-login.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const WIN_HOME = 'C:\\Users\\someone';
const fakeExists = (set) => (p) => set.some((s) => p.replace(/\\/g, '/').endsWith(s.replace(/\\/g, '/')));

// ---------------------------------------------------------------- 目录定位
test('Windows 上按浏览器找用户配置目录（chrome / edge / firefox）', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local', APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' };
  assert.deepEqual(
    browserProfileRoots({ app: 'chrome.exe', platform: 'win32', env, home: WIN_HOME }),
    [path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')],
  );
  assert.deepEqual(
    browserProfileRoots({ app: 'msedge.exe', platform: 'win32', env, home: WIN_HOME }),
    [path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data')],
  );
  assert.deepEqual(
    browserProfileRoots({ app: 'firefox.exe', platform: 'win32', env, home: WIN_HOME }),
    [path.join(env.APPDATA, 'Mozilla', 'Firefox')],
  );
});

test('macOS 上走 Application Support；不认识的程序返回空（**不猜**）', () => {
  const roots = browserProfileRoots({ app: 'chrome.exe', platform: 'darwin', home: '/Users/someone' });
  assert.equal(roots[0], path.join('/Users/someone', 'Library', 'Application Support', 'Google', 'Chrome'));
  assert.deepEqual(browserProfileRoots({ app: 'myapp.exe', platform: 'win32', home: WIN_HOME }), []);
});

test('只有三个浏览器算浏览器', () => {
  assert.deepEqual(Object.keys(BROWSER_APPS).sort(), ['chrome.exe', 'firefox.exe', 'msedge.exe']);
});

// ---------------------------------------------------------------- 快照计划
test('★ 非浏览器直接拒（没有可共享的登录态）', () => {
  const r = planLoginSnapshot({ app: 'notepad.exe', dataDir: 'C:\\data', exists: () => true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_a_browser');
});

test('★ 找不到配置目录 → 说清楚，不假装共享', () => {
  const r = planLoginSnapshot({ app: 'chrome.exe', dataDir: 'C:\\data', exists: () => false, platform: 'win32' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_profile');
  assert.match(r.text, /没找到/);
});

test('★ 目录在但里面没登录文件 → 也算没共享（空壳没意义）', () => {
  // 只让 User Data 这一层存在，具体文件一个都不存在
  const exists = (p) => /User Data$/.test(p);
  const r = planLoginSnapshot({ app: 'chrome.exe', dataDir: 'C:\\data', exists, platform: 'win32' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'empty_profile');
});

test('★ 快照只能落在数据目录（那里不会被当附件发出去）', () => {
  const exists = fakeExists(['User Data', 'Local State', 'Default/Cookies']);
  const r = planLoginSnapshot({ app: 'chrome.exe', dataDir: 'C:\\data', exists, platform: 'win32' });
  assert.equal(r.ok, true);
  assert.ok(r.destRoot.startsWith(path.join('C:\\data', 'island-login')));
  // 绝不允许指回用户正在用的那份
  assert.notEqual(r.destRoot, r.sourceRoot);
});

test('只挑登录要用的那几个文件，不复制缓存', () => {
  const exists = fakeExists(['User Data', 'Local State', 'Default/Cookies', 'Default/Login Data', 'Default/Cache']);
  const r = planLoginSnapshot({ app: 'chrome.exe', dataDir: 'C:\\data', exists, platform: 'win32' });
  assert.equal(r.ok, true);
  assert.ok(r.entries.includes('Default/Cookies'));
  assert.ok(r.entries.includes('Local State'));
  assert.ok(!r.entries.some((e) => /Cache/.test(e)), '缓存不是登录态，复制它只会让启动变慢');
  for (const e of r.entries) assert.ok(SNAPSHOT_ENTRIES.includes(e));
});

// ---------------------------------------------------------------- 复制
test('复制：统计个数，单个文件失败不算整体失败', () => {
  const fsImpl = {
    statSync: (p) => {
      if (p.endsWith('Cookies')) throw new Error('EBUSY（浏览器正开着）');
      return { size: 1234 };
    },
    mkdirSync: () => {},
    copyFileSync: () => {},
  };
  const r = copyLoginSnapshot({
    sourceRoot: 'C:\\src',
    destRoot: 'C:\\dst',
    entries: ['Default/Cookies', 'Local State'],
    fsImpl,
  });
  assert.equal(r.ok, true, '一个文件被锁不该拖垮整体');
  assert.equal(r.copied, 1);
  assert.equal(r.skipped, 1);
});

test('全部失败 → ok=false（不能说"已共享"）', () => {
  const fsImpl = { statSync: () => { throw new Error('nope'); }, mkdirSync: () => {}, copyFileSync: () => {} };
  const r = copyLoginSnapshot({ sourceRoot: 'a', destRoot: 'b', entries: ['x'], fsImpl });
  assert.equal(r.ok, false);
});

test('超大文件跳过（多半是缓存，不是登录态）', () => {
  const fsImpl = {
    statSync: () => ({ size: MAX_FILE_BYTES + 1 }),
    mkdirSync: () => {},
    copyFileSync: () => { throw new Error('不该复制'); },
  };
  const r = copyLoginSnapshot({ sourceRoot: 'a', destRoot: 'b', entries: ['big'], fsImpl });
  assert.equal(r.copied, 0);
  assert.equal(r.skipped, 1);
});

// ---------------------------------------------------------------- 启动参数
test('Chromium 系：带 --user-data-dir 和 --no-first-run', () => {
  const args = islandBrowserArgs({ app: 'chrome.exe', userDataDir: 'D:\\snap', extra: ['--start-maximized'] });
  assert.ok(args.includes('--user-data-dir=D:\\snap'));
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--start-maximized'), '调用方给的参数要保留');
});

test('★ 不加 --headless：我们要的是有窗口、能截图', () => {
  const args = islandBrowserArgs({ app: 'msedge.exe', userDataDir: 'D:\\snap' });
  assert.ok(!args.some((a) => /headless/i.test(a)));
});

test('Firefox 用自己的 -profile 机制', () => {
  const args = islandBrowserArgs({ app: 'firefox.exe', userDataDir: 'D:\\snap' });
  assert.ok(args.includes('-profile'));
  assert.ok(args.includes(path.join('D:\\snap', 'Default')));
});

test('没有快照就原样返回（不硬塞 --user-data-dir）', () => {
  assert.deepEqual(islandBrowserArgs({ app: 'chrome.exe', userDataDir: '' }), []);
});

// ---------------------------------------------------------------- 清理
test('★ 过期快照会被清掉（那是可用的凭据，不能长期躺着）', () => {
  const now = 1_700_000_000_000;
  const removed = [];
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['chrome', 'edge'],
    statSync: (p) => ({ mtimeMs: p.endsWith('chrome') ? now - 30 * 24 * 3600_000 : now - 1000 }),
    rmSync: (p) => removed.push(p),
  };
  const r = pruneLoginSnapshots({ dataDir: 'C:\\data', now, fsImpl });
  assert.equal(r.removed, 1);
  assert.ok(removed[0].endsWith('chrome'));
});

test('没有快照目录时安静返回（housekeeping 不该报错）', () => {
  const r = pruneLoginSnapshots({ dataDir: 'C:\\data', fsImpl: { existsSync: () => false } });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 0);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
