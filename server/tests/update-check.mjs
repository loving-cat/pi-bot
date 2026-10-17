/**
 * 版本比较与更新判定测试。
 *
 * 这一层是纯函数：不发网络请求、不碰文件，所以能直接断言各种版本写法。
 * 重点覆盖那些"想当然会写错"的边界：
 *   · v 前缀 / 构建号 / 预发布；
 *   · 1.10.0 与 1.9.0（字符串比较会判错）；
 *   · 预发布小于正式版；
 *   · 远端更旧时不能提示更新。
 */
import assert from 'node:assert/strict';
import {
  parseVersion,
  compareVersions,
  buildUpdateInfo,
  pickAssetFor,
} from '../src/update-check.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

test('解析各种版本写法', () => {
  assert.deepEqual(parseVersion('1.2.3').core, [1, 2, 3]);
  assert.deepEqual(parseVersion('v1.2.3').core, [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3+5').core, [1, 2, 3]);
  assert.deepEqual(parseVersion('1.1.0').pre, []);
  assert.deepEqual(parseVersion('1.2.0-beta.1').pre, ['beta', '1']);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('abc'), null);
  assert.equal(parseVersion(null), null);
});

test('数字段按数值比较，不是按字符串', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '1.10.0 应该大于 1.9.0');
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

test('缺失的段按 0 处理', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.2'), 0);
  assert.equal(compareVersions('1.2.1', '1.2'), 1);
});

test('预发布小于正式版', () => {
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.9'), 1);
});

test('预发布多位数按数值比（beta.10 > beta.9）', () => {
  assert.equal(
    compareVersions('1.0.0-beta.10', '1.0.0-beta.9'),
    1,
    '字符串比较会判成 -1，更新将永远不提示',
  );
  assert.equal(compareVersions('1.0.0-beta.9', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-beta.02', '1.0.0-beta.2'), 0, '前导零按数值相等');
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.11'), 1, '字母段仍按字典序');
});

test('v 前缀与构建号不影响比较', () => {
  assert.equal(compareVersions('v1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.1.0+3', '1.1.0+1'), 0);
  assert.equal(compareVersions('v1.2.0+9', 'v1.1.9'), 1);
});

test('无法解析时判为相等（不误报更新）', () => {
  assert.equal(compareVersions('', '1.0.0'), 0);
  assert.equal(compareVersions('abc', '1.0.0'), 0);
});

test('远端更新 → 提示更新', () => {
  const info = buildUpdateInfo({ current: '1.1.0', latest: 'v1.2.0', notes: '修了几个 bug' });
  assert.equal(info.update, true);
  assert.equal(info.latest, 'v1.2.0');
  assert.match(info.reason, /发现新版本/);
  assert.equal(info.notes, '修了几个 bug');
});

test('远端同版本 / 更旧 → 不提示', () => {
  assert.equal(buildUpdateInfo({ current: '1.1.0', latest: '1.1.0' }).update, false);
  const older = buildUpdateInfo({ current: '1.1.0', latest: 'v1.0.6' });
  assert.equal(older.update, false);
  assert.match(older.reason, /比当前旧/);
});

test('远端版本无法识别 → 不提示且说明原因', () => {
  const info = buildUpdateInfo({ current: '1.1.0', latest: 'not-a-version' });
  assert.equal(info.update, false);
  assert.match(info.reason, /无法识别/);
});

test('更新说明过长会被截断', () => {
  const notes = 'x'.repeat(9000);
  assert.equal(buildUpdateInfo({ current: '1.0.0', latest: '2.0.0', notes }).notes.length, 4000);
});

test('挑 Windows 安装包', () => {
  const assets = [
    { name: 'pi-bot-android.apk', url: 'https://x/app.apk' },
    { name: 'pi-bot-1.2.0-windows-setup.exe', url: 'https://x/win.exe', size: 100 },
    { name: 'pi-bot-1.2.0.dmg', url: 'https://x/mac.dmg' },
  ];
  assert.equal(pickAssetFor(assets, 'win32').url, 'https://x/win.exe');
  assert.equal(pickAssetFor(assets, 'darwin').url, 'https://x/mac.dmg');
  assert.equal(pickAssetFor(assets, 'android').url, 'https://x/app.apk');
});

test('Windows 不能挑到 darwin 包（无锚点 /win/ 会误命中）', () => {
  const assets = [{ name: 'pi-bot-1.2.0-darwin-arm64.dmg', url: 'https://x/mac.dmg', size: 1 }];
  assert.equal(pickAssetFor(assets, 'win32'), null, 'darwin 里含 win 子串，必须带分隔符边界');
});

test('更新元数据不能被当成安装包', () => {
  const assets = [
    { name: 'latest.yml', url: 'https://x/latest.yml' },
    { name: 'pi-bot-setup.exe.blockmap', url: 'https://x/a.blockmap' },
    { name: 'pi-bot-win-x64.exe', url: 'https://x/a.exe', size: 9 },
  ];
  assert.equal(pickAssetFor(assets, 'win32').name, 'pi-bot-win-x64.exe');
});

test('只按文件名判平台，URL 里带平台词不干扰', () => {
  const assets = [{ name: 'pi-bot-win64.exe', url: 'https://x/darwin/pi-bot-win64.exe', size: 5 }];
  assert.equal(pickAssetFor(assets, 'win32').name, 'pi-bot-win64.exe');
});

test('非 https 链接不采纳', () => {
  assert.equal(pickAssetFor([{ name: 'a.exe', url: 'http://x/a.exe' }], 'win32'), null);
});

test('挑不到对应平台 → 返回 null（不瞎猜）', () => {
  const assets = [{ name: 'something.zip', url: 'https://x/s.zip' }];
  assert.equal(pickAssetFor(assets, 'android'), null);
  assert.equal(pickAssetFor([], 'win32'), null);
});

test('没有 assets 字段也不炸', () => {
  const info = buildUpdateInfo({ current: '1.0.0', latest: '1.1.0' });
  assert.deepEqual(info.assets, []);
  assert.equal(pickAssetFor(info.assets, 'win32'), null);
});

console.log(`\n更新判定测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
