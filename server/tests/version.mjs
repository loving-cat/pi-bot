import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
);
const { VERSION, isReleaseVersion } = await import('../src/version.js');

await test('版本来自 package.json（唯一来源）', () => {
  assert.equal(VERSION, pkg.version);
});

await test('是 semver 形态（允许 alpha/beta/rc 预发布，禁止平台后缀）', () => {
  // 更新检查按 semver 解析 tag：`-win.20261022` 这类后缀会被判成预发布，
  // 于是"远端比当前旧"，用户永远收不到更新提示。见 docs/RELEASE.md。
  // 2.0.0-alpha.1 这类**标准预发布**必须放行：alpha 版要靠它和 1.7.1 区分。
  assert.ok(isReleaseVersion(VERSION), `VERSION=${VERSION} 不是合法的发布版本号`);

  for (const ok of ['1.7.1', '2.0.0', '2.0.0-alpha.1', '2.0.0-beta.12', '2.0.0-rc.0', '10.20.30']) {
    assert.ok(isReleaseVersion(ok), `${ok} 应该合法`);
  }
  for (const bad of [
    '2.0.0-win.20261022',
    '2.0.0-macos',
    '2.0.0-alpha',
    '2.0.0-alpha.01',
    '2.0.0-alpha.1-win',
    '2.0.0-alpha.1+build',
    'v2.0.0',
    '2.0',
    '2.0.0.1',
    '2026-11-21',
    '',
    null,
  ]) {
    assert.ok(!isReleaseVersion(bad), `${String(bad)} 不该被当成发布版本号`);
  }
});

await test('app/pubspec.yaml 的版本与服务端一致', () => {
  // 只 bump 一处会让 APK 的 versionName 和更新检查的"当前版本"对不上。
  const pubspec = fs.readFileSync(
    path.join(process.cwd(), '..', 'app', 'pubspec.yaml'),
    'utf8',
  );
  const m = pubspec.match(/^version:\s*(\S+)\s*$/m);
  assert.ok(m, 'app/pubspec.yaml 里找不到 version:');
  const appVersion = m[1].split('+')[0];
  assert.equal(
    appVersion,
    VERSION,
    `app/pubspec.yaml(${appVersion}) 与服务端 package.json(${VERSION}) 不一致，发布前必须同步`,
  );
});

await test('源码里不再出现写死的旧版本号', async () => {
  // /health、ws hello、serverInfo 都不写死版本号
  const files = ['src/http.js', 'src/ws.js', 'src/index.js'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
    assert.ok(!text.includes("'0.2.0'"), `${f} 里还有写死的 0.2.0`);
  }
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 版本测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
