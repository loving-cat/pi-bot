/**
 * 1.7.1 过渡版：弃用提醒通道（C1 环境变量 / C2 旧数据目录）。
 *   node tests/brand-deprecation.mjs
 *
 * ## 为什么要有这个文件
 *
 * 2.0 会删掉三样兼容层：`PI_BOT_*` 环境变量、旧数据目录回退、`x-pi-bot-*` 请求头。
 * 删之前必须先让用户**看得见**提醒（1.7.1 的使命），否则 2.0 上线当天就是数据事故：
 * 「我的聊天记录不见了」「我的配置全丢了」。
 *
 * 这里守三条纪律：
 *   1. 旧名仍能用（不破坏老配置）；
 *   2. 每次命中提醒一次，**同一进程内按 `kind:from` 去重** —— 这条最容易被写错，
 *      `readBrandEnv` 在请求热路径上会被反复调用，不去重就是刷屏；
 *   3. 提醒可通过 `onBrandDeprecation` 订阅、`resetBrandDeprecations` 清零，
 *      单测不用去抓 stderr。
 *
 * 请求头那一半（`x-orbis-deprecated` 响应头）在 `tests/local-csrf.mjs` 里验。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-brand-dep-'));
process.env.ORBIS_HOME = fixture;
process.env.PI_CODING_AGENT_DIR = path.join(fixture, 'agent');
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`✗ ${name}\n  ${err?.stack || err}`);
  }
}

const {
  readBrandEnv,
  noticeBrandDeprecation,
  onBrandDeprecation,
  brandDeprecations,
  resetBrandDeprecations,
} = await import(src('brand.js'));

await test('BD-1 旧环境变量仍可用，且记一条弃用（key = env:PI_BOT_X）', () => {
  resetBrandDeprecations();
  assert.equal(readBrandEnv({ PI_BOT_HOME: '/legacy' }, 'HOME'), '/legacy');
  assert.deepEqual(brandDeprecations(), ['env:PI_BOT_HOME']);
});

await test('BD-2 同一变量反复读（热路径）只记一次', () => {
  resetBrandDeprecations();
  const env = { PI_BOT_WORKSPACE: '/w' };
  for (let i = 0; i < 50; i++) readBrandEnv(env, 'WORKSPACE');
  assert.deepEqual(brandDeprecations(), ['env:PI_BOT_WORKSPACE'], '50 次调用只能留 1 条；否则日志会刷屏');
});

await test('BD-3 不同 suffix 各记一条', () => {
  resetBrandDeprecations();
  readBrandEnv({ PI_BOT_HOME: '/h' }, 'HOME');
  readBrandEnv({ PI_BOT_HOME: '/h', PI_BOT_PORT: '8787' }, 'PORT');
  assert.deepEqual(brandDeprecations().sort(), ['env:PI_BOT_HOME', 'env:PI_BOT_PORT']);
});

await test('BD-4 新名优先：设了 ORBIS_* 就不该有弃用记录', () => {
  resetBrandDeprecations();
  assert.equal(readBrandEnv({ ORBIS_HOME: '/new', PI_BOT_HOME: '/old' }, 'HOME'), '/new');
  assert.deepEqual(brandDeprecations(), []);
});

await test('BD-5 空串视为未设置（与新名的判定一致）', () => {
  resetBrandDeprecations();
  assert.equal(readBrandEnv({ PI_BOT_HOME: '' }, 'HOME'), undefined);
  assert.deepEqual(brandDeprecations(), []);
});

await test('BD-6 订阅者能收到结构化事件（kind / from / to），且每个 key 只回调一次', () => {
  resetBrandDeprecations();
  const seen = [];
  const off = onBrandDeprecation((ev) => seen.push(ev));
  readBrandEnv({ PI_BOT_MODEL: 'glm' }, 'MODEL');
  readBrandEnv({ PI_BOT_MODEL: 'glm' }, 'MODEL');
  off();
  readBrandEnv({ PI_BOT_TOOLS: 'x' }, 'TOOLS');
  assert.equal(seen.length, 1, '退订后不该再回调');
  assert.deepEqual(seen[0], { kind: 'env', from: 'PI_BOT_MODEL', to: 'ORBIS_MODEL', hint: '' });
});

await test('BD-7 noticeBrandDeprecation 返回值：首次 true / 重复 false', () => {
  resetBrandDeprecations();
  const info = { kind: 'test', from: 'a', to: 'b' };
  assert.equal(noticeBrandDeprecation(info), true);
  assert.equal(noticeBrandDeprecation(info), false);
});

// ---------------------------------------------------------------------------
// C2：旧数据目录（config.resolveHomeDir）
// ---------------------------------------------------------------------------
const { resolveHomeDir } = await import(src('config.js'));

await test('BD-8 只有旧目录 pi-bot 时沿用旧目录，并提醒一次（C2）', () => {
  resetBrandDeprecations();
  const seen = [];
  const off = onBrandDeprecation((ev) => seen.push(ev));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-home-'));
  fs.mkdirSync(path.join(base, 'pi-bot'), { recursive: true });
  const picked = resolveHomeDir(base);
  off();
  assert.equal(path.basename(picked), 'pi-bot', '2.0 之前必须继续读旧目录，否则老用户数据“消失”');
  assert.equal(brandDeprecations().length, 1);
  assert.match(brandDeprecations()[0], /^data-dir:/);
  // 同一个 base 再算一次不重复提醒
  resolveHomeDir(base);
  assert.equal(brandDeprecations().length, 1);
  // ★ 提示里不能承诺一个还不存在的命令：1.7.1 用户跟着敲会 command not found
  const hint = seen[0]?.hint ?? '';
  assert.doesNotMatch(hint, /orbis migrate/, 'orbis migrate 要到 2.0 才有，1.7.1 的提示不能让人去敲它');
  assert.match(hint, /手动|2\.0/, '要给出 1.7.1 当下可做的事（手动改名）或说清 2.0 才有工具');
  fs.rmSync(base, { recursive: true, force: true });
});

await test('BD-9 新旧目录都在时用新目录，且不提醒', () => {
  resetBrandDeprecations();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-home-'));
  fs.mkdirSync(path.join(base, 'orbis'), { recursive: true });
  fs.mkdirSync(path.join(base, 'pi-bot'), { recursive: true });
  assert.equal(path.basename(resolveHomeDir(base)), 'orbis');
  assert.deepEqual(brandDeprecations(), []);
  fs.rmSync(base, { recursive: true, force: true });
});

await test('BD-10 两个都没有时给新目录（新装用户）', () => {
  resetBrandDeprecations();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-home-'));
  assert.equal(path.basename(resolveHomeDir(base)), 'orbis');
  assert.deepEqual(brandDeprecations(), []);
  fs.rmSync(base, { recursive: true, force: true });
});

fs.rmSync(fixture, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\nbrand-deprecation: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
