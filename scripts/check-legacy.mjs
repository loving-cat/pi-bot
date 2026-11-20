#!/usr/bin/env node
/**
 * 旧品牌残留守卫（Orbis 2.0 清债 · T1.0）。
 *
 *   node scripts/check-legacy.mjs              # 检查（CI 用）
 *   node scripts/check-legacy.mjs --write      # 重写 entries 基线（保留 permanent）
 *   node scripts/check-legacy.mjs --strict     # 2.0 收门：待清债项必须清零
 *   node scripts/check-legacy.mjs --root <dir> --allowlist <file>   # 测试用
 *
 * ## 为什么需要它
 *
 * 品牌从 pi-bot 换成 Orbis 之后，旧名字散在 300 多个文件里：环境变量双前缀、
 * 请求头双读、mDNS 服务类型、原生启动器名、文案……它们大多**不是 bug**，
 * 是刻意保留的兼容层（见 `docs/ROADMAP-2.0.md` §1.1 的 C1–C8）。
 *
 * 真正危险的是**悄悄增长**：新功能顺手又写了一个 `PI_BOT_*`、新加一个
 * `x-pi-bot-` 头，一年后没人分得清哪些是兼容层的债、哪些是还在生长的草。
 *
 * ## 两分区（这是关键）
 *
 *   · `permanent`：**永远不删**的身份常量 —— mDNS 服务类型、TLS 证书名、
 *     Android applicationId、macOS bundle id、Dart 包名。删了就是换一个新应用，
 *     1.x 客户端再也发现不了 2.x 服务端。这里按「模式」登记，命中直接不计入债务。
 *   · `entries`   ：**待清债项**（C1–C5、C7、C8 的代码残留）。按文件登记计数：
 *       - 没登记的文件出现旧名字 → 红（新债不许产生）
 *       - 已登记的文件出现比基线更多 → 红（旧债不许变大）
 *       - 变少了 → 绿（并提示可以 `--write` 收基线）
 *
 * `--strict` 只要求 `entries` 清零；`permanent` 不参与收门判定 —— 否则
 * 「C6 永久双播」和「2.0 收门」会互相卡死。
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

/**
 * 首次生成白名单时写入的永久保留项（之后以 JSON 里的为准）。
 * 每一条都对应 `docs/ROADMAP-2.0.md` §1.1 的 C6 或 `docs/RELEASE.md` 的「永远不删」表。
 */
const DEFAULT_PERMANENT = [
  { pattern: 'pibot.discover', reason: 'C6 mDNS 探测类型：1.x 客户端靠它发现 2.x 服务端，永久双播' },
  { pattern: 'pibot.host', reason: 'C6 mDNS 公告类型：同上，永久双播' },
  { pattern: 'pi-bot.local', reason: 'C6 TLS 自签证书名：1.x 客户端按它校验，2.x 保留' },
  { pattern: 'com.pibot.pi_bot', reason: 'Android applicationId：改了老用户装不上更新，只能卸载重装' },
  { pattern: 'io.pibot.piBot', reason: 'macOS bundle id：改了等于换新应用（权限/钥匙串/偏好全重来）' },
  { pattern: 'package:pi_bot/', reason: 'Dart 包名（pubspec name: pi_bot）：改名要动全仓 import，无用户可见收益' },
  { pattern: 'name: pi_bot', reason: 'Dart 包名声明（pubspec.yaml）' },
];

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

/** 统计一行里「不被 permanent 模式覆盖」的旧品牌命中 */
function countLine(line, patterns) {
  const ranges = [];
  for (const p of patterns) {
    let from = 0;
    for (;;) {
      const at = line.indexOf(p, from);
      if (at < 0) break;
      ranges.push([at, at + p.length]);
      from = at + p.length;
    }
  }
  let debt = 0;
  let permanent = 0;
  for (const m of line.matchAll(LEGACY)) {
    const start = m.index;
    const end = start + m[0].length;
    const covered = ranges.some(([s, e]) => start >= s && end <= e);
    if (covered) permanent++;
    else debt++;
  }
  return { debt, permanent };
}

function countInFile(file, patterns) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { debt: 0, permanent: 0 };
  }
  if (!text || text.includes('\u0000')) return { debt: 0, permanent: 0 }; // 保险：读成二进制就跳过
  let debt = 0;
  let permanent = 0;
  for (const line of text.split(/\r?\n/)) {
    const r = countLine(line, patterns);
    debt += r.debt;
    permanent += r.permanent;
  }
  return { debt, permanent };
}

function readAllowlist(file) {
  if (!fs.existsSync(file)) {
    return { entries: [], map: new Map(), permanent: DEFAULT_PERMANENT.map((p) => ({ ...p })) };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const map = new Map();
    for (const item of list) {
      if (!item || typeof item.path !== 'string') continue;
      const count = Number.isFinite(item.count) ? Math.max(0, Math.floor(item.count)) : 0;
      map.set(item.path, count);
    }
    const permanent = (Array.isArray(parsed?.permanent) ? parsed.permanent : [])
      .filter((p) => p && typeof p.pattern === 'string' && p.pattern)
      .map((p) => ({ pattern: p.pattern, reason: String(p.reason ?? '') }));
    return { entries: list, map, permanent: permanent.length ? permanent : DEFAULT_PERMANENT.map((p) => ({ ...p })) };
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
const allow = readAllowlist(opts.allowlist);
const patterns = allow.permanent.map((p) => p.pattern);

const hits = new Map();
let permanentHits = 0;
for (const rel of SCAN_DIRS) {
  const abs = path.join(opts.root, rel);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const relPath = path.relative(opts.root, file).split(path.sep).join('/');
    if (SKIP_FILES.has(relPath)) continue;
    const { debt, permanent } = countInFile(file, patterns);
    permanentHits += permanent;
    if (debt > 0) hits.set(relPath, debt);
  }
}

if (opts.write) {
  const entries = [...hits.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, count]) => ({ path: p, count }));
  const payload = {
    _comment:
      '旧品牌残留基线（scripts/check-legacy.mjs）。entries = 待清债项，只许变小：' +
      '新增文件或计数上涨都会让 CI 变红；permanent = 永远不删的身份常量（C6 / 应用 ID / Dart 包名），' +
      '命中不计入债务。清理进度见 docs/ROADMAP-2.0.md §1.1 / §3。',
    permanent: allow.permanent,
    entries,
  };
  fs.mkdirSync(path.dirname(opts.allowlist), { recursive: true });
  fs.writeFileSync(opts.allowlist, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(
    `已重写白名单 ${path.relative(process.cwd(), opts.allowlist)}：` +
      `待清债 ${entries.length} 个文件 / ${total(new Map(entries.map((e) => [e.path, e.count])))} 处；` +
      `永久保留 ${allow.permanent.length} 个模式（命中 ${permanentHits} 处不计入）`,
  );
  process.exit(0);
}

const problems = [];

if (opts.strict && allow.entries.length > 0) {
  problems.push(
    `--strict 要求待清债项为空，当前还登记着 ${allow.entries.length} 个文件 / ${total(allow.map)} 处（2.0 收门未完成）`,
  );
}

for (const [file, count] of [...hits.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (!allow.map.has(file)) {
    problems.push(`${file}：新出现 ${count} 处旧品牌（未登记 —— 新债不许产生）`);
    continue;
  }
  const baseline = allow.map.get(file);
  if (count > baseline) {
    problems.push(`${file}：${baseline} → ${count}（超出基线 ${count - baseline} 处 —— 旧债不许变大）`);
  }
}

let shrunk = 0;
for (const [file, baseline] of allow.map) {
  const count = hits.get(file) ?? 0;
  if (count < baseline) shrunk += baseline - count;
}

if (problems.length) {
  console.error('✗ 旧品牌残留守卫未通过：');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\n提示：清理后请 `node scripts/check-legacy.mjs --write` 收基线；' +
      '永久保留项写进白名单的 permanent 区（带原因），不要塞进 entries。',
  );
  process.exit(1);
}

const remaining = total(allow.map) - shrunk;
console.log(
  `✓ 旧品牌残留未增长（待清债 ${hits.size} 个文件 / ${total(hits)} 处；` +
    `基线 ${allow.entries.length} 个文件 / ${total(allow.map)} 处；` +
    `永久保留 ${allow.permanent.length} 个模式 / ${permanentHits} 处不计入）`,
);
if (shrunk > 0) {
  console.log(`  比基线少了 ${shrunk} 处 —— 跑 \`node scripts/check-legacy.mjs --write\` 收基线`);
}
if (remaining === 0) {
  console.log('  待清债项已清零：可以把 --strict 加进 CI 作为 2.0 收门条件');
}
