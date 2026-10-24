/**
 * 性能基准：造 20 个部门 × 每部门 500 条消息，量几个热点路径。
 *   node tests/bench.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_bench');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { store } = await import('../src/store.js');
const { parseMentions } = await import('../src/mentions.js');

function ms(fn, times = 1) {
  const t = process.hrtime.bigint();
  for (let i = 0; i < times; i++) fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

// ---- 造数据
const ROOMS = 20;
const PER_ROOM = 500;
const t0 = Date.now();
const botIds = [];
for (let i = 0; i < 6; i++) botIds.push(store.createBot({ name: `员工${i}`, persona: `第${i}号员工` }).id);
for (let i = 0; i < ROOMS; i++) {
  const room = store.createGroup({ name: `部门${i}`, botIds, leadBotId: botIds[0] });
  for (let j = 0; j < PER_ROOM; j++) {
    store.appendMessage({
      roomId: room.id,
      authorType: j % 3 === 0 ? 'user' : 'bot',
      authorId: j % 3 === 0 ? null : botIds[j % 6],
      authorName: j % 3 === 0 ? '我' : `员工${j % 6}`,
      text: `这是第 ${j} 条消息，@员工${(j + 1) % 6} 你看一下这个任务怎么处理比较好，需要给出具体方案和交付物清单。`,
      status: 'done',
    });
  }
}
console.log(`造数据：${ROOMS} 个部门 × ${PER_ROOM} 条 = ${ROOMS * PER_ROOM} 条，耗时 ${Date.now() - t0}ms\n`);

const rooms = store.listRooms().filter((r) => r.kind === 'group');

const bench = [];
bench.push(['listRooms() 全量排序', ms(() => store.listRooms(), 200), 200]);
bench.push(['roomSummary × 20（/api/state 走这条）', ms(() => rooms.forEach((r) => store.roomSummary(r)), 200), 200]);
bench.push(['listMessages(500) × 20', ms(() => rooms.forEach((r) => store.listMessages(r.id, { limit: 500 })), 200), 200]);
bench.push(['appendMessage × 1000', ms(() => {
  for (let i = 0; i < 1000; i++) {
    store.appendMessage({ roomId: rooms[0].id, authorType: 'bot', authorId: botIds[0], authorName: '员工0', text: `基准${i}` });
  }
}, 1), 1]);
bench.push(['saveNow() 落盘（脏房间 1 个）', ms(() => store.saveNow(), 20), 20]);
bench.push(['parseMentions × 1000', ms(() => {
  const members = botIds.map((id, i) => ({ id, name: `员工${i}` }));
  for (let i = 0; i < 1000; i++) parseMentions('@员工1 @员工3 你们处理下', members);
}, 1), 1]);

console.log('============ 基准结果 ============');
for (const [name, total, times] of bench) {
  console.log(`${name.padEnd(44)} ${(total / times).toFixed(3)} ms/次   (${times} 次共 ${total.toFixed(1)}ms)`);
}

// ---- 落盘体积
let bytes = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else bytes += fs.statSync(p).size;
  }
};
walk(process.env.PI_BOT_HOME);
console.log(`\n落盘总量：${(bytes / 1024 / 1024).toFixed(2)} MB`);

// ---- 脏房间优化验证：改 1 个房间，不该写 20 个文件（断言，失败退出 1）
const roomsDir = path.join(process.env.PI_BOT_HOME, 'rooms');
store.saveNow(); // 先把前面造数据留下的脏房间都写掉
const stamp = (f) => fs.statSync(path.join(roomsDir, f)).mtimeMs;
const before = new Map(fs.readdirSync(roomsDir).map((f) => [f, stamp(f)]));
await new Promise((r) => setTimeout(r, 30)); // 让修改时间能分出先后
store.appendMessage({ roomId: rooms[1].id, authorType: 'bot', text: '触发一次变更' });
const dirty = store.dirtyRooms.size;
console.log(`脏房间数：${dirty}（应该是 1，而不是 ${ROOMS}）`);
store.saveNow();
const rewritten = [...before].filter(([f, t]) => stamp(f) !== t).length;
console.log(`rooms 目录文件数：${fs.readdirSync(roomsDir).length}，这次落盘重写了 ${rewritten} 个`);
let failed = 0;
const check = (ok, msg) => {
  if (!ok) {
    failed++;
    console.log(`✗ ${msg}`);
  }
};
check(dirty === 1, `改一个房间只该标记 1 个脏房间（实际 ${dirty}）`);
check(rewritten === 1, `落盘只该重写 1 个房间文件（实际 ${rewritten}）`);
check(store.dirtyRooms.size === 0, '落盘后脏房间要清空');
console.log(failed ? `基准断言：${failed} 条失败` : '基准断言：全部通过');
process.exit(failed ? 1 : 0);
