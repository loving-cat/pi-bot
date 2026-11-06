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

let index = Object.assign(Object.create(null), readJson(INDEX, {}) ?? {});
let deletionRevision = null;

function persist() {
  writeJsonAtomic(INDEX, index);
}

// 删除标记保留，启动时仅完成待清理文件并压缩标记元信息。
try {
  pruneTombstones();
} catch (error) {
  log('整理删除记录失败：', error?.message || error);
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
  const meta = index[id];
  return meta && !meta.deletedAt ? meta : null;
}

export function pathFor(id) {
  const meta = metaFor(id);
  if (!meta) return null;
  const file = path.join(DIR, id + (meta.ext ?? ''));
  return fs.existsSync(file) ? file : null;
}

/** 返回有效附件 ID；单次请求内去重。 */
function validIds(ids = []) {
  return [...new Set(ids.filter((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))];
}

/** 从现有消息中确认缺失附件的引用，避免任意未知 ID 生成永久标记。 */
export function referencedAttachmentIds(messageLists, ids) {
  const wanted = new Set(validIds(ids));
  const found = new Set();
  for (const messages of messageLists) {
    for (const message of messages) {
      for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        const id = typeof attachment === 'string' ? attachment : attachment?.id;
        if (wanted.delete(id)) found.add(id);
      }
      if (!wanted.size) return found;
    }
  }
  return found;
}

/** 已删除记录中尚待移除的文件扩展名；空串代表无扩展名文件。 */
function pendingExtension(meta) {
  if (Object.hasOwn(meta, 'pendingDeleteExt')) return meta.pendingDeleteExt;
  if (Object.hasOwn(meta, 'ext')) return meta.ext ?? '';
  return null;
}

function removePendingFile(id, meta) {
  const ext = pendingExtension(meta);
  if (ext == null) return true;
  const basename = id + String(ext);
  if (path.basename(basename) !== basename || /[\\/]/.test(basename)) return false;
  try {
    fs.unlinkSync(path.join(DIR, basename));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    log('清理附件文件失败：', error?.message || error);
    return false;
  }
}

/** 先一次性持久化删除意图，再清理文件；缺失 ID 须由调用方确认历史引用。 */
export function deleteAttachments(ids, { referencedMissing = new Set() } = {}) {
  const result = { deleted: [], missing: [], failed: [] };
  const next = Object.assign(Object.create(null), index);
  const candidates = [];
  let changed = false;
  for (const id of validIds(ids)) {
    const previous = index[id];
    if (!previous && !referencedMissing.has(id)) {
      result.missing.push(id);
      continue;
    }
    candidates.push(id);
    if (!previous?.deletedAt) {
      next[id] = {
        deletedAt: Date.now() || 1,
        ...(previous ? { pendingDeleteExt: previous.ext ?? '' } : {}),
      };
      changed = true;
    }
  }
  if (changed) {
    writeJsonAtomic(INDEX, next);
    index = next;
    deletionRevision = null;
  }
  const compacted = Object.assign(Object.create(null), index);
  let compactedAny = false;
  for (const id of candidates) {
    if (removePendingFile(id, index[id])) {
      result.deleted.push(id);
      if (Object.keys(index[id]).length !== 1) {
        compacted[id] = { deletedAt: index[id].deletedAt };
        compactedAny = true;
      }
    } else {
      result.failed.push(id);
    }
  }
  if (compactedAny) {
    try {
      writeJsonAtomic(INDEX, compacted);
      index = compacted;
    } catch (error) {
      // 删除意图已经落盘，保留清理指针供重启或再次删除时重试。
      log('压缩附件删除记录失败：', error?.message || error);
    }
  }
  return result;
}

/** 单项删除；markMissing 只供已确认存在历史引用的调用方使用。 */
export function deleteAttachment(id, { markMissing = false } = {}) {
  if (!markMissing && (!index[id] || index[id].deletedAt)) return false;
  try {
    return deleteAttachments([id], {
      referencedMissing: markMissing ? new Set([id]) : new Set(),
    }).deleted.includes(id);
  } catch (error) {
    log('记录附件删除失败：', error?.message || error);
    return false;
  }
}

export function isAttachmentDeleted(id) {
  return typeof id === 'string' && Boolean(index[id]?.deletedAt);
}

/** 有界删除版本包含墓碑数量与摘要，快照不传输墓碑 ID 列表。 */
export function attachmentDeletionRevision() {
  if (deletionRevision == null) {
    const ids = Object.keys(index).filter(isAttachmentDeleted).sort();
    const digest = crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
    deletionRevision = `${ids.length}:${digest}`;
  }
  return deletionRevision;
}

/** 压缩删除标记并重试待清理文件；不按时间或数量丢弃删除事实。 */
export function pruneTombstones() {
  const compacted = Object.assign(Object.create(null), index);
  let count = 0;
  for (const [id, meta] of Object.entries(index)) {
    if (!meta?.deletedAt || !removePendingFile(id, meta)) continue;
    if (Object.keys(meta).length === 1) continue;
    compacted[id] = { deletedAt: meta.deletedAt };
    count++;
  }
  if (count) {
    writeJsonAtomic(INDEX, compacted);
    index = compacted;
  }
  return count;
}

/** 仅过滤明确删除的附件，保留原始消息与未知索引引用。 */
export function withoutDeletedAttachments(message) {
  if (!Array.isArray(message?.attachments)) return message;
  const attachments = message.attachments.filter((a) => !isAttachmentDeleted(typeof a === 'string' ? a : a?.id));
  return attachments.length === message.attachments.length ? message : { ...message, attachments };
}

/** 房间目录名仅保留安全字符；清洗或截断时追加摘要防止名称碰撞。 */
export function inboxScope(roomId) {
  const raw = String(roomId ?? '').trim();
  if (!raw) return '';
  const safe = raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
  if (safe === raw) return safe;
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${safe.slice(0, 55)}_${digest}`;
}
/** 按房间复制附件；空房间回落到根目录，已有历史路径保留；目录划分不作为权限边界。 */
export function inboxPath(id, roomId = '') {
  const meta = index[id];
  const src = pathFor(id);
  if (!meta || !src) return null;
  const scope = inboxScope(roomId);
  // 无房间归属时记录回落路径，便于检查调用方。
  if (!scope) {
    log(`⚠️  附件 ${id} 没有房间归属，落到了 _inbox 根目录（调用方漏传 roomId？）`);
  }
  const dir = scope
    ? path.join(config.workspace, '_inbox', scope)
    : path.join(config.workspace, '_inbox');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(meta.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-100);
  // 文件前缀保留 12 位附件 ID，降低同名文件碰撞概率。
  const target = path.join(dir, `${id.slice(0, 12)}_${safe}`);
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
 */
export function pruneOld(maxAgeMs = 30 * 24 * 3600 * 1000) {
  let n = 0;
  for (const [id, meta] of Object.entries(index)) {
    if (meta.deletedAt) continue;
    if (Date.now() - meta.createdAt < maxAgeMs) continue;
    if (deleteAttachment(id)) n++;
  }
  if (n) {
    persist();
    log(`清理了 ${n} 个过期附件`);
  }
}
