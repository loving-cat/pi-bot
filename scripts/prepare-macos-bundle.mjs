/** 签名前整理前端调试信息、验证原生资产，并阻止本机编译路径进入发行包。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MACH_MAGICS = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const BUNDLE_RPATHS = new Set(['@executable_path/../Frameworks', '@loader_path/Frameworks']);

export function isMachO(bytes) {
  return bytes.length >= 4 && MACH_MAGICS.has(bytes.subarray(0, 4).toString('hex'));
}

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** 每个架构分别保留其运行搜索路径；路径内容不用于 shell 拼接。 */
export function parseRpathGroups(text) {
  const groups = [];
  let current = null;
  let inRpath = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\S.*:\s*$/.test(line)) {
      current = [];
      groups.push(current);
      inRpath = false;
    } else if (/^\s*cmd LC_RPATH\s*$/.test(line)) {
      inRpath = true;
      if (!current) { current = []; groups.push(current); }
    } else if (inRpath) {
      const match = line.match(/^\s*path (.*?) \(offset \d+\)\s*$/);
      if (match) { current.push(match[1]); inRpath = false; }
      else if (/^Load command /.test(line)) inRpath = false;
    }
  }
  return groups;
}

/** 只允许移除本机用户目录中的工具链 Swift 回退路径。 */
export function removableRpaths(groups, home) {
  const result = new Set();
  for (const group of groups) {
    const local = group.filter((entry) => path.isAbsolute(entry) && isWithin(home, entry) &&
      /\/Contents\/Developer\/Toolchains\/[^/]+\.xctoolchain\/usr\/lib\/swift\/macosx\/?$/.test(entry));
    if (local.length && (!group.includes('/usr/lib/swift') || !group.some((entry) => BUNDLE_RPATHS.has(entry)))) {
      throw new Error('工具链搜索路径缺少系统或应用内回退，拒绝修改');
    }
    for (const entry of local) result.add(entry);
  }
  return [...result];
}

function bundleFiles(app) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (path.isAbsolute(fs.readlinkSync(target))) throw new Error('应用包包含绝对链接');
        let resolved;
        try { resolved = fs.realpathSync(target); } catch { throw new Error('应用包包含失效链接'); }
        if (!isWithin(app, resolved)) throw new Error('应用包包含指向包外的链接');
      } else if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
      else throw new Error('应用包包含不支持的文件类型');
    }
  }
  visit(app);
  return files;
}

function magic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    const size = fs.readSync(fd, bytes, 0, 4, 0);
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

/** 分块扫描 UTF-8 与 UTF-16 路径，不将命中内容写入诊断。 */
export function containsLocalHome(file, home) {
  if (!path.isAbsolute(home) || home === path.parse(home).root) throw new Error('本机目录设置无效');
  const values = [...new Set([home, encodeURI(home)])];
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

function command(name, args) {
  try { return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }); }
  catch { throw new Error(`无法完成 ${name} 检查或处理`); }
}

/** 将文件型原生资产解析为应用内 Frameworks 文件，拒绝路径越界。 */
export function nativeAssetRequirements(manifest) {
  if (!Array.isArray(manifest?.['format-version']) || manifest['format-version'][0] !== 1) {
    throw new Error('原生资产清单版本不受支持');
  }
  const assets = manifest['native-assets'];
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) throw new Error('原生资产清单格式不正确');
  const result = [];
  for (const [target, entries] of Object.entries(assets)) {
    const architecture = { macos_arm64: 'arm64', macos_x64: 'x86_64' }[target];
    if (!architecture || !entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error('原生资产包含不支持的目标或格式');
    }
    for (const entry of Object.values(entries)) {
      if (!Array.isArray(entry) || entry.length !== 2 || entry[0] !== 'absolute' || typeof entry[1] !== 'string') {
        throw new Error('原生资产加载方式不受支持');
      }
      const file = entry[1];
      if (!file || path.posix.isAbsolute(file) || file.includes('\\') || file.split('/').some((part) => part === '..') || file.includes('\0')) {
        throw new Error('原生资产路径不在应用包内');
      }
      result.push({ architecture, file });
    }
  }
  return result;
}

function validateNativeAssets(app, files, run) {
  let count = 0;
  const architectures = new Map();
  for (const file of files.filter((file) => path.basename(file) === 'NativeAssetsManifest.json' && !file.includes(`${path.sep}Resources${path.sep}server${path.sep}`))) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('原生资产清单无法解析'); }
    for (const requirement of nativeAssetRequirements(manifest)) {
      const target = path.resolve(app, 'Contents/Frameworks', requirement.file);
      if (!isWithin(path.join(app, 'Contents/Frameworks'), target) || !fs.existsSync(target) ||
          !isWithin(app, fs.realpathSync(target)) || !fs.statSync(target).isFile() || !isMachO(magic(target))) {
        throw new Error('原生资产缺失或不是应用内原生库');
      }
      if (!architectures.has(target)) architectures.set(target, run('lipo', ['-archs', target]).trim().split(/\s+/));
      if (!architectures.get(target).includes(requirement.architecture)) throw new Error('原生资产缺少目标架构');
      count++;
    }
  }
  return count;
}

/** 仅修改前端 Mach-O，服务端依赖仅参与路径扫描；成功后仍须重新签名。 */
export function prepareMacosBundle(appPath, { home = os.homedir(), run = command, checkOnly = false } = {}) {
  const app = fs.realpathSync(appPath);
  if (!fs.statSync(app).isDirectory() || !fs.existsSync(path.join(app, 'Contents/Info.plist'))) throw new Error('不是完整应用包');
  const files = bundleFiles(app);
  const server = path.join(app, 'Contents/Resources/server');
  const frontendMachO = files.filter((file) => !isWithin(server, file) && isMachO(magic(file)));
  let removedRpaths = 0;
  if (!checkOnly) {
    for (const file of frontendMachO) {
      run('strip', ['-S', file]);
      const paths = removableRpaths(parseRpathGroups(run('otool', ['-l', file])), home);
      for (const entry of paths) { run('install_name_tool', ['-delete_rpath', entry, file]); removedRpaths++; }
    }
  }
  const nativeAssets = validateNativeAssets(app, files, run);
  const privateFiles = files.filter((file) => containsLocalHome(file, home));
  if (privateFiles.length) throw new Error(`应用包仍有 ${privateFiles.length} 个文件包含本机目录；请重新构建并分离调试信息`);
  return { files: files.length, frontendMachO: frontendMachO.length, removedRpaths, nativeAssets };
}

const entryPath = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const checkOnly = args[0] === '--check-only';
    if (checkOnly) args.shift();
    if (args.length !== 1) throw new Error('用法：node prepare-macos-bundle.mjs [--check-only] <App路径>');
    console.log(JSON.stringify(prepareMacosBundle(args[0], { checkOnly })));
  } catch (error) {
    const message = String(error.message).split(os.homedir()).join('[本机目录]');
    console.error(`应用包检查失败：${message}`); process.exitCode = 1;
  }
}
