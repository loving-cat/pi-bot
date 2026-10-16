/**
 * 文件解析自测：只造自包含的样本，不依赖本机任何私人文件。
 *
 * 想顺便测真实 PDF / Word 的话，用环境变量指路径：
 *   PI_BOT_TEST_PDF=/path/to/any.pdf PI_BOT_TEST_DOCX=/path/to/any.docx node tests/extract.mjs
 *
 *   node tests/extract.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { extractText } from '../src/extract.js';

const dir = path.join(process.cwd(), 'data', '_extract_test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// ---- 造样本 ----
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ['股票代码', '名称', '市值(亿)', '涨跌幅'],
    ['002920', '示例A', 1204.5, '+3.2%'],
    ['600519', '示例B', 18230.0, '-0.8%'],
  ]),
  '持仓',
);
XLSX.writeFile(wb, path.join(dir, 'sample.xlsx'));

fs.writeFileSync(path.join(dir, 'sample.md'), '# 标题\n\n- 一\n- 二\n\n```js\nconsole.log(1)\n```\n');
fs.writeFileSync(
  path.join(dir, 'sample.html'),
  '<html><head><style>body{color:red}</style><script>var a=1</script></head>' +
    '<body><h1>报告</h1><p>第一段</p><ul><li>要点A</li><li>要点B</li></ul>' +
    '<table><tr><td>1</td><td>2</td></tr></table></body></html>',
);
fs.writeFileSync(path.join(dir, 'sample.csv'), 'a,b,c\n1,2,3\n4,5,6\n');
fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify({ hello: 'world', n: 1 }));

const cases = [
  [path.join(dir, 'sample.xlsx'), 'Excel'],
  [path.join(dir, 'sample.md'), 'Markdown'],
  [path.join(dir, 'sample.html'), 'HTML'],
  [path.join(dir, 'sample.csv'), 'CSV'],
  [path.join(dir, 'sample.json'), 'JSON'],
];
if (process.env.PI_BOT_TEST_PDF) cases.push([process.env.PI_BOT_TEST_PDF, 'PDF（外部）']);
if (process.env.PI_BOT_TEST_DOCX) cases.push([process.env.PI_BOT_TEST_DOCX, 'Word（外部）']);

let ok = 0;
for (const [file, label] of cases) {
  const r = await extractText(file, { maxChars: 300 });
  console.log(`\n===== ${label} =====`);
  if (!r.ok) {
    console.log('  ✗', r.error);
    continue;
  }
  ok++;
  console.log(`  ✓ ${r.ext} ${r.chars} 字${r.truncated ? ' (截断)' : ''}`);
  console.log(
    r.text
      .split('\n')
      .slice(0, 6)
      .map((l) => `  | ${l.slice(0, 110)}`)
      .join('\n'),
  );
}
console.log(`\n${ok}/${cases.length} 通过`);
process.exit(ok === cases.length ? 0 : 1);
