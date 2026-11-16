#!/usr/bin/env node
/**
 * 第三方组件许可证清单（规格 §14.2）。
 *
 *   node scripts/check-licenses.mjs          # 重新生成 docs/LICENSES.md 并检查
 *   node scripts/check-licenses.mjs --check  # 只检查，不写文件（CI 用）
 *
 * ## 为什么要有这个
 *
 * §14.2 要求：内置/随包分发的组件必须核对**锁文件、安装及打包清单、许可证义务
 * 和来源**，未核实的不得列为已选型内置依赖。而仓库里此前只有根 `LICENSE` ——
 * 也就是说"我们随包发了什么、它们的许可证允许我们这么发吗"，一个字都没有。
 *
 * 这件事不能靠"我记得都是 MIT"。所以做成脚本：**从真的装了什么读**，
 * 而不是从我们以为装了什么写。
 *
 * ## 判定规则
 *
 * | 判定 | 许可证 | 处置 |
 * |---|---|---|
 * | ✅ 宽松 | MIT / ISC / Apache-2.0 / BSD-2/3 / 0BSD / Unlicense / CC0 | 可以用 |
 * | ⚠️ 需复核 | LGPL / MPL / EPL / CC-BY / 复合表达式 | 需要人看一眼（动态链接、修改义务） |
 * | ⛔ 不可用 | GPL / AGPL / SSPL | 随包分发会传染，必须换掉 |
 * | ❓ 未知 | 读不到 license 字段 / 目录里没有 LICENSE | 当成不可用 |
 *
 * ## 它读哪里
 *
 *   · `server/package.json` 的 dependencies → `server/node_modules/<name>/package.json`
 *   · `app/pubspec.lock` → `.dart_tool/package_config.json` 里的 rootUri →
 *     那个包里找 `LICENSE*`
 *
 * 不读 transitive 的 transitive？读。`node_modules` 里所有包都列出来，
 * 因为随包发布的是它们全部。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'LICENSES.md');
const checkOnly = process.argv.includes('--check');

/** 许可证文本 → 判定。宁可把不确定的算"需复核"，也不要放宽。 */
const VERDICT_RULES = [
  { verdict: '⛔ 不可用', re: /\b(A?GPL|SSPL)\b|GNU (Affero )?General Public/i },
  { verdict: '⚠️ 需复核', re: /\b(L?GPL|MPL|EPL|CDDL|CC-BY|Artistic)\b/i },
  // 只写 "BSD" 的：可能是 4-clause（带广告条款），所以算需复核而不是宽松
  { verdict: '⚠️ 需复核', re: /^BSD$/i },
  {
    verdict: '✅ 宽松',
    re: /^(MIT|MIT-0|ISC|Apache-2\.0|BSD-[23]-Clause|0BSD|Unlicense|CC0-1\.0|BlueOak-1\.0\.0|Zlib|Apache-2\.0 WITH LLVM-exception)$/i,
  },
];

function classify(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { verdict: '❓ 未知', why: '没有 license 字段' };
  // ★ 复合表达式要按**法律含义**算，不能一律取最严：
  //   · `MIT OR GPL-3.0-or-later` —— 我们可以选 MIT，所以是宽松的（取最好）；
  //   · `MIT AND Zlib` —— 两份义务都要满足，取最严。
  //   一律取最严会把双许可包误判成不可用，然后有人为了"过检查"加一条白名单，
  //   那才是真把闸拆了。
  const paren = /^\((.*)\)$/.exec(text);
  const body = paren ? paren[1] : text;
  if (/\s+OR\s+/i.test(body)) {
    const judged = body.split(/\s+OR\s+/i).map((p) => classify(p.trim()));
    const best = judged.find((j) => j.verdict.startsWith('✅')) ?? judged[judged.length - 1];
    return { verdict: best.verdict, why: `双许可（可选其一）：${text}` };
  }
  if (/\s+AND\s+/i.test(body)) {
    const judged = body.split(/\s+AND\s+/i).map((p) => classify(p.trim()));
    const worst = judged.find((j) => j.verdict.startsWith('⛔'))
      ?? judged.find((j) => j.verdict.startsWith('❓'))
      ?? judged.find((j) => j.verdict.startsWith('⚠'))
      ?? judged[0];
    return { verdict: worst.verdict, why: `多份许可（需同时满足）：${text}` };
  }
  // 到了这里就只剩单个标识符：按规则判（**不能再调 classify**，否则自递归）
  for (const r of VERDICT_RULES) {
    if (r.re.test(body)) return { verdict: r.verdict, why: '' };
  }
  return { verdict: '❓ 未知', why: `认不出的许可证：${text}` };
}

/** 读一个包的许可证：先看 package.json，再看目录里的 LICENSE 文件。 */
function readNodePackage(dir, name) {
  const pkgFile = path.join(dir, 'package.json');
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch {
    return { name, version: '?', license: '', source: 'package.json 读不出来' };
  }
  let license = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l?.type ?? l).join(' OR ') : '');
  if (!license) {
    // 老包可能只有 LICENSE 文件，没有字段
    try {
      const files = fs.readdirSync(dir).filter((f) => /^licen[cs]e/i.test(f));
      if (files.length) {
        const text = fs.readFileSync(path.join(dir, files[0]), 'utf8').slice(0, 4000);
        if (/MIT License/i.test(text)) license = 'MIT';
        else if (/Apache License/i.test(text)) license = 'Apache-2.0';
        else if (/BSD 3-Clause/i.test(text)) license = 'BSD-3-Clause';
        else if (/BSD 2-Clause/i.test(text)) license = 'BSD-2-Clause';
        else if (/ISC/i.test(text)) license = 'ISC';
        else if (/GNU (Affero )?General Public License/i.test(text)) license = /Affero/.test(text) ? 'AGPL' : 'GPL';
        else if (/Lesser General Public License/i.test(text)) license = 'LGPL';
      }
    } catch { /* 读不到就是未知 */ }
  }
  return {
    name,
    version: String(pkg.version ?? '?'),
    license: String(license ?? ''),
    source: 'node_modules',
  };
}

function nodePackages() {
  const root = path.join(ROOT, 'server', 'node_modules');
  if (!fs.existsSync(root)) return { missing: true, list: [] };
  const list = [];
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const dir = path.join(root, entry);
    if (entry.startsWith('@')) {
      for (const sub of fs.readdirSync(dir)) {
        if (sub.startsWith('.')) continue;
        list.push(readNodePackage(path.join(dir, sub), `${entry}/${sub}`));
      }
      continue;
    }
    if (fs.statSync(dir).isDirectory()) list.push(readNodePackage(dir, entry));
  }
  return { missing: false, list };
}

function flutterPackages() {
  const lockFile = path.join(ROOT, 'app', 'pubspec.lock');
  const cfgFile = path.join(ROOT, 'app', '.dart_tool', 'package_config.json');
  if (!fs.existsSync(lockFile)) return { missing: true, list: [] };
  let versions = new Map();
  try {
    const lock = fs.readFileSync(lockFile, 'utf8');
    // pubspec.lock 是 YAML；这里只抓"包名 + 两行后的 version"
    const re = /^ {2}([a-z0-9_]+):\n(?:.*\n)*? {4}version: "?([^"\n]+)"?/gm;
    for (const m of lock.matchAll(re)) versions.set(m[1], m[2]);
  } catch { /* 解析不了就只有名字 */ }

  let roots = new Map();
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      for (const p of cfg.packages ?? []) {
        if (!p?.rootUri) continue;
        const dir = p.rootUri.startsWith('file://')
          ? decodeURIComponent(new URL(p.rootUri).pathname).replace(/^\/([A-Za-z]:)/, '$1')
          : path.resolve(ROOT, 'app', '.dart_tool', p.rootUri);
        roots.set(String(p.name), dir);
      }
    } catch { /* 没有 package_config 就只列版本 */ }
  }

  const list = [];
  for (const [name, version] of versions) {
    if (name === 'flutter' || name === 'sky_engine') continue; // SDK 自带，不是随包第三方组件
    const dir = roots.get(name);
    let license = '';
    if (dir && fs.existsSync(dir)) {
      try {
        const file = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
        if (file) {
          const text = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 4000);
          if (/MIT/i.test(text)) license = 'MIT';
          else if (/Apache License/i.test(text)) license = 'Apache-2.0';
          else if (/BSD 3-Clause/i.test(text)) license = 'BSD-3-Clause';
          else if (/BSD 2-Clause|Redistribution and use in source and binary/i.test(text)) license = 'BSD-2-Clause';
          else if (/ISC/i.test(text)) license = 'ISC';
          else if (/GNU (Affero )?General Public License/i.test(text)) license = /Affero/.test(text) ? 'AGPL' : 'GPL';
          else if (/Lesser General Public License/i.test(text)) license = 'LGPL';
        }
      } catch { /* 未知 */ }
    }
    list.push({ name, version: String(version), license, source: 'pubspec' });
  }
  return { missing: false, list };
}

// ---------------------------------------------------------------- 汇总
const node = nodePackages();
const dart = flutterPackages();
const rows = [...node.list, ...dart.list].map((p) => ({ ...p, ...classify(p.license) }));
rows.sort((a, b) => a.name.localeCompare(b.name));

const counts = new Map();
for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);

const bad = rows.filter((r) => r.verdict.startsWith('⛔'));
const unknown = rows.filter((r) => r.verdict.startsWith('❓'));
const review = rows.filter((r) => r.verdict.startsWith('⚠'));

const lines = [
  '# 第三方组件许可证清单',
  '',
  '> 由 `node scripts/check-licenses.mjs` 生成，**不要手改**。',
  '> 来源是"真的装在机器上的东西"（`server/node_modules` 与 `app/.dart_tool`），',
  '> 不是手写的依赖列表 —— 规格 §14.2 要求核对的是锁文件与打包清单，不是记忆。',
  '',
  `生成时间：${new Date().toISOString().slice(0, 10)}　｜　`
    + `共 ${rows.length} 个组件：`
    + [...counts].map(([k, v]) => `${k} ${v}`).join('　'),
  '',
  '## 判定规则',
  '',
  '| 判定 | 包含 | 处置 |',
  '|---|---|---|',
  '| ✅ 宽松 | MIT / ISC / Apache-2.0 / BSD / 0BSD / Unlicense / CC0 | 可以随包分发 |',
  '| ⚠️ 需复核 | LGPL / MPL / EPL / CDDL / CC-BY / 复合表达式 | 人看一眼：动态链接、修改义务、署名要求 |',
  '| ⛔ 不可用 | GPL / AGPL / SSPL | 随包分发会传染，必须换掉 |',
  '| ❓ 未知 | 读不到 license 字段，目录里也没 LICENSE | 当成不可用，直到核实 |',
  '',
];

if (bad.length || unknown.length) {
  lines.push('## ⛔ 需要处理', '');
  for (const r of [...bad, ...unknown]) {
    lines.push(`- **${r.name}@${r.version}** — ${r.verdict}（${r.license || '未声明'}）`);
  }
  lines.push('');
}
if (review.length) {
  lines.push('## ⚠️ 需复核', '');
  for (const r of review) lines.push(`- **${r.name}@${r.version}** — ${r.license}`);
  lines.push('');
}

lines.push('## 全量清单', '', '| 组件 | 版本 | 许可证 | 判定 | 来源 |', '|---|---|---|---|---|');
for (const r of rows) {
  lines.push(`| ${r.name} | ${r.version} | ${r.license || '(未声明)'} | ${r.verdict} | ${r.source} |`);
}
lines.push('');

if (node.missing) lines.push('> ⚠ `server/node_modules` 不存在：Node 部分没扫到（先 `npm install`）。', '');
if (dart.missing) lines.push('> ⚠ `app/pubspec.lock` 不存在：Flutter 部分没扫到。', '');

if (!checkOnly) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(`✓ 已生成 ${path.relative(ROOT, OUT)}：${rows.length} 个组件`);
}

const summary = [...counts].map(([k, v]) => `${k} ${v}`).join('　');
console.log(`   ${summary}`);

if (bad.length || unknown.length) {
  console.error(`\n✗ 有 ${bad.length + unknown.length} 个组件不能随包分发（GPL/AGPL/未知）：`);
  for (const r of [...bad, ...unknown]) console.error(`  · ${r.name}@${r.version} — ${r.license || '未声明'}`);
  console.error('\n修法：换掉它，或者在 docs/LICENSES.md 里写明为什么可以用（并在这里加白名单）。');
  process.exit(1);
}
console.log('✓ 许可证检查通过：没有 GPL/AGPL/未声明许可证的组件');
