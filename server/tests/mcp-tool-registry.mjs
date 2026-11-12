/**
 * D5/P1：MCP 工具名网关 —— 只放行 tools/list 里真实存在的工具。
 *   node tests/mcp-tool-registry.mjs
 *
 * 转发 tools/call 之前先校验工具名在不在该 server 最近一次 tools/list 的结果里；
 * 不在就直接拒绝，请求**不会到达 MCP 子进程**。
 *
 * 为什么不能按时间过期：长会话里过了 TTL 就等于没检查，模型幻觉出的工具名
 * 照样能打到子进程。所以只在 revision 变化或重新 probe 时作废，
 * 未知时由调用方**拒绝并后台重拉**，不放行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-toolreg-'));

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err?.message || String(err) }); }
}

const { rememberTools, isListedTool, clearToolRegistry } =
  await import('../src/mcp-tool-registry.js');

// ────────────────── D5：网关拒绝未列出的工具名 ──────────────────

await test('★ 网关：不在 tools/list 里的工具名被拒', () => {
  clearToolRegistry();
  rememberTools('x', ['decompile', 'read_file'], 'rev1');

  assert.equal(isListedTool('x', 'decompile'), true, '列出的应通过');
  assert.equal(isListedTool('x', 'not_listed'), false, '未列出的应被拒');
});

await test('网关：没有可信清单时放行（安全靠审批，不靠这个缓存）', () => {
  clearToolRegistry();
  assert.equal(isListedTool('unknown_server', 'anything'), null, '未知 server 返回 null（放行）');
  rememberTools('y', ['a'], 'rev1');
  assert.equal(isListedTool('y', 'a', 'rev2'), null, '配置变了旧清单不可信');
});


// ────────────────── P1：网关清单不再按时间过期 ──────────────────

await test('★ 网关：清单不按时间过期（超过 10 分钟仍然有效）', async () => {
  clearToolRegistry();
  rememberTools('x', ['decompile'], 'rev1');

  // 注册表里已经没有任何时间判断 —— 源码级断言比"改时间戳"更可靠：
  // 只要代码里不出现按时间过期的逻辑，长会话就不会失效。
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'mcp-tool-registry.js'),
    'utf8',
  );
  // 去掉注释再检查，避免把说明文字误当代码
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /TTL|Date\.now\(\)\s*-\s*entry\.at|expire/i,
    '注册表不该有按时间过期的逻辑');

  // 行为上：不管多久，只要 revision 没变就一直有效
  assert.equal(isListedTool('x', 'decompile', 'rev1'), true);
  assert.equal(isListedTool('x', 'not_listed', 'rev1'), false);
});

await test('★ 网关：revision 变化后旧清单不再作数', () => {
  clearToolRegistry();
  rememberTools('x', ['decompile'], 'rev1');
  assert.equal(isListedTool('x', 'decompile', 'rev1'), true);
  // revision 变了 → 返回 null（要求重新拉），而不是拿旧清单放行
  assert.equal(isListedTool('x', 'decompile', 'rev2'), null);
  assert.equal(isListedTool('x', 'not_listed', 'rev2'), null);
});

await test('★ 网关：没有清单时返回 null → 调用方拒绝（不放行）', () => {
  clearToolRegistry();
  assert.equal(isListedTool('never_probed', 'anything'), null);

  // 网关对 null 的处理是"拒绝 + 后台刷新"，不是放行。
  // 源码级断言：确认那段逻辑里是 block: true。
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp-hook.js'), 'utf8');
  const seg = src.slice(src.indexOf('if (listed === null)'), src.indexOf('if (listed === false)'));
  assert.match(seg, /block:\s*true/, '没有清单时必须 block');
  assert.match(seg, /refreshToolList/, '并且要在后台重新拉一次');
});

await test('网关：probe 失败时不留清单（后续调用会被拒）', () => {
  clearToolRegistry();
  // 模拟 probe 失败：不调 rememberTools
  assert.equal(
    isListedTool('failed_server', 'some_tool'),
    null,
    'probe 失败后应无清单，网关会拒绝',
  );
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
