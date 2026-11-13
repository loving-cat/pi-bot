/**
 * 校验启动器 exe 的版本与 Node 侧常量一致。
 *   node tools/check-launcher-version.mjs [exe路径]
 *
 * 为什么单独一个脚本：CI 的 native job 和 scripts/build-sandbox-win.ps1
 * 都要做同一件事。两边各写一份 bash/pwsh 解析很容易漂移
 * （`-EncodedCommand` 那次就是漂移踩的坑）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const exeArg = process.argv[2];
if (!exeArg) {
  console.error('用法: node tools/check-launcher-version.mjs <pibot-sandbox.exe>');
  process.exit(2);
}
const exe = path.resolve(exeArg);
if (!fs.existsSync(exe)) {
  console.error(`找不到启动器：${exe}`);
  process.exit(1);
}

// Node 侧期望的版本（server/src/sandbox-win.js 里唯一一份）
const nodeSide = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'sandbox-win.js'), 'utf8',
);
const wanted = /LAUNCHER_VERSION = '([^']+)'/.exec(nodeSide)?.[1];
if (!wanted) {
  console.error('无法从 server/src/sandbox-win.js 读出 LAUNCHER_VERSION');
  process.exit(1);
}

const res = spawnSync(exe, ['version'], { encoding: 'utf8' });
if (res.status !== 0) {
  console.error(`启动器跑不起来（exit ${res.status}）：${(res.stderr || '').slice(0, 200)}`);
  process.exit(1);
}
const reported = /pibot-sandbox\s+(\S+)/.exec(res.stdout || '')?.[1];
if (!reported) {
  console.error(`版本输出无法解析：${JSON.stringify(res.stdout)}`);
  process.exit(1);
}
if (reported !== wanted) {
  console.error(`版本不一致：Node 侧 ${wanted}，exe ${reported}`);
  console.error('改了一边就要改另一边，并重新编译 native/pibot-sandbox。');
  process.exit(1);
}
console.log(`version ok: ${reported}`);
