#!/usr/bin/env node
/**
 * 权限层一致性自查（CI + 本地手动跑）。
 *
 *   node scripts/check-consistency.mjs
 *
 * ## 为什么把这堆检查集中到一条命令
 *
 * 这一周反复踩的同类事故都是"两处事实不一致"，而每次都靠临时写脚本才发现：
 *   · 迁移授权没列新动作 → 一调就 no_grant
 *   · 只读名单与网关不同步 → 切成只读后 12 个工具被误拦
 *   · 风险档按工具名查动作名 → 审计里 risk 恒为 null
 *   · 签发/校验世代不一致 → "重启后旧批准不续命"从没生效过
 *
 * 集中成一个命令之后，改完网关跑一次就知道有没有退化。
 *
 * ## 五项检查
 *
 * 1. 只读漂移：策略层放行的工具，网关必须有对应授权（否则"看得见、一调就被拒"）
 * 2. 覆盖漂移：allow 档下主 Bot 对每个"有工具的动作"都能过
 * 3. 新主体：新建的 bot 立刻能用（不然只能重启服务端补登记）
 * 4. 审计完整：判定记录的 risk 不为 null
 * 5. 窄范围授权 fail-closed：认不出目标时必须拒绝，不能当"没目标"放行
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
const src = (f) => pathToFileURL(path.join(ROOT, 'src', f));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-consistency-'));
Object.assign(process.env, {
  PI_BOT_HOME: path.join(fixture, 'data'),
  PI_BOT_WORKSPACE: path.join(fixture, 'ws'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('自查期间不允许联网'); };

const { store } = await import(src('store.js'));
const { bus } = await import(src('bus.js'));
const { createGrantGate } = await import(src('grant-gate.js'));
const { ensureLegacyGrant } = await import(src('migration-grants.js'));
const R = await import(src('role-tools.js'));
const C = await import(src('capabilities.js'));

const chief = store.mainBot();
const rev = () => store.policyVersion();
const sync = ({ botIds }) => ensureLegacyGrant({
  store, policy: store.policy(), policyRevision: rev(),
  botIds, chiefBotId: chief.id, generation: 'gen-check',
});
const gate = createGrantGate({
  store, currentPolicyRevision: rev, currentGeneration: () => 'gen-check',
  syncGrants: sync, bus, log: () => {},
});

sync({ botIds: store.listBots().map((b) => b.id) });
gate.start();

let problems = 0;
const fail = (msg) => { problems++; console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

// ---- 1) 只读漂移
console.log('\n[1] 只读档：策略放行 ⇄ 网关授权');
store.updatePolicy({ dangerous: 'deny' });
sync({ botIds: store.listBots().map((b) => b.id) });
for (const tool of R.READONLY_ALLOW) {
  const mapped = gate.actionForTool(tool);
  if (!mapped) continue;
  const v = gate.check({ subject: { botId: chief.id }, action: mapped.action });
  if (!v.ok) fail(`策略放行 ${tool}（${mapped.action}），网关却拒：${v.code}`);
}
if (!problems) ok(`${R.READONLY_ALLOW.length} 个只读工具与网关一致`);

// ---- 2) 覆盖漂移（allow 档）
console.log('\n[2] allow 档：主 Bot 对每个有工具的动作');
store.updatePolicy({ dangerous: 'allow' });
sync({ botIds: store.listBots().map((b) => b.id) });
const before = problems;
for (const action of C.GATED_ACTIONS) {
  if (action === 'desktop.input' || action === 'git.destructive') continue; // 刻意不给
  const v = gate.check({ subject: { botId: chief.id }, action });
  if (!v.ok) fail(`allow 档下主 Bot 被拒：${action}（${v.code}）`);
}
if (problems === before) ok(`${C.GATED_ACTIONS.length - 2} 个动作全部放行`);

// ---- 3) 新主体
console.log('\n[3] 运行期新建的 bot 立刻可用');
{
  const nb = store.createBot({ name: '自查新人' });
  const v = gate.check({ subject: { botId: nb.id }, action: 'file.write' });
  if (!v.ok) fail(`新 bot 拿不到权限（${v.code}）—— 只能重启服务端补登记`);
  else ok('新 bot 立刻拿到权限');
}

// ---- 4) 审计完整
console.log('\n[4] 审计记录');
{
  const last = store.state.grantAudit?.at?.(-1) ?? store.state.grantAudit?.[store.state.grantAudit.length - 1];
  if (!last) fail('没有任何审计记录');
  else if (!last.risk) fail('审计里的 risk 是空的（动作目录没被正确读到）');
  else ok(`最近一条审计带 risk=${last.risk}`);
}

// ---- 5) 窄范围 fail-closed
console.log('\n[5] 窄范围授权 + 认不出目标');
{
  store.state.grants = store.state.grants.filter((g) => g.subject?.botId !== chief.id);
  gate.add({
    source: 'user', subject: { botId: chief.id, role: 'main' },
    actions: ['cmd.exec'], resources: [{ kind: 'path', ref: '/proj/alpha' }], mode: 'host',
  });
  const t = gate.targetsForTool('bash', { command: 'rm -rf /' });
  const v = gate.check({ subject: { botId: chief.id }, action: 'cmd.exec', targets: t, params: { command: 'rm -rf /' } });
  if (v.ok) fail('认不出目标的命令被放行了 —— 范围约束形同虚设');
  else ok(`被正确拒绝：${v.code}`);
}

// ---- 6) 空范围不限（回归）
console.log('\n[6] 不限范围的授权 + 能推出目标');
{
  store.state.grants = store.state.grants.filter((g) => g.subject?.botId !== chief.id);
  gate.add({ source: 'user', subject: { botId: chief.id, role: 'main' }, actions: ['file.write'], resources: [], mode: 'host' });
  const t = gate.targetsForTool('write', { path: 'a.js' });
  const v = gate.check({ subject: { botId: chief.id }, action: 'file.write', targets: t, params: { path: 'a.js' } });
  if (!v.ok) fail(`不限范围的授权却拒了带目标的写文件（${v.code}）—— 这条回归过一次`);
  else ok('不限范围照常放行');
}

// ---- 7) 执行模式真的被校验（规格 §8）
console.log('\n[7] 执行模式（§8）：host 授权不能在 project 会话里生效');
{
  // 这一项守的是本轮修的洞：`grants.js` 有完整三档模式、`check()` 支持按它过滤，
  // 但唯一调用方**不传** —— 于是那道 `.filter((g) => !mode || ...)` 永远短路，
  // §8 整节在运行时不生效。任何一处接线退回去，这里就红。
  const { MODE } = await import(src('grants.js'));
  const modeBot = store.createBot({ name: '模式自查' });
  // ★ 先把它的迁移授权清掉。
  //
  //   createBot 会按规矩自动补一条 legacy-policy 授权（mode=project，非主 Bot），
  //   那条会覆盖 file.write —— 于是下面"project 模式应当被拒"就永远是放行，
  //   看着像 mode 没生效。这是**测试自己的夹具污染**，不是被测代码的问题。
  store.state.grants = (store.state.grants ?? []).filter((g) => g.subject?.botId !== modeBot.id);
  const g = gate.add({
    source: 'user',
    subject: { botId: modeBot.id, role: '' },
    actions: ['file.write'],
    resources: [],
    mode: MODE.host,
  });
  if (!g.ok) fail(`造不出 host 授权：${g.code}`);
  const inHost = gate.check({ subject: { botId: modeBot.id }, action: 'file.write', mode: MODE.host });
  if (!inHost.ok) fail(`host 授权在 host 模式下被拒了（${inHost.code}）`);
  const inProject = gate.check({ subject: { botId: modeBot.id }, action: 'file.write', mode: MODE.project });
  if (inProject.ok) fail('★ host 授权在 project 模式下被放行了 —— mode 没传进网关（§8 形同虚设）');
  else ok(`被正确拒绝：${inProject.code}`);
  // 静态检查：policy-hook 调网关时必须带 mode 字段
  const hookSrc = fs.readFileSync(path.join(ROOT, 'src', 'policy-hook.js'), 'utf8');
  const checkCall = hookSrc.slice(hookSrc.indexOf('grantGate.check({'));
  const head = checkCall.slice(0, 600);
  if (!head.includes('mode:')) {
    fail('★ policy-hook 调 grantGate.check() 时没有传 mode —— §8 会静默失效');
  } else ok('policy-hook 调用网关时带了 mode');
}

// ---------------- 8. pubspec.lock 不许带镜像地址 ----------------
//
// 本地打包时会为了速度把 PUB_HOSTED_URL 指到 pub.flutter-io.cn，而 `flutter pub get`
// **会把镜像地址写进 pubspec.lock**。一旦跟着提交上去，CI 用官方源就
// `Unable to satisfy pubspec.yaml using pubspec.lock` —— 三平台 app 任务全红，
// 而错误信息只说"锁文件不满足"，看不出是镜像 URL 造成的。
// 这件事已经发生过两次（2026-10 一次、2026-11 发版一次），所以放进 CI 检查。
{
  const lockPath = path.join(ROOT, '..', 'app', 'pubspec.lock');
  const MIRRORS = ['pub.flutter-io.cn', 'pub-mirrors', 'storage.flutter-io.cn'];
  if (!fs.existsSync(lockPath)) {
    fail('找不到 app/pubspec.lock');
  } else {
    const lock = fs.readFileSync(lockPath, 'utf8');
    const hit = MIRRORS.filter((m) => lock.includes(m));
    if (hit.length) {
      fail(`★ app/pubspec.lock 里有镜像地址（${hit.join(', ')}）—— CI 的 --enforce-lockfile 会红；`
        + '请 `git checkout <上一个干净提交> -- app/pubspec.lock`，不要提交镜像版锁文件');
    } else ok('pubspec.lock 用的是官方源（没有镜像地址）');
  }
}

clearTimeout(store.saveTimer);
fs.rmSync(fixture, { recursive: true, force: true });
console.log(problems ? `\n✗ ${problems} 处不一致` : '\n✓ 八项一致性检查全部通过');
process.exit(problems ? 1 : 0);
