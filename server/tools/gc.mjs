/**
 * 清理磁盘上的孤儿文件：state.json 中已不存在的房间文件与会话文件。
 *
 *   node tools/gc.mjs            只报告（默认，不修改任何文件）
 *   node tools/gc.mjs --yes      执行删除
 *
 * 判定规则：仅删除 state.json 未引用的文件。会话文件名由 pi SDK 生成，
 * 因此以 state.sessions 的值集合为准，不按 id 前缀推断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const yes = process.argv.includes('--yes');
const stateFile = path.join(config.dataDir, 'state.json');
const roomsDir = path.join(config.dataDir, 'rooms');
const sessionsDir = path.join(config.dataDir, 'sessions');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const state = readJson(stateFile, null);
if (!state) {
  console.error(`没有 ${stateFile}（先跑一次服务端）`);
  process.exit(1);
}

const liveRooms = new Set(Object.keys(state.rooms ?? {}));
const liveSessions = new Set(
  Object.values(state.sessions ?? {})
    .filter((p) => typeof p === 'string')
    .map((p) => path.basename(p)),
);

function scan(dir, isLive, suffix) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => !suffix || f.endsWith(suffix));
  } catch {
    return { orphans: [], bytes: 0 };
  }
  const orphans = [];
  let bytes = 0;
  for (const f of files) {
    if (isLive(f)) continue;
    const full = path.join(dir, f);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    orphans.push({ file: full, size });
    bytes += size;
  }
  return { orphans, bytes };
}

const rooms = scan(roomsDir, (f) => liveRooms.has(f.replace(/\.json$/, '')), '.json');
const sessions = scan(sessionsDir, (f) => liveSessions.has(f), '');

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
console.log(`数据目录：${config.dataDir}`);
console.log(`  房间：在线 ${liveRooms.size} 个，孤儿文件 ${rooms.orphans.length} 个（${mb(rooms.bytes)}）`);
console.log(`  会话：在线 ${liveSessions.size} 个，孤儿文件 ${sessions.orphans.length} 个（${mb(sessions.bytes)}）`);

const all = [...rooms.orphans, ...sessions.orphans];
if (!all.length) {
  console.log('没有要清的。');
  process.exit(0);
}

if (!yes) {
  console.log('\n示例（最多列 10 个）：');
  for (const o of all.slice(0, 10)) console.log(`  ${o.file}  (${o.size}B)`);
  console.log('\n这是试运行。确认无误后加 --yes 真删。');
  process.exit(0);
}

let removed = 0;
for (const o of all) {
  try {
    fs.unlinkSync(o.file);
    removed++;
  } catch (err) {
    console.warn(`删不掉 ${o.file}：${err?.message || err}`);
  }
}
console.log(`\n已删除 ${removed}/${all.length} 个文件，回收 ${mb(all.reduce((s, o) => s + o.size, 0))}。`);
