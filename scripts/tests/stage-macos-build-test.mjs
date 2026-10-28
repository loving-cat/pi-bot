/** 干净源码副本的路径过滤、链接边界及源码不变性回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { includeBuildSource, stageMacosBuild } from '../stage-macos-build.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-stage-test-'));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
function fixture() {
  const source = fs.mkdtempSync(path.join(root, 'source-'));
  for (const [file, text] of Object.entries({
    'pubspec.yaml': 'name: fixture\n', 'pubspec.lock': 'fixture pinned lock',
    'lib/main.dart': 'void main() {}', 'macos/Runner.xcodeproj/project.pbxproj': 'fixture project',
  })) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), text);
  }
  return source;
}
function destination() { return path.join(root, `build-${passed}`); }

try {
  test('按路径段过滤生成缓存，业务文件名不被误排除', () => {
    for (const name of ['.dart_tool', 'build', 'macos/Pods', 'macos/Flutter/ephemeral', 'macos/.symlinks',
      'macos/Runner.xcodeproj/xcuserdata', '.flutter-plugins-dependencies', 'ios/Flutter/Generated.xcconfig']) {
      assert.equal(includeBuildSource(name), false, name);
    }
    for (const name of ['lib/build_helpers.dart', 'lib/rebuild/widget.dart', 'macos/Flutter/Flutter-Debug.xcconfig', 'pubspec.lock']) {
      assert.equal(includeBuildSource(name), true, name);
    }
  });
  test('无Git的源码可复制，缓存不进入副本且原文件不变', () => {
    const source = fixture(), target = destination();
    const caches = ['.dart_tool', 'build', 'macos/Pods', 'macos/Flutter/ephemeral', 'macos/.symlinks', 'macos/Runner.xcodeproj/xcuserdata'];
    for (const cache of caches) {
      fs.mkdirSync(path.join(source, cache), { recursive: true });
      fs.writeFileSync(path.join(source, cache, 'marker'), 'fixture cached content');
    }
    const before = fs.readFileSync(path.join(source, 'lib/main.dart'));
    assert.equal(stageMacosBuild(source, target).files, 4);
    assert.deepEqual(fs.readFileSync(path.join(target, 'lib/main.dart')), before);
    assert.deepEqual(fs.readFileSync(path.join(source, 'lib/main.dart')), before);
    for (const cache of caches) {
      assert.equal(fs.existsSync(path.join(target, cache)), false);
      assert.equal(fs.readFileSync(path.join(source, cache, 'marker'), 'utf8'), 'fixture cached content');
    }
    fs.writeFileSync(path.join(target, 'pubspec.lock'), 'fixture new resolution');
    assert.equal(fs.readFileSync(path.join(source, 'pubspec.lock'), 'utf8'), 'fixture pinned lock');
  });
  test('不覆盖已存在目标', () => {
    const source = fixture(), target = destination(); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'fixture keep');
    assert.throws(() => stageMacosBuild(source, target), /已存在/);
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'fixture keep');
  });
  test('不在源码目录内创建构建副本', () => {
    const source = fixture();
    assert.throws(() => stageMacosBuild(source, path.join(source, 'clone')), /不能位于源码/);
    assert.equal(fs.existsSync(path.join(source, 'clone')), false);
  });
  test('缺少必要源码时失败且不产生副本', () => {
    const source = fixture(), target = destination(); fs.unlinkSync(path.join(source, 'lib/main.dart'));
    assert.throws(() => stageMacosBuild(source, target), /必要文件/);
    assert.equal(fs.existsSync(target), false);
  });
  test('内部相对链接保持相对路径', () => {
    const source = fixture(), target = destination();
    fs.symlinkSync('main.dart', path.join(source, 'lib/alias.dart'));
    stageMacosBuild(source, target);
    assert.equal(fs.readlinkSync(path.join(target, 'lib/alias.dart')), 'main.dart');
    assert.equal(fs.readFileSync(path.join(target, 'lib/alias.dart'), 'utf8'), 'void main() {}');
  });
  test('包外、绝对和失效链接被拒绝', () => {
    for (const [name, linked] of [['external', '../../outside'], ['absolute', root], ['broken', 'missing']]) {
      const source = fixture(), target = path.join(root, `invalid-${name}`);
      fs.symlinkSync(linked, path.join(source, 'lib/link'));
      assert.throws(() => stageMacosBuild(source, target), /链接/);
    }
  });
  test('指向生成缓存的源码链接被拒绝', () => {
    const source = fixture(), target = destination();
    fs.mkdirSync(path.join(source, 'build')); fs.writeFileSync(path.join(source, 'build/cache'), 'fixture cache');
    fs.symlinkSync('../build/cache', path.join(source, 'lib/generated'));
    assert.throws(() => stageMacosBuild(source, target), /链接/);
  });
  test('缓存目录内的坏链接不影响源码副本', () => {
    const source = fixture(), target = destination();
    fs.mkdirSync(path.join(source, '.dart_tool'));
    fs.symlinkSync('/missing/fixture-cache', path.join(source, '.dart_tool/broken'));
    assert.equal(stageMacosBuild(source, target).files, 4);
  });
  test('通过脚本符号链接执行仍真正生成副本', () => {
    const source = fixture(), target = destination();
    const alias = path.join(root, 'stage-alias.mjs');
    fs.symlinkSync(fileURLToPath(new URL('../stage-macos-build.mjs', import.meta.url)), alias);
    const result = JSON.parse(execFileSync(process.execPath, [alias, source, target], { encoding: 'utf8' }));
    assert.equal(result.files, 4); assert.equal(fs.existsSync(path.join(target, 'lib/main.dart')), true);
  });
  console.log(`\n${passed}/${passed} 通过`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
