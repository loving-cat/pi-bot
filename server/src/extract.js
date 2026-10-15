/**
 * 文件正文提取：把 PDF / Excel / Word / HTML / CSV / MD ... 变成模型能读的文本。
 *
 * 用法两处：
 *   1. 用户发文件时，自动提取正文塞进提示词（bot 不用再操作一步）
 *   2. bot 用 extract_file 工具按需读工作目录里的文件
 */
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import { PDFParse } from 'pdf-parse';
import { log } from './util.js';

export const MAX_CHARS = 120_000;

export const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.js', '.ts', '.py', '.sh', '.sql', '.ini', '.env',
]);

export const DOC_EXT = new Set(['.pdf', '.xlsx', '.xls', '.xlsm', '.ods', '.docx', '.doc', '.rtf']);

export const SUPPORTED_EXT = new Set([...TEXT_EXT, ...DOC_EXT]);

export function isSupported(filePath) {
  return SUPPORTED_EXT.has(path.extname(filePath).toLowerCase());
}

function clip(text, maxChars) {
  const trimmed = text.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, maxChars)}\n\n…（正文过长，只取了前 ${maxChars} 字）`, truncated: true };
}

async function extractPdf(file) {
  const buffer = fs.readFileSync(file);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result?.text ?? '';
  } finally {
    await parser.destroy?.().catch(() => {});
  }
}

function extractSheet(file) {
  const workbook = XLSX.readFile(file, { cellDates: true });
  const parts = [];
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '' });
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    parts.push(`### 工作表「${name}」：${rows.length} 行 × ${width} 列`);
    const shown = rows.slice(0, 200).map((row) => {
      const cells = row.slice(0, 30).map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '));
      return `| ${cells.join(' | ')} |`;
    });
    parts.push(shown.join('\n'));
    if (rows.length > 200) parts.push(`…（只显示前 200 行，共 ${rows.length} 行）`);
    parts.push('');
  }
  return parts.join('\n');
}

async function extractDocx(file) {
  let markdown = '';
  try {
    // 不让 mammoth 把图片内联成 base64（一张图几千字，会把正文挤没）
    const result = await mammoth.convertToMarkdown(
      { path: file },
      { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
    );
    markdown = result?.value ?? '';
  } catch {
    const raw = await mammoth.extractRawText({ path: file });
    markdown = raw?.value ?? '';
  }
  // 万一还是内联了，兜底清掉
  return markdown
    .replace(/!\[[^\]]*\]\(data:image\/[^)]*\)/g, '[图片]')
    .replace(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g, '[图片]');
}

function extractHtml(file) {
  const html = fs.readFileSync(file, 'utf8');
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article').each((_, el) => {
    $(el).append('\n');
  });
  return $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function extractCsv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const shown = lines.slice(0, 400);
  if (lines.length > 400) shown.push(`…（只显示前 400 行，共 ${lines.length} 行）`);
  return shown.join('\n');
}

function extractJson(file) {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2);
  } catch {
    return fs.readFileSync(file, 'utf8');
  }
}

/**
 * @returns {Promise<{ok:boolean, text?:string, ext?:string, chars?:number, truncated?:boolean, error?:string}>}
 */
export async function extractText(filePath, { maxChars = MAX_CHARS } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (!fs.existsSync(filePath)) return { ok: false, error: `文件不存在：${filePath}` };
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return { ok: false, error: '这是一个目录，不是文件' };

  let raw = '';
  try {
    switch (ext) {
      case '.pdf':
        raw = await extractPdf(filePath);
        break;
      case '.xlsx':
      case '.xls':
      case '.xlsm':
      case '.ods':
        raw = extractSheet(filePath);
        break;
      case '.docx':
        raw = await extractDocx(filePath);
        break;
      case '.doc':
      case '.rtf':
        return { ok: false, error: `${ext} 是老式二进制格式，解析不了。让用户另存为 .docx 或 .pdf 再发。` };
      case '.html':
      case '.htm':
        raw = extractHtml(filePath);
        break;
      case '.csv':
      case '.tsv':
        raw = extractCsv(filePath);
        break;
      case '.json':
        raw = extractJson(filePath);
        break;
      default:
        raw = fs.readFileSync(filePath, 'utf8');
        break;
    }
  } catch (err) {
    log(`解析 ${path.basename(filePath)} 失败：`, err?.message || err);
    return { ok: false, error: `${ext || '文件'} 解析失败：${err?.message || err}` };
  }

  const { text, truncated } = clip(raw, maxChars);
  if (!text) return { ok: false, error: `${ext} 里没提取到文字（可能是扫描件或空文件）` };
  return { ok: true, text, ext, chars: text.length, truncated };
}

/** 给提示词用的附件正文块 */
export async function attachmentBlock(filePath, displayName) {
  const result = await extractText(filePath);
  if (!result.ok) return `【附件 ${displayName}】解析失败：${result.error}`;
  return [
    `【附件正文：${displayName}（${result.ext}，${result.chars} 字${result.truncated ? '，已截断' : ''}）】`,
    result.text,
    '【附件正文结束】',
  ].join('\n');
}
