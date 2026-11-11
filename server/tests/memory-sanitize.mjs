/**
 * 记忆摘要写入脱敏 + 失败不覆盖旧摘要。
 *
 * 背景：摘要是长期留存、跨会话复用的。模型总结时可能把对话里的邮箱、
 * 令牌原文带进来，一旦落盘就会反复被读取。所以在写入前抹掉。
 *
 * 两条底线：
 *   · 抹掉真凭据（邮箱、私钥块、Bearer、赋值式 key/secret）
 *   · 不误杀正常用语（"token 预算"、"最大 token 数"）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mem-san-'));
process.env.PI_BOT_HOME = home;
process.env.PI_BOT_WORKSPACE = path.join(home, 'ws');

const { store } = await import('../src/store.js');
const { sanitizeMemoryText } = await import('../src/memory-sanitize.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

const REDACTED = '[已脱敏]';

await test('sanitizeMemoryText：邮箱被抹掉', () => {
  const out = sanitizeMemoryText('有问题联系 analyst@example.com 谢谢');
  assert.ok(!out.includes('analyst@example.com'), '邮箱没被抹掉');
  assert.ok(out.includes(REDACTED));
});

await test('sanitizeMemoryText：PEM 私钥块被抹掉', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
  const out = sanitizeMemoryText(`这里是配置：\n${pem}\n结束`);
  assert.ok(!out.includes('MIIEow'), '私钥内容没被抹掉');
  assert.ok(out.includes(REDACTED));
});

await test('sanitizeMemoryText：Bearer 令牌被抹掉', () => {
  const out = sanitizeMemoryText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secretpart');
  assert.ok(!out.includes('secretpart'), 'Bearer 令牌没被抹掉');
});

await test('sanitizeMemoryText：赋值式 api_key / secret / password 被抹掉', () => {
  assert.ok(!sanitizeMemoryText('api_key = sk-live-1234567890').includes('sk-live'));
  assert.ok(!sanitizeMemoryText('access_token: abcdefgh12345').includes('abcdefgh'));
  assert.ok(!sanitizeMemoryText('password: hunter2xyz').includes('hunter2xyz'));
  assert.ok(!sanitizeMemoryText('client_secret="s3cr3t-value-here"').includes('s3cr3t'));
});

await test('★ 正常用语不能被误删：token 预算 / 最大 token 数', () => {
  const a = 'token 预算控制在 8000 以内';
  const b = '最大 token 数不要超过上下文窗口';
  const c = 'secret 配置项在设置页里';
  assert.equal(sanitizeMemoryText(a), a, '「token 预算」被误删');
  assert.equal(sanitizeMemoryText(b), b, '「最大 token 数」被误删');
  assert.equal(sanitizeMemoryText(c), c, '「secret 配置项」被误删');
});

await test('正常业务数据不受影响', () => {
  const text = '1) 上期收益 12.5%\n2) 持仓 3 只，其中 C05 已恢复 404 口径';
  assert.equal(sanitizeMemoryText(text), text);
});

await test('★ setMemorySummary 写入后，读回不含原文', () => {
  const room = 'san_room_1';
  const bot = 'san_bot_1';
  store.setMemorySummary(room, bot, {
    text: '用户邮箱 user@corp.example，令牌 api_key = sk-abcdef1234567890',
    lastId: 'm1',
    count: 1,
  });
  const got = store.memorySummaryFor(room, bot);
  assert.ok(got, '摘要应该写入成功');
  assert.ok(!got.text.includes('user@corp.example'), '邮箱原文漏进摘要');
  assert.ok(!got.text.includes('sk-abcdef'), '令牌原文漏进摘要');
  assert.ok(got.text.includes(REDACTED), '应出现脱敏标记');
  // 包形状不变
  assert.equal(got.lastId, 'm1');
  assert.equal(got.count, 1);
  assert.ok(got.at > 0);
});

await test('★ 脱敏器抛异常时不写入，保留旧摘要', () => {
  const room = 'san_room_2';
  const bot = 'san_bot_2';
  store.setMemorySummary(room, bot, { text: '原始结论：收益 12.5%', lastId: 'old', count: 5 });
  const before = store.memorySummaryFor(room, bot);
  assert.equal(before.text, '原始结论：收益 12.5%');

  // 让脱敏器爆炸：塞一个 toString 会抛的对象
  const bomb = {
    toString() {
      throw new Error('boom');
    },
  };
  const after = store.setMemorySummary(room, bot, {
    text: bomb,
    lastId: 'new',
    count: 9,
  });
  const still = store.memorySummaryFor(room, bot);
  assert.equal(still.text, '原始结论：收益 12.5%', '旧摘要被覆盖了');
  assert.equal(still.lastId, 'old', 'lastId 被覆盖了');
  assert.equal(after.text, '原始结论：收益 12.5%');
});

await test('不同 room/bot 的摘要互不可见', () => {
  store.setMemorySummary('iso_room_a', 'iso_bot_a', { text: 'A 的秘密', lastId: 'x', count: 1 });
  assert.ok(store.memorySummaryFor('iso_room_a', 'iso_bot_a'));
  assert.equal(store.memorySummaryFor('iso_room_a', 'iso_bot_b'), null);
  assert.equal(store.memorySummaryFor('iso_room_b', 'iso_bot_a'), null);
});

await test('开新会话清房间摘要的行为不变', () => {
  store.setMemorySummary('reset_room', 'reset_bot', { text: '会被清掉', lastId: 'y', count: 2 });
  assert.ok(store.memorySummaryFor('reset_room', 'reset_bot'));
  store.clearMemorySummariesForRoom('reset_room');
  assert.equal(store.memorySummaryFor('reset_room', 'reset_bot'), null);
});

console.log(`\n记忆摘要脱敏：${passed}/${passed} 通过`);
fs.rmSync(home, { recursive: true, force: true });
