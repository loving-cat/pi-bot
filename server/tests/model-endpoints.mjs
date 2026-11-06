import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_ENDPOINTS,
  ModelGroupStore,
  endpointAt,
  normalizeEndpoints,
  publicEndpoints,
  rotateCursor,
} from '../src/model-groups.js';

// ---------------------------------------------------------------------------
// 多端点：一个模型组可以配多条 baseUrl + key
//
// 用户诉求：key 不稳时「尽可能无感」。
// 最直接的解法不是硬等，而是**后台静默换一条通路**。
// ---------------------------------------------------------------------------

test('老配置自动迁移成单端点，不丢 key', () => {
  // 这一步最关键：不迁移的话，老用户保存一次就丢 key
  const eps = normalizeEndpoints(null, {
    fallbackBaseUrl: 'https://old.example',
    fallbackApiKey: 'old-key',
  });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].baseUrl, 'https://old.example');
  assert.equal(eps[0].apiKey, 'old-key');
});

test('已经有 endpoints 时优先用它', () => {
  const eps = normalizeEndpoints([{ baseUrl: 'https://a', apiKey: 'k1' }], {
    fallbackBaseUrl: 'https://fallback',
    fallbackApiKey: 'fk',
  });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].baseUrl, 'https://a');
});

test('空的 url 条目被丢掉，不留空壳', () => {
  const eps = normalizeEndpoints([
    { baseUrl: 'https://a', apiKey: 'k1' },
    { baseUrl: '   ', apiKey: 'k2' },
    { baseUrl: '', apiKey: 'k3' },
  ]);
  assert.equal(eps.length, 1);
});

test('尾斜杠统一去掉（否则拼出来的 URL 会双斜杠）', () => {
  const eps = normalizeEndpoints([{ baseUrl: 'https://a///', apiKey: 'k' }]);
  assert.equal(eps[0].baseUrl, 'https://a');
});

test('条数有上限，防止塞进来几千条', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    baseUrl: 'https://h' + i, apiKey: 'k' + i,
  }));
  const eps = normalizeEndpoints(many);
  assert.equal(eps.length, MAX_ENDPOINTS);
});

test('endpointAt 按游标取，越界自动取模', () => {
  const eps = [{ baseUrl: 'https://a' }, { baseUrl: 'https://b' }];
  assert.equal(endpointAt(eps, 0).index, 0);
  assert.equal(endpointAt(eps, 1).index, 1);
  assert.equal(endpointAt(eps, 2).index, 0);
  assert.equal(endpointAt(eps, -1).index, 1, '负数也要能定位');
  assert.equal(endpointAt([], 0), null);
});

test('rotateCursor 循环轮转', () => {
  assert.equal(rotateCursor(0, 2), 1);
  assert.equal(rotateCursor(1, 2), 0);
  assert.equal(rotateCursor(0, 3), 1);
  assert.equal(rotateCursor(2, 3), 0);
  // 只有一条时游标照样转，但结果恒为 0 —— 上层不用写特殊分支
  assert.equal(rotateCursor(0, 1), 0);
  assert.equal(rotateCursor(5, 1), 0);
});

test('对外展示一定打码，真 key 不出服务端', () => {
  const pub = publicEndpoints([
    { baseUrl: 'https://a', apiKey: 'fixture-credential-endpoint-key', label: '主' },
    { baseUrl: 'https://b', apiKey: '', label: '' },
  ]);
  assert.equal(pub[0].hasKey, true);
  assert.ok(!pub[0].keyMasked.includes('7890abcdef'), '不能泄露完整 key');
  assert.equal(pub[1].hasKey, false);
  assert.equal(pub[1].keyMasked, '');
});

// ---------------------------------------------------------------------------
// 落盘与加密往返
// ---------------------------------------------------------------------------

test('★ 端点的 key 落盘是密文，读回来是明文', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ep-enc-'));
  try {
    const file = path.join(tmp, 'model-groups.json');
    const s = new ModelGroupStore({ dataDir: tmp });
    s.load();
    s.upsert({
      name: 'T',
      baseUrl: 'https://a.example',
      apiKey: 'k0',
      models: [{ id: 'm', name: 'm' }],
      endpoints: [
        { baseUrl: 'https://a.example', apiKey: 'primary-key' },
        { baseUrl: 'https://b.example', apiKey: 'backup-key', label: '备用' },
      ],
    });
    s.save();

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const ep of raw.groups[0].endpoints) {
      assert.match(String(ep.apiKey), /^enc:/, '落盘必须是密文');
    }

    // 重新载入：解出来是明文
    const s2 = new ModelGroupStore({ dataDir: tmp });
    s2.load();
    const g = s2.list()[0];
    assert.equal(g.endpoints[0].apiKey, 'primary-key');
    assert.equal(g.endpoints[1].apiKey, 'backup-key');
    assert.equal(g.endpoints[1].label, '备用');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('toProviderConfig 能按索引取某条端点（轮转用）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ep-cfg-'));
  try {
    const file = path.join(tmp, 'model-groups.json');
    const s = new ModelGroupStore({ dataDir: tmp });
    s.load();
    s.upsert({
      name: 'T',
      baseUrl: 'https://a.example',
      apiKey: 'k0',
      models: [{ id: 'm', name: 'm' }],
      endpoints: [
        { baseUrl: 'https://a.example', apiKey: 'k1' },
        { baseUrl: 'https://b.example', apiKey: 'k2' },
      ],
    });
    const g = s.list()[0];
    const cfg0 = g.toProviderConfig(0);
    const cfg1 = g.toProviderConfig(1);
    assert.equal(cfg0.baseUrl, 'https://a.example');
    assert.equal(cfg0.apiKey, 'k1');
    assert.equal(cfg1.baseUrl, 'https://b.example');
    assert.equal(cfg1.apiKey, 'k2');
    // 不传索引 = 第一条（保持老行为）
    assert.equal(g.toProviderConfig().baseUrl, 'https://a.example');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('只改某条端点的 key 时，没传的那条保留原 key', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ep-keep-'));
  try {
    const file = path.join(tmp, 'model-groups.json');
    const s = new ModelGroupStore({ dataDir: tmp });
    s.load();
    s.upsert({
      name: 'T',
      baseUrl: 'https://a.example',
      apiKey: 'k0',
      models: [{ id: 'm', name: 'm' }],
      endpoints: [
        { baseUrl: 'https://a.example', apiKey: 'keep-me' },
        { baseUrl: 'https://b.example', apiKey: 'also-keep' },
      ],
    });
    const id = s.list()[0].id;
    // 模拟 App 只传了地址、key 留空（打码值不能拿来覆盖）
    const r = s.upsert({
      id,
      endpoints: [
        { baseUrl: 'https://a.example', apiKey: '' },
        { baseUrl: 'https://b.example', apiKey: 'new-backup' },
      ],
    });
    assert.equal(r.group.endpoints[0].apiKey, 'keep-me', '没传的要保留');
    assert.equal(r.group.endpoints[1].apiKey, 'new-backup', '传了的要更新');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});