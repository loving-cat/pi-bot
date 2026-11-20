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
