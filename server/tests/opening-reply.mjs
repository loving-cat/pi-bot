/**
 * 开场白收尾测试：模型把「卡片已发出」当回答时，要换成自我介绍。
 *   node tests/opening-reply.mjs
 *
 * ## 守什么
 *
 * 首开私聊是用户对 bot 的第一印象。提示词要求「自我介绍 + 弹卡片」，
 * 但模型经常只念一句工具播报（"卡片已发出，请你选择或直接说。"），
 * 自我介绍没了 —— 用户看到的第一句话是一句说明书。
 *
 * 这里的规则必须**保守**：只改开场轮里「纯播报」的那一类，
 * 已经在介绍自己的话一个字都不许动。
 */
import assert from 'node:assert/strict';

const { looksLikeToolNarration, openingIntro, polishOpeningReply } =
  await import('../src/opening-reply.js');

const bot = { name: '抓数员', persona: '你是一名数据工程师，擅长把网页上的数据抓回来。其它事听负责人安排。' };

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

test('★ 纯工具播报被识别出来', () => {
  assert.equal(looksLikeToolNarration('卡片已发出，请你选择或直接说。', bot), true);
  assert.equal(looksLikeToolNarration('已发送，请选择。', bot), true);
  assert.equal(looksLikeToolNarration('请点击下面这张卡片', bot), true);
});

test('★ 播报被换成「名字 + 人设首句」', () => {
  const out = polishOpeningReply('卡片已发出，请你选择或直接说。', bot);
  assert.equal(out, '我是抓数员，数据工程师，擅长把网页上的数据抓回来。');
});

test('自我介绍已经在了就不动（哪怕提到卡片）', () => {
  const text = '我是抓数员，负责抓数据。下面这张卡片里挑一个就行。';
  assert.equal(looksLikeToolNarration(text, bot), false);
  assert.equal(polishOpeningReply(text, bot), text);
});

test('话里报了自己的名字也算自我介绍', () => {
  const text = '抓数员在这儿，卡片里选一个吧。';
  assert.equal(polishOpeningReply(text, bot), text);
});

test('长回答不替换（那通常真在说话，不是一句播报）', () => {
  const text = '卡片已发出，请你选择或直接说。另外提醒一句：抓取需要目标站点允许，遇到登录墙我会先问你。';
  assert.equal(looksLikeToolNarration(text, bot), false);
  assert.equal(polishOpeningReply(text, bot), text);
});

test('空正文 → 自我介绍兜底', () => {
  assert.equal(polishOpeningReply('', bot), '我是抓数员，数据工程师，擅长把网页上的数据抓回来。');
  assert.equal(polishOpeningReply('   ', bot), '我是抓数员，数据工程师，擅长把网页上的数据抓回来。');
});

test('没有 persona 时只报名字', () => {
  assert.equal(openingIntro({ name: '榜单撰写' }), '我是榜单撰写。');
  assert.equal(openingIntro({}), '我是助手。');
});

test('persona 里的第二人称被去掉、过长截断', () => {
  const long = { name: '调研员', persona: '你的职责是把开源项目按 star 排序并标注活跃度，同时还要写趋势结论、做图表、整理来源链接、给出结论建议。' };
  const out = openingIntro(long);
  assert.ok(out.startsWith('我是调研员，'), out);
  assert.equal(out.includes('你的职责'), false, '不该出现第二人称');
  assert.ok(out.length <= 50, `太长：${out.length}`);
  assert.ok(out.endsWith('。'));
});

test('普通回复不受影响（调用方只在开场轮调用）', () => {
  const text = '看完了，A 股数据能拿到，但需要 token。';
  assert.equal(polishOpeningReply(text, bot), text);
});

console.log(`\n开场白收尾：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
