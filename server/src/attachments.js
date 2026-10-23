/**
 * 附件（图片/文件）存取。
 *
 * 文件落在 data/uploads/<id><ext>，元信息索引在 data/uploads.json。
 * 手机上传的图、bot 用 send_image 发出来的图，都走这里。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJsonAtomic, log } from './util.js';

const DIR = path.join(config.dataDir, 'uploads');
const INDEX = path.join(config.dataDir, 'uploads.json');

fs.mkdirSync(DIR, { recursive: true });

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
};

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
  'application/zip': '.zip',
  'video/mp4': '.mp4',
};

let index = readJson(INDEX, {}) ?? {};

function persist() {
  writeJsonAtomic(INDEX, index);
}

export function kindFor(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

function normalizeMime(name, mime) {
  if (mime && mime !== 'application/octet-stream') return mime;
  const ext = path.extname(name || '').toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** 存一段二进制 */
export function saveBuffer(buffer, { name = 'file', mime = null } = {}) {
  const type = normalizeMime(name, mime);
  const id = crypto.randomBytes(9).toString('hex');
  const ext = EXT_BY_MIME[type] ?? path.extname(String(name || ''));
  const file = path.join(DIR, id + ext);
  fs.writeFileSync(file, buffer);
  const meta = {
    id,
    name: String(name || 'file').slice(0, 200),
    mime: type,
    kind: kindFor(type),
    size: buffer.length,
    ext,
    createdAt: Date.now(),
  };
  index[id] = meta;
  persist();
  return meta;
}

/**
 * 把一个**已经在磁盘上**的文件收进来（分片上传合并后走这条）。
 *
 * 与 saveBuffer 的区别：不把内容读进内存 —— 500MB 的文件用 readFileSync 会直接
 * 顶到峰值内存。这里先算 id/扩展名，再 rename（跨盘则 copy+unlink）。
 */
export function saveMovedFile(sourcePath, { name = 'file', mime = null } = {}) {
  if (!fs.existsSync(sourcePath)) throw new Error(`文件不存在：${sourcePath}`);
  const type = normalizeMime(name, mime);
  const id = crypto.randomBytes(9).toString('hex');
  const ext = EXT_BY_MIME[type] ?? path.extname(name || '') ?? '';
  const file = path.join(DIR, id + ext);
  try {
    fs.renameSync(sourcePath, file);
  } catch {
    fs.copyFileSync(sourcePath, file);
    try {
      fs.unlinkSync(sourcePath);
    } catch {}
  }
  const stat = fs.statSync(file);
  const meta = {
    id,
    name: String(name || 'file').slice(0, 200),
    mime: type,
    kind: kindFor(type),
    size: stat.size,
    ext,
    createdAt: Date.now(),
  };
  index[id] = meta;
  persist();
  return meta;
}

/** 把工作目录里的文件收进来（bot 发图用） */
export function saveFromPath(filePath, { name = null, mime = null } = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
  const buffer = fs.readFileSync(filePath);
  const base = name ?? path.basename(filePath);
  return saveBuffer(buffer, {
    name: base,
    mime: mime ?? MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null,
  });
}

export function metaFor(id) {
  return index[id] ?? null;
}

export function pathFor(id) {
  const meta = index[id];
  if (!meta) return null;
  const file = path.join(DIR, id + (meta.ext ?? ''));
  return fs.existsSync(file) ? file : null;
}

/** 把附件复制进工作目录的 _inbox/，让 bot 能直接按路径读到 */
export function inboxPath(id) {
  const meta = index[id];
  const src = pathFor(id);
  if (!meta || !src) return null;
  const dir = path.join(config.workspace, '_inbox');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(meta.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-100);
  const target = path.join(dir, `${id.slice(0, 6)}_${safe}`);
  try {
    if (!fs.existsSync(target)) fs.copyFileSync(src, target);
    return target;
  } catch (err) {
    log('复制附件到 _inbox 失败：', err?.message || err);
    return null;
  }
}

export function readForModel(id) {
  const file = pathFor(id);
  if (!file) return null;
  const meta = index[id];
  if (!meta || !meta.mime.startsWith('image/')) return null;
  return { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: meta.mime };
}

/**
 * 按年龄删附件。
 *
 * ⚠ 故意没有任何定时器调它：附件以元信息的形式存在消息里，老聊天记录还在引用它们。
 *   按年龄自动删，老消息里的图片和文件就全打不开了 —— 那是在删用户看得见的数据。
 *   真要做清理，应该只删「没有任何消息引用」的附件（需要扫 rooms/），而不是按年龄。
 *   复审（docs/REVIEW-v1.1.0.md 的 P2）建议过「挂定时器」，这是不采纳的原因。
 */
export function pruneOld(maxAgeMs = 30 * 24 * 3600 * 1000) {
  let n = 0;
  for (const [id, meta] of Object.entries(index)) {
    if (Date.now() - meta.createdAt < maxAgeMs) continue;
    const file = pathFor(id);
    try {
      if (file) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    delete index[id];
    n++;
  }
  if (n) {
    persist();
    log(`清理了 ${n} 个过期附件`);
  }
}
