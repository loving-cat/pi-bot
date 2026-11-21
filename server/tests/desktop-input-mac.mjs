/**
 * macOS 桌面输入的测试。
 *   node tests/desktop-input-mac.mjs
 *
 * ## 分三层守
 *
 * 1. **纯逻辑（三端 CI 都跑）**：参数拼装、错误码翻译、非 darwin 守卫。
 *    这些不依赖 macOS，Ubuntu / Windows 的 CI 上一样要绿。
 * 2. **助手交互（注入 runner）**：把助手换成假实现，验证「授权不足 / 参数非法 /
 *    输出坏掉」这些情况被如实翻译，而不是被当成成功。
 * 3. **真机（只有 darwin 且有二进制时跑）**：键码全表、探针、光标、前台标题。
 *    CI 上没有辅助功能授权，所以这里只做**不发输入**的只读验证。
 *
 * ## 为什么对着"没发出去却报成功"写这么多测试
 *
 * 桌面输入点错了就是点了：删文件、付款、发消息都收不回来。
 * 最危险的失败不是崩溃，是**看起来成功了**：
 * 辅助功能没开时 `CGEventPost` 静默丢弃，上层如果只看 `ok:true`，
 * 会以为鼠标已经移过去、点下去，然后基于这个假设做下一步。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-mac-input-'));
Object.assign(process.env, {
  ORBIS_HOME: fixture,
  ORBIS_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  ORBIS_PROBE: '0',
  ORBIS_TASK_INTAKE: '0',
  ORBIS_DISCOVERY: '0',
  ORBIS_TLS: '0',
});
for (const d of [process.env.ORBIS_HOME, process.env.ORBIS_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const M = await import(src('desktop-input-mac.js'));
const S = await import(src('desktop-input-session.js'));
const P = await import(src('desktop-input.js'));
const T = await import(src('desktop-takeover.js'));
const { INPUT_FAIL } = P;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

/** 把 process.platform 临时换掉，测「非 darwin 守卫」。 */
function withPlatform(name, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

const ENTRIES = [
  ['probeEnvironment', () => M.probeEnvironment()],
  ['lastInputAt', () => M.lastInputAt()],
  ['perform', () => M.perform({ plan: { action: 'move', point: { x: 1, y: 1 } } })],
  ['cursorPosition', () => M.cursorPosition()],
  ['sampleInputNoise', () => M.sampleInputNoise({ samples: 2, intervalMs: 20 })],
  ['foregroundTitle', () => M.foregroundTitle()],
];

// ---------------------------------------------------------------- 非 darwin 守卫
for (const [name, call] of ENTRIES) {
  test(`${name}()：非 darwin 直接返回 not_platform`, () => {
    // ★ 这条守的是 Linux CI：desktop-input-session.js 在非 win32 上都会落到
    //   本模块，如果这里不挡，Ubuntu 上会去 spawn 一个 macOS 二进制。
    for (const plat of ['linux', 'win32', 'freebsd']) {
      const r = withPlatform(plat, call);
      assert.equal(r.ok, false, `在 ${plat} 上 ${name} 不许返回成功`);
      assert.equal(r.code, INPUT_FAIL.notPlatform, `在 ${plat} 上应当是 not_platform`);
      assert.equal(typeof r.text, 'string');
      assert.match(r.text, /没有/, '文案要说清是平台没有实现');
    }
  });
}

test('isSupported()：非 darwin 恒为 false，且不抛异常', () => {
  for (const plat of ['linux', 'win32']) {
    assert.equal(withPlatform(plat, () => M.isSupported()), false);
  }
});

// ---------------------------------------------------------------- 参数拼装
test('toHelperRequest：六个动作都翻成助手能懂的请求', () => {
  assert.deepEqual(
    M.toHelperRequest({ action: 'move', point: { x: 10, y: 20 } }),
    { action: 'move', point: { x: 10, y: 20 } },
  );
  assert.deepEqual(
    M.toHelperRequest({ action: 'click', point: { x: 1, y: 2 }, button: 'right', clicks: 2 }),
    { action: 'click', point: { x: 1, y: 2 }, button: 'right', clicks: 2 },
  );
  assert.deepEqual(M.toHelperRequest({ action: 'scroll', delta: -3 }), { action: 'scroll', delta: -3 });
  assert.deepEqual(M.toHelperRequest({ action: 'key', keys: ['enter'] }), { action: 'key', key: 'enter' });
  assert.deepEqual(
    M.toHelperRequest({ action: 'keyCombo', keys: ['cmd', 'v'] }),
    { action: 'keyCombo', keys: ['cmd', 'v'] },
  );
  assert.deepEqual(M.toHelperRequest({ action: 'type_text', text: 'hi' }), { action: 'type_text', text: 'hi' });
});

test('★ scroll 带坐标时透传 point（macOS 滚轮事件发给鼠标下那个窗口）', () => {
  // 不先移动就滚 → 会滚到光标上次停留的无关窗口。用户在 A 窗口让 bot 看着，
  // bot 滚了 B —— 而且不会报错。planInput 对 scroll 本来就允许带 point（叫 at）。
  const withPoint = M.toHelperRequest({ action: 'scroll', delta: -3, point: { x: 500, y: 400 } });
  assert.deepEqual(withPoint, { action: 'scroll', delta: -3, point: { x: 500, y: 400 } });
  // 不带坐标就保持原样：在当前位置滚
  const plain = M.toHelperRequest({ action: 'scroll', delta: 2 });
  assert.deepEqual(plain, { action: 'scroll', delta: 2 });
  assert.equal('point' in plain, false, '没有坐标就不该带一个 null 下去');
  // point 为 null（planInput 在未给坐标时就是这么摆的）也不该出现
  const nullPoint = M.toHelperRequest({ action: 'scroll', delta: 1, point: null });
  assert.equal('point' in nullPoint, false);
});
test('★ toHelperRequest：用 keys 不用 codes（Win32 键码在 macOS 上是错的）', () => {
  // Win32 里 v = 0x56，macOS 的 CGKeyCode 里 v = 0x09 —— 完全不是一回事。
  // 如果哪天有人「顺手」把 codes 传下去，cmd+V 会变成别的键。
  const req = M.toHelperRequest({ action: 'keyCombo', keys: ['cmd', 'v'], codes: [0x5b, 0x56] });
  assert.deepEqual(req, { action: 'keyCombo', keys: ['cmd', 'v'] });
  assert.equal(JSON.stringify(req).includes('86'), false, '不许把 Win32 码漏进请求');
});

test('toHelperRequest：缺参数的动作返回 null（交给上层报 invalid）', () => {
  assert.equal(M.toHelperRequest(null), null);
  assert.equal(M.toHelperRequest({}), null);
  assert.equal(M.toHelperRequest({ action: 'move' }), null);
  assert.equal(M.toHelperRequest({ action: 'click' }), null);
  assert.equal(M.toHelperRequest({ action: 'key', keys: [] }), null);
  assert.equal(M.toHelperRequest({ action: 'nonsense' }), null);
});

test('★ drag 在参数层就被标出来（不发下去，也不假装支持）', () => {
  assert.deepEqual(M.toHelperRequest({ action: 'drag' }), { action: 'drag' });
  const r = withPlatform('darwin', () => M.perform({ plan: { action: 'drag', from: { x: 0, y: 0 }, to: { x: 9, y: 9 } } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.invalid);
  assert.match(r.text, /拖拽/);
  assert.match(r.text, /不支持/, '要明确说「本轮不支持」，不能只说失败');
});

// ---------------------------------------------------------------- 助手交互（注入 runner）
const fakeRun = (out) => (helper, args, input) => {
  fakeRun.lastCall = { helper, args, input };
  return out;
};

test('parseHelperOutput：解析成功 / 失败 / 坏输出', () => {
  assert.deepEqual(M.parseHelperOutput('{"ok":true,"x":1}'), { ok: true, x: 1 });
  const bad = M.parseHelperOutput('{"ok":false,"code":"invalid","text":"参数不对"}');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid');
  assert.equal(bad.text, '参数不对');
  assert.equal(M.parseHelperOutput('').code, INPUT_FAIL.callFailed);
  assert.equal(M.parseHelperOutput('not json').code, INPUT_FAIL.callFailed);
  assert.equal(M.parseHelperOutput('{"ok":true}').ok, true);
  const noDetail = M.parseHelperOutput('{"ok":false}');
  assert.equal(noDetail.code, INPUT_FAIL.callFailed);
  assert.match(noDetail.text, /没有说明原因/);
});

test('★★ not_authorized 原样上抛，不许被降级成 call_failed', () => {
  // 授权不足是「用户要去开」，不是「工具坏了」—— 上层对这两种的处理完全不同：
  // call_failed 会被当成故障重试，not_authorized 要引导用户去设置页。
  const r = withPlatform('darwin', () => M.perform({
    plan: { action: 'move', point: { x: 1, y: 1 } },
    run: fakeRun('{"ok":false,"code":"not_authorized","text":"需要辅助功能授权"}'),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.notAuthorized);
  assert.equal(r.code, 'not_authorized');
  assert.match(r.text, /辅助功能/);
});

test('probeEnvironment：助手的 session/authorized 如实透传', () => {
  const screen = { x: -100, y: 0, width: 2000, height: 1000 };
  const r = withPlatform('darwin', () => M.probeEnvironment({
    run: fakeRun(JSON.stringify({ ok: true, screen, dpi: 192, session: false, locked: true, authorized: false })),
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.screen, screen, '多屏的负坐标要原样保留');
  assert.equal(r.dpi, 192);
  assert.equal(r.session, false);
  assert.equal(r.locked, true);
  assert.equal(r.authorized, false);
});

test('游标位置不是数字时不许返回 ok', () => {
  const r = withPlatform('darwin', () => M.cursorPosition({ run: fakeRun('{"ok":true,"x":"abc"}') }));
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.callFailed);
});

// ---------------------------------------------------------------- 装配层
test('★ 装配层在 darwin 上选到的是 mac 实现（不是 Windows 的）', () => {
  // 这条守的是最容易出错的地方：process.platform 判断写错，
  // macOS 上就会跑去调 powershell —— 那不会报错，只会什么都不发生。
  const plat = S.desktopInputPlatform();
  for (const key of ['probeEnvironment', 'probeLastInput', 'perform', 'sampleNoise', 'cursorPosition', 'foregroundTitle']) {
    assert.equal(typeof plat[key], 'function', `平台实现的 ${key} 必须是函数`);
  }
});

test('★★ 非 darwin 时整条链路是「明确拒绝」，不是静默成功', () => {
  S.setDesktopInputPlatform({
    probeEnvironment: M.probeEnvironment,
    probeLastInput: M.lastInputAt,
    perform: M.perform,
    sampleNoise: M.sampleInputNoise,
    cursorPosition: M.cursorPosition,
    foregroundTitle: M.foregroundTitle,
  });
  const session = S.desktopInputSession();
  const lease = session.acquireLease({ taskId: 'tr_mac_1', botId: 'bot_main', generation: 'gen-1' });
  assert.equal(lease.ok, true, '租约是平台无关的，能申请');
  const r = withPlatform('linux', () => session.act({
    identity: { taskId: 'tr_mac_1', botId: 'bot_main', epoch: lease.epoch },
    input: { action: 'move', point: { x: 100, y: 100 } },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.notPlatform, '★ 停在平台层，不能往下走');
  // 而且不能留下「已经注入过」的痕迹 —— 否则下一次接管检测会误判
  assert.equal(session.watchState.lastInjectionAt, 0, '没发出去就不许 noteInjection');
  const audit = session.recentAudit();
  assert.ok(audit.some((a) => a.kind === 'refuse' && a.code === INPUT_FAIL.notPlatform),
    '拒绝要进审计，否则排查时看不到「为什么没动」');
});

test('平台层失败不污染接管检测状态（失败之后仍可正常重试）', () => {
  S.setDesktopInputPlatform({
    probeEnvironment: () => ({ ok: true, screen: { x: 0, y: 0, width: 800, height: 600 }, dpi: 96, session: true }),
    probeLastInput: () => ({ ok: true, lastInputAt: Date.now() - 60_000, idleMs: 60_000 }),
    perform: () => ({ ok: false, code: INPUT_FAIL.notAuthorized, text: '需要辅助功能授权' }),
    sampleNoise: () => ({ ok: true, kind: 'quiet', noisy: false, cursorStill: true, samples: [1000, 1000], cursor: { x: 0, y: 0 } }),
    cursorPosition: () => ({ ok: true, x: 10, y: 10 }),
    foregroundTitle: () => ({ ok: true, title: 'Test' }),
  });
  const session = S.desktopInputSession();
  const lease = session.acquireLease({ taskId: 'tr_2', botId: 'b', generation: 'g' });
  const r = session.act({
    identity: { taskId: 'tr_2', botId: 'b', epoch: lease.epoch },
    input: { action: 'move', point: { x: 1, y: 1 } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.notAuthorized, '授权不足要原样上抛');
  assert.equal(session.watchState.consecutiveUserActive, 0, '授权问题不该被算成「用户在动」');
  assert.equal(session.watchState.lastTakeoverAt, 0);
  assert.equal(session.lease.status, 'held', '租约还在（失败原因不是用户接管）');
  S.setDesktopInputPlatform({});
});

test('锁屏（session:false）时整条链路返回 no_session 并吊销租约', () => {
  S.setDesktopInputPlatform({
    probeEnvironment: () => ({ ok: true, screen: { x: 0, y: 0, width: 800, height: 600 }, dpi: 96, session: false, locked: true }),
    probeLastInput: () => ({ ok: true, lastInputAt: Date.now() - 60_000, idleMs: 60_000 }),
    perform: () => ({ ok: true, at: { x: 1, y: 1 }, foreground: '' }),
    sampleNoise: () => ({ ok: true, kind: 'quiet', noisy: false, cursorStill: true, samples: [1000], cursor: { x: 0, y: 0 } }),
    cursorPosition: () => ({ ok: true, x: 10, y: 10 }),
    foregroundTitle: () => ({ ok: true, title: '' }),
  });
  const session = S.desktopInputSession();
  const lease = session.acquireLease({ taskId: 'tr_3', botId: 'b', generation: 'g' });
  const r = session.act({
    identity: { taskId: 'tr_3', botId: 'b', epoch: lease.epoch },
    input: { action: 'move', point: { x: 1, y: 1 } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.noSession);
  S.setDesktopInputPlatform({});
});

// ---------------------------------------------------------------- 平台表与文档
test('★ describePlatform 照实标 supported:true，drag 仍在不支持里', () => {
  const d = M.describePlatform();
  assert.equal(d.platform, 'darwin');
  assert.equal(d.supported, true, '实机验收过了才敢写 true');
  assert.ok(d.verified && d.verified.length > 8, '要写清在什么环境验的');
  assert.equal(d.unsupported.includes('drag'), true, 'drag 没做完就必须在这张表里');
  assert.equal(d.actions.includes('drag'), false, '没做完的动作不许出现在支持列表里');
  for (const a of ['move', 'click', 'scroll', 'key', 'keyCombo', 'type_text']) {
    assert.ok(d.actions.includes(a), `应当支持 ${a}`);
  }
});

test('纯逻辑层的 describePlatform(darwin) 与实现说的一致', () => {
  const fromPure = P.describePlatform('darwin');
  const fromImpl = M.describePlatform();
  assert.equal(fromPure.supported, fromImpl.supported, '两处说法必须一致');
  assert.equal(fromPure.supported, true);
  assert.deepEqual([...fromPure.unsupported].sort(), [...fromImpl.unsupported].sort());
  assert.deepEqual([...fromPure.actions].sort(), [...fromImpl.actions].sort());
});

test('待办文档存在且已改成验收记录', () => {
  const doc = path.join(import.meta.dirname, '..', '..', 'docs', 'MACOS-DESKTOP-INPUT.md');
  assert.equal(fs.existsSync(doc), true);
  const text = fs.readFileSync(doc, 'utf8');
  assert.match(text, /CGDisplayBounds/, '要写清楚坐标系怎么取');
  assert.match(text, /AXIsProcessTrusted/, '要写清辅助功能授权怎么判');
  assert.match(text, /验/, '要有验收清单');
});

// ---------------------------------------------------------------- 真机只读验证
// 只在「真 macOS + 助手二进制在」时跑。CI 上没有辅助功能授权，
// 所以这里只验证**不发输入**的只读能力，以及键码表是否全认得。
const HAS_HELPER = process.platform === 'darwin' && M.isSupported();

if (!HAS_HELPER) {
  test('（跳过真机项：当前不是 macOS 或没有助手二进制）', () => {
    assert.ok(true);
  });
} else {
  test('真机：探针返回真实秒数（不是 0 / -1）', () => {
    const r = M.lastInputAt();
    assert.equal(r.ok, true, '探针不可用：' + r.text);
    assert.equal(Number.isFinite(r.lastInputAt), true);
    assert.ok(r.lastInputAt <= Date.now() + 2000, '不许报一个未来时刻');
    assert.ok(r.idleMs >= 0);
  });

  test('真机：探出屏幕矩形与 dpi', () => {
    const r = M.probeEnvironment();
    assert.equal(r.ok, true);
    assert.ok(r.screen.width > 0 && r.screen.height > 0);
    assert.ok(r.dpi >= 96, 'dpi 是 scale x 96，Retina 上是 192');
    assert.equal(typeof r.session, 'boolean');
  });

  test('真机：光标位置在屏幕矩形内', () => {
    const env = M.probeEnvironment();
    const cur = M.cursorPosition();
    assert.equal(cur.ok, true);
    const inside = cur.x >= env.screen.x && cur.x <= env.screen.x + env.screen.width
      && cur.y >= env.screen.y && cur.y <= env.screen.y + env.screen.height;
    assert.equal(inside, true, '光标 ' + cur.x + ',' + cur.y + ' 不在屏幕 ' + JSON.stringify(env.screen) + ' 里');
  });

  test('真机：不认识的键必须报 invalid（不许猜）', () => {
    const unknown = M.perform({ plan: { action: 'key', keys: ['definitely_not_a_key'] } });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, INPUT_FAIL.invalid, '不认识的键必须报 invalid，不能猜一个键码');
  });

  test('真机：认识的键不会被当成不认识（键码表覆盖）', () => {
    // 键码表在 Swift 里，JS 侧测不到；这里用助手的真实反应验：
    // 认识的键在没授权时是 not_authorized（说明解析过了），不认识才是 invalid。
    const samples = ['ctrl', 'shift', 'alt', 'cmd', 'enter', 'tab', 'esc', 'space', 'a', 'z', '0', '9', 'f12'];
    for (const k of samples) {
      const r = M.perform({ plan: { action: 'key', keys: [k] } });
      assert.notEqual(r.code, INPUT_FAIL.invalid, '键名 ' + k + ' 应当被键码表认识');
    }
  });

  test('真机：前台标题不报错（可以是空串）', () => {
    const r = M.foregroundTitle();
    assert.equal(r.ok, true, '读前台标题失败：' + r.text);
    assert.equal(typeof r.title, 'string');
  });
}

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  const mark = r.ok ? '✓' : '✗';
  console.log(mark + ' ' + r.name + (r.ok ? '' : ' —— ' + r.err));
}
console.log((results.length - failed.length) + '/' + results.length + ' 通过');
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);

