import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ModelGroupStore } from '../src/model-groups.js';

// ---------------------------------------------------------------------------
// 测试隔离：绝不能碰用户真实配置
//
// 真实事故：早期版 model-groups.js 的 file getter 写死从全局 config 取
// dataDir，单测 new ModelGroupStore(file) 时 file 参数被忽略 ——
// 测试里的 3 个 'T' 组被写进了用户真实的 model-groups.json，
// 还把「公司」组的 baseUrl 覆盖成了测试用的 https://a.example。
//
// 这些测试就是为了防止再犯：测试必须落到临时目录。
// ---------------------------------------------------------------------------

test('★ ModelGroupStore 接受 dataDir 覆盖，不碰全局 config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-iso-'));
  try {
    const s = new ModelGroupStore({ dataDir: tmp });
    // file 必须指向临时目录
    assert.ok(s.file.startsWith(tmp), '文件路径必须在临时目录里：' + s.file);
    assert.ok(s.file.endsWith('model-groups.json'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('★ 写入只落在临时目录，真实数据目录不受影响', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-iso2-'));
  try {
    const s = new ModelGroupStore({ dataDir: tmp });
    s.load();
    s.upsert({
      name: '隔离测试组',
      baseUrl: 'https://isolation.example',
      apiKey: 'fixture-credential-isolation-key',
      models: [{ id: 'iso-model', name: 'iso' }],
    });
    s.save();

    // 只在临时目录里生成了文件
    const tmpFile = path.join(tmp, 'model-groups.json');
    assert.ok(fs.existsSync(tmpFile), '应该在临时目录写入');
    const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(written.groups[0].name, '隔离测试组');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('默认行为不变：不传 dataDir 时仍用全局 config', () => {
  const s = new ModelGroupStore();
  // 不传参数时 dataDir 必须被填充（否则 file getter 会炸）
  assert.ok(s.dataDir, '不传时要回落到全局 config');
  assert.ok(s.file.endsWith('model-groups.json'));
});