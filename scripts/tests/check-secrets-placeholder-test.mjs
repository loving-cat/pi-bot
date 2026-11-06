import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 验证占位符豁免不会把真 key 一起放行。
// 这是最危险的回归方向：宁可漏报几个假 key，也不能让真 key 混过去。

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ph-'));
const repo = tmp;
execFileSync('git', ['init', '-q', repo]);
const script = '/Users/alex/code/pi-bot-macos-current/scripts/check-secrets.mjs';

function commitWith(content, message) {
  const f = path.join(repo, 'probe.txt');
  fs.writeFileSync(f, content);
  execFileSync('git', ['-C', repo, 'add', 'probe.txt']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=probe',
    '-c', 'user.email=1+someone@users.noreply.github.com',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

function run() {
  try {
    execFileSync('node', [script], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return err.status;
  }
}

const cases = [
  // [内容, 期望退出码, 说明]
  ['key = "sk-1234567890abcdef"', 0, '连续数字占位符 → 放行'],
  ['key = "sk-abcdefabcdefaaaa"', 0, 'abcdef 顺序串 → 放行'],
  ['key = "sk-aaaaaaaaaaaaaaaa"', 0, '同字符重复 → 放行'],
  ['key = "sk-1234567890123456"', 0, '全数字 → 放行'],
  // 真 key 形状必须照抓
  ['key = "sk-KRK2MgT0RnyuDxOcOonqkHUl8sbzf9VC6MLEfrFJEcLDcTGy"', 1, '★ 真 key 必须抓住'],
  ['key = "sk-proj-Xb7Kq2mNp9Rt4Vw1Zs8Yh3Lj6Gf5Dc0Ab2Ei7Hn"', 1, '★ 另一种真 key 必须抓住'],
  ['key = "sk-Zm9Xq4Lp7Rt2Vw8Yn5Kj3Hf6Dc1Ab0Ei9Gu7Ox"', 1, '★ 短一点的真 key 也必须抓住'],
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
