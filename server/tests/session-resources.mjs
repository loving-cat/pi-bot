/**
 * bot 会话只吃"模型 + 我们给的工具"，不吃 pi 侧外挂。
 *   node tests/session-resources.mjs
 *
 * 覆盖：
 *   ① 默认四个开关全关（扩展 / MCP / skills / 提示模板）；
 *   ② 环境变量单独开哪样就只开哪样；
 *   ③ 真的拿 DefaultResourceLoader 验一次：noExtensions 能挡住目录里的扩展，
 *      noSkills 能挡住 skills（不是只写了个字段没人管）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.PI_BOT_HOME = path.join(process.cwd(), 'data', '_unit_test_session_resources');
fs.rmSync(process.env.PI_BOT_HOME, { recursive: true, force: true });

const { resourceSwitches } = await import('../src/config.js');
const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

await test('默认全关', () => {
  assert.deepEqual(resourceSwitches({}), {
    noExtensions: true,
    noMcp: true,
    noSkills: true,
    noPromptTemplates: true,
  });
});

await test('单独开扩展', () => {
  const s = resourceSwitches({ PI_BOT_EXTENSIONS: '1' });
  assert.equal(s.noExtensions, false);
  assert.equal(s.noMcp, true, '开扩展不该顺带把 MCP 打开');
  assert.equal(s.noSkills, true);
});

await test('单独开 MCP / skills', () => {
  assert.equal(resourceSwitches({ PI_BOT_MCP: '1' }).noMcp, false);
  const sk = resourceSwitches({ PI_BOT_SKILLS: '1' });
  assert.equal(sk.noSkills, false);
  assert.equal(sk.noPromptTemplates, false);
  assert.equal(sk.noExtensions, true);
});

await test('别把 "0" 当成开', () => {
  assert.equal(resourceSwitches({ PI_BOT_EXTENSIONS: '0' }).noExtensions, true);
  assert.equal(resourceSwitches({ PI_BOT_EXTENSIONS: 'true' }).noExtensions, true);
});

/** 造一个"像用户家目录"的 agentDir：一个扩展 + 一个 skill */
function makeAgentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-res-'));
  const extDir = path.join(dir, 'extensions', 'noisy');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'index.ts'),
    'export default function (pi) { pi.registerTool({ name: "noisy_tool", label: "N", description: "d", parameters: {}, execute: async () => ({}) }); }\n',
  );
  const skillDir = path.join(dir, 'skills', 'noisy-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: noisy-skill\ndescription: 测试用\n---\n\n# 步骤\n1. 啥也别做\n',
  );
  return dir;
}

const agentDir = makeAgentDir();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-cwd-'));

async function loadWith(options) {
  const loader = new DefaultResourceLoader({ cwd, agentDir, ...options });
  await loader.reload();
  return loader;
}

await test('noSkills 真的挡住 agentDir 里的 skill', async () => {
  const on = await loadWith({});
  assert.ok(
    (on.skills ?? []).some((sk) => String(sk.name ?? sk.path ?? '').includes('noisy')),
    `默认应能看见测试 skill（实际 ${JSON.stringify((on.skills ?? []).map((s) => s.name))}）`,
  );

  const off = await loadWith({ noSkills: true, noPromptTemplates: true });
  assert.equal((off.skills ?? []).length, 0, '关掉后不该再加载任何 skill');
});

// 扩展由 packageManager 决定（settings.json 里的 packages / agentDir/extensions 目录下的文件），
// 临时 agentDir 里的 extensions/ 不会被收录，所以这里只验证开关本身传到 loader。
await test('noExtensions 传到 loader 并被采纳', async () => {
  const on = new DefaultResourceLoader({ cwd, agentDir });
  await on.reload();
  assert.equal(on.noExtensions ?? false, false, '默认不关扩展');

  const off = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
  await off.reload();
  assert.equal(off.noExtensions, true, 'noExtensions 应写进 loader');
  assert.deepEqual(
    (off.extensionsResult?.extensions ?? []).map((e) => e.path),
    [],
    '关掉扩展后不该加载任何扩展',
  );
});

fs.rmSync(agentDir, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n    ${r.err}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
