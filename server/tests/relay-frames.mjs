/**
 * 中转帧编解码测试（纯函数）。
 *   node tests/relay-frames.mjs
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const { packBody, unpackBody, encodeFrame, decodeFrame, MAX_FRAME_BYTES } = await import(
  '../src/relay/frames.js'
);

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

await test('往返：小消息原样还原（不压缩）', () => {
  const body = Buffer.from('hello');
  const packed = packBody(body);
  assert.equal(packed.z, 0, '太小就别压');
  assert.ok(unpackBody(packed).equals(body));
});

await test('★ 往返：大段重复内容会被压缩，且无损', () => {
  const body = Buffer.from('pi-bot 中转 '.repeat(5000));
  const packed = packBody(body);
  assert.equal(packed.z, 1, '重复内容应该压得动');
  assert.ok(
    Buffer.byteLength(packed.body, 'base64') < body.length / 2,
    '压缩后应该明显更小',
  );
  assert.ok(unpackBody(packed).equals(body), '解压后必须逐字节一致');
});

await test('★ 图片类（已压缩）数据不会被硬压大', () => {
  const body = crypto.randomBytes(200 * 1024); // 近似"已压缩"的随机数据
  const packed = packBody(body);
  const encodedSize = Buffer.byteLength(packed.body, 'base64');
  assert.ok(encodedSize >= body.length, 'base64 本身会变大');
  assert.ok(encodedSize < body.length * 1.4, '不应该被二次压缩放大太多');
  assert.ok(unpackBody(packed).equals(body));
});

await test('空 body 也能往返', () => {
  const packed = packBody(Buffer.alloc(0));
  assert.equal(packed.body, '');
  assert.equal(unpackBody(packed).length, 0);
});

await test('坏帧返回 null，不抛异常', () => {
  assert.equal(decodeFrame('not json'), null);
  assert.equal(decodeFrame('{"t":123}'), null);
  assert.equal(decodeFrame('[]'), null);
  assert.equal(decodeFrame('{"t":"req"}').t, 'req');
});

await test('超大帧被拒发 / 拒收', () => {
  const huge = Buffer.alloc(MAX_FRAME_BYTES + 1024, 65);
  assert.throws(() => packBody(huge), /帧太大/);

  // 直接伪造一个超大的 base64 body 解包 → 应抛
  const fake = { body: Buffer.alloc(MAX_FRAME_BYTES + 10, 66).toString('base64'), z: 0 };
  assert.throws(() => unpackBody(fake));
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 中转帧测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
