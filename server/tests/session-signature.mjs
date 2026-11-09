/**
 * 会话缓存签名：改了工具或提示词，老会话必须重建。
 *
 * 这是「天使用户升级后看不到新功能」的防线 —— 会话按 roomId:botId 缓存复用，
 * 签名不变就一直用旧的，新工具根本不加载，而且没有任何报错。
 */
import assert from 'node:assert/strict';

const { roleConfigurationKey, SESSION_TOOLS_VERSION } =
  await import('../src/role-tools.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

const room = { kind: 'group', botIds: ['b1', 'b2'], leadBotId: 'b1' };
const bot = { role: 'lead' };

test('★ 签名里带工具集版本', () => {
  const key = roleConfigurationKey(room, bot);
  const parsed = JSON.parse(key);
  assert.equal(
    parsed[parsed.length - 1],
    SESSION_TOOLS_VERSION,
    '版本号必须在签名里，否则改工具后老会话不会重建',
  );
});

test('★ 改了工具版本 → 签名变化 → 老会话重建', () => {
  // 模拟升级前后：房间和成员都没变，只有版本号不同
  const before = JSON.stringify(['lead', 'group', 'b1', ['b1', 'b2'], 1]);
  const after = roleConfigurationKey(room, bot);
  assert.notEqual(before, after, '版本变了签名必须跟着变');
});

test('房间/成员变化仍然能触发重建', () => {
  const a = roleConfigurationKey(room, bot);
  const b = roleConfigurationKey({ ...room, botIds: ['b1', 'b2', 'b3'] }, bot);
  assert.notEqual(a, b, '加成员必须重建');

  const c = roleConfigurationKey({ ...room, kind: 'dm' }, bot);
  assert.notEqual(a, c, '群变私聊必须重建');

  const d = roleConfigurationKey(room, { role: 'member' });
  assert.notEqual(a, d, '角色变化必须重建');
});

test('配置没变时签名稳定（避免无谓重建）', () => {
  const a = roleConfigurationKey(room, bot);
  const b = roleConfigurationKey({ ...room }, { ...bot });
  assert.equal(a, b, '同样的配置必须得到同样的签名');
});

test('成员顺序不影响签名（同一批人以不同顺序传入视为相同）', () => {
  const a = roleConfigurationKey({ ...room, botIds: ['b2', 'b1'] }, bot);
  const b = roleConfigurationKey({ ...room, botIds: ['b1', 'b2'] }, bot);
  assert.equal(a, b, '成员排序后再进签名，顺序变化不该触发重建');
});

console.log(`\n会话签名：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
