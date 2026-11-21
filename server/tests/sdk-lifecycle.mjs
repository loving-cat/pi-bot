/**
 * SDK 生命周期（路线图 §4 T2.4）：`run.settled` / `dispose()` 幂等 / 初始化中途失败回收。
 *   node tests/sdk-lifecycle.mjs
 *
 * ## 这个文件守什么
 *
 * 1. **`run.settled` 只在房间真的安静下来时发一次** —— 对齐 pi 的 `agent_settled`。
 *    一轮结束后 turn-executor 还会 setTimeout(0) 去 drain 排队请求与主控汇总，
 *    同步发会在"下一轮马上开始"时误报"不会再自动继续了"。所以有 150ms 去抖，
 *    定时器到点要**重新判一次**安静。
 * 2. **`dispose()` 幂等且不抛**：第二次返回 `{already: true}`；某一步拆失败也要把
 *    剩下的拆完（失败明细在返回值里），否则留下半个 runtime。
 * 3. **初始化中途失败要把已起来的句柄收回去**：子进程里构造一个会失败的 runtime，
 *    catch 之后进程必须**自己**退出（没有泄漏的定时器/监听）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeMockModelRuntimeFactory, makeMockSessionApi } from './helpers/sdk-mock.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-sdk-lifecycle-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.ORBIS_HOME = root;
process.env.ORBIS_WORKSPACE = path.join(root, 'workspace');
process.env.ORBIS_PROBE = '0';
process.env.ORBIS_LESSON_REFLECT = '0';
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const sdk = await import('../src/sdk/index.js');
const { RUN_SETTLED_DEBOUNCE_MS, isRoomQuiet, pendingSettleTimerCount } = await import(
  '../src/runner/run-settled.js',
);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeoutMs = 3000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

function makeDirs(tag) {
  const base = path.join(root, tag);
  const dataDir = path.join(base, 'data');
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { base, dataDir, workspace };
}

async function makeRuntime(tag, options = {}) {
  const dirs = makeDirs(tag);
  const state = { behavior: 'reply' };
  const runtime = await sdk.createOrbisRuntime({
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    userName: 'Tester',
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(state, path.join(dirs.base, 'agent')),
    ...options,
  });
  return { runtime, state, dirs };
}

const { runtime: rt, state: rtState } = await makeRuntime('main');
const mainBot = rt.store.mainBot();
const dm = rt.store.ensureDm(mainBot.id);
const settled = [];
const off = rt.onEvent((ev) => {
  if (ev?.t === 'run.settled') settled.push(ev);
});

await test('run.settled：一轮结束后发且只发一次，带 roomId / botId / ok / generation', async () => {
  await rt.askMain('跑一轮看看');
  const ev = await waitFor(() => settled.find((e) => e.roomId === dm.id), { label: 'run.settled' });
  assert.equal(ev.t, 'run.settled');
  assert.equal(ev.botId, mainBot.id);
  assert.equal(ev.ok, true);
  assert.equal(ev.reason, 'turn_done');
  assert.equal(typeof ev.generation, 'string');
  assert.ok(ev.generation.startsWith('sdk-'), `generation 应该是本次 runtime 的标记，实际 ${ev.generation}`);
  // 去抖窗口内不会重复发
  await sleep(RUN_SETTLED_DEBOUNCE_MS * 2);
  assert.equal(settled.filter((e) => e.roomId === dm.id).length, 1, '同一个房间不该连发两次 settled');
});

await test('run.settled：去抖窗口内房间又忙起来 → 不发（不会误报"不会再继续"）', async () => {
  const key = `${dm.id}:${mainBot.id}`;
  const entry = rt.runner.sessions.get(key);
  assert.ok(entry, '跑过一轮后应有 session entry');
  const before = settled.filter((e) => e.roomId === dm.id).length;
  // 制造"一轮结束但马上又忙"的窗口：先让 askMain 跑完，再立刻标记繁忙
  await rt.askMain('又来一轮');
  entry.busy = true;
  try {
    await sleep(RUN_SETTLED_DEBOUNCE_MS + 120);
    assert.equal(
      settled.filter((e) => e.roomId === dm.id).length,
      before,
      '房间不安静时不许发 run.settled',
    );
  } finally {
    entry.busy = false;
  }
  // 真安静下来之后，下一轮结束仍然会发（不是永久丢掉）
  await rt.askMain('第三轮');
  await waitFor(() => settled.filter((e) => e.roomId === dm.id).length > before, {
    label: '安静之后的 settled',
  });
});

await test('留意：空转时 isRoomQuiet 为真，排队中的轮次让它是假', () => {
  assert.equal(isRoomQuiet(rt.runner, dm.id), true);
  rt.runner.roundQueue.set(dm.id, { marker: true });
  try {
    assert.equal(isRoomQuiet(rt.runner, dm.id), false, 'roundQueue 有东西就不算安静');
  } finally {
    rt.runner.roundQueue.delete(dm.id);
  }
});

await test('dispose：幂等（第二次 {already:true}）、不抛、并且清掉待发的 settled 定时器', async () => {
  // 再跑一轮，让 settled 处于"已排程未触发"的状态
  await rt.askMain('最后一轮');
  const pending = pendingSettleTimerCount(rt.runner);
  assert.ok(pending >= 1, '刚跑完一轮应该有待发的 settled 定时器');

  const first = await rt.dispose();
  assert.deepEqual(first, { ok: true, already: false });
  assert.equal(pendingSettleTimerCount(rt.runner), 0, 'dispose 必须清掉 run.settled 定时器');

  const second = await rt.dispose();
  assert.deepEqual(second, { ok: true, already: true });

  off?.();
});

await test('初始化中途失败：构造会失败的 runtime 之后，子进程必须自己退出（没有泄漏句柄）', () => {
  const dirs = makeDirs('init-fail');
  const childScript = `
    import { createOrbisRuntime } from 'orbis-agent/sdk';
    const modelRuntimeFactory = async () => ({
      registerProvider() {}, unregisterProvider() {},
      getModels: () => [{ provider: 'mock', id: 'fast-1', contextWindow: 128000, reasoning: false }],
      getModel: () => null,
      async getAvailable() { return []; },
      async completeSimple() { return { content: [] }; },
    });
    try {
      await createOrbisRuntime({
        dataDir: ${JSON.stringify(dirs.dataDir)},
        workspace: ${JSON.stringify(dirs.workspace)},
        defaultModel: 'nope/nope',
        modelRuntimeFactory,
      });
      console.log('UNEXPECTED_OK');
      process.exitCode = 2;
    } catch (err) {
      console.log('caught ' + err.code);
    }
  `;
  const started = Date.now();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: path.join(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 15000,
  });
  const elapsed = Date.now() - started;
  assert.equal(child.error, undefined, `子进程没有按时退出（疑似泄漏定时器）：${child.error?.message ?? ''}`);
  assert.equal(child.status, 0, `子进程退出码 ${child.status}：${child.stderr?.slice(0, 400) ?? ''}`);
  assert.match(child.stdout, /caught E_MODEL_UNAVAILABLE/, `输出：${child.stdout}`);
  assert.ok(elapsed < 12000, `构造失败后 ${elapsed}ms 才退出，太慢（可能有长定时器残留）`);
});

console.log(`\nsdk-lifecycle: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
