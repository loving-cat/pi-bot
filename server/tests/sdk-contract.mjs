/**
 * SDK 对外契约快照（Phase 0 · T2.1）。
 *
 *   node tests/sdk-contract.mjs
 *   UPDATE_SDK_CONTRACT=1 node tests/sdk-contract.mjs   # 显式改契约
 *
 * ## 为什么要有这个文件
 *
 * `orbis-agent` 自称「可嵌入基座」，但对外契约一直是**口头的**：
 * 加一个导出、改一个返回字段、删一个兼容别名，都不会有任何东西变红，
 * 只有等外部宿主的脚本在别人机器上报错才知道。
 *
 * 这份测试把「当前承诺给宿主的形状」写成快照：
 *   · 包层面：五个入口的导出名单与类型、`exports` / `bin` / `engines`
 *   · 运行时层面：`createOrbisRuntime()` 返回的字段、六个领域服务的公开方法
 *
 * 新增或删除任何一项，必须显式改快照文件（`sdk-contract.snapshot.json`），
 * 于是每次契约变更都会在 diff 里留下一条可 review 的记录。
 *
 * ## 它不做什么
 *
 * 不断言行为（那是 sdk-runtime.mjs 的事），也不启动服务端 / 不联网。
 * 只锁「形状」，让「静默改契约」不可能发生。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const HERE = import.meta.dirname;
const SNAPSHOT_PATH = path.join(HERE, 'sdk-contract.snapshot.json');
const PKG_PATH = path.join(HERE, '..', 'package.json');
const UPDATE = process.env.UPDATE_SDK_CONTRACT === '1';

/** 记录一个值的「形状」：函数只记 function，对象只记 object，数组记 array */
function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function exportShape(mod) {
  const out = {};
  for (const key of Object.keys(mod).sort()) {
    out[key] = shapeOf(mod[key]);
  }
  return out;
}

/** 服务对象是工厂返回的普通对象：把方法名排好序记下来 */
function methodNames(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj)
    .filter((k) => typeof obj[k] === 'function')
    .sort();
}

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

/** 收集当前真实契约 */
async function collectContract() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const contract = {
    package: {
      name: pkg.name,
      type: pkg.type,
      private: pkg.private === true,
      engines: pkg.engines ?? {},
      exports: pkg.exports ?? {},
      bin: pkg.bin ?? {},
    },
    entries: {},
    runtime: {},
  };

  for (const spec of ['orbis-agent', 'orbis-agent/sdk', 'orbis-agent/client', 'orbis-agent/capabilities']) {
    const mod = await import(spec);
    contract.entries[spec] = exportShape(mod);
  }

  // 运行时形状：临时目录 + 关掉复盘/探测，避免任何真实副作用
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-sdk-contract-'));
  const { createOrbisRuntime } = await import('orbis-agent/sdk');
  let runtime = null;
  try {
    runtime = await createOrbisRuntime({
      dataDir: path.join(root, 'data'),
      workspace: path.join(root, 'workspace'),
      autoProbe: false,
      lessonReflect: false,
    });
    const surface = {};
    for (const key of Object.keys(runtime).sort()) {
      surface[key] = shapeOf(runtime[key]);
    }
    contract.runtime = surface;
    contract.services = {};
    for (const name of ['bots', 'rooms', 'models', 'automations', 'capabilities', 'policy', 'lessons']) {
      contract.services[name] = methodNames(runtime[name]);
    }
  } finally {
    try {
      await runtime?.dispose?.();
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
  return contract;
}

/** 逐层比较，输出人话差异（哪条新增、哪条消失、哪条类型变了） */
function diff(actual, expected, at = '', out = []) {
  if (expected === undefined) {
    out.push(`+ ${at}（新增，快照里没有）`);
    return out;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const a = Array.isArray(actual) ? actual : [];
    const e = Array.isArray(expected) ? expected : [];
    for (const item of a) if (!e.includes(item)) out.push(`+ ${at}[${item}]`);
    for (const item of e) if (!a.includes(item)) out.push(`- ${at}[${item}]（消失）`);
    return out;
  }
  if (typeof expected === 'object' && expected !== null) {
    const a = typeof actual === 'object' && actual !== null ? actual : {};
    for (const key of Object.keys(a)) diff(a[key], expected[key], at ? `${at}.${key}` : key, out);
    for (const key of Object.keys(expected)) {
      if (!(key in a)) out.push(`- ${at ? `${at}.${key}` : key}（消失）`);
    }
    return out;
  }
  if (actual !== expected) out.push(`~ ${at}: ${expected} → ${actual}`);
  return out;
}

let collected = null;

await test('SDK-C1 包层面契约（exports / bin / engines / private）', async () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  assert.equal(pkg.name, 'orbis-agent', '包名是外部宿主的 import 根，不能悄悄改');
  assert.ok(pkg.exports && typeof pkg.exports === 'object', 'exports 必须存在');
  assert.equal(typeof pkg.engines?.node, 'string', 'engines.node 必须写死（宿主据此选 Node 版本）');
});

await test('SDK-C2 五个入口的导出名单与类型未静默变化', async () => {
  collected = await collectContract();
  const expected = fs.existsSync(SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
    : null;
  assert.ok(expected, `缺少快照文件 ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
  const differences = diff(collected.entries, expected.entries, 'entries');
  assert.deepEqual(
    differences,
    [],
    `入口导出与快照不一致（改契约请 UPDATE_SDK_CONTRACT=1 重写快照）：\n  ${differences.join('\n  ')}`,
  );
});

await test('SDK-C3 运行时字段与服务方法未静默变化', async () => {
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const differences = [
    ...diff(collected.runtime, expected.runtime, 'runtime'),
    ...diff(collected.services, expected.services, 'services'),
  ];
  assert.deepEqual(
    differences,
    [],
    `运行时契约与快照不一致（改契约请 UPDATE_SDK_CONTRACT=1 重写快照）：\n  ${differences.join('\n  ')}`,
  );
});

await test('SDK-C4 包层面快照与真实 package.json 一致', async () => {
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const differences = diff(collected?.package ?? null, expected.package, 'package');
  assert.deepEqual(
    differences,
    [],
    `package.json 契约与快照不一致（改契约请 UPDATE_SDK_CONTRACT=1 重写快照）：\n  ${differences.join('\n  ')}`,
  );
});

if (UPDATE) {
  if (!collected) {
    console.error('无法采集契约，未写入快照');
    process.exit(1);
  }
  const before = fs.existsSync(SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
    : null;
  const changed = before
    ? [
        ...diff(collected.entries, before.entries, 'entries'),
        ...diff(collected.runtime, before.runtime, 'runtime'),
        ...diff(collected.services, before.services, 'services'),
        ...diff(collected.package, before.package, 'package'),
      ]
    : ['+ 首次生成'];
  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(collected, null, 2)}\n`, 'utf8');
  console.log(`\n已重写快照 ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
  if (changed.length) console.log(`本次契约变更：\n  ${changed.join('\n  ')}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nsdk-contract: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
