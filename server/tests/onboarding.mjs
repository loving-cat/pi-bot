/**
 * 首次授权流程（规格 §13.2）的测试。
 *   node tests/onboarding.mjs
 *
 * ## 为什么这块必须测
 *
 * §13.2 是"整节一步都没做"的 P0，而它做的三件事都**不会自己报错**：
 *
 *   1. 少说了一句"哪些硬隔离保证给不了"—— 页面照样渲染，用户照样点开始；
 *   2. 把 `host` 放进了执行 Bot 的模式下拉框 —— 没人会立刻发现，
 *      直到某天有人选上，然后一个执行 Bot 拿到了可信宿主模式；
 *   3. 把"逐次确认"整段挂在 `policy.dangerous` 下面 ——
 *      于是默认的 allow 档下，外部 MCP 工具和改安全配置变成免审批。
 *
 * 三条的共同点：**错的方向都是"放宽"**。所以这里的断言大多是反向的：
 * 不测"算了什么"，测"选了最宽的输入之后，该留的还在不在"。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  STEP,
  GIT_SCOPE,
  SEPARATE_APPROVAL,
  DESKTOP_STATE,
  planFirstRun,
  perCallConfirmItems,
  describeBoundaries,
  desktopStatusOf,
  summarizeEffectivePermissions,
  retentionRefusal,
  planWrapUp,
} = await import(src('onboarding.js'));
const { ACTION, MODE, DENY } = await import(src('grants.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------- fixtures
const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

const MAIN = { id: 'b-main', name: '主 Bot', role: 'main' };
const CODER = { id: 'b-code', name: '编码手', role: 'member' };
const PROJECT = { id: 'p-quant', label: 'quant-all-in', path: 'D:/quant-all-in' };

function grant(over = {}) {
  return {
    id: 'g-1',
    source: 'user',
    subject: { botId: 'b-code', role: 'member' },
    actions: [ACTION.fileRead],
    resources: [{ kind: 'path', ref: 'D:/quant-all-in' }],
    mode: MODE.project,
    createdAt: NOW - HOUR,
    ...over,
  };
}

const baseRun = (over = {}) =>
  planFirstRun({
    policy: { dangerous: 'ask' },
    bots: [MAIN, CODER],
    projects: [PROJECT],
    grants: [],
    desktop: { observe: DESKTOP_STATE.granted, input: DESKTOP_STATE.granted },
    platform: 'win32',
    now: NOW,
    ...over,
  });

// ---------------------------------------------------------------- 五步齐全
test('前四步进首启页，第五步单独（规格 §13.2 五步一个不少）', () => {
  const plan = baseRun();
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    [STEP.visibility, STEP.project, STEP.leastPrivilege, STEP.summary],
  );
  const wrap = planWrapUp({ now: NOW });
  assert.equal(wrap.step, STEP.wrapUp);
});

test('首次判定：一条未撤销授权都没有才算首次', () => {
  assert.equal(baseRun().firstRun, true);
  assert.equal(baseRun({ grants: [grant()] }).firstRun, false);
  // 已撤销的不算"配过了"
  assert.equal(baseRun({ grants: [grant({ revokedAt: NOW - 1, revokedBy: 'user' })] }).firstRun, true);
});

test('★ 迁移授权不算“配过了”（否则首启页永远不会弹）', () => {
  // server-main.js 每次启动都会发 legacy-policy 的迁移授权；按“有没有授权”
  // 判首次，等于这页永远不出现 —— 而且没有任何报错。
  const legacy = grant({ id: 'g-legacy', source: 'legacy-policy' });
  const plan = baseRun({ grants: [legacy] });
  assert.equal(plan.firstRun, true, '迁移授权不是用户走过 §13.2');
  assert.equal(plan.legacyGrants, 1);

  // 而且要在第 2 步就说清“它不会自动收窄”
  const step2 = plan.steps.find((s) => s.id === STEP.project);
  assert.match(step2.lines.join(' | '), /迁移授权/);
  assert.match(step2.lines.join(' | '), /要你自己收回/);
});

test('已保存的窄范围规则也算用户配过了', () => {
  assert.equal(baseRun({ grants: [grant({ source: 'saved-rule' })] }).firstRun, false);
});

test('legacyGrants 计数只数迁移授权', () => {
  const plan = baseRun({
    grants: [
      grant({ id: 'g-l1', source: 'legacy-policy' }),
      grant({ id: 'g-l2', source: 'legacy-policy' }),
      grant({ id: 'g-u1', source: 'user' }),
    ],
  });
  assert.equal(plan.legacyGrants, 2);
  assert.equal(plan.firstRun, false);
});

// ---------------------------------------------------------------- 第 2 步的边界
test('四类"另需批准"是死数：Git 范围选到最宽也不减少（规格 §13.2-2）', () => {
  const ids = SEPARATE_APPROVAL.map((s) => s.id).sort();
  assert.deepEqual(ids, ['credentials', 'hooks-signing', 'remote', 'shared-metadata']);

  const plan = baseRun();
  const step2 = plan.steps.find((s) => s.id === STEP.project);
  const widest = step2.options.gitScopes.find((s) => s.id === GIT_SCOPE.push);
  assert.ok(widest, 'push 应该作为一个可选档位出现');
  // 选最宽的一档，第 2 步列出的另批项仍然是四条
  assert.equal(step2.separateApproval.length, 4);

  // 而且 push 本身也在"另需批准"里 —— 它不是"选了就能推"
  const remote = step2.separateApproval.find((s) => s.id === 'remote');
  assert.ok(remote.actions.includes(ACTION.gitPush));
});

test('Git 范围的动作是递减的：none ⊂ read ⊂ commit ⊂ push', () => {
  const plan = baseRun();
  const scopes = plan.steps.find((s) => s.id === STEP.project).options.gitScopes;
  const byId = new Map(scopes.map((s) => [s.id, s.actions]));
  const isSubset = (a, b) => a.every((x) => b.includes(x));
  assert.ok(isSubset(byId.get('none'), byId.get('read')));
  assert.ok(isSubset(byId.get('read'), byId.get('commit')));
  assert.ok(isSubset(byId.get('commit'), byId.get('push')));
  assert.ok(byId.get('push').includes(ACTION.gitPush));
  assert.ok(!byId.get('commit').includes(ACTION.gitPush), '★ 本地提交不能顺带拿到推远端');
});

// ---------------------------------------------------------------- 第 3 步：host 不可选
test('★ 执行 Bot 的模式选项里没有 host（选了就是放宽）', () => {
  const plan = baseRun();
  const step3 = plan.steps.find((s) => s.id === STEP.leastPrivilege);
  assert.ok(!step3.options.modes.includes(MODE.host), 'host 只能属于主 Bot，不能出现在执行 Bot 的下拉框里');
  assert.deepEqual(step3.options.modes, [MODE.project, MODE.isolated]);
});

test('★ 已有 host 模式授权的非主 Bot 会被点名', () => {
  const plan = baseRun({ grants: [grant({ mode: MODE.host })] });
  assert.ok(
    plan.warnings.some((w) => w.id.startsWith('host-mode-on-sub:')),
    '非主 Bot 拿着 host 授权必须报出来',
  );
});

test('★ 已有桌面键鼠授权的非主 Bot 会被点名（§13.2-3 不随角色继承）', () => {
  const plan = baseRun({
    grants: [grant({ actions: [ACTION.desktopObserve, ACTION.desktopInput] })],
  });
  assert.ok(plan.warnings.some((w) => w.id.startsWith('desktop-input-inherited:')));
});

test('主 Bot 拿桌面键鼠授权不算异常', () => {
  const plan = baseRun({
    grants: [
      grant({ subject: { botId: 'b-main', role: 'main' }, actions: [ACTION.desktopInput], mode: MODE.host }),
    ],
  });
  assert.equal(plan.warnings.filter((w) => w.id.includes('desktop-input')).length, 0);
});

// ---------------------------------------------------------------- 逐次确认的分组
test('★ policy 调到最宽也拿不掉"改安全配置"和"外部 MCP"这两条', () => {
  for (const dangerous of ['allow', 'ask', 'deny']) {
    const items = perCallConfirmItems({ policy: { dangerous }, mcpServerCount: 2 });
    const ids = items.map((i) => i.id);
    assert.ok(ids.includes('security-config'), `${dangerous} 档丢了改安全配置`);
    assert.ok(ids.includes('external-mcp'), `${dangerous} 档丢了外部 MCP`);
    assert.equal(items.filter((i) => i.always).length, 2);
  }
});

test('policy=ask 多出"所有会动手的动作"；policy=allow 没有这一条', () => {
  const ask = perCallConfirmItems({ policy: { dangerous: 'ask' } }).map((i) => i.id);
  const allow = perCallConfirmItems({ policy: { dangerous: 'allow' } }).map((i) => i.id);
  assert.ok(ask.includes('mutating'));
  assert.ok(!allow.includes('mutating'));
  // allow 档要明说自己没覆盖那两条 always 的（文案层面这句在 note 里）
  assert.ok(perCallConfirmItems({ policy: { dangerous: 'allow' } }).filter((i) => i.always).length === 2);
});

test('policy=deny 时不是"逐次确认"而是"根本不给"——文案要分开', () => {
  const items = perCallConfirmItems({ policy: { dangerous: 'deny' } });
  const denied = items.find((i) => i.id === 'mutating-denied');
  assert.ok(denied);
  assert.match(denied.title, /拒绝/);
  assert.ok(!items.some((i) => i.id === 'mutating'));
});

test('逐次确认清单里不带凭据值，只带工具名', () => {
  const items = perCallConfirmItems({ policy: { dangerous: 'ask' } });
  const text = JSON.stringify(items);
  assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(text));
  assert.ok(!/Bearer /.test(text));
});

// ---------------------------------------------------------------- 桌面权限：如实报
test('★ 桌面键鼠被拒时：报告不可用，且不出现"改用更宽模式"这种兜底', () => {
  const plan = baseRun({ desktop: { observe: DESKTOP_STATE.granted, input: DESKTOP_STATE.denied } });
  const joined = plan.boundaries.cannot.join(' | ');
  assert.match(joined, /桌面键鼠：系统拒绝了授权/);
  assert.match(joined, /不会自动改用更宽的模式顶上/);
  // 第 1 步也要如实写
  assert.match(plan.steps[0].lines.join(' | '), /桌面键鼠：系统拒绝了授权/);
  // 而且没有任何一处建议改用 host
  assert.ok(!/改用 host|切换成 host|用 host 模式兜底/.test(JSON.stringify(plan)));
});

test('桌面输入未实现（macOS 空壳）也如实报，并指向文档', () => {
  const plan = baseRun({ desktop: { input: DESKTOP_STATE.notPlatform }, platform: 'darwin' });
  const joined = plan.boundaries.cannot.join(' | ');
  assert.match(joined, /这个平台还没实现/);
  assert.match(joined, /MACOS-DESKTOP-INPUT/);
});

test('没探测过就当"不知道"，不乐观推定成可用', () => {
  const plan = baseRun({ desktop: {} });
  assert.match(plan.steps[0].lines.join(' | '), /屏幕观察：还不知道/);
  assert.ok(!plan.boundaries.can.some((l) => /桌面键鼠：可用/.test(l)));
});

test('★ 系统权限是"不可用"但存在桌面键鼠授权 → 提醒那几条现在用不上', () => {
  const plan = baseRun({
    desktop: { input: DESKTOP_STATE.denied },
    grants: [grant({ subject: { botId: 'b-main', role: 'main' }, actions: [ACTION.desktopInput], mode: MODE.host })],
  });
  assert.ok(plan.warnings.some((w) => w.id === 'desktop-grant-unusable'));
});

// ---------------------------------------------------------------- 硬隔离边界
test('project 模式必须承认"不是沙箱"', () => {
  const b = describeBoundaries({ mode: MODE.project, desktop: { input: DESKTOP_STATE.granted } });
  assert.ok(b.cannot.some((l) => /不是沙箱/.test(l)));
  assert.ok(b.cannot.some((l) => /不做网络隔离/.test(l)));
});

test('host 模式必须承认"用的是你的登录身份"', () => {
  const b = describeBoundaries({ mode: MODE.host, desktop: {} });
  assert.ok(b.cannot.some((l) => /当前的登录身份/.test(l)));
});

test('isolated 模式也要承认内核级穿透', () => {
  const b = describeBoundaries({ mode: MODE.isolated, desktop: {} });
  assert.ok(b.cannot.some((l) => /不是虚拟机/.test(l)));
});

test('边界那一节永远有"不能"—— 没有"保证全部做到"这种回答', () => {
  for (const mode of [MODE.host, MODE.project, MODE.isolated]) {
    const b = describeBoundaries({ mode, desktop: { observe: 'granted', input: 'granted' } });
    assert.ok(b.cannot.length >= 2, `${mode} 的"不能"少于两条`);
  }
});

// ---------------------------------------------------------------- 阻断项
test('没主 Bot / 没项目 → 不能开始，且说清是哪一条', () => {
  const noMain = baseRun({ bots: [CODER] });
  assert.equal(noMain.startable, false);
  assert.ok(noMain.blockers.some((b) => b.id === 'no-main-bot'));

  const noProject = baseRun({ projects: [] });
  assert.equal(noProject.startable, false);
  assert.ok(noProject.blockers.some((b) => b.id === 'no-project'));
});

test('齐全就能开始', () => {
  assert.equal(baseRun().startable, true);
  assert.equal(baseRun().blockers.length, 0);
});

test('没有执行 Bot 不阻断，但第 3 步要说清"只有主 Bot 受约束"', () => {
  const plan = baseRun({ bots: [MAIN] });
  assert.equal(plan.startable, true);
  const step3 = plan.steps.find((s) => s.id === STEP.leastPrivilege);
  assert.match(step3.lines.join(' | '), /还没有执行 Bot/);
});

// ---------------------------------------------------------------- 有效权限汇总
test('有效权限汇总：过期的不进"本次有效"', () => {
  const s = summarizeEffectivePermissions({
    grants: [
      grant({ id: 'g-live', expiresAt: NOW + HOUR }),
      grant({ id: 'g-dead', expiresAt: NOW - HOUR }),
    ],
    bots: [MAIN, CODER],
    now: NOW,
  });
  assert.deepEqual(s.entries.map((e) => e.id), ['g-live']);
  assert.equal(s.temporary, 1);
});

test('★ 按旧规矩批的授权不能画成正常授权 —— 单列成 stale（规格 §6.1）', () => {
  const s = summarizeEffectivePermissions({
    grants: [grant({ id: 'g-old', policyRevision: 'rev-old' })],
    policyRevision: 'rev-new',
    now: NOW,
  });
  assert.equal(s.entries.length, 0);
  assert.equal(s.stale.length, 1);
  assert.equal(s.stale[0].id, 'g-old');
});

test('坏数据进 invalid，不炸整页', () => {
  const s = summarizeEffectivePermissions({
    grants: [{ id: 'g-bad' }, null, grant({ id: 'g-ok' })],
    now: NOW,
  });
  assert.equal(s.entries.length, 1);
  assert.equal(s.invalid.length, 2);
  assert.equal(s.invalid[0].code, DENY.badSource, '缺 source 的授权是来源不合法，不是格式不合法');
  assert.equal(s.invalid[1].code, DENY.invalid);
});

test('汇总里带执行模式的人话（复用 exec-mode 的解释）', () => {
  const s = summarizeEffectivePermissions({
    grants: [grant({ mode: MODE.isolated })],
    bots: [CODER],
    now: NOW,
  });
  assert.equal(s.entries[0].modeText, '隔离执行模式：命令跑在沙箱里');
  assert.equal(s.entries[0].botName, '编码手');
});

// ---------------------------------------------------------------- 保留与回收
test('项目范围的授权可以保留', () => {
  assert.equal(retentionRefusal(grant({ actions: [ACTION.fileRead, ACTION.fileWrite, ACTION.gitCommit] })), null);
});

test('★ 对外发送 / 凭据不能靠"保留项目"推出来（规格 §13.2-5）', () => {
  assert.match(retentionRefusal(grant({ actions: [ACTION.netSend] })), /对外发送/);
  assert.match(retentionRefusal(grant({ actions: [ACTION.secretUse] })), /凭据/);
  // 混着项目动作也不行 —— 有一个就整条不能长期留
  assert.match(
    retentionRefusal(grant({ actions: [ACTION.fileWrite, ACTION.netSend] })),
    /对外发送/,
  );
});

test('host / isolated 模式授权不能长期保留', () => {
  assert.match(retentionRefusal(grant({ mode: MODE.host })), /host 模式/);
  assert.match(retentionRefusal(grant({ mode: MODE.isolated })), /isolated 模式/);
});

test('范围里含主机/凭据/桌面 → 不是项目授权', () => {
  const g = grant({ resources: [{ kind: 'path', ref: 'D:/quant-all-in' }, { kind: 'host', ref: 'example.com' }] });
  assert.match(retentionRefusal(g), /非项目资源/);
});

test('收尾：临时授权进回收，项目授权进可保留', () => {
  const w = planWrapUp({
    grants: [
      grant({ id: 'g-temp', taskId: 't-1', expiresAt: NOW + HOUR }),
      grant({ id: 'g-keep' }),
    ],
    bots: [CODER],
    artifacts: ['docs/SPEC-COVERAGE.md'],
    testedBoundaries: ['Windows 实机'],
    sideEffects: ['新增一个 worktree'],
    now: NOW,
  });
  assert.deepEqual(w.revokeNow.map((r) => r.id), ['g-temp']);
  assert.deepEqual(w.keepable.map((k) => k.id), ['g-keep']);
  assert.equal(w.artifacts.length, 1);
  assert.equal(w.sideEffects.length, 1);
});

test('收尾：长期的对发送授权进 refused，不因为"项目还在"就放行', () => {
  const w = planWrapUp({
    grants: [grant({ id: 'g-send', actions: [ACTION.netSend] })],
    now: NOW,
  });
  assert.deepEqual(w.refused.map((r) => r.id), ['g-send']);
  assert.equal(w.keepable.length, 0);
});

test('收尾：用户勾了"保留"但那条不能留 → 给出为什么', () => {
  const w = planWrapUp({
    grants: [grant({ id: 'g-send', actions: [ACTION.netSend] })],
    keepRequested: ['g-send'],
    now: NOW,
  });
  assert.equal(w.deniedKeep.length, 1);
  assert.match(w.deniedKeep[0].text, /不能保留/);
});

test('★ 自动收割没接线就如实写 false，不能假称"已自动回收"', () => {
  const w = planWrapUp({ now: NOW });
  assert.equal(w.cascadeImplemented, false);
  assert.match(w.note, /手动/);
});

test('收尾：已撤销/过期的授权不进任何一栏', () => {
  const w = planWrapUp({
    grants: [grant({ id: 'g-rev', revokedAt: NOW - 1 }), grant({ id: 'g-exp', expiresAt: NOW - 1 })],
    now: NOW,
  });
  assert.equal(w.revokeNow.length, 0);
  assert.equal(w.keepable.length, 0);
  assert.equal(w.refused.length, 0);
});

// ---------------------------------------------------------------- 一页 vs 向导
test('一页里只有两步需要用户选（其余是告知与确认）', () => {
  const plan = baseRun();
  const choices = plan.steps.filter((s) => s.kind === 'choose');
  assert.equal(choices.length, 2);
  assert.equal(plan.steps.filter((s) => s.kind === 'tell').length, 1);
  assert.equal(plan.steps.filter((s) => s.kind === 'confirm').length, 1);
});

test('推荐值是"最小可用"：项目 = 第一个可选项目，Git = 本地提交（不含远端）', () => {
  const plan = baseRun();
  const rec = plan.steps.find((s) => s.id === STEP.project).recommended;
  assert.equal(rec.projectId, 'p-quant');
  assert.equal(rec.gitScope, GIT_SCOPE.commit);
  assert.ok(!plan.steps.find((s) => s.id === STEP.project).options.gitScopes
    .find((s) => s.id === rec.gitScope).actions.includes(ACTION.gitPush));
});

// ---------------------------------------------------------------- 探针 → 状态

test('探针成功 → granted；没探过 → unknown（不乐观推定）', () => {
  assert.deepEqual(desktopStatusOf({ ok: true, screen: { width: 2560, height: 1440 } }), {
    observe: DESKTOP_STATE.granted,
    input: DESKTOP_STATE.granted,
    detail: null,
  });
  assert.equal(desktopStatusOf(null).input, DESKTOP_STATE.unknown);
  assert.equal(desktopStatusOf(undefined).observe, DESKTOP_STATE.unknown);
});

test('★ "平台没实现" 和 "系统拒绝" 必须分开报', () => {
  const np = desktopStatusOf({ ok: false, code: 'not_platform', text: 'macOS 的桌面输入还没实现' });
  assert.equal(np.input, DESKTOP_STATE.notPlatform);
  assert.match(np.detail, /还没实现/);

  const denied = desktopStatusOf({ ok: false, code: 'not_dpi_aware', text: '声明不了 DPI 感知' });
  assert.equal(denied.input, DESKTOP_STATE.denied);
  assert.equal(denied.code, 'not_dpi_aware');

  // 两者在页面上不能说成同一句话
  const lineOf = (st) => baseRun({ desktop: st }).steps[0].lines.find((l) => l.startsWith('桌面键鼠'));
  assert.match(lineOf(np), /这个平台还没实现/);
  assert.match(lineOf(denied), /系统拒绝了授权/);
  assert.notEqual(lineOf(np), lineOf(denied));
});

test('探针失败（拿不到会话/调用挂了）按 denied 报，并进边界文案', () => {
  for (const code of ['no_session', 'call_failed', 'probe_unavailable']) {
    const st = desktopStatusOf({ ok: false, code, text: `${code} 了` });
    assert.equal(st.input, DESKTOP_STATE.denied);
    const plan = baseRun({ desktop: st });
    assert.match(plan.boundaries.cannot.join(' | '), /不会自动改用更宽的模式顶上/);
  }
});

// ---------------------------------------------------------------- 结果
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
