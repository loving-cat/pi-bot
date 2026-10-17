/**
 * 看工作目录"这一轮到底改了什么"。
 *
 * 用户看回复时最想确认的一件事是：它除了说话，有没有动我的文件。
 * 做法：跑之前拍一张快照（路径 → 大小 + mtime），跑完再拍一张，比出
 * 新增 / 修改 / 删除。只记录**工作目录内**的文件，跳过依赖与构建产物。
 *
 * 纯函数 + 有上限的遍历：一轮里出现几千个文件时只报前面一部分并标记 truncated，
 * 不把消息体撑爆，也不让快照把这一轮拖慢。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 不参与对比的目录：依赖、构建产物、版本库内部 */
export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'build',
  'dist',
  '.dart_tool',
  '.gradle',
  '.next',
  '.nuxt',
  'target',
  'coverage',
  '.idea',
  '.cache',
]);

/**
 * 拍快照。
 *
 * @returns {Map<string, {size:number, mtime:number}>} key 是相对 root 的 posix 路径
 */
export function snapshotWorkspace(root, { maxFiles = 6000, maxDepth = 10 } = {}) {
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.size >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不存在 / 没权限：当作空目录
    }
    for (const entry of entries) {
      if (out.size >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      try {
        const st = fs.statSync(full);
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.set(rel, { size: st.size, mtime: st.mtimeMs });
      } catch {
        /* 刚好被删掉：跳过 */
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 对比两次快照。
 *
 * 修改判定：大小变了，或 mtime 变了超过 1ms（文件系统精度不足时留一点容差）。
 *
 * @returns {{
 *   added: Array<{path:string,size:number}>,
 *   modified: Array<{path:string,size:number}>,
 *   removed: Array<{path:string}>,
 *   total: number,
 *   truncated: boolean
 * }}
 */
export function diffSnapshots(before, after, { limit = 50 } = {}) {
  const added = [];
  const modified = [];
  const removed = [];

  if (before && after) {
    for (const [file, info] of after) {
      const prev = before.get(file);
      if (!prev) {
        added.push({ path: file, size: info.size });
        continue;
      }
      const touched = prev.size !== info.size || Math.abs(prev.mtime - info.mtime) > 1;
      // 大小和 mtime 都没变，但时间戳被写过又改回去的极端情况无法识别，接受这个盲区
      if (touched) modified.push({ path: file, size: info.size });
    }
    for (const file of before.keys()) {
      if (!after.has(file)) removed.push({ path: file });
    }
  }

  const total = added.length + modified.length + removed.length;
  const cap = (list) => list.slice(0, limit);
  return {
    added: cap(added),
    modified: cap(modified),
    removed: cap(removed),
    total,
    truncated: added.length > limit || modified.length > limit || removed.length > limit,
  };
}

/** 给消息用的摘要文案数据（不含界面文案，界面自己组） */
export function summarizeChanges(diff) {
  if (!diff || !diff.total) return null;
  return {
    added: diff.added,
    modified: diff.modified,
    removed: diff.removed,
    total: diff.total,
    truncated: diff.truncated,
  };
}
