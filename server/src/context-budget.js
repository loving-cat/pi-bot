/**
 * 上下文预算：模型容量覆盖 + 压缩参数 + 占用读数。
 *
 * 本模块只跟 pi 的会话对象打交道，不碰房间、不碰调度：
 *   · withCapacity        把 bot 上设的 contextWindow / maxTokens 盖到模型上
 *   · applyCompactionBudget  把"什么时候压缩、压缩时保留多少"套到会话上
 *   · readContext         读回占用（给界面显示用了多少）
 *
 * 四个数（contextWindow / maxTokens / reserveTokens / keepRecentTokens）
 * 都能被用户或主控单独覆盖，所以每一层都是"设了才覆盖，没设交给下一层"。
 */
import { calculateContextTokens, estimateTokens } from '@earendil-works/pi-coding-agent';

import { config } from './config.js';
import { log } from './util.js';

/** 正数才要，其他一律 null（和 store 里那个同名助手一个意思） */
export function positiveOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * 保留原文必须低于最早触发线，并为摘要和**固定开销**留出空间。
 *
 * ★ 为什么要扣固定开销（fixedOverheadTokens）
 *
 *   上下文里有一块是每轮都在、且压缩动不了的：system prompt + 工具定义。
 *   原来算"压缩后能留多少原文"时只看触发线和摘要预算，没把这块算进去 ——
 *   于是账面上留 6 万，实际留给原文的只剩 6 万减掉固定开销。
 *
 *   实测症状（128k 窗口 / 0.6 触发 / 保留 60k）：
 *     触发线 76.8k，摘要预算 16k，名义保留上限 60.8k
 *     但 system + tools 通常有三四十 k，压完实际腾出的空间只有约 1 万 ——
 *     等于刚压完很快就又到线了，用户感觉"一直在压缩"。
 *
 *   扣掉之后，保留上限是"真正能留给原文的部分"。
 *   不额外设用户可感知的新下限：算出来太小就照实小，回退逻辑交给调用方。
 *
 * @param {object} p
 * @param {number} [p.fixedOverheadTokens] system + tools 占用的 token；不知道就传 0
 */
export function capRecentTokens({
  contextWindow, keepRecentTokens, reserveTokens = 16384, threshold = 0.6,
  fixedOverheadTokens = 0,
}) {
  const cw = positiveOrNull(contextWindow);
  const keep = positiveOrNull(keepRecentTokens);
  if (!cw || !keep) return keep;
  const configuredReserve = positiveOrNull(reserveTokens) ?? 16384;
  const reserve = configuredReserve < cw ? configuredReserve : Math.max(1, Math.floor(cw / 2));
  const ratio = Number.isFinite(Number(threshold))
    ? Math.min(0.95, Math.max(0.2, Number(threshold))) : 0.6;
  const trigger = Math.max(1, Math.floor(Math.min(cw * ratio, cw - reserve)));
  const summaryBudget = Math.min(reserve, Math.floor(trigger / 2));

  // 固定开销不能吃掉全部余量：至少给原文留 1 token，
  // 否则这个函数会返回一个没有意义的负数被上层当成"极小的保留量"。
  const overhead = Math.max(0, Math.floor(Number(fixedOverheadTokens) || 0));
  const roomForRecent = trigger - summaryBudget - overhead;
  return Math.min(keep, Math.max(1, roomForRecent));
}

/**
 * 把 bot 上设的 contextWindow / maxTokens 盖到模型对象上。
 *
 * ★ 只影响这一个会话 —— 不去改 pi 的 models.json。那是全局的，改了连用户在终端里
 *   用的 pi 一起变；而且"每个 bot 一套预算"本来就该是会话级的事。
 * 典型场景：模型标称 1M 上下文 / 32k 输出，但用户知道它实际能出 161k。
 */
export function withCapacity(model, bot = {}) {
  const cw = positiveOrNull(bot.contextWindow);
  const mt = positiveOrNull(bot.maxTokens);
  if (cw == null && mt == null) return model;
  return {
    ...model,
    ...(cw != null ? { contextWindow: cw } : {}),
    ...(mt != null ? { maxTokens: mt } : {}),
  };
}

/**
 * 把某个 bot 的上下文预算套到会话上。
 *
 * 触发线 = contextWindow - reserveTokens 用满就自动压缩；
 * 压缩时保留最近 keepRecentTokens 不总结。
 *
 * 三层回退：bot 上单独设的 → 全局 config（环境变量）→ pi 自带默认（16384 / 20000）。
 * 任何一层是 null 就不覆盖，交给下一层。
 */
/**
 * 校准系数 r：真实 token / estimateTokens 的估计值。
 *
 * ★ 为什么需要
 *
 *   依赖里的 estimateTokens 是 **chars / 4**。英文大致对（4 字符≈1 token），
 *   但中文约 **1 字 1 token** —— 于是 estimateTokens 把中文上下文低估约 4 倍。
 *   而切压缩保留点用的正是这个估计值，所以名义上"保留 6 万 token"
 *   实际留下了 25–29 万字符的原文（Xiao 的实测：压缩前 60.5 万、
 *   压缩请求 input 32–36 万，正是这个比例）。
 *
 *   要按"真实 token"来定保留量，就得先测出这块偏差。
 *
 * ★ 公式（分子分母覆盖同一批上下文，都含 system + 工具 + 全部历史）
 *
 *     分子 realTokens = (最近一次有效 assistant usage 的 input + cacheRead)
 *                     + Σ estimateTokens(该 usage 之后的消息)
 *     分母 estTokens  = estimateTokens(system prompt)
 *                     + Σ estimateTokens(工具定义)
 *                     + Σ estimateTokens(session.messages 全部)
 *     r = realTokens / estTokens
 *
 *   ★ 分子为什么是 input + cacheRead，不是 calculateContextTokens：
 *     calculateContextTokens 是 totalTokens || (input + output + cacheRead + cacheWrite)，
 *     **含 output**（模型这次生成的内容）。而对比基准是"上下文有多长" ——
 *     上下文里没有上一轮的 output（它作为 assistant 消息进了 messages，
 *     由分母的 estimateTokens 计入）。把 output 放分子会让 r 虚高。
 *     压缩请求的 cacheRead 几乎为 0（Xiao 实测），所以实际 ≈ input。
 *
 *   ★ 分母为什么必须补 system 和工具：
 *     真实 usage 覆盖的是**整次请求**（system + 工具定义 + 全部消息）。
 *     只估 messages 会让分母偏小，r 虚高，keep 被算得过小 → 压得太狠。
 *
 * ★ 回退：任一为 0/NaN、或 r 落在不合理区间，返回 null，调用方不动 keep 值。
 *   宁可保持原行为，也不要拿一个错系数把会话压垮。
 */
export function estimateTokenRatio(session) {
  try {
    if (typeof estimateTokens !== 'function' || typeof calculateContextTokens !== 'function') {
      return null;
    }
    const messages = session?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // 分母：system + 工具 + 全部消息（与真实 usage 的覆盖范围对齐）
    let estTokens = 0;
    for (const m of messages) estTokens += estimateTokens(m);
    // system prompt 通常已经在 messages 里（role === 'system'），
    // 但有些分支下它单独挂在 session 上 —— 补一次，重复时不加。
    const hasSystemMsg = messages.some((m) => m?.role === 'system');
    if (!hasSystemMsg) {
      const sys = session?.systemPrompt;
      if (sys) {
        const msg = typeof sys === 'string'
          ? { role: 'system', content: sys }
          : { role: 'system', content: sys.content ?? '', sections: sys.sections };
        estTokens += estimateTokens(msg);
      }
    }
    // 工具定义也是每次请求都发出去的，真实 usage 里算进去了
    estTokens += estimateToolTokens(session);
    if (!Number.isFinite(estTokens) || estTokens <= 0) return null;

    // 分子：找最近一条有效 assistant usage，取其 **input + cacheRead**。
    //
    // 不用 calculateContextTokens —— 它是
    // totalTokens || (input + output + cacheRead + cacheWrite)，**含 output**。
    // 我们要比的是"上下文有多长"，而上一轮的 output 已经作为 assistant 消息
    // 进了 messages（由分母计入）。把它放分子会让 r 虚高、keep 算得过小。
    let usageIndex = -1;
    let usageTokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== 'assistant' || !m.usage) continue;
      if (m.stopReason === 'aborted' || m.stopReason === 'error') continue;
      const u = m.usage;
      const input = Number(u.input ?? u.inputTokens ?? u.input_tokens ?? 0) || 0;
      const cacheRead = Number(u.cacheRead ?? u.cache_read_input_tokens ?? 0) || 0;
      const t = input + cacheRead;
      if (!Number.isFinite(t) || t <= 0) continue;
      usageIndex = i;
      usageTokens = t;
      break;
    }
    if (usageIndex < 0) return null; // 还没有真实 usage（新会话），没得校准

    // usage 之后新追加的消息只能估，补进分子
    let trailing = 0;
    for (let i = usageIndex + 1; i < messages.length; i++) {
      trailing += estimateTokens(messages[i]);
    }
    const realTokens = usageTokens + trailing;
    if (!Number.isFinite(realTokens) || realTokens <= 0) return null;

    const ratio = realTokens / estTokens;
    // 合理区间：英文约 1 倍，纯中文约 4 倍，中文为主 + 大段代码/JSON 时更高。
    // 实测（60 万汉字、真实 60.5 万 token）能到 8 左右，所以上限放到 16 ——
    // 留足余量，同时仍能挡住明显的脏数据（比如 usage 记的是上一次压缩前的，
    // 那种情况会算出几十上百）。
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 16) return null;
    return ratio;
  } catch {
    return null;
  }
}

/**
 * 估算工具定义占的 token（name + description + 参数 schema）。
 *
 * 抽出来是因为两处要用：固定开销（capRecentTokens）和校准分母
 * （estimateTokenRatio）—— 两处用同一套口径，结果才可比。
 */
function estimateToolTokens(session) {
  try {
    // ★ 依赖公开的接口是 getAllTools()，没有 tools getter 也没有 getTools()。
    //   写成后者会永远拿到 undefined → 返回 0 → 工具开销实际一分没扣，
    //   而且不报错（评审组抓到的）。
    //   这里用公开接口；拿不到就当 0（不猜），不影响其它逻辑。
    const tools = typeof session?.getAllTools === 'function'
      ? session.getAllTools()
      : null;
    if (!Array.isArray(tools)) return 0;
    let sum = 0;
    for (const t of tools) {
      const json = JSON.stringify({
        name: t?.name ?? '',
        description: t?.description ?? '',
        parameters: t?.parameters ?? t?.inputSchema ?? null,
      });
      // 与 estimateTokens 同量纲（chars / 4）
      sum += Math.ceil(json.length / 4);
    }
    return sum;
  } catch {
    return 0;
  }
}

/**
 * 估算「每轮都在、压缩动不了」的固定开销：system prompt + 工具定义。
 *
 * 拿不到就返回 0（当作没有固定开销），不猜一个数字糊弄调用方 ——
 * 猜大了会让保留量被无谓压小，猜小了等于没扣。
 *
 * 用 estimateTokens 的同一套口径（chars / 4）估，
 * 这样它和 capRecentTokens 里的其它数字在同一量纲上。
 */
function fixedOverheadOf(session) {
  try {
    if (typeof estimateTokens !== 'function') return 0;
    let sum = 0;
    // system prompt（含 sections / toolsAdded）
    const sys = session?.systemPrompt;
    if (sys) {
      const msg = typeof sys === 'string'
        ? { role: 'system', content: sys }
        : { role: 'system', content: sys.content ?? '', sections: sys.sections };
      sum += estimateTokens(msg);
    }
    // 工具定义：参数 schema 也是每轮都发出去的
    sum += estimateToolTokens(session);
    return sum;
  } catch {
    return 0;
  }
}

export function applyCompactionBudget(session, bot = {}) {
  const sm = session?.settingsManager;
  if (!sm || typeof sm.applyOverrides !== 'function') return null;

  let reserve = positiveOrNull(bot.reserveTokens) ?? config.reserveTokens ?? null;
  let keep = positiveOrNull(bot.keepRecentTokens) ?? config.keepRecentTokens ?? null;
  // ★ 防御：reserve / keep ≥ 上下文窗口 = 没有意义的值。
  //   reserve 用来算"什么时候压缩"，等于窗口时触发线变成 0；
  //   keep 等于窗口时等于"什么都保留"，压缩压不动，会话会一路顶到 100% 再炸。
  //   这种配置直接丢弃，回退到 pi 的默认值。
  const cw = Number(session?.model?.contextWindow ?? 0);
  if (cw > 0) {
    if (reserve != null && reserve >= cw) reserve = null;
    if (keep != null && keep >= cw) keep = null;
  }
  const overrides = {};
  if (reserve != null) overrides.reserveTokens = reserve;
  if (keep != null) overrides.keepRecentTokens = keep;
  if (cw > 0) {
    let existing = {};
    try { existing = sm.getCompactionSettings?.(session.model) ?? {}; } catch {}
    let effectiveReserve = reserve ?? positiveOrNull(existing.reserveTokens) ?? 16384;
    if (effectiveReserve >= cw) {
      effectiveReserve = Math.max(1, Math.floor(cw / 2));
      overrides.reserveTokens = effectiveReserve;
    }
    const requestedKeep = keep ?? positiveOrNull(existing.keepRecentTokens) ?? 20000;
    const boundedKeep = capRecentTokens({
      contextWindow: cw, keepRecentTokens: requestedKeep,
      reserveTokens: effectiveReserve, threshold: config.compactAtPercent,
      // system prompt + 工具定义是压缩动不了的固定开销，必须从"能留给原文的空间"里扣掉
      fixedOverheadTokens: fixedOverheadOf(session),
    });
    if (boundedKeep < requestedKeep) {
      overrides.keepRecentTokens = boundedKeep;
    }
    const model = session.model;
    if (model?.provider && model?.id
        && (overrides.keepRecentTokens != null || overrides.reserveTokens != null)) {
      overrides.modelOverrides = {
        [`${model.provider}/${model.id}`]: {
          ...(overrides.keepRecentTokens != null ? { keepRecentTokens: overrides.keepRecentTokens } : {}),
          ...(overrides.reserveTokens != null ? { reserveTokens: overrides.reserveTokens } : {}),
        },
      };
    }
  }
  if (!config.autoCompact) overrides.enabled = false;
  if (Object.keys(overrides).length === 0) return null;
  try {
    sm.applyOverrides({ compaction: overrides });
    return overrides;
  } catch (err) {
    log('⚠️  设置上下文预算失败：', err?.message || err);
    return null;
  }
}

/**
 * 读一个会话的上下文占用。
 *
 * 返回 null 表示"现在还不知道"（比如刚压缩完、还没等到下一次回复）——
 * 这时候界面该显示"—"而不是 0%，否则用户会以为上下文是空的。
 */
export function readContext(session) {
  try {
    const u = session?.getContextUsage?.();
    if (!u) return null;
    return {
      tokens: u.tokens ?? null,
      contextWindow: u.contextWindow ?? null,
      percent: u.percent ?? null,
      compacting: Boolean(session.isCompacting),
    };
  } catch {
    return null;
  }
}
