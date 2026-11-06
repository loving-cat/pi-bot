import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// 决策设置存在 state.json 里，key 要加密。
// 这个测试用临时目录，不碰真实的 ~/Library/... 数据。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-decision-'));
process.env.PI_BOT_HOME = tmp;

const { Store, DECISION_DEFAULT, normalizeDecision } = await import('../src/store.js');

// ---------------------------------------------------------------------------
// 默认关着
// ---------------------------------------------------------------------------

test('默认设置是「关闭」—— 不想用的人不该被迫承受延迟和费用', () => {
  assert.equal(DECISION_DEFAULT.enabled, false);
  assert.equal(DECISION_DEFAULT.baseUrl, '');
});

test('默认置信度门槛是 0.75', () => {
  assert.equal(DECISION_DEFAULT.carefulMinConfidence, 0.75);
});

// ---------------------------------------------------------------------------
// 规范化：脏数据不能让它崩
// ---------------------------------------------------------------------------

test('enabled 任何真值都规范成 bool', () => {
  assert.equal(normalizeDecision({ enabled: 'yes' }).enabled, true);
  assert.equal(normalizeDecision({ enabled: 0 }).enabled, false);
});

test('阈值越界被夹紧', () => {
  assert.equal(normalizeDecision({ noulThreshold: 5 }).noulThreshold, 1);
  assert.equal(normalizeDecision({ noulThreshold: -3 }).noulThreshold, 0);
  // 非数字保留默认
  assert.equal(normalizeDecision({ noulThreshold: 'abc' }).noulThreshold, 0.5);
});

test('地址两头空格被去掉', () => {
  assert.equal(normalizeDecision({ baseUrl: '  https://x.ai  ' }).baseUrl, 'https://x.ai');
});

test('disabledPoints 去重且去空', () => {
  const r = normalizeDecision({ disabledPoints: ['a', 'a', ' ', '', 'b'] });
  assert.deepEqual(r.disabledPoints, ['a', 'b']);
});

test('传不认识的字段不会混进结果', () => {
  const r = normalizeDecision({ evil: 'x' });
  assert.equal(r.evil, undefined);
});

// ---------------------------------------------------------------------------
// store 读写
// ---------------------------------------------------------------------------

test('改设置后能读回来', () => {
  const s = new Store();
  s.updateDecision({ enabled: true, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' });
  const d = s.decision();
  assert.equal(d.enabled, true);
  assert.equal(d.baseUrl, 'https://api.typesafe.ai');
  assert.equal(d.model, 'jev-latest');
});

test('★ key 落盘是密文，读出来是明文', () => {
  const s = new Store();
  s.useSecretsKey(Buffer.alloc(32, 7));
  s.updateDecision({ enabled: true, apiKey: 'fixture-credential-decision-key' });

  // 内存里的 state 应该是密文（形如 enc:v1:...）
  const stored = s.state.decision?.apiKey ?? '';
  assert.notEqual(stored, 'fixture-credential-decision-key', '不该明文落盘');
  assert.match(stored, /^enc:/, '应该是加密格式');

  // getter 解出来是明文
  assert.equal(s.decision().apiKey, 'fixture-credential-decision-key');
});

test('没有密钥时 key 保持原样（本地调试不至于用不了）', () => {
  const s = new Store();
  s.updateDecision({ enabled: true, apiKey: 'plain_key' });
  assert.equal(s.decision().apiKey, 'plain_key');
});

test('apiKey 传空字符串表示清掉', () => {
  const s = new Store();
  s.updateDecision({ apiKey: 'k1' });
  assert.equal(s.decision().apiKey, 'k1');
  s.updateDecision({ apiKey: '' });
  assert.equal(s.decision().apiKey, '');
});

test('不传 apiKey 时不动它', () => {
  const s = new Store();
  s.updateDecision({ apiKey: 'k1' });
  s.updateDecision({ enabled: true });
  assert.equal(s.decision().apiKey, 'k1', '改别的字段不该把 key 冲掉');
});

test('decisionRoute 与 decision 内容一致', () => {
  const s = new Store();
  s.updateDecision({ enabled: true, baseUrl: 'https://a.b', apiKey: 'k' });
  const route = s.decisionRoute();
  assert.equal(route.enabled, true);
  assert.equal(route.baseUrl, 'https://a.b');
  assert.equal(route.apiKey, 'k');
});

test('解不开的密文当没配，不拿密文去请求', () => {
  const s = new Store();
  s.useSecretsKey(Buffer.alloc(32, 1));
  s.updateDecision({ enabled: true, apiKey: 'good' });
  // 换一把钥匙 → 旧密文解不开
  s.useSecretsKey(Buffer.alloc(32, 2));
  assert.equal(s.decision().apiKey, '', '解不开要当没配，而不是把密文发出去');
});
