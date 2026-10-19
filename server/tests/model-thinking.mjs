/**
 * 思考强度的合并规则；只用纯函数，起服务端/网络都不需要。
 *
 * 这些断言盯的是"静默降智"：thinkingFormat 填错、档位映射丢了、或者关掉思考后
 * 上一步的 thinkingFormat 还挂着继续下发 —— 三种情况都不会报错，只会让模型变笨。
 */
import assert from 'node:assert/strict';

import {
  THINKING_FORMATS,
  THINKING_LEVELS,
  THINKING_PRESETS,
  describeThinking,
  normalizeFormat,
  normalizeThinking,
  thinkingCompat,
  thinkingLevelMapError,
  availableThinkingLevels,
} from '../src/model-thinking.js';
import { mergeGroupModels } from '../src/model-capacity.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

const preset = { ...THINKING_PRESETS.deepseek };

await test('档位列表是 pi 认的七个，且顺序稳定', () => {
  assert.deepEqual(THINKING_LEVELS, [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
});

await test('格式列表不含 pi schema 之外的写法', () => {
  for (const format of THINKING_FORMATS) {
    assert.match(format, /^[a-z][a-z-]*$/);
  }
  assert.ok(!THINKING_FORMATS.includes('openai-completions'));
});

await test('只认白名单格式，大小写与空白会被归一', () => {
  assert.equal(normalizeFormat(' DeepSeek '), 'deepseek');
  assert.equal(normalizeFormat('瞎写的'), '');
  assert.equal(normalizeFormat(undefined), '');
});

await test('给了格式和 reasoning 时自动套用该格式的预设映射', () => {
  const thinking = normalizeThinking({
    reasoning: true,
    thinkingFormat: 'deepseek',
  });
  assert.equal(thinking.reasoning, true);
  assert.equal(thinking.thinkingFormat, 'deepseek');
  assert.deepEqual(thinking.thinkingLevelMap, preset);
  assert.equal(thinking.thinkingLevelMap.xhigh, 'max');
});

await test('显式映射覆盖预设，空串表示这一档不传', () => {
  const thinking = normalizeThinking({
    reasoning: true,
    thinkingFormat: 'deepseek',
    thinkingLevelMap: { high: 'MAX_SAFE', xhigh: '', off: null },
  });
  assert.deepEqual(thinking.thinkingLevelMap, { high: 'MAX_SAFE', off: null });
});

await test('不思考时格式和映射一律清空，避免残留继续下发', () => {
  const thinking = normalizeThinking({
    reasoning: false,
    thinkingFormat: 'deepseek',
    thinkingLevelMap: { high: 'high' },
  });
  assert.equal(thinking.reasoning, false);
  assert.equal(thinking.thinkingFormat, '');
  assert.equal(thinking.thinkingLevelMap, null);
});

await test('改格式会换用新格式的预设，不会沿用上一个格式的映射', () => {
  const previous = normalizeThinking({
    reasoning: true,
    thinkingFormat: 'openai',
  });
  const next = normalizeThinking(
    { reasoning: true, thinkingFormat: 'deepseek' },
    previous,
  );
  assert.equal(next.thinkingFormat, 'deepseek');
  assert.equal(next.thinkingLevelMap.xhigh, 'max');
});

await test('没改思考设置时沿用已存配置', () => {
  const previous = normalizeThinking({
    reasoning: true,
    thinkingFormat: 'deepseek',
  });
  const next = normalizeThinking({}, previous);
  assert.equal(next.reasoning, true);
  assert.equal(next.thinkingFormat, 'deepseek');
  assert.deepEqual(next.thinkingLevelMap, previous.thinkingLevelMap);
});

await test('新模型没给思考设置 = 不思考，不猜上游能力', () => {
  const thinking = normalizeThinking({ id: 'some-model' });
  assert.equal(thinking.reasoning, false);
  assert.equal(thinking.thinkingFormat, '');
  assert.equal(thinking.thinkingLevelMap, null);
});

await test('映射校验拦下不认识的档位和非字符串值', () => {
  assert.match(thinkingLevelMapError({ turbo: 'high' }), /不认识/);
  assert.match(thinkingLevelMapError({ high: 3 }), /字符串/);
  assert.equal(thinkingLevelMapError({ high: 'high', off: null }), null);
  assert.equal(thinkingLevelMapError(null), null);
});

await test('compat 在不思考时关掉 supportsReasoningEffort', () => {
  assert.deepEqual(thinkingCompat({ reasoning: false }), {
    supportsReasoningEffort: false,
  });
  assert.deepEqual(
    thinkingCompat({ reasoning: true, thinkingFormat: 'deepseek' }),
    { supportsReasoningEffort: true, thinkingFormat: 'deepseek' },
  );
});

await test('摘要文案能区分不思考与已映射档位', () => {
  assert.equal(describeThinking({ reasoning: false }), '不思考');
  assert.match(
    describeThinking({ reasoning: true, thinkingFormat: 'deepseek', thinkingLevelMap: preset }),
    /deepseek · 7 档/,
  );
});

await test('mergeGroupModels 把思考设置合进模型，且不碰容量', () => {
  const merged = mergeGroupModels(
    [
      {
        id: 'wb-deepseek-v4.1-flash',
        contextWindow: 1000000,
        maxTokens: 128000,
        reasoning: true,
        thinkingFormat: 'deepseek',
      },
    ],
    {},
    [],
  );
  assert.equal(merged.error, undefined);
  const model = merged.models[0];
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingFormat, 'deepseek');
  assert.equal(model.thinkingLevelMap.xhigh, 'max');
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.maxTokens, 128000);
});

await test('mergeGroupModels 拒绝非法档位映射', () => {
  const merged = mergeGroupModels(
    [{ id: 'm', reasoning: true, thinkingLevelMap: { turbo: 'high' } }],
    {},
    [],
  );
  assert.match(merged.error, /思考档位 turbo 不认识/);
});

await test('已有模型不传思考字段时保留原来的思考配置', () => {
  const previous = [
    {
      id: 'm',
      contextWindow: 1000,
      maxTokens: 100,
      reasoning: true,
      thinkingFormat: 'zai',
      thinkingLevelMap: { high: 'high' },
    },
  ];
  const merged = mergeGroupModels([{ id: 'm' }], {}, previous);
  assert.equal(merged.error, undefined);
  assert.equal(merged.models[0].thinkingFormat, 'zai');
  assert.deepEqual(merged.models[0].thinkingLevelMap, { high: 'high' });
});


await test('availableThinkingLevels：关掉思考就没有任何档位', () => {
  assert.deepEqual(availableThinkingLevels({ reasoning: false }), []);
  assert.deepEqual(availableThinkingLevels({}), []);
});

await test('availableThinkingLevels：开了思考但没映射 = 七档全给', () => {
  assert.deepEqual(
    availableThinkingLevels({ reasoning: true }),
    THINKING_LEVELS,
  );
});

await test('availableThinkingLevels：只返回映射过的档位（前台靠它渲染）', () => {
  assert.deepEqual(
    availableThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { off: null, low: 'low', high: 'high' },
    }),
    ['off', 'low', 'high'],
  );
});

await test('availableThinkingLevels 与 deepseek 预设有七个档位', () => {
  assert.deepEqual(
    availableThinkingLevels({ reasoning: true, thinkingLevelMap: preset }),
    THINKING_LEVELS,
  );
});

console.log(`\n${failed ? '✗' : '✓'} ${passed} 通过，${failed} 失败`);
await test('availableThinkingLevels：没有 max 映射就不给 max（pi 会 clamp 成 high）', () => {
  const levels = availableThinkingLevels({
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  });
  assert.ok(levels.includes('off'), 'off 永远可选');
  assert.ok(!levels.includes('max'));
  assert.ok(!levels.includes('xhigh'));
});

await test('availableThinkingLevels：显式映射 max 才给 max', () => {
  const levels = availableThinkingLevels({
    reasoning: true,
    thinkingLevelMap: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' },
  });
  assert.ok(levels.includes('max'));
  assert.ok(levels.includes('off'), 'map 里没写 off 也算可选');
  assert.ok(!levels.includes('xhigh'), 'xhigh 没映射就不给');
});

await test('availableThinkingLevels：off:null 不会把 off 删掉', () => {
  const levels = availableThinkingLevels({
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', high: 'high' },
  });
  assert.ok(levels.includes('off'));
});

if (failed) process.exit(1);
