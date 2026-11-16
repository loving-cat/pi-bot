/**
 * 派活交付落点（产品决定 2026-11-16）：纯逻辑测试。
 *   node tests/delegated-delivery.mjs
 *
 * ## 守什么
 *
 * 这件事做错了用户会看到**同一份结果两遍**，或者更糟：**一遍都看不到**。
 *
 *   · 搬到派活房间时把上一轮的旧答复又搬一遍 → 重复；
 *   · 把成员那边的内容标成 internal 却没搬 → 交付物消失；
 *   · 附件复制成两份 → 存储里多一份，删的时候删不干净。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { collectDelegatedArtifacts, mirrorDelegatedResult } = await import(src('delegated-delivery.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const START = 1_700_000_000_000;
const msg = (over) => ({
  id: 'm', roomId: 'dm_worker', authorType: 'bot', authorId: 'w1',
  text: '', createdAt: START + 1000, kind: '', attachments: [], meta: {}, ...over,
});

// ---------------------------------------------------------------- 挑什么
test('只认时间窗之后、这个 bot 写的消息（不搬上一轮的旧答复）', () => {
  const a = collectDelegatedArtifacts({
    workerId: 'w1',
    since: START,
    messages: [
      msg({ id: 'old', text: '上一轮的答复', createdAt: START - 60_000 }),
      msg({ id: 'new', text: '这次的答复', createdAt: START + 2000 }),
    ],
  });
  assert.equal(a.text, '这次的答复');
  assert.equal(a.picked, 1);
});

test('运行结果里的正文优先（它比消息更完整）', () => {
  const a = collectDelegatedArtifacts({
    workerId: 'w1', since: START,
    messages: [msg({ text: '流式里的半截' })],
    finalText: '完整答复\n第二段',
  });
  assert.match(a.text, /完整答复/);
});

test('没有 finalText 时取最后一条有正文的', () => {
  const a = collectDelegatedArtifacts({
    workerId: 'w1', since: START,
    messages: [msg({ id: 'a', text: '第一段' }), msg({ id: 'b', text: '   ' }), msg({ id: 'c', text: '最后' })],
  });
  assert.equal(a.text, '最后');
});

test('★ 附件按 id 去重（同一个文件只带一次）', () => {
  const f1 = { id: 'att_1', name: 'a.png', mime: 'image/png' };
  const f2 = { id: 'att_2', name: 'b.png', mime: 'image/png' };
  const a = collectDelegatedArtifacts({
    workerId: 'w1', since: START,
    messages: [
      msg({ id: 'm1', attachments: [f1] }),
      msg({ id: 'm2', attachments: [f1, f2] }),
    ],
  });
  assert.deepEqual(a.attachments.map((x) => x.id), ['att_1', 'att_2']);
});

test('别的 bot 的消息不算（同一个私聊里可能混着别人）', () => {
  const a = collectDelegatedArtifacts({
    workerId: 'w1', since: START,
    messages: [msg({ authorId: 'w2', text: '别人的话' })],
  });
  assert.equal(a.text, '');
  assert.equal(a.picked, 0);
});

test('ref / compact 这类内部消息不搬', () => {
  const a = collectDelegatedArtifacts({
    workerId: 'w1', since: START,
    messages: [msg({ id: 'r', kind: 'ref', text: '指针' }), msg({ id: 'c', kind: 'compact', text: '压缩提示' })],
  });
  assert.equal(a.text, '');
});

// ---------------------------------------------------------------- 落盘
function fakeStore({ workerMessages = [] } = {}) {
  const rooms = new Map([['dm_worker', workerMessages.map((m) => ({ ...m }))], ['dm_caller', []]]);
  const updated = [];
  return {
    rooms,
    updated,
    listMessages: (roomId) => rooms.get(roomId) ?? [],
    updateMessage: (roomId, id, patch) => {
      updated.push({ roomId, id, patch });
      const m = (rooms.get(roomId) ?? []).find((x) => x.id === id);
      if (m) Object.assign(m, patch);
      return m;
    },
    appendMessage: (partial) => {
      const m = { id: 'm_mirror', createdAt: START + 5000, ...partial };
      (rooms.get(partial.roomId) ?? []).push(m);
      return m;
    },
  };
}

test('★ 交付物搬到派活房间；成员那边标 internal', () => {
  const worker = { id: 'w1', name: '平台开发工程师', emoji: '🛠️' };
  const store = fakeStore({
    workerMessages: [
      msg({ id: 'm1', text: '我先看看窗口' }),
      msg({ id: 'm2', text: '播放成功', attachments: [{ id: 'att_9', name: 'proof.png' }] }),
    ],
  });
  const r = mirrorDelegatedResult({
    store, callerRoomId: 'dm_caller', workerRoomId: 'dm_worker',
    worker, callerId: 'b_main', since: START, finalText: '播放成功',
  });
  assert.equal(r.messageId, 'm_mirror');
  assert.equal(r.attachments, 1);
  assert.equal(r.marked, 2, '两条过程都要标 internal');

  const caller = store.rooms.get('dm_caller');
  assert.equal(caller.length, 1);
  assert.equal(caller[0].authorId, 'w1', '作者是干活的人，不是派活的人');
  assert.equal(caller[0].kind, 'delegated');
  assert.equal(caller[0].attachments[0].id, 'att_9', '★ 复用同一个 attachment id，不复制文件');
  assert.equal(caller[0].meta.from, 'b_main', '看得出来是谁派的');

  // 成员那边还在（可查），只是标了 internal
  const workerRoom = store.rooms.get('dm_worker');
  assert.equal(workerRoom.length, 2);
  assert.ok(workerRoom.every((m) => m.meta.internal === true));
});

test('没有内容就不产生空消息（避免聊天里冒出空气泡）', () => {
  const store = fakeStore({ workerMessages: [] });
  const r = mirrorDelegatedResult({
    store, callerRoomId: 'dm_caller', workerRoomId: 'dm_worker',
    worker: { id: 'w1', name: 'x' }, callerId: 'b_main', since: START,
  });
  assert.equal(r.messageId, null);
  assert.equal(store.rooms.get('dm_caller').length, 0);
});

test('缺参数不炸（调用方写错时静默不动，不要让派活失败）', () => {
  assert.equal(mirrorDelegatedResult({}).messageId, null);
  assert.equal(mirrorDelegatedResult({ store: fakeStore() }).messageId, null);
});

test('★ 已经标过 internal 的不重复标（重复调用幂等）', () => {
  const store = fakeStore({ workerMessages: [msg({ id: 'm1', text: 'a', meta: { internal: true } })] });
  const r = mirrorDelegatedResult({
    store, callerRoomId: 'dm_caller', workerRoomId: 'dm_worker',
    worker: { id: 'w1' }, callerId: 'b_main', since: START, finalText: 'a',
  });
  assert.equal(r.marked, 0);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
