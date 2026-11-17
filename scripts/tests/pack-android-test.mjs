/** pack-android.mjs 的纯函数单测：不跑 flutter、不需要 Android SDK。 */
import assert from 'node:assert/strict';
import {
  APP_ID,
  apkFileName,
  assertSigner,
  commandLine,
  assertVersionsAgree,
  checkJdk,
  findMirrorHost,
  parseJavaMajor,
  parsePubspecVersion,
  parseSignerDigest,
  verifyMetadata,
} from '../pack-android.mjs';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}

test('pubspec 版本 + 构建号都能读出来', () => {
  assert.deepEqual(parsePubspecVersion('name: pi_bot\nversion: 1.4.1+19\n'), { version: '1.4.1', build: 19 });
  assert.deepEqual(parsePubspecVersion('version: 2.0.0\n'), { version: '2.0.0', build: 0 });
});

test('pubspec 没写版本号要报错', () => {
  assert.throws(() => parsePubspecVersion('name: pi_bot\n'), /version/);
});

test('两处版本一致才放行', () => {
  const pubspec = parsePubspecVersion('version: 1.4.1+19');
  assert.equal(assertVersionsAgree({ serverVersion: '1.4.1', pubspec }), '1.4.1');
});

test('只 bump 一处要报错，并给出该改成什么', () => {
  const pubspec = parsePubspecVersion('version: 1.3.14+18');
  assert.throws(
    () => assertVersionsAgree({ serverVersion: '1.4.1', pubspec }),
    /1\.4\.1\+18/,
  );
});

test('锁文件里的镜像地址能被认出来', () => {
  assert.equal(findMirrorHost('url: "https://pub.dev"'), null);
  assert.equal(findMirrorHost('url: "https://pub.flutter-io.cn"'), 'pub.flutter-io.cn');
  assert.equal(findMirrorHost('url: "http://pub.dartlang.org"'), 'pub.dartlang.org');
});

test('java -version 的大版本解析（1.8 与 21 两种写法）', () => {
  const java8 = 'java version "1.8.0_401"\nJava(TM) SE Runtime Environment';
  const java21 = 'openjdk version "21.0.12.1" 2026-08-18 LTS';
  assert.equal(parseJavaMajor(java8), 8);
  assert.equal(parseJavaMajor(java21), 21);
  assert.equal(parseJavaMajor('garbage'), null);
});

test('JDK 1.8 被拦住，并且错误里说清要 17+', () => {
  assert.throws(
    () => checkJdk({ javaHome: 'C:\\Program Files\\Java\\jdk-1.8', runJavaVersion: () => 'java version "1.8.0_401"' }),
    /需要 17\+/,
  );
});

test('JDK 21 放行', () => {
  assert.equal(
    checkJdk({ javaHome: '', runJavaVersion: () => 'openjdk version "21.0.12.1" 2026-08-18 LTS' }),
    21,
  );
});

test('读不到 Java 版本要报错，不能当通过', () => {
  assert.throws(() => checkJdk({ javaHome: '', runJavaVersion: () => '' }), /读不到 Java 版本/);
});

test('带空格的路径要被引号包住（否则 Windows 上 C:/Program Files 直接断）', () => {
  const line = commandLine('C:/flutter/bin/flutter.bat', ['build', 'apk', '--release']);
  assert.equal(line, 'C:/flutter/bin/flutter.bat build apk --release');
  const spaced = commandLine('C:/Program Files/flutter/bin/flutter.bat', ['build', 'apk']);
  assert.equal(spaced, '"C:/Program Files/flutter/bin/flutter.bat" build apk');
});

test('产物名带平台词和纯 semver', () => {
  assert.equal(apkFileName('1.4.1'), 'pi-bot-android-v1.4.1.apk');
});

test('元数据对得上才放行', () => {
  const metadata = {
    applicationId: APP_ID,
    elements: [{ versionName: '1.4.1', versionCode: 19 }],
  };
  assert.equal(verifyMetadata(metadata, { version: '1.4.1', build: 19 }), true);
});

test('元数据是旧版本、构建号不对、包名不对，三种都要红', () => {
  const base = { applicationId: APP_ID, elements: [{ versionName: '1.4.1', versionCode: 19 }] };
  assert.throws(() => verifyMetadata(base, { version: '1.4.2', build: 19 }), /期望 1\.4\.2/);
  assert.throws(() => verifyMetadata(base, { version: '1.4.1', build: 20 }), /构建号/);
  assert.throws(
    () => verifyMetadata({ ...base, applicationId: 'com.example.other' }, { version: '1.4.1', build: 19 }),
    /applicationId/,
  );
});

test('签名证书指纹能从 apksigner 输出里读出来', () => {
  const output = [
    'Verifies',
    'Signer #1 certificate DN: C=US, O=Android, CN=Android Debug',
    'Signer #1 certificate SHA-256 digest: 03CDDCF5C4DEEA5F1ABFE9327B6F552452D707532A66A8E77153AF5F031445D6',
    'Signer #1 certificate SHA-1 digest: 0123456789abcdef',
  ].join(' ');
  assert.equal(
    parseSignerDigest(output),
    '03cddcf5c4deea5f1abfe9327b6f552452d707532a66a8e77153af5f031445d6',
  );
});

test('找不到 apksigner 必须直接失败，不能静默跳过签名校验', () => {
  assert.throws(() => assertSigner('x.apk', { apksignerPath: null }), /找不到 apksigner/);
});

test('apksigner 没输出指纹时要返回 null（不能让调用方当成通过）', () => {
  assert.equal(parseSignerDigest('ERROR: does not verify'), null);
  assert.equal(parseSignerDigest(''), null);
});

if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('\npack-android 单测通过');
