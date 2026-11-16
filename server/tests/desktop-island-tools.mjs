/**
 * 独立桌面的**工具层**测试（规格 §5.6 T1）：直接调模型会调的那三个工具。
 *   node tests/desktop-island-tools.mjs
 *
 * ## 为什么还要再测一层
 *
 * `desktop-island-win` 已经证明了"系统调用通"，但那不等于"模型用起来对"。
 * 工具层有三处**错了也不会报错**的地方：
 *
 *   1. 默认岛名 / 参数翻译不一致 → 模型每次都要显式传名字，否则两个任务撞到一张岛上；
 *   2. 白名单拒绝时给的提示没用 → 模型会一直重试同一个被拒的应用；
 *   3. `close` 只关桌面不杀进程 → 每跑一次任务就在用户机器上留一堆孤儿窗口。
 *
 * 第 3 条是真会留垃圾的，所以这里连"进程真的没了"一起验。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
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
const win = await import(src('desktop-island-win.js'));

if (!win.isSupported()) {
  console.log(`- 跳过：${process.platform} 没有 CreateDesktop 等价 API`);
  console.log('0/0 通过（已跳过）');
  process.exit(0);
}
const probeMod = await import(src('desktop-input-win.js'));
const env = probeMod.probeEnvironment();
if (!env.ok || env.session !== true) {
  console.log(`- 跳过：没有可操作的交互桌面（${env.ok ? 'session=false' : env.code}）`);
  console.log('0/0 通过（已跳过）');
  process.exit(0);
}

const { buildIslandTools, DEFAULT_ISLAND } = await import(src('desktop-island-tools.js'));
const tools = buildIslandTools({ botId: 'b_test_island' });
const byName = new Map(tools.map((t) => [t.name, t]));
const call = (name, params) => byName.get(name).execute('call-1', params);
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? '').join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const island = DEFAULT_ISLAND;

try {
  await test('三个工具都在，且名字/参数长得对', () => {
    for (const name of ['desktop_island_launch', 'desktop_island_observe', 'desktop_island_input']) {
      assert.ok(byName.has(name), `缺工具 ${name}`);
      assert.ok(byName.get(name).description.length > 80, `${name} 的说明太短，模型会看不懂边界`);
    }
  });

  await test('★ 三个命令解释器被拒，而且提示要说清"为什么"和"该走哪条路"', async () => {
    // 产品决定：其它程序都能起（按 cmd.exec 的权限走），只有"会把参数当命令串
    // 解释"的那三个不行 —— 它们能把"一项一个参数"绕成一段命令。
    const r = await call('desktop_island_launch', { app: 'cmd.exe' });
    assert.equal(r.isError, true);
    const t = textOf(r);
    assert.match(t, /没启动/);
    assert.match(t, /不能起/, '要告诉模型这个工具不走命令串');
    assert.match(t, /bash|powershell 工具/, '要给出替代路径，否则它会反复重试');
  });

  await test('★ 拼命令串被拒，且点名"要一项一项给"', async () => {
    const r = await call('desktop_island_launch', { app: 'notepad.exe', args: ['a', '&', 'del', '*'] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /不接命令串/);
  });

  await test('启动一个真实应用 → 岛上有窗口', async () => {
    const r = await call('desktop_island_launch', { app: 'notepad.exe' });
    assert.notEqual(r.isError, true, textOf(r));
    assert.match(textOf(r), /已在岛上启动/);
    assert.ok(r.details.pid > 0);
    assert.equal(r.details.island, island, '默认岛名要一致');
    const obs = await call('desktop_island_observe', {});
    assert.notEqual(obs.isError, true, textOf(obs));
    assert.match(textOf(obs), /Notepad|记事本/i);
  });

  await test('给 window 就列控件（而不是只列窗口）', async () => {
    const r = await call('desktop_island_observe', { window: 'Notepad' });
    if (r.isError) {
      // 现代记事本的控件类名不一定是 Win32 的；这时工具应如实说"控件 0 个"
      assert.match(textOf(r), /没找到窗口|控件/);
      return;
    }
    assert.match(textOf(r), /控件 \d+ 个/);
  });

  await test('★ 点一下之后建议再截一张（消息发出去 ≠ 界面变了）', async () => {
    const r = await call('desktop_island_input', { action: 'click', window: 'Notepad', x: 40, y: 40 });
    if (r.isError) {
      assert.match(textOf(r), /没找到目标窗口|没点/);
      return;
    }
    assert.match(textOf(r), /点了一下/);
    assert.match(textOf(r), /确认/, '要提醒"发了不等于成了"');
  });

  await test('★ 收尾：桌面关掉，起过的进程也杀掉（不留孤儿）', async () => {
    const before = await call('desktop_island_observe', {});
    assert.notEqual(before.isError, true);
    const r = await call('desktop_island_input', { action: 'close' });
    assert.notEqual(r.isError, true, textOf(r));
    assert.equal(win.islandExists({ name: island }).exists, false, '桌面应该没了');
    assert.ok(r.details.killed >= 1, '至少该杀掉刚才那个记事本');
    await sleep(300);
    // 再观察应该是"岛上什么都没有"
    const after = await call('desktop_island_observe', {});
    assert.equal(after.isError, true);
    assert.match(textOf(after), /岛上什么都没有/);
  });

  await test('没有岛时点/看都给可执行的提示，不是一句"失败"', async () => {
    const click = await call('desktop_island_input', { action: 'click', x: 1, y: 1 });
    assert.equal(click.isError, true);
    assert.match(textOf(click), /先 desktop_island_launch/);
  });
} finally {
  await win.closeIsland({ name: island }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
