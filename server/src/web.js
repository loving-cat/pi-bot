/**
 * 联网：搜索 + 抓网页。
 *
 * 为什么要在服务端自己实现：pi 的**核心工具里没有联网**，能上网的通常是某个
 * 扩展或 MCP。而 pi-bot 是要给别人用的 —— 不能假设对方装了哪个扩展。
 * 所以这里自带一份，开箱即用。
 *
 * 默认**不需要任何 API key**：走搜索引擎的 HTML 端点。
 * 想更稳/更干净，可以配一个正式接口（见 .env.example）：
 *   PI_BOT_SEARCH_URL   例：https://api.search.brave.com/res/v1/web/search?q={q}
 *   PI_BOT_SEARCH_KEY   配了就带上 Authorization: Bearer
 *
 * 三条硬约束（都是踩过的坑）：
 *   1. 一切都要有超时和大小上限 —— 网络是最容易把整个 agent 卡死的地方。
 *   2. 抓不到就**老实说抓不到**，绝不能编。模型拿不到内容时最爱圆一个答案出来。
 *   3. 正文要截断。一个网页塞进上下文，几千 token 就没了。
 */
import * as cheerio from 'cheerio';
import { config } from './config.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 抓页面的默认超时（毫秒） */
const FETCH_TIMEOUT_MS = Number(process.env.PI_BOT_WEB_TIMEOUT_MS || 15_000);
/** 单个页面拿回来的正文上限（字符）。再长就截断，剩下的让模型自己再抓一次。 */
const MAX_TEXT_CHARS = Number(process.env.PI_BOT_WEB_MAX_CHARS || 8000);
/** 下载上限（字节），防止有人甩个大文件过来把内存吃光 */
const MAX_BYTES = 4 * 1024 * 1024;

/** 带超时的 fetch —— AbortSignal.timeout 在某些 Node 组合上不给力，自己控一次 */
async function fetchWithTimeout(url, options = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时')), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 读响应体，但设上限 */
async function readCapped(res) {
  const buf = await res.arrayBuffer();
  const bytes = Buffer.from(buf);
  if (bytes.length <= MAX_BYTES) return bytes.toString('utf8');
  return bytes.subarray(0, MAX_BYTES).toString('utf8');
}

/** HTML → 可读文本。去掉脚本/样式/导航那些噪音，块级元素之间补换行。 */
export function readable(html, { maxChars = MAX_TEXT_CHARS } = {}) {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg, header, footer, nav, form, aside').remove();

  // 优先抓正文容器；没有就用 body
  const main =
    $('article').first().length
      ? $('article').first()
      : $('main').first().length
        ? $('main').first()
        : $('body');

  main.find('br').replaceWith('\n');
  main.find('p, div, li, h1, h2, h3, h4, h5, h6, tr, pre, blockquote').each((_, el) => {
    $(el).append('\n');
  });

  let text = main.text() || '';
  text = text
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { text, truncated };
}

/** 标题（抓不到就空） */
function titleOf(html) {
  try {
    return cheerio.load(html)('title').first().text().trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** 解析搜索结果里的跳转链接（DDG 会用 /l/?uddg=… 包一层） */
function unwrapUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const inner = u.searchParams.get('uddg');
    return inner ? decodeURIComponent(inner) : u.toString();
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

async function searchConfigured(query, limit) {
  const tpl = config.searchUrl;
  const key = config.searchKey;
  if (!tpl || !key) return null;
  const url = tpl.includes('{q}')
    ? tpl.replace('{q}', encodeURIComponent(query))
    : `${tpl}${tpl.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw new Error(`搜索接口 ${res.status}`);
  const json = await res.json();
  // 常见几种返回形状都认一下（brave / tavily / serper / 自建）
  const rows =
    json.web?.results ?? json.results ?? json.organic ?? json.data ?? [];
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, limit).map((r) => ({
    title: String(r.title ?? r.name ?? '').trim(),
    url: String(r.url ?? r.link ?? '').trim(),
    snippet: String(r.description ?? r.snippet ?? r.content ?? '').trim(),
  }));
}

async function searchDuckDuckGo(query, limit) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const res = await fetchWithTimeout(url.toString(), {
    headers: { referer: 'https://duckduckgo.com/', accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const $ = cheerio.load(await readCapped(res));
  const out = [];
  $('.result, .web-result').each((_, el) => {
    if (out.length >= limit) return;
    const a = $(el).find('a.result__a').first();
    const href = unwrapUrl(a.attr('href') || '');
    if (!href || !/^https?:\/\//.test(href)) return;
    out.push({
      title: a.text().trim(),
      url: href,
      snippet: $(el).find('.result__snippet').first().text().trim(),
    });
  });
  return out;
}

async function searchBing(query, limit) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('setlang', 'zh-Hans');
  const res = await fetchWithTimeout(url.toString(), {
    headers: { referer: 'https://www.bing.com/', accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  const $ = cheerio.load(await readCapped(res));
  const out = [];
  $('li.b_algo').each((_, el) => {
    if (out.length >= limit) return;
    const a = $(el).find('h2 a').first();
    const href = a.attr('href') || '';
    if (!/^https?:\/\//.test(href)) return;
    out.push({
      title: a.text().trim(),
      url: href,
      snippet: $(el).find('.b_caption p, .b_lineclamp2, p').first().text().trim(),
    });
  });
  return out;
}

/**
 * 搜一下。按"配置的接口 → DuckDuckGo → Bing"依次试，前一个失败/空就换下一个 ——
 * 这几个 HTML 端点偶尔会抽风（限流、改版、地区屏蔽），单点不可靠。
 *
 * 全挂了就抛错。**绝不能返回空列表当成功** —— 那模型会以为"网上没有这个事"。
 */
export async function webSearch(query, { limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索词是空的');
  const errors = [];
  for (const [name, fn] of [
    ['配置的搜索接口', searchConfigured],
    ['DuckDuckGo', searchDuckDuckGo],
    ['Bing', searchBing],
  ]) {
    try {
      const rows = await fn(q, limit);
      if (rows && rows.length) return { provider: name, results: rows };
	} catch (err) {
      errors.push(`${name}：${err?.message || err}`);
    }
  }
  throw new Error(`搜索没成功（${errors.join('；') || '所有来源都返回空'}）`);
}

// ---------------------------------------------------------------------------
// 抓页面
// ---------------------------------------------------------------------------

/**
 * 抓一个 URL 的正文。
 *
 * 返回 `{ url, title, text, truncated, contentType }`。
 * 不是 HTML（JSON / 纯文本）就原样给回来 —— 很多 API 直接返回 JSON，
 * 那正是 agent 想要的，别去做"可读化"。
 */
export async function webFetch(url, { maxChars = MAX_TEXT_CHARS } = {}) {
  let target;
  try {
    target = new URL(String(url || '').trim());
  } catch {
    throw new Error(`不是合法的网址：${url}`);
  }
  if (!/^https?:$/.test(target.protocol)) {
    throw new Error(`只支持 http/https，收到的是 ${target.protocol}`);
  }

  const res = await fetchWithTimeout(target.toString(), { accept: 'text/html,*/*' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());

  const type = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await readCapped(res);

  if (type.includes('json')) {
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
    return { url: target.toString(), title: '', text, truncated: raw.length > maxChars, contentType: type };
  }
  if (!type.includes('html') && !type.includes('xml')) {
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
    return { url: target.toString(), title: '', text, truncated: raw.length > maxChars, contentType: type };
  }

  const { text, truncated } = readable(raw, { maxChars });
  return { url: target.toString(), title: titleOf(raw), text, truncated, contentType: type };
}

export const webLimits = { MAX_TEXT_CHARS, FETCH_TIMEOUT_MS };
