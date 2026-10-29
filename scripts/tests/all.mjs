/** 打包脚本的 Node 单测入口。Linux CI 可跑；不替代真实 flutter build。 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tests = [
  'stage-macos-build-test.mjs',
  'prepare-macos-bundle-test.mjs',
  'stage-app-build-test.mjs',
  'prepare-windows-bundle-test.mjs',
];

let failed = 0;
for (const test of tests) {
  console.log(`\n== ${test} ==`);
  const result = spawnSync(process.execPath, [path.join(dir, test)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}
if (failed) {
  console.error(`\n${failed} script test file(s) failed`);
  process.exit(1);
}
console.log('\npack script unit tests passed');
