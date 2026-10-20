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
import dns from 'node:dns/promises';
import net from 'node:net';

import { proxyFetch, proxyStatus } from './http-client.js';
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
    // ★ 用 proxyFetch 而不是原生 fetch：
    //   用户开了 clash/surge 这类代理（尤其 TUN 模式）时，域名会被解析成
    //   假地址（198.18.x.x），而 Node 的 fetch **不读系统代理**，直连假 IP 必挂。
    //   表现就是“一开代理 agent 就搜不了网了”。proxyFetch 会自动探测
    //   系统/环境变量里的代理并转过去，没代理时行为跟原生 fetch 一致。
    return await proxyFetch(url, {
      ...options,
      signal: ac.signal,
      // 抓页面要逐跳校验，调用方会显式传 manual
      redirect: options.redirect ?? 'follow',
      headers: { 'user-agent': UA, ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 内网拦截（web_fetch 的 SSRF 防护）
// ---------------------------------------------------------------------------

/**
 * 这些地址一律不许 web_fetch 去碰。
 *
 * 为什么必须拦：web_fetch 的输入来自模型 —— 模型读了任何一个被投毒的网页，
 * 就可能被诱导去抓 `http://127.0.0.1:<端口>/api/...`。本机 API 对 loopback
 * 免鉴权，能读到全部聊天记录、模型组和配置；部署到云服务器时
 * `169.254.169.254` 还能拿到实例元数据。这类问题不报错，只是"内容被抓回来了"，
 * 事后很难发现。
 *
 * ★ 198.18.0.0/15 **不拦**：那是 clash/surge TUN 的假 IP 段。本机开着代理时
 *   所有域名都解析到这里，拦了等于把联网功能全废掉。它只是代理的占位地址，
 *   真正的目标域名由代理去解析，不是内网服务。
 */
function isBlockedAddress(addr) {
  const ip = String(addr || '').replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播 / 保留
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return true;
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    // URL 会把 ::ffff:127.0.0.1 规范成 ::ffff:7f00:1 这种十六进制写法
    const mappedHex = low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (/^f[cd]/.test(low)) return true; // 唯一本地地址（内网）
    if (/^fe[89ab]/.test(low)) return true; // link-local
    return false;
  }
  return false;
}

/**
 * 目标必须落在公网才允许抓（域名先解析，逐地址检查）。
 *
 * 解析失败不在这里报错 —— 交给 fetch 报"域名解析不出来"，措辞更准确；
 * 在这里拦反而会让模型以为是权限问题。
 *
 * @param {string|URL} url
 */
export async function assertPublicTarget(url) {
  const u = url instanceof URL ? url : new URL(String(url));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('地址里没有主机名');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`拒绝访问内网地址（${host}）：web_fetch 只能抓公网`);
    }
    return;
  }
  let rows = [];
  try {
    rows = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return;
  }
  for (const row of rows) {
    if (isBlockedAddress(row.address)) {
      throw new Error(
        `拒绝访问：${host} 解析到内网地址（${row.address}）—— web_fetch 不能用来读本机或局域网服务`,
      );
    }
  }
}

const MAX_REDIRECTS = 5;

/**
 * 逐跳校验的抓取。
 *
 * 为什么不能用 `redirect:'follow'`：首跳是公网域名，不等于它 302 去的还是公网。
 * 攻击者只要让首跳返回 `Location: http://127.0.0.1:18787/api/state`，
 * follow 就会替它把内网内容抓回来 —— 首跳校验白做。
 */
async function safeFetch(url, options = {}) {
  let current = url instanceof URL ? url : new URL(String(url));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicTarget(current);
    const res = await fetchWithTimeout(current.toString(), { ...options, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('重定向地址不合法');
      }
      if (!/^https?:$/.test(next.protocol)) {
        throw new Error(`重定向到了不支持的协议：${next.protocol}`);
      }
      current = next;
      continue;
    }
    return { res, url: current };
  }
  throw new Error(`重定向次数过多（超过 ${MAX_REDIRECTS} 次）`);
}

/**
 * 把 fetch 的底层异常翻译成**能指导下一步**的话。
 *
 * 为什么必须翻译：原来失败就抛一句 "fetch failed"，模型只能看到个光秃秃的
 * 错误，于是自己去 curl 一遍遍试 —— 十几步才摸出来"这台机器上那个域名
 * 走了假 IP"。把原因直接说出来，它第一步就知道该换路。
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

  let res;
  let finalUrl = target;
  try {
    const out = await safeFetch(target, { accept: 'text/html,*/*' });
    res = out.res;
    finalUrl = out.url;
  } catch (err) {
    const msg = String(err?.message ?? err);
    // 安全拦截 / 重定向策略要原样说出去：翻成"抓取失败"会让模型以为是网络问题，
    // 然后换个写法继续试内网 —— 那正是要防的事。
    if (/^(拒绝访问|重定向)/.test(msg)) throw err;
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
