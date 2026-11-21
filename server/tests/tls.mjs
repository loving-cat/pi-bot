/**
 * 自签证书 + TLS 监听的测试。
 *
 * 这块没有"看起来对就行"的余地：证书拼错一个字节，客户端握手直接失败，而失败只表现成
 * "连不上"。所以这里用真的 X509 解析器和真的 TLS 握手去验：
 *   · 证书能被 node:crypto 解析出 subject / SAN / 有效期；
 *   · SAN 里必须有本机局域网 IP（手机就是按 IP 连的，缺了就会被拒）；
 *   · 指纹是证书 DER 的 sha256，且换一张证书就变；
 *   · 网卡地址变了要重签（不然新 IP 连不上）；
 *   · https 服务真的能握手，且默认校验会拒绝自签（证明"必须固定指纹"）。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const {
  createSelfSignedCertificate,
  certificateIps,
  fingerprintOf,
  ensureTlsMaterial,
  tlsOptions,
  derIntegerBytes,
} = await import('../src/tls.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.message || err}`);
    fail++;
  }
}

const made = createSelfSignedCertificate({ commonName: 'pi-bot', ips: ['192.168.1.7', '10.0.0.5'] });

await test('证书能被标准解析器读懂（subject / CA=false / 有效期 10 年）', () => {
  const parsed = new crypto.X509Certificate(made.certPem);
  assert.match(parsed.subject, /CN=pi-bot/);
  assert.equal(parsed.ca, false, '不该是 CA 证书');
  const days = (new Date(parsed.validTo) - new Date(parsed.validFrom)) / 86_400_000;
  assert.ok(days > 3600, `有效期应该够长（实际 ${Math.round(days)} 天）`);
});

await test('SAN 里必须有每个局域网 IP（少一个，那个网段的手机就连不上）', () => {
  const parsed = new crypto.X509Certificate(made.certPem);
  const san = parsed.subjectAltName ?? '';
  assert.match(san, /IP Address:192\.168\.1\.7/);
  assert.match(san, /IP Address:10\.0\.0\.5/);
  assert.match(san, /IP Address:127\.0\.0\.1/);
  assert.match(san, /DNS:localhost/);
  assert.deepEqual(new Set(certificateIps(made.certPem)), new Set(['127.0.0.1', '192.168.1.7', '10.0.0.5']));
});

await test('指纹 = 证书 DER 的 sha256；两张不同证书指纹不同', () => {
  const parsed = new crypto.X509Certificate(made.certPem);
  assert.equal(fingerprintOf(made.certPem), crypto.createHash('sha256').update(parsed.raw).digest('hex'));
  const other = createSelfSignedCertificate({ commonName: 'pi-bot', ips: [] });
  assert.notEqual(other.fingerprint, made.fingerprint);
});

// ---------------------------------------------------------------------------
// DER INTEGER 最小编码（X.690 §8.3.2）
//
// ★ 这里以前有个 1/256 概率的真 bug：序列号 `randomBytes(16)` 只做了
//   `serial[0] &= 0x7f`，首字节正好是 0x00 且次字节 < 0x80 时，签出来的证书
//   带非法前导零 —— OpenSSL 3 解析直接抛 ERR_OSSL_ASN1_ILLEGAL_PADDING，
//   表现是“证书文件在、客户端就是连不上”。而且只在重签那一刻才炸，平时完全看不出。
// ---------------------------------------------------------------------------
await test('★ DER 正整数：剥掉多余前导零，必要时才补一个 0x00', () => {
  assert.deepEqual([...derIntegerBytes(Buffer.from([0x00, 0x01, 0x02]))], [0x01, 0x02], '多写的前导零必须剥掉');
  assert.deepEqual([...derIntegerBytes(Buffer.from([0x00, 0x00, 0x7f]))], [0x7f]);
  assert.deepEqual([...derIntegerBytes(Buffer.from([0x00, 0x80]))], [0x00, 0x80], '次字节最高位为 1 时那个 0 是必须的，不能剥');
  assert.deepEqual([...derIntegerBytes(Buffer.from([0x80]))], [0x00, 0x80], '最高位为 1 会被当负数 → 补 0x00');
  assert.deepEqual([...derIntegerBytes(Buffer.from([0x00]))], [0x00], '零就是单个 0x00');
  assert.deepEqual([...derIntegerBytes(Buffer.alloc(0))], [0x00]);
  assert.deepEqual([...derIntegerBytes(2n)], [0x02]);
  assert.deepEqual([...derIntegerBytes(0n)], [0x00]);
  assert.deepEqual([...derIntegerBytes(0x80n)], [0x00, 0x80]);
});

await test('★ 序列号首字节 0x00：签出来的证书必须是合法 DER（以前 1/256 概率炸）', () => {
  const { keyPem } = createSelfSignedCertificate({ ips: ['10.0.0.1'] });
  for (let second = 0; second < 0x40; second += 1) {
    const serial = Buffer.alloc(16, 0);
    serial[1] = second;
    const cert = createSelfSignedCertificate({ ips: ['10.0.0.1'], keyPem, serial });
    const parsed = new crypto.X509Certificate(cert.certPem); // 非法 DER 会在这里抛
    const expected = second === 0 ? '0' : serial.subarray(1).toString('hex');
    assert.equal(
      parsed.serialNumber.toLowerCase(),
      expected,
      `序列号 ${serial.toString('hex')} 的前导零没按 DER 规则处理`,
    );
  }
});

await test('★ 默认随机序列号：判到 64 张都合法（首字节强制 0x40–0x7f）', () => {
  const { keyPem } = createSelfSignedCertificate({ ips: ['10.0.0.1'] });
  for (let i = 0; i < 64; i += 1) {
    const cert = createSelfSignedCertificate({ ips: ['10.0.0.1'], keyPem });
    const parsed = new crypto.X509Certificate(cert.certPem);
    const hex = parsed.serialNumber.toLowerCase();
    assert.ok(hex.length <= 34, `序列号长度异常：${hex}`);
    assert.ok(!hex.startsWith('0000'), `出现了非法前导零：${hex}`);
    assert.ok(/^[4-7][0-9a-f]/.test(hex), `默认序列号首字节应落在 0x40–0x7f，实际 ${hex.slice(0, 2)}`);
  }
});

await test('真握手：https 服务能起来，客户端拿到的是同一个指纹', async () => {
  const server = https.createServer(tlsOptions({ certPem: made.certPem, keyPem: made.keyPem }), (req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  try {
    const port = server.address().port;
    const result = await new Promise((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (res) => {
        const peer = res.socket.getPeerCertificate();
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, fingerprint: peer?.fingerprint256 }));
      });
      req.on('error', reject);
    });
    assert.equal(result.status, 200);
    assert.equal(result.fingerprint.replace(/:/g, '').toLowerCase(), made.fingerprint);
  } finally {
    server.close();
  }
});

await test('默认校验会拒绝自签 —— 这正是客户端必须固定指纹的原因', async () => {
  const server = https.createServer(tlsOptions({ certPem: made.certPem, keyPem: made.keyPem }), (req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const outcome = await new Promise((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: true }, () => {
        resolve({ authorized: true });
        socket.end();
      });
      socket.on('error', (err) => resolve({ error: err.code }));
    });
    assert.equal(outcome.error, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  } finally {
    server.close();
  }
});

await test('ensureTlsMaterial：首次生成、第二次复用（指纹不变）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-tls-'));
  try {
    const first = ensureTlsMaterial({ dir });
    const second = ensureTlsMaterial({ dir });
    assert.equal(first.fingerprint, second.fingerprint, '没换网卡就该复用同一张证书');
    assert.ok(fs.existsSync(path.join(dir, 'key.pem')));
    assert.ok(fs.existsSync(path.join(dir, 'cert.pem')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('★ ensureTlsMaterial：换网卡/换 WiFi **不重签**（指纹不变，配对不被踢）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-tls-'));
  try {
    // 客户端固定的是整张证书 DER 的 sha256（见 app/lib/pinned_http.dart），
    // 所以任何一次重签都会让所有已配对设备连不上 —— 网卡变了也不许动它。
    const first = ensureTlsMaterial({ dir, ips: ['10.0.0.5'] });
    const second = ensureTlsMaterial({ dir, ips: ['10.0.0.5', '10.0.0.9', '192.168.1.7'] });
    assert.equal(
      first.fingerprint,
      second.fingerprint,
      '新增网卡地址不该触发重签：那会让用户换个 WiFi 就要重新配对',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('ensureTlsMaterial：显式 forceRotate 才换证（指纹变）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-tls-'));
  try {
    const first = ensureTlsMaterial({ dir, ips: ['10.0.0.5'] });
    const rotated = ensureTlsMaterial({ dir, ips: ['10.0.0.5'], forceRotate: true });
    assert.notEqual(rotated.fingerprint, first.fingerprint, '强制换证必须真的换');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('ensureTlsMaterial：临期（剩余 < 30 天）才自动重签', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-tls-'));
  try {
    // 造一张只剩 5 天的证书，模拟"用久了快过期"
    const shortLived = createSelfSignedCertificate({ commonName: 'pi-bot', ips: ['10.0.0.5'], days: 5 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cert.pem'), shortLived.certPem);
    fs.writeFileSync(path.join(dir, 'key.pem'), shortLived.keyPem);
    const logs = [];
    const fresh = ensureTlsMaterial({ dir, ips: ['10.0.0.5'], log: (line) => logs.push(line) });
    assert.notEqual(fresh.fingerprint, shortLived.fingerprint, '快过期就该换');
    assert.ok(logs.some((line) => line.includes('重签')), '重签要留一行日志，别静默');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
