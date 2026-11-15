/**
 * macOS 桌面输入空壳的测试。
 *   node tests/desktop-input-mac.mjs
 *
 * ## 这个文件守什么
 *
 * macOS 实现现在是空壳（`desktop-input-mac.js`）。空壳本身不值得测，
 * 但它**必须满足三条纪律**，否则会在 Mac 上变成"看起来通了、其实没通"：
 *
 * 1. **每个入口都明确说不支持**，而不是抛异常、也不是返回成功。
 *    返回成功 = 上层以为指令发出去了；抛异常 = 上层看到的是崩溃而不是
 *    "这个平台没做"。
 * 2. **平台状态表照实标 `supported: false`**。写成 true 就是骗人，
 *    而且是骗在"能不能动用户鼠标"这件事上。
 * 3. **整条链路（租约 → 装配 → 平台）走到空壳时是"明确拒绝"而不是"静默成功"**。
 *    这条最重要：租约能申请、动作能规划，但最后一步必须停在这里。
 *
 * ## 为什么值得为"没实现"写测试
 *
 * 因为最容易出的错不是"忘了实现"，而是**把空壳接错地方**：
 * 装配层如果误把 Windows 实现在 macOS 上也用上（`process.platform` 写错），
 * 或者空壳返回了 `{ok:true}` 让上层以为成功 —— 这两种都不会报错。
 * 本机 Windows 上踩过同类：远程控制工具让探针永远报"刚刚有人动"，
 * 而代码一路返回"正常"。**没有测试守着的"暂时没实现"，一定会变形。**
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mac-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const M = await import(src('desktop-input-mac.js'));
const S = await import(src('desktop-input-session.js'));
const P = await import(src('desktop-input.js'));
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

/** 六个入口都必须"明确说不支持"的统一形状。 */
const ENTRIES = [
  ['probeEnvironment', () => M.probeEnvironment()],
  ['lastInputAt', () => M.lastInputAt()],
  ['perform', () => M.perform({ plan: { action: 'move', point: { x: 1, y: 1 } } })],
  ['cursorPosition', () => M.cursorPosition()],
  ['sampleInputNoise', () => M.sampleInputNoise()],
  ['foregroundTitle', () => M.foregroundTitle()],
];

// ---------------------------------------------------------------- 空壳纪律
for (const [name, call] of ENTRIES) {
  test(`${name}()：明确返回 not_platform，不抛异常也不谎报成功`, () => {
    const r = call();
    assert.equal(r.ok, false, `${name} 不许返回成功`);
    assert.equal(r.code, INPUT_FAIL.notPlatform, `${name} 的 code 应当是 not_platform`);
    assert.equal(typeof r.text, 'string');
    assert.match(r.text, /macOS/, '文案要说清是平台没实现');
    assert.match(r.text, /MACOS-DESKTOP-INPUT/, '要指向那份待办文档，别让人到处找');
  });
}

test('★ isSupported() 返回 false（不是 undefined、不是 true）', () => {
  assert.equal(M.isSupported(), false);
});

test('★ describePlatform 照实标 supported:false，并指出待办文档', () => {
  const d = M.describePlatform();
  assert.equal(d.platform, 'darwin');
  assert.equal(d.supported, false, '★ 写成 true 就是骗在"能不能动用户鼠标"这件事上');
  assert.equal(d.verified, null, '没实机验过就不能有 verified');
  assert.deepEqual(d.actions, [], '一个动作都不该声称支持');
  assert.equal(d.todo, 'docs/MACOS-DESKTOP-INPUT.md');
});

test('纯逻辑层的 describePlatform("darwin") 与空壳说的一致', () => {
  const fromPure = P.describePlatform('darwin');
  const fromShell = M.describePlatform();
  assert.equal(fromPure.supported, fromShell.supported, '两处说法必须一致');
  assert.equal(fromPure.supported, false);
});

// ---------------------------------------------------------------- 接线纪律
test('★★ 装配层在 darwin 上会选到空壳（不是 Windows 实现）', () => {
  // 这条守的是最容易出错的地方：process.platform 判断写错，
  // macOS 上就会跑去调用 powershell —— 那不会报错，只会什么都不发生。
  const plat = S.desktopInputPlatform();
  for (const key of ['probeEnvironment', 'probeLastInput', 'perform', 'sampleNoise']) {
    assert.equal(typeof plat[key], 'function', `平台实现的 ${key} 必须是函数`);
  }
  // 在真 macOS 上跑这个测试时，选到的必须是 mac 空壳；在其它平台上跳过
  if (process.platform === 'darwin') {
    const r = plat.probeEnvironment();
    assert.equal(r.ok, false);
    assert.equal(r.code, INPUT_FAIL.notPlatform);
  }
});

test('★★ 整条链路走到空壳时是"明确拒绝"：租约能拿，动作被拦在平台层', () => {
  // 把平台换成 macOS 空壳，模拟一次完整调用
  S.setDesktopInputPlatform({
    probeEnvironment: M.probeEnvironment,
    probeLastInput: M.lastInputAt,
    perform: M.perform,
    sampleNoise: M.sampleInputNoise,
  });
  const session = S.desktopInputSession();
  const lease = session.acquireLease({ taskId: 'tr_mac_1', botId: 'bot_main', generation: 'gen-1' });
  assert.equal(lease.ok, true, '租约本身是平台无关的，能申请');
  const r = session.act({
    identity: { taskId: 'tr_mac_1', botId: 'bot_main', epoch: lease.epoch },
    input: { action: 'move', point: { x: 100, y: 100 } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_FAIL.notPlatform, '★ 停在平台层，不能往下走');
  assert.match(r.text, /macOS/);
  // 而且不能留下"已经注入过"的痕迹 —— 否则下一次接管检测会误判
  assert.equal(session.watchState.lastInjectionAt, 0, '没发出去就不许 noteInjection');
  // 审计里要有这一条拒绝记录
  const audit = session.recentAudit();
  assert.ok(audit.some((a) => a.kind === 'refuse' && a.code === INPUT_FAIL.notPlatform),
    '拒绝要进审计，否则排查时看不到"为什么没动"');
});

test('空壳不会污染接管检测状态（失败之后仍可正常重试别的平台实现）', () => {
  S.setDesktopInputPlatform({
    probeEnvironment: M.probeEnvironment,
    probeLastInput: M.lastInputAt,
    perform: M.perform,
    sampleNoise: M.sampleInputNoise,
  });
  const session = S.desktopInputSession();
  const lease = session.acquireLease({ taskId: 'tr_2', botId: 'b', generation: 'g' });
  session.act({
    identity: { taskId: 'tr_2', botId: 'b', epoch: lease.epoch },
    input: { action: 'move', point: { x: 1, y: 1 } },
  });
  assert.equal(session.watchState.consecutiveUserActive, 0, '平台没实现不该被算成"用户在动"');
  assert.equal(session.watchState.lastTakeoverAt, 0);
  // 租约还在（没被误吊销）—— 因为失败原因是"平台不支持"，不是"用户接管"
  assert.equal(session.lease.status, 'held');
});

// ---------------------------------------------------------------- 文档纪律
test('★ 待办文档存在，且写清了"先验什么"', () => {
  const doc = path.join(import.meta.dirname, '..', '..', 'docs', 'MACOS-DESKTOP-INPUT.md');
  assert.equal(fs.existsSync(doc), true, '空壳指向的文档必须真的存在（死链比没有更差）');
  const text = fs.readFileSync(doc, 'utf8');
  // 这份文档的用处就是"接手的人照着做"，所以必须有三样东西
  assert.match(text, /CGDisplayBounds/, '要写清楚坐标系怎么取');
  assert.match(text, /AXIsProcessTrusted/, '要写清辅助功能授权怎么判');
  assert.match(text, /验/, '要有验收清单');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
