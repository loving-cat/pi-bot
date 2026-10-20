/**
 * 中转的安全边界：空口令不对外、同 code 不静默顶号。
 *
 * 这两条都是"配错了不该静默接受"的类型：
 *   · 空 secret + 0.0.0.0 = 任何能连到端口的人都能挂 agent 上来接管会话
 *   · 拿到泄露 code 的人先连上就能把主人踢掉，手机配对 token 随之落到对方手里
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-relay-'));
const serverDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** 跑一次 relay-server，拿到退出码与输出 */
function bootRelay({ env = {}, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/relay-server.js'], {
      cwd: serverDir,
      env: { ...process.env, RELAY_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, output: out, killed: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, killed: false });
    });
  });
}

await test('★ 空 secret + 对外监听 → 拒绝启动', async () => {
  const r = await bootRelay({ env: { RELAY_HOST: '0.0.0.0', RELAY_SECRET: '' } });
  assert.equal(r.code, 1, `应退出码 1，实际 ${r.code}`);
  assert.match(r.output, /拒绝启动/, '要明确说拒绝');
  assert.match(r.output, /RELAY_SECRET/, '要告诉用户该设什么');
});

await test('拒绝启动时给足三条出路（正经用 / 本机调试 / 显式放行）', async () => {
  const r = await bootRelay({ env: { RELAY_HOST: '0.0.0.0', RELAY_SECRET: '' } });
  assert.match(r.output, /RELAY_HOST=127\.0\.0\.1/, '本机调试的写法');
  assert.match(r.output, /RELAY_ALLOW_OPEN=1/, '显式放行的开关');
});

await test('★ 显式 RELAY_ALLOW_OPEN=1 时放行（让它是"想清楚了才做"）', async () => {
  const r = await bootRelay({
    env: { RELAY_HOST: '0.0.0.0', RELAY_SECRET: '', RELAY_ALLOW_OPEN: '1' },
    timeoutMs: 3000,
  });
  assert.ok(!/拒绝启动/.test(r.output), '显式放行后不该拒绝');
  assert.match(r.output, /中转已启动/);
});

await test('本机监听 + 空 secret → 放行（本地调试的正常用法）', async () => {
  const r = await bootRelay({
    env: { RELAY_HOST: '127.0.0.1', RELAY_SECRET: '' },
    timeoutMs: 3000,
  });
  assert.ok(!/拒绝启动/.test(r.output));
  assert.match(r.output, /中转已启动/);
});

await test('设了 secret 就能对外监听', async () => {
  const r = await bootRelay({
    env: { RELAY_HOST: '0.0.0.0', RELAY_SECRET: 'a-test-secret' },
    timeoutMs: 3000,
  });
  assert.ok(!/拒绝启动/.test(r.output));
  assert.match(r.output, /中转已启动/);
});

// ---- 同 code 顶号：直接测 createRelay 的行为 ----

const { createRelay } = await import('../src/relay/server.js');
const { WebSocket } = await import('ws');

/** 起一个 relay，返回 {relay, port, url} */
async function startRelay(secret) {
  const relay = createRelay({ secret, port: 0, host: '127.0.0.1' });
  const addr = await relay.listen();
  return { relay, port: addr.port, url: `ws://127.0.0.1:${addr.port}` };
}

/** 连一个 agent，等它 settle（收 close 或超时） */
function connectAgent(url, { code, secret } = {}) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams();
    if (code) qs.set('code', code);
    if (secret) qs.set('secret', secret);
    const ws = new WebSocket(`${url}/agent?${qs}`);
    let closed = null;
    ws.on('close', (c, r) => { closed = { code: c, reason: r.toString() }; resolve({ ws, closed }); });
    ws.on('open', () => setTimeout(() => resolve({ ws, closed }), 120));
    ws.on('error', () => {});
  });
}

await test('★ 同 code 且没带 secret → 拒绝新连接，不顶掉旧的', async () => {
  const { relay, url } = await startRelay('sec-1');
  try {
    const first = await connectAgent(url, { code: 'aaaaaaaaaaaa', secret: 'sec-1' });
    assert.equal(first.closed, null, '第一台应该正常挂着');

    const second = await connectAgent(url, { code: 'aaaaaaaaaaaa' }); // 没 secret
    assert.ok(second.closed, '第二台应该被拒绝（close）');
    // 4403 = secret 不对（在"同 code"判断之前就先拦掉了，更严格）；
    // 4404 = code 被占用。两者都算"没被顶号"，这里只要求是 4xxx 拒绝。
    assert.ok(
      [4403, 4404].includes(second.closed.code),
      `应是 4403/4404 拒绝，实际 ${second.closed?.code}`,
    );

    // 关键：第一台必须还活着
    assert.equal(first.ws.readyState, WebSocket.OPEN, '主人不能被踢下线');

    first.ws.close();
    second.ws.close();
  } finally {
    await relay.close();
  }
});

await test('同 code 且带了正确 secret → 允许替换（电脑重连场景）', async () => {
  const { relay, url } = await startRelay('sec-2');
  try {
    const first = await connectAgent(url, { code: 'bbbbbbbbbbbb', secret: 'sec-2' });
    assert.equal(first.closed, null);

    const second = await connectAgent(url, { code: 'bbbbbbbbbbbb', secret: 'sec-2' });
    // 第二台能挂上
    assert.equal(second.closed, null, '带对 secret 的新连接应该接上');
    // 旧的被替换掉
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(first.ws.readyState, WebSocket.CLOSED, '旧连接应被 4409 替换');

    second.ws.close();
  } finally {
    await relay.close();
  }
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} 通过，${failed} 失败`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
