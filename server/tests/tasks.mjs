/**
 * 任务板模型测试。
 *   node tests/tasks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_tasks');
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

const bot = store.createBot({ name: '执行者', persona: '测试' });
const room = store.createGroup({ name: '任务测试组', botIds: [bot.id] });

await test('建任务：没标题不建，默认 open', () => {
  assert.equal(store.createTask({ roomId: room.id, title: '   ' }), null);
  const t = store.createTask({ roomId: room.id, title: '拉日线数据' });
  assert.equal(t.status, 'open');
  assert.equal(t.roomId, room.id);
  assert.ok(store.getTask(t.id));
});

await test('状态流转：doing → done 记未读，标记已读后清掉', () => {
  const t = store.createTask({ roomId: room.id, title: '跑回测' });
  store.updateTask(t.id, { status: 'doing' });
  assert.equal(store.getTask(t.id).status, 'doing');
  assert.equal(store.getTask(t.id).unreadAt, 0, '进行中不该有未读');

  store.updateTask(t.id, { status: 'done' });
  assert.ok(store.getTask(t.id).unreadAt > 0, '完成后应有未读');

  store.updateTask(t.id, { read: true });
  assert.equal(store.getTask(t.id).unreadAt, 0);
});

await test('置顶排在前面', () => {
  const a = store.createTask({ roomId: room.id, title: '普通任务' });
  const b = store.createTask({ roomId: room.id, title: '重要任务' });
  store.updateTask(b.id, { pinned: true });
  const list = store.listTasks({ roomId: room.id });
  assert.equal(list[0].id, b.id);
  assert.ok(store.listTasks({ roomId: room.id }).some((t) => t.id === a.id));
});

await test('★ 派活登记：同一个人 + 同一句话 10 分钟内复用一条', () => {
  const first = store.upsertDispatchTask({
    roomId: room.id,
    ownerBotId: bot.id,
    title: '查一遍行情',
  });
  const again = store.upsertDispatchTask({
    roomId: room.id,
    ownerBotId: bot.id,
    title: '查一遍行情',
  });
  assert.equal(first, again, '不该重复建');

  const other = store.upsertDispatchTask({
    roomId: room.id,
    ownerBotId: bot.id,
    title: '顺手算个因子',
  });
  assert.notEqual(first, other);
  assert.equal(store.getTask(first).status, 'doing');
});

await test('跑完收尾：成功→done，失败→回到 open', () => {
  const okId = store.upsertDispatchTask({ roomId: room.id, ownerBotId: bot.id, title: '成功那条' });
  store.finishTask(okId, { ok: true, text: '结果：3 个文件' });
  assert.equal(store.getTask(okId).status, 'done');
  assert.match(store.getTask(okId).detail, /3 个文件/);

  const failId = store.upsertDispatchTask({ roomId: room.id, ownerBotId: bot.id, title: '失败那条' });
  store.finishTask(failId, { ok: false, text: '端口被占' });
  assert.equal(store.getTask(failId).status, 'open');
  assert.equal(store.getTask(failId).unreadAt, 0);
});

await test('按房间过滤 + 删除', () => {
  const other = store.createGroup({ name: '另一个组' });
  const t = store.createTask({ roomId: other.id, title: '别的组的事' });
  assert.ok(store.listTasks({ roomId: other.id }).every((x) => x.roomId === other.id));
  assert.equal(store.deleteTask(t.id), true);
  assert.equal(store.getTask(t.id), null);
  assert.equal(store.deleteTask('不存在'), false);
});

await test('重启收尾：遗留的 doing 全部放回待办，并留下说明', () => {
  const a = store.createTask({ roomId: room.id, title: '跑到一半被打断的活' });
  const b = store.createTask({ roomId: room.id, title: '正常待办' });
  store.updateTask(a.id, { status: 'doing' });
  assert.equal(store.getTask(a.id).status, 'doing');

  const n = store.reconcileTasks();
  assert.ok(n >= 1, `应该至少收回 1 条，实际 ${n}`);
  assert.equal(store.getTask(a.id).status, 'open');
  assert.equal(store.getTask(b.id).status, 'open', '本来就待办的不动');
  assert.match(store.getTask(a.id).detail, /中断/);
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 任务板测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
