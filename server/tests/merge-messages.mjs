/**
 * 多段消息合并：用户连发几条时，让模型一次看到完整意图。
 *
 * 盯的是三个容易做错的点：
 *   · 单条也被包装（模型会以为用户在说三条，自己乱编号）
 *   · 一直在输入导致永远不投递（必须有最长等待）
 *   · 投递过程中新消息被吸进同一次 flush（会无限续期）
 */
import assert from 'node:assert/strict';

import {
  MERGE_MAX_WAIT_MS,
  MERGE_QUIET_MS,
  MergeQueue,
  mergeUserMessages,
} from '../src/merge-messages.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

await test('单条消息原样返回，不加任何包装', () => {
  assert.equal(mergeUserMessages(['你好']), '你好');
  assert.equal(mergeUserMessages(['  前后有空格  ']), '前后有空格');
});

await test('单条消息不会告诉模型"这是几条"', () => {
  const text = mergeUserMessages(['帮我看下这个系统']);
  assert.ok(!text.includes('连着发'), '单条不该出现合并提示');
  assert.ok(!text.includes('1.'), '单条不该编号');
});

await test('多条消息合起来，并明确告知模型这是一件事', () => {
  const text = mergeUserMessages([
    '帮我看下这个系统',
    'https://xxx.com',
    '账号 admin 密码 123',
  ]);
  assert.match(text, /连着发了几条/, '要让模型知道这是连发的');
  assert.match(text, /1\. 帮我看下这个系统/);
  assert.match(text, /3\. 账号 admin 密码 123/);
});

await test('空消息被丢掉，不会产生空条目', () => {
  const text = mergeUserMessages(['a', '', '  ', 'b']);
  assert.match(text, /1\. a/);
  assert.match(text, /2\. b/);
  assert.ok(!text.includes('3.'));
});

await test('全是空消息时返回空串', () => {
  assert.equal(mergeUserMessages(['', '  ']), '');
  assert.equal(mergeUserMessages([]), '');
});

await test('静默窗口内连发的几条会被合并成一次投递', async () => {
  const calls = [];
  const q = new MergeQueue({
    quietMs: 100,
    flush: async (roomId, merged, parts) => {
      calls.push({ roomId, merged, parts });
    },
  });

  q.push('r1', '第一条');
  q.push('r1', '第二条');
  q.push('r1', '第三条');
  assert.equal(q.pendingCount('r1'), 3, '应该都攒着');

  await new Promise((r) => setTimeout(r, 180));

  assert.equal(calls.length, 1, '只投递一次');
  assert.equal(calls[0].parts.length, 3);
  assert.match(calls[0].merged, /连着发了几条/);
  assert.ok(!q.hasPending('r1'), '投递后队列应清空');
});

await test('间隔超过静默窗口时分两次投递', async () => {
  const calls = [];
  const q = new MergeQueue({
    quietMs: 80,
    flush: async (roomId, merged, parts) => {
      calls.push(parts.length);
    },
  });

  q.push('r1', '第一批');
  await new Promise((r) => setTimeout(r, 150));
  q.push('r1', '第二批');
  await new Promise((r) => setTimeout(r, 150));

  assert.deepEqual(calls, [1, 1], '两次独立投递');
});

await test('★ 一直在输入也会在最长等待后强制投递', async () => {
  const calls = [];
  const q = new MergeQueue({
    quietMs: 5000, // 故意设很大：模拟"用户一直不停手"
    maxWaitMs: 100,
    flush: async (roomId, merged, parts) => {
      calls.push(parts.length);
    },
  });

  q.push('r1', 'a');
  // 用户还在敲，静默窗口永远不到期
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(calls.length, 1, '到最长等待必须发出去，不能一直攒');
});

await test('★ 投递中的新消息不会被吸进同一次 flush', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const q = new MergeQueue({
    quietMs: 50,
    flush: async (roomId, merged, parts) => {
      seen.push(parts.slice());
      await gate; // 卡住第一次投递
    },
  });

  q.push('r1', '第一批');
  await new Promise((r) => setTimeout(r, 80));
  // 此时第一次 flush 正在 await
  q.push('r1', '第二批');
  assert.equal(q.pendingCount('r1'), 1, '新消息应该开新槽');

  release();
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(seen.length, 2, '应该是两次独立投递');
  assert.deepEqual(seen[0], ['第一批']);
  assert.deepEqual(seen[1], ['第二批']);
});

await test('drop 能清掉攒着的内容（终止时用）', async () => {
  const calls = [];
  const q = new MergeQueue({
    quietMs: 60,
    flush: async () => calls.push(1),
  });
  q.push('r1', '会被丢掉');
  q.drop('r1');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.length, 0, 'drop 之后不该再投递');
});

await test('★ 终止时要能丢掉攒着的（否则像"停不住"）', async () => {
  const calls = [];
  const q = new MergeQueue({
    quietMs: 60,
    flush: async () => calls.push(1),
  });
  q.push('r1', '刚攒的一条');
  // 用户按停止 → runner.abort 会调 drop
  q.drop('r1');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.length, 0, 'drop 之后不该再冒出一条消息');
});

await test('flushAll 立刻投递所有房间', async () => {
  const rooms = [];
  const q = new MergeQueue({
    quietMs: 10_000, // 静默窗口设很大，只能靠 flushAll
    flush: async (roomId) => rooms.push(roomId),
  });
  q.push('r1', 'a');
  q.push('r2', 'b');
  await q.flushAll();
  assert.deepEqual(rooms.sort(), ['r1', 'r2']);
});

await test('不同房间互不干扰', async () => {
  const got = [];
  const q = new MergeQueue({
    quietMs: 60,
    flush: async (roomId, merged, parts) => got.push({ roomId, n: parts.length }),
  });
  q.push('r1', 'a');
  q.push('r2', 'b');
  q.push('r2', 'c');
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(got.length, 2);
  const r1 = got.find((g) => g.roomId === 'r1');
  const r2 = got.find((g) => g.roomId === 'r2');
  assert.equal(r1.n, 1);
  assert.equal(r2.n, 2);
});

await test('默认窗口足够短（不能让人感觉卡顿）', () => {
  assert.ok(MERGE_QUIET_MS <= 1000, `静默窗口 ${MERGE_QUIET_MS}ms 太长了`);
  assert.ok(MERGE_MAX_WAIT_MS <= 6000, `最长等待 ${MERGE_MAX_WAIT_MS}ms 太长了`);
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
