/**
 * 后台进程注册表测试。
 *   node tests/shells.mjs
 *
 * 覆盖启动/读输出/写 stdin/结束、输出上限、模式等待、并发上限、空闲清理。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellRegistry, trimChunks } from '../src/shells.js';

// 用临时脚本文件跑，避免不同平台 shell 对引号/括号的解析差异
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-shells-'));
const script = (name, body) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body, 'utf8');
  return `node "${file}"`;
};

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = new ShellRegistry({ idleMs: 60_000 });

await test('启动并读到输出', async () => {
  const started = reg.start({ roomId: 'r1', botId: 'b1', command: 'echo hello-from-shell', cwd: process.cwd() });
  assert.ok(started.id, started.error);
  const r = await reg.read(started.id, { waitMs: 4000 });
  assert.match(r.output, /hello-from-shell/);
  await sleep(300);
  const done = reg.get(started.id);
  assert.equal(done.running, false);
  assert.equal(done.exitCode, 0);
});

await test('★ 写 stdin 能送到进程里', async () => {
  const cmd = script('stdin.js', `process.stdin.on('data',d=>{console.log('got:'+d.toString().trim());process.exit(0)});
`);
  const started = reg.start({ roomId: 'r1', botId: 'b1', command: cmd, cwd: process.cwd() });
  assert.ok(started.id, started.error);
  await sleep(500);
  const w = reg.write(started.id, 'ping\n');
  assert.equal(w.ok, true, w.error);
  const r = await reg.read(started.id, { pattern: 'got:ping', waitMs: 5000 });
  assert.equal(r.matched, true, r.output);
});

await test('★ pattern 等待：命中就返回', async () => {
  const cmd = script('ready.js', `setTimeout(()=>console.log('READY'),400);
`);
  const started = reg.start({ roomId: 'r1', botId: 'b1', command: cmd, cwd: process.cwd() });
  const begin = Date.now();
  const r = await reg.read(started.id, { pattern: 'READY', waitMs: 5000 });
  assert.equal(r.matched, true);
  assert.ok(Date.now() - begin < 5000);
});

await test('结束进程', async () => {
  const started = reg.start({ roomId: 'r1', botId: 'b1', command: script('idle.js', `setInterval(()=>{},500);
`), cwd: process.cwd() });
  await sleep(400);
  assert.equal(reg.get(started.id).running, true);
  const killed = reg.kill(started.id);
  assert.equal(killed.ok, true);
  await sleep(600);
  const r = await reg.read(started.id);
  assert.equal(r.running, false);
});

await test('★ 输出上限：超出后标记 truncated 且只保留尾部', async () => {
  const small = new ShellRegistry({ maxBytes: 4096, idleMs: 60_000 });
  const cmd = script('big.js', `process.stdout.write('a'.repeat(200000));
`);
  const started = small.start({ roomId: 'r1', botId: 'b1', command: cmd, cwd: process.cwd() });
  await sleep(1200);
  const r = await small.read(started.id);
  assert.equal(r.truncated, true);
  assert.ok(r.output.length <= 4096 + 64, `实际 ${r.output.length}`);
  small.stopAll();
});

await test('并发上限：超出直接拒绝', async () => {
  const tiny = new ShellRegistry({ maxShells: 1, idleMs: 60_000 });
  const first = tiny.start({ roomId: 'r1', botId: 'b1', command: script('idle2.js', `setInterval(()=>{},500);
`), cwd: process.cwd() });
  assert.ok(first.id);
  const second = tiny.start({ roomId: 'r1', botId: 'b1', command: 'echo x', cwd: process.cwd() });
  assert.equal(second.id, null);
  assert.match(second.error, /上限/);
  tiny.stopAll();
});

await test('空闲清理：结束并移除记录', async () => {
  const quick = new ShellRegistry({ idleMs: 50 });
  const started = quick.start({ roomId: 'r1', botId: 'b1', command: script('idle3.js', `setInterval(()=>{},300);
`), cwd: process.cwd() });
  await sleep(200);
  quick.pruneIdle();
  assert.equal(quick.get(started.id), null);
  quick.stopAll();
});

await test('按房间清理', async () => {
  const started = reg.start({ roomId: 'r_clear', botId: 'b1', command: script('idle4.js', `setInterval(()=>{},300);
`), cwd: process.cwd() });
  await sleep(300);
  assert.equal(reg.killRoom('r_clear'), 1);
  assert.equal(reg.get(started.id), null);
});

await test('单块超上限也要截尾（不依赖操作系统的分块大小）', () => {
  const entry = { chunks: ['a'.repeat(200000)], bytes: 200000, truncated: false };
  trimChunks(entry, 1024);
  assert.equal(entry.truncated, true);
  assert.ok(Buffer.byteLength(entry.chunks[0]) <= 1024, `实际 ${Buffer.byteLength(entry.chunks[0])}`);
});

await test('截尾不会切断 UTF-8 多字节字符', () => {
  const text = '中'.repeat(1000); // 3000 字节
  const entry = { chunks: [text], bytes: Buffer.byteLength(text), truncated: false };
  trimChunks(entry, 1000);
  const kept = entry.chunks[0];
  assert.ok(Buffer.byteLength(kept) <= 1000);
  assert.ok(!kept.startsWith('\uFFFD'), '开头不能是替换符（说明切在了半个字符上）');
  assert.ok(/^中+$/.test(kept), kept.slice(0, 10));
});

reg.stopAll();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (_) {}

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 后台进程测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
