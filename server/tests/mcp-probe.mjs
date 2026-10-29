/** MCP 探测回归：只连接测试创建的随机端口和合成 stdio 服务。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { probeMcpServer } from '../src/mcp-probe.js';
import { stopMcpProbeProcess } from '../src/mcp-probe-cleanup.js';
import { PROBE_LIMITS } from '../src/mcp-probe-protocol.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-probe-server.mjs', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-mcp-probe-'));
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.log(`✗ ${name}: ${error.message}`); }
}

const tool = (name = 'query') => ({ name, title: '测试工具', description: '合成工具', inputSchema: { type: 'object' } });
const init = (extra = {}) => ({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' }, ...extra });

async function withServer(handler, fn) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, headers: req.headers, message });
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    if (message?.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    const send = (result, options = {}) => {
      res.writeHead(options.status ?? 200, { 'content-type': 'application/json', ...options.headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    try { await handler({ req, res, message, send, requests }); }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try { await fn(url, requests, sockets); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

await test('HTTP 完成初始化、通知和工具发现并传递会话头', async () => {
  await withServer(({ message, send }) => {
    send(message.method === 'initialize' ? init() : { tools: [tool()] }, { headers: { 'mcp-session-id': 'fixture-session' } });
  }, async (url, requests) => {
    const result = await probeMcpServer({ type: 'http', url });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'ready');
    assert.equal(result.toolCount, 1);
    assert.equal(result.tools[0].name, 'query');
    assert.deepEqual(requests.map((r) => r.message?.method ?? r.method), ['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
    assert.equal(requests[2].headers['mcp-session-id'], 'fixture-session');
    assert.equal(requests[2].headers['mcp-protocol-version'], '2025-11-25');
  });
});

await test('零工具目录合法', async () => {
  await withServer(({ message, send }) => send(message.method === 'initialize' ? init() : { tools: [] }), async (url) => {
    const result = await probeMcpServer({ type: 'http', url });
    assert.equal(result.ok, true);
    assert.equal(result.toolCount, 0);
  });
});

await test('没有 tools 能力时不伪造工具调用', async () => {
  await withServer(({ send }) => send(init({ capabilities: {} })), async (url, requests) => {
    const result = await probeMcpServer({ type: 'http', url });
    assert.equal(result.ok, true);
    assert.equal(result.toolCount, 0);
    assert.equal(requests.filter((r) => r.message?.method === 'tools/list').length, 0);
  });
});

await test('HTTP 200 的普通健康响应不能冒充 MCP', async () => {
  await withServer(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, async (url) => {
    const result = await probeMcpServer({ type: 'http', url });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'protocol_error');
  });
});

await test('HTTP 200 HTML 页面不能冒充 MCP', async () => {
  await withServer(({ res }) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>login</p>'); }, async (url) => {
    assert.equal((await probeMcpServer({ type: 'http', url })).errorCode, 'protocol_error');
  });
});

for (const status of [401, 403]) {
  await test(`HTTP ${status} 归类为需授权且不回显响应`, async () => {
    await withServer(({ res }) => { res.writeHead(status); res.end('fixture-secret-not-for-output'); }, async (url) => {
      const result = await probeMcpServer({ type: 'http', url });
      assert.equal(result.state, 'auth_required');
      assert.equal(result.errorCode, 'auth_required');
      assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    });
  });
}

await test('JSON-RPC error 返回失败且不回显服务端错误', async () => {
  await withServer(({ res, message }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'fixture-secret-value' } }));
  }, async (url) => {
    const result = await probeMcpServer({ type: 'http', url });
    assert.equal(result.errorCode, 'rpc_error');
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  });
});

await test('不支持的协议版本不能记为可用', async () => {
  await withServer(({ send }) => send(init({ protocolVersion: '2099-01-01' })), async (url) => {
    assert.equal((await probeMcpServer({ type: 'http', url })).errorCode, 'unsupported_protocol');
  });
});

await test('按游标发现多页工具', async () => {
  await withServer(({ message, send }) => {
    send(message.method === 'initialize' ? init() : message.params?.cursor ? { tools: [tool('two')] } : { tools: [tool('one')], nextCursor: 'page2' });
  }, async (url, requests) => {
    const result = await probeMcpServer({ type: 'http', url });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools.map((t) => t.name), ['one', 'two']);
    assert.equal(requests.at(-1).message.params.cursor, 'page2');
  });
});

await test('循环游标被拒绝', async () => {
  await withServer(({ message, send }) => send(message.method === 'initialize' ? init() : { tools: [], nextCursor: 'same' }), async (url) => {
    assert.equal((await probeMcpServer({ type: 'http', url })).errorCode, 'pagination');
  });
});

await test('工具数量有上限', async () => {
  await withServer(({ message, send }) => send(message.method === 'initialize' ? init() : { tools: Array.from({ length: PROBE_LIMITS.tools + 1 }, (_, i) => tool(`t${i}`)) }), async (url) => {
    assert.equal((await probeMcpServer({ type: 'http', url })).errorCode, 'response_limit');
  });
});

await test('重复工具名和非法 schema 不得显示为已验证', async () => {
  for (const tools of [[tool(), tool()], [{ name: 'bad', inputSchema: [] }]]) {
    await withServer(({ message, send }) => send(message.method === 'initialize' ? init() : { tools }), async (url) => {
      assert.equal((await probeMcpServer({ type: 'http', url })).errorCode, 'protocol_error');
    });
  }
});

await test('SSE 多行数据及长连接在对应响应到达后完成', async () => {
  await withServer(({ message, res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keepalive\n\n');
    res.write('data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n');
    const result = message.method === 'initialize' ? init() : { tools: [tool('sse_query')] };
    res.write(`data: {"jsonrpc":"2.0","id":${message.id},\ndata: "result":${JSON.stringify(result)}}\n\n`);
  }, async (url) => {
    const result = await probeMcpServer({ type: 'http', url }, { timeoutMs: 1500 });
    assert.equal(result.ok, true);
    assert.equal(result.tools[0].name, 'sse_query');
    assert.ok(result.ms < 1200);
  });
});

await test('SSE 不执行服务发起的采样请求', async () => {
  await withServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"jsonrpc":"2.0","id":"remote1","method":"sampling/createMessage","params":{}}\n\n');
  }, async (url) => {
    assert.equal((await probeMcpServer({ type: 'http', url })).errorCode, 'server_request');
  });
});

await test('SSE 无结果保持连接会超时', async () => {
  await withServer(({ res }) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); }, async (url) => {
    assert.equal((await probeMcpServer({ type: 'http', url }, { timeoutMs: 100 })).errorCode, 'timeout');
  });
});

await test('响应字节上限终止无限数据', async () => {
  await withServer(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(PROBE_LIMITS.bytes + 1)); }, async (url) => {
    assert.equal((await probeMcpServer({ type: 'http', url })).errorCode, 'response_limit');
  });
});

await test('重定向不会携带凭据去第二个地址', async () => {
  let redirectedCalls = 0;
  await withServer(({ send }) => { redirectedCalls++; send(init()); }, async (other) => {
    await withServer(({ res }) => { res.writeHead(302, { location: other }); res.end(); }, async (url) => {
      const result = await probeMcpServer({ type: 'http', url, headers: { Authorization: 'fixture-secret-value' } });
      assert.equal(result.errorCode, 'redirect');
      assert.equal(redirectedCalls, 0);
    });
  });
});

await test('元数据地址在发请求前拒绝', async () => {
  const result = await probeMcpServer({ type: 'http', url: 'https://169.254.169.254/mcp' });
  assert.equal(result.errorCode, 'unsafe_target');
});

await test('用户信息地址、明文远端和请求头注入被拒绝', async () => {
  for (const server of [
    { url: 'https://user:fixture-secret@example.test/mcp' },
    { url: 'http://example.test/mcp' },
    { url: 'http://localhost:1/mcp', headers: { Host: 'example.test' } },
    { url: 'http://localhost:1/mcp', headers: { Authorization: 'value\r\ninjected:true' } },
  ]) {
    assert.equal((await probeMcpServer({ type: 'http', ...server })).errorCode, 'invalid_config');
  }
});

await test('直连使用已经校验的 DNS 地址且不再次解析', async () => {
  await withServer(({ message, send }) => send(message.method === 'initialize' ? init() : { tools: [] }), async (url, requests) => {
    let lookups = 0;
    const result = await probeMcpServer({ type: 'http', url: url.replace('127.0.0.1', 'localhost') }, {
      lookup: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; },
    });
    assert.equal(result.ok, true);
    assert.equal(lookups, requests.length);
    assert.equal(requests.length, 3);
  });
});

await test('DNS 返回元数据地址时不连接其它地址', async () => {
  await withServer(({ send }) => send(init()), async (url, requests) => {
    const result = await probeMcpServer({ type: 'http', url: url.replace('127.0.0.1', 'localhost') }, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }],
    });
    assert.equal(result.errorCode, 'unsafe_target');
    assert.equal(requests.length, 0);
  });
});

await test('固定代理收到 CONNECT，失败后验证失败', async () => {
  let connections = 0;
  const proxy = http.createServer();
  proxy.on('connect', (_request, socket) => {
    connections++;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probeMcpServer({ type: 'http', url: 'https://proxy-fixture.example.test/mcp' }, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      currentProxy: async () => `http://127.0.0.1:${proxy.address().port}`,
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'network');
    assert.ok(connections > 0);
  } finally { await new Promise((resolve) => proxy.close(resolve)); }
});

await test('stdio 真正发现工具并在验证结束后退出', async () => {
  const pidFile = path.join(temporary, 'pid');
  const result = await probeMcpServer({ type: 'stdio', command: process.execPath, args: [fixture, 'ok', pidFile] });
  assert.equal(result.ok, true);
  assert.equal(result.toolCount, 1);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
});

await test('stdio 显式环境变量可用但工具元数据不回显其值', async () => {
  const result = await probeMcpServer({ type: 'stdio', command: process.execPath, args: [fixture, 'env'], env: { PROBE_FIXTURE_VALUE: 'fixture-visible-value' } });
  assert.equal(result.ok, true);
  assert.equal(result.tools[0].description, '[已隐藏]');
});

await test('长凭据在工具名称、标题、描述裁剪前完整脱敏', async () => {
  const token = `fixture-secret-${'t'.repeat(850)}`;
  const short = 'fixture-secret-short';
  await withServer(({ message, send }) => send(message.method === 'initialize' ? init() : {
    tools: [{ ...tool(short), title: `说明 ${token} 尾部`, description: `Bearer ${token} 末尾` }],
  }), async (url) => {
    const result = await probeMcpServer({ type: 'http', url, headers: { Authorization: `Bearer ${token}`, 'X-Fixture': short } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools, [{ name: '[已隐藏]', title: '说明 [已隐藏] 尾部', description: '[已隐藏] 末尾' }]);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|tttttttt/);
  });
});

await test('stdio 长环境凭据在描述裁剪前脱敏', async () => {
  const value = `fixture-secret-${'e'.repeat(900)}`;
  const result = await probeMcpServer({ type: 'stdio', command: process.execPath, args: [fixture, 'env'], env: { PROBE_FIXTURE_VALUE: value } });
  assert.equal(result.ok, true);
  assert.equal(result.tools[0].description, '[已隐藏]');
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|eeeeeeee/);
});

await test('stdio 回收忽略 stdin 的后代进程', async () => {
  const pidFile = path.join(temporary, 'tree-pid');
  const result = await probeMcpServer({ type: 'stdio', command: process.execPath, args: [fixture, 'tree', pidFile] });
  assert.equal(result.ok, true);
  for (const file of [pidFile, `${pidFile}.child`]) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let gone = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { gone = true; break; } throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(gone, true, '本次探测的进程未退出');
  }
});

await test('POSIX 父进程立即退出后仍强制回收忽略 TERM 的后代', async () => {
  if (process.platform === 'win32') return;
  const pidFile = path.join(temporary, 'stubborn-tree-pid');
  let parent;
  try {
    const result = await probeMcpServer({ type: 'stdio', command: process.execPath, args: [fixture, 'stubborn-tree', pidFile] });
    parent = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(result.ok, true);
    const descendant = Number(fs.readFileSync(`${pidFile}.child`, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(descendant, 0); }
      catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, '忽略 TERM 的后代仍在运行');
  } finally {
    if (parent) { try { process.kill(-parent, 'SIGKILL'); } catch { /* 测试进程组已回收。 */ } }
  }
});

for (const [mode, errorCode] of [['idle', 'timeout'], ['exit', 'process_exit'], ['broken', 'protocol_error'], ['server-request', 'server_request'], ['flood', 'response_limit']]) {
  await test(`stdio ${mode} 不误报成功并清理进程`, async () => {
    const result = await probeMcpServer({ type: 'stdio', command: process.execPath, args: [fixture, mode] }, { timeoutMs: mode === 'idle' ? 150 : 1500 });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, errorCode);
  });
}

await test('找不到命令返回固定错误，不回显绝对路径', async () => {
  const result = await probeMcpServer({ type: 'stdio', command: path.join(temporary, 'nonexistent') });
  assert.equal(result.errorCode, 'command_missing');
  assert.ok(!JSON.stringify(result).includes(temporary));
});

await test('调用方可取消等待中的探测', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const result = await probeMcpServer({ type: 'stdio', command: process.execPath, args: [fixture, 'idle'] }, { signal: controller.signal });
  clearTimeout(timer);
  assert.equal(result.errorCode, 'cancelled');
});

function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, actions: [] });
  child.stdin = { end: () => child.actions.push('stdin:end') };
  child.kill = (signal) => { child.actions.push(signal); child.signalCode = signal; child.emit('exit'); };
  return child;
}

await test('Windows 先按拥有的 PID 回收树，再关闭包装器输入', async () => {
  const child = fakeChild(process.pid + 100_000);
  await stopMcpProbeProcess(child, { platform: 'win32', runTreeKill: async (pid) => {
    assert.equal(pid, child.pid);
    child.actions.push('tree');
  } });
  assert.deepEqual(child.actions, ['tree', 'stdin:end', 'SIGTERM']);
});

await test('没有 PID、非法 PID 或主服务 PID 不运行进程树清理', async () => {
  for (const pid of [undefined, 0, -1, 1.2, process.pid]) {
    const child = fakeChild(pid);
    await stopMcpProbeProcess(child, { platform: 'win32', runTreeKill: async () => assert.fail('不可清理') });
    assert.deepEqual(child.actions, []);
  }
});

await test('POSIX 清理不执行 Windows 命令', async () => {
  const child = fakeChild(process.pid + 100_001);
  await stopMcpProbeProcess(child, {
    platform: 'darwin',
    runTreeKill: async () => assert.fail('不可调用 taskkill'),
    killGroup: (pid, signal) => { assert.equal(pid, child.pid); child.kill(signal); },
  });
  assert.deepEqual(child.actions, ['stdin:end', 'SIGTERM']);
});

await test('POSIX 组长已退出不提前结束整个组的宽限期', async () => {
  const child = fakeChild(process.pid + 100_005);
  let alive = true;
  await stopMcpProbeProcess(child, {
    platform: 'darwin', graceMs: 25,
    groupAlive: () => alive,
    killGroup: (_pid, signal) => { child.kill(signal); if (signal === 'SIGKILL') alive = false; },
  });
  assert.deepEqual(child.actions, ['stdin:end', 'SIGTERM', 'SIGKILL']);
  assert.equal(alive, false);
});

await test('Windows 树清理失败仍回收直接子进程', async () => {
  const child = fakeChild(process.pid + 100_002);
  await stopMcpProbeProcess(child, { platform: 'win32', runTreeKill: async () => { throw Error('fixture failure'); } });
  assert.deepEqual(child.actions, ['stdin:end', 'SIGTERM']);
});

await test('Windows 树清理无响应时仍有时间上限', async () => {
  const child = fakeChild(process.pid + 100_004);
  const startedAt = Date.now();
  await stopMcpProbeProcess(child, { platform: 'win32', timeoutMs: 25, runTreeKill: () => new Promise(() => {}) });
  assert.ok(Date.now() - startedAt < 800);
  assert.deepEqual(child.actions, ['stdin:end', 'SIGTERM']);
});

await test('已退出的 Windows 子进程不会再按 PID 调 taskkill', async () => {
  const child = fakeChild(process.pid + 100_003);
  child.exitCode = 0;
  await stopMcpProbeProcess(child, { platform: 'win32', runTreeKill: async () => assert.fail('不能杀已退出 PID') });
  assert.deepEqual(child.actions, ['stdin:end', 'SIGTERM']);
});

fs.rmSync(temporary, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} 通过`);
process.exitCode = failed ? 1 : 0;
