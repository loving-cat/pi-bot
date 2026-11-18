/**
 * 记忆摘要与主动上下文压缩子模块。
 *
 * 收敛：
 *   1. 递归对话记忆自动/手动总结（`maybeAutoSummarize` / `summarizeMemory`）；
 *   2. 主动压缩水位判定（`planCompaction`）、真实 token 保留校准（`calibrateKeepRecent`）；
 *   3. 后台配额排队、退避重试与冷却机制（`compactIfNeeded`）。
 */
import { log } from '../util.js';
import { providerLeaseScope } from '../provider-updates.js';
import { modelFailure } from '../model-reply.js';
import { isRecoverableFailure, transientBackoffMs } from '../retry-policy.js';
import {
  capRecentTokens,
  estimateTokenRatio,
  fixedOverheadOf,
} from '../context-budget.js';
import { buildMemoryDigest, buildSummarizePrompt, memoryProgress } from '../memory-digest.js';
import { sanitizeMemoryText } from '../memory-sanitize.js';
import { shouldAutoSummarize } from '../memory-policy.js';
import {
  COMPACT_COOLDOWN_MS,
  COMPACT_MAX_ATTEMPTS,
  sleep,
  textOf,
} from './runner-utils.js';

export const MEMORY_WINDOW = 400;
export const TARGET_RECENT_TOKENS = 200_000;
export const TARGET_RECENT_TOKENS_LIGHT = 80_000;
export const COMPACT_PROMPT = null;

/**
 * 主动压缩前的判定（纯函数）：该不该压、是否在冷却中。
 */
export function planCompaction({
  percent = null,
  threshold = 80,
  now = Date.now(),
  retryAfter = 0,
  compacting = false,
  autoCompact = true,
} = {}) {
  if (!autoCompact) return { compact: false, why: '自动压缩已关闭' };
  if (compacting) return { compact: false, why: '已在压缩中' };
  if (typeof percent !== 'number') return { compact: false, why: '拿不到上下文占用' };
  if (percent < threshold) return { compact: false, why: `未到阈值 ${threshold}%` };
  if (retryAfter > now) {
    const left = Math.ceil((retryAfter - now) / 1000);
    return { compact: false, why: `上次压缩失败，冷却中（还剩 ${left}s）` };
  }
  return { compact: true, why: `${percent.toFixed(0)}% ≥ ${threshold}%` };
}

/** 按实测偏差校准 keepRecentTokens，让保留原文按真实 token 估算并扣减固定开销。 */
export function calibrateKeepRecent(runner, session, bot) {
  try {
    const sm = session?.settingsManager;
    if (!sm || typeof sm.applyOverrides !== 'function') return;
    if (bot?.keepRecentTokens != null) return;

    const ratio = estimateTokenRatio(session);
    if (ratio == null) return;

    const target = runner?.constructor?.TARGET_RECENT_TOKENS ?? TARGET_RECENT_TOKENS;
    const rawKeep = Math.max(1, Math.round(target / ratio));

    const cw = Number(session?.model?.contextWindow ?? 0);
    let keep = rawKeep;
    let maxReal = target;
    if (cw > 0) {
      const existing = (() => {
        try { return sm.getCompactionSettings?.(session.model) ?? {}; } catch { return {}; }
      })();
      const maxEstInWindow = capRecentTokens({
        contextWindow: cw,
        keepRecentTokens: Number.MAX_SAFE_INTEGER,
        reserveTokens: existing.reserveTokens ?? runner.config.reserveTokens ?? 16384,
        threshold: runner.config.compactAtPercent ?? 0.6,
        fixedOverheadTokens: fixedOverheadOf(session),
      });
      const triggerReal = Math.min(cw, Math.floor(cw * (runner.config.compactAtPercent ?? 0.6)));
      maxReal = Math.min(target, Math.round(maxEstInWindow * ratio), triggerReal);
      keep = Math.min(rawKeep, Math.max(1, Math.round(maxReal / ratio)));
    }
    const compaction = { keepRecentTokens: keep };
    const model = session?.model;
    if (model?.provider && model?.id) {
      compaction.modelOverrides = {
        [`${model.provider}/${model.id}`]: { keepRecentTokens: keep },
      };
    }
    sm.applyOverrides({ compaction });
    log(
      `【${bot?.name ?? 'bot'}】上下文校准：r=${ratio.toFixed(2)} → ` +
        `保留 ${keep} 估算 token（目标 ${target} 真实 token）` +
        (keep < rawKeep
          ? `，已按窗口上限从 ${rawKeep} 夹到 ${keep}`
          : ''),
    );
  } catch (err) {
    log('上下文校准失败（忽略，保持原行为）：', err?.message || err);
  }
}

/** 按策略判断要不要自动总结一次记忆（异步后台执行，不阻塞主链路） */
export function maybeAutoSummarize(runner, roomId, botId) {
  if (runner.memoryAutoDisabled) return;
  try {
    const windowLimit = runner?.constructor?.MEMORY_WINDOW ?? MEMORY_WINDOW;
    const all = runner.store.listMessages(roomId, { limit: windowLimit });
    const summary = runner.store.memorySummaryFor(roomId, botId);
    const { conversation, newMessages, totalTurns } = memoryProgress(all, summary);
    if (!conversation.length || !newMessages.length) return;
    const verdict = shouldAutoSummarize({
      summary,
      totalTurns,
      newMessages,
      now: Date.now(),
    });
    if (!verdict.due) return;
    log(
      `🧾 自动记忆总结（${verdict.reason}）：轮数 ${totalTurns}，` +
        `新增 ${newMessages.length} 条，重要度 ${verdict.score}`,
    );
    summarizeMemory(runner, roomId, botId).catch((err) =>
      log(`自动记忆总结失败：${err?.message ?? err}`),
    );
  } catch (err) {
    log(`自动记忆总结判断失败：${err?.message ?? err}`);
  }
}

/** 记忆摘要入口（单飞复用 + 强制重算走后台槽位与模型配置租约） */
export async function summarizeMemory(runner, roomId, botId, { force = false } = {}) {
  const jobKey = `${roomId}:${botId}`;
  if (!runner.memoryJobs) runner.memoryJobs = new Map();
  if (!force && runner.memoryJobs.has(jobKey)) return runner.memoryJobs.get(jobKey);
  runner.flushProviderUpdates();
  const job = runner.withBackgroundSlot(`记忆摘要 · ${roomId}`, () => {
    runner.flushProviderUpdates();
    return runner.providerUpdates.withLease((lease) =>
      summarizeMemoryNow(runner, roomId, botId, { force, lease }),
    );
  });
  runner.memoryJobs.set(jobKey, job);
  try {
    return await job;
  } finally {
    if (runner.memoryJobs.get(jobKey) === job) runner.memoryJobs.delete(jobKey);
  }
}

async function summarizeMemoryNow(runner, roomId, botId, { force = false, lease = null } = {}) {
  const room = runner.store.getRoom(roomId);
  if (!room) return { error: '会话不存在' };
  const bot = runner.store.getBot(botId);
  if (!bot) return { error: 'bot 不存在' };

  const windowLimit = runner?.constructor?.MEMORY_WINDOW ?? MEMORY_WINDOW;
  const all = runner.store.listMessages(roomId, { limit: windowLimit });
  const cached = runner.store.memorySummaryFor(roomId, botId);
  const { conversation, newMessages, lastId, totalTurns } = memoryProgress(all, cached);
  if (!conversation.length) return { text: '', at: null, count: 0, stale: false, lastId };
  if (!force && cached && cached.lastId === lastId) return cached;

  const cachedText = String(cached?.text ?? '').trim();
  const recursive = runner.config.memoryRecursive !== false && Boolean(cachedText);
  const digestMessages = recursive && newMessages.length ? newMessages : all;
  const digest = buildMemoryDigest(digestMessages);

  const prompt = buildSummarizePrompt({
    botName: bot.name,
    previousText: recursive ? cachedText : '',
    digest,
  });

  const model = (bot.model ? runner.resolveModel(bot.model) : null) ?? runner.model;
  lease?.restrictTo(providerLeaseScope(model));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('记忆摘要超时（90 秒）')),
    90_000,
  );
  try {
    const reply = await runner.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: '你是一个记忆整理器，只输出整理后的记忆摘要。',
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      },
      { maxTokens: 1200, signal: controller.signal },
    );
    const raw = textOf(reply).trim();
    if (!raw) {
      return { ...(cached ?? {}), error: '模型没有返回内容', stale: true };
    }
    let text;
    try {
      text = sanitizeMemoryText(raw);
    } catch (err) {
      return {
        ...(cached ?? {}),
        error: `脱敏失败：${err?.message || err}`,
        stale: true,
      };
    }
    return runner.store.setMemorySummary(roomId, botId, {
      text,
      lastId,
      count: totalTurns,
      turns: totalTurns,
      at: Date.now(),
    });
  } catch (err) {
    return { ...(cached ?? {}), error: String(err?.message || err), stale: true };
  } finally {
    clearTimeout(timer);
  }
}

/** 主动压缩：上下文到达阈值即收成摘要（成功后清理已注入技能缓存标记） */
export async function compactIfNeeded(runner, entry, bot, roomId = null, { signal = null, deadline = 0 } = {}) {
  const session = entry?.session;
  if (!session) return { compacted: false, failed: false, attempts: 0, why: '没有会话' };

  const usage = session.getContextUsage?.();
  const threshold = Math.min(0.95, Math.max(0.2, runner.config.compactAtPercent || 0.6)) * 100;
  const planner = runner?.constructor?.planCompaction ?? planCompaction;
  const plan = planner({
    percent: typeof usage?.percent === 'number' ? usage.percent : null,
    threshold,
    retryAfter: entry.compactRetryAfter ?? 0,
    compacting: Boolean(session.isCompacting),
    autoCompact: runner.config.autoCompact,
  });
  if (!plan.compact) {
    if (entry.compactRetryAfter > Date.now()) {
      log(`【${bot.name}】跳过主动压缩：${plan.why}`);
    }
    return { compacted: false, failed: false, attempts: 0, why: plan.why };
  }

  const remaining = deadline ? Math.max(1, deadline - Date.now()) : 0;
  const configuredWait = runner.config.backgroundSlotWaitMs;
  const waitMs = remaining && configuredWait > 0 ? Math.min(remaining, configuredWait) : remaining || configuredWait;
  const bgTicket = await runner.acquireBackgroundSlot({
    name: `压缩 · ${bot.name}`, signal, timeoutMs: waitMs,
  });
  if (signal?.aborted) {
    bgTicket?.release?.();
    throw signal.reason ?? Object.assign(new Error('已终止'), { name: 'AbortError' });
  }
  if (deadline && Date.now() >= deadline) {
    bgTicket?.release?.();
    throw new Error('等待上下文整理超时');
  }
  if (bgTicket && !bgTicket.ok) {
    log(`【${bot.name}】压缩没拿到后台槽位（${bgTicket.reason}），本轮先不压`);
    return { compacted: false, failed: false, attempts: 0, why: '后台槽位不可用' };
  }

  calibrateKeepRecent(runner, session, bot);

  entry.compactingOnly = true;
  const beat = setInterval(() => {
    entry.progressAt = Date.now();
  }, 15_000);

  const compactPrompt = runner?.constructor?.COMPACT_PROMPT !== undefined
    ? runner.constructor.COMPACT_PROMPT
    : COMPACT_PROMPT;

  let attempts = 0;
  let lastError = null;
  try {
    for (let i = 0; i < COMPACT_MAX_ATTEMPTS; i++) {
      if (signal?.aborted || roomId && runner.aborting.has(roomId)) {
        return { compacted: false, failed: false, attempts, why: '用户已终止' };
      }
      attempts = i + 1;
      entry.startedAt = entry.startedAt ?? Date.now();
      entry.progressAt = Date.now();
      let compactTimer;
      try {
        const limitMs = deadline ? Math.max(1, Math.min(5 * 60 * 1000, deadline - Date.now())) : 5 * 60 * 1000;
        const compactStartedAt = Date.now();
        const compactResult = await Promise.race([
          session.compact(compactPrompt),
          new Promise((_, reject) => {
            compactTimer = setTimeout(() => reject(new Error('上下文压缩超时')), limitMs);
          }),
        ]);
        try {
          if (compactResult?.usage) {
            runner.recordRun({
              roomId,
              botId: bot.id,
              startedAt: compactStartedAt,
              ok: true,
              usage: compactResult.usage,
              kind: 'compact',
            });
          }
        } catch (err) {
          log('记录压缩开销失败：', err?.message || err);
        }
        entry.compactRetryAfter = 0;
        entry.progressAt = Date.now();
        // ★ 主动压缩不走 compaction_end 事件，必须在这里清技能注入标记。
        entry.compactedSinceInjection = true;
        entry.skillsInjected = null;
        return { compacted: true, failed: false, attempts, why: plan.why };
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || err);
        if (/压缩超时/.test(msg)) break;
        if (!isRecoverableFailure({ error: msg })) break;
        if (i === COMPACT_MAX_ATTEMPTS - 1) break;
        const wait = transientBackoffMs(attempts);
        const sec = Math.round(wait / 1000);
        log(`【${bot.name}】主动压缩失败（第 ${attempts}/${COMPACT_MAX_ATTEMPTS} 次），${sec}s 后重试：${msg}`);
        await sleep(Math.min(wait, deadline ? Math.max(0, deadline - Date.now()) : wait));
      } finally {
        clearTimeout(compactTimer);
      }
    }
  } finally {
    clearInterval(beat);
    entry.compactingOnly = false;
    try {
      await session.abort?.();
    } catch {} finally {
      bgTicket?.release?.();
    }
  }

  entry.compactRetryAfter = Date.now() + COMPACT_COOLDOWN_MS;
  const msg = String(lastError?.message || lastError || '未知原因');
  log(
    `【${bot.name}】主动压缩放弃（试了 ${attempts} 次），` +
      `${Math.round(COMPACT_COOLDOWN_MS / 1000)}s 内不再重试；本轮继续跑：${msg}`,
  );
  if (roomId) runner.bus.emit('event', {
    t: 'bot.compactFailed',
    roomId,
    botId: bot.id,
    attempts,
    error: modelFailure(msg).error,
  });
  return { compacted: false, failed: true, attempts, why: msg };
}
