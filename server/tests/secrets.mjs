/**
 * 口令加密与「不进仓库」保障测试。
 *
 * 两件事必须钉住：
 *   1. 加密是可用的（能还原、错密钥解不开、同一口令两次密文不同）；
 *   2. **state.json 里绝不能出现明文口令** —— 这是用户明确要求。
 *      第 2 条用真实 store 落盘验证，不是测 mock。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store 依赖数据目录，必须在 import 之前指好
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-secrets-'));
process.env.PI_BOT_HOME = tmpRoot;

const { encrypt, decrypt, isEncrypted, loadOrCreateKey, hasKey } = await import('../src/secrets.js');

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

const key = crypto.randomBytes(32);

// ---------------------------------------------------------------- 加解密

await test('加密后能还原', () => {
  const plain = 'example-pw-1234';
  const enc = encrypt(plain, key);
  assert.ok(enc.startsWith('enc:v1:'), '要有可识别前缀');
  assert.ok(!enc.includes(plain), '密文里不能出现明文');
  assert.equal(decrypt(enc, key), plain);
});

await test('同一个口令两次加密结果不同（IV 随机）', () => {
  const a = encrypt('same', key);
  const b = encrypt('same', key);
  assert.notEqual(a, b, 'IV 必须随机，否则能看出两个口令相同');
  assert.equal(decrypt(a, key), 'same');
  assert.equal(decrypt(b, key), 'same');
});

await test('换密钥解不开（返回空，不抛错）', () => {
  const enc = encrypt('secret', key);
  const other = crypto.randomBytes(32);
  assert.equal(decrypt(enc, other), '', '密钥不对就该解不出');
});

await test('密文被篡改后解不开', () => {
  const enc = encrypt('secret', key);
  // 改最后一个字符
  const tampered = enc.slice(0, -1) + (enc.endsWith('A') ? 'B' : 'A');
  assert.equal(decrypt(tampered, key), '', 'GCM 校验失败应返回空');
});

await test('空值安全', () => {
  assert.equal(encrypt('', key), '');
  assert.equal(decrypt('', key), '');
  assert.equal(decrypt(null, key), '');
});

await test('历史明文原样返回（供迁移识别）', () => {
  assert.equal(decrypt('plain-old-value', key), 'plain-old-value');
  assert.equal(isEncrypted('plain-old-value'), false);
  assert.equal(isEncrypted(encrypt('x', key)), true);
});

await test('中文与特殊字符都能还原', () => {
  for (const s of ['密码123', 'a:b:c', '{"json":"内嵌"}', 'emoji🔐test', 'x'.repeat(150)]) {
    assert.equal(decrypt(encrypt(s, key), key), s);
  }
});

// ---------------------------------------------------------------- 密钥文件

await test('密钥文件：首次创建，之后复用', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'key-'));
  assert.equal(hasKey(dir), false);
  const k1 = loadOrCreateKey(dir);
  assert.equal(k1.length, 32);
  assert.equal(hasKey(dir), true);
  const k2 = loadOrCreateKey(dir);
  assert.deepEqual(k1, k2, '第二次应读到同一把密钥');
});

await test('密钥文件损坏时报错，不静默覆盖', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'badkey-'));
  fs.writeFileSync(path.join(dir, 'secret.key'), Buffer.alloc(5));
  assert.throws(() => loadOrCreateKey(dir), /长度异常/, '损坏的密钥必须报错，不能悄悄换一把');
});

await test('密钥文件与数据分开：拷走 state.json 没用', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'sep-'));
  const k = loadOrCreateKey(dir);
  const enc = encrypt('topsecret', k);
  // 模拟"只拿 state.json 里的密文"：没有 key 文件就解不开
  const otherDir = fs.mkdtempSync(path.join(tmpRoot, 'other-'));
  const otherKey = loadOrCreateKey(otherDir);
  assert.equal(decrypt(enc, otherKey), '', '换机器（不同密钥）读不到口令');
});

// ---------------------------------------------------------------- 真实 store 落盘

await test('state.json 里绝不出现明文口令（真实落盘验证）', async () => {
  const { store } = await import('../src/store.js');
  const k = loadOrCreateKey(path.join(tmpRoot, 'keystore-'));
  store.useSecretsKey(k);

  const PASSWORD = 'fixture-password';
  const r = store.addSite({
    name: '测试系统',
    baseUrl: 'https://example.com',
    account: 'someone@example.com',
    password: PASSWORD,
    auth: { loginPath: '/api/auth/login' },
  });
  assert.ok(!r.error, r.error);

  // 1. 内存里读出的是明文（runtime 要用）
  const readBack = store.siteList().find((s) => s.id === r.site.id);
  assert.equal(readBack.password, PASSWORD, '业务层应该拿到明文');

  // 2. state 对象里是密文
  const inState = store.state.sites.find((s) => s.id === r.site.id);
  assert.ok(isEncrypted(inState.password), 'state 里必须是密文');
  assert.ok(!inState.password.includes(PASSWORD), 'state 里不能有明文');

  // 3. 真正落盘的文件里也不能有明文
  store.saveNow();
  const stateFile = path.join(tmpRoot, 'state.json');
  if (fs.existsSync(stateFile)) {
    const raw = fs.readFileSync(stateFile, 'utf8');
    assert.ok(!raw.includes(PASSWORD), `落盘文件里出现了明文口令！`);
    assert.ok(raw.includes('enc:v1:'), '落盘文件里应有密文标记');
  }
});

await test('修改口令后仍是密文', async () => {
  const { store } = await import('../src/store.js');
  const sites = store.siteList();
  const target = sites[0];
  assert.ok(target, '前面应已建过一个站点');

  const NEW_PW = 'changed-pw-999';
  const r = store.updateSite(target.id, { password: NEW_PW });
  assert.ok(!r.error, r.error);

  assert.equal(store.siteList()[0].password, NEW_PW, '读出应是新明文');
  const inState = store.state.sites.find((s) => s.id === target.id);
  assert.ok(isEncrypted(inState.password), '改完仍必须是密文');
  assert.ok(!inState.password.includes(NEW_PW));
});

await test('历史明文会在启动时自动迁成密文', async () => {
  const { store } = await import('../src/store.js');
  // 造一条"老版本留下的明文"
  const legacyPw = 'legacy-plain-777';
  store.state.sites = [
    {
      id: 'site_legacy',
      name: '老系统',
      baseUrl: 'https://legacy.example.com',
      account: 'old@example.com',
      password: legacyPw, // 明文
      auth: { kind: 'json', loginPath: '/api/login', accountField: 'account', passwordField: 'password', tokenPath: 'token', header: 'Authorization', scheme: 'Bearer' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  const key2 = loadOrCreateKey(path.join(tmpRoot, 'migrate-'));
  store.useSecretsKey(key2); // 触发迁移

  const after = store.state.sites.find((s) => s.id === 'site_legacy');
  assert.ok(isEncrypted(after.password), '迁移后必须是密文');
  assert.ok(!after.password.includes(legacyPw));
  assert.equal(store.siteList()[0].password, legacyPw, '迁移后仍要能读出正确明文');
});

console.log(`\n口令加密测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
