/**
 * 纯单测统一入口（不需要起服务端、不需要网络）。
 *   node tests/all.mjs
 *
 * 集成测试（smoke/org/steer/attach）需要先起服务端，单独跑：见 README。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TESTS = [
  'model-config',
  'model-thinking',
  'version',
  'pi-args',
  'console-inherit',
  'closing-turn',
  'transcript-budget',
  'skills',
  'lessons',
  'lesson-reflect',
  'site-draft',
  'merge-messages',
  'local-capabilities',
  'mcp',
  'sites',
  'secrets',
  'retry-policy',
  'update-check',
  'update-checker',
  'session-resources',
  'relay-frames',
  'unit',
  'tasks',
  'automations',
  'uploads',
  'approvals',
  'hooks',
  'shell-policy',
  'policy-hook',
  'shells',
  'change-watch',
  'dm',
  'ask-guard',
  'ask-card',
  'auth',
  'device-revoke',
  'disk',
  'room-lock',
  'model-health',
];

let failed = 0;
const rows = [];
for (const name of TESTS) {
  const file = path.join(process.cwd(), 'tests', `${name}.mjs`);
  const res = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const ok = res.status === 0;
  if (!ok) failed++;
  const tail = (res.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  rows.push(`${ok ? '✓' : '✗'} ${name.padEnd(16)} ${tail}`);
  if (!ok) {
    // 把子文件里带 ✗ 的行打出来：CI 日志只留最后一行的话，
    // 根本看不出是哪一个用例红的（排查一次要重跑一轮）。
    const detail = (res.stdout || '')
      .split(/\r?\n/)
      .filter((line) => line.includes('✗') && !line.includes('通过'))
      .slice(0, 5);
    if (detail.length) rows.push(detail.map((line) => `    ${line.trim()}`).join('\n'));
  }
  if (!ok && res.stderr) rows.push(res.stderr.trim().split(/\r?\n/).slice(-3).join('\n'));
}

console.log('\n================ 全部纯单测 ================');
console.log(rows.join('\n'));
console.log(`\n${TESTS.length - failed}/${TESTS.length} 个测试文件通过`);
process.exit(failed ? 1 : 0);
