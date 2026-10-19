/**
 * 本机能力扫描：解析 SKILL.md、读 mcp.json、一键导入。
 *
 * 盯的是"用户明明装过却看不见"和"导入把用户配置改坏了"这两类问题：
 *   · frontmatter 的 YAML 多行写法（`description: >`）解析错 → 摘要变成 ">"
 *   · 扫描时写文件 → 用户终端里的 pi 配置被 pi-bot 改掉
 *   · 导入时同名覆盖 → 用户自己调过的 skill 被冲掉
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-local-'));
const agentDir = path.join(root, 'agent');
const skillsDir = path.join(agentDir, 'skills');
fs.mkdirSync(skillsDir, { recursive: true });

process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_DATA_DIR = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
fs.mkdirSync(process.env.HOME, { recursive: true });

// --- 造几个样本 skill ---
// 1) 标准 frontmatter
fs.mkdirSync(path.join(skillsDir, 'plain'), { recursive: true });
fs.writeFileSync(
  path.join(skillsDir, 'plain', 'SKILL.md'),
  '---\nname: 标准技能\ndescription: 一句话说明\n---\n\n# 标题\n\n正文内容\n',
);
// 2) YAML 折叠多行 description（最容易解析错的那种）
fs.mkdirSync(path.join(skillsDir, 'folded'), { recursive: true });
fs.writeFileSync(
  path.join(skillsDir, 'folded', 'SKILL.md'),
  '---\nname: 折叠技能\ndescription: >\n  第一行\n  第二行\n---\n\n正文\n',
);
// 3) 没有 frontmatter，靠目录名
fs.mkdirSync(path.join(skillsDir, 'bare'), { recursive: true });
fs.writeFileSync(path.join(skillsDir, 'bare', 'SKILL.md'), '# 只有正文\n\n做点什么\n');
// 4) 没有 SKILL.md，只有普通 md
fs.mkdirSync(path.join(skillsDir, 'docs-only'), { recursive: true });
fs.writeFileSync(path.join(skillsDir, 'docs-only', 'README.md'), '# 文档式技能\n\n按这里做\n');
// 5) 空目录（应被跳过）
fs.mkdirSync(path.join(skillsDir, 'empty'), { recursive: true });

// --- mcp.json ---
fs.writeFileSync(
  path.join(agentDir, 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      filesystem: { type: 'stdio', command: 'npx', args: ['-y', 'server-fs'] },
      remote: { url: 'https://mcp.example.com/v1' },
      'bad name': { command: 'node' },
    },
  }),
);

const {
  scanLocalSkills,
  scanLocalMcpServers,
  scanLocalCapabilities,
  localSkillToLibrary,
  localMcpToLibrary,
} = await import('../src/local-capabilities.js');

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

await test('扫描出所有有内容的 skill 目录', () => {
  const list = scanLocalSkills();
  // 有 frontmatter 的用里面的 name，没有的才用目录名
  const titles = list.map((s) => s.title).sort();
  assert.deepEqual(titles, ['docs-only', '折叠技能', '标准技能', 'bare'].sort());
  assert.equal(list.length, 4, '空目录应被跳过');
});

await test('frontmatter 的 name/description 被正确读取', () => {
  const list = scanLocalSkills();
  const plain = list.find((s) => s.title === '标准技能');
  assert.ok(plain, '应该用 frontmatter 里的 name');
  assert.equal(plain.summary, '一句话说明');
  assert.match(plain.howto, /正文内容/);
});

await test('YAML 折叠多行 description 不会被解析成 ">"', () => {
  const list = scanLocalSkills();
  const folded = list.find((s) => s.title === '折叠技能');
  assert.ok(folded);
  assert.equal(folded.summary, '第一行 第二行');
  assert.notEqual(folded.summary, '>');
});

await test('没有 frontmatter 时用目录名当标题', () => {
  const list = scanLocalSkills();
  assert.ok(list.some((s) => s.title === 'bare'));
});

await test('没有 SKILL.md 时退回最大的 md', () => {
  const list = scanLocalSkills();
  assert.ok(list.some((s) => s.title === 'docs-only'));
});

await test('扫描 mcp.json：stdio 与 http 都认，非法名字跳过', () => {
  const list = scanLocalMcpServers();
  assert.deepEqual(list.map((s) => s.name).sort(), ['filesystem', 'remote']);
  const fs0 = list.find((s) => s.name === 'filesystem');
  assert.equal(fs0.type, 'stdio');
  assert.equal(fs0.command, 'npx');
  const remote = list.find((s) => s.name === 'remote');
  assert.equal(remote.type, 'http');
  assert.equal(remote.url, 'https://mcp.example.com/v1');
});

await test('导入的 MCP 默认不启用（不能偷偷起进程）', () => {
  const list = scanLocalMcpServers();
  for (const s of list) assert.equal(s.enabled, false);
});

await test('已导入的条目会被标记出来，避免重复导', () => {
  const found = scanLocalCapabilities({
    existingSkills: [{ title: '标准技能' }],
    existingMcp: [{ name: 'filesystem' }],
  });
  assert.equal(found.skills.find((s) => s.title === '标准技能').imported, true);
  assert.equal(found.skills.find((s) => s.title === 'bare').imported, false);
  assert.equal(found.mcpServers.find((s) => s.name === 'filesystem').imported, true);
  assert.equal(found.mcpServers.find((s) => s.name === 'remote').imported, false);
});

await test('扫描给出根目录，让用户知道从哪找的', () => {
  const found = scanLocalCapabilities();
  assert.equal(found.scannedFrom.skills, skillsDir);
  assert.equal(found.scannedFrom.mcp, path.join(agentDir, 'mcp.json'));
});

await test('转成库条目：skill 走 normalizeSkill', () => {
  const list = scanLocalSkills();
  const skill = localSkillToLibrary(list.find((s) => s.title === '标准技能'));
  assert.equal(skill.title, '标准技能');
  assert.equal(skill.summary, '一句话说明');
  assert.ok(skill.id);
});

await test('转成库条目：mcp 走 normalizeMcpServer', () => {
  const list = scanLocalMcpServers();
  const server = localMcpToLibrary(list.find((s) => s.name === 'filesystem'));
  assert.equal(server.name, 'filesystem');
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'npx');
  assert.equal(server.enabled, false);
});

await test('★ 扫描不修改用户的 pi 配置（只读）', () => {
  const skillFile = path.join(skillsDir, 'plain', 'SKILL.md');
  const mcpFile = path.join(agentDir, 'mcp.json');
  const before = {
    skill: fs.readFileSync(skillFile, 'utf8'),
    mcp: fs.readFileSync(mcpFile, 'utf8'),
    skillMtime: fs.statSync(skillFile).mtimeMs,
    mcpMtime: fs.statSync(mcpFile).mtimeMs,
    dirs: fs.readdirSync(skillsDir).sort(),
  };

  scanLocalCapabilities();
  scanLocalSkills();
  scanLocalMcpServers();

  assert.equal(fs.readFileSync(skillFile, 'utf8'), before.skill, 'SKILL.md 被改了');
  assert.equal(fs.readFileSync(mcpFile, 'utf8'), before.mcp, 'mcp.json 被改了');
  assert.equal(fs.statSync(skillFile).mtimeMs, before.skillMtime, 'SKILL.md 被写入了');
  assert.equal(fs.statSync(mcpFile).mtimeMs, before.mcpMtime, 'mcp.json 被写入了');
  assert.deepEqual(fs.readdirSync(skillsDir).sort(), before.dirs, 'skills 目录被动过');
});

await test('目录不存在时不报错，返回空列表', () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'nope');
  try {
    assert.deepEqual(scanLocalSkills(), []);
    assert.deepEqual(scanLocalMcpServers(), []);
    const found = scanLocalCapabilities();
    assert.deepEqual(found.skills, []);
    assert.deepEqual(found.mcpServers, []);
  } finally {
    process.env.PI_CODING_AGENT_DIR = saved;
  }
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} 通过，${failed} 失败`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
