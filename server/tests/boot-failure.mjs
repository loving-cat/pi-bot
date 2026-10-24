/**
 * 启动阶段的失败必须**说清楚并退出**，不能变成"活着但没干活"的僵尸。
 *
 * 盯的是这个场景：端口被占时，`server.listen` 的 EADDRINUSE 冒到
 * 进程级 uncaughtException，而那个兜底是"记日志继续跑" ——
 * 于是进程活着、端口没监听、pid 还写着，桌面端只会一直转圈。
 *
 * 另一个隐蔽点：`new WebSocketServer({ server })` 会给 http server
 * 挂一个自己的 error 监听器。用 `on()` 注册在后面时错误被它先消费掉，
 * 后注册的 error 分支永远不执行 —— 所以必须 `prependListener`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-boot-'));
const serverDir = fileURLToPath(new URL('..', import.meta.url));

/** 起一个占位服务，拿到端口 */
async function occupyPort() {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  return { server, port: server.address().port };
}

/** 跑一次 pi-bot 启动，返回 {code, output} */
function boot({ port, timeoutMs = 15000, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: serverDir,
      env: {
        ...process.env,
        PI_BOT_HOME: path.join(root, `home-${port}`),
        PI_BOT_WORKSPACE: path.join(root, `ws-${port}`),
        PI_BOT_PORT: String(port),
        // 别让它去连真实模型
        PI_BOT_MODEL: '',
        ...env,
      },
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

await test('★ 端口被占：退出码 1，并说清为什么和怎么查', async () => {
  const { server, port } = await occupyPort();
  try {
    const r = await boot({ port });
    assert.equal(r.killed, false, '必须自己退出，不能一直挂着');
    assert.equal(r.code, 1, `退出码应为 1，实际 ${r.code}`);
    assert.match(r.output, /已被占用/, '要说清是端口被占');
    assert.match(r.output, /lsof/, '要给自查命令');
  } finally {
    server.close();
  }
});

await test('★ 端口被占时不能只留一句"未捕获异常"', async () => {
  const { server, port } = await occupyPort();
  try {
    const r = await boot({ port });
    // 兜底日志是允许的（进程级异常确实会先被它看到），
    // 但用户能看到的必须是那句人话。
    assert.match(r.output, /端口/, '必须出现人话提示');
  } finally {
    server.close();
  }
});

await test('端口空闲时能正常起来（不误杀）', async () => {
  const { server, port } = await occupyPort();
  await new Promise((r) => server.close(r)); // 释放掉
  const r = await boot({ port, timeoutMs: 6000 });
  // 正常启动的进程会一直跑；本测试主动 kill 它 —— 或者它自己因为
  // 没有模型等原因退出，都不该是"端口被占用"
  assert.ok(!/已被占用/.test(r.output), '端口空着不该报占用');
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} 通过，${failed} 失败`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
