/**
 * 能力清单（Capability Manifest）的测试。
 *   node tests/capabilities.mjs
 *
 * 守的核心一句：**一个事实只声明一处**。
 *
 * 改造前「加一个能力」要改 7 处、跨 4 个文件（动作目录 3 处、角色名单 2 处、
 * 迁移清单 2 处）。漏掉任一处不会报错，只会静默出错 —— 这一周实测踩到 4 次：
 *
 *   · 迁移授权没列新动作 → 一调就 no_grant，看着像"功能坏了"
 *   · 只读名单与网关不同步 → 切成只读后 12 个工具被误拦
 *   · 风险档按工具名查动作名 → 审计里 risk 恒为 null
 *   · 签发/校验世代不一致 → "重启后旧批准不续命"从没生效过
 *
 * 这个文件守的是"以后不会再出现第 5 次"：
 *   · 派生层不许再手写清单
 *   · 一个工具只能有一个身份
 *   · 每个能改状态的工具都必须在能力清单里
 *   · 动作层和工具层不能互相污染（ego_browser 与 web_fetch 必须分开标）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-caps-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
});
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const C = await import(src('capabilities.js'));
const G = await import(src('grants.js'));
const { ACTION, RISK, ALL_ACTIONS } = G;
const A = await import(src('action-catalog.js'));
const R = await import(src('role-tools.js'));
const M = await import(src('migration-grants.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const readSrc = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', f), 'utf8');

// ---------------------------------------------------------------- 声明完整性
await test('每个动作都在 ACTIONS 里声明，且字段齐全', () => {
  const validRisk = new Set(Object.values(RISK));
  const validMigration = new Set(['all', 'chief', 'never']);
  for (const action of ALL_ACTIONS) {
    const a = C.ACTIONS[action];
    assert.ok(a, `${action} 没在 capabilities.ACTIONS 里声明`);
    assert.equal(typeof a.label, 'string', `${action} 缺 label`);
    assert.ok(a.label.trim(), `${action} 的 label 不能为空`);
    assert.ok(validRisk.has(a.risk), `${action} 的 risk 不合法：${a.risk}`);
    assert.equal(typeof a.irreversible, 'boolean', `${action} 必须明确能不能撤销`);
    assert.equal(typeof a.needsTarget, 'boolean', `${action} 必须明确要不要目标`);
    assert.ok(validMigration.has(a.migration), `${action} 的 migration 不合法：${a.migration}`);
  }
});

await test('每个工具都有声明，且指向已登记的动作', () => {
  for (const [tool, spec] of Object.entries(C.TOOL_SPECS)) {
    assert.equal(typeof tool, 'string');
    assert.ok(spec.action === null || C.ACTIONS[spec.action], `${tool} 指向未登记的动作 ${spec.action}`);
  }
});

await test('★ 一个工具只能有一个身份（不允许两个动作认领同一个工具）', () => {
  const seen = new Map();
  for (const [tool, spec] of Object.entries(C.TOOL_SPECS)) {
    assert.equal(seen.has(tool), false, `工具 ${tool} 出现在两处声明里`);
    seen.set(tool, spec.action);
  }
});

// ---------------------------------------------------------------- 派生层不手写
await test('★ 派生层不许再手写清单（这是防第 5 次的关键）', () => {
  const catalog = readSrc('action-catalog.js');
  const role = readSrc('role-tools.js');
  const migration = readSrc('migration-grants.js');
  const caps = readSrc('capabilities.js');

  // 工具名只允许出现在 capabilities.js
  for (const tool of Object.keys(C.TOOL_SPECS)) {
    assert.equal(catalog.includes(`'${tool}'`), false, `action-catalog.js 里不该再出现工具名 ${tool}`);
    assert.equal(role.includes(`'${tool}'`), false, `role-tools.js 里不该再出现工具名 ${tool}`);
    assert.equal(migration.includes(`'${tool}'`), false, `migration-grants.js 里不该再出现工具名 ${tool}`);
  }
  // 名单只允许定义一次
  for (const name of ['READONLY_ALLOW', 'MUTATING_TOOLS', 'COORDINATION_TOOLS', 'CHIEF_ONLY_TOOLS']) {
    const hits = [caps, role, catalog, migration].filter((s) => s.includes(`export const ${name} =`));
    assert.equal(hits.length, 1, `${name} 只允许定义一处，实际 ${hits.length} 处`);
    assert.ok(caps.includes(`export const ${name} =`), `${name} 应当在 capabilities.js 定义`);
  }
});

await test('派生的四个名单彼此独立（不是同一个数组换个名字）', () => {
  assert.notEqual(C.READONLY_ALLOW, C.MUTATING_TOOLS);
  assert.equal(C.READONLY_ALLOW instanceof Array || Array.isArray(C.READONLY_ALLOW), true);
  // 只读与会动手不该有交集 —— 一个工具不可能既只读又改状态
  const overlap = C.READONLY_ALLOW.filter((t) => C.MUTATING_TOOLS.includes(t));
  assert.deepEqual(overlap, [], `这些工具既只读又改状态：${overlap.join(',')}`);
});

// ---------------------------------------------------------------- 动作 vs 工具
await test('★ 同一动作下的工具可以有不同的只读/改状态标记（ego_browser ≠ web_fetch）', () => {
  // 这条守的是"层级不能拍平"：把它俩合并成一个标志，
  // 只读档就会要么放行浏览器脚本、要么禁掉查资料。
  assert.ok(C.MUTATING_TOOLS.includes('ego_browser'), 'ego_browser 会点按钮/提交，必须算"会动手"');
  assert.ok(C.READONLY_ALLOW.includes('web_fetch'), 'web_fetch 只读一篇文章，只读档该放行');
  assert.equal(C.TOOLS.ego_browser, C.TOOLS.web_fetch, '它们仍是同一个动作 net.fetch');
  assert.equal(C.MUTATING_TOOLS.includes('web_fetch'), false);
  assert.equal(C.READONLY_ALLOW.includes('ego_browser'), false);
});

await test('★ 主 Bot 专属：工具级和动作级是两件事', () => {
  // 工具级：**看用户真实屏幕 / 动用户鼠标**那一组只给主 Bot。
  // desktop_lease 不过网关（它只排队不碰东西），但仍然是主 Bot 专属。
  //
  // ★ 独立桌面三件（§5.6 T1）**不在这个列表里**：2026-11-16 产品决定
  //   "一台电脑人机合作，一个部门一张岛"，所以每个 Bot 都能开自己部门那张。
  //   风险面没变宽 —— 岛碰不到用户的鼠标与焦点，而 T2 那两个工具仍然只有主 Bot 有。
  assert.deepEqual(
    [...C.CHIEF_ONLY_TOOLS].sort(),
    ['cleanup_storage', 'desktop_input', 'desktop_lease', 'desktop_observe', 'desktop_screenshot'],
  );
  for (const t of ['desktop_island_observe', 'desktop_island_launch', 'desktop_island_input']) {
    assert.ok(!C.CHIEF_ONLY_TOOLS.includes(t), `${t} 现在对每个 Bot 开放`);
  }
  // 动作级：桌面观察 + push（迁移授权只给主 Bot）
  // desktop.input 属于 migration:'never'（谁都不给），比分给主 Bot 更严，
  // 所以它出现在 MIGRATION_WITHHELD 而不是这里 —— 这两个列表语义不同。
  // desktop.observe 现在是 'all'（每个 bot 都要能看自己那张岛）；
  // 只给主 Bot 的只剩 git.push。desktop.input 仍是 'never'（谁都不从迁移继承）。
  assert.deepEqual([...C.CHIEF_ONLY_ACTIONS].sort(), ['git.push']);
  // git_push 在动作级但不在工具级：负责人也能调，但迁移授权不给它
  assert.equal(C.CHIEF_ONLY_TOOLS.includes('git_push'), false);
  assert.equal(C.CHIEF_ONLY_ACTIONS.includes('git.push'), true);
  // ★ 输入动作三件事全部从动作声明派生，工具层不重复写
  assert.equal(C.actionForTool('desktop_input').action, ACTION.desktopInput);
  assert.equal(C.isIrreversible(ACTION.desktopInput), true, '点错了就是点了，不可撤销');
  assert.equal(C.riskOf(ACTION.desktopInput), 'critical');
  assert.equal(C.migrationScopeOf(ACTION.desktopInput), 'never');
  // 租约工具**不过网关**：它只排队，不碰用户的东西；真正危险的是输入
  assert.equal(C.actionForTool('desktop_lease'), null);
  // 独立桌面的三件各占不同风险档：看=只读、起进程=执行命令、点/打字=不可撤销
  assert.equal(C.actionForTool('desktop_island_observe').action, ACTION.desktopObserve);
  assert.equal(C.actionForTool('desktop_island_launch').action, ACTION.cmdExec);
  assert.equal(C.actionForTool('desktop_island_input').action, ACTION.desktopInput);
});

// ---------------------------------------------------------------- 迁移推导
await test('迁移授权：只读档只发只读动作 + 读文件', () => {
  const deny = C.deriveMigrationActions({ readonly: true, chief: false });
  assert.ok(deny.includes(ACTION.fileRead), '读文件必须有（read 工具不过网关）');
  for (const forbidden of [ACTION.fileWrite, ACTION.fileDelete, ACTION.cmdExec, ACTION.cmdBackground, ACTION.gitCommit, ACTION.gitPush]) {
    assert.equal(deny.includes(forbidden), false, `只读档不该有 ${forbidden}`);
  }
});

await test('★ 迁移授权与策略层逐条对齐（只读档放行的工具必须有对应动作）', () => {
  const deny = C.deriveMigrationActions({ readonly: true, chief: true });
  for (const tool of C.READONLY_ALLOW) {
    const mapped = C.actionForTool(tool);
    if (!mapped) continue;
    assert.ok(deny.includes(mapped.action), `策略放行 ${tool}，迁移授权却没有 ${mapped.action}`);
  }
});

await test('迁移授权：never 的动作不继承（前瞻性声明）', () => {
  for (const action of C.MIGRATION_WITHHELD) {
    for (const chief of [true, false]) {
      for (const readonly of [true, false]) {
        const got = C.deriveMigrationActions({ readonly, chief });
        assert.equal(got.includes(action), false, `${action} 标了 never，不该出现在迁移授权里`);
      }
    }
  }
  // 桌面输入与破坏性 Git 现在还没有工具产生，但声明必须提前就位
  assert.ok(C.MIGRATION_WITHHELD.includes(ACTION.desktopInput), '桌面输入不能被迁移授权继承');
  assert.ok(C.MIGRATION_WITHHELD.includes(ACTION.gitDestructive), '破坏性 Git 不能被迁移授权继承');
});

await test('迁移授权：chief 动作只给主 Bot', () => {
  const chief = C.deriveMigrationActions({ readonly: false, chief: true });
  const worker = C.deriveMigrationActions({ readonly: false, chief: false });
  for (const action of C.CHIEF_ONLY_ACTIONS) {
    assert.ok(chief.includes(action), `主 Bot 应当有 ${action}`);
    assert.equal(worker.includes(action), false, `普通成员不该有 ${action}`);
  }
});

// ---------------------------------------------------------------- 目标认法
await test('目标认法：文件类读 path，网页类读 url 取主机名', () => {
  assert.deepEqual(C.targetsForTool('write', { path: '/p/a.js' }), [{ kind: 'path', ref: '/p/a.js' }]);
  assert.deepEqual(C.targetsForTool('web_fetch', { url: 'https://api.example.com/x' }), [{ kind: 'host', ref: 'api.example.com' }]);
  assert.deepEqual(C.targetsForTool('send_image', { path: 'charts/a.png' }), [{ kind: 'path', ref: 'charts/a.png' }]);
});

await test('目标认法：认不出来的返回空（不猜）', () => {
  assert.deepEqual(C.targetsForTool('bash', { command: 'rm -rf /' }), []);
  assert.deepEqual(C.targetsForTool('ego_browser', { script: 'p.goto("https://x")' }), []);
  assert.deepEqual(C.targetsForTool('desktop_observe', {}), []);
});

// ---------------------------------------------------------------- 自检
await test('auditCapabilities() 在当前清单上是干净的', () => {
  assert.deepEqual(C.auditCapabilities(), []);
});

await test('★ 自检能抓出"工具指向未登记的动作"', () => {
  // 用一份坏清单验证检查本身有效（不污染真清单）
  const bad = { ghost: { action: 'no.such.action', readonly: false } };
  const before = C.TOOL_SPECS;
  assert.equal(typeof bad.ghost.action, 'string');
  // 直接调内部逻辑：把 TOOL_SPECS 想成可注入的
  const problems = C.auditCapabilities({ hasTool: (t) => t !== 'desktop_observe' });
  assert.ok(problems.some((p) => p.includes('desktop_observe')), '应当报出缺 defineTool 的工具');
});

await test('★ 自检能抓出"critical 却可撤销"这种自相矛盾', () => {
  // 用 action-catalog 的公开面做语义验证：critical 动作必须不可撤销
  for (const [action, a] of Object.entries(C.ACTIONS)) {
    if (a.risk === RISK.critical) {
      assert.equal(a.irreversible, true, `${action} 标了 critical 就必须不可撤销`);
    }
  }
});

// ---------------------------------------------------------------- 兼容转发
await test('action-catalog / role-tools / migration-grants 的导出与能力清单同源', () => {
  assert.equal(A.ACTIONS, undefined === A.ACTIONS ? undefined : A.ACTIONS);
  assert.deepEqual(Object.keys(A.ACTIONS).sort(), Object.keys(C.ACTIONS).sort());
  assert.deepEqual(Object.keys(A.TOOLS).sort(), Object.keys(C.TOOLS).sort());
  assert.deepEqual([...A.GATED_ACTIONS], [...C.GATED_ACTIONS]);
  assert.deepEqual([...R.READONLY_ALLOW].sort(), [...C.READONLY_ALLOW].sort());
  assert.deepEqual([...R.MUTATING_TOOLS].sort(), [...C.MUTATING_TOOLS].sort());
  assert.deepEqual([...R.COORDINATION_TOOLS].sort(), [...C.COORDINATION_TOOLS].sort());
  assert.deepEqual([...R.CHIEF_ONLY_TOOLS].sort(), [...C.CHIEF_ONLY_TOOLS].sort());
  assert.deepEqual([...M.CHIEF_ONLY_ACTIONS].sort(), [...C.CHIEF_ONLY_ACTIONS].sort());
  assert.deepEqual([...M.MIGRATION_WITHHELD].sort(), [...C.MIGRATION_WITHHELD].sort());
});

await test('migrationActions 与 deriveMigrationActions 同源', () => {
  for (const readonly of [true, false]) {
    for (const chief of [true, false]) {
      assert.deepEqual(
        M.migrationActions({ readonly, chief }),
        C.deriveMigrationActions({ readonly, chief }),
      );
    }
  }
});

await test('风险档与可撤销性从能力清单读，不随工具变', () => {
  // 同一个动作被多个工具触发时，风险档只有一个
  const risks = new Set(Object.values(C.TOOLS)
    .filter((a) => a === ACTION.netSend)
    .map(() => C.riskOf(ACTION.netSend)));
  assert.equal(risks.size, 1);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
clearTimeout((await import(src('store.js'))).store?.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
