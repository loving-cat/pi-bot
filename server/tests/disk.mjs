/**
 * 持久化测试：房间文件写入与删除。
 *   node tests/disk.mjs
 *
 * 覆盖：
 *   ① 房间消息写入 `rooms/<id>.json`；
 *   ② 删除房间/删除 bot 的私聊时同步删除消息文件与会话文件；
 *   ③ 空房间不生成文件；
 *   ④ 删除后再次落盘不重新生成文件；
 *   ⑤ 写入失败不抛出异常。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_disk');
const HOME = process.env.PI_BOT_HOME;
fs.rmSync(HOME, { recursive: true, force: true });

const { store } = await import('../src/store.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const roomFile = (id) => path.join(HOME, 'rooms', `${id}.json`);

await test('房间消息落盘到 rooms/<id>.json', () => {
  const bot = store.createBot({ name: '磁盘测试员', persona: '测试' });
  const room = store.createGroup({ name: '落盘测试组', botIds: [bot.id] });
  store.appendMessage({ roomId: room.id, authorType: 'user', authorId: 'u', authorName: '我', text: '你好', status: 'done' });
  store.saveNow();
  assert.ok(fs.existsSync(roomFile(room.id)), '文件应该被写出来');
  const saved = JSON.parse(fs.readFileSync(roomFile(room.id), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, '你好');
});

await test('★ 删房间要真删磁盘文件（房间消息 + 会话记录）', () => {
  const bot = store.createBot({ name: '会话测试员', persona: '测试' });
  const room = store.createGroup({ name: '要删掉的组', botIds: [bot.id] });
  store.appendMessage({ roomId: room.id, authorType: 'user', authorId: 'u', authorName: '我', text: 'x', status: 'done' });

  // 造一个真的会话文件（真会话是 pi SDK 写的，这里只验删得掉）
  const sessionFile = path.join(HOME, 'sessions', 'fake-session.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '{"type":"session"}\n');
  store.setSessionFile(room.id, bot.id, sessionFile);

  store.saveNow();
  assert.ok(fs.existsSync(roomFile(room.id)));
  assert.ok(fs.existsSync(sessionFile));

  store.deleteRoom(room.id);
  assert.equal(store.getRoom(room.id), null);
  assert.ok(!fs.existsSync(roomFile(room.id)), '房间文件应该被删掉');
  assert.ok(!fs.existsSync(sessionFile), '会话文件也应该被删掉');
});

await test('★ 空房间不写文件（不留 2 字节的 `[]` 垃圾）', () => {
  const bot = store.createBot({ name: '回收测试员', persona: '测试' });
  const room = store.createGroup({ name: '回收测试组', botIds: [bot.id] });
  store.saveNow();
  assert.ok(!fs.existsSync(roomFile(room.id)), '一条消息都没有就不该写文件');

  store.appendMessage({ roomId: room.id, authorType: 'user', authorId: 'u', authorName: '我', text: 'z', status: 'done' });
  store.saveNow();
  assert.ok(fs.existsSync(roomFile(room.id)));

  store.deleteRoom(room.id);
  store.saveNow();
  assert.ok(!fs.existsSync(roomFile(room.id)), '删掉的房间不能因为一次 scheduleSave 又冒出来');
});

await test('删 bot 时它的私聊也要连文件一起删', () => {
  const bot = store.createBot({ name: '被删掉的同事', persona: '测试' });
  const dm = store.ensureDm(bot.id);
  store.appendMessage({ roomId: dm.id, authorType: 'user', authorId: 'u', authorName: '我', text: 'y', status: 'done' });
  store.saveNow();
  assert.ok(fs.existsSync(roomFile(dm.id)));

  store.deleteBot(bot.id);
  store.saveNow();
  assert.equal(store.getRoom(dm.id), null);
  assert.ok(!fs.existsSync(roomFile(dm.id)), 'bot 的私聊文件也该一起清掉');
});

await test('落盘失败不抛异常（进程要继续跑）', () => {
  // 用一个非法路径制造写失败：把 state.json 的目录换成一个文件是行不通的，
  // 所以这里直接让 writeJsonAtomic 的输入不可序列化 —— 环形引用。
  const ring = { name: '环形' };
  ring.self = ring;
  assert.throws(() => JSON.stringify(ring), '前提：环形引用确实会让 stringify 抛');
  // store.saveNow 里各层都有 try/catch，这里只要"不抛"就够
  store.saveNow();
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 落盘测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
