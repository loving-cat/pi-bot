/**
 * 连接请求（附近设备 → 电脑上弹窗允许）的规则测试。
 *
 * 这块是"谁能拿到 token"的入口，所以逐条钉死：
 *   · 没人批 → 拿不到 token，会过期；
 *   · 批了 → token 只交付一次，第二次轮询拿不到；
 *   · 拒了 → 状态如实、不发 token；
 *   · 同一个 IP 刷请求 → 被限速；
 *   · 待批太多 → 直接拒，不让电脑被弹窗淹掉。
 */
import assert from 'node:assert/strict';

import { createPairRequests, REQUEST_TTL_MS, MAX_PENDING, MAX_PER_IP_PER_MINUTE } from '../src/pair-requests.js';

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

/** 可控时钟 + 记录发出的设备名与事件 */
function harness({ ttlMs = REQUEST_TTL_MS } = {}) {
  let clock = 1_700_000_000_000;
  const events = [];
  const issued = [];
  const requests = createPairRequests({
    ttlMs,
    now: () => clock,
    emit: (e) => events.push(e),
    addDevice: (name) => {
      issued.push(name);
      return { token: `tok-${issued.length}`, device: { id: `d_${issued.length}`, name } };
    },
    describeServer: () => ({ serverName: 'pi-bot', workspace: '/work' }),
  });
  return {
    requests,
    events,
    issued,
    tick: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

test('发起请求：状态 pending，事件里带设备名和来源 IP', () => {
  const h = harness();
  const view = h.requests.create({ device: '我的手机', platform: 'android', ip: '192.168.1.30' });
  assert.equal(view.status, 'pending');
  assert.match(view.id, /^[a-f0-9]{32}$/, 'id 必须是 128 位随机数（它本身就是凭证）');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].t, 'pair.request');
  assert.equal(h.events[0].request.device, '我的手机');
  assert.equal(h.events[0].request.ip, '192.168.1.30');
  assert.equal(h.events[0].request.token, undefined, '事件里绝不能带 token');
});

test('没人批 → 过一会儿就 expired，拿不到 token', () => {
  const h = harness({ ttlMs: 1000 });
  const view = h.requests.create({ device: '手机', ip: '10.0.0.2' });
  h.tick(1500);
  const polled = h.requests.poll(view.id);
  assert.equal(polled?.status, 'expired');
  assert.equal(polled.token, undefined);
  assert.equal(h.issued.length, 0, '没人批就不该签发任何设备');
});

test('电脑上点了允许 → 轮询拿到 token，而且只有一次', () => {
  const h = harness();
  const view = h.requests.create({ device: '我的手机', ip: '192.168.1.30' });
  const decided = h.requests.decide(view.id, true);
  assert.equal(decided.ok, true);
  assert.equal(decided.status, 'approved');
  assert.deepEqual(h.issued, ['我的手机'], '签发的设备名就是手机上填的名字');

  const first = h.requests.poll(view.id);
  assert.equal(first.status, 'approved');
  assert.equal(first.token, 'tok-1');
  assert.equal(first.serverName, 'pi-bot');
  assert.equal(first.workspace, '/work');

  const second = h.requests.poll(view.id);
  assert.equal(second.status, 'approved');
  assert.equal(second.token, undefined, '同一个 id 不能第二次拿到 token');
});

test('拒绝 → 状态 denied，不发 token，也不能再改主意', () => {
  const h = harness();
  const view = h.requests.create({ device: '手机', ip: '10.0.0.3' });
  assert.equal(h.requests.decide(view.id, false).status, 'denied');
  const polled = h.requests.poll(view.id);
  assert.equal(polled.status, 'denied');
  assert.equal(polled.token, undefined);
  assert.equal(h.requests.decide(view.id, true).code, 'PAIR_REQUEST_ALREADY_DECIDED');
  assert.equal(h.issued.length, 0);
});

test('不存在的 id → poll 返回 null、decide 报 NOT_FOUND', () => {
  const h = harness();
  assert.equal(h.requests.poll('0'.repeat(32)), null);
  assert.equal(h.requests.decide('0'.repeat(32), true).code, 'PAIR_REQUEST_NOT_FOUND');
});

test('同一个 IP 一分钟内刷请求 → 被限速', () => {
  const h = harness();
  for (let i = 0; i < MAX_PER_IP_PER_MINUTE; i++) {
    h.requests.create({ device: `手机${i}`, ip: '10.0.0.9' });
  }
  assert.throws(
    () => h.requests.create({ device: '手机X', ip: '10.0.0.9' }),
    (err) => err.code === 'PAIR_REQUEST_RATE_LIMITED',
  );
  // 换一个 IP 立刻可以（不同的人/设备）—— 但要先腾出待批名额，
  // 否则撞到的是"待批太多"而不是限速（两条闸本来就该各自独立生效）
  h.requests.decide(h.requests.pending()[0].id, false);
  assert.equal(h.requests.create({ device: '另一台', ip: '10.0.0.10' }).status, 'pending');
  // 过一分钟后恢复
  // 一分钟后：限速窗口滑过去了，旧的待批也都过期了（默认 TTL 60 秒）
  h.tick(61_000);
  assert.equal(h.requests.create({ device: '手机Y', ip: '10.0.0.9' }).status, 'pending');
});

test('待批太多 → 直接拒（不让电脑被弹窗淹掉）', () => {
  const h = harness();
  for (let i = 0; i < MAX_PENDING; i++) {
    h.requests.create({ device: `手机${i}`, ip: `10.0.1.${i}` });
  }
  assert.throws(
    () => h.requests.create({ device: '多出来的', ip: '10.0.1.99' }),
    (err) => err.code === 'PAIR_REQUEST_BUSY',
  );
});

test('待批列表：只列 pending，批过的消失', () => {
  const h = harness();
  const a = h.requests.create({ device: 'A', ip: '10.0.2.1' });
  h.requests.create({ device: 'B', ip: '10.0.2.2' });
  assert.equal(h.requests.pending().length, 2);
  h.requests.decide(a.id, true);
  const left = h.requests.pending();
  assert.equal(left.length, 1);
  assert.equal(left[0].device, 'B');
});

test('过期很久的请求会被清掉，不会一直占着待批名额', () => {
  const h = harness({ ttlMs: 1000 });
  for (let i = 0; i < MAX_PENDING; i++) {
    h.requests.create({ device: `手机${i}`, ip: `10.0.3.${i}` });
  }
  h.tick(10 * 60_000);
  assert.equal(h.requests.create({ device: '新来的', ip: '10.0.3.99' }).status, 'pending');
});

test('设备名过长/为空都被收拾干净', () => {
  const h = harness();
  const long = h.requests.create({ device: 'x'.repeat(200), ip: '10.0.4.1' });
  assert.equal(long.device.length, 60);
  const empty = h.requests.create({ device: '   ', ip: '10.0.4.2' });
  assert.equal(empty.device, '一台手机');
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
