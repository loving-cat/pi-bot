/**
 * 出站 SSRF 拦截。用户或模型能影响的 URL，都先过 assertPublicTarget。
 *
 * scope（不传按 untrusted）：
 *   user-config  用户自己填的地址（模型组 / MCP 测试、站点探测·登录·探活、更新检查）。
 *                允许本机和局域网，只拦 169.254.0.0/16、IPv6 链路本地、
 *                内嵌映射进该段的地址，以及 metadata.google.internal 这类主机名。
 *   untrusted    模型可控的 URL（web_fetch、搜索抓取、query_site 实际请求）。
 *                回环、私网、链路本地、元数据、ULA、映射地址一律拒绝。
 * 重定向的每一跳都改按 untrusted，同主机跳转也不再沿用 user-config。
 *
 * 直连只用校验当时的地址，避免查完再解析一次被换成内网（rebinding）。
 * 「直连」包括开着系统代理、但主机本来就不走代理的情况（本机 / 局域网 / 短主机名）。
 * 解析失败或超时直接报「域名解析失败」，不再交给系统解析器重查。
 * 真正走 HTTP 代理时目标由代理解析，这里钉不住那一次查询。
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { currentProxy, isDirectHost, proxyFetch } from './http-client.js';

const MAX_REDIRECTS = 5;
const DNS_TIMEOUT_MS = 2_000;

/**
 * 这些地址一律不许服务端代为访问。
 *
 * 198.18.0.0/15 不拦：clash/surge TUN 的假 IP。拦了等于把开代理的联网功能废掉。
 */
function isBlockedIpv4(ip) {
  const [a, b] = String(ip).split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地，含 169.254.169.254 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT，含部分云元数据
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

/** 十进制 / 八进制 / 十六进制 / 缩写 IPv4。URL 已规范成点分时走不到这里。 */
function altIpv4(host) {
  if (!host || host.includes(':') || host.length > 64) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const part of parts) {
    const n = parseIpv4Part(part);
    if (n == null) return null;
    nums.push(n);
  }
  let value = 0n;
  for (let i = 0; i < nums.length; i++) {
    const n = BigInt(nums[i]);
    const remain = 4 - i;
    if (i === nums.length - 1) {
      const max = 1n << BigInt(remain * 8);
      if (n >= max) return null;
      value = (value << BigInt(remain * 8)) + n;
    } else if (n > 255n) {
      return null;
    } else {
      value = (value << 8n) + n;
    }
  }
  if (value > 0xffffffffn) return null;
  return [
    Number((value >> 24n) & 255n),
    Number((value >> 16n) & 255n),
    Number((value >> 8n) & 255n),
    Number(value & 255n),
  ].join('.');
}

function parseIpv4Part(part) {
  if (!part) return null;
  let text = part;
  let base = 10;
  if (/^0x/i.test(text)) {
    base = 16;
    text = text.slice(2);
    if (!/^[0-9a-f]+$/i.test(text)) return null;
  } else if (text.length > 1 && text.startsWith('0')) {
    base = 8;
    if (!/^[0-7]+$/.test(text)) return null;
  } else if (!/^[0-9]+$/.test(text)) {
    return null;
  }
  const n = Number.parseInt(text, base);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function expandIpv6(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  if (!s.includes(':')) return null;
  const v4 = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const parts = v4[2].split('.').map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    s = `${v4[1]}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

function ipv4FromGroups(hi, lo) {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** IPv4 映射、NAT64、6to4、兼容地址里嵌着的 IPv4。没有则返回空串。 */
function embeddedIpv4(groups) {
  const [a, b, c, d, e, f, g, h] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return ipv4FromGroups(g, h);
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return ipv4FromGroups(g, h);
  if (a === 0x2002) return ipv4FromGroups(b, c);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) {
    if (g === 0 && (h === 0 || h === 1)) return '';
    return ipv4FromGroups(g, h);
  }
  return '';
}

function normalizeScope(scope) {
  return scope === 'user-config' ? 'user-config' : 'untrusted';
}

function isMetadataIpv4(ip) {
  const [a, b] = String(ip).split('.').map(Number);
  return a === 169 && b === 254;
}

/** 云元数据主机名。两种 scope 都在解析前拒绝。 */
function isMetadataHostname(host) {
  const h = String(host || '').replace(/\.+$/, '').toLowerCase();
  if (!h || net.isIP(h) || altIpv4(h)) return false;
  if (h === 'metadata' || h === 'metadata.google.internal' || h === 'metadata.goog') return true;
  return h.endsWith('.metadata.google.internal') || h.endsWith('.metadata.goog');
}

/** user-config 只拦元数据段和 IPv6 链路本地（含嵌进 169.254/16 的写法）。 */
function isMetadataAddress(addr) {
  const raw = String(addr || '').replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = net.isIPv4(raw) ? raw : altIpv4(raw);
  if (v4 && net.isIPv4(v4)) return isMetadataIpv4(v4);
  if (!net.isIPv6(raw)) return false;
  const groups = expandIpv6(raw);
  if (!groups) return false;
  const embedded = embeddedIpv4(groups);
  if (embedded && isMetadataIpv4(embedded)) return true;
  return (groups[0] & 0xffc0) === 0xfe80;
}

function isBlockedForScope(addr, scope) {
  if (scope === 'user-config') return isMetadataAddress(addr);
  return isBlockedAddress(addr);
}

function blockedTargetError(scope, address, host) {
  if (scope === 'user-config') {
    const raw = String(address || '').split('%')[0];
    const groups = net.isIPv6(raw) ? expandIpv6(raw) : null;
    const embedded = groups ? embeddedIpv4(groups) : '';
    const linkLocal = groups && !embedded && (groups[0] & 0xffc0) === 0xfe80;
    const kind = linkLocal ? '链路本地地址' : '元数据地址';
    return host
      ? new Error(`拒绝访问：${host} 解析到${kind}（${address}）`)
      : new Error(`拒绝访问${kind}（${address}）`);
  }
  return host
    ? new Error(`拒绝访问：${host} 解析到内网地址（${address}）`)
    : new Error(`拒绝访问内网地址（${address}）`);
}

function isBlockedAddress(addr) {
  const raw = String(addr || '').replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = net.isIPv4(raw) ? raw : altIpv4(raw);
  if (v4 && net.isIPv4(v4)) return isBlockedIpv4(v4);
  if (!net.isIPv6(raw)) return false;
  const groups = expandIpv6(raw);
  if (!groups) return false;
  if (groups.every((n) => n === 0)) return true; // ::
  if (groups.slice(0, 7).every((n) => n === 0) && groups[7] === 1) return true; // ::1
  const embedded = embeddedIpv4(groups);
  if (embedded) return isBlockedIpv4(embedded);
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // 链路本地 fe80::/10
  if ((groups[0] & 0xff00) === 0xff00) return true; // 组播
  return false;
}

function canonicalIp(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIP(h)) return { address: h, family: net.isIP(h) };
  const v4 = altIpv4(h);
  if (v4) return { address: v4, family: 4 };
  return null;
}

async function resolveAll(host, lookup) {
  const resolve = lookup ?? dns.lookup;
  let timer;
  try {
    const rows = await Promise.race([
      Promise.resolve(resolve(host, { all: true, verbatim: true })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS);
      }),
    ]);
    const list = asAddressList(rows);
    // 空结果和超时一样：不能留空让后面的连接再走系统解析器
    if (!list.length) throw new Error(`域名解析失败（${host}）`);
    return list;
  } catch (err) {
    if (String(err?.message || '').startsWith('域名解析失败')) throw err;
    throw new Error(`域名解析失败（${host}）`);
  } finally {
    clearTimeout(timer);
  }
}

function asAddressList(rows) {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const out = [];
  for (const row of list) {
    if (typeof row === 'string') {
      const family = net.isIP(row);
      if (family) out.push({ address: row, family });
      continue;
    }
    const address = row?.address;
    if (!address) continue;
    const family = row.family === 6 || net.isIP(address) === 6 ? 6 : 4;
    out.push({ address, family });
  }
  return out;
}

/**
 * 按 scope 检查目标。域名会解析出全部地址，有一个被当前 scope 拒绝就失败。
 * 解析不出地址时直接抛「域名解析失败」，不把空列表交给连接层。
 *
 * @param {string|URL} url
 * @param {{lookup?: Function, scope?: 'user-config'|'untrusted'}} [opts]
 * @returns {Promise<{url: URL, addresses: {address: string, family: number}[]}>}
 */
export async function assertPublicTarget(url, { lookup, scope } = {}) {
  const mode = normalizeScope(scope);
  const u = url instanceof URL ? url : new URL(String(url));
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只支持 http/https，收到的是 ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('地址里没有主机名');
  if (isMetadataHostname(host)) throw new Error(`拒绝访问元数据主机（${host}）`);
  const literal = canonicalIp(host);
  if (literal) {
    if (isBlockedForScope(literal.address, mode)) throw blockedTargetError(mode, literal.address);
    return { url: u, addresses: [literal] };
  }
  const rows = await resolveAll(host, lookup);
  for (const row of rows) {
    if (isBlockedForScope(row.address, mode)) throw blockedTargetError(mode, row.address, host);
  }
  return { url: u, addresses: rows };
}

function pinnedLookup(addresses) {
  const list = addresses.map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));
  return (_hostname, options, cb) => {
    const done = typeof options === 'function' ? options : cb;
    const opts = typeof options === 'function' ? {} : (options ?? {});
    let chosen = list;
    if (opts.family === 4 || opts.family === 6) {
      const filtered = list.filter((a) => a.family === opts.family);
      if (filtered.length) chosen = filtered;
    }
    if (opts.all) done(null, chosen);
    else done(null, chosen[0].address, chosen[0].family);
  };
}

function headerMap(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return { ...headers };
}

function hasHeader(headers, name) {
  const want = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === want);
}

function dropSensitive(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function linkTimeout(signal, timeoutMs) {
  if (!timeoutMs) return { signal, cancel() {} };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时')), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason instanceof Error ? signal.reason : new Error('超时'));
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason instanceof Error ? signal.reason : new Error('超时'));
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ac.signal,
    cancel() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    },
  };
}

function nodeRequest(urlString, init, addresses) {
  const u = new URL(urlString);
  const lib = u.protocol === 'https:' ? https : http;
  const headers = headerMap(init.headers);
  if (!hasHeader(headers, 'accept-encoding')) headers['accept-encoding'] = 'identity';
  let body = init.body;
  if (body != null && body !== '') {
    const buf = Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body));
    if (!hasHeader(headers, 'content-length')) headers['content-length'] = String(buf.length);
    body = buf;
  } else {
    body = null;
  }
  if (!addresses?.length) {
    return Promise.reject(new Error(`域名解析失败（${u.hostname}）`));
  }
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || undefined,
    method: init.method || 'GET',
    path: `${u.pathname}${u.search}` || '/',
    headers,
    // 无代理时只连校验过的 IP，不再让系统解析器重查
    lookup: pinnedLookup(addresses),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err || '连接失败')));
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const h = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value == null) continue;
          const items = Array.isArray(value) ? value : [value];
          for (const item of items) {
            try {
              h.append(key, String(item));
            } catch {
              // set-cookie 等 forbidden header 不影响拦截判断
            }
          }
        }
        succeed(new Response(buf, { status: res.statusCode || 502, headers: h }));
      });
    });
    const signal = init.signal;
    if (signal) {
      const onAbort = () => {
        const reason = signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' });
        req.destroy(reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function dispatch(url, init, addresses, fetchImpl) {
  const target = url.toString();
  if (typeof fetchImpl === 'function') {
    return fetchImpl(target, { ...init, redirect: 'manual' });
  }
  // 本机 / 局域网 / 短主机名本来就不走代理。以前开着代理时也把它们交给 proxyFetch，
  // 而那边对这类主机是裸 fetch —— 按域名再解析一次，刚校验过的地址就白钉了，
  // 第二次解析可以被换成回环（DNS rebinding）。直连一律只连校验时拿到的地址。
  if (!isDirectHost(url.hostname)) {
    const proxy = await currentProxy();
    if (proxy) return proxyFetch(target, { ...init, redirect: 'manual' });
  }
  return nodeRequest(target, init, addresses);
}

/**
 * 逐跳校验后再连接。禁止自动跟随重定向：第一跳用调用方的 scope，
 * 之后每一跳（含同主机、含 user-config 跨主机）都按 untrusted。
 *
 * @param {string|URL} input
 * @param {object} [init]
 * @param {{fetchImpl?: Function, lookup?: Function, timeoutMs?: number, maxRedirects?: number, scope?: 'user-config'|'untrusted'}} [deps]
 */
export async function publicFetch(input, init = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? init.fetchImpl;
  const lookup = deps.lookup ?? init.lookup;
  const timeoutMs = deps.timeoutMs ?? init.timeoutMs ?? 0;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const scope = normalizeScope(deps.scope ?? init.scope);
  const {
    timeoutMs: _timeout,
    fetchImpl: _fetchImpl,
    lookup: _lookup,
    maxRedirects: _max,
    scope: _scope,
    ...rest
  } = init;

  let current = input instanceof URL ? new URL(input.href) : new URL(String(input));
  let headers = headerMap(rest.headers);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const hopScope = hop === 0 ? scope : 'untrusted';
    const checked = await assertPublicTarget(current, { lookup, scope: hopScope });
    const linked = linkTimeout(rest.signal, timeoutMs);
    try {
      const res = await dispatch(
        current,
        { ...rest, headers, signal: linked.signal },
        checked.addresses,
        fetchImpl,
      );
      const location = res.headers?.get?.('location');
      if (res.status >= 300 && res.status < 400 && location) {
        let next;
        try {
          next = new URL(location, current);
        } catch {
          throw new Error('重定向地址不合法');
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error(`重定向到了不支持的协议：${next.protocol}`);
        }
        if (typeof res.arrayBuffer === 'function') await res.arrayBuffer().catch(() => {});
        else if (typeof res.text === 'function') await res.text().catch(() => {});
        if (next.origin !== current.origin) headers = dropSensitive(headers);
        current = next;
        continue;
      }
      return { res, url: current };
    } finally {
      linked.cancel();
    }
  }
  throw new Error(`重定向次数过多（超过 ${maxRedirects} 次）`);
}
