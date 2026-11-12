/**
 * 撤回内置预设 + 取消 static 档的验收测试（E29 / D1 / D2 / D5）。
 *   node tests/mcp-presets.mjs
 *
 * 这一轮撤掉了：
 *   · 内置逆向 MCP 预设（r2mcp / pyghidra-mcp）—— 许可证不合（LGPL/GPL）
 *   · 整条 static 免审批路径 —— 所有外部 MCP 工具一律逐次审批
 *
 * 这个文件从"预设是否正确"改成"预设确实没了、且没有静态放行"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-retired-'));
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_PROBE = '0';
process.env.PI_BOT_LESSON_REFLECT = '0';
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const { store } = await import('../src/store.js');
const { markRetiredPresets, RETIRED_PRESET_IDS } = await import('../src/mcp-presets.js');
const { matchPresetShape, LOADER_ENV_HINTS } = await import('../src/mcp-preset-shapes.js');
const { mcpRequiresApproval, suggestRiskLevel, executableNameOf } = await import('../src/mcp-risk.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const bot = store.createBot({ name: '测试员', persona: '' });

await test('D1：不再创建任何内置预设', () => {
  // 早期版本会在启动时登记两项；现在 markRetiredPresets 只清理、不创建
  const out = markRetiredPresets(store);
  assert.deepEqual(out.retired, [], '空库里不该产生任何条目');
  assert.equal(store.mcpLibrary().length, 0, 'MCP 库应该还是空的');
});

await test('E29：三种逆向 MCP 写法都不再是免审批', () => {
  // 这三种配置曾经靠"精确形状"拿到 static（免审批）
  const shapes = [
    { command: 'r2mcp', args: ['-R'] },
    { command: 'r2pm', args: ['-r', 'r2mcp', '-R'] },
    { command: 'uvx', args: ['--from', 'pyghidra-mcp==0.3.0', 'pyghidra-mcp', '--project-path', 'x'] },
  ];
  for (const server of shapes) {
    // matchPresetShape 现在恒返回 null —— 不再有任何"等于预设"的配置
    assert.equal(matchPresetShape(server, () => 'x'), null, JSON.stringify(server) + ' 不该匹配形状');
    // 所有外部工具都要审批
    assert.equal(mcpRequiresApproval('mcp__x__decompile_function'), true);
  }
});

await test('E29：带已删 presetId 的旧配置升级后不报错', () => {
  // 模拟早期版本登记过、现在带 presetId 和 enabled=true 的旧条目
  const added = store.addMcpServer({
    name: 'r2mcp',
    type: 'stdio',
    command: 'r2mcp',
    args: ['-R'],
    enabled: false,
    presetId: 'r2mcp',
  });
  assert.ok(!added.error, '建旧条目应成功：' + (added.error ?? ''));
  store.updateMcpServer(added.server.id, { enabled: true });

  // 升级后跑清理：不抛错、不删除、强制不启用
  const out = markRetiredPresets(store);
  assert.ok(out.retired.includes('r2mcp'), '应被标成已下线');

  const after = store.mcpLibrary().find((s) => s.name === 'r2mcp');
  assert.ok(after, '旧条目不该被自动删掉');
  assert.equal(after.enabled, false, '必须强制不启用');
  assert.equal(after.retired, true, '应带已下线标记');
  assert.equal(after.presetId, 'r2mcp', 'presetId 保留（界面据此显示已下线）');
});

await test('旧配置即使带 presetId，工具调用仍要审批', () => {
  // 清理之后这个 server 还在库里，但它的工具不是"免审批"的
  const after = store.mcpLibrary().find((s) => s.name === 'r2mcp');
  assert.ok(after);
  assert.equal(mcpRequiresApproval('mcp__r2mcp__decompile_function'), true);
});

await test('markRetiredPresets 幂等', () => {
  const before = store.mcpLibrary().length;
  const out = markRetiredPresets(store);
  assert.deepEqual(out.retired, [], '第二次不该再有变化');
  assert.equal(store.mcpLibrary().length, before, '条目数不变');
});

await test('已下线的 presetId 清单仍然可查', () => {
  assert.deepEqual(RETIRED_PRESET_IDS.sort(), ['pyghidra-mcp', 'r2mcp', 'r2mcp-via-r2pm']);
});

// ────────────────── 所有外部 MCP 工具一律要审批 ──────────────────

await test('★ 资源类工具也要审批（原来无条件 static，对任意 server 成立）', () => {
  for (const tool of ['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']) {
    assert.equal(mcpRequiresApproval(tool), true, tool + ' 必须审批');
  }
});

await test('★ 任意 mcp__<server>__<tool> 都要审批', () => {
  for (const tool of [
    'mcp__evil__get_info',
    'mcp__evil__read_data',
    'mcp__r2mcp__decompile_function',
    'mcp__x__not_listed',
  ]) {
    assert.equal(mcpRequiresApproval(tool), true, tool);
  }
});

await test('非 MCP 工具不受影响（交给既有 shell/内置判定）', () => {
  for (const tool of ['bash', 'write', 'read', 'list_bots']) {
    assert.equal(mcpRequiresApproval(tool), false, tool);
  }
});

await test('suggestRiskLevel 只做展示建议，不影响审批判定', () => {
  // 它可能说"看起来是只读的"，但审批判定仍然是 true
  assert.equal(suggestRiskLevel('get_info'), 'static');
  assert.equal(mcpRequiresApproval('mcp__evil__get_info'), true);
});

await test('executableNameOf 保留给 UI 展示', () => {
  assert.equal(executableNameOf({ command: 'r2mcp' }), 'r2mcp');
  assert.equal(executableNameOf({ command: 'uvx', args: ['--from', 'x==1', 'x'] }), 'x');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
