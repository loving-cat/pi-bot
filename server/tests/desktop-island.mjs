/**
 * 独立桌面（规格 §5.6 的 T1 档）纯逻辑测试。
 *   node tests/desktop-island.mjs
 *
 * ## 这里守的是什么
 *
 * 平台层（真起一个桌面、真点一下）只能在 Windows 交互会话里跑，CI 上跳过。
 * 但下面这几件事**错了都不会报错**，只会在生产里表现成"任务悄悄跑到了用户的屏幕上"：
 *
 *   1. T1 不可用时**静默退到 T2**；
 *   2. 命令行被拼成一段交给 shell 解释的字符串；
 *   3. 坐标越界还发出去（点在目标窗口外面）；
 *   4. 全黑截帧当成功交出去；
 *   5. 白名单形同虚设（路径穿越、解释器）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  TIER, ISLAND_FAIL, ISLAND_APPS, ISLAND_LIMITS, MAX_TEXT_CHARS,
  chooseTier, planIslandLaunch, planIslandMessages, pointToLParam,
  captureVerdict, describeTier,
} = await import(src('desktop-island.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------- 档位选择
test('不需要 GUI 就走 T0（有 CLI/API 就别开界面）', () => {
  const r = chooseTier({ needsGui: false, islandSupported: true, islandAuthorized: true });
  assert.equal(r.tier, TIER.programmatic);
  // 而且不该拿"T1 可用"当借口去做 GUI
  assert.deepEqual(r.why.length, 1);
});

test('T1 可用且已授权 → 选 T1', () => {
  const r = chooseTier({ needsGui: true, islandSupported: true, islandAuthorized: true });
  assert.equal(r.tier, TIER.island);
});

test('★ T1 不可用时**不自动退到 T2**，只给理由', () => {
  const r = chooseTier({
    needsGui: true,
    islandSupported: false, // macOS
    sharedSupported: true,
    sharedAuthorized: true,
  });
  assert.equal(r.tier, null, '静默退到 T2 会让任务在用户屏幕上乱点，而日志里看不出来');
  assert.equal(r.silentFallback, false);
  assert.ok(r.why.some((w) => /没有独立桌面/.test(w)));
  assert.ok(r.why.some((w) => /会动用户的鼠标/.test(w)), '必须把"会动鼠标"说出来');
});

test('T1 没授权也不退；理由要区分"平台没有"和"没给权限"', () => {
  const noAuth = chooseTier({ needsGui: true, islandSupported: true, islandAuthorized: false });
  assert.equal(noAuth.tier, null);
  assert.ok(noAuth.why.some((w) => /没有被授权/.test(w)));

  const noPlatform = chooseTier({ needsGui: true, islandSupported: false, islandAuthorized: true });
  assert.ok(noPlatform.why.some((w) => /没有独立桌面/.test(w)));
});

test('什么都没有时说清是哪一层缺，而不是一句"用不了"', () => {
  const r = chooseTier({ needsGui: true });
  assert.equal(r.tier, null);
  assert.equal(r.why.length, 2);
  assert.ok(r.why.some((w) => /没有独立桌面/.test(w)));
  assert.ok(r.why.some((w) => /不可用/.test(w)));
});

test('三档都有中文解释（诊断/审计要看）', () => {
  for (const t of Object.values(TIER)) {
    assert.match(describeTier(t), /T\d/);
  }
  assert.match(describeTier('??'), /未选定/);
});

// ---------------------------------------------------------------- 启动
test('白名单里的应用可以用，命令行保留完整路径', () => {
  const r = planIslandLaunch({ exe: 'C:\\Windows\\System32\\notepad.exe' });
  assert.equal(r.ok, true);
  assert.equal(r.commandLine, '"C:\\Windows\\System32\\notepad.exe"');
});

test('★ 不在白名单里就拒（解释器、任意程序）', () => {
  for (const exe of ['cmd.exe', 'powershell.exe', 'C:\\tmp\\evil.exe', 'bash.exe']) {
    const r = planIslandLaunch({ exe });
    assert.equal(r.ok, false, `${exe} 不该被放行`);
    assert.equal(r.code, ISLAND_FAIL.appNotAllowed);
  }
});

test('★ 路径穿越拒掉（..\\..\\Windows\\notepad.exe 不行）', () => {
  const r = planIslandLaunch({ exe: '..\\..\\..\\Windows\\System32\\notepad.exe' });
  assert.equal(r.ok, false);
  assert.equal(r.code, ISLAND_FAIL.appNotAllowed);
});

test('★ 参数里出现 shell 元字符就拒 —— 这个工具不接命令串', () => {
  for (const args of [['&', 'calc.exe'], ['/c', 'dir', '|', 'more'], ['a;b'], ['$(whoami)'], ['x\ny']]) {
    const r = planIslandLaunch({ exe: 'notepad.exe', args });
    assert.equal(r.ok, false, `参数 ${JSON.stringify(args)} 不该被放行`);
    assert.equal(r.code, ISLAND_FAIL.shellMetachar);
  }
});

test('带空格的参数会被引号包住（不交给 shell，只做最朴素包裹）', () => {
  const r = planIslandLaunch({ exe: 'notepad.exe', args: ['C:\\my notes.txt'] });
  assert.equal(r.ok, true);
  assert.equal(r.commandLine, '"notepad.exe" "C:\\my notes.txt"');
});

test('参数里的引号被剥掉，避免把包裹打断', () => {
  const r = planIslandLaunch({ exe: 'notepad.exe', args: ['a"b c'] });
  assert.equal(r.ok, true);
  assert.ok(!r.commandLine.includes('a"b'), r.commandLine);
});

test('单个参数过长拒掉', () => {
  const r = planIslandLaunch({ exe: 'notepad.exe', args: ['x'.repeat(401)] });
  assert.equal(r.ok, false);
});

test('白名单本身是干净的小写 basename，且不含解释器', () => {
  assert.ok(ISLAND_APPS.length >= 5);
  for (const app of ISLAND_APPS) {
    assert.equal(app, app.toLowerCase(), `${app} 应该是小写`);
    assert.ok(app.endsWith('.exe'));
    assert.ok(!/^(cmd|powershell|pwsh|bash|sh|wscript|cscript)\.exe$/.test(app));
  }
  // 记事本/写字板必须在（探针与集成测试都靠它们）
  assert.ok(ISLAND_APPS.includes('notepad.exe'));
  assert.ok(ISLAND_APPS.includes('write.exe'));
});

// ---------------------------------------------------------------- 消息计划
test('一次点击 = 按下 + 抬起，lParam 是客户区坐标', () => {
  const r = planIslandMessages({ kind: 'click', point: { x: 100, y: 50 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ops.map((o) => o.msg), ['WM_LBUTTONDOWN', 'WM_LBUTTONUP']);
  assert.equal(r.ops[0].lParam, (50 << 16) | 100);
  assert.equal(r.ops[0].wParam, 1, '按下带 MK_LBUTTON');
  assert.equal(r.ops[1].wParam, 0);
});

test('★ 坐标越界就拒发（会点在窗口外面的东西上）', () => {
  const r = planIslandMessages({
    kind: 'click',
    point: { x: 900, y: 20 },
    clientSize: { width: 520, height: 320 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, ISLAND_FAIL.badPoint);
  assert.match(r.text, /窗口外/);
});

test('客户区尺寸不可信也拒（不拿 0x0 当合法）', () => {
  const r = planIslandMessages({ kind: 'click', point: { x: 1, y: 1 }, clientSize: { width: 0, height: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.code, ISLAND_FAIL.badPoint);
});

test('负坐标 / NaN 拒掉', () => {
  assert.equal(planIslandMessages({ kind: 'click', point: { x: -1, y: 5 } }).ok, false);
  assert.equal(planIslandMessages({ kind: 'click', point: { x: 'a', y: 5 } }).ok, false);
  assert.equal(planIslandMessages({ kind: 'click' }).ok, false);
  assert.equal(pointToLParam({ x: -3, y: 0 }), null);
  assert.equal(pointToLParam({ x: 1e9, y: 0 }), null);
});

test('打字按 UTF-16 码元拆（emoji 两个 WM_CHAR）', () => {
  const r = planIslandMessages({ kind: 'type', text: 'A😀' });
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 3, 'A + 两个代理项');
  assert.equal(r.ops[0].wParam, 'A'.charCodeAt(0));
  assert.equal(r.ops[0].msg, 'WM_CHAR');
});

test('setText 走 WM_SETTEXT（不依赖焦点）', () => {
  const r = planIslandMessages({ kind: 'setText', text: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].msg, 'WM_SETTEXT');
  assert.equal(r.ops[0].text, 'hello');
});

test('空文字与超长文字拒掉', () => {
  assert.equal(planIslandMessages({ kind: 'type', text: '' }).ok, false);
  const long = planIslandMessages({ kind: 'type', text: 'x'.repeat(MAX_TEXT_CHARS + 1) });
  assert.equal(long.ok, false);
  assert.equal(long.code, ISLAND_FAIL.badText);
  assert.equal(planIslandMessages({ kind: 'type', text: 'x'.repeat(MAX_TEXT_CHARS) }).ok, true);
});

test('不认识的操作拒掉', () => {
  const r = planIslandMessages({ kind: 'drag' });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- 截帧判定
test('正常画面通过', () => {
  const r = captureVerdict({ darkRatio: 0.079, width: 520, height: 320 });
  assert.equal(r.ok, true);
});

test('★ 全黑必须判失败（实测真的出现过 1.000）', () => {
  const r = captureVerdict({ darkRatio: 1.0, width: 628, height: 646 });
  assert.equal(r.ok, false);
  assert.equal(r.code, ISLAND_FAIL.blankFrame);
});

test('★ 窗口太小也判失败（还没画出来）', () => {
  const r = captureVerdict({ darkRatio: 0.1, width: 40, height: 30 });
  assert.equal(r.ok, false);
  assert.match(r.text, /还没画出来/);
});

test('深色主题不该被误判（纯文字终端有 95% 是黑的）', () => {
  const r = captureVerdict({ darkRatio: 0.95, width: 800, height: 600 });
  assert.equal(r.ok, true, '阈值 0.98：卡太严会把正常的深色界面判成失败');
});

test('算不出暗像素占比就不敢当成功', () => {
  const r = captureVerdict({ width: 400, height: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.code, ISLAND_FAIL.blankFrame);
});

// ---------------------------------------------------------------- 边界说明
test('T1 的"给不了"必须说清不是沙箱', () => {
  assert.ok(ISLAND_LIMITS.length >= 3);
  assert.ok(ISLAND_LIMITS.some((l) => /不是权限|同一份文件/.test(l)));
  assert.ok(ISLAND_LIMITS.some((l) => /macOS/.test(l)));
});

// ---------------------------------------------------------------- 结果
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
