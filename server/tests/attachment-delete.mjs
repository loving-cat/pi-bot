import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 附件模块加载前固定本测试的数据目录。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-attach-'));
process.env.PI_BOT_HOME = tmp;
process.env.PI_BOT_WORKSPACE = path.join(tmp, 'workspace');

const mod = await import('../src/attachments.js');

test('保存后能按 id 找到元信息与文件路径', () => {
  const meta = mod.saveBuffer(Buffer.from('hello'), { name: 'a.txt', mime: 'text/plain' });
  assert.ok(meta.id);
  assert.equal(mod.metaFor(meta.id).name, 'a.txt');
  assert.ok(mod.pathFor(meta.id), '文件应真实存在');
});

test('删除后元信息与文件都没了', () => {
  const meta = mod.saveBuffer(Buffer.from('bye'), { name: 'b.txt', mime: 'text/plain' });
  const file = mod.pathFor(meta.id);
  assert.ok(file && fs.existsSync(file));

  const removed = mod.deleteAttachment(meta.id);
  assert.equal(removed, true);
  assert.equal(mod.metaFor(meta.id), null, '元信息要清掉');
  assert.equal(fs.existsSync(file), false, '文件要删掉');
});

test('删不存在的附件返回 false，不抛错', () => {
  assert.equal(mod.deleteAttachment('nope-not-here'), false);
});

test('重复删除同一个：第二次返回 false（不会一路报错）', () => {
  const meta = mod.saveBuffer(Buffer.from('x'), { name: 'c.txt', mime: 'text/plain' });
  assert.equal(mod.deleteAttachment(meta.id), true);
  assert.equal(mod.deleteAttachment(meta.id), false, '已删过再删不该抛');
});

test('文件已被外部删掉时，仍能清掉索引（不留幽灵条目）', () => {
  const meta = mod.saveBuffer(Buffer.from('ghost'), { name: 'd.txt', mime: 'text/plain' });
  const file = mod.pathFor(meta.id);
  fs.unlinkSync(file); // 模拟文件被别人删了

  const removed = mod.deleteAttachment(meta.id);
  assert.equal(removed, true, '文件不见了也应该当作删成功');
  assert.equal(mod.metaFor(meta.id), null, '索引必须清掉');
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
