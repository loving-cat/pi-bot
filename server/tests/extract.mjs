/**
 * 文件解析自测：造几个样本 + 用真实 PDF/Word 跑一遍。
 *   node tests/extract.mjs
 */
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { extractText } from '../src/extract.js';

const dir = 'D:/pi-bot/server/data';
fs.mkdirSync(dir, { recursive: true });

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ['股票代码', '名称', '市值(亿)', '涨跌幅'],
    ['002920', '德赛西威', 1204.5, '+3.2%'],
    ['600519', '贵州茅台', 18230.0, '-0.8%'],
  ]),
  '持仓',
);
XLSX.writeFile(wb, `${dir}/test.xlsx`);

fs.writeFileSync(`${dir}/test.md`, '# 标题\n\n- 一\n- 二\n\n```js\nconsole.log(1)\n```\n');
fs.writeFileSync(
  `${dir}/test.html`,
  '<html><head><style>body{color:red}</style><script>var a=1</script></head><body><h1>报告</h1><p>第一段</p><ul><li>要点A</li><li>要点B</li></ul><table><tr><td>1</td><td>2</td></tr></table></body></html>',
);
fs.writeFileSync(`${dir}/test.csv`, 'a,b,c\n1,2,3\n4,5,6\n');

const cases = [
  [`${dir}/test.xlsx`, 'Excel'],
  [`${dir}/test.md`, 'Markdown'],
  [`${dir}/test.html`, 'HTML'],
  [`${dir}/test.csv`, 'CSV'],
  ['/home/user/Desktop/Ai_Agent_Eval.pdf', 'PDF'],
  ['/home/user/Desktop/0000000000USER-实验3.docx', 'Word'],
];

for (const [file, label] of cases) {
  const r = await extractText(file, { maxChars: 300 });
  console.log(`\n===== ${label} =====`);
  if (!r.ok) {
    console.log('  ✗', r.error);
    continue;
  }
  console.log(`  ✓ ${r.ext} ${r.chars} 字${r.truncated ? ' (截断)' : ''}`);
  console.log(r.text.split('\n').slice(0, 6).map((l) => `  | ${l.slice(0, 110)}`).join('\n'));
}
