/**
 * 敏感字段的加密存储（AES-256-GCM）。
 *
 * 为什么需要它：外部系统的登录口令必须能还原成明文才能去登录 ——
 * 这是可逆需求的本质。但「可逆」不等于「明文落盘」：
 * 用户的数据目录可能被备份、同步、误传给别人的，明文口令会跟着流出。
 *
 * 做法：
 *   · 密钥默认在 `<data>/secret.key`（权限 0600），不和数据文件放一起；
 *   · 环境变量 `PI_BOT_SECRET_KEY`（32 字节的 hex 或 base64）若设置则覆盖文件，
 *     此时不读、不写 secret.key；
 *   · 站点口令和模型组 API key 共用这一把密钥；
 *   · 密文串 `enc:v1:<iv>:<tag>:<data>`（全 base64url），每段独立随机 IV。
 *
 * 边界：
 *   · 同用户的其他进程仍能读密钥文件，防的是数据文件被拷走；
 *   · 密钥丢失或换错 = 密文无法还原。解密失败会抛错，调用方不得把空值写回。
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

/** 环境变量名：设置后覆盖 secret.key */
export const SECRET_KEY_ENV = 'PI_BOT_SECRET_KEY';

/** @param {string} dataDir */
export function secretKeyPath(dataDir) {
  return path.join(dataDir, 'secret.key');
}

/**
 * 解析 `PI_BOT_SECRET_KEY`。未设置返回 null；设置了但不是 32 字节则抛错。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Buffer|null}
 */
export function keyFromEnv(env = process.env) {
  const raw = String(env?.[SECRET_KEY_ENV] ?? '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  for (const enc of ['base64', 'base64url']) {
    const buf = Buffer.from(raw, enc);
    if (buf.length === KEY_BYTES) return buf;
  }
  throw new Error(`${SECRET_KEY_ENV} 须为 32 字节（64 位 hex 或 base64）`);
}

/**
 * 读取或创建密钥。环境变量优先于文件。
 *
 * @param {string} dataDir 数据目录
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Buffer} 32 字节密钥
 */
export function loadOrCreateKey(dataDir, env = process.env) {
  const fromEnv = keyFromEnv(env);
  if (fromEnv) return fromEnv;

  const file = secretKeyPath(dataDir);
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

/** 密文解不开。调用方必须中止写入，不能把空字符串存回去。 */
export class SecretDecryptError extends Error {
  constructor(message = '解密失败') {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

/**
 * 解密。
 * 空串仍是空串；没有前缀的历史明文原样返回（交给迁移）。
 * 带 `enc:v1:` 但密钥不对或内容损坏时抛 SecretDecryptError，不返回空串。
 *
 * @param {string} payload
 * @param {Buffer} key
 * @returns {string}
 */
export function decrypt(payload, key) {
  const raw = String(payload ?? '');
  if (!raw) return '';
  if (!raw.startsWith(PREFIX)) return raw;
  const parts = raw.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new SecretDecryptError('解密失败：密文损坏或密钥不对');
  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const data = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof SecretDecryptError) throw err;
    throw new SecretDecryptError('解密失败：密文损坏或密钥不对');
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
    return fs.statSync(secretKeyPath(dataDir)).size === KEY_BYTES;
  } catch {
    return false;
  }
}
