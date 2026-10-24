/**
 * 跑完之后把**产物**直接发到群里。
 *
 * 图片由 image-watch.js 自动带上；导出的表格 / PDF / 报表也在这里直接发出来，
 * 不需要再去工作目录里翻找。
 *
 * 三条约束，都是防"把消息撑爆"：
 *   · 只认**交付物**的扩展名（表格、文档、PDF、压缩包…），源码不算；
 *   · 只认这一轮**新增或改过**的文件（快照差异），不把整个工作目录端上来；
 *   · 单文件 ≤10MB、最多 5 个、合计 ≤25MB，超了就跳过并在日志里说一声。
 *
 * 图片不在这里处理（image-watch.js 已经会把新图带上），避免重复附件。
 */
import fs from 'node:fs';
import path from 'node:path';

import { diffSnapshots, snapshotWorkspace } from './change-watch.js';

/** 算"交付物"的扩展名。源码（.py/.js/.ts/.dart…）不算 —— 那是 changed_files 的事。 */
export const ARTIFACT_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|tsv|md|txt|rtf|html?|json|zip|tar|gz|7z|rar)$/i;

/** 这些目录里的东西不是产出（用户投进来的输入、临时目录） */
const SKIP_PREFIX = ['_inbox/', '.scratch/', 'tmp/', 'temp/'];

export const ARTIFACT_LIMITS = {
  maxFiles: 5,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
};

/**
 * 找出这一轮产出的交付物。
 *
 * @param {string} root 工作目录
 * @param {Map<string,{size:number,mtime:number}>} before 跑之前的快照
 * @param {object} [opts]
 * @returns {Array<{file:string, rel:string, size:number}>} 新的在前
 */
export function collectArtifacts(root, before, opts = {}) {
  const { maxFiles, maxFileBytes, maxTotalBytes } = { ...ARTIFACT_LIMITS, ...opts };
  if (!before) return [];

  let diff;
  try {
    diff = diffSnapshots(before, snapshotWorkspace(root));
  } catch {
    return [];
  }

  const candidates = [...diff.added, ...diff.modified]
    .filter((f) => ARTIFACT_EXT.test(f.path))
    .filter((f) => !SKIP_PREFIX.some((prefix) => f.path.startsWith(prefix)))
    .filter((f) => f.size > 0 && f.size <= maxFileBytes);

  // 新的在前：同一轮里最后写出来的通常才是最终版
  const withTime = [];
  for (const f of candidates) {
    const abs = path.join(root, ...f.path.split('/'));
    try {
      withTime.push({ file: abs, rel: f.path, size: f.size, mtime: fs.statSync(abs).mtimeMs });
    } catch {
      // 刚被删了 / 没权限：跳过
    }
  }
  withTime.sort((a, b) => b.mtime - a.mtime);

  const out = [];
  let total = 0;
  for (const item of withTime) {
    if (out.length >= maxFiles) break;
    if (total + item.size > maxTotalBytes) continue;
    total += item.size;
    out.push({ file: item.file, rel: item.rel, size: item.size });
  }
  return out;
}
