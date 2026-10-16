/**
 * 上下文预算：模型容量覆盖 + 压缩参数 + 占用读数。
 *
 * 从 pi-runner.js 搬出来的（那边原本 2000 行，什么都在里面）。
 * 这一块的特点是**只跟 pi 的会话对象打交道**，不碰房间、不碰调度：
 *   · withCapacity        把 bot 上设的 contextWindow / maxTokens 盖到模型上
 *   · applyCompactionBudget  把"什么时候压缩、压缩时保留多少"套到会话上
 *   · readContext         读回占用（给界面显示用了多少）
 *
 * 四个数（contextWindow / maxTokens / reserveTokens / keepRecentTokens）
 * 都能被用户或主控单独覆盖，所以每一层都是"设了才覆盖，没设交给下一层"。
 */
import { config } from './config.js';
import { log } from './util.js';

/** 正数才要，其他一律 null（和 store 里那个同名助手一个意思） */
export function positiveOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
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
export function applyCompactionBudget(session, bot = {}) {
  const sm = session?.settingsManager;
  if (!sm || typeof sm.applyOverrides !== 'function') return null;

  const reserve = positiveOrNull(bot.reserveTokens) ?? config.reserveTokens ?? null;
  const keep = positiveOrNull(bot.keepRecentTokens) ?? config.keepRecentTokens ?? null;
  const overrides = {};
  if (reserve != null) overrides.reserveTokens = reserve;
  if (keep != null) overrides.keepRecentTokens = keep;
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
