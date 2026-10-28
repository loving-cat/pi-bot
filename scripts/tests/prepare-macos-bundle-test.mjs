/** 使用合成文件和命令替身验证应用包检查，不修改真实应用。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  containsLocalHome, isMachO, nativeAssetRequirements,
  parseRpathGroups, prepareMacosBundle, removableRpaths,
} from '../prepare-macos-bundle.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-bundle-test-'));
const home = path.join(root, 'fixture-home');
const toolchain = path.join(home, 'SDK.app/Contents/Developer/Toolchains/Default.xctoolchain/usr/lib/swift/macosx');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
const macho = Buffer.from('cffaedfe00000000', 'hex');
function fixture(name = `fixture-${passed}`) {
  const app = path.join(root, `${name}.app`);
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<plist/>');
  fs.writeFileSync(path.join(app, 'Contents/MacOS/fixture'), macho);
  return app;
}
function writeManifest(app, manifest) {
  const file = path.join(app, 'Contents/Frameworks/App.framework/Resources/flutter_assets/NativeAssetsManifest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest));
}
const manifest = {
  'format-version': [1, 0, 0],
  'native-assets': {
    macos_arm64: { 'fixture:library': ['absolute', 'fixture.framework/fixture'] },
    macos_x64: { 'fixture:library': ['absolute', 'fixture.framework/fixture'] },
  },
};
function rpathOutput(paths, arch = 'arm64') {
  return `fixture (architecture ${arch}):\n` + paths.map((value, i) => `Load command ${i}\n cmd LC_RPATH\n cmdsize 64\n path ${value} (offset 12)\n`).join('');
}
const fallback = ['/usr/lib/swift', '@executable_path/../Frameworks'];
const stub = (name) => name === 'lipo' ? 'arm64 x86_64\n' : name === 'otool' ? rpathOutput(fallback) : '';

try {
  test('识别所有支持的 Mach-O 字节序与 fat 头，忽略普通文本', () => {
    for (const magic of ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']) {
      assert.equal(isMachO(Buffer.from(magic, 'hex')), true);
    }
    assert.equal(isMachO(Buffer.from('fixture')), false);
    assert.equal(isMachO(Buffer.from([1, 2])), false);
  });
  test('按架构读取包含空格的 rpath，不误读 dylib 名称', () => {
    const text = rpathOutput([...fallback, toolchain.replace('SDK.app', 'Fixture SDK.app')]) +
      rpathOutput(fallback, 'x86_64') + ' cmd LC_LOAD_DYLIB\n name fixture (offset 24)\n';
    const groups = parseRpathGroups(text);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].length, 3);
    assert.equal(groups[1].length, 2);
    assert.ok(groups[0][2].includes('Fixture SDK.app'));
  });
  test('只移除本机工具链 Swift 路径并去重', () => {
    assert.deepEqual(removableRpaths([[...fallback, toolchain], [...fallback, toolchain]], home), [toolchain]);
    assert.deepEqual(removableRpaths([[...fallback, path.join(home, 'custom/lib')]], home), []);
    assert.deepEqual(removableRpaths([[...fallback, '/opt/SDK.app/Contents/Developer/Toolchains/Default.xctoolchain/usr/lib/swift/macosx']], home), []);
  });
  test('任一架构缺少系统或应用回退时拒绝移除', () => {
    assert.throws(() => removableRpaths([[...fallback, toolchain], ['/usr/lib/swift', toolchain]], home), /拒绝修改/);
    assert.throws(() => removableRpaths([['@loader_path/Frameworks', toolchain]], home), /拒绝修改/);
  });
  test('分块边界和 UTF-16 路径也能发现，不输出匹配内容', () => {
    const file = path.join(root, 'scan.bin');
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(1024 * 1024 - 3), Buffer.from(home)]));
    assert.equal(containsLocalHome(file, home), true);
    fs.writeFileSync(file, Buffer.from(home, 'utf16le'));
    assert.equal(containsLocalHome(file, home), true);
    fs.writeFileSync(file, 'fixture public content');
    assert.equal(containsLocalHome(file, home), false);
    assert.throws(() => containsLocalHome(file, path.parse(home).root), /无效/);
  });
  test('解析每个原生资产架构', () => {
    assert.deepEqual(nativeAssetRequirements(manifest), [
      { architecture: 'arm64', file: 'fixture.framework/fixture' },
      { architecture: 'x86_64', file: 'fixture.framework/fixture' },
    ]);
  });
  test('拒绝绝对资产、路径穿越、错误版本和未知加载方式', () => {
    for (const entry of [['absolute', '../fixture'], ['absolute', '/tmp/fixture'], ['absolute', '..\\fixture'], ['other', 'fixture']]) {
      assert.throws(() => nativeAssetRequirements({ 'format-version': [1], 'native-assets': { macos_arm64: { fixture: entry } } }));
    }
    assert.throws(() => nativeAssetRequirements({ 'format-version': [2], 'native-assets': {} }));
  });
  test('缺少库文件时停止准备', () => {
    const app = fixture(); writeManifest(app, manifest);
    assert.throws(() => prepareMacosBundle(app, { home, run: stub }), /原生资产缺失/);
  });
  test('库文件缺少目标架构时停止准备', () => {
    const app = fixture(); writeManifest(app, manifest);
    const library = path.join(app, 'Contents/Frameworks/fixture.framework/fixture');
    fs.mkdirSync(path.dirname(library), { recursive: true }); fs.writeFileSync(library, macho);
    assert.throws(() => prepareMacosBundle(app, { home, run: (name) => name === 'lipo' ? 'arm64' : stub(name) }), /缺少目标架构/);
  });
  test('完整库按目标架构验证，重复执行保持结果', () => {
    const app = fixture(); writeManifest(app, manifest);
    const library = path.join(app, 'Contents/Frameworks/fixture.framework/fixture');
    fs.mkdirSync(path.dirname(library), { recursive: true }); fs.writeFileSync(library, macho);
    const one = prepareMacosBundle(app, { home, run: stub });
    const two = prepareMacosBundle(app, { home, run: stub });
    assert.deepEqual(one, two); assert.equal(one.nativeAssets, 2);
  });
  test('服务端 Mach-O 只扫描，前端使用标准工具处理', () => {
    const app = fixture();
    const serverFile = path.join(app, 'Contents/Resources/server/native.node');
    fs.mkdirSync(path.dirname(serverFile), { recursive: true }); fs.writeFileSync(serverFile, macho);
    const calls = [];
    prepareMacosBundle(app, { home, run: (name, args) => { calls.push({ name, args }); return stub(name); } });
    assert.equal(calls.some((call) => call.args.includes(serverFile)), false);
    assert.deepEqual(calls.map((call) => call.name), ['strip', 'otool']);
    assert.equal(calls[0].args[0], '-S');
  });
  test('搜索路径通过标准工具移除，第二次不重复删除', () => {
    const app = fixture();
    let paths = [...fallback, toolchain];
    const calls = [];
    const run = (name, args) => {
      calls.push({ name, args });
      if (name === 'otool') return rpathOutput(paths) + rpathOutput(paths, 'x86_64');
      if (name === 'install_name_tool') {
        assert.equal(args[0], '-delete_rpath');
        assert.equal(args[1], toolchain);
        paths = paths.filter((item) => item !== args[1]);
      }
      return '';
    };
    assert.equal(prepareMacosBundle(app, { home, run }).removedRpaths, 1);
    assert.equal(prepareMacosBundle(app, { home, run }).removedRpaths, 0);
    assert.equal(calls.filter((call) => call.name === 'install_name_tool').length, 1);
    assert.deepEqual(paths, fallback);
  });
  test('服务端文件残留本机目录也拒绝发布', () => {
    const app = fixture();
    const file = path.join(app, 'Contents/Resources/server/config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ fixture: home }));
    assert.throws(() => prepareMacosBundle(app, { home, run: stub }), /1 个文件包含本机目录/);
  });
  test('只读检查不会 strip 或修改 rpath', () => {
    const app = fixture(); const calls = [];
    prepareMacosBundle(app, { home, checkOnly: true, run: (name) => { calls.push(name); return stub(name); } });
    assert.deepEqual(calls, []);
  });
  test('脚本通过符号链接执行时不会跳过CLI检查', () => {
    const app = fixture();
    const alias = path.join(root, 'prepare-alias.mjs');
    fs.symlinkSync(fileURLToPath(new URL('../prepare-macos-bundle.mjs', import.meta.url)), alias);
    const result = JSON.parse(execFileSync(process.execPath, [alias, '--check-only', app], { encoding: 'utf8' }));
    assert.equal(result.frontendMachO, 1);
  });
  test('命令失败会停止处理，保留错误而非继续签名', () => {
    const app = fixture();
    assert.throws(() => prepareMacosBundle(app, { home, run: () => { throw new Error('fixture command failed'); } }), /fixture command failed/);
  });
  test('只允许包内相对链接，拒绝外链、绝对链接和坏链', () => {
    for (const [name, target] of [['outside', '../../outside'], ['absolute', root], ['broken', 'missing']]) {
      const app = fixture(name);
      fs.symlinkSync(target, path.join(app, 'Contents/link'));
      assert.throws(() => prepareMacosBundle(app, { home, run: stub }), /链接/);
    }
    const app = fixture('inside');
    fs.symlinkSync('fixture', path.join(app, 'Contents/MacOS/alias'));
    assert.equal(prepareMacosBundle(app, { home, run: stub }).frontendMachO, 1);
  });
  test('残留调试路径不会被字节替换伪装通过', () => {
    const app = fixture(); const executable = path.join(app, 'Contents/MacOS/fixture');
    const original = Buffer.concat([macho, Buffer.from(home)]); fs.writeFileSync(executable, original);
    assert.throws(() => prepareMacosBundle(app, { home, run: stub }), /包含本机目录/);
    assert.deepEqual(fs.readFileSync(executable), original);
  });
  console.log(`\n${passed}/${passed} 通过`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
