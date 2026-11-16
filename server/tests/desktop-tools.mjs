/**
 * 桌面输入工具的接线测试（`desktop_lease` / `desktop_input`）。
 *   node tests/desktop-tools.mjs
 *
 * ## 这个文件守什么
 *
 * 上面两个模块的测试（`desktop-input.mjs`）守的是**判定**。这里守的是
 * **接线**：工具层有没有把「判定结果」翻译对。
 *
 * 具体三条：
 *
 * 1. 没租约时，模型看到的是"先申请一次"而不是"被拒绝"。文案错了，
 *    模型会去重试而不是去申请租约 —— 那是这一层最容易犯的错。
 * 2. 用户接管 / 锁屏 / 没租约这几种是**正常停下**（`isError: false`）。
 *    报成 error 会让模型以为工具坏了，然后反复重试 —— 而这几种最不该重试。
 * 3. 真正的参数错误（屏幕外、不认识的键）必须是 error，别混进"正常停下"。
 *
 * 平台调用全部用假的：这里不需要真机，也不会在 CI 里动鼠标。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dtools-'));
Object.assign(process.env, {
  PI_BOT_HOME: path.join(root, 'data'),
  PI_BOT_WORKSPACE: path.join(root, 'ws'),
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const { store } = await import(new URL('../src/store.js', import.meta.url));
const { buildCommonTools } = await import(new URL('../src/tools.js', import.meta.url));
const S = await import(new URL('../src/desktop-input-session.js', import.meta.url));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

/** 假的平台：所有调用都记账，不发任何真实输入。 */
function installFakePlatform(over = {}) {
  const calls = { perform: [] };
  const fake = {
    env: { ok: true, screen: { x: 0, y: 0, width: 2560, height: 1440 }, dpi: 120, session: true },
    // 默认"用户已经离开 10 分钟"（离开门槛 90 秒）：大多数用例不该被
    // "他还在看书"挡住；要测这个门槛的用例自己覆盖它
    lastInput: { ok: true, lastInputAt: Date.now() - 10 * 60_000, idleMs: 10 * 60_000 },
    noise: { ok: true, kind: 'quiet', phantom: false, noisy: false, cursorStill: true, samples: [3000, 3100], cursor: { x: 1, y: 1 } },
    perform: () => ({ ok: true, at: { x: 400, y: 300 }, foreground: 'Notepad' }),
    ...over,
  };
  S.setDesktopInputPlatform({
    probeEnvironment: () => fake.env,
    probeLastInput: () => fake.lastInput,
    perform: (plan) => { calls.perform.push(plan); return fake.perform(plan); },
    sampleNoise: () => fake.noise,
  });
  return { calls, fake };
}

const main = store.createBot({ name: '主控', persona: 'x' });
store.updateBot(main.id, { role: 'main' });
const member = store.createBot({ name: '成员', persona: 'x' });

/** 每个用例换一份新会话，避免租约状态互相污染。 */
function freshTools(isMain = true) {
  S.resetDesktopInputSession();
  const tools = buildCommonTools({ runner: {}, roomId: 'r-desktop', botId: isMain ? main.id : member.id, isMain });
  return {
    lease: tools.find((t) => t.name === 'desktop_lease'),
    input: tools.find((t) => t.name === 'desktop_input'),
    names: tools.map((t) => t.name),
  };
}

await test('★ 成员根本没有桌面工具（规格 §5.3：普通桌面只给主 Bot）', () => {
  const { names } = freshTools(false);
  assert.equal(names.includes('desktop_lease'), false);
  assert.equal(names.includes('desktop_input'), false);
  assert.equal(names.includes('desktop_observe'), false);
});

await test('主 Bot 拿得到两个桌面输入工具', () => {
  const { names } = freshTools(true);
  assert.equal(names.includes('desktop_lease'), true);
  assert.equal(names.includes('desktop_input'), true);
});

await test('★ 没租约时文案是"先申请"，并且不算错误（isError 缺失）', async () => {
  installFakePlatform();
  const { input } = freshTools();
  const r = await input.execute('c1', { epoch: 1, action: 'move', x: 400, y: 300 });
  const text = r.content[0].text;
  assert.match(text, /先申请/);
  assert.match(text, /no_lease/);
  assert.notEqual(r.isError, true, '没租约是正常停下，不是工具故障');
  assert.equal(r.details.stopped, true);
});

await test('租约流转：acquire → 用起来 → release 后不能再发', async () => {
  const plat = installFakePlatform();
  const { lease, input } = freshTools();
  const a = await lease.execute('c1', { action: 'acquire' });
  assert.match(a.content[0].text, /epoch 1/);
  const epoch = a.details.epoch;
  const m = await input.execute('c2', { epoch, action: 'move', x: 400, y: 300 });
  assert.notEqual(m.isError, true, `移动失败：${m.content[0].text}`);
  assert.equal(plat.calls.perform.length, 1);
  assert.match(m.content[0].text, /移动鼠标/);
  assert.match(m.content[0].text, /Notepad/, '要告诉模型动的是哪个窗口');
  const rel = await lease.execute('c3', { action: 'release' });
  assert.match(rel.content[0].text, /已释放/);
  const after = await input.execute('c4', { epoch, action: 'move', x: 400, y: 300 });
  assert.equal(after.details.code, 'no_lease');
  assert.equal(plat.calls.perform.length, 1, '释放之后不该再发');
});

await test('★ 旧 epoch 是 error（那是真错：拿着一张过期的票）', async () => {
  const plat = installFakePlatform();
  const { lease, input } = freshTools();
  const a = await lease.execute('c1', { action: 'acquire' });
  const r = await input.execute('c2', { epoch: a.details.epoch + 3, action: 'move', x: 400, y: 300 });
  assert.equal(r.isError, true);
  assert.equal(r.details.code, 'stale_epoch');
  assert.equal(plat.calls.perform.length, 0);
});

await test('★ 用户在动 / 锁屏 → 不是 error（模型该停下而不是重试）', async () => {
  const plat = installFakePlatform();
  const { lease, input } = freshTools();
  const a = await lease.execute('c1', { action: 'acquire' });
  // 用户刚动过：平台报的输入时间比我们"上次注入"晚很多
  plat.fake.lastInput = { ok: true, lastInputAt: Date.now() + 5_000, idleMs: 0 };
  const r1 = await input.execute('c2', { epoch: a.details.epoch, action: 'move', x: 400, y: 300 });
  assert.notEqual(r1.isError, true, '用户在动不是工具故障');
  assert.equal(r1.details.stopped, true);
  // 锁屏
  S.resetDesktopInputSession();
  const t2 = freshTools();
  const b = await t2.lease.execute('c3', { action: 'acquire' });
  plat.fake.env = { ok: true, screen: { x: 0, y: 0, width: 2560, height: 1440 }, dpi: 120, session: false };
  const r2 = await t2.input.execute('c4', { epoch: b.details.epoch, action: 'move', x: 400, y: 300 });
  assert.notEqual(r2.isError, true, '没会话不是工具故障');
  assert.equal(r2.details.code, 'no_session');
  assert.match(r2.content[0].text, /交还|锁屏|会话/);
});

await test('屏幕外坐标是 error（那是调用方算错了，不是"正常停下"）', async () => {
  installFakePlatform();
  const { lease, input } = freshTools();
  const a = await lease.execute('c1', { action: 'acquire' });
  const r = await input.execute('c2', { epoch: a.details.epoch, action: 'click', x: 99_999, y: 10 });
  assert.equal(r.isError, true);
  assert.equal(r.details.code, 'out_of_screen');
});

await test('status 会说清租约状态；环境有合成输入时补一句诊断', async () => {
  const plat = installFakePlatform();
  const { lease } = freshTools();
  const clean = await lease.execute('c1', { action: 'status' });
  assert.match(clean.content[0].text, /桌面|空闲/);
  assert.equal(clean.content[0].text.includes('合成'), false, '环境干净时不该提合成输入');
  // 模拟"有东西一直在合成输入"的机器
  S.resetDesktopInputSession();
  plat.fake.noise = {
    ok: true, kind: 'phantom', phantom: true, noisy: true, cursorStill: true,
    samples: [0, 47, 484, 0, 15], cursor: { x: 100, y: 100 },
  };
  const t2 = freshTools();
  const noisy = await t2.lease.execute('c2', { action: 'status' });
  assert.match(noisy.content[0].text, /合成/);
  assert.match(noisy.content[0].text, /不是用户碰了鼠标/, '要把误判说清楚，否则用户会以为是自己碰的');
  assert.equal(noisy.details.inputNoise.phantom, true);
});

await test('有人在真的用远程控制动鼠标 → 说成"有人在动"，不说成合成输入', async () => {
  const plat = installFakePlatform();
  plat.fake.noise = {
    ok: true, kind: 'moving', phantom: false, noisy: true, cursorStill: false,
    samples: [0, 20, 15], cursor: { x: 5, y: 5 },
  };
  const { lease } = freshTools();
  const r = await lease.execute('c1', { action: 'status' });
  assert.match(r.content[0].text, /动这台机器的鼠标/);
  assert.match(r.content[0].text, /远程控制|自动化/);
  assert.equal(r.content[0].text.includes('合成'), false);
});

await test('release 之后 status 回到空闲（不会留一条隐式长租约）', async () => {
  installFakePlatform();
  const { lease } = freshTools();
  await lease.execute('c1', { action: 'acquire' });
  await lease.execute('c2', { action: 'release' });
  const r = await lease.execute('c3', { action: 'status' });
  assert.match(r.content[0].text, /空闲/);
  assert.equal(r.details.lease, 'idle');
});

clearTimeout(store.saveTimer);
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
