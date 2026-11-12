/**
 * D3：改安全配置的接口要一次性 nonce。
 *   node tests/local-nonce.mjs
 *
 * 挡的攻击：同用户进程在磁盘上读到 local-token 文件后，直接
 *   PATCH /api/policy { dangerous: 'allow' }
 *   POST  /api/mcp    { command: '/tmp/evil' }
 * 把策略改成全放行、或者挂一个 MCP 作为执行入口。
 *
 * 拿 token 是容易的（文件在数据目录里，同用户可读）；拿一个
 * **正在被界面使用**的 nonce 不容易。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nonce-'));
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_PROBE = '0';
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const { store } = await import('../src/store.js');
const { createHttpServer } = await import('../src/http.js');
const { issueNonce, consumeNonce, clearNonces, nonceCount, NONCE_PURPOSE, NONCE_TTL_MS } =
  await import('../src/local-nonce.js');
const { installLocalToken } = await import('./_local-token.mjs');
const { Pairing } = await import('../src/pairing.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err?.message || String(err) }); }
}

const token = installLocalToken(root);
// 最小 runner：这些接口只需要它存在，不实际起 pi 会话
const runner = {
  availableModels: [],
  modelLabel: () => null,
  initNote: null,
  taskCommands: null,
  taskRequests: null,
};
const server = createHttpServer({ runner, pairing: new Pairing() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

import http from 'node:http';
import { URL } from 'node:url';

/** 发一个本机 HTTP 请求（不用 fetch：本测试把 fetch 禁了，防止误联网）。 */
function call(pathname, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + pathname);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
        // 改状态的请求必须带客户端自定义头（防跨站），这是另一层，不是本测试重点
        'x-pi-bot-client': 'test',
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ────────────────── nonce 单元行为 ──────────────────

await test('★ 只有 token、没有 nonce → 改策略被拒 403', async () => {
  const r = await call('/api/policy', 'PATCH', { dangerous: 'allow' });
  assert.equal(r.status, 403);
  assert.equal(r.json?.error, 'nonce_required');
});

await test('★ 只有 token、没有 nonce → 挂 MCP 被拒 403', async () => {
  const r = await call('/api/mcp', 'POST', {
    name: 'evil', type: 'stdio', command: '/tmp/evil', enabled: true,
  });
  assert.equal(r.status, 403);
  // 关键：库里不该多出这个服务
  assert.equal(store.mcpLibrary().find((s) => s.name === 'evil'), undefined);
});

await test('★ 带正确 nonce → 改策略成功', async () => {
  const { nonce } = issueNonce(NONCE_PURPOSE.POLICY);
  const r = await call('/api/policy', 'PATCH', { dangerous: 'ask' }, { 'x-pi-bot-nonce': nonce });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

await test('★ nonce 重放 → 第二次 403', async () => {
  const { nonce } = issueNonce(NONCE_PURPOSE.POLICY);
  const first = await call('/api/policy', 'PATCH', { dangerous: 'ask' }, { 'x-pi-bot-nonce': nonce });
  assert.equal(first.status, 200);
  const second = await call('/api/policy', 'PATCH', { dangerous: 'allow' }, { 'x-pi-bot-nonce': nonce });
  assert.equal(second.status, 403);
  assert.equal(second.json?.reason, 'unknown');
});

await test('★ nonce 过期 → 403', () => {
  const { nonce } = issueNonce(NONCE_PURPOSE.POLICY, Date.now() - NONCE_TTL_MS - 1000);
  const r = consumeNonce(nonce, NONCE_PURPOSE.POLICY);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

await test('★ 用途不符的 nonce 不能用（policy 的不能拿去改 MCP）', () => {
  const { nonce } = issueNonce(NONCE_PURPOSE.POLICY);
  const r = consumeNonce(nonce, NONCE_PURPOSE.MCP);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'purpose');
});

await test('★ 伪造的 nonce → 403', async () => {
  const r = await call('/api/policy', 'PATCH', { dangerous: 'allow' }, { 'x-pi-bot-nonce': 'forged-value' });
  assert.equal(r.status, 403);
  assert.equal(r.json?.reason, 'unknown');
});

await test('非法的 purpose 申请被拒 400', async () => {
  const r = await call('/api/local-nonce', 'POST', { purpose: 'whatever' });
  assert.equal(r.status, 400);
});

await test('申请 nonce 本身需要 token', async () => {
  const res = await new Promise((resolve, reject) => {
    const url = new URL(base + '/api/local-nonce');
    const payload = JSON.stringify({ purpose: 'policy' });
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-pi-bot-client': 'test',
      },
    }, (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode })); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  assert.equal(res.status, 401);
});

await test('★ 正常流程：申请 → 使用 → 成功', async () => {
  const issued = await call('/api/local-nonce', 'POST', { purpose: 'mcp' });
  assert.equal(issued.status, 200);
  assert.ok(issued.json?.nonce, '应返回 nonce');
  assert.ok(issued.json?.expiresAt > Date.now());

  const r = await call('/api/mcp', 'POST', {
    name: 'fixture_mcp', type: 'stdio', command: '/bin/echo', args: ['hi'], enabled: false,
  }, { 'x-pi-bot-nonce': issued.json.nonce });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  // 再删掉，确认 DELETE 也要 nonce 且能正常工作。
  // 注意用 response 里回来的真实 id：addMcpServer 可能规范化 name。
  const realId = r.json?.server?.id ?? 'fixture_mcp';
  const delNoNonce = await call('/api/mcp/' + encodeURIComponent(realId), 'DELETE');
  assert.equal(delNoNonce.status, 403);

  const { nonce } = issueNonce(NONCE_PURPOSE.MCP);
  const del = await call('/api/mcp/' + encodeURIComponent(realId), 'DELETE', undefined,
    { 'x-pi-bot-nonce': nonce });
  assert.equal(del.status, 200, JSON.stringify(del.json));
});

await test('PATCH 单个 MCP 也要 nonce', async () => {
  const added = store.addMcpServer({ name: 'patchme', type: 'stdio', command: '/bin/echo' });
  assert.ok(!added.error);
  const r = await call('/api/mcp/' + encodeURIComponent('patchme'), 'PATCH', { enabled: true });
  assert.equal(r.status, 403);
});

await test('nonce 有数量上限，不会无限增长', () => {
  clearNonces();
  for (let i = 0; i < 250; i += 1) issueNonce(NONCE_PURPOSE.POLICY);
  assert.ok(nonceCount() <= 200, '应受上限约束，实际 ' + nonceCount());
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
await new Promise((r) => server.close(r));
clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
