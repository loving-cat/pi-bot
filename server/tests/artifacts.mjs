/**
 * 产物自动回传：只认交付物、只认这一轮新增/改过的、并且有上限。
 *
 * 盯的是"别把工作目录整个端进群里"：源码、_inbox 里的输入、超大文件都不该出现。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ARTIFACT_LIMITS, collectArtifacts } from '../src/artifact-watch.js';
import { snapshotWorkspace } from '../src/change-watch.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-artifacts-'));
const write = (rel, content = 'x') => {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};

test('只认交付物：表格/文档/PDF 收，源码和输入不收', () => {
  write('out/report.xlsx', 'x'.repeat(64));
  write('notes.md', '# 说明');
  write('script.py', 'print(1)');
  write('_inbox/input.csv', 'a,b');

  const got = collectArtifacts(root, new Map()).map((a) => a.rel).sort();
  assert.deepEqual(got, ['notes.md', 'out/report.xlsx']);
});

test('只认这一轮新增或改过的（早就存在的文件不端上来）', () => {
  write('old.pdf', 'old');
  const before = snapshotWorkspace(root);
  write('new.csv', 'a,b\n1,2');
  const got = collectArtifacts(root, before).map((a) => a.rel);
  assert.deepEqual(got, ['new.csv']);
});

test('超大文件跳过（不把消息撑爆）', () => {
  const big = path.join(root, 'huge.pdf');
  fs.writeFileSync(big, Buffer.alloc(ARTIFACT_LIMITS.maxFileBytes + 1024, 0x61));
  const got = collectArtifacts(root, new Map()).map((a) => a.rel);
  assert.ok(!got.includes('huge.pdf'), got.join(','));
});

test('数量上限：最多 5 个', () => {
  for (let i = 0; i < 8; i++) write(`many/f${i}.txt`, `n${i}`);
  const got = collectArtifacts(root, new Map());
  assert.ok(got.length <= ARTIFACT_LIMITS.maxFiles, `实际 ${got.length}`);
});

test('没有快照时什么都不带（不知道这轮改了什么就不猜）', () => {
  assert.deepEqual(collectArtifacts(root, null), []);
});

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 句柄，忽略
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
