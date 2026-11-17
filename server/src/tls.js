/**
 * 自己签一张证书 —— 局域网里没有可信 CA，HTTPS 只能这么来。
 *
 * ## 为什么要手写 ASN.1
 *
 * 用户机器上不一定有 openssl（Windows 默认没有），而服务端启动时要**自动**生成
 * 一张带本机局域网 IP 的证书。所以只能纯 JS 拼 DER：字段就那几个，拼错了
 * `crypto.X509Certificate` 和 `tls.createSecureContext` 会当场报错，能被测住。
 *
 * ## 证书里有什么
 *
 *   · RSA 2048，SHA-256 签名，有效期 10 年；
 *   · SAN（Subject Alternative Name）覆盖：`localhost`、`127.0.0.1`、以及本机
 *     每张网卡的 IPv4 —— 手机是按 `https://<局域网IP>:<端口>` 连的，
 *     没有对应 SAN 的浏览器/客户端会直接拒（Dart 的 HttpClient 也会）。
 *   · 网卡地址变了就**重新签**（SAN 是写死在证书里的）。
 *
 * ## 它证明不了什么
 *
 * 自签证书不证明"这是真的 pi-bot" —— 谁来都能给自己签一张。身份是靠
 * **手机固定指纹 + 6 位校验码人眼比对**（见 docs/ANDROID.md）建立起来的。
 * 这张证书的作用是：让链路有加密、让"固定指纹"有一个稳定的东西可固定。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { lanAddresses } from './pairing.js';

/** 有效期（天）。10 年：换证书意味着手机上存的指纹全要重对一遍。 */
const VALID_DAYS = 3650;

// ---------------------------------------------------------------- DER 拼装

function len(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  for (let n = size; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, inner) => tlv(0xa0 | n, inner);
const int = (value) => {
  const buf = Buffer.isBuffer(value) ? value : null;
  if (buf) return tlv(0x02, buf);
  let hex = BigInt(value).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
};
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const octetString = (buf) => tlv(0x04, buf);
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const ia5 = (text) => tlv(0x16, Buffer.from(text, 'ascii'));
const utcTime = (date) => tlv(0x17, Buffer.from(stamp(date), 'ascii'));
const nullValue = () => tlv(0x05);

function stamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(
    date.getUTCHours(),
  )}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

/** 点分 OID → DER */
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let n = part;
    do {
      chunk.unshift(n & 0x7f);
      n = Math.floor(n / 128);
    } while (n > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const rdn = (oidDotted, value) => set(seq(oid(oidDotted), utf8(value)));
const name = (...rdns) => seq(...rdns);

function extension(oidDotted, value, critical = false) {
  const parts = [oid(oidDotted)];
  if (critical) parts.push(bool(true));
  parts.push(octetString(value));
  return seq(...parts);
}

/** 证书里那张"这张证书可以代表哪些名字"的清单 */
function subjectAltName({ hostnames, ips }) {
  const entries = [
    ...hostnames.map((h) => tlv(0x82, Buffer.from(h, 'ascii'))),
    ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),
  ];
  return seq(...entries);
}

// ---------------------------------------------------------------- 证书

/**
 * 签一张自签证书。
 * @returns {{certPem:string, keyPem:string, certDer:Buffer, fingerprint:string}}
 */
export function createSelfSignedCertificate({ commonName = 'pi-bot', ips = [], days = VALID_DAYS } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const hostnames = ['localhost', 'pi-bot.local'];
  const ipList = Array.from(new Set(['127.0.0.1', ...ips]));

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // 正整数

  const signatureAlg = seq(oid(OID.sha256WithRsa), nullValue());
  const subject = name(
    rdn(OID.organization, 'pi-bot'),
    rdn(OID.commonName, commonName),
  );

  const extensions = seq(
    extension(OID.basicConstraints, seq(), true),
    // digitalSignature + keyEncipherment（后者给 TLS 1.2 的 RSA 密钥交换用）
    extension(OID.keyUsage, bitString(Buffer.from([0xa0]), 5), true),
    extension(OID.extKeyUsage, seq(oid(OID.serverAuth))),
    extension(OID.subjectAltName, subjectAltName({ hostnames, ips: ipList })),
  );

  const tbs = seq(
    explicit(0, int(2)), // v3
    int(serial),
    signatureAlg,
    subject, // issuer == subject（自签）
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    explicit(3, extensions),
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, signatureAlg, bitString(signature));

  const certPem = pem('CERTIFICATE', certDer);
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return {
    certPem,
    keyPem: String(keyPem),
    certDer,
    fingerprint: crypto.createHash('sha256').update(certDer).digest('hex'),
  };
}

function pem(label, der) {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** 证书里现在写着哪些 IP（用来判断网卡变了要不要重签） */
export function certificateIps(certPem) {
  try {
    const parsed = new crypto.X509Certificate(certPem);
    const subjectAltName = parsed.subjectAltName ?? '';
    return subjectAltName
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('IP Address:'))
      .map((part) => part.slice('IP Address:'.length));
  } catch {
    return [];
  }
}

/** 证书指纹（sha256 hex），HTTPS 服务端和 App 固定用同一个值 */
export function fingerprintOf(certPem) {
  const parsed = new crypto.X509Certificate(certPem);
  return crypto.createHash('sha256').update(parsed.raw).digest('hex');
}

/**
 * 读/生成 `<dataDir>/tls/` 下的证书。
 *
 * 网卡 IP 变了就重签：手机连的是 `https://<当前IP>:<端口>`，证书里没有这个 IP
 * 的话客户端会报证书不匹配（Dart 的 HttpClient 不认 SAN 之外的名字）。
 */
export function ensureTlsMaterial({ dir, commonName = 'pi-bot', log = () => {} } = {}) {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const wanted = lanAddresses().map((entry) => entry.address);

  let certPem = null;
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const existing = fs.readFileSync(certPath, 'utf8');
    const covered = new Set(certificateIps(existing));
    const missing = wanted.filter((ip) => !covered.has(ip));
    let expired = false;
    try {
      expired = new Date(new crypto.X509Certificate(existing).validTo).getTime() < Date.now() + 86_400_000;
    } catch {
      expired = true;
    }
    if (missing.length === 0 && !expired) {
      certPem = existing;
    } else {
      log(
        `[tls] 证书需要重签：${expired ? '快过期了' : `缺这些地址 ${missing.join(', ')}`}`,
      );
    }
  }

  if (!certPem) {
    const created = createSelfSignedCertificate({ commonName, ips: wanted });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(certPath, created.certPem, { mode: 0o600 });
    fs.writeFileSync(keyPath, created.keyPem, { mode: 0o600 });
    certPem = created.certPem;
  }

  const keyPem = fs.readFileSync(keyPath, 'utf8');
  return {
    certPem,
    keyPem,
    fingerprint: fingerprintOf(certPem),
    ips: certificateIps(certPem),
  };
}

/** 给 TLS 选项用（https.createServer / wss） */
export function tlsOptions(material) {
  return {
    cert: material.certPem,
    key: material.keyPem,
    // 只留 TLS 1.2+：老 TLS 在局域网里也没有存在价值
    minVersion: 'TLSv1.2',
  };
}

/**
 * 当前进程里的加密监听信息（`{port, fingerprint}`），供 /health、serverInfo 取用。
 *
 * 为什么用模块级变量而不是层层传参：读它的是"描述自己"这种边角接口，
 * 而 tls 的启动发生在 server.listen 回调里 —— 传参得穿透三四个函数。
 */
let active = null;

export function setActiveTls(info) {
  active = info ?? null;
}

export function activeTls() {
  return active;
}
