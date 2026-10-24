/**
 * 分片上传测试：顺序校验、大小校验、sha256、合并结果、中断清理。
 *   node tests/uploads.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const { UploadSessions, MAX_UPLOAD_BYTES } = await import('../src/upload-sessions.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-uploads-'));

await test('顺序分片 + 合并，内容一致', async () => {
  const up = new UploadSessions({ dir });
  const body = Buffer.from('hello world，分片上传测试');
  const { uploadId } = up.init({ name: 'a.txt', size: body.length, mime: 'text/plain' });
  assert.ok(uploadId);

  const mid = Math.floor(body.length / 2);
  assert.equal(up.writeChunk(uploadId, 0, body.subarray(0, mid)).received, mid);
  const second = up.writeChunk(uploadId, mid, body.subarray(mid));
  assert.equal(second.received, body.length);

  const done = await up.complete(uploadId);
  assert.equal(done.error, undefined);
  assert.equal(done.name, 'a.txt');
  assert.equal(done.mime, 'text/plain');
  // 不整读进内存：返回临时文件路径，由调用方移走
  assert.ok(done.filePath);
  assert.ok(fs.readFileSync(done.filePath).equals(body));
  fs.rmSync(done.filePath, { force: true });
});

await test('★ 乱序分片被拒绝（避免拼错文件）', () => {
  const up = new UploadSessions({ dir });
  const { uploadId } = up.init({ name: 'b.bin', size: 10 });
  const r = up.writeChunk(uploadId, 5, Buffer.alloc(5));
  assert.match(r.error, /顺序不对/);
});

await test('★ 超过声明大小被拒绝', () => {
  const up = new UploadSessions({ dir });
  const { uploadId } = up.init({ name: 'c.bin', size: 4 });
  const r = up.writeChunk(uploadId, 0, Buffer.alloc(8));
  assert.match(r.error, /超过声明大小/);
});

await test('没传完不能合并', async () => {
  const up = new UploadSessions({ dir });
  const { uploadId } = up.init({ name: 'd.bin', size: 10 });
  up.writeChunk(uploadId, 0, Buffer.alloc(4));
  assert.match((await up.complete(uploadId)).error, /还差 6 字节/);
});

await test('★ sha256 不一致时丢弃', async () => {
  const up = new UploadSessions({ dir });
  const body = Buffer.from('tamper');
  const { uploadId } = up.init({ name: 'e.txt', size: body.length });
  up.writeChunk(uploadId, 0, body);
  const r = await up.complete(uploadId, { sha256: 'deadbeef' });
  assert.match(r.error, /校验失败/);
  assert.equal(up.sessions.has(uploadId), false, '失败后会话要一起清掉');
});

await test('sha256 正确时通过', async () => {
  const up = new UploadSessions({ dir });
  const body = Buffer.from('ok');
  const { uploadId } = up.init({ name: 'f.txt', size: body.length });
  up.writeChunk(uploadId, 0, body);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const done = await up.complete(uploadId, { sha256: sha });
  assert.ok(fs.readFileSync(done.filePath).equals(body));
  fs.rmSync(done.filePath, { force: true });
});

await test('超大文件在 init 就被拒', () => {
  const up = new UploadSessions({ dir });
  assert.match(up.init({ size: MAX_UPLOAD_BYTES + 1 }).error, /太大/);
});

await test('中断：删掉会话与临时文件', () => {
  const up = new UploadSessions({ dir });
  const { uploadId } = up.init({ name: 'g.bin', size: 10 });
  up.writeChunk(uploadId, 0, Buffer.alloc(2));
  assert.equal(up.abort(uploadId), true);
  assert.equal(up.sessions.has(uploadId), false);
  assert.equal(up.abort('nope'), false);
});

fs.rmSync(dir, { recursive: true, force: true });

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 分片上传测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
