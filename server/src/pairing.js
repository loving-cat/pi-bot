/**
 * 配对码 + 二维码。
 *
 * 服务端定期轮换一个 6 位数字，手机扫码或输码换长期 token。
 * 二维码里放的是 JSON：{"v":1,"url":"http://192.168.1.100:8787","code":"482913"}
 * 手机 App 扫到就直接把地址和码填好。
 *
 * 也支持 PI_BOT_TOKEN 固定 token（服务器部署 / 自用免配对）。
 */
import os from 'node:os';
import QRCode from 'qrcode';
import { config } from './config.js';
import { pairingCode } from './util.js';

/** 本机所有可用的局域网地址 */
/**
 * 本机所有非回环 IPv4，**按"手机连得上"的可能性排序**。
 *
 * 为什么必须排序（真事）：开着 VPN 时机器上会多出一张 TUN 网卡
 * （Mihomo / Clash 的 198.18.0.1，属于 benchmark 保留段），
 * 而它往往排在真网卡前面 —— 于是终端打印的二维码和地址是
 * `http://198.18.0.1:8787`，**手机根本连不上**，用户只会觉得"连不上"。
 *
 * 规则：真局域网段优先（192.168 / 10 / 172.16-31），
 * TUN / 保留段排后面（198.18-19、100.64-127 的 CGNAT、169.254 link-local）。
 */
function rank(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 192 && b === 168) return 0; // 家用/公司局域网，最常见
  if (a === 10) return 1; // 大型内网
  if (a === 172 && b >= 16 && b <= 31) return 2; // 内网
  if (a === 198 && (b === 18 || b === 19)) return 90; // VPN TUN（benchmark 段）
  if (a === 100 && b >= 64 && b <= 127) return 91; // CGNAT（有些 VPN 用）
  if (a === 169 && b === 254) return 92; // link-local，连不上
  return 50; // 其他，放中间
}

export function lanAddresses() {
  const out = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address });
    }
  }
  return out.sort((x, y) => rank(x.address) - rank(y.address));
}

/** 手机该填哪个地址：优先局域网 IP，没有就 127.0.0.1 */
export function preferredUrl() {
  const lan = lanAddresses();
  const host = lan[0]?.address ?? '127.0.0.1';
  return `http://${host}:${config.port}`;
}

export class Pairing {
  constructor() {
    this.code = pairingCode();
    this.rotatedAt = Date.now();
    this.expiresAt = this.rotatedAt + config.pairTtlMs;
    this.attempts = 0;
    this.timer = setInterval(() => this.rotate(), 60 * 1000);
    this.timer.unref?.();
  }

  rotate() {
    if (Date.now() < this.expiresAt) return;
    this.code = pairingCode();
    this.rotatedAt = Date.now();
    this.expiresAt = this.rotatedAt + config.pairTtlMs;
    this.attempts = 0;
    this.onRotate?.(this.code);
  }

  verify(input) {
    this.attempts++;
    if (this.attempts > 20) return false;
    if (Date.now() > this.expiresAt) return false;
    return String(input ?? '').trim() === this.code;
  }

  snapshot() {
    return {
      code: this.code,
      expiresAt: this.expiresAt,
      ttlMs: this.expiresAt - Date.now(),
      url: preferredUrl(),
      addresses: lanAddresses().map(({ name, address }) => ({ name, url: `http://${address}:${config.port}` })),
    };
  }

  /** 二维码内容 */
  payload() {
    return JSON.stringify({ v: 1, url: preferredUrl(), code: this.code, name: config.serverName });
  }

  /** 终端里画的二维码（半块字符，UTF-8 终端能正常显示） */
  async ascii() {
    return QRCode.toString(this.payload(), { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
  }

  async svg() {
    return QRCode.toString(this.payload(), { type: 'svg', margin: 1, width: 260 });
  }

  async png() {
    return QRCode.toBuffer(this.payload(), { type: 'png', margin: 1, width: 300 });
  }

  stop() {
    clearInterval(this.timer);
  }
}
