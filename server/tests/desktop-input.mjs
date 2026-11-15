/**
 * 桌面输入的测试（规格 §5.2 / §5.4 的输入层）。
 *   node tests/desktop-input.mjs
 *
 * 分两半：
 *
 * **前半：纯逻辑**（`desktop-input.js`）
 *   · 规划阶段该拦的都拦住：屏幕外坐标、不认识的键、拖拽、次数/文本上限
 *   · 坐标是物理像素，**不做任何缩放换算**
 *   · PS 转义必须把 ` $ " 都吃掉（否则等于把 shell 交给模型）
 *
 * **后半：装配层**（`desktop-input-session.js`）
 *   · 顺序：租约 → 持有者/epoch → 环境 → 接管 → 规划 → 发送 → noteInjection
 *   · 任何一步失败都不许调用平台发送
 *   · 探针不可用时**保守让开**（fail-closed），且租约要被吊销
 *   · 漏掉 `noteInjection` 会让下一次检测把自己的输入误判成用户接管 —— 有专门一条
 *
 * 这一层**不需要真机**：平台探针与发送都是注入的假实现。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dinput-'));
Object.assign(process.env, {
  PI_BOT_HOME: path.join(root, 'data'),
  PI_BOT_WORKSPACE: path.join(root, 'ws'),
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_PROBE: '0',
});
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const P = await import(new URL('../src/desktop-input.js', import.meta.url));
const S = await import(new URL('../src/desktop-input-session.js', import.meta.url));
const { LEASE, DENY } = await import(new URL('../src/desktop-lease.js', import.meta.url));
const { TAKEOVER } = await import(new URL('../src/desktop-takeover.js', import.meta.url));

const {
  INPUT_ACTIONS, INPUT_FAIL, MAX_CLICKS, MAX_SCROLL_NOTCHES, MAX_TEXT_CHARS, BUTTONS,
  planInput, vkCode, insideScreen, checkPoint, escapeForPsDoubleQuotes, describePlan,
  describePlatform,
} = P;
const { createDesktopInputSession, REFUSE } = S;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const SCREEN = { x: 0, y: 0, width: 2560, height: 1440 };
const SCREEN_LEFT = { x: -1920, y: 0, width: 4480, height: 1440 }; // 左外接屏
const T0 = 1_700_000_000_000;

// ============================================================ 纯逻辑：键码
test('认识常用键，不认识的不猜', () => {
  assert.equal(vkCode('ctrl'), 0x11);
  assert.equal(vkCode('CTRL'), 0x11, '键名大小写不敏感');
  assert.equal(vkCode('v'), 0x56);
  assert.equal(vkCode('V'), 0x56);
  assert.equal(vkCode('f5'), 0x74);
  assert.equal(vkCode('enter'), 0x0d);
  assert.equal(vkCode('5'), 0x35);
  // ★ 多字符但不在表里 → 0（不猜成"逐字打"）。猜错就是在用户文档里乱打字。
  assert.equal(vkCode('hello'), 0, '不认识的键名不许猜');
  assert.equal(vkCode(''), 0);
  assert.equal(vkCode(null), 0);
});

// ============================================================ 纯逻辑：坐标
test('屏幕判定：左闭右开，与 Win32 一致', () => {
  assert.equal(insideScreen({ point: { x: 0, y: 0 }, screen: SCREEN }), true);
  assert.equal(insideScreen({ point: { x: 2559, y: 1439 }, screen: SCREEN }), true);
  // 右下角那一像素在矩形外（宽 2560 → 有效 x 0..2559）
  assert.equal(insideScreen({ point: { x: 2560, y: 100 }, screen: SCREEN }), false);
  assert.equal(insideScreen({ point: { x: 100, y: 1440 }, screen: SCREEN }), false);
  assert.equal(insideScreen({ point: { x: -1, y: 100 }, screen: SCREEN }), false);
  assert.equal(insideScreen({ point: null, screen: SCREEN }), false);
});

test('★ 负坐标的屏幕是合法的（左外接屏），虚拟桌面不是从 0 开始', () => {
  // 本机这类布局很常见：主屏在 0,0，副屏在左边 → x 为负
  assert.equal(insideScreen({ point: { x: -1920, y: 0 }, screen: SCREEN_LEFT }), true);
  assert.equal(insideScreen({ point: { x: -1, y: 100 }, screen: SCREEN_LEFT }), true);
  assert.equal(insideScreen({ point: { x: 2559, y: 100 }, screen: SCREEN_LEFT }), true);
  assert.equal(insideScreen({ point: { x: -1921, y: 100 }, screen: SCREEN_LEFT }), false);
  assert.equal(insideScreen({ point: { x: 2560, y: 100 }, screen: SCREEN_LEFT }), false);
});

test('屏幕外坐标一律拒绝，**不静默夹到边缘**', () => {
  // 夹到边缘然后点下去 = 在错的元素上点。规格 §5.4「布局变化使旧坐标失效」。
  const r = checkPoint({ point: { x: 9999, y: 300 }, screen: SCREEN });
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.outOfScreen);
  assert.match(r.text, /布局/);
});

test('坐标取整但不再做任何缩放换算（物理像素进、物理像素出）', () => {
  const r = checkPoint({ point: { x: 100.7, y: 200.2 }, screen: SCREEN });
  assert.equal(r.ok, true);
  assert.deepEqual(r.point, { x: 101, y: 200 });
});

// ============================================================ 纯逻辑：规划
test('move / click 必须有合法坐标；没有屏幕基准一律拒', () => {
  assert.equal(planInput({ action: 'move', point: { x: 10, y: 10 }, screen: SCREEN }).ok, true);
  assert.equal(planInput({ action: 'move', point: null, screen: SCREEN }).ok, false);
  // ★ 没有屏幕基准时，就算坐标"看着没问题"也不许规划：那是闭眼点
  const noScreen = planInput({ action: 'move', point: { x: 10, y: 10 }, screen: null });
  assert.equal(noScreen.ok, false);
  assert.match(noScreen.text, /屏幕基准/);
});

test('连点次数有上下限（一次把界面点穿是真实事故）', () => {
  assert.equal(planInput({ action: 'click', point: { x: 1, y: 1 }, screen: SCREEN, clicks: 1 }).ok, true);
  assert.equal(planInput({ action: 'click', point: { x: 1, y: 1 }, screen: SCREEN, clicks: MAX_CLICKS }).ok, true);
  const tooMany = planInput({ action: 'click', point: { x: 1, y: 1 }, screen: SCREEN, clicks: MAX_CLICKS + 1 });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.text, /最多连点/);
  assert.equal(planInput({ action: 'click', point: { x: 1, y: 1 }, screen: SCREEN, clicks: 0 }).ok, false);
});

test('鼠标键名只认左/右/中', () => {
  for (const b of BUTTONS) {
    assert.equal(planInput({ action: 'click', point: { x: 5, y: 5 }, screen: SCREEN, button: b }).ok, true, b);
  }
  const bad = planInput({ action: 'click', point: { x: 5, y: 5 }, screen: SCREEN, button: 'primary' });
  assert.equal(bad.ok, false);
});

test('滚轮：要有 delta，且一次最多 10 格', () => {
  assert.equal(planInput({ action: 'scroll', screen: SCREEN, delta: 3 }).ok, true);
  assert.equal(planInput({ action: 'scroll', screen: SCREEN, delta: -3 }).ok, true);
  assert.equal(planInput({ action: 'scroll', screen: SCREEN, delta: 0 }).ok, false);
  const big = planInput({ action: 'scroll', screen: SCREEN, delta: MAX_SCROLL_NOTCHES + 1 });
  assert.equal(big.ok, false);
  assert.match(big.text, /最多滚/);
  // 带坐标滚：坐标也要在屏幕内
  assert.equal(planInput({ action: 'scroll', screen: SCREEN, delta: 1, point: { x: 50, y: 50 } }).ok, true);
  assert.equal(planInput({ action: 'scroll', screen: SCREEN, delta: 1, point: { x: 99999, y: 50 } }).ok, false);
});

test('★ 拖拽明确拒绝（半截实现会留下"鼠标按着不放"）', () => {
  const r = planInput({ action: 'drag', point: { x: 10, y: 10 }, screen: SCREEN });
  assert.equal(r.ok, false);
  assert.match(r.text, /拖拽/);
  assert.match(r.text, /中断|租约/, '要说清为什么不支持');
  assert.equal(planInput({ action: 'drag_drop', point: { x: 10, y: 10 }, screen: SCREEN }).ok, false);
  assert.equal(INPUT_ACTIONS.includes('drag'), false);
});

test('组合键：最多 4 个，且每个都必须认识', () => {
  assert.equal(planInput({ action: 'keyCombo', screen: SCREEN, keyCombo: ['ctrl', 'v'] }).ok, true);
  assert.equal(planInput({ action: 'keyCombo', screen: SCREEN, keyCombo: ['ctrl', 'shift', 'alt', 'f4'] }).ok, true);
  assert.equal(planInput({ action: 'keyCombo', screen: SCREEN, keyCombo: ['ctrl', 'shift', 'alt', 'win', 'a'] }).ok, false);
  const unknown = planInput({ action: 'keyCombo', screen: SCREEN, keyCombo: ['ctrl', 'pagebreak'] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /不认识的键/);
  assert.match(unknown.text, /type_text/, '要告诉调用方改用 type_text');
  assert.equal(planInput({ action: 'keyCombo', screen: SCREEN, keyCombo: [] }).ok, false);
});

test('输入文本：不能空，不能超长', () => {
  assert.equal(planInput({ action: 'type_text', screen: SCREEN, text: '你好' }).ok, true);
  assert.equal(planInput({ action: 'type_text', screen: SCREEN, text: '' }).ok, false);
  const long = planInput({ action: 'type_text', screen: SCREEN, text: 'x'.repeat(MAX_TEXT_CHARS + 1) });
  assert.equal(long.ok, false);
  assert.match(long.text, /最多输入/);
});

test('不认识的动作要列出支持的动作（别让模型靠猜）', () => {
  const r = planInput({ action: 'teleport', screen: SCREEN });
  assert.equal(r.ok, false);
  for (const a of INPUT_ACTIONS) assert.ok(r.text.includes(a), `报错里该提到 ${a}`);
});

// ============================================================ 纯逻辑：转义
test('★ PS 双引号字符串转义：反引号 / $ / 双引号都要吃掉', () => {
  // 不转义 = 执行模型写的东西 = 把 shell 交出去
  assert.equal(escapeForPsDoubleQuotes('a`b'), 'a``b');
  assert.equal(escapeForPsDoubleQuotes('$HOME'), '`$HOME');
  assert.equal(escapeForPsDoubleQuotes('say "hi"'), 'say `"hi`"');
  // 反引号必须先换（否则后面换出来的反引号又被当转义符）
  assert.equal(escapeForPsDoubleQuotes('`'), '``');
  assert.equal(escapeForPsDoubleQuotes('$(calc.exe)'), '`$(calc.exe)');
  // 中文与 emoji 原样保留
  assert.equal(escapeForPsDoubleQuotes('中文✅'), '中文✅');
});

// ============================================================ 纯逻辑：摘要
test('动作摘要进审计，不含输入文字原文', () => {
  const plan = planInput({ action: 'type_text', screen: SCREEN, text: '这是一段秘密的密码 abc123' }).plan;
  const d = describePlan(plan);
  assert.match(d, /输入文字/);
  assert.match(d, /字/);
  assert.equal(d.includes('秘密'), false, '摘要里不许出现原文');
  assert.equal(d.includes('abc123'), false);
});

test('平台状态表不吹牛：macOS 明确标"未实现"', () => {
  const win = describePlatform('win32');
  assert.equal(win.supported, true);
  assert.ok(win.unsupported.includes('drag'));
  const mac = describePlatform('darwin');
  assert.equal(mac.supported, false, 'macOS 还没实现，不许写成 supported');
  assert.ok(mac.probe.includes('未实现'));
});

// ============================================================ 装配层：夹具
/**
 * 假平台：把"探到的东西"和"发出去的东西"都记下来，断言可以直接看。
 */
function makeFakePlatform(over = {}) {
  const calls = { env: 0, probe: 0, perform: [] };
  const fake = {
    env: { ok: true, screen: SCREEN, dpi: 120, session: true },
    lastInput: { ok: true, lastInputAt: T0 - 60_000, idleMs: 60_000 },
    perform: () => ({ ok: true, at: { x: 10, y: 10 }, foreground: 'Notepad' }),
    ...over,
  };
  return {
    calls,
    deps: {
      now: () => T0,
      probeEnvironment: () => { calls.env += 1; return fake.env; },
      probeLastInput: () => { calls.probe += 1; return fake.lastInput; },
      perform: (plan) => { calls.perform.push(plan); return fake.perform(plan); },
    },
    fake,
  };
}

/** 建会话并拿到租约，返回 `{session, identity, plat}`。 */
function withLease(plat = makeFakePlatform()) {
  const session = createDesktopInputSession(plat.deps);
  const r = session.acquireLease({ taskId: 'tr_1', botId: 'bot_main', generation: 'gen-1' });
  assert.equal(r.ok, true);
  return { session, identity: { taskId: 'tr_1', botId: 'bot_main', epoch: r.epoch }, plat };
}

// ============================================================ 装配层：正常路径
test('★ 没有租约时明确说"先申请"，而不是含糊的"被拒绝"', () => {
  const plat = makeFakePlatform();
  const session = createDesktopInputSession(plat.deps);
  const r = session.act({ identity: { taskId: 'tr_1', botId: 'b', epoch: 1 }, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, REFUSE.noLease);
  assert.match(r.text, /先申请/);
  assert.equal(plat.calls.perform.length, 0, '没租约时**一次平台调用都不该发生**');
});

test('拿到租约后能正常发一次动作，并且记了审计', () => {
  const { session, identity, plat } = withLease();
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, true);
  assert.equal(plat.calls.perform.length, 1);
  assert.equal(plat.calls.perform[0].action, 'move');
  const audit = session.recentAudit();
  const last = audit.at(-1);
  assert.equal(last.kind, 'inject');
  assert.equal(last.action, 'move');
  assert.equal(last.foreground, 'Notepad');
});

test('★ 每次成功注入都要 noteInjection，否则下一次会把自己的输入当成用户接管', () => {
  const { session, identity, plat } = withLease();
  // 第一次：探针报"一分钟前有人动过"，安静，能干活
  assert.equal(session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } }).ok, true);
  const afterFirst = session.watchState.lastInjectionAt;
  assert.equal(afterFirst, T0, '注入之后必须记下注入时刻');
  // 第二次：平台探针现在报"我们的注入之后 0.2s 有人动过" → 那是我们自己
  plat.fake.lastInput = { ok: true, lastInputAt: T0 + 200, idleMs: 0 };
  const second = session.act({ identity, input: { action: 'move', point: { x: 20, y: 20 } } });
  assert.equal(second.ok, true, '自己刚注入的动作不该被当成用户接管');
  assert.equal(plat.calls.perform.length, 2);
});

test('epoch 不对 → stale_epoch，且不调平台', () => {
  const { session, identity, plat } = withLease();
  const r = session.act({ identity: { ...identity, epoch: identity.epoch - 1 }, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, DENY.staleEpoch);
  assert.equal(plat.calls.perform.length, 0);
});

test('换个 bot 来用别人的租约 → not_holder', () => {
  const { session, identity, plat } = withLease();
  const r = session.act({ identity: { ...identity, botId: 'bot_other' }, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, DENY.notHolder);
  assert.equal(plat.calls.perform.length, 0);
});

// ============================================================ 装配层：环境
test('DPI 感知拿不到 → 不发（坐标基准不可信）', () => {
  const plat = makeFakePlatform({ env: { ok: false, code: INPUT_FAIL.notAware, text: '声明不了 DPI 感知' } });
  const { session, identity } = withLease(plat);
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.notAware);
  assert.equal(plat.calls.perform.length, 0);
});

test('★ 锁屏/断开会话：拒绝并**自动吊销租约**（恢复后重新观察）', () => {
  const plat = makeFakePlatform({ env: { ok: true, screen: SCREEN, dpi: 120, session: false } });
  const { session, identity } = withLease(plat);
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, REFUSE.noSession);
  assert.equal(plat.calls.perform.length, 0);
  assert.equal(session.lease.status, LEASE.revoking, '没会话就该吊销，不能留着一条僵住的租约');
  assert.match(r.text, /释放租约/);
});

test('★ 探针不可用 → 保守交还用户，租约被吊销（fail-closed）', () => {
  const plat = makeFakePlatform({ lastInput: { ok: false, code: INPUT_FAIL.probeUnavailable, text: '探针挂了' } });
  const { session, identity } = withLease(plat);
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, REFUSE.yielded);
  assert.equal(plat.calls.perform.length, 0, '探针不可用时绝不许发输入');
  assert.equal(session.lease.status, LEASE.revoking);
});

test('★ 用户真的动过手 → 让开并吊销，文案要说清是"交还"不是"出错"', () => {
  const { session, identity, plat } = withLease();
  // 先注入一次，建立"我们动过"的基准
  assert.equal(session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } }).ok, true);
  // 用户在我们注入之后 5s 动了鼠标 —— 远超容差（1.5s），不可能是我们那次动作
  plat.fake.lastInput = { ok: true, lastInputAt: T0 + 5_000, idleMs: 0 };
  const r1 = session.act({ identity, input: { action: 'move', point: { x: 30, y: 30 } } });
  // 抖动抑制：第一次是"等一下"，第二次才真让开
  assert.equal(r1.ok, false);
  assert.equal(plat.calls.perform.length, 1, '判成用户在场就不该再发');
  const r2 = session.act({ identity, input: { action: 'move', point: { x: 30, y: 30 } } });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, REFUSE.yielded);
  assert.match(r2.text, /交还/);
  assert.equal(session.lease.status, LEASE.revoking);
  assert.equal(plat.calls.perform.length, 1);
});

test('★ 容差内的输入时间算我们自己的（不然长动作永远跑不完）', () => {
  const { session, identity, plat } = withLease();
  assert.equal(session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } }).ok, true);
  // 我方注入 1.4s 之后平台才记账 —— 在容差（1.5s）内，应当当成自己那次动作
  plat.fake.lastInput = { ok: true, lastInputAt: T0 + 1_400, idleMs: 0 };
  const r = session.act({ identity, input: { action: 'move', point: { x: 20, y: 20 } } });
  assert.equal(r.ok, true, '容差内不该判成用户接管');
  assert.equal(plat.calls.perform.length, 2);
});

// ============================================================ 装配层：规划层拦截
test('屏幕外坐标在**平台调用之前**就被拦掉', () => {
  const { session, identity, plat } = withLease();
  const r = session.act({ identity, input: { action: 'click', point: { x: 99_999, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.outOfScreen);
  assert.equal(plat.calls.perform.length, 0, '规划层拦下的事不该走到平台层');
});

test('拖拽在装配层也走不通（不是只有纯函数拦）', () => {
  const { session, identity, plat } = withLease();
  const r = session.act({ identity, input: { action: 'drag', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.match(r.text, /拖拽/);
  assert.equal(plat.calls.perform.length, 0);
});

test('平台发送失败 → 原样上抛原因，且不记成"注入成功"', () => {
  const plat = makeFakePlatform({
    perform: () => ({ ok: false, code: INPUT_FAIL.callFailed, text: '光标没到位' }),
  });
  const { session, identity } = withLease(plat);
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.match(r.text, /光标没到位/);
  const audit = session.recentAudit();
  assert.equal(audit.at(-1).kind, 'refuse', '失败的动作不能记成 inject');
});

// ============================================================ 装配层：租约生命周期
test('释放租约后就不能再发（不该留一条隐式长租约）', () => {
  const { session, identity, plat } = withLease();
  session.releaseLease({ taskId: identity.taskId, reason: '任务结束' });
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, REFUSE.noLease);
  assert.equal(plat.calls.perform.length, 0);
});

test('心跳续期要带 epoch；过期后不能再发', () => {
  let clock = T0;
  const plat = makeFakePlatform();
  const session = createDesktopInputSession({ ...plat.deps, now: () => clock });
  const got = session.acquireLease({ taskId: 'tr_1', botId: 'b', generation: 'gen-1', ttlMs: 1_000 });
  assert.equal(got.ok, true);
  // 到期之后
  clock = T0 + 5_000;
  const r = session.act({ identity: { taskId: 'tr_1', botId: 'b', epoch: got.epoch }, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, DENY.expired);
  assert.equal(plat.calls.perform.length, 0);
});

test('审计只留最近 50 条（不让内存无限长）', () => {
  const { session, identity } = withLease();
  for (let i = 0; i < 60; i += 1) {
    session.act({ identity, input: { action: 'move', point: { x: 10 + i, y: 10 } } });
  }
  assert.equal(session.recentAudit().length, 50);
});

test('describe() 同时给出租约与接管两句话（界面/日志能一眼看懂）', () => {
  const { session } = withLease();
  const d = session.describe();
  assert.match(d, /桌面/);
  assert.match(d, /接管检测/);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
