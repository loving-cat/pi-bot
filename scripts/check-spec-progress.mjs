#!/usr/bin/env node
/**
 * 台账自检：文档里写的 commit 必须真的在仓库历史里。
 *
 *   node scripts/check-spec-progress.mjs
 *   node scripts/check-spec-progress.mjs --quiet   # 只报错
 *
 * ## 为什么需要
 *
 * `docs/TODO.md` / `docs/SPEC-COVERAGE.md` 里每一行都挂着 commit 号（"✅ `202f0d7`"）。
 * 那是它们的可信度来源：说改了就真改了，能查。
 *
 * 但**没人核过这些号**。实测一次就抓到 4 行过期状态：
 *
 *   · 写着"sweepLeases 生产零调用"，其实 `202f0d7` 早就接了；
 *   · 写着"policy-hook 不传 mode"，其实 `406fb89` 修了；
 *   · 写着"删 bot 不回收授权"，也已经接了。
 *
 * 过期台账比没有台账更坏：它让人以为还有一堆活，或者以为某件事没做而重做一遍。
 *
 * ## 它查什么（三件，都能机器判）
 *
 *   1. **commit 存在性**：文档里每个 `[0-9a-f]{7,40}` 都得能在 `git cat-file` 里找到。
 *   2. **文档提到的文件存在**：`` `src/xxx.js` `` / `` `docs/xxx.md` `` 之类的路径要真在。
 *   3. **✅ 行至少有一个证据**：挂了 commit / 测试文件 / 脚本之一，不许空口说"✅"。
 *
 * 不做什么：不判断"这条到底做没做完"——那需要人读代码，机器判不了。
 * 这里只把"明显对不上"的挑出来。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS = ['docs/TODO.md', 'docs/SPEC-COVERAGE.md', 'docs/acceptance-matrix.md'];
const quiet = process.argv.includes('--quiet');

const errors = [];
const warnings = [];

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** 这个 sha 在不在仓库里。 */
function commitExists(sha) {
  return git(['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

/** 文档里提到的仓库内路径在不在。 */
function pathExistsInRepo(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const SHA_RE = /\b([0-9a-f]{7,40})\b/g;
const PATH_RE = /`((?:server|app|scripts|docs|tools)\/[A-Za-z0-9._#@/+ -]+?\.(?:js|mjs|dart|md|ps1|json|ya?ml|cmake))`/g;

let scannedRows = 0;
let checkedShas = 0;
let checkedPaths = 0;
const missingSha = new Map();
const missingPath = new Map();

for (const doc of DOCS) {
  const file = path.join(ROOT, doc);
  if (!fs.existsSync(file)) {
    warnings.push(`缺文档：${doc}`);
    continue;
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    // 只看表格行（台账就是表格）
    if (!line.startsWith('|')) continue;
    scannedRows += 1;

    for (const m of line.matchAll(SHA_RE)) {
      const sha = m[1];
      // 只认"看起来是 commit"的：纯数字（版本号/端口/时间）不算
      if (/^\d+$/.test(sha)) continue;
      checkedShas += 1;
      if (!commitExists(sha)) {
        const key = `${doc}:${i + 1}`;
        if (!missingSha.has(key)) missingSha.set(key, []);
        missingSha.get(key).push(sha);
      }
    }

    for (const m of line.matchAll(PATH_RE)) {
      const rel = m[1].trim();
      checkedPaths += 1;
      if (!pathExistsInRepo(rel)) {
        const key = `${doc}:${i + 1}`;
        if (!missingPath.has(key)) missingPath.set(key, []);
        missingPath.get(key).push(rel);
      }
    }
  }
}

for (const [where, shas] of missingSha) {
  errors.push(`${where} 引用了不存在的 commit：${shas.join(', ')}`);
}
for (const [where, paths] of missingPath) {
  errors.push(`${where} 引用了不存在的文件：${paths.join(', ')}`);
}

// ---- 第三项：✅ 行必须有证据 ----
// 证据的形态：commit 号、测试/脚本路径、**点了名的实现文件**（`xxx.js` / `xxx.dart`）、
// 或者明确写了测试/实测。抠太严只会逼人往表格里灌水。
const EVIDENCE = /(`[0-9a-f]{7,40}`|`[\w./@-]+\.(js|mjs|dart|ps1)`|tests\/|scripts\/|check-|测试|实机|实测|规格)/;
for (const doc of DOCS) {
  const file = path.join(ROOT, doc);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('|') || !line.includes('✅')) continue;
    // 表头/分组行不算
    if (/^\|\s*-+/.test(line) || /^\|\s*(项|条款|能力|组)\s*\|/.test(line)) continue;
    if (!EVIDENCE.test(line)) {
      warnings.push(`${doc}:${i + 1} 标了 ✅ 但没有任何证据（commit / 测试 / 实测）：${line.slice(0, 60)}…`);
    }
  }
}

// ---------------------------------------------------------------- 输出
if (!quiet) {
  console.log(`台账自检：扫了 ${scannedRows} 行，核了 ${checkedShas} 个 commit、${checkedPaths} 个文件路径`);
}

for (const w of warnings) console.log(`⚠ ${w}`);
if (errors.length) {
  console.error(`\n✗ 台账与仓库对不上（${errors.length} 处）：\n`);
  for (const e of errors) console.error(`  ${e}`);
  console.error('\n修法：把过期的状态改成实际的，或者删掉那个引用。');
  process.exit(1);
}
console.log(`✓ 台账自检通过：引用的 commit 与文件都存在${warnings.length ? `（${warnings.length} 条提醒）` : ''}`);
