/**
 * TypeSafe / Jev 决策模型客户端。
 *
 * 职责：把"一次决策请求"翻译成 HTTP 调用，只负责传输与错误归类；
 * 决策逻辑不在这里（见 decision-router.js）。
 *
 * 端点语义（实测确认）：
 *   · https://api.typesafe.ai 是 TypeSafe 官方端点，key 属于它
 *   · https://jev-ai.pro/api  是 Jev AI 的兼容端点，key 不通用
 *   两者用同一个 key 实测：官方 200 / 兼容端点 401，所以不要混用。
 *
 * 请求格式（文档与实际 schema 不一致，以实测为准）：
 *   POST {baseUrl}/v1/systemone
 *   {
 *     model: 'jev-latest',
 *     state: { ... 要判断的内容 ... } | '纯文本',
 *     questions: {
 *       <名字>: { type: 'noul',    instructions: '是/否问题' },
 *               { type: 'choice',  instructions, criteria: { 选项: 适用条件 } },
 *               { type: 'score',   instructions, criteria: ['档位描述', ...] },
 *     }
 *   }
 *
 *   注意 choice 的选项在 **criteria 对象**里，不是 options 数组；
 *   score 也要 criteria（列出档位），不是 min/max。
 *
 * 响应：
 *   {
 *     model: 'jev-1.14.0',
 *     answers: {
 *       <名字>: { type: 'noul',   noul: 0.98 },          // 0~1 概率，不是布尔
 *               { type: 'choice', choice: 'billing', confidence: 0.97, probabilities: {...} },
 *               { type: 'score',  score: 4 },
 *     },
 *     usage: { input_tokens, output_tokens }
 *   }
 */

/** 请求发不出去 / 发出去但对方不认，导致本轮无法用 Jev 决策的错误种类。 */
export const JEV_FAILURE = Object.freeze({
  /** 没配置 key 或地址 */
  unconfigured: 'unconfigured',
  /** 网络层失败、超时、5xx —— 可重试但本轮不重试（决策不等人） */
  transport: 'transport',
  /** 401/403 —— key 错，重试无意义 */
  auth: 'auth',
  /** 400/422 —— 请求体不合法，是我们的 bug */
  badRequest: 'badRequest',
  /** 200 但结构不符预期 */
  badResponse: 'badResponse',
});

export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const JEV_DEFAULT_MODEL = 'jev-latest';

/**
 * 接入方式。
 *
 *   typesafe —— TypeSafe 官方 Jev。地址固定、模型名固定（jev-latest），
 *               用户只需要填 key。少让用户填两个他本来也不知道填什么的字段。
 *   custom   —— 任何兼容 /v1/systemone 的服务（自建、中转、别家）。
 *               地址和模型名都得用户自己给 —— 我们无从猜测。
 *
 * 为什么要分这两种而不是"全都让用户填"：
 *   绝大多数人用的是官方，让他填地址和模型名纯属负担，
 *   而且填错（比如把 /v1 填进去）只会得到一堆 404。
 */
export const JEV_MODE = Object.freeze({
  typesafe: 'typesafe',
  custom: 'custom',
});

/**
 * 拼出"列模型"的地址。
 *
 * 两种习惯都要认，否则会拼出 /v1/v1/models：
 *   · TypeSafe 官方：baseUrl = https://api.typesafe.ai（不带 /v1）
 *   · OpenAI 兼容：  baseUrl = https://xxx/v1（绝大多数中转都是这么填的）
 *
 * 用户不应该为了让我们拼对而记住"别带 /v1"这种规矩。
 */
export function modelsUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/v\d+$/.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

/** 某个接入方式下，地址和模型名的默认值。 */
export function endpointsForMode(mode, { baseUrl = '', model = '' } = {}) {
  if (mode === JEV_MODE.custom) {
    return { baseUrl: String(baseUrl || '').trim(), model: String(model || '').trim() };
  }
  return { baseUrl: JEV_DEFAULT_BASE_URL, model: model || JEV_DEFAULT_MODEL };
}

/** 决策请求的超时。超过这个时间就不等了 —— 决策点通常卡在用户交互路径上。 */
export const JEV_DEFAULT_TIMEOUT_MS = 8000;

/**
 * 把 HTTP 状态码和异常归类成 JEV_FAILURE。
 * 纯函数，便于单测覆盖"哪类错该重试、哪类不该"。
 */
export function classifyFailure(status, error) {
  if (!status) {
    const name = String(error?.name || '');
    if (name === 'AbortError' || /abort|timeout/i.test(String(error?.message || ''))) {
      return JEV_FAILURE.transport;
    }
    return JEV_FAILURE.transport;
  }
  if (status === 401 || status === 403) return JEV_FAILURE.auth;
  if (status === 400 || status === 422) return JEV_FAILURE.badRequest;
  if (status >= 500) return JEV_FAILURE.transport;
  return JEV_FAILURE.badResponse;
}

/**
 * 解析 serviceOne 响应，取出每个问题的结论。
 *
 * 为什么不直接透传 answers：调用方要的是"是/否/哪个选项/几分"，
 * 而不是带着 type 标签的原始结构。这里归一成普通值，
 * 顺便把 noul 的概率按阈值折成布尔 —— 概率留着给上层的置信度判断用。
 *
 * @returns {{ values: Record<string, any>, confidences: Record<string, number>, model: string, usage: object }}
 */
export function parseAnswers(json, questions = {}, { noulThreshold = 0.5 } = {}) {
  const values = {};
  const confidences = {};
  const answers = json && typeof json === 'object' ? json.answers : null;
  if (!answers || typeof answers !== 'object') {
    return { values, confidences, model: json?.model ?? '', usage: json?.usage ?? {} };
  }
  for (const [name, raw] of Object.entries(answers)) {
    if (!raw || typeof raw !== 'object') continue;
    const declared = questions[name]?.type ?? raw.type;
    if (declared === 'noul') {
      const p = Number(raw.noul);
      values[name] = Number.isFinite(p) ? p >= noulThreshold : null;
      // 概率离 0.5 越远越有把握
      confidences[name] = Number.isFinite(p) ? Math.abs(p - 0.5) * 2 : 0;
    } else if (declared === 'choice') {
      values[name] = typeof raw.choice === 'string' ? raw.choice : null;
      confidences[name] = Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0;
    } else if (declared === 'score') {
      const s = Number(raw.score);
      values[name] = Number.isFinite(s) ? s : null;
      confidences[name] = 1;
    } else {
      // 未知类型：原样保留，让调用方自己判断
      values[name] = raw.choice ?? raw.score ?? raw.noul ?? null;
      confidences[name] = 0;
    }
  }
  return { values, confidences, model: json?.model ?? '', usage: json?.usage ?? {} };
}

/**
 * 发一次决策请求。
 *
 * 设计要点：
 *   · 不抛异常 —— 决策点的调用方是在用户路径上，抛出去就得包 try/catch，
 *     不如统一返回 { ok, failure, error }，让调用方决定降级方式。
 *   · 单次超时 + 不重试 —— 决策比"最终一致"更看延迟；重试留给上层决定。
 *   · fetch 可注入 —— 单测不打真网。
 *
 * @returns {Promise<{ok:boolean, values?:object, confidences?:object, model?:string,
 *                    usage?:object, failure?:string, error?:string, ms:number}>}
 */
export async function jevDecide({
  baseUrl,
  apiKey,
  model,
  state,
  questions,
  timeoutMs = JEV_DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  noulThreshold = 0.5,
} = {}) {
  const started = Date.now();
  const fail = (failure, error) => ({
    ok: false,
    failure,
    error,
    ms: Date.now() - started,
  });

  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const key = String(apiKey || '').trim();
  if (!base || !key) return fail(JEV_FAILURE.unconfigured, '未配置 Jev 的地址或 key');
  if (typeof fetchImpl !== 'function') return fail(JEV_FAILURE.transport, '运行环境没有 fetch');
  if (!questions || !Object.keys(questions).length) {
    return fail(JEV_FAILURE.badRequest, '没有要判断的问题');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 0));
  let status = 0;
  let json = null;
  let text = '';
  try {
    const res = await fetchImpl(`${base}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: model || JEV_DEFAULT_MODEL,
        state: state ?? '',
        questions,
      }),
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text().catch(() => '');
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      // 错误体里通常有 message/detail，取一小段给排查用
      const detail = json?.message || json?.detail?.[0]?.msg || text.slice(0, 200);
      return fail(classifyFailure(status, null), `HTTP ${status}${detail ? `：${detail}` : ''}`);
    }
  } catch (err) {
    return fail(classifyFailure(0, err), String(err?.message || err));
  } finally {
    clearTimeout(timer);
  }

  if (!json || typeof json !== 'object' || !json.answers) {
    return fail(JEV_FAILURE.badResponse, '响应里没有 answers');
  }
  const { values, confidences, model: used, usage } = parseAnswers(json, questions, {
    noulThreshold,
  });
  if (!Object.keys(values).length) {
    return fail(JEV_FAILURE.badResponse, 'answers 为空');
  }
  return {
    ok: true,
    values,
    confidences,
    model: used,
    usage,
    ms: Date.now() - started,
  };
}

/**
 * 连通性自检：只读模型列表，不产生推理费用。
 *
 * 用来在设置页做"配好了吗"的即时反馈 —— 用户填完 key 不该等到
 * 真正派活时才发现 401。
 */
export async function jevProbe({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
} = {}) {
  const started = Date.now();
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const key = String(apiKey || '').trim();
  if (!base || !key) {
    return { ok: false, failure: JEV_FAILURE.unconfigured, error: '未配置地址或 key', ms: 0 };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, failure: JEV_FAILURE.transport, error: '运行环境没有 fetch', ms: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 0));
  try {
    const res = await fetchImpl(`${modelsUrl(base)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        detail = j?.message || j?.detail?.[0]?.msg || detail;
      } catch {
        /* 非 JSON 就用原文前 200 字 */
      }
      return {
        ok: false,
        failure: classifyFailure(res.status, null),
        error: `HTTP ${res.status}${detail ? `：${detail}` : ''}`,
        ms: Date.now() - started,
      };
    }
    let models = [];
    try {
      const j = JSON.parse(text);
      // TypeSafe：{ models: [{ name }] }
      // OpenAI 兼容：{ data: [{ id }] }
      // 两种都要认 —— 自定义端点多半是后者，不认的话"测一下"会说
      // "连通了但一个模型都没有"，用户不知道该填什么。
      if (Array.isArray(j?.models)) {
        models = j.models.map((m) => m?.name || m?.id).filter(Boolean);
      } else if (Array.isArray(j?.data)) {
        models = j.data.map((m) => m?.id || m?.name).filter(Boolean);
      }
    } catch {
      /* 结构不符也当连通，至少 200 了 */
    }
    return { ok: true, models, ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      failure: classifyFailure(0, err),
      error: String(err?.message || err),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
