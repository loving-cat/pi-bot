/**
 * 快速决策路由框架。
 *
 * ## 为什么要有这一层
 *
 * 产品里有一批"小判断"：这条消息该派给哪个 bot、这段上下文压完要不要保留、
 * 这次的活值得挂哪个 MCP、要不要现在插话……这些判断的共性是：
 *   · 答案是**有限集合**里的一个（谁 / 是或否 / 哪一档）
 *   · 判错代价可接受，判对能明显省事
 *   · 走一次完整 LLM 调用太贵，也慢
 *
 * Jev 这类"决策模型"正好干这个：输入一段文本 + 几个具名问题，
 * 输出结构化答案，一次几百 token、不到一秒。
 *
 * ## 两条线
 *
 * 用户不开 Jev 时，所有决策点走各自原有的逻辑（规则 / 主控 LLM / 启发式）。
 * 开了之后，**只有注册表里声明 supported 的决策点**才切到 Jev —— 不是全局替换。
 *
 * 这个区分很重要：有的判断必须确定性（比如危险命令放行），
 * 有的判断高频到不能每次都发网络请求。逐点声明，才能既拿到收益又不翻车。
 *
 * ## 一次决策的生命周期
 *
 *   1. 调用方给 point 名字 + 判断素材
 *   2. 框架查注册表：这个点开了吗？支持 Jev 吗？
 *   3. 支持 → 组请求 → 调 Jev → 解析 → **再跑一遍校验器**（模型说的不一定合法）
 *   4. 任何一步不成立 → 返回 fallback，让调用方走原有逻辑
 *
 * 第 3 步的复验不能省：决策模型输出的是概率和选项名，
 * 它不是"权威"，只是一个更快的判断者。选项名拼错、分数越界、
 * 置信度太低，都必须落回原逻辑，而不是把一个瞎猜的结果当真。
 */

import { jevDecide, JEV_FAILURE } from './jev-client.js';

/** 决策点优先级：值不值得为它付出一次网络往返。 */
export const POINT_WEIGHT = Object.freeze({
  /** 低频、结果可校验、判错也无所谓 —— 优先接 */
  ideal: 'ideal',
  /** 低频但判错有代价 —— 需要置信度门槛 */
  careful: 'careful',
  /** 高频或必须确定性 —— 不接 */
  unsuitable: 'unsuitable',
});

/**
 * 决策点注册表。
 *
 * 每个点必须声明：
 *   · weight    —— 为什么适合/不适合走 Jev
 *   · questions —— 要问 Jev 什么（question 定义按 jev-client 的格式）
 *   · build     —— 把调用方的素材转成 state（喂给模型的文本/对象）
 *   · validate  —— 模型答案的复验：返回 true 才算数
 *   · fallback  —— 走不通时调用方该做什么（只是标签，具体逻辑在调用方）
 *
 * 注册表是**纯数据 + 纯函数**，不碰网络也不碰 store，
 * 所以能直接单测"哪个点该走 Jev"这件事。
 */
export const POINTS = Object.freeze({
  /**
   * 给成员分配模型。
   *
   * 判断内容：这个成员要干什么活 → 该用哪一档模型。
   * 适合 Jev：低频（建组/加成员时才发生）、候选是有限集合、判错用户能改。
   */
  'assign-model': {
    weight: POINT_WEIGHT.ideal,
    description: '给成员分配模型时，按职责挑一档',
    questions: {
      kind: {
        type: 'choice',
        instructions: '这个成员要干的活属于哪一类？',
        criteria: {
          reasoning: '架构设计、复杂排查、需要长链条推理',
          coding: '写代码、改文件、跑命令',
          research: '查资料、读文档、整理信息',
          writing: '写文案、总结、翻译',
          routine: '格式转换、简单查询、流水线操作',
        },
      },
      needsLongContext: {
        type: 'noul',
        instructions: '这个活是否需要读很长的上下文（整个仓库、大量文档）？',
      },
      needsSpeed: {
        type: 'noul',
        instructions: '这个活是否对速度敏感、用户会等着看结果？',
      },
    },
    build: ({ task = '', botName = '', botRole = '' } = {}) => ({
      task: String(task || '').slice(0, 4000),
      member: botName,
      role: botRole,
    }),
    validate: (values) => {
      const kinds = ['reasoning', 'coding', 'research', 'writing', 'routine'];
      return kinds.includes(values?.kind);
    },
  },

  /**
   * 群聊里这条消息要不要接话。
   *
   * 适合但也危险：判断质量高，但**频率太高** —— 群里每来一条都可能触发。
   * 所以标 careful，并要求置信度；低于门槛就走原逻辑。
   */
  'should-reply': {
    weight: POINT_WEIGHT.careful,
    description: '群聊里这条消息值不值得接',
    questions: {
      shouldReply: {
        type: 'noul',
        instructions: '这条消息需要当前这个 bot 回应吗？（别人能答、或只是通知，就不需要）',
      },
      urgency: {
        type: 'score',
        instructions: '回应的紧迫程度',
        criteria: ['可以晚点', '正常', '比较急', '很急'],
      },
    },
    build: ({ message = '', recent = [], botName = '' } = {}) => ({
      message: String(message || '').slice(0, 2000),
      recent: (Array.isArray(recent) ? recent : []).slice(-8).map((m) => String(m).slice(0, 300)),
      me: botName,
    }),
    validate: (values) => typeof values?.shouldReply === 'boolean',
  },

  /**
   * 压缩上下文时，哪些内容必须保住。
   *
   * 适合：低频、纯判断、判错可接受（压坏了下一轮能看出来）。
   */
  'compact-keep': {
    weight: POINT_WEIGHT.ideal,
    description: '压缩时哪些内容不能丢',
    questions: {
      decisions: {
        type: 'noul',
        instructions: '这段对话里有没有已经拍板的决定？（丢了就会重复讨论）',
      },
      unfinished: {
        type: 'noul',
        instructions: '有没有做到一半的活？（丢了就接不上）',
      },
      focus: {
        type: 'choice',
        instructions: '这段对话主要在干什么？',
        criteria: {
          planning: '讨论方案、分工',
          executing: '正在动手做',
          debugging: '排查问题',
          wrapping: '收尾、总结',
        },
      },
    },
    build: ({ transcript = '' } = {}) => ({ transcript: String(transcript || '').slice(0, 6000) }),
    validate: (values) => typeof values?.decisions === 'boolean',
  },

  /**
   * 这次任务该挂哪些 MCP。
   *
   * 适合：低频（建组时）、已有 mcp-capability.js 的规则打底，Jev 只做补充判断。
   */
  'pick-mcp': {
    weight: POINT_WEIGHT.ideal,
    description: '这次任务该挂哪些 MCP 能力',
    questions: {
      needsBrowser: { type: 'noul', instructions: '需要操作网页吗？' },
      needsReverse: { type: 'noul', instructions: '需要逆向分析二进制/包吗？' },
      needsDatabase: { type: 'noul', instructions: '需要连数据库查询吗？' },
    },
    build: ({ task = '' } = {}) => ({ task: String(task || '').slice(0, 4000) }),
    validate: (values) => typeof values?.needsBrowser === 'boolean',
  },
});

/** 某个决策点是否已注册且不是 unsuitable。 */
export function isJevCandidate(point) {
  const def = POINTS[point];
  return Boolean(def) && def.weight !== POINT_WEIGHT.unsuitable;
}

/**
 * 判断这次要不要真的走 Jev。
 *
 * 三重条件缺一不可：全局开着、点支持、且这个点没被单独关掉。
 * 纯函数 —— 单测能覆盖所有组合，不用起服务。
 *
 * @param {string} point
 * @param {{enabled?:boolean, baseUrl?:string, apiKey?:string, disabledPoints?:string[]}} settings
 * @returns {{use:boolean, why:string}}
 */
export function shouldUseJev(point, settings = {}) {
  const { enabled = false, baseUrl = '', apiKey = '', disabledPoints = [] } = settings;
  if (!enabled) return { use: false, why: '后台没开 Jev' };
  if (!isJevCandidate(point)) return { use: false, why: `未注册或不适用的决策点：${point}` };
  if (Array.isArray(disabledPoints) && disabledPoints.includes(point)) {
    return { use: false, why: `这个点被单独关掉了：${point}` };
  }
  if (!String(baseUrl || '').trim() || !String(apiKey || '').trim()) {
    return { use: false, why: '缺少 Jev 地址或 key' };
  }
  return { use: true, why: '走 Jev' };
}

/**
 * 执行一次决策。
 *
 * 调用方拿到 use=false 或 ok=false 时，**必须**走自己的原有逻辑 ——
 * 这是框架的契约：Jev 是加速器，不是唯一路径。
 *
 * @returns {Promise<{ok:boolean, values?:object, confidences?:object,
 *                    source:'jev'|'fallback', failure?:string, error?:string, why:string}>}
 */
export async function decide(point, payload, settings = {}, { fetchImpl, timeoutMs } = {}) {
  const gate = shouldUseJev(point, settings);
  if (!gate.use) {
    return { ok: false, source: 'fallback', why: gate.why };
  }
  const def = POINTS[point];
  const state = def.build?.(payload ?? {});
  const result = await jevDecide({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    state,
    questions: def.questions,
    timeoutMs,
    fetchImpl,
    noulThreshold: settings.noulThreshold ?? 0.5,
  });
  if (!result.ok) {
    return {
      ok: false,
      source: 'fallback',
      failure: result.failure,
      error: result.error,
      why: `Jev 调用失败（${result.failure}）`,
    };
  }
  // 复验：模型给的选项名可能拼错、分数可能越界
  let valid = true;
  try {
    valid = def.validate ? Boolean(def.validate(result.values, payload)) : true;
  } catch {
    valid = false;
  }
  if (!valid) {
    return {
      ok: false,
      source: 'fallback',
      failure: 'invalidAnswer',
      why: 'Jev 的答案没通过校验',
    };
  }
  const minConfidence = POINTS[point].weight === POINT_WEIGHT.careful
    ? Number(settings.carefulMinConfidence ?? 0.75)
    : 0;
  if (minConfidence > 0) {
    const lows = Object.entries(result.confidences ?? {})
      .filter(([, c]) => Number(c) < minConfidence)
      .map(([name]) => name);
    if (lows.length) {
      return {
        ok: false,
        source: 'fallback',
        failure: 'lowConfidence',
        why: `Jev 置信度不足：${lows.join('、')}`,
      };
    }
  }
  return {
    ok: true,
    source: 'jev',
    values: result.values,
    confidences: result.confidences,
    model: result.model,
    usage: result.usage,
    ms: result.ms,
    why: '走 Jev',
  };
}

export { JEV_FAILURE };
