/** 发行树遍历与本机路径扫描。只读文件内容，不改写。 */
import fs from 'node:fs';
import path from 'node:path';

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function listTreeFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (path.isAbsolute(fs.readlinkSync(target))) throw new Error('应用包包含绝对链接');
        let resolved;
        try { resolved = fs.realpathSync(target); } catch { throw new Error('应用包包含失效链接'); }
        if (!isWithin(root, resolved)) throw new Error('应用包包含指向包外的链接');
      } else if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
      else throw new Error('应用包包含不支持的文件类型');
    }
  }
  visit(root);
  return files;
}

/** 分块扫描 UTF-8 与 UTF-16 标记，不将命中内容写入诊断。 */
export function fileContainsMarkers(file, markers) {
  const values = [...new Set(markers.filter((value) => typeof value === 'string' && value.length > 0))];
  if (!values.length) return false;
  const needles = values.flatMap((value) => [Buffer.from(value), Buffer.from(value, 'utf16le')]);
  const overlap = Math.max(...needles.map((value) => value.length)) - 1;
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let tail = Buffer.alloc(0);
  try {
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) return false;
      const content = Buffer.concat([tail, buffer.subarray(0, size)]);
      if (needles.some((needle) => content.includes(needle))) return true;
      tail = content.subarray(Math.max(0, content.length - overlap));
    }
  } finally { fs.closeSync(fd); }
}

/** 与发行包检查共用：只判断本机目录是否出现，不返回命中片段。 */
export function containsLocalHome(file, home) {
  if (!path.isAbsolute(home) || home === path.parse(home).root) throw new Error('本机目录设置无效');
  return fileContainsMarkers(file, [home, encodeURI(home)]);
}

function pathApi(marker) {
  return /^[A-Za-z]:[\\/]/.test(marker) || marker.startsWith('\\\\') ? path.win32 : path;
}

/** 绝对路径的正斜杠、反斜杠和 JSON 转义形式都要能命中。 */
export function markerVariants(marker) {
  const api = pathApi(marker);
  if (typeof marker !== 'string' || !api.isAbsolute(marker)) throw new Error('本机目录设置无效');
  const resolved = api.resolve(marker);
  if (resolved === api.parse(resolved).root) throw new Error('本机目录设置无效');
  const values = new Set([resolved, encodeURI(resolved)]);
  if (api === path.win32) {
    const forward = resolved.replaceAll('\\', '/');
    values.add(forward);
    values.add(encodeURI(forward));
    values.add(resolved.replaceAll('\\', '\\\\'));
  }
  return [...values];
}

const STATE_SEGMENTS = new Set(['.pi', '_inbox']);

/** 目录名与日志文件一并计入；空目录也不会被漏掉。 */
export function findLocalState(root) {
  const hits = [];
  function visit(dir, relative) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { throw new Error('无法读取发行包'); }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const parts = rel.split('/');
      const target = path.join(dir, entry.name);
      if (parts.some((part) => STATE_SEGMENTS.has(part)) || (entry.name === '.env' && parts.length === 2 && parts[0] === 'server')) {
        hits.push(rel);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith('.log')) {
        hits.push(rel);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(target, rel);
    }
  }
  visit(root, '');
  return hits;
}

export function localStateSummary(relativePaths) {
  const kinds = new Set();
  for (const rel of relativePaths) {
    const parts = rel.split(/[\\/]/);
    if (parts.includes('.pi')) kinds.add('.pi');
    if (parts.includes('_inbox')) kinds.add('_inbox');
    if (parts.at(-1) === '.env') kinds.add('server/.env');
    if (parts.at(-1).toLowerCase().endsWith('.log')) kinds.add('log');
  }
  return [...kinds].join(', ');
}
