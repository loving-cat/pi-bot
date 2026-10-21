/** 回执来源规划：显式关联、任务隔离、时间边界和幂等。 */
import assert from 'node:assert/strict';
import { planProgressSenderBackfill } from '../src/progress-senders.js';

const dm = { id: 'dm', kind: 'dm' };
const source = (id, roomId = 'a', authorId = 'lead-a', createdAt = 100) => ({
  id, roomId, authorId, authorName: authorId, authorType: 'bot', status: 'done', createdAt,
  text: '按任务要求生成结果',
});
const receipt = (id, phase, meta = {}, createdAt = 200) => ({
  id, roomId: dm.id, authorId: 'worker', authorType: 'bot', status: 'done', createdAt,
  text: '在部门接到活，开始处理：按任务要求生成结果',
  meta: { progress: true, fromRoomId: 'a', phase, ...meta },
});
const input = (receipts, sources = []) => {
  const messagesByRoom = new Map([[dm.id, receipts]]);
  for (const m of sources) messagesByRoom.set(m.roomId, [...(messagesByRoom.get(m.roomId) ?? []), m]);
  return { rooms: [dm], messagesByRoom };
};
const plan = (receipts, sources = []) => planProgressSenderBackfill(input(receipts, sources));
const from = { fromId: 'lead-a', fromName: 'lead-a' };
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

test('明确来源消息补齐 start 来源，保留已有元数据', () => {
  const patches = plan([receipt('s', 'start', { sourceMessageId: 'src', keep: 7 })], [source('src')]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].meta.fromId, 'lead-a');
  assert.equal(patches[0].meta.keep, 7);
});

test('明确来源消息可独立补齐 done 来源，不猜任务结果', () => {
  const [patch] = plan([receipt('d', 'done', { sourceMessageId: 'src' })], [source('src')]);
  assert.equal(patch.meta.fromName, 'lead-a');
  assert.equal(patch.meta.outcome, undefined);
});

test('未来消息即使具有明确 ID 也不作为来源', () => {
  assert.equal(plan([receipt('s', 'start', { sourceMessageId: 'future' })], [source('future', 'a', 'lead-a', 201)]).length, 0);
});

test('执行员自己的确认消息不能作为派活来源', () => {
  assert.equal(plan([receipt('s', 'start', { sourceMessageId: 'echo' })], [source('echo', 'a', 'worker')]).length, 0);
});

test('只有正文相似的历史消息保持未知，包括未来引用确认', () => {
  assert.equal(plan([receipt('s', 'start')], [source('task'), source('echo', 'a', 'worker', 201)]).length, 0);
});

test('来源 ID 不能从另一个部门查找', () => {
  assert.equal(plan([receipt('s', 'start', { sourceMessageId: 'b-src' })], [source('b-src', 'b', 'lead-b')]).length, 0);
});

test('来源消息自己的 roomId 必须与索引房间一致', () => {
  const data = input([receipt('s', 'start', { sourceMessageId: 'src' })]);
  data.messagesByRoom.set('a', [source('src', 'b')]);
  assert.equal(planProgressSenderBackfill(data).length, 0);
});

test('不接受失败消息、重复来源 ID 或缺失时间戳', () => {
  const s = receipt('s', 'start', { sourceMessageId: 'src' });
  assert.equal(plan([s], [{ ...source('src'), status: 'error' }]).length, 0);
  assert.equal(plan([s], [source('src'), source('src')]).length, 0);
  assert.equal(plan([{ ...s, createdAt: undefined }], [source('src')]).length, 0);
});

test('无调度关联的 done 不沿用跨部门最近 start', () => {
  const rows = [
    receipt('a-start', 'start', from),
    receipt('b-start', 'start', { fromRoomId: 'b', fromId: 'lead-b', fromName: 'lead-b' }),
    receipt('a-done', 'done'),
  ];
  assert.equal(plan(rows).length, 0);
});

test('明确调度关联区分跨部门交错完成的任务', () => {
  const rows = [
    receipt('a-start', 'start', { ...from, dispatchId: 'a-run' }),
    receipt('b-start', 'start', { fromRoomId: 'b', fromId: 'lead-b', fromName: 'lead-b', dispatchId: 'b-run' }),
    receipt('a-done', 'done', { dispatchId: 'a-run' }, 300),
    receipt('b-done', 'done', { fromRoomId: 'b', dispatchId: 'b-run' }, 301),
  ];
  assert.deepEqual(plan(rows).map((p) => [p.messageId, p.meta.fromId]), [['a-done', 'lead-a'], ['b-done', 'lead-b']]);
});

test('同部门重叠任务按调度 ID 配对，不按最近消息配对', () => {
  const rows = [
    receipt('a-start', 'start', { ...from, dispatchId: 'a-run' }),
    receipt('b-start', 'start', { fromId: 'lead-b', fromName: 'lead-b', dispatchId: 'b-run' }),
    receipt('a-done', 'done', { dispatchId: 'a-run' }, 300),
  ];
  assert.equal(plan(rows)[0].meta.fromId, 'lead-a');
});

test('新 start 没有可验证来源时不会继承之前任务', () => {
  const rows = [
    receipt('old-start', 'start', { ...from, dispatchId: 'old' }),
    receipt('new-start', 'start', { dispatchId: 'new' }),
    receipt('new-done', 'done', { dispatchId: 'new' }, 300),
  ];
  assert.equal(plan(rows).length, 0);
});

test('调度 ID 相同但来源部门或执行员不同不能串用', () => {
  const start = receipt('s', 'start', { ...from, dispatchId: 'same' });
  assert.equal(plan([start, receipt('d', 'done', { fromRoomId: 'b', dispatchId: 'same' }, 300)]).length, 0);
  assert.equal(plan([start, { ...receipt('d', 'done', { dispatchId: 'same' }, 300), authorId: 'another-worker' }]).length, 0);
});

test('重复 start 或开始晚于完成时不猜配对', () => {
  const start = receipt('s', 'start', { ...from, dispatchId: 'run' });
  const done = receipt('d', 'done', { dispatchId: 'run' }, 300);
  assert.equal(plan([start, { ...start, id: 's2' }, done]).length, 0);
  assert.equal(plan([{ ...start, createdAt: 301 }, done]).length, 0);
});

test('由 start 的显式消息关联恢复 done，并保留 sourceMessageId', () => {
  const rows = [receipt('s', 'start', { sourceMessageId: 'src', dispatchId: 'run' }), receipt('d', 'done', { dispatchId: 'run' }, 300)];
  const patches = plan(rows, [source('src')]);
  assert.equal(patches.length, 2);
  assert.equal(patches[1].meta.sourceMessageId, 'src');
});

test('done 的失效显式来源不由其他 start 覆盖', () => {
  const rows = [receipt('s', 'start', { ...from, dispatchId: 'run' }), receipt('d', 'done', { sourceMessageId: 'missing', dispatchId: 'run' }, 300)];
  assert.equal(plan(rows).length, 0);
});

test('完整来源不覆盖，部分来源发生冲突则保持原状', () => {
  assert.equal(plan([receipt('s', 'start', { fromId: 'saved', fromName: 'saved', sourceMessageId: 'src' })], [source('src')]).length, 0);
  assert.equal(plan([receipt('s', 'start', { fromId: 'saved', sourceMessageId: 'src' })], [source('src')]).length, 0);
});

test('规划不修改输入，应用补全后再次规划幂等', () => {
  const rows = [receipt('s', 'start', { sourceMessageId: 'src' })];
  const before = JSON.stringify(rows);
  const patches = plan(rows, [source('src')]);
  assert.equal(JSON.stringify(rows), before);
  const updated = rows.map((m) => ({ ...m, meta: patches.find((p) => p.messageId === m.id)?.meta ?? m.meta }));
  assert.equal(plan(updated, [source('src')]).length, 0);
});

console.log(`\n回执来源规划：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
