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

export function findMenuEntry(input, entries = menuEntries()) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  return (
    entries.find((m) => m.alias.toLowerCase() === key) ??
    entries.find((m) => m.slugs.some((s) => s.toLowerCase() === key)) ??
    // 也允许直接用 `<组id>/<模型id>` 或唯一后缀指定
    entries.find((m) =>
      m.slugs.some((s) => s.toLowerCase().endsWith(`/${key}`)),
    ) ??
    null
  );
}

/**
 * 解析别名或 slug：同族中优先取探活通过的线路。
 *
 * 判定 alive：
 *   · 存在新鲜结论且可用 → true；
 *   · 存在新鲜结论但均不可用 → false；
 *   · 无新鲜结论（过期或从未探活）→ 有历史可用结论时视为可用，等待后台重探。
 * @returns {{entry:object, slug:string, alive:boolean}|null}
 */
export function resolveMenu(input, health, entries) {
  const entry = findMenuEntry(input, entries);
  if (!entry) return null;
  const alive = entry.slugs.filter((s) => health?.isKnownGood(s));
  // 这一族现在有没有新鲜结论？有新鲜结论且都不是好的 → 真的不能用（照旧判死）
  const fresh = health?.hasFreshFor?.(entry.slugs);
  const staleGood = entry.slugs.filter((s) => health?.wasGood?.(s));
  // 没有新鲜结论：有历史可用结论（或全库都没结论）就先乐观放行，后台重探完会给真结论
  const optimistic =
      !alive.length &&
      fresh !== true &&
      (staleGood.length > 0 || health?.hasFresh?.() === false);
  const slug = alive[0] ?? staleGood[0] ?? entry.slugs[0];
  return { entry, slug, alive: alive.length > 0 || !health || optimistic };
}

/**
 * 把一份菜单渲染成给主控看的文本。**纯函数** —— 菜单内容全在参数里，
 * 所以"没配模型组时该说什么"这件事能被单测钉住，不用真去建组。
 */
export function renderMenu(entries, health) {
  if (!entries.length) return EMPTY_MENU_HINT;
  return entries
    .map((entry) => {
      const r = resolveMenu(entry.alias, health, entries);
      const mark = r?.alive ? '★' : '✗';
      return `${mark} ${entry.alias.padEnd(14)} → ${(r?.slug ?? '?').padEnd(44)} ${entry.use}`;
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
    const r = resolveMenu(entry.alias, health, entries);
    if (r?.alive) return r.slug;
  }
  const first = entries[0];
  return first ? (resolveMenu(first.alias, health, entries)?.slug ?? null) : null;
}

export function logMenu(health) {
  log('模型菜单（来自你自己配的模型组）：');
  for (const line of menuText(health).split('\n')) log('   ' + line);
}
