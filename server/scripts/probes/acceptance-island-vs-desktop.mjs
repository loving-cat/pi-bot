/**
 * 实机验收 W6-2：T1 独立桌面 vs T2 用户桌面隔离。
 *
 *   cd server && node scripts/probes/acceptance-island-vs-desktop.mjs
 *
 * 对应 `docs/acceptance-matrix.md` §4「GUI 间接越权」与 W6 第 2 项门禁：
 *   **成员 Bot 调 `desktop_island_*` 不能越界观察/操控用户真实桌面**。
 *
 * 为什么要用“真实装配”而不是断言纯函数：T2 的边界有三道，任何一道单独测过
 * 都不代表合起来是通的 ——
 *
 *   1. **工具集**：`CHIEF_ONLY_TOOLS` 那一层让成员根本拿不到 `desktop_observe`
 *      （`customToolsForRole` 按 bot.role 过滤）；
 *   2. **授权网关**：即使旧会话里残留了工具句柄，`grantGate.check` 也要按
 *      `subject.role` 判（成员没有 desktop.observe 授权，主 Bot 有迁移授权）；
 *   3. **执行边界钩子**：`createPolicyExtension` 的 `tool_call` 回调把上面两件事
 *      接到真实调用链上 —— 这里用真实的 extension + 真实 grantGate 驱动一次。
 *
 * 全部在临时 dataDir 里跑（`PI_BOT_HOME` 指向 %TEMP%），不碰你正在用的配置。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-accept-island-'));
Object.assign(process.env, {
  PI_BOT_HOME: path.join(root, 'data'),
  PI_BOT_WORKSPACE: path.join(root, 'ws'),
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  PI_BOT_PROBE: '0',
});

const src = (f) => new URL(`../../src/${f}`, import.meta.url);
const { store } = await import(src('store.js'));
const C = await import(src('capabilities.js'));
const R = await import(src('role-tools.js'));
const { createGrantGate } = await import(src('grant-gate.js'));
const { ensureLegacyGrant } = await import(src('migration-grants.js'));
const { createPolicyExtension } = await import(src('policy-hook.js'));
// config.js 只导出 `config`（没有 defaultConfig）—— 解构错名字会得到 undefined，
// 展开成 `{}` 后不报错，只是悄悄用了一份残缺配置（假绿的经典来源）。
const { config: appConfig } = await import(src('config.js'));

const problems = [];
const say = (s) => console.log(s);

// ────────────────────────────── 0. 临时环境：一个主控 + 一个成员
// ★ state.bots 是对象 map（`store.getBot(id)` 走 `state.bots[id]`），不是数组
store.state.bots = {
  bot_main: {
    id: 'bot_main', name: '主控', role: 'main', provider: 'fake', model: 'fake',
    persona: '', createdAt: Date.now(),
  },
  bot_worker: {
    id: 'bot_worker', name: '成员', role: 'member', provider: 'fake', model: 'fake',
    persona: '', createdAt: Date.now(),
  },
};
store.state.rooms = [{
  id: 'room_accept', name: '验收组', kind: 'group', botIds: ['bot_main', 'bot_worker'],
  leadBotId: 'bot_main', createdAt: Date.now(),
}];
ensureLegacyGrant({
  store,
  policy: store.policy(),
  policyRevision: store.policyVersion(),
  botIds: ['bot_main', 'bot_worker'],
  chiefBotId: 'bot_main',
});
say(`临时数据目录：${root}`);

// ────────────────────────────── 1. 工具集这一层
const CHIEF_ONLY = new Set(R.CHIEF_ONLY_TOOLS ?? []);
say('');
say('【1】工具集（按角色派生，成员根本不该拿到 T2 工具）');
for (const name of ['desktop_observe', 'desktop_screenshot', 'desktop_input', 'desktop_lease',
  'desktop_island_observe', 'desktop_island_input', 'desktop_island_launch']) {
  const registered = Boolean(C.TOOL_SPECS?.[name]);
  const chiefOnly = CHIEF_ONLY.has(name);
  const expectChiefOnly = name.startsWith('desktop_') && !name.startsWith('desktop_island_');
  const ok = registered && chiefOnly === expectChiefOnly;
  say(`  ${ok ? '✓' : '✗'} ${name.padEnd(24)} 已注册=${registered} chiefOnly=${chiefOnly}（期望 ${expectChiefOnly}）`);
  if (!ok) problems.push(`${name} 的 chiefOnly 与期望不符`);
}

// 真实过滤函数：成员拿不到 T2，但拿得到 T1
const allTools = Object.keys(C.TOOL_SPECS ?? {}).map((name) => ({ name }));
const memberView = new Set(R.customToolsForRole(allTools, {
  room: store.state.rooms[0],
  bot: store.getBot('bot_worker'),
  policy: store.policy(),
}).map((t) => t.name));
const mainView = new Set(R.customToolsForRole(allTools, {
  room: store.state.rooms[0],
  bot: store.getBot('bot_main'),
  policy: store.policy(),
}).map((t) => t.name));

for (const name of ['desktop_observe', 'desktop_screenshot', 'desktop_input', 'desktop_lease']) {
  if (memberView.has(name)) problems.push(`成员的工具清单里居然有 ${name}`);
  if (!mainView.has(name)) problems.push(`主控的工具清单里没有 ${name}`);
}
if (!memberView.has('desktop_island_observe')) {
  problems.push('成员的清单里没有 desktop_island_observe（T1 应该给成员可用）');
}
say(`  成员可见工具 ${memberView.size} 个 / 主控 ${mainView.size} 个；成员无 desktop_observe 与 desktop_input ✓`);

// ────────────────────────────── 2. 授权网关这一层
say('');
say('【2】授权网关（就算旧会话残留了工具句柄，也要按主体判）');
const gate = createGrantGate({
  store,
  currentPolicyRevision: () => store.policyVersion(),
  currentGeneration: () => 'gen-accept',
});
const ACTION = { desktopObserve: 'desktop.observe', desktopInput: 'desktop.input' };

// ★ 这里刻意不做“成员必须被拒”的断言：`desktop.observe` 这个**动作**
//   从 2026-11-16 起 migration 是 'all' —— 因为 T1 独立桌面上的观察用的也是它
//   （每个 Bot 都该能看见自己那张岛在干什么）。真正的 T2 边界在**工具级**：
//   `desktop_observe` / `desktop_screenshot` 是 chiefOnly，成员拿不到那个工具。
//   所以这一段验的是“动作级放行是预期的、且属于设计”，不是越权。
const memberVerdict = gate.check({
  subject: { botId: 'bot_worker', role: 'member', instanceId: '' },
  action: ACTION.desktopObserve,
  targets: [],
  params: {},
  taskId: null,
});
say('  （注：这里 targets 传空 = “不限目标”，网关会宽松些；真实路径用的是'
  + ' targetsForTool 算出的具体目标，见第 3 段）');
say(`  成员 desktop.observe（动作级）→ ${memberVerdict.ok ? 'ok' : memberVerdict.code}`
  + `（action migration='all'：T1 共用这个动作，属设计）`);
if (!memberVerdict.ok) {
  problems.push(`成员连动作级 desktop.observe 都拿不到（T1 就废了）：${memberVerdict.code}`);
}

const mainVerdict = gate.check({
  subject: { botId: 'bot_main', role: 'main', instanceId: '' },
  action: ACTION.desktopObserve,
  targets: [],
  params: {},
  taskId: null,
});
say(`  主控调 desktop.observe → ${mainVerdict.ok ? 'ok（迁移授权给的）' : `${mainVerdict.code}`}`);
if (!mainVerdict.ok) problems.push(`主控拿不到 desktop.observe：${mainVerdict.text ?? mainVerdict.code}`);

const memberInput = gate.check({
  subject: { botId: 'bot_worker', role: 'member', instanceId: '' },
  action: ACTION.desktopInput,
  targets: [],
  params: {},
  taskId: null,
});
say(`  成员调 desktop.input → ${memberInput.ok ? 'ok（不该发生！）' : memberInput.code}`);
if (memberInput.ok) problems.push('成员居然通过了 desktop.input 的网关检查');

// ────────────────────────────── 3. 执行边界钩子这一层
say('');
say('【3】执行边界钩子（真实 createPolicyExtension 驱动一次 tool_call）');
function driveToolCall({ botId, tool, input = {} }) {
  const bot = store.getBot(botId);
  // ★ mode 必须按真实角色给：主控是 host（Jarvis 宿主），成员是 project。
  //   早先这里给成员也传 'host'，结果是“模式不匹配”把它拦住了 —— 看起来像拦对了，
  //   实际是假绿：真实会话里成员用的是 project，那条路根本没被验。
  const mode = bot?.role === 'main' ? 'host' : 'project';
  const hooks = [];
  const fakePi = {
    on: (event, cb) => { if (event === 'tool_call') hooks.push(cb); },
    registerTool: () => {},
    registerCommand: () => {},
  };
  const ext = createPolicyExtension({
    roomId: 'room_accept',
    bot,
    grantGate: gate,
    config: {
      ...appConfig,
      jarvisMode: true,
      workspace: path.join(root, 'ws'),
      dataDir: path.join(root, 'data'),
    },
    store,
    mode,
  });
  ext.factory(fakePi);
  if (!hooks.length) return { block: false, reason: '(没有注册 tool_call 钩子)' };
  const event = { toolName: tool, input: { ...input } };
  return hooks[0](event) ?? { block: false };
}

const memberHook = driveToolCall({ botId: 'bot_worker', tool: 'desktop_observe' });
say(`  成员（project）desktop_observe → ${memberHook.block ? 'block' : 'allow'}：${String(memberHook.reason ?? '').slice(0, 80)}`);
if (!memberHook.block) problems.push('执行边界没拦住成员调 desktop_observe（T2 越界）');
// 成员被拦的理由应当是"只给主控"这一道（工具级 chiefOnly），不是别的偶然原因
if (memberHook.block && !/只给主控/.test(String(memberHook.reason ?? ''))) {
  problems.push(`拦住理由不是 chiefOnly 兜底，可能只是别的原因碰巧挡住：${memberHook.reason}`);
}

// T1 的 island 工具：成员本来就该能用，不能被 chiefOnly 这道门拦
const islandHook = driveToolCall({ botId: 'bot_worker', tool: 'desktop_island_observe' });
say(`  成员（project）desktop_island_observe → ${islandHook.block ? 'block' : 'allow'}：${String(islandHook.reason ?? '').slice(0, 80)}`);
if (islandHook.block && /只给主控/.test(String(islandHook.reason ?? ''))) {
  problems.push('T1 的 desktop_island_observe 被 chiefOnly 兜底误拦了（成员就废了）');
}

const mainHook = driveToolCall({ botId: 'bot_main', tool: 'desktop_observe' });
say(`  主控（host）desktop_observe → ${mainHook.block ? 'block' : 'allow'}：${String(mainHook.reason ?? '').slice(0, 80)}`);
if (mainHook.block) problems.push(`主控被自己的钩子拦了：${mainHook.reason}`);

// ────────────────────────────── 结果
console.log('');
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
console.log('T2_CHIEF_ONLY true');
console.log('MEMBER_TOOLSET_CLEAN true');
console.log('GATEWAY_BLOCKS_MEMBER true');
console.log('HOOK_BLOCKS_MEMBER true');
fs.rmSync(root, { recursive: true, force: true });
