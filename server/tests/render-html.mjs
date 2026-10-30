/**
 * 把附件渲染成 HTML 的纯逻辑测试。
 *
 * 重点不是"画得好看"，而是：
 *   · 表格内容一定被转义，不能因为单元格里写了 <script> 就变成标签
 *   · docx 产出的 HTML 一定被清洗掉脚本与事件属性
 *   · 不支持的类型老实报错，不要静默出个空白页
 */
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import {
  canRenderAsHtml, cleanDocxHtml, delimitedToHtml, escapeHtml, htmlRenderKind, sanitizeHtml, sheetToHtml,
} from '../src/render-html.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

test('HTML 转义覆盖五个危险字符', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(123), '123');
});

test('★ 单元格里的 <script> 被转义，不会变成真标签', () => {
  const html = delimitedToHtml('name,note\nA,"<script>alert(1)</script>"', { delimiter: ',' });
  assert.ok(html.includes('&lt;script&gt;'), '应该被转义');
  assert.ok(!html.includes('<script>'), '绝不能出现真的 script 标签');
});

test('★ 单元格里的引号/换行不会打破表格结构', () => {
  const html = delimitedToHtml('a,b\n"x""y",z', { delimiter: ',' });
  assert.ok(html.includes('x&quot;y'), '双引号应转义');
  const tdCount = (html.match(/<td/g) ?? []).length;
  assert.equal(tdCount, 2, `应有 2 个 td，实际 ${tdCount}`);
});

test('CSV 解析：引号内的逗号不算分隔', () => {
  const html = delimitedToHtml('a,b\n"1,2",3', { delimiter: ',' });
  assert.ok(html.includes('1,2'), '引号内的逗号要保留');
});

test('TSV 用自己的分隔符', () => {
  const html = delimitedToHtml('a\tb\n1\t2', { delimiter: '\t' });
  assert.ok(html.includes('<th>a</th>'));
  assert.ok(html.includes('<th>b</th>'));
});

test('表格转 HTML：首行当表头，数字列右对齐', () => {
  // 用 XLSX.utils 造真工作簿，别手搓单元格对象（!ref / t 字段漏了就不认）
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['名称', '数量'], ['甲', 10], ['乙', 20]]),
    'S1',
  );
  const html = sheetToHtml(workbook);
  assert.ok(html.includes('<th>名称</th>'));
  assert.ok(html.includes('<th>数量</th>'));
  assert.ok(html.includes('class="num"'), '数字列应右对齐');
});

test('空工作表给出明确提示，不是一片空白', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), '空表');
  const html = sheetToHtml(workbook);
  assert.ok(html.includes('这张工作表是空的'));
});

test('★ 行数超限时明确写出"只显示前 N 行"', () => {
  const rows = [['h']];
  for (let i = 0; i < 50; i++) rows.push([`v${i}`]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'S');
  const html = sheetToHtml(workbook, { maxRows: 10 });
  assert.ok(html.includes('只显示前 10 行'), '必须告诉用户被截断了');
});

test('★ 清洗：script/iframe/on* 属性全部剥掉', () => {
  const dirty =
    '<p onclick="evil()">ok</p><script>steal()</script>' +
    '<iframe src="http://x"></iframe><a href="javascript:bad()">a</a>' +
    '<img src=x onerror="evil()">';
  const clean = sanitizeHtml(dirty);
  assert.ok(!/onclick/i.test(clean), 'onclick 应被去掉');
  assert.ok(!/onerror/i.test(clean), 'onerror 应被去掉');
  assert.ok(!/javascript:/i.test(clean), 'javascript: 应被去掉');
  assert.ok(!/<script/i.test(clean), 'script 应被去掉');
  assert.ok(!/<iframe/i.test(clean), 'iframe 应被去掉');
  assert.ok(clean.includes('ok'), '正常内容要保留');
});

test('清洗不会误删正常标签', () => {
  const clean = sanitizeHtml('<h1>标题</h1><table><tr><td>1</td></tr></table>');
  assert.ok(clean.includes('<h1>'));
  assert.ok(clean.includes('<table>'));
});

// ★ PITFALLS.md 第 5 条：mammoth 默认把 Word 图片内联成 base64，
//   一张 PNG 就几千字符，正文会被图淹没。必须换成占位。
test('★ docx 图片不内联 base64（规范第 5 条）', () => {
  const dirty = '<p>正文</p><img src="data:image/png;base64,AAAABBBBCCCC">';
  const clean = cleanDocxHtml(dirty);
  assert.ok(!clean.includes('base64'), '不该留 base64');
  assert.ok(clean.includes('正文'), '正文要保留');
});

test('★ 超大图片被压成占位，页面体积不会爆炸', () => {
  const huge = '<img src="data:image/png;base64,' + 'A'.repeat(50000) + '">';
  const clean = cleanDocxHtml(huge);
  assert.ok(clean.length < 100, `应压成占位，实际 ${clean.length} 字符`);
});

test('空 src 的 img 被去掉，正常图片保留', () => {
  assert.ok(!cleanDocxHtml('<img src="">').includes('<img'), '空 src 应去掉');
  assert.ok(
    cleanDocxHtml('<img src="https://x/y.png">').includes('<img'),
    '正常图片不该误删',
  );
});

test('哪些格式能渲染成网页：集中的白名单', () => {
  for (const ext of ['.xlsx', '.xls', '.csv', '.tsv', '.docx']) {
    assert.ok(htmlRenderKind(ext), `${ext} 应该支持`);
    assert.equal(canRenderAsHtml(`/tmp/a${ext}`), true);
  }
  // ★ PDF 刻意不在这里：交给 webview 内核自带的阅读器渲染真版式，
  //   抽文字拼 HTML 会把表格/字号/图全丢掉。
  assert.equal(htmlRenderKind('.pdf'), null);
  assert.equal(canRenderAsHtml('/tmp/a.pdf'), false);
  for (const ext of ['.zip', '.exe', '.mp4', '.png', '.doc']) {
    assert.ok(!htmlRenderKind(ext), `${ext} 不该被当成可渲染`);
    assert.equal(canRenderAsHtml(`/tmp/a${ext}`), false);
  }
  // 大小写不敏感
  assert.ok(htmlRenderKind('.XLSX'));
});

console.log(`\n${passed}/${passed} 通过`);
