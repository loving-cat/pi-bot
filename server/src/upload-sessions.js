/**
 * 分片上传：大文件不再一次性塞进内存。
 *
 * 流程：init 拿 uploadId → 按 offset 逐片写 → complete 合并（可校验 sha256）。
 * 单片上限 4MB，整文件上限 500MB；中断的会话 24 小时后清掉。
 *
 * 只负责"收片 + 合并"，落地成附件由调用方（attachments.saveBuffer）做。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from './util.js';

export const CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const STALE_MS = 24 * 3600 * 1000;

export class UploadSessions {
  constructor({ dir }) {
    this.dir = dir;
    this.sessions = new Map();
    fs.mkdirSync(dir, { recursive: true });
    this.#sweep();
  }

  #sweep() {
    try {
      const at = Date.now();
      for (const name of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, name);
        try {
          const st = fs.statSync(full);
          if (at - st.mtimeMs > STALE_MS) fs.rmSync(full, { recursive: true, force: true });
        } catch {}
      }
    } catch {}
  }

  /** 开一个上传会话；size 超出上限直接拒绝 */
  init({ name = 'file', size = 0, mime = '' } = {}) {
    const total = Number(size);
    if (!Number.isFinite(total) || total <= 0) {
      return { error: '文件大小不对' };
    }
    if (total > MAX_UPLOAD_BYTES) {
      return { error: `文件太大，上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB` };
    }
    const id = newId('up_');
    const file = path.join(this.dir, `${id}.part`);
    fs.writeFileSync(file, Buffer.alloc(0));
    this.sessions.set(id, {
      id,
      file,
      name: String(name || 'file').slice(0, 200),
      mime: String(mime || '').slice(0, 200),
      size: total,
      received: 0,
      createdAt: Date.now(),
    });
    return { uploadId: id, chunkSize: CHUNK_SIZE };
  }

  /**
   * 写一片。必须按顺序（offset === 已收字节数），避免乱序拼错。
   */
  writeChunk(id, offset, buffer) {
    const s = this.sessions.get(id);
    if (!s) return { error: '上传会话不存在或已过期' };
    const at = Number(offset);
    if (at !== s.received) {
      return { error: `分片顺序不对：应该在 ${s.received}，收到 ${at}` };
    }
    if (buffer.length === 0) return { error: '空分片' };
    if (s.received + buffer.length > s.size) {
      return { error: '收到超过声明大小的数据' };
    }
    try {
      const fd = fs.openSync(s.file, 'r+');
      try {
        fs.writeSync(fd, buffer, 0, buffer.length, s.received);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { error: `写分片失败：${err?.message || err}` };
    }
    s.received += buffer.length;
    return { received: s.received, size: s.size };
  }

  /**
   * 合并完成；sha256 给了就校验。
   *
   * 不把文件读进内存：只做 stat + 流式算 hash，然后把**临时文件路径**交回去，
   * 由调用方用 saveMovedFile 直接 rename 进附件目录（500MB 也不会顶内存）。
   */
  async complete(id, { sha256 = '' } = {}) {
    const s = this.sessions.get(id);
    if (!s) return { error: '上传会话不存在或已过期' };
    if (s.received !== s.size) {
      return { error: `还差 ${s.size - s.received} 字节没传完` };
    }
    if (sha256) {
      const actual = await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(s.file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
      }).catch((err) => ({ error: `校验失败：${err?.message || err}` }));
      if (actual && actual.error) return actual;
      if (actual !== String(sha256).toLowerCase()) {
        this.abort(id);
        return { error: '校验失败：内容与 sha256 不一致，已丢弃' };
      }
    }
    // 会话记录先摘掉（临时文件保留给调用方取走）
    this.sessions.delete(id);
    return { filePath: s.file, name: s.name, mime: s.mime, size: s.size };
  }

  abort(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    try {
      fs.rmSync(s.file, { force: true });
    } catch {}
    return true;
  }
}
