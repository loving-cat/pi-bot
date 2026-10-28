/** 用合成 PE 和目录验证 Windows 发行包检查，不触碰真实构建产物。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  computePeChecksum, prepareWindowsBundle, rewritePeDebugPaths, scanWindowsBundle,
  verifyProductionDependencies, windowsNativeAssetFiles,
} from '../prepare-windows-bundle.mjs';
import { fileContainsMarkers, markerVariants } from '../scan-release-tree.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-win-bundle-'));
const home = 'C:\\Users\\example';
const otherHome = 'D:\\Other\\home';
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
function count(buffer, text) {
  const needle = Buffer.from(text);
  let found = 0;
  let from = 0;
  while (from <= buffer.length - needle.length) {
    const at = buffer.indexOf(needle, from);
    if (at < 0) break;
    found++;
    from = at + 1;
  }
  return found;
}
function buildPe(codeViewPath, extra = Buffer.alloc(0)) {
  const pathBytes = Buffer.from(`${codeViewPath}\0`, 'utf8');
  const codeView = Buffer.alloc(24 + pathBytes.length);
  codeView.writeUInt32LE(0x53445352, 0);
  codeView.writeUInt32LE(1, 20);
  pathBytes.copy(codeView, 24);
  const debugDir = Buffer.alloc(28);
  debugDir.writeUInt32LE(2, 12);
  debugDir.writeUInt32LE(codeView.length, 16);
  const contentLen = debugDir.length + codeView.length + extra.length;
  const rawPtr = 0x80 + 4 + 20 + 0xf0 + 40;
  const debugRva = 0x1000;
  debugDir.writeUInt32LE(debugRva + 28, 20);
  debugDir.writeUInt32LE(rawPtr + 28, 24);
  const dos = Buffer.alloc(0x80);
  dos.write('MZ', 0, 'latin1');
  dos.writeUInt32LE(0x80, 0x3c);
  const coff = Buffer.alloc(20);
  coff.writeUInt16LE(0x8664, 0);
  coff.writeUInt16LE(1, 2);
  coff.writeUInt16LE(0xf0, 16);
  const opt = Buffer.alloc(0xf0);
  opt.writeUInt16LE(0x20b, 0);
  opt.writeUInt32LE(16, 108);
  opt.writeUInt32LE(debugRva, 112 + 48);
  opt.writeUInt32LE(28, 112 + 52);
  const section = Buffer.alloc(40);
  section.write('.text', 0, 'latin1');
  section.writeUInt32LE(contentLen, 8);
  section.writeUInt32LE(debugRva, 12);
  section.writeUInt32LE(contentLen, 16);
  section.writeUInt32LE(rawPtr, 20);
  return Buffer.concat([dos, Buffer.from('PE\0\0', 'latin1'), coff, opt, section, debugDir, codeView, extra]);
}
function bundle(name = `fixture-${passed}`) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pi_bot.exe'), 'fixture exe');
  return dir;
}
const opts = { home: otherHome, verifyDependencies: false };

try {
  test('PE 校验和跳过自身字段并加上文件长度', () => {
    const sample = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    assert.equal(computePeChecksum(sample, 0), 0x0605 + sample.length);
    const overflow = Buffer.alloc(4);
    overflow.writeUInt16LE(0xffff, 0);
    overflow.writeUInt16LE(0xffff, 2);
    assert.equal(computePeChecksum(overflow, 8), (0xffff + 4) >>> 0);
  });
  test('只缩短 CodeView 绝对路径，文件其余绝对路径保持原样', () => {
    const abs = `${home}\\build\\pi_bot.pdb`;
    const extra = Buffer.from(abs);
    const original = buildPe(abs, extra);
    assert.equal(count(original, abs), 2);
    const result = rewritePeDebugPaths(original);
    assert.equal(result.changed, true);
    assert.equal(count(result.buffer, abs), 1);
    assert.ok(result.buffer.includes(Buffer.from('pi_bot.pdb\0')));
    const checksumOffset = 0x80 + 4 + 20 + 64;
    assert.equal(result.buffer.readUInt32LE(checksumOffset), computePeChecksum(result.buffer, checksumOffset));
    assert.deepEqual(original.subarray(original.length - extra.length), extra);
    assert.deepEqual(result.buffer.subarray(result.buffer.length - extra.length), extra);
  });
  test('相对 PDB 路径不改写', () => {
    const original = buildPe('pi_bot.pdb');
    const result = rewritePeDebugPaths(original);
    assert.equal(result.changed, false);
    assert.equal(result.buffer, original);
  });
  test('正斜杠、转义和 UTF-16 都能扫到，且不把标记写进错误', () => {
    const file = path.join(root, 'scan.bin');
    fs.writeFileSync(file, `prefix ${home.replaceAll('\\', '/')} suffix`);
    assert.equal(fileContainsMarkers(file, markerVariants(home)), true);
    fs.writeFileSync(file, home.replaceAll('\\', '\\\\'));
    assert.equal(fileContainsMarkers(file, markerVariants(home)), true);
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(1024 * 1024 - 3), Buffer.from(home, 'utf16le')]));
    assert.equal(fileContainsMarkers(file, markerVariants(home)), true);
    fs.writeFileSync(file, 'fixture public content');
    assert.equal(fileContainsMarkers(file, markerVariants(home)), false);
    assert.throws(() => markerVariants('C:\\'), /无效/);
  });
  test('前端 PDB 删除且调试路径改成文件名，重复执行不再改写', () => {
    const dir = bundle();
    const abs = `${home}\\build\\pi_bot.pdb`;
    fs.writeFileSync(path.join(dir, 'pi_bot.exe'), buildPe(abs));
    fs.writeFileSync(path.join(dir, 'flutter_windows.pdb'), 'fixture symbols');
    const once = prepareWindowsBundle(dir, { ...opts, markers: [home] });
    assert.equal(once.removedPdbs, 1);
    assert.equal(once.rewrittenDebugPaths, 1);
    assert.equal(fs.existsSync(path.join(dir, 'flutter_windows.pdb')), false);
    assert.equal(count(fs.readFileSync(path.join(dir, 'pi_bot.exe')), home), 0);
    const twice = prepareWindowsBundle(dir, { ...opts, markers: [home] });
    assert.equal(twice.removedPdbs, 0);
    assert.equal(twice.rewrittenDebugPaths, 0);
  });
  test('只读检查不删除 PDB 也不改 PE', () => {
    const dir = bundle();
    const abs = `${home}\\build\\pi_bot.pdb`;
    const original = buildPe(abs);
    fs.writeFileSync(path.join(dir, 'pi_bot.exe'), original);
    fs.writeFileSync(path.join(dir, 'pi_bot.pdb'), 'fixture symbols');
    assert.throws(() => prepareWindowsBundle(dir, { ...opts, checkOnly: true, markers: [home] }), /调试符号/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'pi_bot.exe')), original);
    assert.equal(fs.readFileSync(path.join(dir, 'pi_bot.pdb'), 'utf8'), 'fixture symbols');
  });
  test('CodeView 以外的本机路径不会被替换掉', () => {
    const dir = bundle();
    const abs = `${home}\\build\\pi_bot.pdb`;
    const original = buildPe(abs, Buffer.from(abs));
    fs.writeFileSync(path.join(dir, 'pi_bot.exe'), original);
    assert.throws(() => prepareWindowsBundle(dir, { home, verifyDependencies: false }), /1 个文件包含本机路径/);
    const after = fs.readFileSync(path.join(dir, 'pi_bot.exe'));
    assert.equal(count(after, abs), 1);
    assert.equal(after.includes(Buffer.from(home)), true);
  });
  test('服务端原生文件和 node.exe 只扫描不改写', () => {
    const dir = bundle();
    const abs = `${home}\\build\\addon.pdb`;
    const serverFile = path.join(dir, 'server/native/addon.node');
    fs.mkdirSync(path.dirname(serverFile), { recursive: true });
    const native = buildPe(abs);
    const bundledNode = buildPe(abs);
    fs.writeFileSync(serverFile, native);
    fs.writeFileSync(path.join(dir, 'node.exe'), bundledNode);
    assert.throws(() => prepareWindowsBundle(dir, { home, verifyDependencies: false }), /2 个文件包含本机路径/);
    assert.deepEqual(fs.readFileSync(serverFile), native);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'node.exe')), bundledNode);
  });
  test('本机状态、日志和 server/.env 会失败，示例环境文件可以留下', () => {
    for (const [name, file] of [
      ['.pi', '.pi/config.json'],
      ['_inbox', '_inbox/note.txt'],
      ['server/.env', 'server/.env'],
      ['log', 'data/app.log'],
    ]) {
      const dir = bundle(name);
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), 'fixture');
      fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'server', '.env.example'), 'FIXTURE=1\n');
      let message = '';
      try { prepareWindowsBundle(dir, opts); } catch (error) { message = error.message; }
      assert.match(message, /本机状态/);
      assert.equal(message.includes(home), false);
      assert.equal(message.includes('fixture'), false);
    }
    const dir = bundle('env-example');
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server/.env.example'), 'FIXTURE=1\n');
    fs.writeFileSync(path.join(dir, 'server/package.json'), '{"name":"fixture","version":"0.0.0"}\n');
    assert.equal(prepareWindowsBundle(dir, { ...opts, verifyDependencies: true }).files > 0, true);
  });
  test('空的 .pi 目录也算本机状态', () => {
    const dir = bundle();
    fs.mkdirSync(path.join(dir, '.pi'));
    assert.throws(() => prepareWindowsBundle(dir, opts), /本机状态（\.pi）/);
  });
  test('构建机路径不在用户目录下也能命中', () => {
    const dir = bundle();
    const build = 'D:\\work\\fixture\\app';
    fs.writeFileSync(path.join(dir, 'data.txt'), `built at ${build}\\out`);
    assert.throws(() => prepareWindowsBundle(dir, { ...opts, markers: [build] }), /本机路径/);
  });
  test('缺少声明依赖时失败，装进发行目录后可以通过', () => {
    const dir = bundle();
    const server = path.join(dir, 'server');
    fs.mkdirSync(path.join(server, 'node_modules/fixture-pkg'), { recursive: true });
    fs.writeFileSync(path.join(server, 'package.json'), '{"dependencies":{"fixture-pkg":"1.0.0"}}\n');
    assert.throws(() => verifyProductionDependencies(server), /未安装完整（1）/);
    fs.writeFileSync(path.join(server, 'node_modules/fixture-pkg/package.json'), '{"name":"fixture-pkg","main":"index.js"}\n');
    fs.writeFileSync(path.join(server, 'node_modules/fixture-pkg/index.js'), 'module.exports = {};\n');
    assert.equal(verifyProductionDependencies(server), 1);
    assert.equal(prepareWindowsBundle(dir, { home: otherHome, verifyDependencies: true }).dependencies, 1);
  });
  function cleanPackage(name) {
    const dir = bundle(name);
    fs.mkdirSync(path.join(dir, 'data/flutter_assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin/fixture.dll'), 'MZ');
    fs.writeFileSync(path.join(dir, 'data/flutter_assets/NativeAssetsManifest.json'), JSON.stringify({
      'format-version': [1, 0, 0],
      'native-assets': { windows_x64: { 'fixture:library': ['absolute', 'plugin/fixture.dll'] } },
    }));
    return dir;
  }
  function assertRejected(dir, pattern) {
    let message = '';
    try { scanWindowsBundle(dir, { home }); }
    catch (error) { message = error.message; }
    assert.match(message, pattern);
    assert.equal(message.includes(home), false);
    assert.equal(message.includes('plugin/fixture.dll'), false);
    return message;
  }
  test('假包目录：每种问题都报错且不打印本机路径，干净包通过', () => {
    const utf8 = cleanPackage('utf8');
    fs.writeFileSync(path.join(utf8, 'note.txt'), `prefix ${home} suffix`);
    const utf8Message = assertRejected(utf8, /1 个文件包含本机路径/);
    assert.match(utf8Message, /note\.txt/);
    const utf16 = cleanPackage('utf16');
    fs.writeFileSync(path.join(utf16, 'note.txt'), Buffer.from(home, 'utf16le'));
    assertRejected(utf16, /1 个文件包含本机路径/);
    const pdb = cleanPackage('pdb');
    fs.writeFileSync(path.join(pdb, 'pi_bot.pdb'), 'symbols');
    assertRejected(pdb, /1 个调试符号文件/);
    const pi = cleanPackage('state-pi');
    fs.mkdirSync(path.join(pi, '.pi'));
    fs.writeFileSync(path.join(pi, '.pi/config.json'), '{}');
    assertRejected(pi, /本机状态（\.pi）/);
    const inbox = cleanPackage('state-inbox');
    fs.mkdirSync(path.join(inbox, '_inbox'));
    fs.writeFileSync(path.join(inbox, '_inbox/note.txt'), 'x');
    assertRejected(inbox, /本机状态（_inbox）/);
    const env = cleanPackage('state-env');
    fs.mkdirSync(path.join(env, 'server'));
    fs.writeFileSync(path.join(env, 'server/.env'), 'TOKEN=fixture\n');
    assertRejected(env, /本机状态（server\/\.env）/);
    const log = cleanPackage('state-log');
    fs.writeFileSync(path.join(log, 'server.log'), 'log');
    assertRejected(log, /本机状态（log）/);
    const missing = cleanPackage('missing-dll');
    fs.rmSync(path.join(missing, 'plugin/fixture.dll'));
    assertRejected(missing, /原生资产缺失/);
    const clean = cleanPackage('clean');
    fs.mkdirSync(path.join(clean, 'server/native'), { recursive: true });
    fs.writeFileSync(path.join(clean, 'server/native/NativeAssetsManifest.json'), JSON.stringify({
      'format-version': [1, 0, 0],
      'native-assets': { windows_x64: { 'server:ignored': ['absolute', 'missing.dll'] } },
    }));
    const result = scanWindowsBundle(clean, { home });
    assert.equal(result.nativeAssets, 1);
    assert.deepEqual(windowsNativeAssetFiles(JSON.parse(fs.readFileSync(
      path.join(clean, 'data/flutter_assets/NativeAssetsManifest.json'), 'utf8',
    ))), ['plugin/fixture.dll']);
  });
  test('拒绝绝对路径、路径穿越和不是 DLL 的原生资产', () => {
    const manifest = { 'format-version': [1, 0, 0], 'native-assets': { windows_x64: {} } };
    for (const file of [`${home}\\fixture.dll`, '../fixture.dll', '/tmp/fixture.dll', 'fixture.exe', 'plugin//fixture.dll']) {
      manifest['native-assets'].windows_x64 = { fixture: ['absolute', file] };
      assert.throws(() => windowsNativeAssetFiles(manifest));
      try { windowsNativeAssetFiles(manifest); } catch (error) {
        assert.equal(error.message.includes(home), false);
      }
    }
  });
  test('包外链接被拒绝，包内相对链接可以保留', () => {
    try {
      const probe = path.join(root, 'symlink-probe');
      fs.symlinkSync('target', probe);
      fs.rmSync(probe);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return;
      throw error;
    }
    for (const [name, target] of [['outside', path.join(root, 'outside')], ['absolute', root], ['broken', 'missing']]) {
      const dir = bundle(name);
      fs.symlinkSync(target, path.join(dir, 'link'));
      assert.throws(() => prepareWindowsBundle(dir, opts), /链接/);
    }
    const dir = bundle('inside');
    fs.symlinkSync('pi_bot.exe', path.join(dir, 'alias.exe'));
    assert.equal(prepareWindowsBundle(dir, opts).files >= 1, true);
  });
  test('Runner 工程把 PDB 路径限制为文件名', () => {
    const cmake = fs.readFileSync(fileURLToPath(new URL('../../app/windows/runner/CMakeLists.txt', import.meta.url)), 'utf8');
    assert.match(cmake, /PDBALTPATH:%_PDB%/);
  });
  test('打包脚本保持纯 ASCII', () => {
    for (const rel of ['../pack-windows.ps1', 'pack-windows-test.ps1']) {
      const bytes = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
      assert.equal(bytes.includes(0), false, rel);
      for (const byte of bytes) assert.ok(byte < 128, rel);
    }
  });
  test('通过符号链接执行 CLI 仍会检查发行目录', () => {
    const dir = bundle('cli');
    const alias = path.join(root, 'prepare-alias.mjs');
    fs.symlinkSync(fileURLToPath(new URL('../prepare-windows-bundle.mjs', import.meta.url)), alias);
    const result = JSON.parse(execFileSync(process.execPath, [alias, '--skip-deps', '--check-only', dir], { encoding: 'utf8' }));
    assert.equal(result.removedPdbs, 0);
    assert.equal(result.files >= 1, true);
  });
  console.log(`\n${passed}/${passed} 通过`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
