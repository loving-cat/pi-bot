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
export function lanAddresses() {
  const out = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address });
    }
  }
  return out;
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
