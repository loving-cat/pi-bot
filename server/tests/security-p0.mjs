/**
 * 安全 P0 回归测试。
 *   node tests/security-p0.mjs
 *
 * 覆盖三个 P0 的核心断言：
 *   ① MCP 工具按服务端分级表判定：dynamic 任何档位都强制审批、
 *      且不被"本任务授权"窗口覆盖；static 行为不变。
 *   ② 审批卡能看到脱敏后的参数摘要（凭据被遮掉）。
 *   ③ 不带本机 token 的请求访问改状态接口一律 401；带正确 token 正常。
 *   ④ ask/allow 两档下，add_mcp_server 与 update_bot 挂 MCP 都出审批卡。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p0-'));
process.env.PI_BOT_HOME = root;

const { store } = await import('../src/store.js');
const { createPolicyExtension, summarizeToolCall } = await import('../src/policy-hook.js');
const { mcpRequiresApproval, suggestRiskLevel } = await import('../src/mcp-risk.js');
const { mcpApprovalSummary } = await import('../src/mcp-approval-summary.js');
const { installLocalToken } = await import('./_local-token.mjs');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const bot = store.createBot({ name: '审查员', persona: '测试' });
const room = store.createGroup({ name: 'P0 测试组', botIds: [bot.id] });

/** 装一个策略扩展，返回 tool_call 处理器。 */
function install() {
  let handler = null;
  const pi = { on: (ev, fn) => { if (ev === 'tool_call') handler = fn; return () => {}; } };
  createPolicyExtension({ roomId: room.id, bot }).factory(pi);
  assert.ok(handler, '应该注册了 tool_call 处理器');
  return handler;
}
const callTool = (h, toolName, input = {}) => h({ type: 'tool_call', toolName, toolCallId: 'c1', input });

/**
 * 真的在库里建一个已启用的 MCP 服务并挂到这个 bot 上。
 *
 * 白名单按 (可执行文件名, 工具名) 匹配，所以必须让 store 里有一条
 * command 正确、enabled 为真、且 bot.mcpServers 引用了它的记录 ——
 * 只有这样才能测到"白名单内 static 放行"。
 */
function mountMcp({ name, command, args = [], tools }) {
  const added = store.addMcpServer({ name, type: 'stdio', command, args, enabled: false });
  assert.ok(!added.error, '建 MCP 应成功：' + (added.error ?? ''));
  const enabled = store.updateMcpServer(added.server.id, { enabled: true });
  assert.ok(!enabled.error, '启用 MCP 应成功：' + (enabled.error ?? ''));
  store.updateBot(bot.id, { mcpServers: [name] });
  return added.server;
}
/** 完全等于内置预设的配置（static 白名单唯一认的形态）。 */
const PRESET_R2 = { command: 'r2mcp', args: ['-R'] };
const PRESET_GH = {
  command: 'uvx',
  args: ['--from', 'pyghidra-mcp==0.3.0', 'pyghidra-mcp', '--project-path', '/x'],
};
/** pyghidra 的 project_path 要按这个函数算，这里固定成一个值便于断言。 */
const projectPathOf = (id) => (id === 'pyghidra-mcp' ? '/x' : '/x/' + id);

const cleared = () => { store.state.approvals = []; store.state.approvalGrants = []; };

// ───────────────────────── ① 风险分级 ─────────────────────────

// ───────────────────────── ① 外部 MCP 工具一律审批 ─────────────────────────

await test('★ ① 所有外部 MCP 工具都要审批（没有 static 档）', () => {
  for (const tool of [
    'mcp__r2mcp__decompile_function',
    'mcp__r2mcp__list_functions',
    'mcp__evil__get_info',
    'mcp__evil__read_data',
    'mcp__x__not_listed',
  ]) {
    assert.equal(mcpRequiresApproval(tool), true, tool + ' 必须审批');
  }
});

await test('★ ① 资源类工具也要审批（原来无条件 static，是个洞）', () => {
  for (const tool of ['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']) {
    assert.equal(mcpRequiresApproval(tool), true, tool);
  }
});

await test('① 非 MCP 工具不受外部工具判定影响', () => {
  for (const tool of ['bash', 'write', 'list_bots']) {
    assert.equal(mcpRequiresApproval(tool), false, tool);
  }
});

await test('① allow 档：外部 MCP 工具仍然弹卡', () => {
  cleared();
  store.updatePolicy({ dangerous: 'allow' });
  const h = install();
  const out = callTool(h, 'mcp__evil__get_info', { x: 1 });
  assert.ok(out && out.block === true, 'allow 档下外部 MCP 工具也要被拦下');
  assert.equal(store.listApprovals({ status: 'pending' }).length, 1);
});

await test('★ ① 任务授权窗口覆盖不了外部 MCP 工具', () => {
  cleared();
  store.updatePolicy({ dangerous: 'allow' });
  store.grantApproval({ roomId: room.id, botId: bot.id, minutes: 120 });
  const h = install();
  const out = callTool(h, 'mcp__r2mcp__decompile_function', { path: '/bin/ls' });
  assert.ok(out && out.block === true, '外部 MCP 工具不该吃 120 分钟授权窗口');
  assert.equal(store.listApprovals({ status: 'pending' }).length, 1);
});

await test('① suggestRiskLevel 只做展示，不影响审批', () => {
  assert.equal(suggestRiskLevel('get_info'), 'static', '建议值可以是 static');
  assert.equal(mcpRequiresApproval('mcp__evil__get_info'), true, '但审批判定仍是需要');
});

await test('② 审批卡带参数摘要，不再是 null', () => {
  const s = summarizeToolCall('mcp__x__run', { path: '/tmp/a', offset: 8 });
  assert.match(s, /path=\/tmp\/a/);
  assert.match(s, /offset=8/);
  assert.doesNotMatch(s, /null/);
});

await test('② 凭据键名被遮掉', () => {
  // 键名就叫 api_key，值不需要长得像真凭据 —— 遮的是"键名像凭据"这条规则。
  // 样例故意用重复字符：形状像 sk- 开头的真 key 会被 CI 的 secret scan 判成泄漏
  // （见 memory-sanitize.mjs 里同样的处理）。
  const s = mcpApprovalSummary({ api_key: 'XXXXXXXXXXXXXXXX', count: 3 });
  assert.match(s, /api_key=\[已隐藏\]/);
  assert.match(s, /count=3/);
  assert.doesNotMatch(s, /XXXXXXXX/);
});

await test('② 值本身像凭据时也遮（不靠键名）', () => {
  // 键名完全无害，但值有形如 sk- 的前缀 + 长随机串
  const fakeKey = 'sk-' + 'X'.repeat(20);
  const s = mcpApprovalSummary({ someField: fakeKey });
  assert.match(s, /someField=\[已隐藏\]/);
});

await test('② 与已存 env 同名但值像凭据的也要遮', () => {
  const s = mcpApprovalSummary({ FOO: 'ghp_' + 'a'.repeat(20) }, { secretKeys: ['FOO'] });
  assert.match(s, /FOO=\[已隐藏\]/);
});

await test('② Bearer / Basic / 长随机串被遮', () => {
  const a = mcpApprovalSummary({ auth: 'Bearer eyJhbGciOiJIUzI1NiJ9' });
  assert.match(a, /auth=\[已隐藏\]/);
  const b = mcpApprovalSummary({ x: 'A'.repeat(40) });
  assert.match(b, /x=\[已隐藏\]/);
});

await test('② 普通参数原样保留（用户要看到它要干什么）', () => {
  const s = mcpApprovalSummary({ command: 'gdb -p 123', timeout: 30 });
  assert.match(s, /gdb -p 123/);
  assert.match(s, /timeout=30/);
});

// ───────────────────────── ④ 改安全配置必须审批 ─────────────────────────

for (const policy of ['ask', 'allow']) {
  await test(`★ ④ ${policy} 档：add_mcp_server 出审批卡`, () => {
    cleared();
    store.updatePolicy({ dangerous: policy });
    const h = install();
    const out = callTool(h, 'add_mcp_server', {
      name: 'evil-' + policy, type: 'stdio', command: 'npx', args: ['-y', 'evil-mcp'],
    });
    assert.ok(out && out.block === true, `${policy} 档下 add_mcp_server 应当被拦住`);
    assert.equal(store.listApprovals({ status: 'pending' }).length, 1);
  });

  await test(`★ ④ ${policy} 档：update_bot 挂 MCP 出审批卡`, () => {
    cleared();
    store.updatePolicy({ dangerous: policy });
    const h = install();
    const out = callTool(h, 'update_bot', { botId: bot.id, mcpServers: ['evil'] });
    assert.ok(out && out.block === true, `${policy} 档下 update_bot 挂 MCP 应当被拦住`);
    assert.equal(store.listApprovals({ status: 'pending' }).length, 1);
  });
}

await test('★ ④ update_bot 不改 MCP 时不弹卡（不误伤改名/换模型）', () => {
  cleared();
  store.updatePolicy({ dangerous: 'ask' });
  const h = install();
  const out = callTool(h, 'update_bot', { botId: bot.id, name: '新名字' });
  assert.equal(out, undefined, '只改名不该弹审批卡');
});

await test('★ ④ 改安全配置不吃"本任务授权"窗口', () => {
  cleared();
  store.updatePolicy({ dangerous: 'ask' });
  store.grantApproval({ roomId: room.id, botId: bot.id, minutes: 10 });
  const h = install();
  const out = callTool(h, 'add_mcp_server', { name: 'evil2', command: 'npx' });
  assert.ok(out && out.block === true, '改防线不能靠任务窗口放行');
});

await test('④ add_mcp_server 不再接受 enabled，且恒定登记为未启用', async () => {
  // 直接读源码做静态断言：tools.js 的 schema 是内联在 defineTool 里的，
  // 运行时拿不到结构化 schema。这里验两件事：
  //   1. 代码里没有 'enabled' 参数声明；
  //   2. execute 里恒定传 enabled: false。
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'tools.js'),
    'utf8',
  );
  const start = src.indexOf("name: 'add_mcp_server'");
  assert.ok(start > 0, '应当还有 add_mcp_server 工具');
  const block = src.slice(start, start + 2600);
  assert.doesNotMatch(block, /enabled:\s*Type\.Optional/, 'schema 里不该再有 enabled 参数');
  assert.match(block, /enabled:\s*false/, 'execute 应恒定传 enabled: false');
});

// ───────────────────────── ③ 本机 token ─────────────────────────

const { createHttpServer } = await import('../src/http.js');
const { Pairing } = await import('../src/pairing.js');
const runner = { availableModels: [], modelLabel: () => null, initNote: null, contextUsage: () => ({}) };
const server = createHttpServer({ runner, pairing: new Pairing() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const LOCAL_TOKEN = installLocalToken();

function request(pathname, { method = 'GET', token = '', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-pi-bot-client': 'test' } : {}),
    };
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const PROTECTED = ['/api/mcp', '/api/approvals', '/api/hooks', '/api/policy', '/api/devices'];

await test('★ ③ 不带 token 访问改状态接口 → 401', async () => {
  for (const p of PROTECTED) {
    assert.equal(await request(p), 401, p + ' 应当 401');
  }
});

await test('★ ③ 带正确 token 正常放行', async () => {
  for (const p of PROTECTED) {
    assert.equal(await request(p, { token: LOCAL_TOKEN }), 200, p + ' 应当 200');
  }
});

await test('★ ③ 错误 token 被拒', async () => {
  assert.equal(await request('/api/mcp', { token: 'not-the-token' }), 401);
});

await test('★ ③ 改状态接口不带 token → 401（POST/PATCH/DELETE）', async () => {
  assert.equal(await request('/api/mcp', { method: 'POST', body: JSON.stringify({ name: 'x' }) }), 401);
  assert.equal(await request('/api/policy', { method: 'PATCH', body: JSON.stringify({ dangerous: 'allow' }) }), 401);
  assert.equal(await request('/api/devices/d_x', { method: 'DELETE' }), 401);
});

// 补漏用例要用一个还活着的服务端（前面的 server 已关闭会连不上）
const { attachWs } = await import('../src/ws.js');
const server2 = createHttpServer({ runner, pairing: new Pairing() });
attachWs(server2, { runner });
await new Promise((r) => server2.listen(0, '127.0.0.1', r));

// ────────────────── ③b WebSocket 与配对码（补漏） ──────────────────

await test('★ ③ WS 不带 token 被拒（只改 HTTP 等于没堵）', async () => {
  const WebSocket = (await import('ws')).default;
  const verdict = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + server2.address().port + '/ws');
    let sawHello = false;
    ws.on('message', (m) => {
      const d = JSON.parse(String(m));
      if (d.t === 'hello') sawHello = true;
      ws.close();
    });
    ws.on('close', (code) => resolve({ code, sawHello }));
    ws.on('error', () => resolve({ code: -1, sawHello: false }));
    setTimeout(() => { try { ws.close(); } catch {} resolve({ code: -2, sawHello }); }, 3000);
  });
  assert.equal(verdict.sawHello, false, '不能拿到 hello 身份');
});

await test('★ ③ /api/pairing 不带 token 不给配对码', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server2.address().port, path: '/api/pairing', method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
  // 免 token 路径可能返回 200 也可能 401；关键是**不能出现 code**
  if (status.body) {
    assert.equal(status.body.code, undefined, '无 token 不该拿到配对码');
  }
});

await test('★ ③ /api/pairing 带 token 正常给码', async () => {
  const body = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: server2.address().port, path: '/api/pairing', method: 'GET',
        headers: { authorization: 'Bearer ' + LOCAL_TOKEN },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.ok(body, '应返回 JSON');
  assert.ok(typeof body.code === 'string' && body.code.length > 0, '带 token 应拿到配对码');
});

server2.close();

server.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

store.saveNow?.();
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
