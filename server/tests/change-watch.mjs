/**
 * 文件改动对比测试。
 *   node tests/change-watch.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const { snapshotWorkspace, diffSnapshots, summarizeChanges } = await import('../src/change-watch.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-changes-'));
const write = (rel, body) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

await test('新增 / 修改 / 删除都能认出来', () => {
  write('a.txt', 'one');
  write('sub/b.txt', 'two');
  const before = snapshotWorkspace(root);

  write('a.txt', 'one-changed');           // 修改（大小变了）
  fs.unlinkSync(path.join(root, 'sub/b.txt')); // 删除
  write('c.txt', 'three');                 // 新增

  const diff = diffSnapshots(before, snapshotWorkspace(root));
  assert.deepEqual(diff.added.map((x) => x.path), ['c.txt']);
  assert.deepEqual(diff.modified.map((x) => x.path), ['a.txt']);
  assert.deepEqual(diff.removed.map((x) => x.path), ['sub/b.txt']);
  assert.equal(diff.total, 3);
});

await test('没改动就是空', () => {
  const before = snapshotWorkspace(root);
  const diff = diffSnapshots(before, snapshotWorkspace(root));
  assert.equal(diff.total, 0);
  assert.equal(summarizeChanges(diff), null);
});

await test('跳过依赖与构建目录', () => {
  write('node_modules/pkg/index.js', 'x');
  write('.git/HEAD', 'ref');
  write('build/out.bin', 'x');
  write('src/keep.js', 'x');
  const snap = snapshotWorkspace(root);
  assert.ok(snap.has('src/keep.js'));
  assert.ok(!snap.has('node_modules/pkg/index.js'));
  assert.ok(!snap.has('.git/HEAD'));
  assert.ok(!snap.has('build/out.bin'));
});

await test('大量改动时按上限截断并标记', () => {
  const many = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-many-'));
  const before = snapshotWorkspace(many);
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), 'x');
  const diff = diffSnapshots(before, snapshotWorkspace(many), { limit: 10 });
  assert.equal(diff.added.length, 10);
  assert.equal(diff.total, 30);
  assert.equal(diff.truncated, true);
  fs.rmSync(many, { recursive: true, force: true });
});

await test('summarizeChanges 只保留界面要用的字段', () => {
  const diff = { added: [{ path: 'a', size: 1 }], modified: [], removed: [], total: 1, truncated: false };
  assert.deepEqual(summarizeChanges(diff), {
    added: [{ path: 'a', size: 1 }],
    modified: [],
    removed: [],
    total: 1,
    truncated: false,
  });
});

fs.rmSync(root, { recursive: true, force: true });

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 文件改动测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
