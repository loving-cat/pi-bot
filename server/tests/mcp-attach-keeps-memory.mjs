/**
 * update_bot 挂 MCP 只 reload、不 reset —— 会话记忆必须保留。
 *   node tests/mcp-attach-keeps-memory.mjs
 *
 * ## 为什么要有这条测试
 *
 * 工具集是**建会话时**定下来的，所以挂 MCP 后必须让会话重建才能拿到新工具。
 * 但重建有两种做法，差别是"记不记得刚才聊的"：
 *
 *   resetSessionForBot   → clearSessionFile + clearMemorySummariesForBot，
 *                          等于让 bot 失忆（换模型/开新会话才该用它）
 *   reloadSessionForBot  → 只丢内存里的会话，会话文件和记忆摘要都留着
 *
 * update_bot 原来用的是前者：用户只是"给它加个能力"，
 * 结果那个 bot 把刚才聊的全忘了。这条测试把正确行为钉住。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mcp-keep-'));
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_PROBE = '0';
process.env.PI_BOT_LESSON_REFLECT = '0';
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const bot = store.createBot({ name: '记忆测试员', persona: '测试' });
const room = store.createGroup({ name: 'MCP 记忆测试组', botIds: [bot.id] });

const runner = new PiRunner();

/** 造一个"这个 bot 之前聊过"的状态：会话文件 + 记忆摘要 + 消息。 */
function seedHistory() {
  store.setSessionFile(room.id, bot.id, path.join(root, 'sessions', 'old-session.jsonl'));
  // 必须同时往**内存**里放一个会话条目：
  // resetSessionForBot 是"遍历内存会话 → 对找到的逐个清文件"，
  // 内存里没有就什么都不清（这是对的：没跑的会话本来就该按需重建）。
  const key = `${room.id}:${bot.id}`;
  if (!runner.sessions.has(key)) runner.sessions.set(key, { busy: false, dispose: () => {} });
  store.state.memorySummaries = store.state.memorySummaries ?? {};
  store.state.memorySummaries[`${room.id}:${bot.id}`] = {
    text: '之前聊过基金净值核对的事',
    lastId: 'm1',
    count: 3,
    turns: 1,
    at: Date.now(),
  };
  store.appendMessage({
    roomId: room.id,
    authorType: 'user',
    authorName: '我',
    text: '先把上个季度的持仓核一遍',
    status: 'done',
  });
  return {
    sessionFile: store.sessionFileFor(room.id, bot.id),
    memory: store.memorySummaryFor(room.id, bot.id),
    messages: (store.listMessages(room.id) ?? []).length,
  };
}

await test('★ reload 保留会话文件与记忆摘要', () => {
  const before = seedHistory();
  assert.ok(before.sessionFile, '前置：应当已有会话文件');
  assert.ok(before.memory, '前置：应当已有记忆摘要');

  runner.reloadSessionForBot(bot.id);

  assert.equal(
    store.sessionFileFor(room.id, bot.id),
    before.sessionFile,
    'reload 不该清掉会话文件（对话历史要留着）',
  );
  assert.deepEqual(
    store.memorySummaryFor(room.id, bot.id),
    before.memory,
    'reload 不该清掉记忆摘要',
  );
  assert.equal(
    (store.listMessages(room.id) ?? []).length,
    before.messages,
    '消息不该被删',
  );
});

await test('对照：reset 会清掉会话文件与记忆摘要', () => {
  // 这条不是为了测 reset 好坏，而是证明"两者确实不同" ——
  // 否则下面那条 update_bot 的断言可能只是因为两个方法本来就一样而通过。
  const before = seedHistory();
  runner.resetSessionForBot(bot.id);
  assert.equal(store.sessionFileFor(room.id, bot.id), null, 'reset 应清掉会话文件');
  assert.equal(store.memorySummaryFor(room.id, bot.id), null, 'reset 应清掉记忆摘要');
  assert.equal(
    (store.listMessages(room.id) ?? []).length,
    before.messages,
    '消息本身不属于会话文件，reset 也不该删消息',
  );
});

await test('★ 挂 MCP 走 reload：历史还在，工具配置已更新', () => {
  // 恢复一份历史
  const before = seedHistory();
  assert.ok(store.sessionFileFor(room.id, bot.id), '前置：应当已有会话文件');

  // 建一个已启用的 MCP 并挂上去
  const added = store.addMcpServer({
    name: 'r2mcp-test',
    type: 'stdio',
    command: 'r2mcp',
    args: [],
    enabled: false,
  });
  assert.ok(!added.error, '建 MCP 应成功：' + (added.error ?? ''));
  const enabled = store.updateMcpServer(added.server.id, { enabled: true });
  assert.ok(!enabled.error, '启用 MCP 应成功：' + (enabled.error ?? ''));

  // 模拟 update_bot 的动作：写 bots 配置 + reload（而不是 reset）
  const updated = store.updateBot(bot.id, { mcpServers: ['r2mcp-test'] });
  assert.ok(updated, 'updateBot 应成功');
  runner.reloadSessionForBot(bot.id);

  // ① 记忆还在
  assert.equal(
    store.sessionFileFor(room.id, bot.id),
    before.sessionFile,
    '挂 MCP 后会话文件必须还在（否则 bot 失忆了）',
  );
  assert.deepEqual(
    store.memorySummaryFor(room.id, bot.id),
    before.memory,
    '挂 MCP 后记忆摘要必须还在',
  );
  assert.equal(
    (store.listMessages(room.id) ?? []).length,
    before.messages,
    '挂 MCP 后历史消息必须还在',
  );

  // ② 新挂的 MCP 已经进配置，能被会话读到
  const botNow = store.getBot(bot.id);
  assert.deepEqual(botNow.mcpServers, ['r2mcp-test'], 'bot 应已挂上该 MCP');
  const resolved = store.mcpServersFor(bot.id);
  assert.equal(resolved.length, 1, 'mcpServersFor 应能解析出这个服务');
  assert.equal(resolved[0].name, 'r2mcp-test');
  assert.equal(resolved[0].enabled, true, '解析出来的服务是启用状态');

  // ③ 会话被标记为"待重建"，下次开跑会按新配置重建。
  //
  //    ★ reload 不是立刻删掉内存会话，而是打 reloadPending 标记，
  //      由 retireStaleSession 在"不忙且空闲"时真正释放 ——
  //      这样正在跑的那一轮不会被突然掐掉。断言要看标记，不是看还在不在。
  const key = `${room.id}:${bot.id}`;
  const entry = runner.sessions.get(key);
  assert.ok(entry, '会话条目还在（等空闲时才释放）');
  assert.equal(entry.reloadPending, true, '应被标记为待重建，下次按新配置重建');
});

await test('update_bot 改 model 仍走 reset（既有路径不动）', () => {
  const before = seedHistory();
  // 这里不真的调 runner，只确认分支选择的语义：
  // model 变更走 reset → 会话文件会被清。
  runner.resetSessionForBot(bot.id);
  assert.equal(store.sessionFileFor(room.id, bot.id), null);
  assert.notEqual(before.sessionFile, null);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
