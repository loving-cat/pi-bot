/**
 * 看着工作目录，发现 bot **自己刚生成**的图片。
 *
 * 从 pi-runner.js 搬出来。用途：它画了图 / 导出了表格，下一轮把这些文件
 * 自动作为附件发回给用户 —— 不然用户得自己去目录里翻。
 *
 * 两个注意点（都是踩出来的）：
 *   · 只在工作目录里找，但**跳过**点开头的目录和 node_modules（那是依赖，不是产出）；
 *   · 判断"新"给 5ms 容差 —— 文件系统的毫秒精度不总是可靠，
 *     拿 mtime 做等值比较会漏掉刚刚写出来的文件。
 *
 * 保存动作由外面注入（这里只负责找 + 判断，不碰 store）。
 */
import fs from 'node:fs';
import path from 'node:path';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

/** 扫一遍工作目录，返回 文件绝对路径 → mtime 的 Map */
export function snapshotImages(root, { maxDepth = 4, maxFiles = 400 } = {}) {
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.size > maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不存在 / 没权限：当成"这里没图"，不要让整个流程炸掉
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (IMAGE_EXT.test(entry.name)) {
        try {
          out.set(full, fs.statSync(full).mtimeMs);
        } catch {
          /* 刚好被删了？跳过 */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 和上一次快照比，多了哪些图（返回 [{file, mtime}]，新的在前） */
export function diffImages(root, before, { toleranceMs = 5, limit = 4 } = {}) {
  const after = snapshotImages(root);
  const fresh = [];
  for (const [file, mtime] of after) {
    const prev = before?.get?.(file);
    // 新出现的，或者比上次新了超过容差 —— 后者是"同名覆盖"，也得算新
    if (prev === undefined || mtime > prev + toleranceMs) fresh.push({ file, mtime });
  }
  fresh.sort((a, b) => b.mtime - a.mtime);
  return fresh.slice(0, limit);
}

/**
 * 发现新图并保存成附件（保存动作由调用方注入）。
 * 单张保存失败不影响其它张 —— 报个错就跳过。
 */
export function collectNewImages(root, before, { save, onError = () => {}, limit = 4 } = {}) {
  const out = [];
  for (const item of diffImages(root, before, { limit })) {
    try {
      const meta = save(item.file);
      out.push({
        id: meta.id,
        name: meta.name,
        mime: meta.mime,
        kind: meta.kind,
        size: meta.size,
      });
    } catch (err) {
      onError(err);
    }
  }
  return out;
}
