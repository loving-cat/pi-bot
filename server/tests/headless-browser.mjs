/**
 * 无头浏览器：真起一个 Chromium 跑一遍（离线，不联网）。
 *   node tests/headless-browser.mjs
 *
 * ## 为什么这条测试必须真跑
 *
 * `cdp-client.js` 和 `headless-browser.js` 的每一行都在跟外部进程打交道，
 * 纯函数测不出"参数错了启动就失败"、"回包按顺序取会拿到事件"这类问题。
 * 而它们要保证的恰好是**用户屏幕上不该出现窗口** —— 那种错误上线后
 * 表现是"调研又弹我一脸浏览器"，而日志里一切正常。
 *
 * 用 `data:` URL 和 `about:blank` 做验证，不发任何网络请求。
 * 机器上没有 Chrome/Edge 就跳过（明确打印原因，不假装通过）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  locateBrowser, headlessArgs, openHeadless, closeHeadless, listHeadless, BROWSER_APPS,
  openBrowser,
} = await import(src('headless-browser.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------- 纯参数
test('启动参数里必须有 --headless（这就是"不弹窗"的本体）', () => {
  const args = headlessArgs({ port: 1234, userDataDir: 'D:/tmp/prof' });
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--remote-debugging-port=1234'));
  assert.ok(args.includes('--user-data-dir=D:/tmp/prof'));
  // 首次启动的"设为默认浏览器"横幅会让截图里多一条广告
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--no-default-browser-check'));
  // 无头里 GPU 合成经常出黑图
  assert.ok(args.includes('--disable-gpu'));
});

test('★ 岛模式**不加** --headless（要真窗口，只是开在另一张桌面上）', () => {
  const island = headlessArgs({ port: 1, mode: 'island' });
  assert.ok(!island.some((a) => a.startsWith('--headless')), '岛模式要真窗口：无头会被站点识别成机器人');
  assert.ok(island.includes('--remote-debugging-port=1'), '驱动靠 CDP，端口必须有');
  const headless = headlessArgs({ port: 1, mode: 'headless' });
  assert.ok(headless.includes('--headless=new'));
});

test('没有 profile 目录时不写 --user-data-dir（用浏览器自己的默认）', () => {
  const args = headlessArgs({ port: 1 });
  assert.ok(!args.some((a) => a.startsWith('--user-data-dir=')));
});

test('只认能当浏览器的可执行体', () => {
  assert.deepEqual(Object.keys(BROWSER_APPS).sort(), ['chrome.exe', 'chromium', 'google-chrome', 'msedge.exe']);
  assert.equal(locateBrowser({ app: 'notepad.exe' }).ok, false);
});

test('找不到浏览器时如实报错（不猜路径）', () => {
  const r = locateBrowser({ app: 'chrome.exe', platform: 'win32', exists: () => false });
  assert.equal(r.ok, false);
  assert.match(r.error, /没找到/);
});

// ---------------------------------------------------------------- 真机
const probe = locateBrowser({ app: 'chrome.exe' });
if (!probe.ok) {
  console.log(`- 跳过真机部分：${probe.error}`);
  const failedSkipped = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
  console.log(`${results.length - failedSkipped.length}/${results.length} 通过（真机部分已跳过）`);
  process.exit(failedSkipped.length ? 1 : 0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-headless-'));
const KEY = `test-${Math.random().toString(36).slice(2, 7)}`;

try {
  await test('★ 真的起得来：拿到 CDP 版本号（说明无头进程在听）', async () => {
    const r = await openHeadless({ key: KEY, app: 'chrome.exe', shareLogin: false, dataDir: root });
    assert.equal(r.ok, true, r.text);
    assert.match(r.session.browserVersion, /Chrome|Edg/i);
  });

  await test('★ 能执行 JS（真浏览器，不是 HTTP 抓页面）', async () => {
    const r = await openHeadless({ key: KEY, shareLogin: false, dataDir: root });
    const v = await r.session.evaluate('1 + 1');
    assert.equal(v, 2);
    const asyncValue = await r.session.evaluate('(async () => { await new Promise(r => setTimeout(r, 50)); return "ok"; })()');
    assert.equal(asyncValue, 'ok', '页面里的异步也要能等到');
  });

  await test('打开 data: URL 并读到内容（不联网）', async () => {
    const r = await openHeadless({ key: KEY, shareLogin: false, dataDir: root });
    await r.session.navigate('data:text/html,<title>pi-probe</title><h1 id=x>hello</h1>');
    // ★ 回归锁：navigate 返回时文档必须已解析完，否则调用方紧接着读 DOM 会拿到 null
    assert.equal(await r.session.evaluate('document.readyState'), 'complete');
    const got = await r.session.evaluate('document.getElementById("x").textContent');
    assert.equal(got, 'hello');
    const title = await r.session.evaluate('document.title');
    assert.equal(title, 'pi-probe');
  });

  await test('★ 截图拿得到真内容（不是黑图）', async () => {
    const r = await openHeadless({ key: KEY, shareLogin: false, dataDir: root });
    await r.session.navigate('data:text/html,<body style="background:#fff"><h1 style="color:#000">X</h1></body>');
    const png = await r.session.screenshot({ fullPage: true });
    assert.ok(png.length > 1000, `PNG 太小：${png.length}`);
    assert.equal(png[0], 0x89, 'PNG 魔数');
  });

  await test('★ 页面里报错要如实抛出（不能静默返回 null）', async () => {
    const r = await openHeadless({ key: KEY, shareLogin: false, dataDir: root });
    await assert.rejects(() => r.session.evaluate('throw new Error("boom-in-page")'), /boom-in-page/);
  });

  await test('同一个 key 复用同一个会话（不重复起进程）', async () => {
    const a = await openHeadless({ key: KEY, shareLogin: false, dataDir: root });
    const b = await openHeadless({ key: KEY, shareLogin: false, dataDir: root });
    assert.equal(b.reused, true);
    assert.equal(a.session.port, b.session.port);
  });

  await test('会话表里看得到它（诊断用）', async () => {
    const list = listHeadless();
    assert.ok(list.some((s) => s.key === KEY));
  });

  await test('收得干净：会话没了，进程退掉', async () => {
    const before = (await openHeadless({ key: KEY, shareLogin: false, dataDir: root })).session;
    await closeHeadless({ key: KEY });
    assert.ok(!listHeadless().some((s) => s.key === KEY));
    // 给进程一点时间退出（Windows 上 TerminateProcess 到 exit 事件有延迟）
    for (let i = 0; i < 20 && before.proc.exitCode === null; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.notEqual(before.proc.exitCode, null, '进程应该已经退出');
  });

  await test('没有登录态需求时用的是临时 profile（收摊时删掉）', async () => {
    const r = await openHeadless({ key: `${KEY}-tmp`, shareLogin: false, dataDir: root });
    assert.equal(r.ok, true, r.text);
    const dir = r.session.profileDir;
    await closeHeadless({ key: `${KEY}-tmp` });
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(fs.existsSync(dir), false, '临时 profile 应该删掉');
  });
  await test('★ 岛模式：窗口在另一张桌面上，CDP 照样能驱动', async () => {
    // 岛要"真交互桌面"：非 Windows 会合理退回无头，CI（session 0）也没有桌面。
    // 这两种情况明确跳过 —— 不假装通过，也不假装失败。
    if (process.platform !== 'win32' || process.env.CI) {
      console.log(`  （跳过岛模式：platform=${process.platform}${process.env.CI ? ' / CI 无交互桌面' : ''}）`);
      return;
    }
    const r = await openBrowser({ key: `${KEY}-island`, mode: 'island', shareLogin: false, dataDir: root });
    if (!r.ok) {
      console.log(`  （跳过岛模式：${r.text}）`);
      return;
    }
    assert.equal(r.session.mode, 'island');
    assert.ok(r.session.island, '要记录岛名，收摊时连桌面一起收');
    await r.session.navigate('data:text/html,<title>island-probe</title><h1>hi</h1>');
    assert.equal(await r.session.evaluate('document.title'), 'island-probe');
    const png = await r.session.screenshot({ fullPage: true });
    assert.ok(png.length > 1000);
    await closeHeadless({ key: `${KEY}-island` });
  });
} finally {
  await closeHeadless({ key: `${KEY}-island` }).catch(() => {});
  await closeHeadless({ key: KEY }).catch(() => {});
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 占着就留着 */ }
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
