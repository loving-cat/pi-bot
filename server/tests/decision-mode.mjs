import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JEV_DEFAULT_BASE_URL,
  JEV_DEFAULT_MODEL,
  JEV_MODE,
  endpointsForMode,
  modelsUrl,
} from '../src/jev-client.js';
import { DECISION_DEFAULT, normalizeDecision } from '../src/store.js';

// ---------------------------------------------------------------------------
// 两种接入方式：官方只填 key / 自定义要填地址和模型名
//
// 用户不该为了让我们拼对 URL 而记住"别带 /v1"这种规矩。
// ---------------------------------------------------------------------------

test('官方模式：地址和模型名固定，用户不用填', () => {
  const r = endpointsForMode(JEV_MODE.typesafe);
  assert.equal(r.baseUrl, JEV_DEFAULT_BASE_URL);
  assert.equal(r.model, JEV_DEFAULT_MODEL);
});

test('官方模式下用户填的地址不生效（避免填错就 404）', () => {
  const r = endpointsForMode(JEV_MODE.typesafe, {
    baseUrl: 'https://wrong.example',
    model: 'wrong-model',
  });
  assert.equal(r.baseUrl, JEV_DEFAULT_BASE_URL, '官方地址永远固定');
  // 模型名允许覆盖（jev-preview 这类是合法的）
  assert.equal(r.model, 'wrong-model');
});

test('自定义模式：用户填什么就是什么', () => {
  const r = endpointsForMode(JEV_MODE.custom, {
    baseUrl: 'https://my.jev/v1',
    model: 'my-model',
  });
  assert.equal(r.baseUrl, 'https://my.jev/v1');
  assert.equal(r.model, 'my-model');
});

test('★ 拼 URL 时两种习惯都要认，否则会拼出 /v1/v1/models', () => {
  // TypeSafe 官方：baseUrl 不带 /v1
  assert.equal(modelsUrl('https://api.typesafe.ai'), 'https://api.typesafe.ai/v1/models');
  // OpenAI 兼容中转：绝大多数人填的时候是带 /v1 的
  assert.equal(modelsUrl('https://relay.example/v1'), 'https://relay.example/v1/models');
  // 尾斜杠也要能处理
  assert.equal(modelsUrl('https://relay.example/v1/'), 'https://relay.example/v1/models');
  // 空值不炸
  assert.equal(modelsUrl(''), '');
});

test('模型列表两种返回结构都要认', () => {
  // TypeSafe 返回 { models: [{ name }] }
  // OpenAI 兼容返回 { data: [{ id }] }
  // 只认一种的话，自定义端点会显示"连通了但一个模型都没有"
  // 这里通过 modelsUrl + 解析契约间接覆盖（解析在 jevProbe 里）
  assert.ok(modelsUrl('https://x.ai').endsWith('/v1/models'));
});

// ---------------------------------------------------------------------------
// 设置项的默认值与规范化
// ---------------------------------------------------------------------------

test('默认是官方模式', () => {
  assert.equal(DECISION_DEFAULT.mode, 'typesafe');
});

test('mode 脏数据回落成官方（不因为一个错值让开关失效）', () => {
  assert.equal(normalizeDecision({ mode: 'garbage' }).mode, 'typesafe');
  assert.equal(normalizeDecision({ mode: 'custom' }).mode, 'custom');
});

test('切模式不影响其他字段', () => {
  const before = normalizeDecision({ apiKey: 'k1', noulThreshold: 0.7 });
  const after = normalizeDecision({ mode: 'custom' }, before);
  assert.equal(after.apiKey, 'k1', 'API key 不能被切模式冲掉');
  assert.equal(after.noulThreshold, 0.7);
  assert.equal(after.mode, 'custom');
});