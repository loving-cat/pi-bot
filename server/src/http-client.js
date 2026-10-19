/**
 * 带代理支持的 HTTP 请求。
 *
 * ## 为什么需要这一层
 *
 * Node 自带的 `fetch`（undici）**不会读系统代理设置**。这跟 curl / 浏览器不同：
 * curl 会看 `http_proxy`，浏览器看系统代理，而 Node 一律直连。
 *
 * 后果在开了代理的机器上非常具体：
 *   · 用户开了 clash / surge 的 **TUN 模式**，域名被解析成一个假地址
 *     （`198.18.0.0/15` 这类保留段），流量本该由 TUN 虚拟网卡劫持后转发。
 *   · 但 TUN 的劫持并不总是覆盖到所有进程（尤其是长驻的 node 服务），
 *     于是直连假地址 → 必然失败。
 *   · 用户看到的现象是「**我一开代理，agent 就搜不了网了**」。
 *
 * 解法：主动探测系统代理（macOS 用 `scutil --proxy`，Windows 读注册表，
 * 另外也看环境变量），探测到就用 `undici` 的 ProxyAgent 把请求转发过去。
 * 走代理时由代理按**域名**重新解析，假 IP 的问题自然消失。
 *
 * ## 几条硬约束
 *
 * 1. **没代理时必须还是直连。** 不能因为加了这层就要求人人都装代理。
 * 2. **本机 / 局域网不走代理。** 用户连自己的服务（127.0.0.1、192.168.x）
 *    绕一圈代理只会变慢甚至失败。
 * 3. **探测失败不能拖垮请求。** 任何一步出错都退化成直连，不要抛。
 * 4. **结果缓存。** `scutil` 是起子进程，每个请求都调一次太浪费。
 */

import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 探测结果缓存多久。用户切换代理开关后，最多等这么久就生效。 */
const PROXY_CACHE_MS = 30_000;

/** 探测超时（起子进程要防它卡住） */
const DETECT_TIMEOUT_MS = 1500;

/** 缓存：{ at, proxy } */
let cache = { at: 0, proxy: null };

/**
 * 本机 / 内网地址不走代理。
 *
 * 除了标准私有网段，还要放过 TUN 的假 IP 段（198.18.0.0/15）——
 * 等等，这里要小心：**假 IP 正是需要走代理的那种**。
 * 如果目标解析出来是 198.18.x.x，说明域名被代理解析了，此时应该走代理
 * 让代理按域名重新拿真实地址。所以 198.18 不放进"直连"名单。
 */
function isDirectHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (host === '127.0.0.1' || /^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith('.local')) return true;
  // 无点的短主机名（内网机器名）
  if (!host.includes('.') && !net.isIP(host)) return true;
  return false;
}

/** 从环境变量里捞代理（最省事，也是最常见的配置方式） */
function proxyFromEnv() {
  const pick = (name) => {
    const v = process.env[name];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  };
  const raw =
    pick('HTTPS_PROXY') ||
    pick('https_proxy') ||
    pick('HTTP_PROXY') ||
    pick('http_proxy') ||
    pick('ALL_PROXY') ||
    pick('all_proxy');
  return normalizeProxyUrl(raw);
}

/** 补全 scheme、去掉尾部斜杠；socks 统一成 socks5 */
function normalizeProxyUrl(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  if (!/^[a-z0-9+.-]+:\/\//i.test(v)) v = `http://${v}`;
  try {
    const u = new URL(v);
    // socks:// 在 undici 里不认，统一成 socks5://
    if (u.protocol === 'socks:') u.protocol = 'socks5:';
    const scheme = u.protocol.replace(':', '');
    if (!['http', 'https', 'socks5', 'socks4'].includes(scheme)) return '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * macOS：`scutil --proxy` 输出的是一段 plist 风格文本。
 * 只取 HTTPS（更通用），没有再退回 HTTP。
 */
async function proxyFromMacos() {
  try {
    const { stdout } = await execFileAsync('scutil', ['--proxy'], {
      timeout: DETECT_TIMEOUT_MS,
    });
    const num = (key) => {
      const m = new RegExp(`\\b${key}\\s*:\\s*(\\d+)`).exec(stdout);
      return m ? Number(m[1]) : 0;
    };
    const str = (key) => {
      const m = new RegExp(`\\b${key}\\s*:\\s*([^\\s]+)`).exec(stdout);
      return m ? m[1].trim() : '';
    };
    // 优先 https，其次 http，最后 socks
    for (const [enableKey, hostKey, portKey, scheme] of [
      ['HTTPSEnable', 'HTTPSProxy', 'HTTPSPort', 'http'],
      ['HTTPEnable', 'HTTPProxy', 'HTTPPort', 'http'],
      ['SOCKSEnable', 'SOCKSProxy', 'SOCKSPort', 'socks5'],
    ]) {
      if (num(enableKey) !== 1) continue;
      const host = str(hostKey);
      const port = num(portKey);
      if (!host || !port) continue;
      return normalizeProxyUrl(`${scheme}://${host}:${port}`);
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Windows：读当前用户的 Internet Settings。
 * 注册表里可能是 `host:port`，也可能是 `http=host:port;https=host:port` 这种按协议分列。
 */
async function proxyFromWindows() {
  try {
    const key =
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const { stdout } = await execFileAsync(
      'reg',
      ['query', key, '/v', 'ProxyEnable'],
      { timeout: DETECT_TIMEOUT_MS },
    );
    if (!/0x1\b/.test(stdout)) return '';
    const { stdout: valueOut } = await execFileAsync(
      'reg',
      ['query', key, '/v', 'ProxyServer'],
      { timeout: DETECT_TIMEOUT_MS },
    );
    const m = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(valueOut);
    const raw = m ? m[1].trim() : '';
    if (!raw) return '';
    // 形如 `http=127.0.0.1:7890;https=127.0.0.1:7890`
    if (raw.includes('=')) {
      const parts = new Map(
        raw
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const i = s.indexOf('=');
            return i > 0 ? [s.slice(0, i).toLowerCase(), s.slice(i + 1)] : ['', ''];
          }),
      );
      const picked = parts.get('https') || parts.get('http') || '';
      return picked ? normalizeProxyUrl(`http://${picked}`) : '';
    }
    return normalizeProxyUrl(`http://${raw}`);
  } catch {
    return '';
  }
}

/**
 * 探测当前系统代理。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] 跳过缓存
 * @returns {Promise<string>} 代理 URL；没有代理返回空串
 */
export async function detectProxy({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - cache.at < PROXY_CACHE_MS) return cache.proxy;

  let proxy = proxyFromEnv();
  if (!proxy) {
    if (process.platform === 'darwin') proxy = await proxyFromMacos();
    else if (process.platform === 'win32') proxy = await proxyFromWindows();
  }
  cache = { at: now, proxy };
  return proxy;
}

/** 手动指定代理（设置里配了就用它，优先于自动探测） */
let overrideProxy = '';

/**
 * 设置固定代理。传空串 = 回到自动探测。
 * @param {string} url
 */
export function setProxyOverride(url) {
  overrideProxy = normalizeProxyUrl(url);
  cache = { at: 0, proxy: null };
}

/** 当前生效的代理（只读，给界面/日志用） */
export async function currentProxy() {
  return overrideProxy || (await detectProxy());
}

/** 清掉探测缓存（用户切了代理开关时调） */
export function resetProxyCache() {
  cache = { at: 0, proxy: null };
}

/** undici 的 ProxyAgent 要按 URL 缓存，别每个请求造一个 */
const agentCache = new Map();

/**
 * TUN 代理的假 IP 段（clash/surge 默认用 198.18.0.0/15）。
 *
 * 命中它说明"域名被本机代理解析成了保留地址"，真实地址得由代理去查。
 * 这种情况下**必须走代理**，直连假 IP 一定挂。
 */
function isFakeIp(hostname) {
  return /^198\.1[89]\./.test(String(hostname ?? ''));
}

async function agentFor(proxyUrl) {
  const key = proxyUrl;
  const hit = agentCache.get(key);
  if (hit) return hit;
  const { ProxyAgent } = await import('undici');
  const agent = new ProxyAgent(proxyUrl);
  agentCache.set(key, agent);
  return agent;
}

/**
 * 带代理的 fetch —— 拿它替换 `globalThis.fetch` 的直接调用。
 *
 * @param {string|URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function proxyFetch(input, init = {}) {
  let hostname = '';
  try {
    hostname = new URL(typeof input === 'string' ? input : input.toString()).hostname;
  } catch {
    // 不是绝对 URL（极少见），直接交给原生 fetch
    return fetch(input, init);
  }

  // 本机/局域网：绝不走代理（绕一圈只会更慢，甚至失败）
  if (isDirectHost(hostname)) return fetch(input, init);

  const proxy = overrideProxy || (await detectProxy());
  const fake = isFakeIp(hostname);

  // 没有代理：只能直连。如果是假 IP，给出能看懂的原因，别让上层猜。
  if (!proxy) {
    if (fake) {
      const err = new Error(
        `${hostname} 被解析成了 ${hostname}（代理的假地址），但这台机器没探测到可用代理 —— ` +
          `服务端直连假地址一定失败。请在设置里填代理地址，或关掉代理后再试。`,
      );
      err.code = 'PROXY_NEEDED';
      throw err;
    }
    return fetch(input, init);
  }

  try {
    const dispatcher = await agentFor(proxy);
    return await fetch(input, { ...init, dispatcher });
  } catch (err) {
    // ★ 假 IP 的站点不能退化成直连 —— 直连假地址 100% 失败，
    //   还会把“代理没生效”伪装成“站点挂了”。直接把原因抛出去。
    if (fake) {
      const e = new Error(
        `${hostname} 解析到假地址（${hostname}），走代理 ${proxy} 仍然失败。` +
          `可能是代理规则把它判成了直连，或者该域名在代理那边也不通。`,
      );
      e.code = 'PROXY_NEEDED';
      throw e;
    }
    // 普通域名：代理本身挂了就退化直连试一次（用户的代理可能是刚关掉）
    try {
      return await fetch(input, init);
    } catch {
      throw err;
    }
  }
}

/** 诊断信息：给"测试连接"和设置页显示 */
export async function proxyStatus() {
  const fromEnv = proxyFromEnv();
  const detected = overrideProxy || (await detectProxy());
  return {
    platform: process.platform,
    source: overrideProxy ? 'manual' : fromEnv ? 'env' : detected ? 'system' : 'none',
    proxy: detected,
    envProxy: fromEnv,
  };
}
