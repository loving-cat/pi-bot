#!/usr/bin/env node
/**
 * 旧品牌残留守卫（Orbis 2.0 清债 · T1.0）。
 *
 *   node scripts/check-legacy.mjs              # 检查（CI 用）
 *   node scripts/check-legacy.mjs --write      # 重写白名单基线
 *   node scripts/check-legacy.mjs --strict     # 2.0 收门：白名单必须为空
 *   node scripts/check-legacy.mjs --root <dir> --allowlist <file>   # 测试用
 *
 * ## 为什么需要它
 *
 * 品牌从 pi-bot 换成 Orbis 之后，旧名字散在 60 多个文件里：环境变量双前缀、
 * 请求头双读、mDNS 服务类型、原生启动器名、文案……它们大多**不是 bug**，
 * 是刻意保留的兼容层（见 `docs/ROADMAP-2.0.md` §1.1 的 C1–C8）。
 *
 * 真正危险的是**悄悄增长**：新功能顺手又写了一个 `PI_BOT_*`、新加一个
 * `x-pi-bot-` 头，一年后没人分得清哪些是兼容层的债、哪些是还在生长的草。
 * 这份守卫把「当前欠了多少」写成基线：
 *
 *   · 没登记的文件出现旧名字 → 红（新债不许产生）
 *   · 已登记的文件出现比基线更多 → 红（旧债不许变大）
 *   · 变少了 → 绿（并提示可以 `--write` 收基线）
 *
 * ## 2.0 收门
 *
 * `--strict` 时白名单必须为空 —— 只要还有一个文件带旧名字就红。
 * 这是 Phase 3 的关门条件，写进 `docs/ROADMAP-2.0.md` §10 的 DoD。
 */
import fs from 'node:fs';
import path from 'node:path';

const SCAN_DIRS = [
  'server/src',
  'server/scripts',
  'server/tests',
  'app/lib',
  'app/test',
  'scripts',
  'native',
  '.github',
];
const SKIP_DIRS = new Set([
  'node_modules',
  'build',
  'dist',
  'graphify-out',
  '.git',
  '.dart_tool',
  'target',
  '.gradle',
]);
const BINARY_EXT = new Set([
  '.exe', '.dll', '.so', '.dylib', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.zip', '.apk', '.jar', '.aar', '.ttf', '.otf', '.woff', '.woff2', '.mp4', '.webm',
  '.db', '.sqlite', '.lockb',
]);
/** `pi-bot` / `pi_bot` / `pibot`（大小写不敏感，含 PI_BOT_ 与 x-pi-bot-） */
const LEGACY = /pi[-_]?bot|pibot/gi;
/**
 * 守卫自己与它的基线文件永远不参与扫描。
 * 否则：注释里写了旧名字 → 基线涨 → 再写基线 → 永远自己追自己。
 */
const SKIP_FILES = new Set([
  'scripts/check-legacy.mjs',
  'scripts/legacy-allowlist.json',
  'scripts/tests/check-legacy-test.mjs',
]);

function parseArgs(argv) {
  const opts = { root: path.resolve(import.meta.dirname, '..'), allowlist: null, write: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--root') opts.root = path.resolve(argv[++i] ?? '.');
    else if (a === '--allowlist') opts.allowlist = path.resolve(argv[++i] ?? '');
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  opts.allowlist ??= path.join(opts.root, 'scripts', 'legacy-allowlist.json');
  return opts;
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(full);
    }
  }
  return out;
}

function countInFile(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  if (!text || text.includes('\u0000')) return 0; // 保险：读成二进制就跳过
  let count = 0;
  for (const _ of text.matchAll(LEGACY)) count++;
  return count;
}

function scan(root) {
  const hits = new Map();
  for (const rel of SCAN_DIRS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const relPath = path.relative(root, file).split(path.sep).join('/');
      if (SKIP_FILES.has(relPath)) continue;
      const count = countInFile(file);
      if (count > 0) hits.set(relPath, count);
    }
  }
  return hits;
}

function readAllowlist(file) {
  if (!fs.existsSync(file)) return { entries: [], map: new Map() };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const map = new Map();
    for (const item of list) {
      if (!item || typeof item.path !== 'string') continue;
      const count = Number.isFinite(item.count) ? Math.max(0, Math.floor(item.count)) : 0;
      map.set(item.path, count);
    }
    return { entries: list, map };
  } catch (err) {
    console.error(`白名单读取失败（${file}）：${err?.message || err}`);
    process.exit(2);
  }
}

function total(map) {
  let n = 0;
  for (const v of map.values()) n += v;
  return n;
}

const opts = parseArgs(process.argv.slice(2));
const hits = scan(opts.root);

if (opts.write) {
  const entries = [...hits.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, count]) => ({ path: p, count }));
  const payload = {
    _comment:
      '旧品牌残留基线（scripts/check-legacy.mjs）。只许变小：新增文件或计数上涨都会让 CI 变红；' +
      '2.0 收门时用 --strict 要求本文件 entries 为空。清理进度见 docs/ROADMAP-2.0.md §1.1 / §3。',
    entries,
  };
  fs.mkdirSync(path.dirname(opts.allowlist), { recursive: true });
  fs.writeFileSync(opts.allowlist, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(
    `已重写白名单 ${path.relative(process.cwd(), opts.allowlist)}：` +
      `${entries.length} 个文件 / ${total(new Map(entries.map((e) => [e.path, e.count])))} 处`,
  );
  process.exit(0);
}

const { entries, map: allowed } = readAllowlist(opts.allowlist);
const problems = [];

if (opts.strict && entries.length > 0) {
  problems.push(
    `--strict 要求白名单为空，当前还登记着 ${entries.length} 个文件 / ${total(allowed)} 处（2.0 收门未完成）`,
  );
}

for (const [file, count] of [...hits.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (!allowed.has(file)) {
    problems.push(`${file}：新出现 ${count} 处旧品牌（未登记 —— 新债不许产生）`);
    continue;
  }
  const baseline = allowed.get(file);
  if (count > baseline) {
    problems.push(`${file}：${baseline} → ${count}（超出基线 ${count - baseline} 处 —— 旧债不许变大）`);
  }
}

let shrunk = 0;
for (const [file, baseline] of allowed) {
  const count = hits.get(file) ?? 0;
  if (count < baseline) shrunk += baseline - count;
}

if (problems.length) {
  console.error('✗ 旧品牌残留守卫未通过：');
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n提示：清理后请 \`node scripts/check-legacy.mjs --write\` 收基线；计划见 docs/ROADMAP-2.0.md §3（C1–C8）。`);
  process.exit(1);
}

const remaining = total(allowed) - shrunk;
console.log(
  `✓ 旧品牌残留未增长（${hits.size} 个文件 / ${total(hits)} 处；基线 ${entries.length} 个文件 / ${total(allowed)} 处）`,
);
if (shrunk > 0) {
  console.log(`  比基线少了 ${shrunk} 处 —— 跑 \`node scripts/check-legacy.mjs --write\` 收基线`);
}
if (remaining === 0) {
  console.log('  旧品牌残留已清零：可以把 --strict 加进 CI 作为 2.0 收门条件');
}
