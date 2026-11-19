#!/usr/bin/env node
/**
 * 规格进度与台账真实性自检（CI 用）。
 *
 *   node scripts/check-spec-progress.mjs
 *
 * ## 为什么需要它
 *
 * 文档会随着提交慢慢“过期失真”：写了某个 commit 却不存在、列了某个路径但早被删掉或尚未新建。
 * 本脚本把 `docs/` 里的规格与进度台账当成可校验对象：
 *   1. 行内反引号里的 commit hash，必须能在 git 历史里查到且类型为 commit（浅克隆时跳过历史校验）；
 *   2. 行内反引号里的仓内文件路径（server/app/scripts/docs/.github），除非该行显式标明未落地，否则必须真实存在。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const LEDGER_FILES = [
  'docs/spec-convergence-v1.md',
  'docs/PERMISSIONS-INVENTORY.md',
  'docs/taskrun-gaps.md',
  'docs/acceptance-matrix.md',
];

const PLANNED_MARKERS = ['待新增', '（新）', '未开始', '不存在', '❌'];

function runGit(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

let isShallow = false;
try {
  isShallow = runGit(['rev-parse', '--is-shallow-repository']) === 'true';
} catch (err) {
  console.error(`✗ 无法读取 git 仓库状态：${err?.message || err}`);
  process.exit(1);
}

const problems = [];
const checkedShas = new Set();
const checkedPaths = new Set();

for (const relDoc of LEDGER_FILES) {
  const fullDoc = path.join(ROOT, relDoc);
  if (!fs.existsSync(fullDoc)) {
    problems.push(`缺少台账文档：${relDoc}`);
    continue;
  }

  const lines = fs.readFileSync(fullDoc, 'utf8').split(/\r?\n/);
  let inFence = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const m of line.matchAll(/`([0-9a-f]{7,40})`/g)) {
      const sha = m[1];
      if (/^\d+$/.test(sha)) continue;
      checkedShas.add(sha);
      if (isShallow) continue;
      try {
        const objType = runGit(['cat-file', '-t', sha]);
        if (objType !== 'commit') {
          problems.push(`${relDoc}:${idx + 1} 引用 \`${sha}\` 不是 commit（实际为 ${objType}）`);
        } else {
          // ★ 光「对象存在」不够（2026-11-19 实测踩到）：rebase 之后旧提交对象
          //   还躺在 .git/objects 里，cat-file 查得到，但它不在任何分支上 ——
          //   换台机器 clone 就核验不到了。必须真的在 HEAD 的祖先链上。
          try {
            runGit(['merge-base', '--is-ancestor', sha, 'HEAD']);
          } catch {
            problems.push(
              `${relDoc}:${idx + 1} 引用的 commit \`${sha}\` 不在 HEAD 的历史上（rebase 前的孤儿？）`,
            );
          }
        }
      } catch {
        problems.push(`${relDoc}:${idx + 1} 引用的 commit \`${sha}\` 在当前 git 历史中不存在`);
      }
    }

    const isPlannedLine = PLANNED_MARKERS.some((mark) => line.includes(mark));
    for (const m of line.matchAll(/`((?:server|app|scripts|docs|\.github)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g)) {
      const target = m[1];
      if (target.includes('*') || target.includes('{') || isPlannedLine) continue;
      checkedPaths.add(target);
      if (!fs.existsSync(path.join(ROOT, target))) {
        problems.push(`${relDoc}:${idx + 1} 引用的文件 \`${target}\` 不存在`);
      }
    }
  }
}

if (problems.length) {
  console.log('✗ 规格台账校验失败：');
  for (const p of problems) console.log(`  · ${p}`);
  process.exit(1);
}

const shaNote = isShallow
  ? `${checkedShas.size} 个 commit SHA（浅克隆跳过历史查重）`
  : `${checkedShas.size} 个 commit SHA 已核验`;
console.log(`✓ 规格台账与仓库一致（${LEDGER_FILES.length} 份文档 / ${shaNote} / ${checkedPaths.size} 个路径真实存在）`);
