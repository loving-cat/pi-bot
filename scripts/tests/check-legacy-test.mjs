/**
 * `scripts/check-legacy.mjs` 自测：这个守卫必须真的会变红。
 *
 *   node scripts/tests/check-legacy-test.mjs
 *
 * 一个「只会在文件里数词」的守卫最容易写成永远绿 —— 所以这里造一个临时仓库，
 * 把「新债 / 旧债变大 / 旧债变小 / strict 收门」四种场景各跑一遍。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const GUARD = path.resolve(import.meta.dirname, '..', 'check-legacy.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-legacy-guard-'));

function mk(rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function run(args = []) {
  return spawnSync(process.execPath, [GUARD, '--root', root, ...args], { encoding: 'utf8' });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`✗ ${name}\n  ${err?.stack || err}`);
  }
}

const legacyLine = (n = 1) => Array.from({ length: n }, () => 'const x = process.env.PI_BOT_HOME;').join('\n');

mk('server/src/clean.js', 'export const ok = 1;\n');
mk('server/src/dirty.js', `${legacyLine(2)}\n`);

await test('CL-1 未登记的新残留 → 红，且指出是哪一行文件', async () => {
  const r = run();
  assert.equal(r.status, 1, `应退出 1，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /server\/src\/dirty\.js/);
  assert.match(r.stderr, /新债不许产生/);
  assert.doesNotMatch(r.stderr, /server\/src\/clean\.js/, '干净文件不该被点名');
});

await test('CL-2 --write 生成基线后复跑为绿', async () => {
  const w = run(['--write']);
  assert.equal(w.status, 0, w.stderr);
  const allow = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'legacy-allowlist.json'), 'utf8'));
  assert.deepEqual(
    allow.entries.map((e) => [e.path, e.count]),
    [['server/src/dirty.js', 2]],
    '基线应只登记 dirty.js 的 2 处',
  );
  const r = run();
  assert.equal(r.status, 0, `基线内应绿：\n${r.stderr}`);
  assert.match(r.stdout, /旧品牌残留未增长/);
});

await test('CL-3 旧债变大 → 红（同文件多写一处也算）', async () => {
  mk('server/src/dirty.js', `${legacyLine(3)}\n`);
  const r = run();
  assert.equal(r.status, 1, '超出基线必须红');
  assert.match(r.stderr, /2 → 3/);
  assert.match(r.stderr, /旧债不许变大/);
});

await test('CL-4 旧债变小 → 绿，并提示收基线', async () => {
  mk('server/src/dirty.js', `${legacyLine(1)}\n`);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /比基线少了 1 处/);
  run(['--write']);
  const allow = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'legacy-allowlist.json'), 'utf8'));
  assert.equal(allow.entries[0].count, 1);
});

await test('CL-5 新增文件（哪怕只有一处）未登记 → 红', async () => {
  mk('app/lib/new_widget.dart', "const h = 'x-pi-bot-client';\n");
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /app\/lib\/new_widget\.dart/);
});

await test('CL-6 --strict 有基线 → 红（2.0 收门未完成）', async () => {
  const r = run(['--strict']);
  assert.equal(r.status, 1, '白名单非空时 strict 必须红');
  assert.match(r.stderr, /要求白名单为空/);
});

await test('CL-7 --strict + 零残留 → 绿（2.0 收门通过）', async () => {
  for (const rel of ['server/src/dirty.js', 'app/lib/new_widget.dart']) {
    fs.rmSync(path.join(root, rel), { force: true });
  }
  run(['--write']);
  const r = run(['--strict']);
  assert.equal(r.status, 0, `清空后 strict 应绿：\n${r.stderr}`);
  assert.match(r.stdout, /旧品牌残留已清零/);
});

await test('CL-8 二进制与构建目录不被误扫', async () => {
  fs.mkdirSync(path.join(root, 'app/lib/build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/lib/build/blob.txt'), 'x-pi-bot-client\n', 'utf8');
  fs.writeFileSync(path.join(root, 'app/lib/logo.png'), 'pi-bot', 'utf8');
  const r = run(['--strict']);
  assert.equal(r.status, 0, `构建目录与二进制不该被扫：\n${r.stderr}`);
});

fs.rmSync(root, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\ncheck-legacy: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
