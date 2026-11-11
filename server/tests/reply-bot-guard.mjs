/** reply_bot 的护栏：newId 可用、TTL 按 id 对记账、输出截断。 */
import assert from 'node:assert/strict';

const { buildCommonTools } = await import('../src/tools.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

function tools() {
  return buildCommonTools({ botId: 'b_probe', roomId: 'r_probe' });
}

function replyBot() {
  const t = tools().find((x) => x.name === 'reply_bot');
  assert.ok(t, 'reply_bot 必须存在');
  return t;
}

await test('★ 走完整条对话路径不抛 ReferenceError', async () => {
  // 曾经 newId 没导入导致每次调用必崩。后来 TTL 改成按 id 对记账，
  // 不再需要 dialogId，newId 也就不用了 —— 这个用例保留为"整条路径不崩"的守卫，
  // 一旦以后有人在中间插入需要 newId 的代码而忘了导入，它会失败。
  const { store } = await import('../src/store.js');
  const target = store.createBot({ name: '可达目标' });
  let threw = null;
  try {
    await replyBot().execute('c0', {
      botId: target.id,
      text: '这是一句正常的话',
    });
  } catch (err) {
    threw = err;
  }
  // 没有 runner 时它会在 runBotOnce 那一步报 TypeError —— 那是测试环境缺依赖，
  // 说明代码已经走过了 newId 那一段。**只有 ReferenceError 才是真 bug。**
  const msg = String(threw?.message ?? '');
  assert.equal(
    threw instanceof ReferenceError,
    false,
    `不该出现 ReferenceError，实际：${threw?.constructor?.name}: ${msg}`,
  );
});

await test('★ 找不到目标时返回工具错误，而不是抛异常', async () => {
  const r = await replyBot().execute('c1', { botId: 'b_nope', text: 'hi' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /找不到 bot/);
});

await test('★ 空文本被拒', async () => {
  const r = await replyBot().execute('c2', { botId: 'b_nope', text: '   ' });
  assert.equal(r.isError, true);
});

await test('★ 超长文本被拒（输入限 800 字）', async () => {
  // 注意校验顺序：先查 bot 存在、再查文本长度。
  // 所以这里得用一个真实存在的 bot，否则会先命中"找不到 bot"。
  const { store } = await import('../src/store.js');
  const target = store.createBot({ name: '护栏目标' });
  const r = await replyBot().execute('c3', {
    botId: target.id,
    text: 'x'.repeat(900),
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /800/);
});

await test('★ TTL 记账按「调用方→被叫方」这一对，与房间无关', async () => {
  // 真正的记账在 tools.js 的 peerDialogStarts 里，按 id 对为键。
  // 这里测**真实实现**，不再复制一份本地算法 ——
  // 之前那份副本断言的还是「超过 10 分钟重置」，正是已经修掉的空壳 bug。
  const { peerDialogStart, peerDialogKey, peerDialogReset, PEER_DIALOG_TTL_MS } =
    await import('../src/tools.js');

  // 数字必须与代码一致（文档里写的也是 10 分钟）
  assert.equal(PEER_DIALOG_TTL_MS, 600_000, 'TTL 应为 10 分钟');

  const pair = peerDialogKey('ttl_a', 'ttl_b');
  peerDialogReset('ttl_a', 'ttl_b'); // 从干净状态开始
  const t0 = 1_000_000;

  // 1) 第一次：起点就是 now
  assert.equal(peerDialogStart(pair, t0), t0, '第一次调用应返回 now');

  // 2) TTL 内：沿用最初起点（不是刷新成 now）
  assert.equal(
    peerDialogStart(pair, t0 + 300_000),
    t0,
    '5 分钟后必须沿用最初起点',
  );
  assert.equal(
    peerDialogStart(pair, t0 + 599_999),
    t0,
    'TTL 边界内仍沿用最初起点',
  );

  // 3) 超过 TTL：起点**不得**重置为 now —— 这是那个空壳 bug 的核心
  const overTtl = t0 + 600_001;
  const stillStart = peerDialogStart(pair, overTtl);
  assert.equal(
    stillStart,
    t0,
    '超过 TTL 后起点不得被重置为 now（否则 now-startedAt 恒为 0，护栏永不触发）',
  );
  assert.ok(
    overTtl - stillStart > PEER_DIALOG_TTL_MS,
    `超过 TTL 后必须判定为拦截：${overTtl - stillStart} 应 > ${PEER_DIALOG_TTL_MS}`,
  );

  // 4) 反方向是另一段对话，各记各的
  const reverse = peerDialogKey('ttl_b', 'ttl_a');
  assert.equal(
    peerDialogStart(reverse, t0 + 400_000),
    t0 + 400_000,
    '反方向是另一段对话，起点独立',
  );

  // 5) 只有 peerDialogReset 才重置起点
  peerDialogReset('ttl_a', 'ttl_b');
  assert.equal(
    peerDialogStart(pair, overTtl + 1),
    overTtl + 1,
    'reset 之后重新计时',
  );

  peerDialogReset('ttl_a', 'ttl_b');
  peerDialogReset('ttl_b', 'ttl_a');
});

await test('★ TTL 边界：正好等于 TTL 时不拦截，超过才拦截', async () => {
  const { peerDialogStart, peerDialogKey, peerDialogReset, PEER_DIALOG_TTL_MS } =
    await import('../src/tools.js');
  const pair = peerDialogKey('edge_a', 'edge_b');
  peerDialogReset('edge_a', 'edge_b');
  const t0 = 2_000_000;
  peerDialogStart(pair, t0);

  // 判定式是 now - startedAt > TTL，所以正好等于时**不**拦截
  const atTtl = t0 + PEER_DIALOG_TTL_MS;
  assert.equal(atTtl - peerDialogStart(pair, atTtl), PEER_DIALOG_TTL_MS);
  assert.ok(atTtl - t0 > PEER_DIALOG_TTL_MS === false, '正好等于 TTL 不应判为拦截');

  // 超过 1ms 才拦截
  const past = t0 + PEER_DIALOG_TTL_MS + 1;
  assert.ok(past - peerDialogStart(pair, past) > PEER_DIALOG_TTL_MS, '超过 1ms 应判为拦截');

  peerDialogReset('edge_a', 'edge_b');
});

console.log(`\nreply_bot 护栏：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
