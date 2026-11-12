/**
 * 内置 MCP 预设：幂等登记、不覆盖用户配置、参数正确、白名单对齐、未安装不启动。
 *   node tests/mcp-presets.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preset-'));
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_PROBE = '0';
process.env.PI_BOT_LESSON_REFLECT = '0';
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const { store } = await import('../src/store.js');
const {
  ensureBuiltinPresets,
  detectPresetAvailability,
  BUILTIN_MCP_PRESETS,
  presetOutputDir,
} = await import('../src/mcp-presets.js');
const { mcpRiskLevel } = await import('../src/mcp-risk.js');
const { matchPresetShape } = await import('../src/mcp-preset-shapes.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const byName = (n) => store.mcpLibrary().find((s) => s.name === n);

/** 预设的 project_path 按数据目录算 —— 与 policy-hook 里的算法保持一致。 */
const projectPathOf = (presetId) => presetOutputDir(root, presetId);

await test('预设登记：两项都进库，默认 enabled=false', () => {
  const out = ensureBuiltinPresets(store);
  assert.deepEqual(out.added.sort(), ['pyghidra-mcp', 'r2mcp']);
  const r2 = byName('r2mcp');
  const gh = byName('pyghidra-mcp');
  assert.ok(r2 && gh, '两项都应登记');
  assert.equal(r2.enabled, false, '预设默认不启用');
  assert.equal(gh.enabled, false, '预设默认不启用');
});

await test('默认不挂任何 Bot', () => {
  const bot = store.createBot({ name: '新同事', persona: '' });
  assert.deepEqual(store.getBot(bot.id).mcpServers, [], '新 bot 不该自动挂预设');
  assert.equal(store.mcpServersFor(bot.id).length, 0, '解析出来也应为空');
});

await test('★ 幂等：再登记一次不产生重复条目', () => {
  const before = store.mcpLibrary().length;
  const out = ensureBuiltinPresets(store);
  assert.deepEqual(out.added, [], '第二次不应新增');
  assert.equal(store.mcpLibrary().length, before, '条目数不该变');
  assert.equal(
    store.mcpLibrary().filter((s) => s.name === 'r2mcp').length,
    1,
    'r2mcp 只有一条',
  );
});

await test('★ 用户改过的配置不被覆盖', async () => {
  const r2 = byName('r2mcp');
  // 用户自己改了参数和描述
  const changed = store.updateMcpServer(r2.id, {
    args: ['-R', '-H', '8765'],
    description: '我自己改过的说明',
    enabled: true,
  });
  assert.ok(!changed.error, '改配置应成功：' + (changed.error ?? ''));

  ensureBuiltinPresets(store); // 再跑一遍登记（模拟下次启动）

  const after = store.mcpLibrary().find((s) => s.id === r2.id);
  assert.deepEqual(after.args, ['-R', '-H', '8765'], '用户改的参数必须保留');
  assert.equal(after.description, '我自己改过的说明', '用户改的说明必须保留');
  assert.equal(after.enabled, true, '用户打开的开关必须保留');
  // 还原，避免影响后续用例
  store.updateMcpServer(r2.id, { args: ['-R'], description: BUILTIN_MCP_PRESETS[0].description, enabled: false });
});

await test('★ 用户自建的同名服务不被预设顶掉', async () => {
  // 删掉预设后手工建一个同名服务，模拟"用户早就自己配过"
  const preset = byName('pyghidra-mcp');
  store.removeMcpServer(preset.id);
  const mine = store.addMcpServer({
    name: 'pyghidra-mcp',
    type: 'stdio',
    command: '/my/own/pyghidra',
    args: ['--gui'],
    enabled: false,
  });
  assert.ok(!mine.error);

  ensureBuiltinPresets(store);

  const all = store.mcpLibrary().filter((s) => s.name === 'pyghidra-mcp');
  assert.equal(all.length, 1, '不该撞出第二条');
  assert.equal(all[0].command, '/my/own/pyghidra', '用户自己的 command 不该被改');
  assert.deepEqual(all[0].args, ['--gui'], '用户自己的参数不该被改');

  // 还原：删掉这个手工条目，让后面的用例能看到真正的预设
  store.removeMcpServer(all[0].id);
  ensureBuiltinPresets(store);
});

await test('★ r2mcp 预设：参数含 -R，不含 -r / -L', () => {
  const preset = BUILTIN_MCP_PRESETS.find((p) => p.id === 'r2mcp');
  assert.equal(preset.command, 'r2mcp');
  assert.ok(preset.args.includes('-R'), '必须带只读参数 -R');
  assert.ok(!preset.args.includes('-r'), '不能带 -r（restrict，会改变工具集）');
  assert.ok(!preset.args.includes('-L'), '不能带 -L（会连远端会话）');
  // 实际登记进库的那条也要满足
  const stored = byName('r2mcp');
  if (stored) {
    assert.ok(stored.args.includes('-R'));
    assert.ok(!stored.args.includes('-r'));
    assert.ok(!stored.args.includes('-L'));
  }
});

await test('★ pyghidra 预设：锁版本 + headless + project_path 在数据目录下', () => {
  const preset = BUILTIN_MCP_PRESETS.find((p) => p.id === 'pyghidra-mcp');
  const args = preset.args.join(' ');
  assert.match(args, /pyghidra-mcp==0\.3\.0/, '必须锁到 0.3.0');
  assert.ok(!preset.args.includes('--gui'), '必须是 headless，不能带 --gui');
  assert.ok(args.includes('--project-path'), '必须显式指定 project_path');

  const stored = byName('pyghidra-mcp');
  if (stored) {
    const joined = stored.args.join(' ');
    assert.match(joined, /pyghidra-mcp==0\.3\.0/, '登记进库的也要锁版本');
    assert.ok(!stored.args.includes('--gui'));
    const idx = stored.args.indexOf('--project-path');
    assert.ok(idx >= 0, '应有 --project-path');
    const proj = stored.args[idx + 1];
    assert.ok(
      proj.startsWith(path.join(root, 'mcp-data')),
      `project_path 必须在数据目录下，实际 ${proj}`,
    );
  }
});

await test('★ 两个预设的完整配置能匹配到白名单形状', () => {
  const r2 = byName('r2mcp');
  const gh = byName('pyghidra-mcp');
  assert.ok(r2 && gh, '预设应已登记');
  const s1 = matchPresetShape(r2, projectPathOf);
  const s2 = matchPresetShape(gh, projectPathOf);
  assert.ok(s1, 'r2mcp 预设配置应匹配形状');
  assert.ok(s2, 'pyghidra 预设配置应匹配形状');
  assert.ok(s1.tools.length > 0 && s2.tools.length > 0);
});

await test('★ 白名单工具判 static，其它判 dynamic', () => {
  const r2 = byName('r2mcp');
  const gh = byName('pyghidra-mcp');
  assert.ok(r2 && gh, '预设应已登记');

  for (const t of ['decompile_function', 'disassemble', 'list_functions', 'xrefs_to']) {
    assert.equal(mcpRiskLevel(`mcp__r2mcp__${t}`, r2, null, projectPathOf), 'static', t);
  }
  // 即使 -R 模式，这些也不该放行
  for (const t of ['run_command', 'sql', 'run_script', 'open_file', 'analyze']) {
    assert.equal(mcpRiskLevel(`mcp__r2mcp__${t}`, r2, null, projectPathOf), 'dynamic', t);
  }

  for (const t of ['decompile_function', 'disassemble', 'list_exports']) {
    assert.equal(mcpRiskLevel(`mcp__gh__${t}`, gh, null, projectPathOf), 'static', t);
  }
  for (const t of ['import_binary', 'rename_function', 'save', 'delete_project_binary']) {
    assert.equal(mcpRiskLevel(`mcp__gh__${t}`, gh, null, projectPathOf), 'dynamic', t);
  }
});

await test('★ 去掉 -R 后 r2mcp 全部判 dynamic', () => {
  const noR = { command: 'r2mcp', args: [] };
  for (const t of ['decompile_function', 'disassemble', 'list_functions']) {
    assert.equal(mcpRiskLevel(`mcp__r2mcp__${t}`, noR, null, projectPathOf), 'dynamic', t);
  }
});

await test('★ 未安装时不尝试启动、不下载', () => {
  // 检测函数只查 PATH；这里注入一个"什么都找不到"的 which，
  // 断言它不会做任何 IO 之外的事 —— 返回 found=false + 安装说明。
  const none = () => null;
  const state = detectPresetAvailability(none);
  assert.equal(state.r2mcp.found, false);
  assert.equal(state['pyghidra-mcp'].found, false);
  assert.ok(state.r2mcp.install.length > 0, '应给安装说明');
  assert.ok(state['pyghidra-mcp'].install.length > 0, '应给安装说明');
});

await test('检测：找到可执行文件时 found=true', () => {
  const fake = (n) => (n === 'r2mcp' ? '/usr/bin/r2mcp' : n === 'uvx' ? '/usr/bin/uvx' : n === 'java' ? '/usr/bin/java' : null);
  const prevGhdira = process.env.GHIDRA_INSTALL_DIR;
  process.env.GHIDRA_INSTALL_DIR = '/opt/ghidra';
  try {
    const state = detectPresetAvailability(fake);
    assert.equal(state.r2mcp.found, true, 'r2mcp 找到就算可用');
    assert.equal(state['pyghidra-mcp'].found, true, 'uvx+ghidra+java 齐了才算可用');
  } finally {
    if (prevGhdira === undefined) delete process.env.GHIDRA_INSTALL_DIR;
    else process.env.GHIDRA_INSTALL_DIR = prevGhdira;
  }
});


// ────────────────── 冒充防护：只有逐项等于预设才 static ──────────────────

await test('★ 冒充写法全部判 dynamic', () => {
  const r2 = byName('r2mcp');
  const gh = byName('pyghidra-mcp');
  const at = (tool, server) => mcpRiskLevel(tool, server, null, projectPathOf);
  const T = 'decompile_function';
  const proj = projectPathOf('pyghidra-mcp');
  const ghArgs = [...gh.args];

  const impersonations = [
    // 换个路径放同名可执行文件
    ['/tmp/evil/r2mcp', { command: '/tmp/evil/r2mcp', args: ['-R'] }],
    // npm 上同名包（未必是 radare 官方）
    ['npx -y r2mcp', { command: 'npx', args: ['-y', 'r2mcp'] }],
    // 本地目录当包源
    ['uvx --from 本地目录', {
      command: 'uvx',
      args: ['--from', './evil/pyghidra-mcp', 'pyghidra-mcp', '--project-path', proj],
    }],
    // git 包源
    ['uvx --from git+https', {
      command: 'uvx',
      args: ['--from', 'git+https://evil/x', 'pyghidra-mcp', '--project-path', proj],
    }],
    // --with 塞包（.pth 可在启动时执行代码）
    ['uvx --with', {
      command: 'uvx',
      args: ['--from', 'pyghidra-mcp==0.3.0', '--with', 'evil', 'pyghidra-mcp', '--project-path', proj],
    }],
    // python -m + PYTHONPATH 改加载路径
    ['python -m + PYTHONPATH', {
      command: 'python',
      args: ['-m', 'pyghidra_mcp', '--project-path', proj],
      env: { PYTHONPATH: '/evil' },
    }],
    // 预设配置 + 改 env
    ['预设 + NODE_OPTIONS', {
      command: 'r2mcp', args: ['-R'], env: { NODE_OPTIONS: '--require /e.js' },
    }],
    ['预设 + PYTHONHOME', {
      command: 'uvx', args: ghArgs, env: { PYTHONHOME: '/evil' },
    }],
    // 去掉 -R
    ['r2mcp 无 -R', { command: 'r2mcp', args: [] }],
    // 加多余参数
    ['r2mcp 加 -L', { command: 'r2mcp', args: ['-R', '-L'] }],
    // project_path 换地方
    ['project_path 换处', {
      command: 'uvx',
      args: ['--from', 'pyghidra-mcp==0.3.0', 'pyghidra-mcp', '--project-path', '/tmp/evil'],
    }],
    // 加 --gui
    ['加 --gui', { command: 'uvx', args: [...ghArgs, '--gui'] }],
    // r2pm 换包
    ['r2pm 换包', { command: 'r2pm', args: ['-r', 'evil', '-R'] }],
  ];

  for (const [name, server] of impersonations) {
    assert.equal(at('mcp__x__' + T, server), 'dynamic', name + ' 应判 dynamic');
  }
});

await test('★ 完全等于预设时判 static', () => {
  const r2 = byName('r2mcp');
  const gh = byName('pyghidra-mcp');
  assert.equal(mcpRiskLevel('mcp__x__decompile_function', r2, null, projectPathOf), 'static');
  assert.equal(mcpRiskLevel('mcp__x__decompile_function', gh, null, projectPathOf), 'static');
});

await test('★ r2pm -r r2mcp -R 这一种等价写法也认', () => {
  const viaR2pm = { command: 'r2pm', args: ['-r', 'r2mcp', '-R'] };
  assert.equal(mcpRiskLevel('mcp__x__decompile_function', viaR2pm, null, projectPathOf), 'static');
  // 但换个包名就不认
  assert.equal(mcpRiskLevel('mcp__x__decompile_function', { command: 'r2pm', args: ['-r', 'evil', '-R'] }, null, projectPathOf), 'dynamic');
});



// ────────────────── env 必须为空：任何 env 键都退回 dynamic ──────────────────

await test('★ env 里有任何键都判 dynamic（黑名单挡不全，改成白名单式）', () => {
  const r2 = byName('r2mcp');
  const gh = byName('pyghidra-mcp');
  assert.ok(r2 && gh, '预设应已登记');
  const at = (server) => mcpRiskLevel('mcp__x__decompile_function', server, null, projectPathOf);

  // 你实测过的那几条：PATH 换可执行文件、HOME 换 rc、R2_* 指定 rc、
  // GHIDRA_INSTALL_DIR 换 Ghidra、JAVA_TOOL_OPTIONS 加载 agent
  const dangerous = [
    ['PATH 换可执行文件', { ...r2, env: { PATH: '/tmp/evil' } }],
    ['HOME 换 rc 目录', { ...r2, env: { HOME: '/tmp/evil' } }],
    ['R2_RCFILE 指定 rc', { ...r2, env: { R2_RCFILE: '/tmp/evil/rc' } }],
    ['GHIDRA_INSTALL_DIR 换 Ghidra', { ...gh, env: { GHIDRA_INSTALL_DIR: '/tmp/evil' } }],
    ['JAVA_TOOL_OPTIONS 加载 agent', { ...gh, env: { JAVA_TOOL_OPTIONS: '-javaagent:/tmp/evil.jar' } }],
    // 其它同类（说明黑名单真的补不完）
    ['_JAVA_OPTIONS', { ...r2, env: { _JAVA_OPTIONS: '-Xbootclasspath/a:/tmp/e' } }],
    ['JAVA_HOME', { ...gh, env: { JAVA_HOME: '/tmp/evil' } }],
    ['TMPDIR', { ...r2, env: { TMPDIR: '/tmp/evil' } }],
    ['XDG_CONFIG_HOME', { ...r2, env: { XDG_CONFIG_HOME: '/tmp/evil' } }],
    ['任意未知变量', { ...r2, env: { WHATEVER: 'x' } }],
  ];
  for (const [name, server] of dangerous) {
    assert.equal(at(server), 'dynamic', name + ' 应判 dynamic');
  }
});

await test('★ env 为空或不存在时判 static', () => {
  const r2 = byName('r2mcp');
  const gh = byName('pyghidra-mcp');
  const at = (server) => mcpRiskLevel('mcp__x__decompile_function', server, null, projectPathOf);
  // 不存在 env 字段
  assert.equal(at({ command: r2.command, args: r2.args }), 'static');
  assert.equal(at({ command: gh.command, args: gh.args }), 'static');
  // env 是空对象
  assert.equal(at({ command: r2.command, args: r2.args, env: {} }), 'static');
  assert.equal(at({ command: gh.command, args: gh.args, env: {} }), 'static');
});

await test('★ 依赖变量从 pi-bot 进程环境读，不写进 server.env', () => {
  // 预设定义里不能带 env（否则登记出来就不满足"env 为空"了）
  for (const preset of BUILTIN_MCP_PRESETS) {
    assert.equal(preset.env, undefined, preset.id + ' 的预设定义不该带 env');
  }
  // 库里登记的那两条也不能带
  for (const id of ['r2mcp', 'pyghidra-mcp']) {
    const stored = byName(id);
    if (!stored) continue;
    const keys = Object.keys(stored.env ?? {});
    assert.equal(keys.length, 0, id + ' 登记后不该有 env 键：' + keys.join(','));
  }
  // 而检测是读进程环境变量的（GHIDRA_INSTALL_DIR）
  const prev = process.env.GHIDRA_INSTALL_DIR;
  process.env.GHIDRA_INSTALL_DIR = '/opt/ghidra-test';
  try {
    const found = (n) => '/usr/bin/' + n;
    const state = detectPresetAvailability(found);
    assert.equal(state['pyghidra-mcp'].found, true, '应从进程环境读到 GHIDRA_INSTALL_DIR');
  } finally {
    if (prev === undefined) delete process.env.GHIDRA_INSTALL_DIR;
    else process.env.GHIDRA_INSTALL_DIR = prev;
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);

clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
