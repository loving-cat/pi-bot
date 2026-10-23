/**
 * 群聊记录预算裁剪测试。
 *
 * 起因：真实群聊里单条消息最长 4236 字，而 `transcriptFor` 原来只按条数截
 * （30 条 × 单条 1600 字上限 ≈ 2.4 万 token），够把上下文预算挤爆、频繁触发压缩。
 * 这里验三件事：按字数裁、新的优先、裁掉了要能说出来。
 */
import assert from 'node:assert/strict';
import { trimTranscript, clipMessage } from '../src/transcript-budget.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

const msg = (text) => ({ text });

test('不超预算时原样返回', () => {
  const list = [msg('一二三'), msg('四五六')];
  const r = trimTranscript(list, { maxChars: 100, maxItems: 10 });
  assert.equal(r.items.length, 2);
  assert.equal(r.dropped, 0);
  assert.equal(r.usedChars, 6);
});

test('按字数裁，不是按条数', () => {
  // 5 条各 100 字，预算 250 → 只装得下 2 条（200 字），第 3 条会超
  const list = Array.from({ length: 5 }, (_, i) => msg('x'.repeat(100) + i));
  const r = trimTranscript(list, { maxChars: 250, maxItems: 10 });
  assert.equal(r.items.length, 2, '装 2 条就够 200 字，第 3 条会到 300 超预算');
  assert.ok(r.usedChars <= 250);
  assert.equal(r.dropped, 3);
});

test('保留最新的，丢掉最老的', () => {
  const list = [msg('AAA'), msg('BBB'), msg('CCC'), msg('DDD')];
  const r = trimTranscript(list, { maxChars: 6, maxItems: 10 });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].text, 'CCC', '应该保留最后两条');
  assert.equal(r.items[1].text, 'DDD');
  assert.equal(r.dropped, 2);
});

test('条数上限优先于字数上限生效', () => {
  const list = Array.from({ length: 10 }, (_, i) => msg(`m${i}`));
  const r = trimTranscript(list, { maxChars: 100000, maxItems: 3 });
  assert.equal(r.items.length, 3);
  assert.deepEqual(
    r.items.map((m) => m.text),
    ['m7', 'm8', 'm9'],
    '条数受限时也保留最新的三条',
  );
});

test('单条就超预算时仍收下它（不能一条都不给）', () => {
  const list = [msg('A'.repeat(500))];
  const r = trimTranscript(list, { maxChars: 10, maxItems: 10 });
  assert.equal(r.items.length, 1, '至少给一条，否则模型完全看不到上下文');
  assert.equal(r.dropped, 0);
});

test('空列表 / 非法预算不炸', () => {
  assert.equal(trimTranscript([], { maxChars: 100 }).items.length, 0);
  assert.equal(trimTranscript(null).items.length, 0);
  assert.equal(trimTranscript([msg('a')], { maxChars: 0 }).items.length, 0);
  assert.equal(trimTranscript([msg('a')], { maxItems: 0 }).items.length, 0);
});

test('缺 text 字段的消息按空串算', () => {
  const r = trimTranscript([{ text: undefined }, { text: 'ok' }], { maxChars: 100 });
  assert.equal(r.items.length, 2);
  assert.equal(r.usedChars, 2);
});

test('超长消息保留头尾，中间省略', () => {
  const text = `开头重要信息${'x'.repeat(3000)}结尾的结论是先修 A 再修 B`;
  const clipped = clipMessage(text, 200);
  assert.ok(clipped.length < text.length, '应该被裁短');
  assert.ok(clipped.includes('开头重要信息'), '开头要留');
  assert.ok(clipped.includes('结尾的结论是先修 A 再修 B'), '结尾必须留 —— 结论常在这里');
  assert.match(clipped, /省略 \d+ 字/);
});

test('不超长的消息原样返回', () => {
  const text = '短消息';
  assert.equal(clipMessage(text, 100), text);
});

test('裁剪后的长度接近预算', () => {
  const text = 'y'.repeat(5000);
  const clipped = clipMessage(text, 1000);
  // 1000 预算里含省略说明，允许一点浮动
  assert.ok(clipped.length <= 1050, `实际 ${clipped.length}`);
  assert.ok(clipped.length >= 900, `实际 ${clipped.length}`);
});

test('空值安全', () => {
  assert.equal(clipMessage(null, 10), '');
  assert.equal(clipMessage(undefined, 10), '');
  assert.equal(clipMessage('abc', 0), 'abc', '预算 <= 0 视为不裁');
});

// ---------------------------------------------------------------------------
// 派给它的活不能被截、也不能被后来的讨论挤掉
// ---------------------------------------------------------------------------

test('mustKeep：最早的派活被后来一串长讨论挤爆预算，也必须留下', () => {
  const list = [
    { text: '派活：你去做 A', important: true },
    ...Array.from({ length: 6 }, (_, i) => msg(`同事讨论${i} `.padEnd(50, 'z'))),
  ];
  const r = trimTranscript(list, { maxChars: 120, maxItems: 30, mustKeep: (m) => m.important });
  assert.equal(r.items[0].text, '派活：你去做 A', '派活必须留在最前面');
  assert.ok(r.items.length >= 2, '新的讨论也要留几条');
  assert.equal(r.items.at(-1).text, list.at(-1).text, '最新一条永远在');
  assert.ok(r.dropped > 0, '预算确实爆了，中间丢了一些');
  // 中间跳过的条数要记下来，提示词才能写「中间省略 N 条」
  const gap = r.items.reduce((s, m) => s + (m.gapBefore ?? 0), 0) + r.leadingDropped;
  assert.equal(gap, r.dropped, '省略的条数要对得上');
  assert.equal(list[1].gapBefore, undefined, '不能改传进来的对象');
});

test('mustKeep：不受条数上限限制', () => {
  const list = [{ text: 'a', important: true }, { text: 'b', important: true }, msg('c'), msg('d')];
  const r = trimTranscript(list, { maxChars: 1000, maxItems: 1, mustKeep: (m) => m.important });
  assert.deepEqual(r.items.map((m) => m.text), ['a', 'b', 'd']);
});

test('capOf：预算按截断后的展示长度记，不按原文', () => {
  // 三条 4000 字的同事报告，展示时各截到 1600：总共 4800 字，应该三条都装得下
  const list = Array.from({ length: 3 }, (_, i) => msg(String(i).repeat(4000)));
  const r = trimTranscript(list, { maxChars: 6000, maxItems: 30, capOf: () => 1600 });
  assert.equal(r.items.length, 3, `按原文长度算只装得下 1 条，按展示长度应该 3 条（实际 ${r.items.length}）`);
  assert.equal(r.usedChars, 4800);
});

test('不传 mustKeep / capOf 时行为不变', () => {
  const list = [msg('aaaa'), msg('bbbb'), msg('cccc')];
  const r = trimTranscript(list, { maxChars: 8, maxItems: 10 });
  assert.deepEqual(r.items.map((m) => m.text), ['bbbb', 'cccc']);
  assert.equal(r.dropped, 1);
  assert.equal(r.leadingDropped, 1);
});

console.log(`\n记录预算测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
