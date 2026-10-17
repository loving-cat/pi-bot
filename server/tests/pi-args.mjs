/**
 * 入口分发：pi CLI 参数 vs 服务端参数。
 *   node tests/pi-args.mjs
 *
 * 背景：扩展派子 agent 时会 `node <argv[1]> --mode json -p ...`。
 * 如果入口把这些参数当服务端处理，会再起一个服务端（抢端口、共用数据目录）。
 */
import assert from 'node:assert/strict';
import { isPiInvocation, resolvePiCli } from '../src/pi-args.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

test('子 agent 的调用被认出来', () => {
  assert.equal(
    isPiInvocation(['--mode', 'json', '-p', '--no-session', '--append-system-prompt', '/tmp/p.md', 'Task: hi']),
    true,
  );
});

test('只有 -p 也算（打印模式）', () => {
  assert.equal(isPiInvocation(['-p', 'Task: hi']), true);
  assert.equal(isPiInvocation(['--print', 'hi']), true);
});

test('服务端自己的参数不算', () => {
  assert.equal(isPiInvocation([]), false);
  assert.equal(isPiInvocation(['--port', '8787']), false);
  assert.equal(isPiInvocation(['--data', 'D:/x']), false);
  // 只有 --mode 没别的 pi 特征：可能是别的东西，别乱接管
  assert.equal(isPiInvocation(['--mode', 'dark']), true);
});

test('解析出的 CLI 命令形状正确', () => {
  const inv = resolvePiCli();
  assert.equal(typeof inv.command, 'string');
  assert.ok(Array.isArray(inv.args));
  // 默认走 node + 脚本（Windows 上不能直接 spawn "pi"）
  if (!process.env.PI_CLI) assert.equal(inv.command, process.execPath);
});

test('PI_CLI 环境变量优先', () => {
  const old = process.env.PI_CLI;
  process.env.PI_CLI = 'D:/tmp/fake-cli.js';
  try {
    assert.deepEqual(resolvePiCli(), { command: process.execPath, args: ['D:/tmp/fake-cli.js'] });
  } finally {
    if (old === undefined) delete process.env.PI_CLI;
    else process.env.PI_CLI = old;
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.err}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
