/**
 * 把附件渲染成可直接在浏览器栏里显示的 HTML。
 *
 * 和 `extract.js` 的分工（别混用）：
 *   · extract.js  → 抽纯文本喂给模型（越短越好，表格压成 markdown）
 *   · 本文件      → 生成富 HTML 给人看（保留表格结构、页码、样式）
 *
 * 为什么走 HTML 而不是原生渲染：右侧已经是 webview，把表格/Word 转成 HTML
 * 就能复用同一套渲染与缩放，不用为每种格式各写一套原生 widget。
 *
 * ★ PDF 不在这里：webview 内核自带 PDF 阅读器，直接给它 application/pdf
 * 就能拿到**真版式**（字号、表格、图都在）。抽文字再拼 HTML 会把版式丢掉，
 * 所以 PDF 走 `/api/files/:id` 原文件，走 `htmlRenderKind` 时返回 null。
 *
 * 安全约束：产物只由我们拼，不接受文件里的任意 HTML/脚本。
 *   · 表格：全部走 HTML 转义，单元格内容不会被当标签
 *   · PDF：只取文本，按页分段，不内嵌字体/脚本
 *   · docx：mammoth 产出的 HTML 会先剥掉 script/iframe/on* 属性
 */

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import mammoth from 'mammoth';

/** 能渲染成 HTML 的扩展名 → 用哪种渲染器 */
const RENDERERS = new Map([
  ['.xlsx', 'sheet'],
  ['.xls', 'sheet'],
  ['.xlsm', 'sheet'],
  ['.ods', 'sheet'],
  ['.csv', 'sheet'],
  ['.tsv', 'sheet'],
  ['.docx', 'docx'],
]);

export function htmlRenderKind(ext) {
  return RENDERERS.get(String(ext ?? '').toLowerCase()) ?? null;
}

export function canRenderAsHtml(filePath) {
  return RENDERERS.has(path.extname(filePath).toLowerCase());
}

/** HTML 转义：单元格/文件名一律走这里，绝不让内容变成标签 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 极简的安全清洗：去掉 script/iframe/object 与所有 on* 事件属性、javascript: 链接。 */
export function sanitizeHtml(html) {
  return String(html ?? '')
    .replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*\/?\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(?:"|')?\s*javascript:[^"'\s>]*/gi, '');
}

/**
 * 包一层页面外壳。样式内联（不引外部资源），深浅色跟随系统。
 * 表格用 position: sticky 的表头，长表滚动时还能看见列名。
 */
function pageShell({ title, body, subtitle = '' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 18px 40px;
    font: 13px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    color: #e6e6e6; background: #121212;
  }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
  .sub { font-size: 11px; color: #8a8a8a; margin-bottom: 14px; }
  .sheet { margin-bottom: 26px; }
  .sheet h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: #cfcfcf; }
  .wrap { overflow: auto; max-height: 78vh; border: 1px solid #2a2a2a; border-radius: 8px; }
  table { border-collapse: collapse; font-size: 12px; width: max-content; min-width: 100%; }
  th, td {
    border-right: 1px solid #242424; border-bottom: 1px solid #242424;
    padding: 6px 10px; text-align: left; vertical-align: top;
    max-width: 420px; overflow-wrap: anywhere; white-space: pre-wrap;
  }
  th { position: sticky; top: 0; background: #1d1d1d; font-weight: 600; z-index: 1; }
  tbody tr:nth-child(even) { background: #161616; }
  tbody tr:hover { background: #1f1f1f; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .page { margin-bottom: 22px; }
  .page-tag {
    font-size: 10px; color: #7a7a7a; letter-spacing: .06em;
    margin-bottom: 6px; text-transform: uppercase;
  }
  pre.body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  .more { font-size: 11px; color: #8a8a8a; padding: 6px 2px; }
  .empty { font-size: 12px; color: #8a8a8a; padding: 20px 2px; }
</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ''}
${body}
</body></html>`;
}

/**
 * 表格渲染：每个工作表一张表，首行当表头。
 * 数字列右对齐（能一眼比大小）。
 */
export function sheetToHtml(workbook, { maxRows = 2000, maxCols = 200 } = {}) {
  const blocks = [];
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    });
    if (!rows.length) {
      blocks.push(
        `<div class="sheet"><h2>${escapeHtml(name)}</h2><div class="empty">这张工作表是空的</div></div>`,
      );
      continue;
    }
    const width = Math.min(
      maxCols,
      rows.reduce((m, r) => Math.max(m, r.length), 0),
    );
    const shown = rows.slice(0, maxRows);
    const head = shown[0] ?? [];
    const bodyRows = shown.slice(1);

    const numericCols = new Set();
    for (let c = 0; c < width; c++) {
      let seen = 0;
      let num = 0;
      for (const row of bodyRows.slice(0, 200)) {
        const v = row[c];
        if (v === '' || v == null) continue;
        seen++;
        if (typeof v === 'number' || /^-?[\d,]+(\.\d+)?%?$/.test(String(v).trim())) num++;
      }
      if (seen > 0 && num / seen > 0.7) numericCols.add(c);
    }

    const th = Array.from({ length: width }, (_, c) => `<th>${escapeHtml(head[c] ?? '')}</th>`).join('');
    const trs = bodyRows
      .map((row) => {
        const tds = Array.from({ length: width }, (_, c) => {
          const cls = numericCols.has(c) ? ' class="num"' : '';
          return `<td${cls}>${escapeHtml(row[c] ?? '')}</td>`;
        }).join('');
        return `<tr>${tds}</tr>`;
      })
      .join('');
    const more =
      rows.length > maxRows
        ? `<div class="more">只显示前 ${maxRows} 行，共 ${rows.length} 行；完整内容请下载原文件。</div>`
        : '';
    blocks.push(
      `<div class="sheet"><h2>${escapeHtml(name)} · ${rows.length} 行 × ${width} 列</h2>` +
        `<div class="wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>${more}</div>`,
    );
  }
  return blocks.join('\n');
}

/** CSV/TSV：当单表处理，同样首行表头。 */
export function delimitedToHtml(text, { delimiter = ',', maxRows = 2000 } = {}) {
  const rows = [];
  let cell = '';
  let row = [];
  let quoted = false;
  const pushCell = () => {
    row.push(cell);
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) pushCell();
    else if (ch === '\n') pushRow();
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) pushRow();

  const shown = rows.slice(0, maxRows);
  const width = shown.reduce((m, r) => Math.max(m, r.length), 0);
  const head = shown[0] ?? [];
  const th = Array.from({ length: width }, (_, c) => `<th>${escapeHtml(head[c] ?? '')}</th>`).join('');
  const trs = shown
    .slice(1)
    .map((r) => {
      const tds = Array.from({ length: width }, (_, c) => `<td>${escapeHtml(r[c] ?? '')}</td>`).join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  const more =
    rows.length > maxRows ? `<div class="more">只显示前 ${maxRows} 行，共 ${rows.length} 行。</div>` : '';
  return (
    `<div class="sheet"><h2>${rows.length} 行 × ${width} 列</h2>` +
    `<div class="wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>${more}</div>`
  );
}

/**
 * docx：mammoth 转 HTML，再清洗掉脚本与事件属性。
 *
 * ★ 图片**不内联**成 base64（`PITFALLS.md` 第 5 条）：
 *   一张 PNG 就是几千个字符的 data URI，一篇带图的 Word 会让正文被图淹没，
 *   而且页面体积极大、加载卡顿。这里换成一句占位文字，正文保持可读。
 *   要看原图就用工具栏的「用系统浏览器打开」或下载原文件。
 */
export function cleanDocxHtml(html) {
  return sanitizeHtml(html)
    .replace(/!\[[^\]]*\]\(data:image\/[^)]*\)/g, '[图片]')
    .replace(/data:image\/[A-Za-z+]+;base64,[A-Za-z0-9+/=]+/g, '[图片]')
    .replace(/<img\b[^>]*>/gi, (tag) => (/\bsrc\s*=\s*(?:""|'')/.test(tag) ? '' : tag));
}

export async function docxToHtml(buffer, baseUrl) {
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async () => ({
        src: '',
        alt: '图片',
      })),
    },
  );
  // 清洗逻辑收在 cleanDocxHtml 里（单测覆盖），这里不重复一遍
  const cleaned = cleanDocxHtml(result?.value ?? '');
  return {
    html: pageShell({ title: 'Word 文档', body: `<div class="doc">${cleaned}</div>` }),
    warnings: result?.messages?.length ?? 0,
  };
}

/**
 * 主入口：把文件渲染成 HTML 页面。
 * @returns {Promise<{html:string, kind:string}>}
 */
export async function renderFileAsHtml(filePath, { displayName } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const kind = htmlRenderKind(ext);
  const name = displayName || path.basename(filePath);
  if (!kind) throw new Error(`${ext || '该格式'} 不支持转换成网页查看`);

  if (kind === 'sheet') {
    if (ext === '.csv' || ext === '.tsv') {
      const text = fs.readFileSync(filePath, 'utf8');
      return {
        kind,
        html: pageShell({
          title: name,
          body: delimitedToHtml(text, { delimiter: ext === '.tsv' ? '\t' : ',' }),
        }),
      };
    }
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    return { kind, html: pageShell({ title: name, body: sheetToHtml(workbook) }) };
  }

  if (kind === 'docx') {
    const buffer = fs.readFileSync(filePath);
    const out = await docxToHtml(buffer);
    return { kind, html: out.html.replace('<h1>Word 文档</h1>', `<h1>${escapeHtml(name)}</h1>`) };
  }

  throw new Error('未知的渲染类型');
}
