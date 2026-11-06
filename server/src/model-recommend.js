/**
 * 用决策模型给"这个活该配哪个模型"出主意。
 *
 * ## 它在整条链路里的位置
 *
 * 主控（LLM）本来就有 list_models + create_bot/update_bot，自己会挑模型。
 * 但那是**一次完整推理**：读目录、比对容量、权衡职责 —— 慢，而且
 * 主控有时会挑得随意（比如全给同一个）。
 *
 * 决策模型擅长这件小事：给它"这个成员要干什么"，它回"哪一档"。
 * 一次几百 token、不到一秒。
 *
 * ## 两条线的边界
 *
 *   Jev 开着  → 主控可以先问 Jev 拿建议，再决定（可以不听）
 *   Jev 关着  → 走原来的 list_models，一个字都不变
 *
 * 注意：**Jev 只出建议，不直接改数据**。真正写库的还是 update_bot，
 * 主控仍然有最终决定权。这样即使 Jev 判错，主控能纠回来。
 */

import { decide } from './decision-router.js';
import { menuEntries } from './model-menu.js';

/**
 * 各类活对模型能力的要求。
 *
 * qualityFirst：这类活质量比速度重要 —— 就算用户等着，也不该为了快降级。
 *   写代码、重推理、查资料，图快想错一步要返工，反而更慢。
 */
export const CAPABILITY_HINT = Object.freeze({
  reasoning: { needsLongContext: true, qualityFirst: true, label: '重推理' },
  coding: { needsLongContext: true, qualityFirst: true, label: '写代码' },
  research: { needsLongContext: true, qualityFirst: true, label: '查资料' },
  writing: { needsLongContext: false, qualityFirst: false, label: '写文案' },
  routine: { needsLongContext: false, qualityFirst: false, label: '简单活' },
});

/**
 * 从候选模型里挑一个。
 *
 * 排序依据（越靠前越优先）：
 *   1. 上下文窗口够不够（需要长上下文时，窗口小的排后面）
 *   2. 快不快（对速度敏感的活，快模型优先）
 *   3. 目录顺序（用户配的顺序本身是一种偏好）
 *
 * 为什么要排序而不是直接取第一个：模型组是用户手动配的，
 * 顺序未必反映"哪个适合这个活"。这里用 Jev 给出的性质做一次筛选。
 *
 * @returns {{pick: string|null, alternatives: string[], why: string}}
 */
export function rankCandidates(kind, { entries = [], needsLongContext = false, needsSpeed = false } = {}) {
  if (!entries.length) return { pick: null, alternatives: [], why: '没有可用的模型' };
  const hint = CAPABILITY_HINT[kind] ?? null;
  const longCtx = needsLongContext || hint?.needsLongContext === true;
  const qualityFirst = hint?.qualityFirst === true;
  // ★ 质量优先的活忽略"要快"。
  //
  //   第一版把 needsSpeed 直接当加分项，结果三类任务全挑中带 flash 的那个 ——
  //   因为"用户会等着看结果"对几乎所有活都成立，这个信号没有区分度。
  //   速度只能在不伤质量时当加分项，不能当主判据。
  const wantFast = !qualityFirst && needsSpeed;

  const scored = entries.map((entry, index) => {
    let score = 0;
    const name = String(entry.alias ?? '').toLowerCase();
    const looksFast = /flash|fast|mini|small|lite|turbo/.test(name);
    const looksHeavy = /pro|max|opus|large|thinking|reason/.test(name);

    // 质量优先：轻量模型扣分、重型模型加分
    if (qualityFirst) {
      if (looksFast) score -= 1.5;
      if (looksHeavy) score += 1.0;
    }

    // 窗口：有容量数据才算，没数据的当"未知"不奖不罚
    const window = Number(entry.contextWindow ?? 0);
    if (longCtx && window > 0) score += Math.min(3, Math.log10(window / 100_000 + 1) * 2);
    if (longCtx && looksHeavy) score += 0.5;

    // 速度：只在允许图快的时候加分
    if (wantFast && looksFast) score += 1.5;
    if (wantFast && looksHeavy) score -= 0.5;

    // 目录顺序作微调，避免同分时结果随实现变化
    score -= index * 0.01;
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const pick = scored[0]?.entry?.slugs?.[0] ?? scored[0]?.entry?.alias ?? null;
  const alternatives = scored.slice(1).map((s) => s.entry.slugs?.[0] ?? s.entry.alias).filter(Boolean);
  const parts = [];
  if (hint) parts.push(`活的性质：${hint.label}`);
  if (longCtx) parts.push('需要长上下文');
  if (qualityFirst) parts.push('质量优先于速度');
  else if (wantFast) parts.push('对速度敏感');
  return { pick, alternatives, why: parts.join('、') || '按目录顺序' };
}

/**
 * 给一个任务/成员出模型建议。
 *
 * @returns {Promise<{ok:boolean, source:'jev'|'fallback', pick?:string,
 *                    alternatives?:string[], kind?:string, why:string,
 *                    failure?:string, error?:string}>}
 */
export async function recommendModel({ task = '', botName = '', botRole = '' } = {}, settings = {}, { fetchImpl } = {}) {
  const entries = menuEntries();
  if (!entries.length) {
    return { ok: false, source: 'fallback', why: '没有已启用的模型组' };
  }

  // 没开 Jev：只按目录顺序给第一个，跟原来"让主控自己看目录"的起点一致
  const decision = await decide(
    'assign-model',
    { task, botName, botRole },
    settings,
    { fetchImpl },
  );
  if (!decision.ok) {
    const fallback = rankCandidates('routine', { entries });
    return {
      ok: false,
      source: 'fallback',
      pick: fallback.pick,
      alternatives: fallback.alternatives,
      why: decision.why,
      failure: decision.failure,
      error: decision.error,
    };
  }
  const kind = decision.values?.kind ?? 'routine';
  const ranked = rankCandidates(kind, {
    entries,
    needsLongContext: decision.values?.needsLongContext === true,
    needsSpeed: decision.values?.needsSpeed === true,
  });
  return {
    ok: true,
    source: 'jev',
    pick: ranked.pick,
    alternatives: ranked.alternatives,
    kind,
    why: ranked.why,
    model: decision.model,
    ms: decision.ms,
  };
}
