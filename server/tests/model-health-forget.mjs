import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// 健康结论是针对某份凭证的：换 key / 改 baseUrl 之后，
// 旧凭证的失败记录必须作废，否则菜单上那个组会一直标"实测不可用"，
// 主控绕开它、用户以为换了稳定 key 也没用。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-health-'));
process.env.PI_BOT_HOME = tmp;

const { ModelHealth } = await import('../src/model-health.js');

function fresh() {
  const h = new ModelHealth({}, { autoProbe: false });
  h.results = {};
  return h;
}

test('forgetProvider 只清该组，别的组不动', () => {
  const h = fresh();
  h.results = {
    'g1/model-a': { ok: false, ms: 10, error: '401', at: Date.now() },
    'g1/model-b': { ok: true, ms: 10, error: null, at: Date.now() },
    'g2/model-c': { ok: false, ms: 10, error: '429', at: Date.now() },
  };
  const n = h.forgetProvider('g1');
  assert.equal(n, 2);
  assert.deepEqual(Object.keys(h.results), ['g2/model-c']);
});

test('档位组合（slug@level）也算同组，一起清', () => {
  const h = fresh();
  h.results = {
    'g1/model-a@high': { ok: false, ms: 10, error: 'empty', at: Date.now() },
    'g1/model-a': { ok: true, ms: 10, error: null, at: Date.now() },
  };
  assert.equal(h.forgetProvider('g1'), 2);
  assert.equal(Object.keys(h.results).length, 0);
});

test('组名是别组的前缀时不误伤', () => {
  const h = fresh();
  h.results = {
    'g1/model-a': { ok: false, ms: 10, error: 'x', at: Date.now() },
    'g10/model-b': { ok: false, ms: 10, error: 'x', at: Date.now() },
  };
  h.forgetProvider('g1');
  assert.deepEqual(Object.keys(h.results), ['g10/model-b'], 'g10 不是 g1 的子串匹配');
});

test('空组名不清任何东西', () => {
  const h = fresh();
  h.results = { 'g1/a': { ok: false, ms: 1, error: 'x', at: Date.now() } };
  assert.equal(h.forgetProvider(''), 0);
  assert.equal(Object.keys(h.results).length, 1);
});

test('没有该组的记录时返回 0', () => {
  const h = fresh();
  h.results = { 'g2/a': { ok: true, ms: 1, error: null, at: Date.now() } };
  assert.equal(h.forgetProvider('g1'), 0);
});

test('清完之后该模型不再是"已知不可用"', () => {
  const h = fresh();
  h.results = { 'g1/a': { ok: false, ms: 1, error: '401', at: Date.now() } };
  assert.equal(h.isKnownDead('g1/a'), true);
  h.forgetProvider('g1');
  assert.equal(h.isKnownDead('g1/a'), false, '换凭证后不该还判死');
  assert.equal(h.peek('g1/a'), null);
});
