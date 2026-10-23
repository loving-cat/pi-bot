#!/usr/bin/env node
/**
 * 往仓库里扫"不该公开的东西"。
 *
 *   node scripts/check-secrets.mjs          # 扫当前工作区里被跟踪的文件
 *   node scripts/check-secrets.mjs --staged # 只扫暂存区（给 pre-commit 用）
 *
 * ## 为什么要自己写一个
 *
 * 开源仓库最怕的不是写错代码，是**把本机的东西带上去**：API key、私钥、
 * 别人机器上的用户名路径、真实手机号。这些东西一旦进了历史，删文件是删不掉的
 * （`git log -p` 还能翻出来），只能重写历史 —— 那就不只是麻烦了。
 *
 * 这里只做一件事：在合并前拦下来。规则刻意偏保守：宁可让人改个样例值，
 * 也不放过一个 `sk-` 开头的长串。
 *
 * ## 为什么不用 gitleaks
 *
 * 不想为了一个检查引一份二进制/规则集进 CI；这里的规则集很小，改起来直观，
 * 而且可以按本仓库的情况加放行（比如文档里的 `C:\Users\you` 这种占位路径）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const STAGED = process.argv.includes('--staged');

/** 允许出现的"像但是不是"的样例值 */
const ALLOW = [
  // 文档/测试里的通用占位路径
  /C:\\+Users\\+(you|someone|user|runner|runneradmin|public|example|xxx|test)\b/i,
  /\/Users\/(you|someone|user|runner|shared|example|test)\b/i,
  // 明确的样例域名与样例值
  /example\.(com|test|org)/i,
  /fixture[-_]?(credential|secret|password|token)/i,
  /<[^>]*(用户|your|token|key)[^>]*>/i,
];

/** 只报"确定是凭据"的形状；宁可少报也不要把每个 password 字样都算上 */
const RULES = [
  {
    name: '私钥块',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: 'OpenAI/Anthropic 风格 key',
    re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  },
  {
    name: 'undocumented sk_ key',
    re: /\bsk_[A-Za-z0-9]{24,}/,
  },
  {
    name: 'NVIDIA key',
    re: /\bnvapi-[A-Za-z0-9_-]{10,}/,
  },
  {
    name: 'GitHub token',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  },
  {
    name: 'AWS access key',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{30,}/,
  },
  {
    name: 'Slack token',
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: 'Bearer 长串',
    re: /Bearer\s+[A-Za-z0-9._-]{30,}/,
  },
  {
    // 只抓"值看起来就是钥匙"的赋值，且中文字符/占位符/template 不算
    name: '硬编码口令',
    re: /(api[_-]?key|secret|passwd|password|access[_-]?token)\s*[:=]\s*['"`](?![^'"`]*\$[{(])[^'"`\s]{12,}['"`]/i,
  },
  {
    name: '别人的 Windows 用户目录',
    re: /\b[A-Za-z]:\\+Users\\+(?!you\b|someone\b|user\b|runner\b|runneradmin\b|public\b|example\b|xxx\b|test\b|%USERPROFILE%)[A-Za-z][A-Za-z0-9._-]{1,}/i,
  },
  {
    name: '别人的 macOS 用户目录',
    re: /\/Users\/(?!you\b|someone\b|user\b|runner\b|shared\b|example\b|test\b|Shared\b)[A-Za-z][A-Za-z0-9._-]{1,}/,
  },
  {
    name: '别人的 Linux 用户目录',
    re: /\/home\/(?!you\b|someone\b|user\b|runner\b|example\b|test\b|node\b)[A-Za-z][A-Za-z0-9._-]{1,}/,
  },
  {
    name: '开发环境工作目录',
    re: /(?:^|[\s'"`(=])\/(?:workspace\b|opt\/cursor\b|tmp\/node-v\d)/,
  },
  {
    name: '本机主机名 *.local',
    // 只拦像主机名的写法（带连字符，或跟在 @ / // 后面），放行 pi-bot.local 与 relay.local 这类样例值
    re: /(?<![\w.-])(?!(?:pi-bot|relay)\.local\b)(?:[A-Za-z0-9]+-[A-Za-z0-9-]*\.local\b|(?<=[@/])[A-Za-z0-9-]+\.local\b)/,
  },
  {
    name: '云代理链接',
    re: /cursor\.com\/agents\/|\bbc-[0-9a-f]{8}-[0-9a-f]{4}-/i,
  },
  {
    name: 'QQ 邮箱',
    re: /\b[A-Za-z0-9._%+-]+@(?:qq|foxmail|vip\.qq)\.com\b/i,
  },
  {
    name: '真实邮箱',
    re: /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.|pi-bot\.local\b|[A-Za-z0-9.-]+\.(?:test|example|invalid)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/,
  },
];

const MAX_BYTES = 2 * 1024 * 1024;

function trackedFiles() {
  const args = STAGED
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];
  return execFileSync('git', args, { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

function readFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return '';
    const buf = fs.readFileSync(file);
    // 二进制（前 8KB 有 NUL）直接跳过
    if (buf.subarray(0, 8192).includes(0)) return '';
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

const isAllowed = (line) => ALLOW.some((re) => re.test(line));

const hits = [];

function scanText(where, text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000 || isAllowed(line)) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({ file: where, line: i + 1, rule: rule.name, text: line.trim().slice(0, 120) });
        break;
      }
    }
  }
}

/**
 * --meta <base>..<head>：扫这段提交的作者、提交者、提交信息，以及环境变量 PR_BODY。
 * 只扫本次 PR 的提交，不扫历史（旧提交的问题另行处理）。
 */
const metaIdx = process.argv.indexOf('--meta');
if (metaIdx !== -1) {
  const range = process.argv[metaIdx + 1];
  if (range) {
    const SEP = '\u001e';
    const out = execFileSync('git', ['log', '--format=%h%x1f%ae%x1f%ce%x1f%B' + SEP, range], { encoding: 'utf8' });
    const okMail = (m) => /@users\.noreply\.github\.com$/i.test(m) || /^noreply@github\.com$/i.test(m)
      || /@pi-bot\.local$/i.test(m) || /@[A-Za-z0-9.-]+\.(test|example|invalid)$/i.test(m) || /@example\./i.test(m);
    for (const rec of out.split(SEP).map((r) => r.trim()).filter(Boolean)) {
      const [sha, author, committer, body] = rec.split('\u001f');
      for (const [who, mail] of [['作者', author], ['提交者', committer]]) {
        if (!okMail(mail)) hits.push({ file: `commit ${sha}`, line: 0, rule: `${who}邮箱不是 noreply`, text: mail });
      }
      scanText(`commit ${sha} 提交信息`, body);
    }
  }
  if (process.env.PR_BODY) scanText('PR 正文', process.env.PR_BODY);
}

for (const file of (metaIdx !== -1 ? [] : trackedFiles())) {
  // 这个脚本自己里面就有规则示例，别自匹配
  if (file === 'scripts/check-secrets.mjs') continue;
  const text = readFile(file);
  if (!text) continue;
  scanText(file, text);
}

if (!hits.length) {
  console.log(`✓ 敏感信息扫描：${metaIdx !== -1 ? '提交元数据与 PR 正文' : trackedFiles().length + ' 个文件'}，未发现疑似凭据/本机路径`);
  process.exit(0);
}

console.error(`✗ 发现 ${hits.length} 处疑似敏感信息：\n`);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  [${h.rule}]`);
  console.error(`    ${h.text}`);
}
console.error('\n如果确认为误报，请改成一个明显的样例值，或往 ALLOW 里加放行规则。');
process.exit(1);
