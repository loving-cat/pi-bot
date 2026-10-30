/** 发布前整理 Windows 前端调试路径，并拒绝本机路径、符号文件和本机状态。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  fileContainsMarkers, findLocalState, isWithin, listTreeFiles, localStateSummary, markerVariants,
} from './scan-release-tree.mjs';

const CODEVIEW = 2;
const RSDS = 0x53445352;

/** 标准 PE 校验和；校验和字段自身不参与累加。 */
export function computePeChecksum(buffer, checksumOffset) {
  if (!Number.isInteger(checksumOffset) || checksumOffset < 0 || checksumOffset % 2 !== 0) throw new Error('无法读取可执行文件调试信息');
  let sum = 0;
  const length = buffer.length;
  for (let i = 0; i + 1 < length; i += 2) {
    if (i === checksumOffset || i === checksumOffset + 2) continue;
    sum += buffer.readUInt16LE(i);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (length % 2 === 1) {
    sum += buffer[length - 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + length) >>> 0;
}

function rvaToOffset(rva, sections) {
  for (const section of sections) {
    const size = Math.max(section.virtualSize, section.sizeOfRawData);
    if (size > 0 && rva >= section.virtualAddress && rva < section.virtualAddress + size) {
      return section.pointerToRawData + (rva - section.virtualAddress);
    }
  }
  return null;
}

function isAbsoluteDebugPath(text) {
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('//') || text.startsWith('/');
}

function debugBasename(text) {
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || 'symbols.pdb';
}

/**
 * 只改写 CodeView 里的绝对 PDB 路径为文件名。
 * 其它字节保持原样；调用方仍须扫描残留路径，不能靠替换蒙混过关。
 */
export function rewritePeDebugPaths(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return { buffer: input, changed: false, rewritten: 0 };
  const eLfanew = buffer.readUInt32LE(0x3c);
  if (eLfanew <= 0 || eLfanew + 24 > buffer.length) throw new Error('无法读取可执行文件调试信息');
  if (buffer.toString('latin1', eLfanew, eLfanew + 4) !== 'PE\0\0') return { buffer: input, changed: false, rewritten: 0 };
  const coff = eLfanew + 4;
  const sectionCount = buffer.readUInt16LE(coff + 2);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  if (optionalSize < 64 || optional + optionalSize > buffer.length) throw new Error('无法读取可执行文件调试信息');
  const magic = buffer.readUInt16LE(optional);
  const numberOfRvaOffset = magic === 0x20b ? optional + 108 : magic === 0x10b ? optional + 92 : 0;
  if (!numberOfRvaOffset) throw new Error('无法读取可执行文件调试信息');
  const checksumOffset = optional + 64;
  const dataDirOffset = numberOfRvaOffset + 4;
  if (dataDirOffset + 4 > optional + optionalSize) throw new Error('无法读取可执行文件调试信息');
  const dirCount = buffer.readUInt32LE(numberOfRvaOffset);
  if (dirCount <= 6) return { buffer: input, changed: false, rewritten: 0 };
  const debugEntry = dataDirOffset + 6 * 8;
  if (debugEntry + 8 > optional + optionalSize) throw new Error('无法读取可执行文件调试信息');
  const debugRva = buffer.readUInt32LE(debugEntry);
  const debugSize = buffer.readUInt32LE(debugEntry + 4);
  if (!debugRva || !debugSize) return { buffer: input, changed: false, rewritten: 0 };
  const sectionTable = optional + optionalSize;
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const off = sectionTable + i * 40;
    if (off + 40 > buffer.length) throw new Error('无法读取可执行文件调试信息');
    sections.push({
      virtualSize: buffer.readUInt32LE(off + 8),
      virtualAddress: buffer.readUInt32LE(off + 12),
      sizeOfRawData: buffer.readUInt32LE(off + 16),
      pointerToRawData: buffer.readUInt32LE(off + 20),
    });
  }
  const debugOffset = rvaToOffset(debugRva, sections);
  if (debugOffset == null || debugOffset < 0 || debugOffset + debugSize > buffer.length) throw new Error('无法读取可执行文件调试信息');
  let rewritten = 0;
  const count = Math.floor(debugSize / 28);
  for (let i = 0; i < count; i++) {
    const entry = debugOffset + i * 28;
    if (buffer.readUInt32LE(entry + 12) !== CODEVIEW) continue;
    const sizeOfData = buffer.readUInt32LE(entry + 16);
    const address = buffer.readUInt32LE(entry + 20);
    let pointer = buffer.readUInt32LE(entry + 24);
    if (!pointer) pointer = rvaToOffset(address, sections) ?? 0;
    if (!pointer || sizeOfData < 24 || pointer + sizeOfData > buffer.length) throw new Error('无法读取可执行文件调试信息');
    if (buffer.readUInt32LE(pointer) !== RSDS) continue;
    const pathStart = pointer + 24;
    const pathEnd = pointer + sizeOfData;
    let nul = pathStart;
    while (nul < pathEnd && buffer[nul] !== 0) nul++;
    const pathText = buffer.toString('utf8', pathStart, nul);
    if (!isAbsoluteDebugPath(pathText)) continue;
    const baseBytes = Buffer.from(`${debugBasename(pathText)}\0`, 'utf8');
    if (baseBytes.length > pathEnd - pathStart) throw new Error('无法缩短调试路径');
    buffer.fill(0, pathStart, pathEnd);
    baseBytes.copy(buffer, pathStart);
    rewritten++;
  }
  if (!rewritten) return { buffer: input, changed: false, rewritten: 0 };
  buffer.writeUInt32LE(0, checksumOffset);
  buffer.writeUInt32LE(computePeChecksum(buffer, checksumOffset), checksumOffset);
  return { buffer, changed: true, rewritten };
}

/**
 * 构建根路径会以编译期字符串的形式留在产物里（Dart 产物记 .dart_tool 路径，MSVC 把包含目录写进 .rdata），
 * PE 调试路径那套改写法碰不到它们。这里把构建根的各神写法就地换成长度相同的占位串，
 * 让产物不携带本机目录；因为等长替换，任何字节偏移都不会移动。
 *
 * 约束：
 * - 只替换调用方明确给出的构建根，不动其它字节；替换完仍要独立扫描，不靠它蒙混过关。
 * - 占位串沿用绝对路径形状（某些产物可能拿它当 URI/路径解析），但不含盘符目录、不含用户名。
 */
export const BUILD_ROOT_PLACEHOLDER = 'C:\\pi-bot-build\\'; // C:\pi-bot-build\

/** 构建根路径的可能写法：反斜杠、正斜杠、JSON 双写反斜杠。长串先换，避免前缀互盖。 */
export function buildRootNeedles(buildRoot) {
  if (!buildRoot || !isAbsoluteDebugPath(buildRoot)) return [];
  const values = new Set([buildRoot, buildRoot.replaceAll('\\', '/'), buildRoot.replaceAll('\\', '\\\\')]);
  return [...values].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** 等长占位串：基串不够长就截断，够长就用空格补齐，绝不超过原串宽度。 */
function placeholderFor(width) {
  const base = Buffer.from(BUILD_ROOT_PLACEHOLDER, 'utf8');
  if (width <= base.length) return base.subarray(0, width);
  const out = Buffer.alloc(width, 0x20);
  base.copy(out, 0);
  return out;
}

/** 把产物里的构建根路径就地换成等长占位串，返回改写次数。 */
export function rewriteBuildRootPaths(input, buildRoot) {
  const needles = buildRootNeedles(buildRoot);
  if (!needles.length) return { buffer: input, rewritten: 0 };
  const buffer = Buffer.from(input);
  let rewritten = 0;
  for (const needle of needles) {
    const target = Buffer.from(needle, 'utf8');
    if (!target.length) continue;
    const placeholder = placeholderFor(target.length);
    let index = buffer.indexOf(target);
    while (index !== -1) {
      placeholder.copy(buffer, index);
      rewritten++;
      index = buffer.indexOf(target, index + target.length);
    }
  }
  return { buffer, rewritten };
}

function looksLikePe(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(2);
    const size = fs.readSync(fd, bytes, 0, 2, 0);
    return size === 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
  } finally { fs.closeSync(fd); }
}

function realWithin(root, file) {
  if (!root || !fs.existsSync(root)) return false;
  try { return isWithin(fs.realpathSync(root), fs.realpathSync(file)); }
  catch { return false; }
}

function safeRelative(root, file) {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === '..') return '[包内文件]';
  return relative.split(path.sep).join('/');
}

function collectPdbs(root) {
  const found = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(target);
      else if (!entry.isDirectory() && entry.name.toLowerCase().endsWith('.pdb')) found.push(target);
    }
  }
  visit(root);
  return found;
}

const WINDOWS_ASSET_TARGETS = new Set(['windows_x64', 'windows_arm64']);

/** 只接受发行目录内的相对 DLL 路径，不把清单里的原始字符串写进错误。 */
export function windowsNativeAssetFiles(manifest) {
  if (!Array.isArray(manifest?.['format-version']) || manifest['format-version'][0] !== 1) {
    throw new Error('原生资产清单版本不受支持');
  }
  const assets = manifest['native-assets'];
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) throw new Error('原生资产清单格式不正确');
  const result = [];
  for (const [target, entries] of Object.entries(assets)) {
    if (!WINDOWS_ASSET_TARGETS.has(target) || !entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error('原生资产包含不支持的目标或格式');
    }
    for (const entry of Object.values(entries)) {
      if (!Array.isArray(entry) || entry.length !== 2 || entry[0] !== 'absolute' || typeof entry[1] !== 'string') {
        throw new Error('原生资产加载方式不受支持');
      }
      const file = entry[1];
      const parts = file.split(/[\\/]/);
      if (!file || path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || file.includes('\0') ||
          parts.some((part) => part === '' || part === '.' || part === '..')) {
        throw new Error('原生资产路径不在发行包内');
      }
      if (!file.toLowerCase().endsWith('.dll')) throw new Error('原生资产不是 DLL');
      result.push(parts.join('/'));
    }
  }
  return result;
}

function validateWindowsNativeAssets(bundle, files, serverRoot) {
  let count = 0;
  for (const manifestPath of files) {
    if (path.basename(manifestPath) !== 'NativeAssetsManifest.json') continue;
    if (realWithin(serverRoot, manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch { throw new Error('原生资产清单无法解析'); }
    for (const relative of windowsNativeAssetFiles(manifest)) {
      const target = path.resolve(bundle, ...relative.split('/'));
      if (!isWithin(bundle, target) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`原生资产缺失（${safeRelative(bundle, manifestPath)}）`);
      }
      let resolved;
      try { resolved = fs.realpathSync(target); }
      catch { throw new Error(`原生资产缺失（${safeRelative(bundle, manifestPath)}）`); }
      if (!isWithin(bundle, resolved) || !fs.statSync(resolved).isFile()) throw new Error(`原生资产缺失（${safeRelative(bundle, manifestPath)}）`);
      count++;
    }
  }
  return count;
}

/**
 * 只读检查。命中本机目录、调试符号、本机状态或缺失 DLL 时失败，文案不包含具体路径。
 */
export function scanWindowsBundle(bundlePath, {
  home = os.homedir(),
  markers = [],
  serverRelative = 'server',
} = {}) {
  const bundle = fs.realpathSync(bundlePath);
  if (!fs.statSync(bundle).isDirectory()) throw new Error('不是 Windows 发行目录');
  const files = listTreeFiles(bundle);
  const serverRoot = path.join(bundle, serverRelative);
  const state = findLocalState(bundle);
  if (state.length) throw new Error(`发行包仍有本机状态（${localStateSummary(state)}）`);
  const pdbs = collectPdbs(bundle);
  if (pdbs.length) {
    const names = pdbs.map((file) => safeRelative(bundle, file)).join(', ');
    throw new Error(`发行包仍有 ${pdbs.length} 个调试符号文件（${names}）`);
  }
  const variants = [...new Set([home, ...markers].flatMap((marker) => markerVariants(marker)))];
  const leaks = files.filter((file) => fileContainsMarkers(file, variants));
  if (leaks.length) {
    const names = leaks.map((file) => safeRelative(bundle, file)).join(', ');
    throw new Error(`发行包仍有 ${leaks.length} 个文件包含本机路径（${names}）`);
  }
  const nativeAssets = validateWindowsNativeAssets(bundle, files, serverRoot);
  return { files: files.length, nativeAssets };
}

/**
 * 服务端依赖是否装齐。
 *
 * 注意：不能只靠 createRequire().resolve —— 服务端是 ESM（package.json 里 type=module），
 * 而纯 ESM 的包（exports 只有 import 条件）在 CJS 解析下会报 ERR_PACKAGE_PATH_NOT_EXPORTED，
 * 明明能 import 却被判成缺失。所以按包自身的 type 选解析方式：
 * ESM 先把 import.meta.resolve 走过的 exports 条件走一遍，CJS 维持原样。
 */
export function verifyProductionDependencies(serverDir) {
  const pkgPath = path.join(serverDir, 'package.json');
  if (!fs.statSync(pkgPath, { throwIfNoEntry: false })?.isFile()) throw new Error('发行包缺少服务端 package.json');
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
  catch { throw new Error('发行包服务端 package.json 无法解析'); }
  const dependencies = pkg.dependencies ?? {};
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error('服务端依赖声明无效');
  const resolveCjs = createRequire(pathToFileURL(pkgPath)).resolve;
  const isEsm = pkg.type === 'module';
  let missing = 0;
  for (const name of Object.keys(dependencies)) {
    try {
      resolveCjs(name);
    } catch (error) {
      // CJS 解析失败时，ESM 包再看一眼 exports 的 import 条件；仍不行才算缺
      if (!(isEsm && isEsmOnlyResolutionError(error) && resolvesAsEsm(serverDir, name))) missing++;
    }
  }
  if (missing) throw new Error(`服务端依赖未安装完整（${missing}）`);
  return Object.keys(dependencies).length;
}

/** 只有「包在、但 exports 没有给 CJS 用的入口」这种错才允许回退到 ESM 判定。 */
function isEsmOnlyResolutionError(error) {
  return error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || error?.code === 'ERR_REQUIRE_ESM';
}

/** 在服务端目录下按 ESM 规则找一下这个包能不能 import。 */
function resolvesAsEsm(serverDir, name) {
  const entry = path.join(serverDir, 'node_modules', ...name.split('/'), 'package.json');
  if (!fs.statSync(entry, { throwIfNoEntry: false })?.isFile()) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(entry, 'utf8'));
    const exportsField = pkg.exports;
    const main = exportsField && typeof exportsField === 'object' ? exportsField['.'] : null;
    const target = typeof main === 'string' ? main
      : main && typeof main === 'object' ? (main.import ?? main.default ?? main.node ?? null)
      : null;
    if (!target || typeof target !== 'string') return false;
    return fs.statSync(path.join(path.dirname(entry), target), { throwIfNoEntry: false })?.isFile() === true;
  } catch { return false; }
}

/**
 * 前端 PE 缩短调试路径并删除 .pdb；服务端目录与 node.exe 只扫描不改写。
 * 传了 buildRoot 时，再把产物里的构建根路径就地换成占位串（等长替换，不移动字节）。
 * checkOnly 不写文件，残留调试符号、本机路径或本机状态一律失败。
 */
export function prepareWindowsBundle(bundlePath, {
  home = os.homedir(),
  markers = [],
  serverRelative = 'server',
  checkOnly = false,
  verifyDependencies = true,
  buildRoot = null,
} = {}) {
  const bundle = fs.realpathSync(bundlePath);
  if (!fs.statSync(bundle).isDirectory()) throw new Error('不是 Windows 发行目录');
  const files = listTreeFiles(bundle);
  const serverRoot = path.join(bundle, serverRelative);
  let rewrittenDebugPaths = 0;
  let serverPeFiles = 0;
  let removedPdbs = 0;
  let rewrittenBuildRoots = 0;
  if (!checkOnly) {
    for (const file of files) {
      const inServer = realWithin(serverRoot, file);
      if (looksLikePe(file)) {
        if (inServer) { serverPeFiles++; continue; }
        if (path.basename(file).toLowerCase() === 'node.exe') continue;
        const result = rewritePeDebugPaths(fs.readFileSync(file));
        if (result.changed) {
          fs.writeFileSync(file, result.buffer);
          rewrittenDebugPaths += result.rewritten;
        }
      }
      // 构建根路径常以普通字符串留在产物里（ELF 的 Dart 产物、PE 的 .rdata），
      // 调试路径改写碰不到它们；这里对包内所有文件再包一遍。服务端目录也不该带构建根。
      if (buildRoot) {
        const swapped = rewriteBuildRootPaths(fs.readFileSync(file), buildRoot);
        if (swapped.rewritten) {
          fs.writeFileSync(file, swapped.buffer);
          rewrittenBuildRoots += swapped.rewritten;
        }
      }
    }
    for (const file of collectPdbs(bundle)) {
      if (realWithin(serverRoot, file)) continue;
      fs.rmSync(file, { force: true });
      removedPdbs++;
    }
  } else {
    serverPeFiles = files.filter((file) => looksLikePe(file) && realWithin(serverRoot, file)).length;
  }
  const scanned = scanWindowsBundle(bundle, { home, markers, serverRelative });
  const dependencies = verifyDependencies ? verifyProductionDependencies(serverRoot) : 0;
  return {
    files: scanned.files,
    removedPdbs,
    rewrittenDebugPaths,
    rewrittenBuildRoots,
    serverPeFiles,
    nativeAssets: scanned.nativeAssets,
    dependencies,
  };
}

const entryPath = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let checkOnly = false;
    let verifyDependencies = true;
    let buildRoot = null;
    const markers = [];
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check-only') checkOnly = true;
      else if (args[i] === '--skip-deps') verifyDependencies = false;
      else if (args[i] === '--marker') markers.push(args[++i]);
      else if (args[i] === '--build-root') buildRoot = args[++i];
      else positional.push(args[i]);
    }
    if (positional.length !== 1 || markers.some((marker) => !marker) ||
        (buildRoot !== null && !buildRoot)) {
      throw new Error('用法：node prepare-windows-bundle.mjs [--check-only] [--skip-deps] [--build-root <路径>] <发行目录> [--marker <路径>]');
    }
    console.log(JSON.stringify(prepareWindowsBundle(positional[0], {
      checkOnly, verifyDependencies, markers, buildRoot,
    })));
  } catch (error) {
    let message = String(error.message);
    for (const secret of [os.homedir(), process.argv[process.argv.indexOf('--build-root') + 1]].filter(Boolean)) {
      if (secret && secret.length > 2) message = message.split(secret).join('[构建目录]');
    }
    console.error(`发行包检查失败：${message}`);
    process.exitCode = 1;
  }
}
