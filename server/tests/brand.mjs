/**
 * 品牌环境变量与改名兼容测试。
 *   node tests/brand.mjs
 *
 * ## 为什么这块要单独守
 *
 * 项目从 `pi-bot` 改名为 **Orbis** 后，环境变量统一成 `ORBIS_*`，但老用户的
 * `.env`、桌面端传参、systemd/supervisor 配置里仍是 `PI_BOT_*`。这里守住三条：
 *   1. `readBrandEnv` 一定是「`ORBIS_*` 优先、空串视为未设置、再回退老名」；
 *   2. 各个消费点（接单开关 / 任务上限 / 抓网页上限）真的走这条路，
 *      不是只在 brand.js 里写了个没人用的助手；
 *   3. 品牌常量与更新源不许回退成占位地址 —— 开源分发后检查更新打的就是它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-brand-'));
process.env.ORBIS_HOME = fixture;
process.env.PI_CODING_AGENT_DIR = path.join(fixture, 'agent');
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const {
  BRAND_NAME, BRAND_SLUG, LEGACY_SLUG, DEFAULT_UPDATE_REPO, DEFAULT_MAIN_BOT_NAME, readBrandEnv,
} = await import(src('brand.js'));
const { intakeEnabled } = await import(src('coordination/intake-tool.js'));
const { admissionBudget } = await import(src('coordination/task-admission.js'));

// ---------------------------------------------------------------------------
// 1. 品牌常量：改名的单一真源
// ---------------------------------------------------------------------------

await test('1. 品牌常量是 Orbis，旧 slug 与更新源都写死在一处', () => {
  assert.equal(BRAND_NAME, 'Orbis');
  assert.equal(BRAND_SLUG, 'orbis');
  assert.equal(DEFAULT_MAIN_BOT_NAME, 'Orbis');
  // 老数据目录/老安装包仍能按这个 slug 找到，不许删
  assert.equal(LEGACY_SLUG, 'pi-bot');
  // 检查更新打的就是这个仓库：不许再回退成 orbis-ai/orbis 这类占位地址
  assert.equal(DEFAULT_UPDATE_REPO, 'loving-cat/orbis');
});

// ---------------------------------------------------------------------------
// 2. readBrandEnv 的读取顺序
// ---------------------------------------------------------------------------

await test('2. readBrandEnv：ORBIS_* 优先，未设置或空串才回退 PI_BOT_*', () => {
  assert.equal(readBrandEnv({ ORBIS_PORT: '9000' }, 'PORT'), '9000');
  assert.equal(readBrandEnv({ PI_BOT_PORT: '8787' }, 'PORT'), '8787');
  assert.equal(readBrandEnv({ ORBIS_PORT: '9000', PI_BOT_PORT: '8787' }, 'PORT'), '9000');
  // 空串等于没配 —— 否则 `ORBIS_PORT=` 会把老配置顶掉，服务端直接起不来
  assert.equal(readBrandEnv({ ORBIS_PORT: '', PI_BOT_PORT: '8787' }, 'PORT'), '8787');
  assert.equal(readBrandEnv({}, 'PORT'), undefined);
  assert.equal(readBrandEnv(undefined, 'PORT'), undefined);
});

// ---------------------------------------------------------------------------
// 3. 消费点确实走这条路（否则 echo 一遍品牌常量没有意义）
// ---------------------------------------------------------------------------

await test('3. 接单开关默认开启，ORBIS_TASK_INTAKE 优先于老名 PI_BOT_TASK_INTAKE', () => {
  assert.equal(intakeEnabled({}), true);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '0' }), false);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: 'false' }), false);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: 'off' }), false);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '1' }), true);
  // 老配置仍然有效
  assert.equal(intakeEnabled({ PI_BOT_TASK_INTAKE: '0' }), false);
  assert.equal(intakeEnabled({ PI_BOT_TASK_INTAKE: '1' }), true);
  // 新名一旦配了就压过老名
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '1', PI_BOT_TASK_INTAKE: '0' }), true);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '0', PI_BOT_TASK_INTAKE: '1' }), false);
});

await test('4. 任务上限 ORBIS_TASK_MAX_RUNS 优先，老名照旧生效', () => {
  assert.deepEqual(admissionBudget({}, null), { maxRuns: null, concurrencyLimit: 1 });
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_RUNS: '7' }, null).maxRuns, 7);
  assert.equal(admissionBudget({ PI_BOT_TASK_MAX_RUNS: '7' }, null).maxRuns, 7);
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_RUNS: '2', PI_BOT_TASK_MAX_RUNS: '9' }, null).maxRuns, 2);
  // 非法值（0 / 负数 / 非数字）视为不限额
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_RUNS: '0' }, null).maxRuns, null);
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_RUNS: 'abc' }, null).maxRuns, null);
});

await test('5. 源码里不再有绕过品牌读取的直接 env.PI_BOT_* 读法', () => {
  const dir = path.join(import.meta.dirname, '..', 'src');
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      // brand.js 就是老名读取本身；child-env* 需要知道老名才能过滤，属放行清单
      if (/(^|[\\/])(brand|child-env|child-env-typed)\.js$/.test(full)) continue;
      const re = /(?:process\.)?env(?:ironment)?\.PI_BOT_[A-Z0-9_]+/g;
      for (const m of text.match(re) ?? []) offenders.push(`${path.relative(dir, full)} → ${m}`);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], `这些地方没走 readBrandEnv，ORBIS_* 会失效：\n${offenders.join('\n')}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
