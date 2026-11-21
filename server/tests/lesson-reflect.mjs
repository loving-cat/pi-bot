/**
 * 复盘解析测试（纯函数，不起模型）。
 *
 * 重点全在"防编造"：模型很容易顺手编一个 msgId 或者改动引文。
 * 这类经验一旦进库，下次就会教 bot 一个根本不存在的前提。
 */
import assert from 'node:assert/strict';

import {
  buildReflectInput,
  parseReflectOutput,
  buildOutcomeInput,
  parseOutcomeOutput,
} from '../src/lesson-reflect-prompt.js';

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

// ---------------------------------------------------------------------------
// 蒸馏器的「待确认的边」（§5.1 最后一刀）：只能引用目录里真实存在的 active 经验
// ---------------------------------------------------------------------------
const CATALOG = [
  { id: 'les_old1', cue: '配班子要先按模块拆' },
  { id: 'les_old2', cue: '发布前核对版本号' },
];
const EVIDENCE_JSON = '"evidence":[{"msgId":"m1","quote":"每个功能模块都有专人负责"}]';
const CATALOG_OPTS = {
  ids: new Set(['m1']),
  byId: new Map([['m1', '他们团队应该每个功能模块都有专人负责给我汇报才对']]),
  edgeCatalog: CATALOG,
};
const parseWithCatalog = (edgesJson) =>
  parseReflectOutput(
    `{"lessons":[{"cue":"a","lesson":"b",${EVIDENCE_JSON},${edgesJson}}]}`,
    CATALOG_OPTS,
  );

test('边建议：目录带进输入，只给 id + 情境，最多 15 条', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `les_${i}`, cue: `情境 ${i}` }));
  const { text } = buildReflectInput(round, { dept: '二组', edgeCatalog: many });
  assert.match(text, /【现有经验/);
  assert.match(text, /- les_0｜情境：情境 0/);
  assert.ok(!text.includes('les_15｜'), '超 15 条不喂，否则模型记不住 id');
  // 没给目录时不该出现目录块（老路径逐字不变）
  assert.ok(!buildReflectInput(round, { dept: '二组' }).text.includes('【现有经验'));
});

test('边建议：只留 supersedes / contradicts，目录外的 id 与哨兵一律丢', () => {
  assert.deepEqual(
    parseWithCatalog(
      '"edges":[' +
        '{"to":"les_old1","type":"supersedes"},' +
        '{"to":"les_fake","type":"contradicts"},' +
        '{"to":"les_old2","type":"requires"},' +
        '{"to":"user","type":"contradicts"}' +
        ']',
    )[0].pendingEdges,
    [{ to: 'les_old1', type: 'supersedes' }],
    '编的 id / 不允许的类型 / 哨兵都得丢掉',
  );
  // 不给目录（老调用路径）时只做形状校验：编的 id 会留下来，但物化时会静默跳过
  const shapeOnly = parseReflectOutput(
    `{"lessons":[{"cue":"a","lesson":"b",${EVIDENCE_JSON},"edges":[{"to":"les_fake","type":"contradicts"}]}]}`,
    { ids: new Set(['m1']), byId: new Map([['m1', '他们团队应该每个功能模块都有专人负责给我汇报才对']]) },
  );
  assert.deepEqual(shapeOnly[0].pendingEdges, [{ to: 'les_fake', type: 'contradicts' }]);
});

test('边建议：最多 2 个、去重；没有 edges 时不落键', () => {
  const out = parseWithCatalog(
    '"edges":[' +
      '{"to":"les_old1","type":"supersedes"},' +
      '{"to":"les_old1","type":"supersedes"},' +
      '{"to":"les_old2","type":"contradicts"},' +
      '{"to":"les_old2","type":"supersedes"}' +
      ']',
  );
  assert.equal(out[0].pendingEdges.length, 2);
  assert.deepEqual(out[0].pendingEdges[0], { to: 'les_old1', type: 'supersedes' });
  assert.equal(out[0].pendingEdges[1].to, 'les_old2');

  const plain = parseReflectOutput(`{"lessons":[{"cue":"a","lesson":"b",${EVIDENCE_JSON}}]}`, CATALOG_OPTS);
  assert.equal('pendingEdges' in plain[0], false, '空不落键（老库形状不变）');
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


// ---------------------------------------------------------------------------
// 效果评估（win/fail 的唯一合法来源）
// ---------------------------------------------------------------------------
test('评估输入：带本轮注入过的经验，只给 id / 情境 / 做法', () => {
  const { text, ids } = buildOutcomeInput(
    [{ id: 'm1', authorType: 'user', text: '按模块拆挺好' }],
    { lessons: [{ id: 'les_a', cue: '配班子时', lesson: '按模块拆' }] },
  );
  assert.match(text, /\[m1\] 用户：按模块拆挺好/);
  assert.match(text, /id=les_a/);
  assert.match(text, /按模块拆/);
  assert.deepEqual([...ids], ['les_a']);
});
test('评估解析：id 必须在注入清单里（模型编的 id 一律丢）', () => {
  const out = parseOutcomeOutput(
    JSON.stringify({ outcomes: [{ id: 'les_a', verdict: 'helped' }, { id: 'les_fake', verdict: 'hurt' }] }),
    { ids: new Set(['les_a']) },
  );
  assert.deepEqual(out.map((o) => o.id), ['les_a']);
});
test('评估解析：verdict 只认四档，同一 id 取第一条', () => {
  const out = parseOutcomeOutput(
    JSON.stringify({
      outcomes: [
        { id: 'a', verdict: 'helped', why: '第一条' },
        { id: 'a', verdict: 'hurt' },
        { id: 'b', verdict: '很有效' },
      ],
    }),
    { ids: new Set(['a', 'b']) },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].verdict, 'helped');
});
test('评估解析：不是 JSON / 空输出 → 空数组（不许抛）', () => {
  assert.deepEqual(parseOutcomeOutput('NO_ENTRY', { ids: new Set(['a']) }), []);
  assert.deepEqual(parseOutcomeOutput('', { ids: new Set(['a']) }), []);
  assert.deepEqual(parseOutcomeOutput('{bad json', { ids: new Set(['a']) }), []);
});

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
