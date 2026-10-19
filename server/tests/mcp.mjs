/**
 * MCP 服务库：规范化、校验、转换、选中逻辑。
 *
 * 盯的是"配了但不能用"这类静默失败：
 *   · 名字带空格/中文 → 工具名非法 → 模型根本调不到
 *   · 把网址填进 command → 起进程失败
 *   · 明文 http 连远端 → key 裸奔
 *   · 服务停用了却仍然被挂载 → 关掉等于没关
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MCP_LIMITS,
  mcpNameError,
  mcpRejectReason,
  normalizeMcpServer,
  normalizeMcpList,
  toMcpServersConfig,
  mcpPromptLines,
  describeMcpServer,
} from '../src/mcp.js';

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

await test('名字必须能当工具前缀用', () => {
  assert.equal(mcpNameError('filesystem'), null);
  assert.equal(mcpNameError('my-server_2'), null);
  assert.match(mcpNameError(''), /需要一个名字/);
  assert.match(mcpNameError('有中文'), /只能用字母/);
  assert.match(mcpNameError('has space'), /只能用字母/);
  assert.match(mcpNameError('-leading'), /只能用字母/);
  assert.match(mcpNameError('a/b'), /只能用字母/);
});

await test('stdio 服务规范化：命令、参数、环境变量', () => {
  const s = normalizeMcpServer({
    name: 'fs',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { DEBUG: '1' },
    description: '读写本地文件',
  });
  assert.equal(s.name, 'fs');
  assert.equal(s.type, 'stdio');
  assert.equal(s.command, 'npx');
  assert.deepEqual(s.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.deepEqual(s.env, { DEBUG: '1' });
  assert.equal(s.description, '读写本地文件');
});

await test('默认不启用：加进来只是待配置，不会偷偷起进程', () => {
  const s = normalizeMcpServer({ name: 'x', command: 'node' });
  assert.equal(s.enabled, false);
  const on = normalizeMcpServer({ name: 'x', command: 'node', enabled: true });
  assert.equal(on.enabled, true);
});

await test('只转换启用中的服务 —— 停用等于真停用', () => {
  const cfg = toMcpServersConfig([
    { name: 'on', type: 'stdio', command: 'node', enabled: true },
    { name: 'off', type: 'stdio', command: 'node', enabled: false },
    { name: 'never', type: 'stdio', command: 'node' },
  ]);
  assert.deepEqual(Object.keys(cfg), ['on']);
});

await test('stdio 缺命令不进配置；http 缺 URL 不进配置', () => {
  assert.deepEqual(
    toMcpServersConfig([{ name: 'a', type: 'stdio', enabled: true }]),
    {},
  );
  assert.deepEqual(
    toMcpServersConfig([{ name: 'b', type: 'http', enabled: true }]),
    {},
  );
});

await test('http 服务规范化：URL 与请求头', () => {
  const s = normalizeMcpServer({
    name: 'remote',
    type: 'http',
    url: 'https://mcp.example.com/v1',
    headers: { Authorization: 'Bearer x' },
  });
  assert.equal(s.url, 'https://mcp.example.com/v1');
  assert.deepEqual(s.headers, { Authorization: 'Bearer x' });
});

await test('校验：把网址填进本地命令会被点名', () => {
  const reason = mcpRejectReason({
    name: 'x',
    type: 'stdio',
    command: 'https://mcp.example.com',
  });
  assert.match(reason, /这是网址，不是命令/);
});

await test('校验：远端明文 http 被拒，本机回环放行', () => {
  assert.match(
    mcpRejectReason({ name: 'x', type: 'http', url: 'http://mcp.example.com/v1' }),
    /请用 https/,
  );
  assert.equal(
    mcpRejectReason({ name: 'x', type: 'http', url: 'http://127.0.0.1:3000/mcp' }),
    null,
  );
  assert.equal(
    mcpRejectReason({ name: 'x', type: 'http', url: 'http://localhost:8080/mcp' }),
    null,
  );
});

await test('校验：URL 必须有协议头', () => {
  assert.match(
    mcpRejectReason({ name: 'x', type: 'http', url: 'mcp.example.com' }),
    /http:\/\/ 或 https:\/\//,
  );
});

await test('校验：本地命令不能跨行', () => {
  assert.match(
    mcpRejectReason({ name: 'x', type: 'stdio', command: 'node\nrm -rf /' }),
    /只能写一行/,
  );
});

await test('校验：超时必须正数且有上限', () => {
  assert.match(mcpRejectReason({ name: 'x', command: 'node', timeout: -1 }), /正数/);
  assert.match(mcpRejectReason({ name: 'x', command: 'node', timeout: 0 }), /正数/);
  assert.match(
    mcpRejectReason({ name: 'x', command: 'node', timeout: MCP_LIMITS.timeoutSeconds + 1 }),
    /不能超过/,
  );
  assert.equal(mcpRejectReason({ name: 'x', command: 'node', timeout: 30 }), null);
});

await test('库去重：同名只留第一条', () => {
  const list = normalizeMcpList([
    { name: 'dup', command: 'node', description: '第一条' },
    { name: 'DUP', command: 'python3', description: '第二条' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].description, '第一条');
});

await test('库忽略没有合法名字的条目', () => {
  const list = normalizeMcpList([
    { name: '', command: 'node' },
    { name: '有中文', command: 'node' },
    { name: 'ok', command: 'node' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'ok');
});

await test('环境变量里的换行和等号键被丢掉', () => {
  const s = normalizeMcpServer({
    name: 'x',
    command: 'node',
    env: { GOOD: 'v', 'BAD=KEY': 'v', 'BAD\nKEY': 'v', EMPTY: '' },
  });
  assert.deepEqual(s.env, { GOOD: 'v', EMPTY: '' });
});

await test('工具名暴露方式只认 pi 支持的取值', () => {
  assert.equal(normalizeMcpServer({ name: 'x', command: 'n', exposure: 'direct' }).exposure, 'direct');
  assert.equal(normalizeMcpServer({ name: 'x', command: 'n', exposure: '乱写' }).exposure, 'direct');
  assert.equal(normalizeMcpServer({ name: 'x', command: 'n', exposure: 'hidden' }).exposure, 'hidden');
});

await test('提示词清单列出服务及启用状态', () => {
  const text = mcpPromptLines([
    { name: 'fs', type: 'stdio', command: 'npx', args: ['server-fs'], enabled: true, description: '读写文件' },
    { name: 'web', type: 'http', url: 'https://x.example.com', description: '网页抓取' },
  ]);
  assert.match(text, /fs（可用）/);
  assert.match(text, /web（未启用）/);
  assert.match(text, /读写文件/);
  assert.match(text, /npx server-fs/);
});

await test('没有服务时提示词清单为空串（不占上下文）', () => {
  assert.equal(mcpPromptLines([]), '');
  assert.equal(mcpPromptLines([{ name: '' }]), '');
});

await test('摘要能区分本地与远端', () => {
  assert.match(describeMcpServer({ name: 'a', type: 'stdio', command: 'node' }), /本地/);
  assert.match(describeMcpServer({ name: 'b', type: 'http', url: 'https://x' }), /HTTP/);
});

// ---- 存储层：bot 选中逻辑 ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-mcp-'));
const inherited = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']);
for (const name of Object.keys(process.env)) {
  if (!inherited.has(name)) delete process.env[name];
}
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_DATA_DIR = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { store } = await import('../src/store.js');

await test('store：增删改 MCP 服务', () => {
  const added = store.addMcpServer({ name: 'fs', command: 'npx', args: ['server-fs'] });
  assert.ok(!added.error, added.error);
  assert.equal(store.mcpLibrary().length, 1);

  const updated = store.updateMcpServer(added.server.id, { enabled: true });
  assert.ok(!updated.error, updated.error);
  assert.equal(updated.server.enabled, true);

  const removed = store.removeMcpServer(added.server.id);
  assert.ok(removed.ok);
  assert.equal(store.mcpLibrary().length, 0);
});

await test('store：同名服务被拒', () => {
  store.addMcpServer({ name: 'dup', command: 'node' });
  const again = store.addMcpServer({ name: 'dup', command: 'node' });
  assert.match(again.error, /已经有同名服务/);
});

await test('store：bot 选中按名字解析，且只返回已启用的能用的', () => {
  const a = store.addMcpServer({ name: 'alpha', command: 'node', enabled: true });
  store.addMcpServer({ name: 'beta', command: 'node', enabled: false });
  const bot = store.createBot({ name: '测试员', persona: 'x', mcpServers: ['alpha', 'beta'] });
  const resolved = store.mcpServersFor(bot.id);
  // 两个都选上了，但解析出来是两个（enabled 在转 provider 配置时才过滤）
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved.map((s) => s.name).sort(), ['alpha', 'beta']);
  // 转换时只保留启用的那个
  const cfg = toMcpServersConfig(resolved);
  assert.deepEqual(Object.keys(cfg), ['alpha']);
});

await test('store：bot 没配 MCP 时返回空数组（默认不连）', () => {
  const bot = store.createBot({ name: '干净的人', persona: 'x' });
  assert.deepEqual(store.mcpServersFor(bot.id), []);
  assert.deepEqual(bot.mcpServers, []);
});

await test('store：bot 里存不存在的名字被忽略，不炸', () => {
  const bot = store.createBot({ name: '乱填的人', persona: 'x', mcpServers: ['不存在的'] });
  assert.deepEqual(store.mcpServersFor(bot.id), []);
});

await test('store：非法名字在 bot 字段里被丢掉', () => {
  const bot = store.createBot({
    name: 'x', persona: 'x', mcpServers: ['good-name', '有中文', 'has space', 'good-name'],
  });
  assert.deepEqual(bot.mcpServers, ['good-name']);
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
