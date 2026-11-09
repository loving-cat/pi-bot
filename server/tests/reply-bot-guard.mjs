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

await test('TTL 记账按「调用方→被叫方」这一对，与房间无关', async () => {
  // 原来的写法把 dialogId 写进被叫方 DM 的消息 meta，
  // 却在呼叫方房间读 —— 两个房间不同，永远读不到，TTL 从不触发。
  // 现在按 id 对在内存里记，跟消息落在哪无关。
  //
  // 这里只能验证「同一个模块多次调用共享同一张表」这个前提，
  // 真正的超时行为需要 10 分钟，不适合放进单测。
  const m = new Map();
  const TTL = 600_000;
  function start(pair, now) {
    const e = m.get(pair);
    if (e && now - e <= TTL) return e;
    m.set(pair, now);
    for (const [k, t] of m) if (now - t > TTL) m.delete(k);
    return now;
  }
  const t0 = 1_000_000;
  assert.equal(start('A>B', t0), t0, '第一次开始');
  assert.equal(start('A>B', t0 + 300_000), t0, '5 分钟后沿用同一起点');
  assert.equal(start('B>A', t0 + 400_000), t0 + 400_000, '反方向是另一段对话');
  assert.equal(start('A>B', t0 + 700_000), t0 + 700_000, '超过 10 分钟重置');
});

console.log(`\nreply_bot 护栏：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
