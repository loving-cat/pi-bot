import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_HINT,
  rankCandidates,
  recommendModel,
} from '../src/model-recommend.js';

// ---------------------------------------------------------------------------
// 模型推荐：Jev 判"什么性质的活"，本地按能力排序挑模型
//
// 关键约束：Jev 只出性质判断，不直接吐模型名。
// 因为模型目录是用户配的、会变，让决策模型记名字是在制造漂移。
// ---------------------------------------------------------------------------

const ENTRIES = [
  { alias: '公司/deepseek-v4.1-flash', slugs: ['g1/deepseek-v4.1-flash'], contextWindow: 128000 },
  { alias: 'GPT/gpt-6-astra-fast', slugs: ['g2/gpt-6-astra-fast'], contextWindow: 400000 },
  { alias: 'GPT/gpt-6.1-sol-fast', slugs: ['g2/gpt-6.1-sol-fast'], contextWindow: 1000000 },
  { alias: 'GPT/gpt-6-prime-pro', slugs: ['g2/gpt-6-prime-pro'], contextWindow: 1000000 },
];

const ON = { enabled: true, baseUrl: 'https://api.typesafe.ai', apiKey: 'k' };
const OFF = { enabled: false };

test('质量优先的活不挑轻量模型', () => {
  // 重推理图快只会返工：先慢后快，不如一次做对
  assert.equal(CAPABILITY_HINT.reasoning.qualityFirst, true);
  assert.equal(CAPABILITY_HINT.coding.qualityFirst, true);
  assert.equal(CAPABILITY_HINT.research.qualityFirst, true);
});

test('简单活可以图快', () => {
  assert.equal(CAPABILITY_HINT.routine.qualityFirst, false);
  assert.equal(CAPABILITY_HINT.writing.qualityFirst, false);
});

test('★ 重推理即使标了"要快"也不挑 flash —— 速度不能压过质量', () => {
  const r = rankCandidates('reasoning', {
    entries: ENTRIES,
    needsLongContext: true,
    needsSpeed: true, // 用户等着，也不行
  });
  assert.doesNotMatch(String(r.pick), /flash/, '不该挑轻量模型');
  assert.match(String(r.pick), /pro|sol/);
});

test('简单活标了"要快"就挑快的', () => {
  const r = rankCandidates('routine', {
    entries: ENTRIES,
    needsSpeed: true,
  });
  assert.match(String(r.pick), /flash/);
});

test('需要长上下文时窗口大的排前面', () => {
  const r = rankCandidates('writing', {
    entries: ENTRIES,
    needsLongContext: true,
  });
  // 1M 窗口的两个应该在前
  const top = r.pick;
  const winner = ENTRIES.find((e) => e.slugs[0] === top);
  assert.ok(winner.contextWindow >= 400000, '长上下文活不该挑小窗口');
});

test('没有任何模型时返回 null，不抛', () => {
  const r = rankCandidates('coding', { entries: [] });
  assert.equal(r.pick, null);
  assert.deepEqual(r.alternatives, []);
});

test('单模型时无论如何就是它', () => {
  const only = [ENTRIES[0]];
  assert.equal(rankCandidates('reasoning', { entries: only }).pick, 'g1/deepseek-v4.1-flash');
  assert.equal(rankCandidates('routine', { entries: only }).pick, 'g1/deepseek-v4.1-flash');
});

test('同分时按目录顺序，结果稳定', () => {
  const a = rankCandidates('routine', { entries: ENTRIES }).pick;
  const b = rankCandidates('routine', { entries: ENTRIES }).pick;
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// 走 Jev 时只信"性质"，不信模型名
// ---------------------------------------------------------------------------

test('Jev 关着 → fallback，但仍给一个起点', async () => {
  const r = await recommendModel({ task: '随便干点活' }, OFF);
  assert.equal(r.ok, false);
  assert.equal(r.source, 'fallback');
  assert.ok(r.pick, '关着也要给一个起点，否则主控无从下手');
});

test('Jev 给的性质决定挑哪个模型', async () => {
  // Jev 说这是 routine + 要快 → 应该挑 flash
  const r = await recommendModel(
    { task: '转个格式' },
    ON,
    {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            answers: {
              kind: { type: 'choice', choice: 'routine', confidence: 0.9 },
              needsLongContext: { type: 'noul', noul: 0.1 },
              needsSpeed: { type: 'noul', noul: 0.95 },
            },
          }),
      }),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'routine');
});

test('Jev 判错（选项名非法）→ 落回 fallback', async () => {
  const r = await recommendModel(
    { task: 'x' },
    ON,
    {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            answers: { kind: { type: 'choice', choice: '瞎编的类别', confidence: 1 } },
          }),
      }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.source, 'fallback');
});

test('Jev 网络失败 → 落回 fallback，不阻塞分配', async () => {
  const r = await recommendModel(
    { task: 'x' },
    ON,
    {
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.source, 'fallback');
  assert.ok(r.pick);
});
