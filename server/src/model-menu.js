/**
 * 模型菜单：内容来自用户启用的模型组（见 model-groups.js）。
 *
 * 未配置任何模型组时返回空菜单，并提示配置入口。
 */
import { modelGroups } from './model-groups.js';
import { log } from './util.js';

/** 未配置模型组时给出的提示文本 */
export const EMPTY_MENU_HINT = [
  '还没有可用的模型 —— 去 App 的「模型」页加一个模型组：',
  '  1. 填 baseUrl + API key（任何 OpenAI 兼容接口都行）',
  '  2. 点「测试连接」拉出模型列表，勾上你要用的',
  '  3. 回来再让我选模型。',
].join('\n');

/** 当前可选的模型（每项：alias / label / use / slugs / tier） */
export function menuEntries() {
  return modelGroups.menuEntries();
}

/** 菜单里所有合法 slug（去重） */
export function menuSlugs() {
  return [...new Set(menuEntries().flatMap((m) => m.slugs))];
}

/** 完整标识优先；别名和裸后缀必须唯一，歧义不按目录顺序猜测。 */
export function matchMenuEntry(input, entries = menuEntries()) {
  const text = String(input ?? '').trim();
  if (!text) return { entry: null, reason: 'missing', candidates: [] };
  const key = text.toLowerCase();
  const tiers = [
    entries.filter((entry) => entry.slugs.includes(text)),
    entries.filter((entry) => entry.slugs.some((slug) => slug.toLowerCase() === key)),
    entries.filter((entry) => entry.alias.toLowerCase() === key),
    entries.filter((entry) => entry.slugs.some((slug) => slug.toLowerCase().endsWith(`/${key}`))),
  ];
  const matches = tiers.find((items) => items.length) ?? [];
  return { entry: matches.length === 1 ? matches[0] : null,
    reason: matches.length > 1 ? 'ambiguous' : matches.length ? null : 'missing',
    candidates: [...new Set(matches.flatMap((entry) => entry.slugs))] };
}

export function findMenuEntry(input, entries = menuEntries()) {
  return matchMenuEntry(input, entries).entry;
}

/**
 * 解析别名或 slug：同族中优先取探活通过的线路。
 *
 * 判定 alive：
 *   · 存在新鲜结论且可用 → true；
 *   · 存在新鲜结论但均不可用 → false；
 *   · 无新鲜结论（过期或从未探活）→ 标为未验证，允许选择。
 * @returns {{entry:object, slug:string, alive:boolean, status:string}|null}
 */
export function resolveMenu(input, health, entries) {
  const entry = findMenuEntry(input, entries);
  if (!entry) return null;
  const text = String(input).trim();
  const preferred = entry.slugs.find((slug) => slug === text)
    ?? entry.slugs.find((slug) => slug.toLowerCase() === text.toLowerCase());
  return resolveEntry(entry, health, preferred);
}

function resolveEntry(entry, health, preferred = null) {
  const slugs = preferred ? [preferred] : entry.slugs;
  const record = typeof health?.peek === 'function' ? (slug) => health.peek(slug) : null;
  const verified = slugs.filter((slug) => record ? record(slug)?.ok === true : health?.isKnownGood?.(slug));
  const unknown = slugs.filter((slug) => !verified.includes(slug) &&
    (record ? record(slug) == null : health?.isKnownDead?.(slug) !== true && health?.hasFreshFor?.([slug]) !== true));
  const staleGood = unknown.filter((slug) => health?.wasGood?.(slug));
  const slug = verified[0] ?? staleGood[0] ?? unknown[0] ?? slugs[0];
  const status = verified.length ? 'verified' : unknown.length ? 'unverified' : 'unavailable';
  return { entry, slug, alive: status !== 'unavailable', status };
}

/**
 * 把一份菜单渲染成给主控看的文本。**纯函数** —— 菜单内容全在参数里，
 * 所以"没配模型组时该说什么"这件事能被单测钉住，不用真去建组。
 */
export function renderMenu(entries, health) {
  if (!entries.length) return EMPTY_MENU_HINT;
  return entries
    .map((entry) => {
      const r = resolveEntry(entry, health);
      const mark = r?.status === 'verified' ? '★' : r?.status === 'unverified' ? '?' : '✗';
      const status = r?.status === 'verified' ? '实测可用' : r?.status === 'unverified' ? '未验证，可选择' : '实测不可用';
      const capacity = Number.isFinite(entry.contextWindow) ? `；上下文 ${entry.contextWindow}` : '';
      return `${mark} ${entry.alias.padEnd(14)} → ${(r?.slug ?? '?').padEnd(44)} ${entry.use}（${status}${capacity}）`;
    })
    .join('\n');
}

/** 菜单渲染成给主控看的文本 */
export function menuText(health) {
  return renderMenu(menuEntries(), health);
}

/** 默认模型：菜单里第一个探活可用的；都没有就退回菜单第一个 */
export function defaultMenuSlug(health) {
  const entries = menuEntries();
  for (const entry of entries) {
    const r = resolveEntry(entry, health);
    if (r?.status === 'verified') return r.slug;
  }
  for (const entry of entries) {
    const r = resolveEntry(entry, health);
    if (r?.alive) return r.slug;
  }
  const first = entries[0];
  return first ? (resolveEntry(first, health)?.slug ?? null) : null;
}

export function logMenu(health) {
  log('模型菜单（来自你自己配的模型组）：');
  for (const line of menuText(health).split('\n')) log('   ' + line);
}
