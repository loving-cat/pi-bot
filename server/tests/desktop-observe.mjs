/**
 * 桌面观察（只读）的单元测试。
 *   node tests/desktop-observe.mjs
 *
 * 这些用例**不需要**真的截到用户屏幕：
 * 它们守的是"能不能安全地调用"和"结果形状对不对"，
 * 真机截图见 docs/PERMISSIONS-INVENTORY.md 的实测记录。
 *
 * 必须在任何平台上都能跑 —— CI 的 ubuntu / windows / macos 三个 job 都会执行它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const m = await import('../src/desktop-observe.js');
const {
  listWindows, captureScreenshot, screenshotPath, describeWindow, pruneScreenshots,
} = m;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-'));
const canObserve = process.platform === 'win32' || process.platform === 'darwin';

await test('截图落点：不进 workspace，按任务/bot 分开', () => {
  const a = screenshotPath({ dataDir: root, taskId: 'tr_abc' });
  const b = screenshotPath({ dataDir: root, taskId: 'tr_abc' });
  assert.ok(a.dir.includes('desktop-shots'), '应落在 desktop-shots 下（不是 workspace）');
  assert.ok(a.dir.includes('tr_abc'));
  assert.notEqual(a.file, b.file, '两次调用不能撞名');
  assert.ok(a.file.endsWith('.png'));

  const noTask = screenshotPath({ dataDir: root, botId: 'b_1' });
  assert.ok(noTask.dir.includes('b_1'));
});

await test('截图落点：id 里的路径字符被清掉（不能靠 id 跳出目录）', () => {
  const evil = screenshotPath({ dataDir: root, taskId: '../../etc/passwd' });
  assert.ok(!evil.dir.includes('..'), '路径穿越字符必须被清掉：' + evil.dir);
  assert.ok(evil.dir.startsWith(path.join(root, 'desktop-shots')), evil.dir);
});

await test('缺参数时明确报错，不猜', () => {
  assert.equal(captureScreenshot({}).ok, false);
  assert.match(captureScreenshot({}).error, /落盘路径/);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const noWin = captureScreenshot({ outFile: path.join(root, 'x.png') });
    assert.equal(noWin.ok, false);
    assert.match(noWin.error, /没有指定窗口|完整屏幕/);
  }
});

await test('窗口描述是可读一行、不含绝对路径', () => {
  const line = describeWindow({
    app: 'msedge', title: 'New tab', x: 100, y: 200, width: 800, height: 600,
  }, 0);
  assert.match(line, /^1\. /);
  assert.match(line, /msedge/);
  assert.match(line, /800x600/);
  assert.ok(!line.includes('/'), '不该出现路径分隔符：' + line);
});

await test('窗口描述：没标题时给出占位而不是空串', () => {
  const line = describeWindow({ app: 'x', title: '', width: 10, height: 10 });
  assert.match(line, /无标题/);
});

await test('清理旧截图只删 png，且不越过 desktop-shots', () => {
  const dir = path.join(root, 'desktop-shots', 'tr_old');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'a.png');
  const keep = path.join(dir, 'b.png');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(keep, 'y');
  // 一个不该被碰的文件（在 desktop-shots 之外）
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, 'z');
  // 把 old 的 mtime 调老
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(old, past, past);

  const out = pruneScreenshots({ dataDir: root, maxAgeMs: 24 * 3600 * 1000 });
  assert.equal(out.removed, 1);
  assert.ok(!fs.existsSync(old), '旧图应被删');
  assert.ok(fs.existsSync(keep), '新图应保留');
  assert.ok(fs.existsSync(outside), 'desktop-shots 之外的文件不许碰');
});

// ---------------------------------------------------------------- 真机行为
await test('当前平台要么能列窗口，要么明确说"不支持"', async () => {
  const r = listWindows();
  if (!canObserve) {
    assert.equal(r.ok, false);
    assert.match(r.error, /不支持/);
    return;
  }
  // Windows 上没有窗口也应当是"空列表"而不是失败
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) {
    assert.ok(Array.isArray(r.windows));
    assert.ok(r.windows.length <= 40, '默认上限 40');
    for (const w of r.windows) {
      assert.ok(w.width > 0 && w.height > 0, '过滤掉零面积窗口');
      assert.equal(typeof w.app, 'string');
    }
  }
});

await test('真机截图：截得到，且文件是合法 PNG', async () => {
  if (!canObserve) return;
  const list = listWindows();
  if (!list.ok || !list.windows.length) {
    console.log('     （当前没有可截窗口，跳过）');
    return;
  }
  const target = list.windows[0];
  const p = screenshotPath({ dataDir: root, botId: 'shot' });
  const r = captureScreenshot({ outFile: p.file, window: target, maxEdge: 800 });
  assert.equal(r.ok, true, r.error ?? '');
  assert.ok(fs.statSync(p.file).size > 1000, '截图不应是空文件');
  const buf = fs.readFileSync(p.file);
  assert.equal(buf.slice(1, 4).toString('ascii'), 'PNG');
  assert.ok(r.width > 0 && r.height > 0);
  // 缩放后最长边不超过 maxEdge
  assert.ok(Math.max(r.width, r.height) <= 800, `最长边 ${Math.max(r.width, r.height)} 超过 800`);
});

await test('真机截图：PrintWindow 拿到的不是空白（回归：PowerShell 变量名撞句柄）', async () => {
  if (process.platform !== 'win32') return;
  const list = listWindows();
  if (!list.ok || !list.windows.length) return;
  const target = list.windows[0];
  const p = screenshotPath({ dataDir: root, botId: 'blank' });
  const r = captureScreenshot({ outFile: p.file, window: target, maxEdge: 4000 });
  assert.equal(r.ok, true, r.error ?? '');

  // 直接解 PNG 的 IDAT 看字节分布：全黑/全白图里单字节占比会 > 99%
  const buf = fs.readFileSync(p.file);
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    if (type === 'IDAT') idat.push(buf.slice(pos + 8, pos + 8 + len));
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const counts = new Uint32Array(256);
  for (let i = 0; i < raw.length; i += 1) counts[raw[i]] += 1;
  let top = 0;
  for (let i = 0; i < 256; i += 1) if (counts[i] > top) top = counts[i];
  const ratio = top / raw.length;
  assert.ok(ratio < 0.99, `截图几乎是纯色（top=${top} / ${raw.length}）——PrintWindow 可能没生效`);
});

await test('全屏截图必须显式要求（默认路径不截全屏）', () => {
  // 这条是行为约定：不传 window 也不传 fullScreen 时必须拒绝，
  // 否则模型很容易"顺手截一下整个桌面"，把用户所有窗口一起送进上下文。
  if (!canObserve) return;
  const out = captureScreenshot({ outFile: path.join(root, 'full.png') });
  assert.equal(out.ok, false);
  assert.match(out.error, /没有指定窗口/);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
