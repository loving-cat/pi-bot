/**
 * 工具钩子测试：匹配、拦下、改写、非法规则。
 *   node tests/hooks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_hooks');
const HOME = process.env.PI_BOT_HOME;
fs.rmSync(HOME, { recursive: true, force: true });

const { applyHooks, validateHook, normalizeHooks, loadHooks, saveHooks } = await import('../src/hooks.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

await test('校验：动作、正则、空条件', () => {
  assert.match(validateHook({ action: 'x' }), /block 或 rewrite/);
  assert.match(validateHook({ action: 'rewrite' }), /rewrite 字段/);
  assert.match(validateHook({ action: 'block', when: { pattern: '([' } }), /不是合法正则/);
  assert.match(validateHook({ action: 'block', when: {} }), /至少要有/);
  assert.equal(validateHook({ action: 'block', when: { tool: 'bash' } }), null);
  assert.equal(validateHook({ action: 'rewrite', rewrite: 'x', when: { pattern: 'npm' } }), null);
});

await test('★ rewrite 必须配 when.pattern（否则空正则会插到命令开头）', () => {
  assert.match(
    validateHook({ action: 'rewrite', rewrite: 'x', when: { tool: 'bash' } }),
    /必须配 when\.pattern/,
  );
});

await test('★ block：命中就拦下并带说明', () => {
  const rules = [
    { id: 'no-publish', action: 'block', note: '发布要人工', when: { tool: 'bash', pattern: 'npm\\s+publish' } },
  ];
  const r = applyHooks(rules, { tool: 'bash', input: { command: 'npm publish --access public' } });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /no-publish/);
  assert.match(r.reason, /发布要人工/);
});

await test('不匹配就放行（工具不同 / 正则不中）', () => {
  const rules = [{ id: 'x', action: 'block', when: { tool: 'bash', pattern: 'rm -rf' } }];
  assert.equal(applyHooks(rules, { tool: 'read', input: { path: 'rm -rf' } }).blocked, false);
  assert.equal(applyHooks(rules, { tool: 'bash', input: { command: 'ls' } }).blocked, false);
});

await test('★ rewrite：改的是真正要执行的那条命令', () => {
  const rules = [
    { id: 'pin-py', action: 'rewrite', rewrite: './.venv/bin/python ', when: { tool: 'bash', pattern: '^python ' } },
  ];
  const r = applyHooks(rules, { tool: 'bash', input: { command: 'python x.py' } });
  assert.equal(r.blocked, false);
  assert.equal(r.input.command, './.venv/bin/python x.py');
  assert.deepEqual(r.applied, ['pin-py']);
});

await test('规则可以关掉；多条规则按顺序叠加', () => {
  const rules = [
    { id: 'off', enabled: false, action: 'block', when: { tool: 'bash' } },
    { id: 'r1', action: 'rewrite', rewrite: 'A', when: { tool: 'bash', pattern: '^x' } },
  ];
  const r = applyHooks(rules, { tool: 'bash', input: { command: 'x y' } });
  assert.equal(r.blocked, false);
  assert.equal(r.input.command, 'A y');
});

await test('★ 文件读写：非法规则被过滤，读回来是干净的', () => {
  const saved = saveHooks([
    { id: 'ok', action: 'block', when: { tool: 'write', pathPattern: '\\.env$' } },
    { id: 'bad', action: 'nope', when: { tool: 'bash' } },
  ]);
  assert.equal(saved.length, 1);
  assert.equal(loadHooks().length, 1);
  assert.equal(normalizeHooks([{ action: 'block', when: { tool: '*' } }]).length, 1);
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 钩子测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
