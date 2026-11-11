import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  POINTS,
  POINT_WEIGHT,
  isJevCandidate,
  shouldUseJev,
  decide,
  shouldAskShouldReply,
  interpretShouldReply,
} from '../src/decision-router.js';
import {
  classifyFailure,
  parseAnswers,
  jevDecide,
  jevProbe,
  JEV_FAILURE,
  JEV_DEFAULT_BASE_URL,
} from '../src/jev-client.js';

// ---------------------------------------------------------------------------
// 快速决策路由：两条线
//
//   开 Jev → 注册过的点走 Jev
//   没开   → 一切走原有逻辑（表现为 shouldUseJev 返回 false）
// ---------------------------------------------------------------------------

const ON = { enabled: true, baseUrl: 'https://api.typesafe.ai', apiKey: 'k' };
const OFF = { enabled: false };

test('没开开关时一律不走 Jev', () => {
  assert.equal(shouldUseJev('assign-model', OFF).use, false);
  assert.match(shouldUseJev('assign-model', OFF).why, /没开/);
});

test('开着但缺地址或 key 也不走', () => {
  assert.equal(shouldUseJev('assign-model', { enabled: true, apiKey: 'k' }).use, false);
  assert.equal(shouldUseJev('assign-model', { enabled: true, baseUrl: 'x' }).use, false);
});

test('开着且配好、点已注册 → 走 Jev', () => {
  const g = shouldUseJev('assign-model', ON);
  assert.equal(g.use, true);
});

test('没注册的决策点不走 —— 不认识的活不要瞎发请求', () => {
  assert.equal(shouldUseJev('made-up-point', ON).use, false);
  assert.match(shouldUseJev('made-up-point', ON).why, /未注册/);
});

test('可以单独关掉某个点，但不影响其他点', () => {
  const s = { ...ON, disabledPoints: ['should-reply'] };
  assert.equal(shouldUseJev('should-reply', s).use, false);
  assert.equal(shouldUseJev('assign-model', s).use, true);
});

test('unsuitable 级别的点永远不走', () => {
  // 危险命令放行这类判断必须确定性，不能交给概率模型
  for (const [name, def] of Object.entries(POINTS)) {
    if (def.weight === POINT_WEIGHT.unsuitable) {
      assert.equal(isJevCandidate(name), false);
    }
  }
});

test('注册表里每个点都有说明、问题、build 与校验器', () => {
  for (const [name, def] of Object.entries(POINTS)) {
    assert.ok(def.description, name + ' 缺 description');
    assert.ok(def.questions && Object.keys(def.questions).length, name + ' 缺 questions');
    assert.equal(typeof def.build, 'function', name + ' 缺 build');
    assert.equal(typeof def.validate, 'function', name + ' 缺 validate');
  }
});

test('高频/高危的点必须标 careful 而不是 ideal', () => {
  // should-reply 群里每条消息都可能触发，不该当作"随便调"
  assert.equal(POINTS['should-reply'].weight, POINT_WEIGHT.careful);
});

// ---------------------------------------------------------------------------
// 失败归类
// ---------------------------------------------------------------------------

test('401/403 归为鉴权错 —— 重试没意义', () => {
  assert.equal(classifyFailure(401), JEV_FAILURE.auth);
  assert.equal(classifyFailure(403), JEV_FAILURE.auth);
});

test('5xx 与网络异常归为传输错', () => {
  assert.equal(classifyFailure(500), JEV_FAILURE.transport);
  assert.equal(classifyFailure(0, new Error('ECONNRESET')), JEV_FAILURE.transport);
});

test('400/422 归为请求体错误 —— 是我们的 bug', () => {
  assert.equal(classifyFailure(422), JEV_FAILURE.badRequest);
});

// ---------------------------------------------------------------------------
// 答案解析
// ---------------------------------------------------------------------------

test('noul 是概率，按阈值折成布尔', () => {
  const json = { answers: { q: { type: 'noul', noul: 0.98 } } };
  const { values, confidences } = parseAnswers(json, { q: { type: 'noul' } });
  assert.equal(values.q, true);
  assert.ok(confidences.q > 0.9, '概率越偏离 0.5，置信度越高');
});

test('noul 低概率判为否', () => {
  const json = { answers: { q: { type: 'noul', noul: 0.2 } } };
  assert.equal(parseAnswers(json, { q: { type: 'noul' } }).values.q, false);
});

test('阈值可调', () => {
  const json = { answers: { q: { type: 'noul', noul: 0.6 } } };
  assert.equal(parseAnswers(json, { q: { type: 'noul' } }, { noulThreshold: 0.7 }).values.q, false);
});

test('choice 取选项名与置信度', () => {
  const json = {
    answers: { c: { type: 'choice', choice: 'billing', confidence: 1.0 } },
  };
  const { values, confidences } = parseAnswers(json, { c: { type: 'choice' } });
  assert.equal(values.c, 'billing');
  assert.equal(confidences.c, 1.0);
});

test('score 取分数', () => {
  const json = { answers: { s: { type: 'score', score: 4 } } };
  assert.equal(parseAnswers(json, { s: { type: 'score' } }).values.s, 4);
});

test('answers 缺失时返回空，不抛', () => {
  assert.deepEqual(parseAnswers({}, {}).values, {});
  assert.deepEqual(parseAnswers(null, {}).values, {});
});

// ---------------------------------------------------------------------------
// 传输层
// ---------------------------------------------------------------------------

const stubFetch = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('没配地址/key 时直接判失败，不发请求', async () => {
  let called = false;
  const r = await jevDecide({
    questions: { q: { type: 'noul', instructions: 'x' } },
    fetchImpl: async () => {
      called = true;
      return stubFetch(200, {})();
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure, JEV_FAILURE.unconfigured);
  assert.equal(called, false, '没配置就不该发请求');
});

test('正常响应解析出值', async () => {
  const r = await jevDecide({
    baseUrl: 'https://api.typesafe.ai',
    apiKey: 'k',
    state: { doc: 'x' },
    questions: { urgent: { type: 'noul', instructions: '急吗' } },
    fetchImpl: stubFetch(200, {
      model: 'jev-1.14.0',
      answers: { urgent: { type: 'noul', noul: 0.97 } },
      usage: { input_tokens: 384, output_tokens: 54 },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.values.urgent, true);
  assert.equal(r.model, 'jev-1.14.0');
});

test('401 判鉴权失败且带原因', async () => {
  const r = await jevDecide({
    baseUrl: 'https://api.typesafe.ai',
    apiKey: 'bad',
    questions: { q: { type: 'noul', instructions: 'x' } },
    fetchImpl: stubFetch(401, { message: 'The API key is invalid.' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure, JEV_FAILURE.auth);
  assert.match(r.error, /401/);
});

test('200 但响应里没有 answers → 判坏响应', async () => {
  const r = await jevDecide({
    baseUrl: 'https://api.typesafe.ai',
    apiKey: 'k',
    questions: { q: { type: 'noul', instructions: 'x' } },
    fetchImpl: stubFetch(200, { ok: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure, JEV_FAILURE.badResponse);
});

test('探针只读 /v1/models，不产生推理', async () => {
  let path = '';
  const r = await jevProbe({
    baseUrl: 'https://api.typesafe.ai',
    apiKey: 'k',
    fetchImpl: async (url) => {
      path = url;
      return stubFetch(200, { models: [{ name: 'jev-latest' }] })();
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['jev-latest']);
  assert.match(path, /\/v1\/models$/);
});

test('默认端点是 TypeSafe 官方（不是 Jev AI 兼容端点）', () => {
  // 实测：同一个 key 在 jev-ai.pro 上是 401，在 api.typesafe.ai 上是 200
  assert.equal(JEV_DEFAULT_BASE_URL, 'https://api.typesafe.ai');
});

// ---------------------------------------------------------------------------
// decide：完整链路 + 降级
// ---------------------------------------------------------------------------

test('关着的时候 decide 直接 fallback，不发请求', async () => {
  let called = false;
  const r = await decide('assign-model', { task: 'x' }, OFF, {
    fetchImpl: async () => {
      called = true;
      return stubFetch(200, {})();
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.source, 'fallback');
  assert.equal(called, false);
});

test('开着且答案合法 → source=jev', async () => {
  const r = await decide(
    'assign-model',
    { task: '写个爬虫', botName: '小明', botRole: '工程' },
    ON,
    {
      fetchImpl: stubFetch(200, {
        answers: {
          kind: { type: 'choice', choice: 'coding', confidence: 0.9 },
          needsLongContext: { type: 'noul', noul: 0.2 },
          needsSpeed: { type: 'noul', noul: 0.8 },
        },
      }),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.source, 'jev');
  assert.equal(r.values.kind, 'coding');
});

test('答案没通过校验 → 落回 fallback，不把瞎猜当真', async () => {
  const r = await decide('assign-model', { task: 'x' }, ON, {
    // 选项名不在允许集合里
    fetchImpl: stubFetch(200, {
      answers: { kind: { type: 'choice', choice: '不存在的类别', confidence: 1 } },
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'invalidAnswer');
});

test('careful 级别的点置信度不足时落回 fallback', async () => {
  const r = await decide('should-reply', { message: '随便一句' }, ON, {
    fetchImpl: stubFetch(200, {
      answers: {
        shouldReply: { type: 'noul', noul: 0.52 }, // 几乎等于瞎猜
        urgency: { type: 'score', score: 2 },
      },
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'lowConfidence');
});

test('careful 级别置信度够高时放行', async () => {
  const r = await decide('should-reply', { message: '这个报错怎么修' }, ON, {
    fetchImpl: stubFetch(200, {
      answers: {
        shouldReply: { type: 'noul', noul: 0.95 },
        urgency: { type: 'score', score: 3 },
      },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.values.shouldReply, true);
});

test('ideal 级别的点不受置信度门槛影响', async () => {
  const r = await decide('assign-model', { task: 'x' }, ON, {
    fetchImpl: stubFetch(200, {
      answers: { kind: { type: 'choice', choice: 'routine', confidence: 0.51 } },
    }),
  });
  assert.equal(r.ok, true);
});

test('网络失败时 fallback 并带失败原因', async () => {
  const r = await decide('assign-model', { task: 'x' }, ON, {
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.source, 'fallback');
  assert.equal(r.failure, JEV_FAILURE.transport);
});


// ---------------------------------------------------------------------------
// should-reply：群聊里「这个 bot 要不要接这条消息」
//
//   测的是两个纯函数：
//     · shouldAskShouldReply —— 便宜规则（要不要问模型）
//     · interpretShouldReply —— 结论解读（答完开不开跑）
//   主流程的接入点由 pi-runner 负责，这里不碰网络。
// ---------------------------------------------------------------------------

test('被 @ / 明确派活 → 不问 should-reply，直接开跑', () => {
  const r = shouldAskShouldReply({ addressed: true, enabled: true });
  assert.equal(r.ask, false, '被点名时不该再问模型');
  assert.match(r.why, /直接开跑/);
});

test('未点名但 Jev 开着 → 需要问一次', () => {
  const r = shouldAskShouldReply({ addressed: false, enabled: true });
  assert.equal(r.ask, true);
});

test('Jev 没开时保持原行为：不判断也不拦截', () => {
  const r = shouldAskShouldReply({ addressed: false, enabled: false });
  assert.equal(r.ask, false);
  assert.match(r.why, /Jev 没开/);
});

test('同一条消息对同一个 bot 只判断一次（节流）', () => {
  const r = shouldAskShouldReply({ addressed: false, enabled: true, alreadyAsked: true });
  assert.equal(r.ask, false);
  assert.match(r.why, /已经判断过/);
});

test('★ 只有 shouldReply === true 才开跑', () => {
  assert.equal(interpretShouldReply({ ok: true, values: { shouldReply: true } }).run, true);
  assert.equal(interpretShouldReply({ ok: true, values: { shouldReply: false } }).run, false);
});

test('★ 判断失败一律不开跑：ok:false / 超时 / 抛错 / 校验不过', () => {
  for (const failure of ['timeout', 'transport', 'invalidAnswer', 'lowConfidence', 'badResponse']) {
    const r = interpretShouldReply({ ok: false, failure, why: 'x' });
    assert.equal(r.run, false, failure + ' 时应不开跑');
  }
  // 抛错在 decide 内部已被转成 ok:false；完全没有回包也不能当成可以说话
  assert.equal(interpretShouldReply(undefined).run, false);
  assert.equal(interpretShouldReply(null).run, false);
  assert.equal(interpretShouldReply({}).run, false);
});

test('★ shouldReply 不是 boolean 或 values 缺失 → 不开跑', () => {
  // values 整个缺失
  assert.equal(interpretShouldReply({ ok: true }).run, false);
  assert.equal(interpretShouldReply({ ok: true, values: {} }).run, false);
  assert.equal(interpretShouldReply({ ok: true, values: null }).run, false);
  // values 有但shouldReply 不是布尔
  for (const v of ['yes', 'true', 1, 0, {}, [], null]) {
    const r = interpretShouldReply({ ok: true, values: { shouldReply: v } });
    assert.equal(r.run, false, 'shouldReply=' + JSON.stringify(v) + ' 不该开跑');
  }
});

test('validate 也挡住非布尔：双层防护', () => {
  assert.equal(POINTS['should-reply'].validate({ shouldReply: true }), true);
  assert.equal(POINTS['should-reply'].validate({ shouldReply: false }), true);
  assert.equal(POINTS['should-reply'].validate({ shouldReply: 'yes' }), false);
  assert.equal(POINTS['should-reply'].validate({}), false);
});
