/**
 * 局域网发现：让手机端的「连接」变成"看到附近有哪些电脑"，而不是手抄 IP。
 *
 * ## 为什么是 UDP 广播而不是 mDNS
 *
 * mDNS 要多一个 npm 依赖（bonjour/bonsoir 之类），而两边做的事一样：
 * 局域网里喊一声、主机应答。这里是自家 App 对自家服务端，协议就那么四个字段，
 * 自己发自己答反而更好排查 —— 抓包能直接看到 JSON。
 *
 * ## 安全边界
 *
 * 应答里**只有**配对页本来就公开展示的东西：名字、版本、地址、还需不需要配对码。
 * 配对码本身绝不出现（它在终端里，只给看得到这台电脑的人）。
 * 手机拿到地址之后仍然要输 6 位配对码才能进来 —— 发现不等于授权。
 *
 * 只回 IPv4 局域网地址；没网的机器（只有 127.0.0.1）就回环不出去，等于不响。
 */
import dgram from 'node:dgram';

import { config } from './config.js';
import { lanAddresses } from './pairing.js';
import { VERSION } from './version.js';
import { log } from './util.js';

/** 手机发这个，主机才应答（随便一个 UDP 包都回会让端口扫描器一眼认出来）。 */
export const PROBE_TYPE = 'pibot.discover';

/** 主机应答的类型。带版本号，以后协议要变时不至于把老 App 喂坏。 */
export const ANNOUNCE_TYPE = 'pibot.host';

export const PROTOCOL_VERSION = 1;

/** 同一个来源 500ms 内只回一次：手机上连点"重新搜索"不该把主机打个半死。 */
const REPLY_THROTTLE_MS = 500;

/**
 * 只对**局域网来源**应答。
 *
 * 应答里虽然只有名字/地址这种公开信息，但"这台机器装着 pi-bot"本身也是信息：
 * 从公网打进来的探针（端口映射、云主机的 0.0.0.0 绑定）不该得到确认。
 * 回环也放行 —— 本机自检/测试走的就是它。
 */
export function isLanSource(address) {
  const ip = String(address ?? '').replace(/^::ffff:/i, '');
  if (!ip) return false;
  if (ip === '::1') return true;
  const parts = ip.split('.');
  if (parts.length !== 4) {
    // IPv6：只认链路本地 fe80::/10 与唯一本地 fc00::/7
    const lower = ip.toLowerCase();
    return lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  const [a, b] = parts.map((n) => Number(n));
  if (!Number.isFinite(a)) return false;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** 手机该看到的这台主机的样子。 */
export function buildAnnouncement(overrides = {}) {
  const port = overrides.port ?? config.port;
  // TLS 开着的话，手机该连的是加密那条腿：地址给 https，并把证书指纹一起带上，
  // 客户端第一次就用它固定证书（自签证书没有 CA 可查，只能这样）。
  const tls = overrides.tls === undefined ? null : overrides.tls;
  const urls = lanAddresses().map(({ address }) =>
    tls?.port ? `https://${address}:${tls.port}` : `http://${address}:${port}`,
  );
  return {
    t: ANNOUNCE_TYPE,
    v: PROTOCOL_VERSION,
    /** 用户给这台主机起的名字（PI_BOT_NAME） */
    name: overrides.name ?? config.serverName,
    /** 机器名 —— 同一个 Wi-Fi 下有两台 pi-bot 时，靠它区分 */
    hostname: overrides.hostname ?? config.hostname,
    version: overrides.version ?? VERSION,
    port,
    urls,
    /** false 表示这台主机用固定 token，没有配对码可填 */
    pairing: overrides.pairing ?? true,
    /** 支持"请求连接"：手机点一下，电脑上弹窗允许（见 pair-requests.js） */
    approve: overrides.approve ?? true,
    /** 加密监听：{port, fingerprint}；null = 这条链路是明文（界面上要提示） */
    tls,
  };
}

/** 严格认探针：不是我们的包就一个字都不回。 */
export function isProbe(buf) {
  if (!buf || buf.length === 0 || buf.length > 512) return false;
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && parsed.t === PROBE_TYPE;
  } catch {
    return false;
  }
}

/**
 * 起发现应答器。
 *
 * 端口占用/无权限都不抛 —— 发现只是"少手输一次地址"，不能因为它起不来就
 * 让整个服务端起不来。真起不来时会打一行日志说明"手机得手动填地址"。
 *
 * @returns {Promise<{port:number, close:()=>Promise<void>}|null>}
 */
export async function startDiscovery({
  port = config.discoveryPort,
  enabled = config.discoveryEnabled,
  announcement = () => buildAnnouncement(),
  logLine = log,
} = {}) {
  if (!enabled) return null;

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const lastReplyAt = new Map();

  socket.on('message', (buf, rinfo) => {
    if (!isProbe(buf)) return;
    if (!isLanSource(rinfo.address)) return;
    const now = Date.now();
    const last = lastReplyAt.get(rinfo.address) ?? 0;
    if (now - last < REPLY_THROTTLE_MS) return;
    lastReplyAt.set(rinfo.address, now);
    // 顺手丢掉过期条目，免得长期运行的机器上这张表无限长
    for (const [key, at] of lastReplyAt) {
      if (now - at > 60_000) lastReplyAt.delete(key);
    }
    let payload;
    try {
      payload = Buffer.from(JSON.stringify(announcement()), 'utf8');
    } catch {
      return;
    }
    socket.send(payload, rinfo.port, rinfo.address, () => {});
  });

  socket.on('error', (err) => {
    logLine(`[discovery] 局域网发现已关闭（${err.message}）—— 手机上需要手动填地址`);
    try {
      socket.close();
    } catch {
      /* 已经关了 */
    }
  });

  const actualPort = await new Promise((resolve) => {
    socket.once('listening', () => resolve(socket.address().port));
    socket.once('error', () => resolve(null));
    socket.bind(port, '0.0.0.0');
  });

  if (!actualPort) return null;

  // 不让它单独撑住进程：服务端关掉时这个 socket 跟着走就行
  socket.unref();

  const safePort = actualPort;
  logLine(
    `[discovery] 局域网发现已开启：UDP ${safePort}（手机在同一 Wi-Fi 下就能看到这台机器）`,
  );

  return {
    port: safePort,
    close: () =>
      new Promise((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}
