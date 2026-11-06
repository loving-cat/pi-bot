import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 验证占位符豁免不会把真 key 一起放行。
// 这是最危险的回归方向：宁可漏报几个假 key，也不能让真 key 混过去。
//
// ★ 这个文件自己也要过扫描。所以：
//   · 路径从脚本位置推出来，不写死本机目录
//   · 样例 key 在运行时拼出来，源码里不留字面量
//     （和 check-secrets-push-test.sh 的做法一样）

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '..', 'check-secrets.mjs');

/** 拼一个"看起来像真 key"的串，但源码里不出现完整字面量。 */
const key = (...parts) => parts.join('');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ph-'));
execFileSync('git', ['init', '-q', tmp]);

function commitWith(content, message) {
  const f = path.join(tmp, 'probe.txt');
  fs.writeFileSync(f, content);
  execFileSync('git', ['-C', tmp, 'add', 'probe.txt']);
  // --allow-empty：内容没变时也要能造出一个新提交（测提交信息扫描要用）
  execFileSync('git', ['-C', tmp, '-c', 'user.name=probe',
    '-c', 'user.email=1+someone@users.noreply.github.com',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message]);
}

function run() {
  try {
    execFileSync('node', [script], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return err.status;
  }
}

const cases = [
  // [内容, 期望退出码, 说明]
  [`key = "${key('sk-', '1234567890', 'abcdef')}"`, 0, '连续数字占位符 → 放行'],
  [`key = "${key('sk-', 'abcdef', 'abcdefaaaa')}"`, 0, 'abcdef 顺序串 → 放行'],
  [`key = "${key('sk-', 'aaaaaaaa', 'aaaaaaaa')}"`, 0, '同字符重复 → 放行'],
  [`key = "${key('sk-', '1234567890', '123456')}"`, 0, '全数字 → 放行'],
  // 真 key 形状必须照抓 —— 用**合成**的高熵串，绝不能用任何真实凭据。
  // 这段刻意拆得很碎：源码里任何一处都不构成完整的 key 形状。
  [
    `key = "${key('sk', '-', 'Qv7', 'Lm2', 'Zp9', 'Rt4', 'Wx8', 'Yn3', 'Kj6', 'Hf5', 'Dc1', 'Ab0', 'Ei7', 'Gu9', 'Ox2', 'Sn5')}"`,
    1,
    '★ 高熵 key 形状必须抓住',
  ],
  [`key = "${key('sk-proj-', 'Xb7Kq2mNp9Rt4Vw1Zs8Yh3Lj6Gf5Dc0Ab2Ei7Hn')}"`, 1, '★ 另一种真 key 必须抓住'],
  [`key = "${key('sk-', 'Zm9Xq4Lp7Rt2Vw8Yn5Kj3Hf6Dc1Ab0Ei9Gu7Ox')}"`, 1, '★ 短一点的真 key 也必须抓住'],
];

let failed = 0;
for (const [content, want, why] of cases) {
  commitWith(content, 'probe');
  const code = run();
  const ok = code === want;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${why} (exit ${code}, want ${want})`);
  if (!ok) failed = 1;
}

// ---------------------------------------------------------------------------
// --push 档：提交信息本身也要扫
//
// 真实踩过：修掉一处误报的提交，提交信息里**引用了那个假值**的描述，
// 顺手把自己的本机路径也写了进去 —— 文件树是干净的，但提交信息泄漏了。
// 这一段专门钉住"提交信息里的本机路径必须被抓住"。
// ---------------------------------------------------------------------------
// 用户名不能用 ALLOW 里放行的那几个（you/someone/user/runner/...），
// 否则这条"必须抓住"的断言会变成永远通过的空断言。
const hostPath = ['/Users', 'zq7', 'code', 'x'].join('/');

commitWith('clean', 'probe');
const cleanBase = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

commitWith('clean', `refactor: move things around`);
const pushClean = (() => {
  try {
    execFileSync('node', [script, '--push', cleanBase, 'HEAD'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return err.status;
  }
})();
console.log(`  ${pushClean === 0 ? 'ok  ' : 'FAIL'} 提交信息干净 → 放行 (exit ${pushClean}, want 0)`);
if (pushClean !== 0) failed = 1;

const base2 = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
commitWith('clean', `docs: note that ${hostPath} works`);
const pushDirty = (() => {
  try {
    execFileSync('node', [script, '--push', base2, 'HEAD'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return err.status;
  }
})();
console.log(`  ${pushDirty === 1 ? 'ok  ' : 'FAIL'} ★ 提交信息里的本机路径必须抓住 (exit ${pushDirty}, want 1)`);
if (pushDirty !== 1) failed = 1;

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('check-secrets 占位符豁免：all passed');
