import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
);
const { VERSION } = await import('../src/version.js');

await test('版本来自 package.json（唯一来源）', () => {
  assert.equal(VERSION, pkg.version);
});

await test('是 semver 形态', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

await test('源码里不再出现写死的旧版本号', async () => {
  // /health、ws hello、serverInfo 以前各写死 '0.2.0'
  const files = ['src/http.js', 'src/ws.js', 'src/index.js'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
    assert.ok(!text.includes("'0.2.0'"), `${f} 里还有写死的 0.2.0`);
  }
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 版本测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
