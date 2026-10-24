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
 * 三条硬约束：
 *   1. 一切都要有超时和大小上限 —— 网络是最容易把整个 agent 卡死的地方。
 *   2. 抓不到就**老实说抓不到**，绝不能编。模型拿不到内容时最爱圆一个答案出来。
 *   3. 正文要截断。一个网页塞进上下文，几千 token 就没了。
 */
import * as cheerio from 'cheerio';

import { proxyStatus } from './http-client.js';
import { config } from './config.js';
import { publicFetch } from './net-guard.js';

export { assertPublicTarget } from './net-guard.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 抓页面的默认超时（毫秒） */
const FETCH_TIMEOUT_MS = Number(process.env.PI_BOT_WEB_TIMEOUT_MS || 15_000);
/** 单个页面拿回来的正文上限（字符）。再长就截断，剩下的让模型自己再抓一次。 */
const MAX_TEXT_CHARS = Number(process.env.PI_BOT_WEB_MAX_CHARS || 8000);
/** 下载上限（字节），防止有人甩个大文件过来把内存吃光 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * 搜索用的抓取。web_fetch 自己调 publicFetch，同样逐跳校验。
 * 没代理时直连并钉住已解析地址；开了代理则交给 proxyFetch。
 */
async function fetchWithTimeout(url, options = {}) {
  const { res } = await publicFetch(
    url,
    {
      ...options,
      headers: { 'user-agent': UA, ...(options.headers || {}) },
    },
    {
      fetchImpl: options.fetchImpl,
      lookup: options.lookup,
      timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
      scope: 'untrusted', // 搜索抓取：查询词和结果链接都可能被模型影响
    },
  );
  return res;
}

/**
 * 把 fetch 的底层异常翻译成**能指导下一步**的话。
 *
 * 为什么必须翻译：只抛一句 "fetch failed"，模型只能看到个光秃秃的错误，
 * 于是自己去 curl 一遍遍试，而失败可能是本机那个域名走了假 IP。
 * 把原因直接说出来，它第一步就知道该换路。
 *
 * 常见成因（按实际遇到过的排序）：
 *   · ENOTFOUND       域名根本没解析
 *   · 198.18.0.0/15   TUN 代理的假 IP 段 —— Node 的 fetch 不走系统代理，直连假 IP 必挂
 *   · ECONNREFUSED    端口没人听
 *   · 证书错误        中间人 / 代理没装根证书
 *
 * @param {Error} err
 * @param {string} url
 * @returns {string} 一句人话
 */
function explainFetchError(err, url) {
  const msg = String(err?.message ?? err);
  const cause = err?.cause;
  const code = String(cause?.code ?? err?.code ?? '');
  const host = (() => {
    try { return new URL(url).hostname; } catch { return url; }
  })();

  if (/超时|timeout/i.test(msg) || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `${host} 连接超时（${Math.round(FETCH_TIMEOUT_MS / 1000)} 秒没响应）—— 站点慢、或网络不通、或需要代理`;
  }
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(msg)) {
    return `${host} 域名解析不出来 —— 域名写错了，或者这台机器的 DNS 有问题`;
  }
  if (code === 'ECONNREFUSED') {
    return `${host} 拒绝连接 —— 端口没开，或者服务没起`;
  }
  if (/CERT|SSL|TLS|self.signed/i.test(code) || /certificate/i.test(msg)) {
    return `${host} 证书验证失败 —— 可能有中间人代理，或站点证书过期`;
  }
  // TUN 假 IP：Node 的 fetch 不走系统代理，直连 198.18.x.x 必然失败。
  // 这是本机装了 clash/surge 这类 TUN 模式代理时的典型现象。
  if (/198\.18\./.test(msg) || /EHOSTUNREACH/.test(code)) {
    return (
      `${host} 连不上。注意：这台机器上它可能被代理解析成了假地址（198.18.x.x），` +
      `而服务端进程不走系统代理 —— 要么换一个能直连的地址，要么在系统层把域名映射到真实 IP`
    );
  }
  return `${host} 抓取失败：${msg.slice(0, 160)}`;
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
export async function webFetch(url, { maxChars = MAX_TEXT_CHARS, fetchImpl, lookup, timeoutMs } = {}) {
  let target;
  try {
    target = new URL(String(url || '').trim());
  } catch {
    throw new Error(`不是合法的网址：${url}`);
  }
  if (!/^https?:$/.test(target.protocol)) {
    throw new Error(`只支持 http/https，收到的是 ${target.protocol}`);
  }

  let res;
  let finalUrl = target;
  try {
    const out = await publicFetch(
      target,
      { headers: { 'user-agent': UA, accept: 'text/html,*/*' } },
      { fetchImpl, lookup, timeoutMs: timeoutMs ?? FETCH_TIMEOUT_MS, scope: 'untrusted' },
    );
    res = out.res;
    finalUrl = out.url;
  } catch (err) {
    const msg = String(err?.message ?? err);
    // 安全拦截 / 重定向策略要原样说出去：翻成"抓取失败"会让模型以为是网络问题，
    // 然后换个写法继续试内网 —— 那正是要防的事。
    if (/^(拒绝访问|重定向|域名解析失败)/.test(msg)) throw err;
    // 把底层异常翻成人话 —— 模型据此换路，而不是自己去 curl 十几遍
    throw new Error(explainFetchError(err, target.toString()));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());

  const type = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await readCapped(res);
  const pageUrl = finalUrl.toString();

  if (type.includes('json')) {
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
    return { url: pageUrl, title: '', text, truncated: raw.length > maxChars, contentType: type };
  }
  if (!type.includes('html') && !type.includes('xml')) {
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
    return { url: pageUrl, title: '', text, truncated: raw.length > maxChars, contentType: type };
  }

  const { text, truncated } = readable(raw, { maxChars });
  const title = titleOf(raw);

  // ★ 正文为空不是错误，但要**说清楚原因**。
  //
  //   现代 SPA（React/Vue）的 HTML 骨架里几乎没有文字，内容全靠 JS 渲染。
  //   直接回一个空 text，模型会以为"这个页面是空的"或者"抓取坏了"，
  //   然后跑去用 curl 反复试 —— 试多少次都一样，因为 curl 也不执行 JS。
  //   所以这里明确告诉它：拿到了页面、但没有正文，要么换接口，要么别在这上面耗。
  if (!text.trim()) {
    return {
      url: pageUrl,
      title,
      text:
        `（这个页面没有可读正文：HTML 只有骨架，内容由 JavaScript 在浏览器里渲染。\n` +
        `标题：${title || '(无)'}\n` +
        `如果它是 SPA 系统，找它的 JSON 接口（通常以 /api/ 开头）直接抓，` +
        `不要用 curl 反复试首页 —— 不执行 JS 的话试多少次都是这个结果。）`,
      truncated: false,
      contentType: type,
      empty: true,
    };
  }
  return { url: pageUrl, title, text, truncated, contentType: type };
}

export const webLimits = { MAX_TEXT_CHARS, FETCH_TIMEOUT_MS };

/** 给界面/日志看的代理状态 */
export { proxyStatus };
