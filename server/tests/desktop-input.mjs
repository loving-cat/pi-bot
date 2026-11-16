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
  describePlatform, classifyInputNoise,
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

// ============================================================ 纯逻辑：输入噪声
test('★ 输入噪声三分：安静 / 有东西在合成 / 有人真在动', () => {
  // 安静：采样间隔正常
  assert.equal(classifyInputNoise({ gaps: [3000, 3200, 3400, 3600] }).kind, 'quiet');
  // 合成输入：idle 一直很新，但光标一动不动（本机实测就是这个形态）
  assert.equal(
    classifyInputNoise({ gaps: [0, 47, 484, 0, 15], cursors: [{ x: 100, y: 100 }, { x: 100, y: 100 }] }).kind,
    'phantom',
  );
  // 真有人动：idle 很新且光标在变
  assert.equal(
    classifyInputNoise({ gaps: [0, 20, 15, 30], cursors: [{ x: 1, y: 2 }, { x: 90, y: 3 }] }).kind,
    'moving',
  );
  // 空输入不炸
  assert.equal(classifyInputNoise({ gaps: [] }).kind, 'quiet');
});

test('噪声判据用"多数"而不是"全部"（采样会被系统拖慢）', () => {
  // 全紧当然算噪声
  assert.equal(classifyInputNoise({ gaps: [0, 20, 15, 40, 5] }).noisy, true);
  // 5 个里 3 个紧、2 个被系统拖慢 → 仍然算噪声（every 会漏掉这一整类）
  assert.equal(classifyInputNoise({ gaps: [15, 172, 190, 625, 703] }).noisy, true);
  // 只有一个紧的，不算噪声
  assert.equal(classifyInputNoise({ gaps: [3000, 3100, 3200, 15] }).noisy, false);
  // 正好一半一半：不过半就不算（250 本身不算"紧"）
  assert.equal(classifyInputNoise({ gaps: [15, 250, 625, 703] }).noisy, false);
});

test('只看一次采样时无法判断光标是否在动，保守当作"没动"', () => {
  const r = classifyInputNoise({ gaps: [5], cursors: [{ x: 1, y: 1 }] });
  assert.equal(r.cursorStill, true);
  assert.equal(r.kind, 'phantom');
});

// ============================================================ 装配层：夹具
/**
 * 假平台：把"探到的东西"和"发出去的东西"都记下来，断言可以直接看。
 */
function makeFakePlatform(over = {}) {
  const calls = { env: 0, probe: 0, perform: [] };
  const fake = {
    env: { ok: true, screen: SCREEN, dpi: 120, session: true },
    // 默认模拟"用户已经离开 10 分钟"（离开门槛 90 秒）—— 大多数用例
    // 关心的是别的判断，不该被"他在看书"挡住
    lastInput: { ok: true, lastInputAt: T0 - 10 * 60_000, idleMs: 10 * 60_000 },
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
      // 下面四个默认"探不到"：老用例的行为因此完全不变。
      sampleNoise: () => fake.noise ?? { ok: false },
      cursorPosition: () => fake.cursor ?? { ok: false },
      foregroundTitle: () => (fake.foreground ? { ok: true, title: fake.foreground } : { ok: false }),
      trustPhantomInput: () => fake.trust === true,
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
  // 抖动抑制：第一次是"等一下"（userActivePending），第二次才真让开
  assert.equal(r1.ok, false);
  assert.equal(r1.code, REFUSE.userActivePending, '第一次抖动只停这一次，不吊销租约');
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

test('★ 时间戳对不上 → 只停这一次，不混淆成"用户在动"也不吊销租约', () => {
  const { session, identity, plat } = withLease();
  assert.equal(session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } }).ok, true);
  // 探针报的时间比我们那次注入还早、又不够旧：可能是时钟漂移/探针抖动
  plat.fake.lastInput = { ok: true, lastInputAt: T0 - 500, idleMs: 0 };
  const r = session.act({ identity, input: { action: 'move', point: { x: 20, y: 20 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, REFUSE.probeUncertain, '看不清要说看不清，别谎报成用户在动');
  assert.equal(session.lease.status, LEASE.held, '抖动阶段不该吊销租约');
  assert.equal(plat.calls.perform.length, 1, '看不清就不许发输入');
});

test('★ 连续命中不会被探针抖动偷走（userActive → 看不清 → userActive）', () => {
  const { session, identity, plat } = withLease();
  assert.equal(session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } }).ok, true);
  plat.fake.lastInput = { ok: true, lastInputAt: T0 + 4_000, idleMs: 0 };
  assert.equal(session.act({ identity, input: { action: 'move', point: { x: 20, y: 20 } } }).code, REFUSE.userActivePending);
  plat.fake.lastInput = { ok: true, lastInputAt: T0 - 500, idleMs: 0 };
  assert.equal(session.act({ identity, input: { action: 'move', point: { x: 20, y: 20 } } }).code, REFUSE.probeUncertain);
  // 第三次仍然算"连续第二次" —— 必须让开。
  // （用 4s 而不是 1.4s：1.4s 落在 1.5s 容差内，会被正确地判成"我们自己那次动作"）
  plat.fake.lastInput = { ok: true, lastInputAt: T0 + 4_000, idleMs: 0 };
  const third = session.act({ identity, input: { action: 'move', point: { x: 20, y: 20 } } });
  assert.equal(third.code, REFUSE.yielded);
  assert.equal(session.lease.status, LEASE.revoking);
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

// ============================================================ 合成输入源（§5.2 误报）
//
// 本机实测：远程控制软件会不停刷新"最后输入时间"但从不移动光标。
// 只看时间 → "用户一直在动" → 这个 bot 永远动不了鼠标。
// 判据必须加一条"光标动过没有"，而且**只有采样判定为合成输入源**才算数。

function withPhantom({ trust = false, cursorMoves = false } = {}) {
  const plat = makeFakePlatform({
    noise: { ok: true, kind: 'phantom', cursorStill: true, noisy: true, samples: [0, 47, 484, 0, 15] },
    cursor: { ok: true, x: 100, y: 100 },
    trust,
  });
  // 每一步"时间都很新" —— 就是那台远程控制软件的样子
  plat.fake.lastInput = { ok: true, lastInputAt: T0 - 5, idleMs: 5 };
  let n = 0;
  plat.deps.cursorPosition = () => {
    n += 1;
    const x = cursorMoves ? 100 + n * 10 : 100;
    return { ok: true, x, y: 100 };
  };
  return { plat, ...withLease(plat) };
}

test('★ 有东西在合成输入 + 用户开了"信任" → 照常干活，并记一笔 phantom', () => {
  const { session, identity, plat } = withPhantom({ trust: true });
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, true, r.text);
  assert.equal(plat.calls.perform.length, 1, '开了信任就该真的发出去');
  const kinds = session.recentAudit().map((a) => a.kind);
  assert.ok(kinds.includes('phantom'), '审计里要能看出"这次是按信任配置硬干的"');
});

test('★ 有东西在合成输入 + 没开信任 → 让开，并把原因说清楚', () => {
  const { session, identity, plat } = withPhantom({ trust: false });
  // 连点两次：watch 有 2 次抖动抑制（第一次只会"等一下"）
  const first = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(first.code, REFUSE.userActivePending, '第一次应当只是等一下，不是故障');
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, REFUSE.yielded);
  assert.equal(plat.calls.perform.length, 0, '没开信任就不能发');
  assert.match(r.text, /动过手|动过输入/, '文案要说明为什么让开');
});

test('★ 光标在动（真有人）时，"信任合成输入"也救不了它 —— 照样让开', () => {
  const { session, identity } = withPhantom({ trust: true, cursorMoves: true });
  session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false, '光标一直在动 = 真的有人在用');
  assert.equal(r.code, REFUSE.yielded);
});

test('★ 没采到噪声样本时，不许凭"光标没动"就放行', () => {
  // sampleNoise 不可用 → syntheticSource 必须为假，哪怕用户开了信任
  const plat = makeFakePlatform({
    cursor: { ok: true, x: 42, y: 42 },
    trust: true,
    lastInput: { ok: true, lastInputAt: T0 - 5, idleMs: 5 },
  });
  const { session, identity } = withLease(plat);
  session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false, '没有样本就只能保守让开');
  assert.equal(r.code, REFUSE.yielded);
  assert.equal(plat.calls.perform.length, 0);
});

test('租约申请时采样：phantom → inputEnvironment().syntheticSource = true', () => {
  const { session } = withPhantom({ trust: false });
  const env = session.inputEnvironment();
  assert.equal(env.syntheticSource, true);
  assert.equal(env.noise.kind, 'phantom');
});

// ============================================================ 重新校验目标窗口（§5.2）
test('★ expectWindow 对不上 → 拒绝，而且一次平台发送都没发生', () => {
  const plat = makeFakePlatform({ foreground: 'Chrome' });
  const { session, identity } = withLease(plat);
  const r = session.act({
    identity,
    input: { action: 'move', point: { x: 10, y: 10 }, expectWindow: 'Notepad' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, REFUSE.targetChanged);
  assert.match(r.text, /Chrome/);
  assert.equal(plat.calls.perform.length, 0, '目标不对就不许点');
});

test('expectWindow 对上了 → 正常发，且返回 targetKept', () => {
  const plat = makeFakePlatform({ foreground: 'Untitled - Notepad' });
  const { session, identity } = withLease(plat);
  const r = session.act({
    identity,
    input: { action: 'move', point: { x: 10, y: 10 }, expectWindow: 'notepad' },
  });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.targetKept, true);
  assert.equal(session.recentAudit().at(-1).expectWindow, 'notepad');
});

test('发完之后窗口变了 → targetKept=false（消息已发出，只能如实报）', () => {
  const plat = makeFakePlatform({ foreground: 'Notepad' });
  const { session, identity } = withLease(plat);
  plat.fake.perform = () => {
    plat.fake.foreground = 'Save As';
    return { ok: true, at: { x: 10, y: 10 }, foreground: 'Save As' };
  };
  const r = session.act({
    identity,
    input: { action: 'click', point: { x: 10, y: 10 }, expectWindow: 'Notepad' },
  });
  assert.equal(r.ok, true, '已经发出去了，不能报失败');
  assert.equal(r.targetKept, false, '但要老实说"目标已经变了"');
  assert.equal(session.recentAudit().at(-1).targetKept, false);
});

// ============================================================ 用户无感（§5.2）
//
// 需求原话："用户无感，bot 们在后面操作"。
// 所以同桌面输入只在**用户真的离开**之后才动手；他只是在看书（没碰鼠标）
// 时必须等 —— 而且"等"不是错误、不吊销租约、不弹任何东西。

test('★ 用户只是停手（没到离开门槛）→ 只等这一次，一次平台调用都不发生', () => {
  const plat = makeFakePlatform({
    lastInput: { ok: true, lastInputAt: T0 - 5_000, idleMs: 5_000 },
  });
  const { session, identity } = withLease(plat);
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, REFUSE.userActivePending, '"等一下"不是故障，用 pending 而不是 error');
  assert.match(r.text, /离开门槛/);
  assert.equal(plat.calls.perform.length, 0, '用户在看着，一下都不许动');
});

test('★ "等"不吊销租约：他离开之后立刻能用（不需要重新申请）', () => {
  const plat = makeFakePlatform({
    lastInput: { ok: true, lastInputAt: T0 - 5_000, idleMs: 5_000 },
  });
  const { session, identity } = withLease(plat);
  session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  // 用户走开了
  plat.fake.lastInput = { ok: true, lastInputAt: T0 - 10 * 60_000, idleMs: 10 * 60_000 };
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, true, '同一个 epoch 就该能用，不该因为"等过"就作废');
  assert.equal(plat.calls.perform.length, 1);
});

test('离开门槛可配 0 → 回到"安静就动手"（给"我就要看着它干"的用户）', () => {
  const plat = makeFakePlatform({
    lastInput: { ok: true, lastInputAt: T0 - 5_000, idleMs: 5_000 },
  });
  plat.deps.awayAfterMs = () => 0;
  const { session, identity } = withLease(plat);
  const r = session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(r.ok, true);
});

// ============================================================ 审计带授权引用（§5.5）
test('★ 审计里记"凭哪一条授权"（从 grant-context 取，动作要对得上、5 分钟过期）', async () => {
  const G = await import(new URL('../src/grant-context.js', import.meta.url));
  G.resetGrantContext();
  const plat = makeFakePlatform();
  const { session, identity } = withLease(plat);
  G.noteGrant({ botId: identity.botId, grantId: 'gr_desktop_1', action: 'desktop.input', now: T0 });
  session.act({ identity, input: { action: 'move', point: { x: 10, y: 10 } } });
  assert.equal(session.recentAudit().at(-1).grantId, 'gr_desktop_1');

  // 动作对不上就不记（不能把"点屏幕"记成"凭 push 的授权干的"）
  G.resetGrantContext();
  G.noteGrant({ botId: identity.botId, grantId: 'gr_git_1', action: 'git.push', now: T0 });
  session.act({ identity, input: { action: 'move', point: { x: 11, y: 10 } } });
  assert.equal(session.recentAudit().at(-1).grantId, null);

  // 过期也不算
  G.resetGrantContext();
  G.noteGrant({ botId: identity.botId, grantId: 'gr_old', action: 'desktop.input', now: T0 - 10 * 60_000 });
  session.act({ identity, input: { action: 'move', point: { x: 12, y: 10 } } });
  assert.equal(session.recentAudit().at(-1).grantId, null);
  G.resetGrantContext();
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
