/**
 * 首次授权页接口（`GET /api/onboarding`）—— 真起一个服务端来验证接线。
 *   node tests/onboarding-route.mjs
 *
 * ## 为什么纯单测不够
 *
 * `onboarding.js` 的 41 项单测证明"给定输入算得对"。但它们证明不了三件
 * 只有接线才看得出来、而且**出错了也不报错**的事：
 *
 *   1. 这个接口有没有真的从 `store` 取数据（而不是拿一份写死的默认值渲染）；
 *   2. 它有没有**顺手创建授权** —— 规格 §16.2 说得很清楚，首启页是
 *      "设计默认，不是新增授权"。建一条 grant 就等于绕过了整条入口鉴权，
 *      而且在页面上完全看不出来；
 *   3. 桌面探针有没有真的探（而不是把"平台支持"当成"实际权限"），
 *      以及探针会不会被反复起进程。
 *
 * 这三条都是"看起来能用"的典型：页面照常渲染，用户照常点开始。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-onboarding-'));
const ws = path.join(fixture, 'workspace');
fs.mkdirSync(ws, { recursive: true });
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: ws,
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_LESSON_REFLECT: '0',
  PI_BOT_TASK_INTAKE: '0',
});
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { createGrantGate } = await import(src('grant-gate.js'));
const { createHttpServer } = await import(src('http.js'));
const { Pairing } = await import(src('pairing.js'));
const { setDesktopInputPlatform } = await import(src('desktop-input-session.js'));
const { ACTION, MODE } = await import(src('grants.js'));

// ---- 探针桩：计数，并且**先报可用**，用来验证真的探了、且只探一次 ----
let probeCalls = 0;
setDesktopInputPlatform({
  probeEnvironment: () => {
    probeCalls += 1;
    return { ok: true, screen: { x: 0, y: 0, width: 1920, height: 1080 }, dpi: 96, session: true };
  },
});

const runner = {
  modelLabel: () => 'test',
  initNote: '',
  contextUsage: () => ({}),
  sessions: new Map(),
  isBusy: () => false,
  stats: null,
  health: null,
  model: 'test',
  escalate: async () => {},
  abortManagedTask: () => {},
  grantGate: createGrantGate({
    store,
    currentPolicyRevision: () => store.policyVersion(),
    currentGeneration: () => 'gen-test',
  }),
};
const server = createHttpServer({ runner, pairing: new Pairing() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const TOKEN = 'tok-onboarding-test';
store.state.devices[TOKEN] = { id: 'd_onb', name: '测试机', createdAt: Date.now(), lastSeenAt: Date.now() };

function req(pathname, { method = 'GET', auth = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-pi-bot-client': 'test' };
    if (auth) headers.authorization = 'Bearer ' + auth;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      let t = '';
      res.on('data', (c) => {
        t += c;
      });
      res.on('end', () => {
        let j = {};
        try {
          j = JSON.parse(t);
        } catch {
          /* 非 JSON */
        }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const main = store.mainBot();
const coder = store.createBot({ name: '编码手', role: 'member' });

// ---------------------------------------------------------------- 鉴权
await test('没 token 就打不开（和其他接口同一档）', async () => {
  const r = await req('/api/onboarding', { auth: null });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------- 真的从 store 取
await test('★ 从 store 取现状：机器上真有这个 bot，页面上就有它', async () => {
  const r = await req('/api/onboarding');
  assert.equal(r.status, 200);
  const plan = r.json;
  assert.equal(plan.firstRun, true, '一条授权都没有就该算首次');
  assert.equal(plan.steps.length, 4, '首启页四步（第五步是跑完之后）');
  assert.equal(plan.startable, true);

  // 第 1 步提到主 Bot 的名字 —— 不是写死的模板
  assert.match(plan.steps[0].lines.join(' | '), new RegExp(main.name));

  // 第 3 步提到那个执行 Bot —— 说明 bots 真的是 store 里读的
  assert.match(plan.steps[2].lines.join(' | '), new RegExp(coder.name));

  // 项目候选就是工作目录
  const step2 = plan.steps[1];
  assert.equal(step2.options.projects.length, 1);
  assert.equal(step2.options.projects[0].path, ws);
});

await test('★ 不创建任何授权（首启页是设计默认，不是新授权 —— §16.2）', async () => {
  const before = (store.state.grants ?? []).length;
  await req('/api/onboarding');
  await req('/api/onboarding');
  const after = (store.state.grants ?? []).length;
  assert.equal(after, before, '打开首启页不该凭空多出授权');
});

await test('不要 nonce，也不写管理审计（只读接口）', async () => {
  const before = store.listAdminActions({ limit: 100 }).length;
  const r = await req('/api/onboarding');
  assert.equal(r.status, 200);
  assert.equal(store.listAdminActions({ limit: 100 }).length, before);
});

// ---------------------------------------------------------------- 桌面权限真的探
await test('★ 桌面权限是探出来的，不是"平台支持就当可用"', async () => {
  const r = await req('/api/onboarding');
  const lines = r.json.steps[0].lines.join(' | ');
  assert.match(lines, /桌面键鼠：可用/);
  assert.ok(probeCalls >= 1, '探针应该真的被调用过');
});

await test('探针结果缓存：连开两次页面只起一次进程', async () => {
  const before = probeCalls;
  await req('/api/onboarding');
  await req('/api/onboarding');
  assert.equal(probeCalls, before, '缓存期内不该反复探测');
});

// ---------------------------------------------------------------- 越权继承要点名
await test('★ 非主 Bot 拿着 host 授权 → 页面上点名（规格 §13.2-3）', async () => {
  (store.state.grants ?? (store.state.grants = [])).push({
    id: 'g-host-on-sub',
    source: 'user',
    sourceRef: '测试',
    subject: { botId: coder.id, role: 'member' },
    actions: [ACTION.fileRead],
    resources: [{ kind: 'path', ref: ws }],
    mode: MODE.host,
    createdAt: Date.now(),
  });
  const r = await req('/api/onboarding');
  assert.equal(r.json.firstRun, false, '已经有授权了就不再是首次');
  const texts = r.json.warnings.map((w) => w.text).join(' | ');
  assert.match(texts, new RegExp(coder.name));
  assert.match(texts, /host 模式/);
  store.state.grants.pop();
});

await test('非主 Bot 拿着桌面键鼠授权 → 页面上点名', async () => {  (store.state.grants ?? (store.state.grants = [])).push({
    id: 'g-desktop-on-sub',
    source: 'user',
    subject: { botId: coder.id, role: 'member' },
    actions: [ACTION.desktopInput],
    resources: [{ kind: 'desktop', ref: 'default' }],
    mode: MODE.project,
    createdAt: Date.now(),
  });
  const r = await req('/api/onboarding');
  assert.match(r.json.warnings.map((w) => w.text).join(' | '), /桌面键鼠授权/);
  store.state.grants.pop();
});

// ---------------------------------------------------------------- 迁移授权的坑
await test('★ 启动时发的迁移授权不算“用户配过了”（否则首启页永远不弹）', async () => {
  const list = store.state.grants ?? (store.state.grants = []);
  list.push({
    id: 'g-legacy-onb',
    source: 'legacy-policy',
    subject: { botId: main.id, role: 'main' },
    actions: [ACTION.fileRead],
    resources: [],
    mode: MODE.host,
    createdAt: Date.now(),
  });
  const r = await req('/api/onboarding');
  assert.equal(r.json.firstRun, true, '迁移授权不是用户走过 §13.2');
  assert.equal(r.json.legacyGrants, 1);
  assert.match(r.json.steps[1].lines.join(' | '), /迁移授权/);
  store.state.grants.pop();
});

// ---------------------------------------------------------------- 界面契约
await test('返回的形状能被 App 的 onboarding_model 直接吃（字段名对得上）', async () => {
  const r = await req('/api/onboarding');
  const plan = r.json;
  for (const key of ['firstRun', 'steps', 'perCallConfirm', 'boundaries', 'warnings', 'blockers', 'startable']) {
    assert.ok(key in plan, `缺少字段 ${key}`);
  }
  for (const step of plan.steps) {
    assert.equal(typeof step.id, 'number');
    assert.ok(['tell', 'choose', 'confirm'].includes(step.kind), `未知 kind: ${step.kind}`);
  }
  assert.ok(plan.boundaries.cannot.length >= 2, '边界里必须说"不能"');
  assert.ok(plan.perCallConfirm.some((i) => i.id === 'security-config'));
  assert.ok(plan.perCallConfirm.some((i) => i.id === 'external-mcp'));
});

// ---------------------------------------------------------------- 首启页的"开始"

/** 申请一枚 nonce（丢开时自动带在头部）。 */
async function nonce(purpose = 'policy') {
  const r = await post('/api/local-nonce', { purpose });
  return r.json.nonce;
}

function post(pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + TOKEN,
          'x-pi-bot-client': 'test',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...extraHeaders,
        },
      },
      (res) => {
        let t = '';
        res.on('data', (c) => {
          t += c;
        });
        res.on('end', () => {
          let j = {};
          try {
            j = JSON.parse(t);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, json: j });
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

await test('★ 不带 nonce 就建不了授权（建授权 = 改防线本身）', async () => {
  const before = (store.state.grants ?? []).length;
  const r = await post('/api/onboarding/apply', { projectId: 'workspace', gitScope: 'commit' });
  assert.ok(r.status >= 400, `应该被拦住，实际 ${r.status}`);
  assert.equal((store.state.grants ?? []).length, before, '被拦下时不能已经落盘');
});

await test('★ 选完就真的建出授权（并且写进审计）', async () => {
  const n = await nonce();
  const auditedBefore = store.listAdminActions({ limit: 100 }).length;
  const r = await post(
    '/api/onboarding/apply',
    { projectId: 'workspace', gitScope: 'commit' },
    { 'x-pi-bot-nonce': n },
  );
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.ok(r.json.created.length >= 2, '主 Bot 和执行 Bot 各一条');

  // 真的进了 locked 的授权表，而且来源是人
  const ids = new Set(r.json.created);
  const live = (store.state.grants ?? []).filter((g) => ids.has(g.id) && !g.revokedAt);
  assert.equal(live.length, r.json.created.length);
  for (const g of live) assert.equal(g.source, 'user');

  // 记了管理审计
  assert.ok(store.listAdminActions({ limit: 100 }).length > auditedBefore);

  // 选择落盘了（界面回填要用）
  const rec = store.onboarding();
  assert.ok(rec.doneAt > 0);
  assert.equal(rec.gitScope, 'commit');
  assert.equal(rec.projectPath, ws);
});

await test('建完之后页面变成"已配过"（firstRun = false）', async () => {
  const r = await req('/api/onboarding');
  assert.equal(r.json.firstRun, false);
  assert.ok(r.json.onboarding.doneAt > 0);
  const state = r.json.steps; // 字段还在，界面不会因为"已配过"变成空白
  assert.equal(state.length, 4);
});

await test('★ 重新选一遍：旧的被回收，不积压（否则面板上一堆看不出哪条有效）', async () => {
  const first = store.onboarding().grantIds.slice();
  const n = await nonce();
  const r = await post(
    '/api/onboarding/apply',
    { projectId: 'workspace', gitScope: 'read' },
    { 'x-pi-bot-nonce': n },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.revoked.sort(), first.sort());
  const liveOld = (store.state.grants ?? []).filter(
    (g) => first.includes(g.id) && !g.revokedAt,
  );
  assert.equal(liveOld.length, 0, '上一次建的必须已经撤销');
});

await test('选不存在的项目 → 400，且一条授权都不建', async () => {
  const before = (store.state.grants ?? []).length;
  const n = await nonce();
  const r = await post(
    '/api/onboarding/apply',
    { projectId: 'nope', gitScope: 'commit' },
    { 'x-pi-bot-nonce': n },
  );
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'UNKNOWN_PROJECT');
  assert.equal((store.state.grants ?? []).length, before);
});

// ---------------------------------------------------------------- 收尾
server.close();
clearTimeout(store.saveTimer);
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
