/**
 * 敏感字段的加密存储（AES-256-GCM）。
 *
 * 为什么需要它：外部系统的登录口令必须能还原成明文才能去登录 ——
 * 这是可逆需求的本质。但「可逆」不等于「明文落盘」：
 * 用户的数据目录可能被备份、同步、误传给别人的，明文口令会跟着流出。
 *
 * 做法：
 *   · 密钥存在**独立文件** `<data>/secret.key`（权限 0600），
 *     只有本机当前用户能读；不和 state.json 放在一起传；
 *   · state.json 里存的是密文串 `enc:v1:<iv>:<tag>:<data>`（全 base64url）；
 *   · 每段密文用独立随机 IV，同一个口令加密两次结果也不同。
 *
 * 边界（必须清楚）：
 *   · 这不是「防止本机其他程序读取」—— 同用户的进程仍能读到密钥文件。
 *     它防的是「数据文件被复制/备份/误传」这类泄漏；
 *   · 密钥丢失 = 密文永久无法还原（要重新填口令），这是设计如此，不提供后门。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 密文前缀，用来识别「已加密」与「历史明文」 */
const PREFIX = 'enc:v1:';

/** 密钥长度（AES-256） */
const KEY_BYTES = 32;

/** IV 长度（GCM 标准 12 字节） */
const IV_BYTES = 12;

/**
 * 读取或创建密钥文件。
 *
 * @param {string} dataDir 数据目录
 * @returns {Buffer} 32 字节密钥
 */
export function loadOrCreateKey(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  try {
    const buf = fs.readFileSync(file);
    if (buf.length === KEY_BYTES) return buf;
    // 长度不对说明文件被改过/损坏：不悄悄覆盖，转成明文迁移会让用户丢数据
    throw new Error(`密钥文件长度异常（${buf.length} 字节，应为 ${KEY_BYTES}）`);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(dataDir, { recursive: true });
  // 先写再改权限：避免文件在创建瞬间是可读的
  fs.writeFileSync(file, key, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，忽略失败
  }
  return key;
}

/**
 * 加密一段文本。
 *
 * @param {string} plain
 * @param {Buffer} key
 * @returns {string} `enc:v1:<iv>:<tag>:<cipher>`（base64url）
 */
export function encrypt(plain, key) {
  const text = String(plain ?? '');
  if (!text) return '';
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
}

/**
 * 解密。格式不对或密钥不匹配时返回空串（不抛错 —— 解不开就当没设）。
 *
 * @param {string} payload
 * @param {Buffer} key
 * @returns {string}
 */
export function decrypt(payload, key) {
  const raw = String(payload ?? '');
  if (!raw) return '';
  if (!raw.startsWith(PREFIX)) return raw; // 历史明文：原样返回，交给上层迁移
  const parts = raw.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return '';
  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const data = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // 密钥换了 / 文件被改：解不开就是解不开，不猜
    return '';
  }
}

/**
 * 这段内容是不是已经加密过。
 * @param {string} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
  return String(value ?? '').startsWith(PREFIX);
}

/**
 * 密钥文件是否已经存在（用于判断"是不是首次运行"）。
 * @param {string} dataDir
 * @returns {boolean}
 */
export function hasKey(dataDir) {
  try {
    return fs.statSync(path.join(dataDir, 'secret.key')).size === KEY_BYTES;
  } catch {
    return false;
  }
}
