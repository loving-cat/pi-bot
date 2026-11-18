#!/usr/bin/env node
/**
 * 编码风格与模块边界自检（CI 用）。
 *
 *   node scripts/check-style.mjs
 *
 * ## 为什么需要它
 *
 * 对应 `docs/spec-convergence-v1.md` §1：
 *   1. 纯逻辑模块必须独立成无副作用叶子文件：头部写清“为什么”，不引 store/config/IO，不偷读系统时钟；
 *   2. 核心纯逻辑模块必须有对应回归测试文件兜底（拒绝形式主义空壳单测）；
 *   3. `pi-runner.js` 外观层体积受控，`runner/*.js` 保持单向 DAG 与体积预算，防止逻辑重新糊成大泥球。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_SRC = path.join(ROOT, 'server', 'src');
const SERVER_TESTS = path.join(ROOT, 'server', 'tests');

const PURE_MODULES = [
  'grants.js',
  'capabilities.js',
  'policy-version.js',
  'role-tools.js',
  'action-catalog.js',
  'duplex-router.js',
  'group-round.js',
  'overrides.js',
  'desktop-lease.js',
  'desktop-takeover.js',
  'retry-policy.js',
  'circuit-breaker.js',
  'memory-policy.js',
  'model-thinking.js',
  'brand.js',
  'chat-redact.js',
  'update-check.js',
  'opening-reply.js',
  'pass-marker.js',
  'task-title.js',
];

const TEST_OVERRIDES = new Map([
  ['group-round.js', 'closing-turn.mjs'],
  ['brand.js', 'sdk-runtime.mjs'],
  ['chat-redact.js', 'jarvis-mode.mjs'],
]);

const FORBIDDEN_IMPORT =
  /(?:from\s+|import\s*\(\s*|import\s+)['"](?:(?:\.\.?\/)*(?:store|config)\.js|(?:node:)?(?:fs|child_process|http|https|net))['"]/g;

function stripCommentsPreserveStrings(source) {
  return source.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, literal) => (literal ?? ''),
  );
}

const problems = [];

for (const file of PURE_MODULES) {
  const full = path.join(SERVER_SRC, file);
  if (!fs.existsSync(full)) {
    problems.push(`缺少纯逻辑模块：server/src/${file}`);
    continue;
  }

  const raw = fs.readFileSync(full, 'utf8');
  if (!raw.trimStart().startsWith('/**')) {
    problems.push(`server/src/${file} 必须以 /** 文件头注释说明设计原因与边界`);
  }

  const code = stripCommentsPreserveStrings(raw);
  for (const m of code.matchAll(FORBIDDEN_IMPORT)) {
    problems.push(`纯逻辑模块 server/src/${file} 禁止引入 IO/状态依赖（${m[0].trim()}）`);
  }

  for (const m of code.matchAll(/Date\.now\(\)/g)) {
    const before = code.slice(Math.max(0, m.index - 24), m.index);
    if (!/\bnow\s*=\s*$/.test(before)) {
      problems.push(`纯逻辑模块 server/src/${file} 禁止直接调用 Date.now()，须通过 now = Date.now() 注入时钟`);
    }
  }

  const testName = TEST_OVERRIDES.get(file) ?? file.replace(/\.js$/, '.mjs');
  if (!fs.existsSync(path.join(SERVER_TESTS, testName))) {
    problems.push(`纯逻辑模块 server/src/${file} 缺少对应回归测试 server/tests/${testName}`);
  }
}

const runnerFacadePath = path.join(SERVER_SRC, 'pi-runner.js');
if (!fs.existsSync(runnerFacadePath)) {
  problems.push('缺少 server/src/pi-runner.js');
} else {
  const lines = fs.readFileSync(runnerFacadePath, 'utf8').split(/\r?\n/).length;
  if (lines > 850) {
    problems.push(`server/src/pi-runner.js 超出外观层行数预算（${lines} > 850）`);
  }
}

const runnerDir = path.join(SERVER_SRC, 'runner');
let runnerSubCount = 0;
if (!fs.existsSync(runnerDir)) {
  problems.push('缺少 server/src/runner 目录');
} else {
  for (const file of fs.readdirSync(runnerDir).filter((f) => f.endsWith('.js')).sort()) {
    runnerSubCount++;
    const raw = fs.readFileSync(path.join(runnerDir, file), 'utf8');
    if (!raw.trimStart().startsWith('/**')) {
      problems.push(`server/src/runner/${file} 缺少 /** 模块头说明`);
    }
    const lines = raw.split(/\r?\n/).length;
    if (lines > 1350) {
      problems.push(`server/src/runner/${file} 超出行数预算（${lines} > 1350）`);
    }
    const imports = [...stripCommentsPreserveStrings(raw).matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1]);
    if (imports.some((spec) => spec.includes('pi-runner'))) {
      problems.push(`server/src/runner/${file} 违反单向依赖 DAG：禁止反向导入 pi-runner.js`);
    }
  }
}

if (problems.length) {
  console.log('✗ 编码风格与模块边界检查未通过：');
  for (const p of problems) console.log(`  · ${p}`);
  process.exit(1);
}

console.log(`✓ 编码风格与模块边界全部通过（${PURE_MODULES.length} 个纯逻辑模块 / pi-runner + ${runnerSubCount} 个 runner 子模块）`);
