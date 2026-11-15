#!/usr/bin/env node
/**
 * 能力清单漂移自检（CI 用）。
 *
 *   node scripts/check-capability-drift.mjs
 *
 * ## 为什么需要它
 *
 * 「加一个能力要改 7 处」这件事已经收成 1 处（`src/capabilities.js`）。
 * 但只要派生层（action-catalog / role-tools / migration-grants）里
 * 还能手写工具名，那个结构就会**慢慢长回去** —— 而且长回去不会报错。
 *
 * 这个脚本就是那条护栏：**派生层里不允许出现工具名字符串**。
 *
 * ## 判据
 *
 * 1. 派生层里不能出现 `'tool_name'` 形式的字面量（工具名只能声明在 capabilities）
 * 2. 每份名单（READONLY_ALLOW / MUTATING_TOOLS / ...）只允许定义一处
 * 3. `auditCapabilities()` 必须干净
 *
 * 允许的例外写在 `ALLOW` 里，并注明理由 —— 不许默默放行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

/** 派生层：这些文件只许转发，不许再手写工具名。 */
const DERIVED = ['action-catalog.js', 'role-tools.js', 'migration-grants.js'];

/**
 * 例外：派生层里确实需要出现的工具名字面量。
 * 加一条必须写理由 —— 否则护栏就废了。
 */
const ALLOW = new Map();

const { ACTIONS, TOOL_SPECS, auditCapabilities } = await import(
  pathToFileURL(path.join(SRC, 'capabilities.js'))
);

let problems = [];

// ---- 1) 派生层不许出现工具名字面量
const toolNames = Object.keys(TOOL_SPECS);
for (const file of DERIVED) {
  const src = read(file);
  for (const tool of toolNames) {
    if (!src.includes(`'${tool}'`) && !src.includes(`"${tool}"`)) continue;
    const allowed = (ALLOW.get(file) ?? []).includes(tool);
    if (!allowed) problems.push(`${file} 里出现了工具名 '${tool}' —— 工具只能声明在 capabilities.js`);
  }
}

// ---- 2) 名单只能定义一处
const NAMES = [
  'READONLY_ALLOW', 'MUTATING_TOOLS', 'COORDINATION_TOOLS', 'CHIEF_ONLY_TOOLS',
  'CHIEF_ONLY_ACTIONS', 'MIGRATION_WITHHELD', 'GATED_ACTIONS',
  'LEAD_EXTRA_BUILTINS', 'OPAQUE_SCRIPT_TOOLS', 'SECURITY_CONFIG_TOOLS',
];
const allFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
for (const name of NAMES) {
  const definers = allFiles.filter((f) => read(f).includes(`export const ${name} =`));
  if (definers.length !== 1) {
    problems.push(`${name} 应当只定义一处，实际在 ${definers.join(', ') || '(无)'}`);
  } else if (definers[0] !== 'capabilities.js') {
    problems.push(`${name} 应当定义在 capabilities.js，实际在 ${definers[0]}`);
  }
}

// ---- 3) 清单自检
problems = problems.concat(auditCapabilities());

if (problems.length) {
  console.log('✗ 能力清单漂移：');
  for (const p of problems) console.log('   · ' + p);
  console.log(`\n${problems.length} 个问题。工具名与名单只允许在 src/capabilities.js 里声明。`);
  process.exit(1);
}
console.log(`✓ 能力清单没有漂移（${Object.keys(ACTIONS).length} 个动作 / ${toolNames.length} 个工具 / ${DERIVED.length} 个派生层文件）`);
