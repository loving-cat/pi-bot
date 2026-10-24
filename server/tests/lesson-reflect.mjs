/**
 * 复盘解析测试（纯函数，不起模型）。
 *
 * 重点全在"防编造"：模型很容易顺手编一个 msgId 或者改动引文。
 * 这类经验一旦进库，下次就会教 bot 一个根本不存在的前提。
 */
import assert from 'node:assert/strict';

import { buildReflectInput, parseReflectOutput } from '../src/lesson-reflect-prompt.js';

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

const round = [
  { id: 'm1', authorType: 'user', text: '他们团队应该每个功能模块都有专人负责给我汇报才对' },
  { id: 'm2', authorType: 'bot', authorName: '二组运营总监', text: '明白，我按模块各配一个人。' },
  { id: 'm3', authorType: 'system', text: '重试回执' },
  { id: 'm4', authorType: 'bot', authorName: '二组数据分析师', text: '数据我这边补上。' },
];

test('输入：带 msgId，系统消息不进（复盘只读人说的话）', () => {
  const { text, ids } = buildReflectInput(round, { dept: '内容运营二组' });
  assert.match(text, /\[m1\] 用户：/);
  assert.match(text, /\[m2\] 二组运营总监：/);
  assert.ok(!text.includes('[m3]'));
  assert.deepEqual([...ids], ['m1', 'm2', 'm4']);
});

test('输入：超长时保留最近的话（尾部截断）', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: `m${i}`,
    authorType: 'bot',
    authorName: '成员',
    text: `第 ${i} 条`.repeat(20),
  }));
  const { text } = buildReflectInput(many, { maxChars: 300 });
  // 只量记录正文（前后还有固定说明文字，不该算进 300 字预算）
  const body = text
    .split('\n')
    .filter((l) => l.startsWith('[m'))
    .join('\n');
  assert.ok(body.length <= 300, `正文实际 ${body.length}`);
  assert.ok(text.includes('[m49]'), '最近的话必须在');
  assert.ok(!text.includes('[m0]'), '最早的话应被丢掉');
});

test('NO_ENTRY：不产出任何经验', () => {
  assert.deepEqual(parseReflectOutput('NO_ENTRY'), []);
  assert.deepEqual(parseReflectOutput(''), []);
});

test('合法输出：能解析出条目（含 ```json 包裹）', () => {
  const out = parseReflectOutput(
    '```json\n{"lessons":[{"cue":"给部门配班子","lesson":"按模块拆 owner","verdict":"helped","evidence":[{"msgId":"m1","quote":"每个功能模块都有专人负责"}]}]}\n```',
    {
      ids: new Set(['m1']),
      byId: new Map([['m1', '他们团队应该每个功能模块都有专人负责给我汇报才对']]),
    },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].cue, '给部门配班子');
  assert.equal(out[0].verdict, 'helped');
  assert.equal(out[0].evidence[0].msgId, 'm1');
});

test('编造的 msgId：整条丢掉', () => {
  const out = parseReflectOutput(
    '{"lessons":[{"cue":"a","lesson":"b","evidence":[{"msgId":"m_fake","quote":"x"}]}]}',
    { ids: new Set(['m1']), byId: new Map([['m1', '真实内容']]) },
  );
  assert.deepEqual(out, []);
});

test('引文和原文对不上：整条丢掉（防模型改原话）', () => {
  const out = parseReflectOutput(
    '{"lessons":[{"cue":"a","lesson":"b","evidence":[{"msgId":"m1","quote":"用户夸我们做得很好"}]}]}',
    { ids: new Set(['m1']), byId: new Map([['m1', '他们团队应该每个功能模块都有专人负责']]) },
  );
  assert.deepEqual(out, []);
});

test('引文只要真出现在原文里（忽略空白）就认', () => {
  const out = parseReflectOutput(
    '{"lessons":[{"cue":"a","lesson":"b","evidence":[{"msgId":"m1","quote":"每个 功能模块 都有专人"}]}]}',
    { ids: new Set(['m1']), byId: new Map([['m1', '他们团队应该每个功能模块都有专人负责']]) },
  );
  assert.equal(out.length, 1);
});

test('没有证据的条目：丢掉', () => {
  const out = parseReflectOutput(
    '{"lessons":[{"cue":"a","lesson":"b","evidence":[]}]}',
    { ids: new Set(['m1']) },
  );
  assert.deepEqual(out, []);
});

test('最多 2 条', () => {
  const one = (i) =>
    `{"cue":"情境${i}","lesson":"做法${i}","evidence":[{"msgId":"m1","quote":"每个功能模块都有专人"}]}`;
  const out = parseReflectOutput(
    `{"lessons":[${one(1)},${one(2)},${one(3)}]}`,
    { ids: new Set(['m1']), byId: new Map([['m1', '每个功能模块都有专人负责']]) },
  );
  assert.equal(out.length, 2);
});

test('乱填的 verdict 退回 confounded', () => {
  const out = parseReflectOutput(
    '{"lessons":[{"cue":"a","lesson":"b","verdict":"感觉不错","evidence":[{"msgId":"m1","quote":"每个功能模块"}]}]}',
    { ids: new Set(['m1']), byId: new Map([['m1', '每个功能模块都有专人负责']]) },
  );
  assert.equal(out[0].verdict, 'confounded');
});

test('不是 JSON / 空对象：安全返回空数组', () => {
  assert.deepEqual(parseReflectOutput('我觉得可以更好'), []);
  assert.deepEqual(parseReflectOutput('{"lessons":"oops"}'), []);
  assert.deepEqual(parseReflectOutput('{}'), []);
});

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
