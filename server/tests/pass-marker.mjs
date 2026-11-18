/**
 * `[PASS]` 尾部标记剥离测试。
 *   node tests/pass-marker.mjs
 *
 * ## 守什么
 *
 * `[PASS]` 是群聊内部的"这轮不用我接"信号。整条只有 PASS 时编排层会删消息，
 * 但模型经常把它贴在报告结尾 —— 那就成了漏给用户的内部协议。
 * 这里守住三件事：
 *   1. 结尾 PASS（含括号说明）一定被剥掉；
 *   2. 整条纯 PASS 保持原样（否则会变成一条空白消息）；
 *   3. 正文中间的 PASS 不动（可能是引用别人的话）。
 */
import assert from 'node:assert/strict';

const { isBarePass, stripTrailingPassMarker } = await import('../src/pass-marker.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

test('★ 报告末尾的 PASS 被剥掉（括号说明一起）', () => {
  const text = '报告写完了，三条官方路径都核对过。\n\n[PASS]（不需要接，直接回答进度）';
  assert.equal(stripTrailingPassMarker(text), '报告写完了，三条官方路径都核对过。');
});

test('★ 纯 PASS 保持原样（交给编排层删消息）', () => {
  assert.equal(stripTrailingPassMarker('[PASS]'), '[PASS]');
  assert.equal(stripTrailingPassMarker('  [pass]  '), '  [pass]  ');
  assert.equal(stripTrailingPassMarker('[PASS]（轮不到我）'), '[PASS]（轮不到我）');
});

test('英文标点/全角括号都认', () => {
  assert.equal(stripTrailingPassMarker('做完了。[PASS](nobody asked me)'), '做完了。');
  assert.equal(stripTrailingPassMarker('做完了。【PASS】（轮不到我）'), '做完了。');
});

test('正文中间提到 PASS 不动（可能是引用）', () => {
  const text = '规则是：不需要接就回 [PASS]。这条别再改了。';
  assert.equal(stripTrailingPassMarker(text), text);
});

test('没有标记时原样返回', () => {
  assert.equal(stripTrailingPassMarker('正常的一句话。'), '正常的一句话。');
  assert.equal(stripTrailingPassMarker(''), '');
});

test('isBarePass 只认整条就是标记的情况', () => {
  assert.equal(isBarePass('[PASS]'), true);
  assert.equal(isBarePass('pass'), true);
  assert.equal(isBarePass('[PASS]（不需要接）'), true);
  assert.equal(isBarePass('报告写完了 [PASS]'), false);
  assert.equal(isBarePass(''), false);
});

console.log(`\nPASS 标记剥离：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
