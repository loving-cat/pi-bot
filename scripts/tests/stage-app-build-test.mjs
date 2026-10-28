/** Windows/共享源码副本：缓存过滤、必要文件与源码不变。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { includeBuildSource, stageAppBuild } from '../stage-app-build.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-stage-app-'));
const windowsRequired = ['pubspec.yaml', 'lib/main.dart', 'windows/CMakeLists.txt'];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
function fixture() {
  const source = fs.mkdtempSync(path.join(root, 'source-'));
  for (const [file, text] of Object.entries({
    'pubspec.yaml': 'name: fixture\n',
    'pubspec.lock': 'fixture pinned lock',
    'lib/main.dart': 'void main() {}',
    'windows/CMakeLists.txt': 'project(fixture)\n',
  })) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), text);
  }
  return source;
}
function destination() { return path.join(root, `build-${passed}`); }

try {
  test('排除 Windows 用户工程状态，不误伤业务文件名', () => {
    for (const name of ['.vs', 'windows/flutter/ephemeral', 'windows/runner/Runner.vcxproj.user', 'app.suo']) {
      assert.equal(includeBuildSource(name), false, name);
    }
    assert.equal(includeBuildSource('lib/build_helpers.dart'), true);
    assert.equal(includeBuildSource('windows/runner/main.cpp'), true);
  });
  test('无 Git 可复制，缓存不进副本且原文件不变', () => {
    const source = fixture();
    const target = destination();
    const caches = ['.dart_tool', 'build', '.vs', 'windows/flutter/ephemeral', 'windows/runner'];
    fs.mkdirSync(path.join(source, 'windows/runner'), { recursive: true });
    fs.writeFileSync(path.join(source, 'windows/runner/main.cpp'), 'int main(){return 0;}\n');
    fs.writeFileSync(path.join(source, 'windows/runner/Runner.vcxproj.user'), 'user state');
    for (const cache of ['.dart_tool', 'build', '.vs', 'windows/flutter/ephemeral']) {
      fs.mkdirSync(path.join(source, cache), { recursive: true });
      fs.writeFileSync(path.join(source, cache, 'marker'), 'fixture cached content');
    }
    const before = fs.readFileSync(path.join(source, 'lib/main.dart'));
    const result = stageAppBuild(source, target, { requiredFiles: windowsRequired });
    assert.equal(result.files, 5);
    assert.deepEqual(fs.readFileSync(path.join(target, 'lib/main.dart')), before);
    assert.deepEqual(fs.readFileSync(path.join(source, 'lib/main.dart')), before);
    assert.equal(fs.existsSync(path.join(target, 'windows/runner/main.cpp')), true);
    assert.equal(fs.existsSync(path.join(target, 'windows/runner/Runner.vcxproj.user')), false);
    for (const cache of caches.slice(0, 4)) assert.equal(fs.existsSync(path.join(target, cache)), false);
    assert.equal(fs.readFileSync(path.join(source, '.dart_tool/marker'), 'utf8'), 'fixture cached content');
    fs.writeFileSync(path.join(target, 'pubspec.lock'), 'fixture new resolution');
    assert.equal(fs.readFileSync(path.join(source, 'pubspec.lock'), 'utf8'), 'fixture pinned lock');
  });
  test('不要求 macOS 工程，但缺少 Windows 工程时不产生副本', () => {
    const source = fixture();
    const target = destination();
    fs.unlinkSync(path.join(source, 'windows/CMakeLists.txt'));
    assert.throws(() => stageAppBuild(source, target, { requiredFiles: windowsRequired }), /必要文件/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(source, 'macos')), false);
  });
  test('脚本入口接受 --require 并真正生成副本', () => {
    const source = fixture();
    const target = destination();
    const script = fileURLToPath(new URL('../stage-app-build.mjs', import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [
      script, source, target, '--require', 'pubspec.yaml', '--require', 'lib/main.dart', '--require', 'windows/CMakeLists.txt',
    ], { encoding: 'utf8' }));
    assert.equal(result.files, 4);
    assert.equal(fs.existsSync(path.join(target, 'windows/CMakeLists.txt')), true);
  });
  console.log(`\n${passed}/${passed} 通过`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
