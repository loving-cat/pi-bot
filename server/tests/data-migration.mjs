/**
 * 数据目录迁移与会话路径修复（复审 P1-6）。
 *   node tests/data-migration.mjs
 *
 * 复现的是这台开发机上实测到的状态：老版本整目录复制过去，state.json 里的会话文件
 * 仍是旧目录的绝对路径，服务端之后一直往旧目录写，新目录里那份是过期副本。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const {
  ENTRIES,
  MIGRATION_MARKER,
  isInside,
  migrateLegacyData,
  migratedWorkspace,
  repairSessionRefs,
} = await import('../src/data-migration.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-migrate-'));
let n = 0;
function fresh() {
  const dir = path.join(root, `case-${++n}`);
  return { legacy: path.join(dir, 'legacy'), target: path.join(dir, 'target') };
}
function write(file, text, mtimeMs = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const quiet = () => {};

/** 造一个老版本的数据目录：两个会话、消息、附件、工作目录（带一个大文件）、测试残留、杂物 */
function makeLegacy(legacy) {
  const s1 = path.join(legacy, 'sessions', 'a.jsonl');
  const s2 = path.join(legacy, 'sessions', 'b.jsonl');
  write(s1, '{"type":"session"}\nA-history\n');
  write(s2, '{"type":"session"}\nB-history\n');
  write(path.join(legacy, 'state.json'), JSON.stringify({ version: 2, rooms: {}, sessions: { 'r1:b1': s1, 'r2:b2': s2 } }));
  write(path.join(legacy, 'rooms', 'r1.json'), '[]');
  write(path.join(legacy, 'uploads', 'u1.png'), 'png');
  write(path.join(legacy, 'uploads', '_partial', 'half.part'), 'half');
  write(path.join(legacy, 'uploads.json'), '[]');
  write(path.join(legacy, 'secret.key'), 'k'.repeat(32));
  write(path.join(legacy, 'workspace', '.venv', 'big.bin'), 'x'.repeat(1024));
  write(path.join(legacy, 'workspace', 'report.md'), 'bot output');
  write(path.join(legacy, '_unit_test', 'state.json'), '{}');
  write(path.join(legacy, 'test.xlsx'), 'junk');
  return { s1, s2 };
}

await test('迁移只搬服务端数据：不复制 workspace、测试残留、分片半成品、杂物', () => {
  const { legacy, target } = fresh();
  makeLegacy(legacy);
  const r = migrateLegacyData({ legacy, target, log: quiet });
  assert.equal(r.migrated, true);
  for (const name of ['state.json', 'rooms', 'sessions', 'uploads', 'uploads.json', 'secret.key']) {
    assert.ok(fs.existsSync(path.join(target, name)), `${name} 应该搬过来`);
  }
  assert.ok(!fs.existsSync(path.join(target, 'workspace')), 'workspace 不该被复制');
  assert.ok(!fs.existsSync(path.join(target, '_unit_test')), '测试残留不该被复制');
  assert.ok(!fs.existsSync(path.join(target, 'test.xlsx')), '用户随手丢的文件不该被复制');
  assert.ok(!fs.existsSync(path.join(target, 'uploads', '_partial')), '上传分片半成品不该被复制');
  assert.ok(fs.existsSync(path.join(target, 'uploads', 'u1.png')));
});

await test('迁移后 state.json 的会话路径指向新目录，内容一致', () => {
  const { legacy, target } = fresh();
  makeLegacy(legacy);
  migrateLegacyData({ legacy, target, log: quiet });
  const st = readState(target);
  for (const ref of Object.values(st.sessions)) {
    assert.ok(isInside(ref, path.join(target, 'sessions')), '会话引用必须在新目录的 sessions 里');
    assert.ok(fs.existsSync(ref));
  }
  assert.match(fs.readFileSync(st.sessions['r1:b1'], 'utf8'), /A-history/);
});

await test('迁移后旧目录一个字节都不动', () => {
  const { legacy, target } = fresh();
  makeLegacy(legacy);
  const before = fs.readFileSync(path.join(legacy, 'state.json'), 'utf8');
  migrateLegacyData({ legacy, target, log: quiet });
  assert.equal(fs.readFileSync(path.join(legacy, 'state.json'), 'utf8'), before, '旧 state.json 不能被改');
  assert.ok(fs.existsSync(path.join(legacy, 'workspace', 'report.md')), '旧工作目录要原样在');
});

await test('工作目录不复制，但会继续用旧的（bot 做出来的东西不会「消失」）', () => {
  const { legacy, target } = fresh();
  makeLegacy(legacy);
  migrateLegacyData({ legacy, target, log: quiet });
  const marker = JSON.parse(fs.readFileSync(path.join(target, MIGRATION_MARKER), 'utf8'));
  assert.equal(marker.from, legacy);
  assert.equal(migratedWorkspace(target), path.join(legacy, 'workspace'));
});

await test('旧工作目录被用户删了：退回新目录自己的 workspace', () => {
  const { legacy, target } = fresh();
  makeLegacy(legacy);
  migrateLegacyData({ legacy, target, log: quiet });
  fs.rmSync(path.join(legacy, 'workspace'), { recursive: true, force: true });
  assert.equal(migratedWorkspace(target), null);
});

await test('新目录已有数据：不迁移（只跑一次）', () => {
  const { legacy, target } = fresh();
  makeLegacy(legacy);
  write(path.join(target, 'state.json'), JSON.stringify({ version: 2, rooms: {}, sessions: {} }));
  const r = migrateLegacyData({ legacy, target, log: quiet });
  assert.equal(r.migrated, false);
  assert.ok(!fs.existsSync(path.join(target, 'rooms')));
});

await test('★ 已经按老办法搬过：指向旧目录、而且旧目录那份更新 → 用更新的覆盖并改路径', () => {
  // 这台开发机的真实状态
  const { legacy, target } = fresh();
  const old = path.join(legacy, 'sessions', 'a.jsonl');
  const copy = path.join(target, 'sessions', 'a.jsonl');
  const t0 = Date.now() - 60 * 3600 * 1000;
  write(copy, 'snapshot-at-migration\n', t0);                       // 迁移时的副本（旧）
  write(old, 'snapshot-at-migration\n58-hours-of-new-turns\n', t0 + 58 * 3600 * 1000); // 迁移后还在往这写
  write(path.join(target, 'state.json'), JSON.stringify({ version: 2, rooms: {}, sessions: { 'r1:b1': old } }));
  const r = repairSessionRefs({ dataDir: target, log: quiet });
  assert.equal(r.rewritten, 1);
  assert.equal(r.copied, 1);
  const st = readState(target);
  assert.equal(path.resolve(st.sessions['r1:b1']), path.resolve(copy));
  assert.match(fs.readFileSync(copy, 'utf8'), /58-hours-of-new-turns/, '必须拿到迁移之后那段记忆');
  assert.ok(fs.existsSync(old), '旧文件不能删');
});

await test('已经搬过：新目录那份更新 → 保留新目录的，只改路径', () => {
  const { legacy, target } = fresh();
  const old = path.join(legacy, 'sessions', 'b.jsonl');
  const copy = path.join(target, 'sessions', 'b.jsonl');
  const t0 = Date.now() - 3600 * 1000;
  write(old, 'old\n', t0);
  write(copy, 'old\nnewer-in-target\n', t0 + 1800 * 1000);
  write(path.join(target, 'state.json'), JSON.stringify({ version: 2, rooms: {}, sessions: { 'r2:b2': old } }));
  const r = repairSessionRefs({ dataDir: target, log: quiet });
  assert.equal(r.rewritten, 1);
  assert.equal(r.copied, 0);
  assert.match(fs.readFileSync(copy, 'utf8'), /newer-in-target/, '新目录里更新的那份不能被旧的覆盖');
});

await test('已经搬过：新目录里根本没有副本 → 复制过来并改路径', () => {
  const { legacy, target } = fresh();
  const old = path.join(legacy, 'sessions', 'c.jsonl');
  write(old, 'only-in-legacy\n');
  write(path.join(target, 'state.json'), JSON.stringify({ version: 2, rooms: {}, sessions: { 'r3:b3': old } }));
  const r = repairSessionRefs({ dataDir: target, log: quiet });
  assert.equal(r.copied, 1);
  assert.match(fs.readFileSync(path.join(target, 'sessions', 'c.jsonl'), 'utf8'), /only-in-legacy/);
});

await test('两边都找不到的会话：保持原样，不报错', () => {
  const { legacy, target } = fresh();
  const gone = path.join(legacy, 'sessions', 'gone.jsonl');
  write(path.join(target, 'state.json'), JSON.stringify({ version: 2, rooms: {}, sessions: { 'r4:b4': gone } }));
  const r = repairSessionRefs({ dataDir: target, log: quiet });
  assert.equal(r.missing, 1);
  assert.equal(r.rewritten, 0);
  assert.equal(readState(target).sessions['r4:b4'], gone);
});

await test('全部引用都在新目录：一个字节都不写（不碰 state.json）', () => {
  const { target } = fresh();
  const ok = path.join(target, 'sessions', 'ok.jsonl');
  write(ok, 'x');
  const text = JSON.stringify({ version: 2, rooms: {}, sessions: { 'r5:b5': ok } });
  write(path.join(target, 'state.json'), text, Date.now() - 5000);
  const before = fs.statSync(path.join(target, 'state.json')).mtimeMs;
  repairSessionRefs({ dataDir: target, log: quiet });
  assert.equal(fs.readFileSync(path.join(target, 'state.json'), 'utf8'), text);
  assert.equal(fs.statSync(path.join(target, 'state.json')).mtimeMs, before);
});

await test('state.json 损坏或不存在：什么都不做', () => {
  const { target } = fresh();
  assert.deepEqual(repairSessionRefs({ dataDir: target, log: quiet }).scanned, 0);
  write(path.join(target, 'state.json'), '{ not json');
  assert.deepEqual(repairSessionRefs({ dataDir: target, log: quiet }).scanned, 0);
  assert.equal(fs.readFileSync(path.join(target, 'state.json'), 'utf8'), '{ not json');
});

await test('修复是幂等的：连跑两次结果一样', () => {
  const { legacy, target } = fresh();
  const old = path.join(legacy, 'sessions', 'd.jsonl');
  write(old, 'd\n');
  write(path.join(target, 'state.json'), JSON.stringify({ version: 2, rooms: {}, sessions: { 'r6:b6': old } }));
  repairSessionRefs({ dataDir: target, log: quiet });
  const once = fs.readFileSync(path.join(target, 'state.json'), 'utf8');
  const second = repairSessionRefs({ dataDir: target, log: quiet });
  assert.equal(second.rewritten, 0);
  assert.equal(fs.readFileSync(path.join(target, 'state.json'), 'utf8'), once);
});

await test('目标就在旧目录里面（或反过来）：拒绝迁移，避免自己复制自己', () => {
  const { legacy } = fresh();
  makeLegacy(legacy);
  const r = migrateLegacyData({ legacy, target: path.join(legacy, 'nested'), log: quiet });
  assert.equal(r.migrated, false);
});

await test('要搬的清单覆盖服务端读写的所有顶层数据', () => {
  // 服务端代码里直接 join 到 dataDir 下的顶层名字（新增数据文件时这里会提醒你）
  const src = path.join(process.cwd(), 'src');
  const names = new Set();
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    for (const m of text.matchAll(/path\.join\((?:config\.)?dataDir,\s*'([^'/]+)'/g)) names.add(m[1]);
  }
  for (const name of names) assert.ok(ENTRIES.includes(name), `${name} 在数据目录里，但迁移不会搬它`);
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed++;
    console.log(`  ✗ ${r.name}\n      ${r.err}`);
  }
}
console.log(`\n数据迁移：${results.length - failed}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
