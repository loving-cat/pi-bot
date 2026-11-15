/**
 * 用户自定义覆盖层的测试（规格 §13.1 四层配置的第②层）。
 *   node tests/overrides.mjs
 *
 * 守三条规格原话：
 *
 *   1. 「保留用户修改」—— 模板升级不许碰用户改过的字段
 *   2. 「冲突需明示」——  模板改了同一个字段 → 列出来让用户选，不静默取一方
 *   3. 「覆盖值不得突破有效授权上限」—— 覆盖不是扩权入口
 *
 * 第 3 条最容易破：覆盖看着只是"改个人设"，但只要能改 `mcpServers`、
 * 或者能无限加技能，它就变成了权限提升通道。所以是**白名单**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-override-'));
Object.assign(process.env, {
  PI_BOT_HOME: path.join(root, 'data'),
  PI_BOT_WORKSPACE: path.join(root, 'ws'),
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_PROBE: '0',
});
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const O = await import(new URL('../src/overrides.js', import.meta.url));
const {
  OVERRIDABLE_FIELDS, FORBIDDEN_FIELDS, CONFLICT,
  normalizeOverride, resolve, diffOnUpgrade, checkOverrideBounds, describeOverride,
} = O;

const results = [];
// ★ 用例必须**按声明顺序串行**跑：接线那几条共享 store 与 captures，
//   并发执行会互相污染（第一条刚 createBot，第二条就在读同一个 captures）。
const pending = [];
function test(name, fn) {
  pending.push({ name, fn });
}
async function runAll() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, err: err?.message || String(err) });
    }
  }
}

const base = (over = {}) => normalizeOverride({ botId: 'b_1', templateId: 'tpl_1', ...over });

// ---------------------------------------------------------------- 白名单
test('★ 允许覆盖的字段是白名单（新字段默认不可覆盖）', () => {
  assert.deepEqual([...OVERRIDABLE_FIELDS].sort(), ['emoji', 'model', 'persona', 'skills', 'tagline', 'thinking']);
  // 不许出现授权层字段
  for (const f of ['grants', 'grantId', 'policy', 'canDelegate']) {
    assert.ok(OVERRIDABLE_FIELDS.includes(f) === false, `${f} 绝不能进可覆盖清单`);
  }
});

test('★ 授权层字段一律拒绝（覆盖不能变成扩权通道）', () => {
  for (const field of ['grants', 'grantId', 'policy', 'policyRevision', 'canDelegate']) {
    const r = base({ values: { [field]: 'x' } });
    assert.equal(r.ok, false, `${field} 应当被拒`);
    assert.equal(r.code, 'forbidden_field');
  }
});

test('★ 能间接扩权的字段也拒（挂 MCP = 起子进程 = 新执行入口）', () => {
  for (const field of ['mcpServers', 'role', 'departmentIds', 'tools', 'allowedTools']) {
    const r = base({ values: { [field]: [] } });
    assert.equal(r.ok, false, `${field} 应当被拒`);
    assert.equal(r.code, 'forbidden_field');
  }
});

test('不认识的字段拒绝，并把白名单说出来（不然用户不知道能改什么）', () => {
  const r = base({ values: { nickname: 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_field');
  assert.match(r.text, /persona/);
});

// ---------------------------------------------------------------- 规范化
test('字符串字段被截到合理长度（防止一条覆盖撑爆 state.json）', () => {
  const r = base({ values: { persona: 'x'.repeat(10_000) } });
  assert.equal(r.ok, true);
  assert.ok(r.override.values.persona.length <= 4000);
});

test('skills 规范化成 id 列表，且有上限', () => {
  const r = base({ values: { skills: Array.from({ length: 100 }, (_, i) => ({ id: `sk_${i}` })) } });
  assert.equal(r.ok, true);
  assert.equal(r.override.values.skills.length, 40);
  assert.ok(r.override.values.skills.every((s) => typeof s === 'string'));
});

test('skills 不是数组就拒（不要"尽力而为"地猜）', () => {
  assert.equal(base({ values: { skills: 'a,b' } }).code, 'invalid');
});

test('非字符串值拒（这次不猜，说清楚是哪个字段）', () => {
  const r = base({ values: { persona: 123 } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.match(r.text, /persona/);
});

test('没有 botId 就拒（覆盖必须绑定到具体 bot）', () => {
  assert.equal(normalizeOverride({ values: { persona: 'x' } }).code, 'invalid');
});

// ---------------------------------------------------------------- 合成
test('★ 模板没给的字段：用户的直接用，不算冲突', () => {
  const ov = base({ values: { emoji: '🐱' } }).override;
  const r = resolve({ templateValues: { persona: '模板人设' }, override: ov });
  assert.equal(r.values.emoji, '🐱');
  assert.equal(r.sources.emoji, 'user');
  assert.deepEqual(r.conflicts, [], '这不该报冲突 —— 模板根本没这个字段');
});

test('★ 模板和用户都改了同一个字段：按 keepUser 保留用户的，但冲突要列出来', () => {
  const ov = base({ values: { persona: '我要的' } }).override;
  const r = resolve({ templateValues: { persona: '模板的' }, override: ov });
  assert.equal(r.values.persona, '我要的', '默认保留用户修改（规格第 1 条）');
  assert.equal(r.sources.persona, 'user');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].field, 'persona');
  assert.equal(r.conflicts[0].template, '模板的');
  assert.equal(r.conflicts[0].user, '我要的');
});

test('★ 冲突必须明示：即使策略是 keepUser 也要列出来（让用户知道模板也改了）', () => {
  for (const policy of [CONFLICT.keepUser, CONFLICT.undecided]) {
    const ov = base({ values: { persona: 'u' }, conflicts: { persona: policy } }).override;
    const r = resolve({ templateValues: { persona: 't' }, override: ov });
    assert.equal(r.conflicts.length, 1, `${policy} 也应当列出来`);
  }
});

test('用户显式选"跟随模板"时才用模板值', () => {
  const ov = base({ values: { persona: 'u' }, conflicts: { persona: CONFLICT.takeTemplate } }).override;
  const r = resolve({ templateValues: { persona: 't' }, override: ov });
  assert.equal(r.values.persona, 't');
  assert.equal(r.sources.persona, 'template');
  assert.deepEqual(r.conflicts, [], '已经决定了就不该再列成"待处理冲突"');
});

test('值一模一样不算冲突（模板恰好也改成了用户要的）', () => {
  const ov = base({ values: { persona: 'same' } }).override;
  const r = resolve({ templateValues: { persona: 'same' }, override: ov });
  assert.equal(r.sources.persona, 'both');
  assert.deepEqual(r.conflicts, []);
});

test('数组按内容比，不按引用比（技能顺序不同算不同）', () => {
  const ov = base({ values: { skills: ['a', 'b'] } }).override;
  assert.equal(resolve({ templateValues: { skills: ['a', 'b'] }, override: ov }).sources.skills, 'both');
  assert.equal(resolve({ templateValues: { skills: ['b', 'a'] }, override: ov }).sources.skills, 'user');
});

test('每个字段都能说出值来自哪一层（不然"为什么不是模板里的"没人答得上）', () => {
  const ov = base({ values: { persona: 'u', model: 'm2' } }).override;
  const r = resolve({ templateValues: { persona: 't', tagline: 'tl' }, override: ov });
  assert.equal(r.sources.persona, 'user');
  assert.equal(r.sources.model, 'user');
  assert.equal(r.sources.tagline, 'template');
});

test('没有覆盖时原样返回模板值', () => {
  const r = resolve({ templateValues: { persona: 't', model: 'm' }, override: null });
  assert.deepEqual(r.values, { persona: 't', model: 'm' });
  assert.deepEqual(r.sources, { persona: 'template', model: 'template' });
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.staleTemplate, false);
});

// ---------------------------------------------------------------- 模板升级
test('★ 模板升级：只列"模板改了、而用户也改过"的字段', () => {
  const ov = base({ values: { persona: 'u', emoji: '🐱' } }).override;
  const d = diffOnUpgrade({
    override: ov,
    oldTemplate: { persona: 'old', emoji: '🐶', model: 'm1' },
    newTemplate: { persona: 'new', emoji: '🐶', model: 'm2' },
  });
  assert.deepEqual(d.changed.map((c) => c.field), ['persona'], 'emoji 模板没改、model 用户没改，都不该进列表');
  assert.equal(d.changed[0].before, 'old');
  assert.equal(d.changed[0].after, 'new');
  assert.equal(d.changed[0].userValue, 'u');
});

test('模板升级不会自动覆盖用户值（只是列出来让人决定）', () => {
  const ov = base({ values: { persona: 'u' } }).override;
  const d = diffOnUpgrade({ override: ov, oldTemplate: { persona: 'old' }, newTemplate: { persona: 'new' } });
  assert.equal(d.changed.length, 1);
  // 覆盖本身没变
  assert.equal(ov.values.persona, 'u');
});

test('模板版本变了会标出来（用户的覆盖可能已经不适用）', () => {
  const ov = base({ templateVersion: 'v1', values: { persona: 'u' } }).override;
  assert.equal(resolve({ templateValues: { persona: 't' }, override: ov, templateVersion: 'v2' }).staleTemplate, true);
  assert.equal(resolve({ templateValues: { persona: 't' }, override: ov, templateVersion: 'v1' }).staleTemplate, false);
});

// ---------------------------------------------------------------- 越界
test('★ 技能数量超上限判越界（覆盖不能扩大能力范围）', () => {
  const ov = base({ values: { skills: Array.from({ length: 20 }, (_, i) => `sk_${i}`) } }).override;
  const r = checkOverrideBounds({ override: ov, maxSkills: 12 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_wide');
  assert.match(r.text, /覆盖不能扩大/);
});

test('正常覆盖不越界', () => {
  const ov = base({ values: { persona: 'x', skills: ['a', 'b'] } }).override;
  assert.equal(checkOverrideBounds({ override: ov, maxSkills: 12 }).ok, true);
});

test('没有覆盖时越界检查通过（不能因为"没数据"报错）', () => {
  assert.equal(checkOverrideBounds({ override: null }).ok, true);
});

// ---------------------------------------------------------------- 描述
test('describeOverride 说清改了什么（日志/界面用）', () => {
  const ov = base({ values: { persona: 'x', model: 'm' }, conflicts: { persona: CONFLICT.keepUser } }).override;
  const text = describeOverride(ov);
  assert.match(text, /b_1/);
  assert.match(text, /persona/);
  assert.match(text, /冲突/);
  assert.equal(describeOverride(null), '(没有用户覆盖)');
});

test('★ 覆盖只允许白名单字段 —— 这条要能挡住"以后顺手加个字段"', () => {
  // 把 FORBIDDEN 的每个字段都试一遍，确保一个都进不来
  for (const field of FORBIDDEN_FIELDS) {
    const r = base({ values: { [field]: 'x' } });
    assert.equal(r.ok, false, `${field} 必须被拒，否则覆盖就成了扩权通道`);
  }
});

// ---------------------------------------------------------------- 真的生效吗
//
// 前面都是纯逻辑。这一段是**接线验证** —— 覆盖写完，会话里的人设真的变了吗？
// 只有这一段能证明"用户改了人设"不是一句空话。

const { store } = await import(new URL('../src/store.js', import.meta.url));
const { PiRunner } = await import(new URL('../src/pi-runner.js', import.meta.url));
const { createSessionBuilder } = await import(new URL('../src/session-factory.js', import.meta.url));

const runner = new PiRunner();
runner.model = { provider: 'fixture', id: 'fixture', contextWindow: 10000, maxTokens: 1000 };
runner.modelRuntime = { completeSimple: () => {} };
const captures = [];
const sessionApi = {
  getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
  SessionManager: { create: () => ({}), open: () => ({}) },
  DefaultResourceLoader: class {
    constructor(options) { this.options = options; this.mcp = []; }
    async reload() {}
  },
  async createAgentSession(options) {
    captures.push(options);
    return {
      session: {
        model: runner.model, options,
        subscribe: () => () => {}, dispose: () => {}, abort: async () => {}, prompt: async () => {},
      },
    };
  },
  createBashTool: () => ({ name: 'bash' }),
  createPowerShellTool: () => ({ name: 'powershell' }),
};
const builder = createSessionBuilder({
  runner, sessionApi,
  getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
  modelLabel: () => 'fixture', logger: null,
});

async function promptOf(botId) {
  await builder(store.ensureDm(botId).id, botId);
  const o = captures[captures.length - 1];
  const asp = o?.resourceLoader?.options?.appendSystemPrompt;
  return Array.isArray(asp) ? asp.join(String.fromCharCode(10)) : String(asp ?? '');
}

test('★ 接线：覆盖写进 store 后，会话里的人设真的换了', async () => {
  const bot = store.createBot({ name: 'ov-fixture', persona: '模板写的：你是个老实人' });
  store.setBotOverride({ botId: bot.id, templateId: 'tpl_x', values: { persona: '用户改的：你是个毒舌' } });
  const text = await promptOf(bot.id);
  assert.ok(text.includes('毒舌'), '会话提示里应当出现用户覆盖后的人设');
  assert.ok(!text.includes('老实人'), '模板原句不该再出现（覆盖优先级更高）');
});

test('★ 接线：没有覆盖的 bot 仍然用模板人设', async () => {
  const bot = store.createBot({ name: 'ov-fixture2', persona: '模板写的：你是个老实人' });
  const text = await promptOf(bot.id);
  assert.ok(text.includes('老实人'));
});

test('★ 接线：清掉覆盖就回到模板原样（用户能反悔）', async () => {
  const bot = store.createBot({ name: 'ov-fixture3', persona: '模板原样' });
  store.setBotOverride({ botId: bot.id, templateId: 'tpl_x', values: { persona: '临时改的' } });
  assert.ok((await promptOf(bot.id)).includes('临时改的'));
  store.clearBotOverride(bot.id);
  const after = await promptOf(bot.id);
  assert.ok(after.includes('模板原样'), '清掉覆盖后应当回到模板');
  assert.ok(!after.includes('临时改的'));
});

test('★ 覆盖不许改能力字段 —— 走 store 也拦得住', () => {
  const bot = store.createBot({ name: 'ov-fixture4', persona: 'p' });
  const r = store.setBotOverride({ botId: bot.id, values: { mcpServers: ['evil'] } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'forbidden_field');
  // 确认真的没写进去
  assert.equal(store.botOverride(bot.id), null);
});

await runAll();
clearTimeout(store.saveTimer);
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
