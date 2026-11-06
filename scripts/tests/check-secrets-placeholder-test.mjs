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
  execFileSync('git', ['-C', tmp, '-c', 'user.name=probe',
    '-c', 'user.email=1+someone@users.noreply.github.com',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
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
  // 真 key 形状必须照抓（运行时拼，源码里不留字面量）
  [`key = "${key('sk-', 'KRK2MgT0RnyuDxOcOonqkHUl8sbzf9VC6MLEfrFJEcLDcTGy')}"`, 1, '★ 真 key 必须抓住'],
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

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('check-secrets 占位符豁免：all passed');
