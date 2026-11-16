/**
 * 独立桌面（规格 §5.6 T1 档）的**接线测试**：真起一个岛、真点一下。
 *   node tests/desktop-island-win.mjs
 *
 * ## 为什么非要有这么慢的一个测试
 *
 * `desktop-island.js` 的 28 项单测证明"算得对"，证明不了四件事 ——
 * 而它们**错了都不报错**，只会表现成"功能好像做了但没用"：
 *
 *   1. 建岛 / 启动 / 枚举 / 取帧 / 发消息这五条系统调用**真的连通**；
 *   2. `PostMessage` 打过去的点击**真的会生效**（不是"发出去了"就算）；
 *   3. 截回来的是**真内容**（不是一张黑图）；
 *   4. 岛上的线程**发不出系统输入**（这才是"不打扰用户"的证据）。
 *
 * 第 2 条靠副作用证明：靶子被点中会写一个标记文件。
 * 第 4 条必须在岛上试 —— 从用户桌面调 `SendInput` 就是 T2 行为本身，
 * 既会真的挪动用户的鼠标，也会被"用户正好在动"污染成噪声。
 *
 * 平台不对就跳过（macOS/Linux 没有等价 API），跳过时打一行说明，不假装通过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const m = await import(src('desktop-island-win.js'));
const { planIslandLaunch, planIslandMessages } = await import(src('desktop-island.js'));

if (!m.isSupported()) {
  console.log(`- 跳过：${process.platform} 没有 CreateDesktop 等价 API（T1 只在 Windows 上成立）`);
  console.log('0/0 通过（已跳过）');
  process.exit(0);
}

// CI/服务账户没有交互会话：桌面能建，但窗口画不出来、消息也没人处理。
// 那种环境下跑这个测试只会给出噪声，所以**明确跳过**并说清原因，不假装通过。
const probeMod = await import(src('desktop-input-win.js'));
const env = probeMod.probeEnvironment();
if (!env.ok || env.session !== true) {
  console.log(`- 跳过：没有可操作的交互桌面（${env.ok ? 'session=false' : env.code}）—— 这一步只能在有人登录的桌面上跑`);
  console.log('0/0 通过（已跳过）');
  process.exit(0);
}

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'island');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-island-'));
const island = `pibot_test_${Math.random().toString(36).slice(2, 8)}`;
const marker = path.join(tmp, 'clicked.txt');
const shot = path.join(tmp, 'island.png');
const state = { pids: [], hwnd: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立（别用固定 sleep：首帧多久全看机器心情）。 */
async function until(fn, { timeout = 15_000, every = 250 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = await fn();
    if (hit) return hit;
    await sleep(every);
  }
  return null;
}

async function findControl(re) {
  const kids = await m.listIslandChildren({ name: island, hwnd: state.hwnd });
  assert.equal(kids.ok, true, kids.text);
  return kids.children.find((c) => re.test(c.cls)) ?? null;
}

try {
  await test('★ 岛要真的起得来（空岛不会留下：句柄一关就销毁）', async () => {
    assert.equal(m.islandExists({ name: island }).exists, false, '还没启动任何东西，岛不该存在');
    const fixture = path.join(FIXTURES, 'island-fixture.ps1');
    assert.ok(fs.existsSync(fixture), `缺靶子脚本：${fixture}`);
    // 白名单只约束"产品里能被要求启动什么"。靶子是测试自己起的进程，
    // powershell 不在白名单里 —— 这条方向由纯逻辑测试守。
    const bad = planIslandLaunch({ exe: 'powershell.exe' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'app_not_allowed');

    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${fixture}" -Seconds 90 -Marker "${marker}"`;
    const r = await m.launchOnIsland({ name: island, commandLine: cmd });
    assert.equal(r.ok, true, r.text);
    assert.ok(r.pid > 0);
    state.pids.push(r.pid);

    const ex = m.islandExists({ name: island });
    assert.equal(ex.exists, true);
    assert.equal(ex.created, true, '这个岛应该是这一轮新建的');
  });

  await test('★ 跨桌面枚举：岛上出现靶子窗口', async () => {
    const win = await until(async () => {
      const list = await m.listIslandWindows({ name: island });
      if (!list.ok) return null;
      return list.windows.find((w) => String(w.title).includes('ISLAND-FIXTURE')) ?? null;
    });
    assert.ok(win, '岛上没出现靶子窗口');
    assert.equal(win.visible, true);
    assert.ok(win.width > 200 && win.height > 200, `窗口太小：${win.width}x${win.height}`);
    state.hwnd = win.hwnd;
  });

  await test('★ 跨桌面取帧：拿到真实内容，且判定为"看得见"', async () => {
    const cap = await m.captureIslandWindow({ name: island, hwnd: state.hwnd, file: shot });
    assert.equal(cap.ok, true, cap.text);
    assert.ok(fs.existsSync(shot), '没落盘');
    assert.ok(fs.statSync(shot).size > 1000, 'PNG 太小，多半是空图');
    assert.ok(cap.darkRatio < 0.98, `暗像素占比 ${cap.darkRatio}，判成黑帧了`);
  });

  await test('★ PostMessage 点按钮：靶子真的写出标记文件', async () => {
    const btn = await findControl(/BUTTON|Button/);
    assert.ok(btn, '没找到按钮控件');
    const plan = planIslandMessages({
      kind: 'click',
      point: { x: Math.floor(btn.clientWidth / 2), y: Math.floor(btn.clientHeight / 2) },
      clientSize: { width: btn.clientWidth, height: btn.clientHeight },
    });
    assert.equal(plan.ok, true, plan.text);
    const sent = await m.postIslandMessages({ name: island, hwnd: btn.hwnd, ops: plan.ops });
    assert.equal(sent.ok, true, sent.text);
    assert.equal(sent.sent, 2);
    const clicked = await until(() => fs.existsSync(marker), { timeout: 8000 });
    assert.ok(clicked, '点了但靶子没有反应 —— 消息没落到按钮上');
  });

  await test('★ WM_CHAR 打字 + WM_GETTEXT 读回（全程不碰系统输入）', async () => {
    const edit = await findControl(/Edit|EDIT/);
    assert.ok(edit, '没找到输入框控件');
    const text = 'island-ok-42';
    const plan = planIslandMessages({ kind: 'type', text });
    assert.equal(plan.ok, true);
    const ops = plan.ops.map((o) => ({ ...o, delayMs: 10 }));
    assert.equal((await m.postIslandMessages({ name: island, hwnd: edit.hwnd, ops })).ok, true);
    const read = await until(
      async () => {
        const r = await m.readIslandText({ name: island, hwnd: edit.hwnd });
        return r.ok && r.text === text ? r : null;
      },
      { timeout: 8000 },
    );
    assert.ok(read, '读回来的文字对不上');
  });

  await test('WM_SETTEXT 一次性替换（不依赖焦点/逐字）', async () => {
    const edit = await findControl(/Edit|EDIT/);
    const plan = planIslandMessages({ kind: 'setText', text: 'replaced' });
    assert.equal((await m.postIslandMessages({ name: island, hwnd: edit.hwnd, ops: plan.ops })).ok, true);
    const read = await until(
      async () => {
        const r = await m.readIslandText({ name: island, hwnd: edit.hwnd });
        return r.ok && r.text === 'replaced' ? r : null;
      },
      { timeout: 8000 },
    );
    assert.ok(read);
  });

  await test('★ 岛上的线程发不出系统输入（这才是"不打扰"的证据）', async () => {
    const checkOut = path.join(tmp, 'input-check.txt');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(FIXTURES, 'island-input-check.ps1')}" -Out "${checkOut}"`;
    const r = await m.launchOnIsland({ name: island, commandLine: cmd });
    assert.equal(r.ok, true, r.text);
    const file = await until(() => (fs.existsSync(checkOut) ? checkOut : null), { timeout: 20_000 });
    assert.ok(file, '岛上那个检查进程没写出结果');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /thread_desktop=pibot_test_/, '它应该跑在岛上');
    assert.match(text, /sendinput_move=sent=0/, `SendInput 应该被拒：${text}`);
    assert.match(text, /sendinput_move=.*err=5/, 'err=5 是 ERROR_ACCESS_DENIED');
    assert.match(text, /setcursorpos_returned=False/, 'SetCursorPos 应该被拒');
  });

  await test('坏句柄 / 坏参数不炸（返回错误码，不乱枚举）', async () => {
    assert.equal((await m.listIslandChildren({ name: island, hwnd: 0 })).ok, false);
    assert.equal((await m.listIslandChildren({ name: island, hwnd: 'abc' })).ok, false);
    assert.equal((await m.readIslandText({ name: island, hwnd: 0 })).ok, false);
    assert.equal((await m.postIslandMessages({ name: island, hwnd: state.hwnd, ops: [] })).ok, false);
    assert.equal((await m.captureIslandWindow({ name: island, hwnd: state.hwnd })).ok, false, '缺路径应报错');
  });

  await test('收摊之后岛就没了（不留孤儿进程/句柄）', async () => {
    await m.closeIsland({ name: island, pids: state.pids });
    assert.equal(m.islandExists({ name: island }).exists, false);
  });
} finally {
  for (const pid of state.pids) {
    await m.killProcess({ name: island, pid }).catch(() => {});
  }
  await m.closeIsland({ name: island }).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
