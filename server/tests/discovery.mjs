/**
 * 局域网发现（UDP 广播）测试。
 *
 * 这一层最容易出的错是"看起来回了、其实手机收不到"，所以用真 UDP socket 跑：
 * 起应答器 → 从 127.0.0.1 发探针 → 断言收到 JSON，且里面是手机该看到的字段。
 *
 * 覆盖：
 *   · 探针格式不对 / 是垃圾包 → 一个字都不回（不能当端口扫描器的望远镜）；
 *   · 应答里绝不能有配对码；
 *   · 同一个来源连发两次 → 第二次被节流（手机上连点"重新搜索"不会打爆主机）；
 *   · 关掉开关（PI_BOT_DISCOVERY=0）→ 不起 socket。
 */
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { PROBE_TYPE, ANNOUNCE_TYPE, PROTOCOL_VERSION, isProbe, buildAnnouncement, startDiscovery } from '../src/discovery.js';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

/** 发一个探针，收集 timeout 内的应答。 */
function probe(port, payload, { timeout = 700 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const replies = [];
    socket.on('message', (buf) => replies.push(JSON.parse(buf.toString('utf8'))));
    socket.bind(0, '127.0.0.1', () => {
      const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      socket.send(data, port, '127.0.0.1');
    });
    setTimeout(() => {
      socket.close();
      resolve(replies);
    }, timeout);
  });
}

const announce = { name: '我的 Mac', hostname: 'xls-mbp', version: '1.4.1', port: 8787, pairing: true };

await test('探针格式：只认 {"t":"pibot.discover"}', () => {
  assert.equal(isProbe(Buffer.from(JSON.stringify({ t: PROBE_TYPE }))), true);
  assert.equal(isProbe(Buffer.from('hello')), false);
  assert.equal(isProbe(Buffer.from(JSON.stringify({ t: 'other' }))), false);
  assert.equal(isProbe(Buffer.alloc(0)), false);
  assert.equal(isProbe(Buffer.alloc(2000)), false, '超大包直接丢');
});

await test('应答字段：名字/机器名/版本/地址都在，且不含配对码', () => {
  const a = buildAnnouncement({ ...announce });
  assert.equal(a.t, ANNOUNCE_TYPE);
  assert.equal(a.v, PROTOCOL_VERSION);
  assert.equal(a.name, '我的 Mac');
  assert.equal(a.hostname, 'xls-mbp');
  assert.equal(a.version, '1.4.1');
  assert.equal(a.port, 8787);
  // urls 由网卡实际地址算出来，不靠传参：每一条都得是 http://<ip>:<port>
  for (const url of a.urls) assert.match(url, /^http:\/\/\d+\.\d+\.\d+\.\d+:8787$/);
  assert.equal(a.pairing, true);
  assert.equal(a.approve, true, '要告诉手机这台主机支持"请求连接"');
  assert.equal(JSON.stringify(a).includes('code'), false, '应答里不能出现配对码字段');
});

await test('真 UDP：发探针能收到一台主机的应答', async () => {
  const responder = await startDiscovery({ port: 0, enabled: true, announcement: () => buildAnnouncement({ ...announce }), logLine: () => {} });
  assert.ok(responder, '应答器应该起来（端口 0 = 随便挑一个）');
  try {
    const replies = await probe(responder.port, { t: PROBE_TYPE, v: 1 });
    assert.equal(replies.length, 1, `应回 1 个包，实际 ${replies.length}`);
    assert.equal(replies[0].t, ANNOUNCE_TYPE);
    assert.equal(replies[0].name, '我的 Mac');
    assert.equal(replies[0].port, 8787);
  } finally {
    await responder.close();
  }
});

await test('真 UDP：垃圾包 / 别的类型 → 不回', async () => {
  const responder = await startDiscovery({ port: 0, enabled: true, announcement: () => buildAnnouncement({ ...announce }), logLine: () => {} });
  assert.ok(responder);
  try {
    assert.deepEqual(await probe(responder.port, 'GET / HTTP/1.1'), []);
    assert.deepEqual(await probe(responder.port, { t: 'pibot.something-else' }), []);
  } finally {
    await responder.close();
  }
});

await test('真 UDP：同一来源 500ms 内只回一次（防连点打爆主机）', async () => {
  const responder = await startDiscovery({ port: 0, enabled: true, announcement: () => buildAnnouncement({ ...announce }), logLine: () => {} });
  assert.ok(responder);
  const socket = dgram.createSocket('udp4');
  try {
    const replies = [];
    socket.on('message', (buf) => replies.push(buf));
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    const data = Buffer.from(JSON.stringify({ t: PROBE_TYPE }));
    socket.send(data, responder.port, '127.0.0.1');
    socket.send(data, responder.port, '127.0.0.1');
    socket.send(data, responder.port, '127.0.0.1');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(replies.length, 1, `应只回 1 次，实际 ${replies.length}`);
  } finally {
    socket.close();
    await responder.close();
  }
});

await test('开关关掉（PI_BOT_DISCOVERY=0）→ 根本不起 socket', async () => {
  const responder = await startDiscovery({ port: 0, enabled: false, logLine: () => {} });
  assert.equal(responder, null);
});

await test('端口被人占了 → 返回 null，不抛（服务端照常起）', async () => {
  const blocker = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve) => blocker.bind(0, '0.0.0.0', resolve));
  const busyPort = blocker.address().port;
  try {
    // reuseAddr: true 的发现 socket 在 Windows 上可能仍抢到端口，
    // 所以这里只断言"不会抛"，并且返回值就是 null 或一个能关掉的对象。
    const responder = await startDiscovery({ port: busyPort, enabled: true, logLine: () => {} });
    if (responder) await responder.close();
  } finally {
    blocker.close();
  }
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
