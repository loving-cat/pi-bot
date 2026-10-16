/**
 * 模型菜单 —— **完全来自用户自己配的模型组**。
 *
 * 以前这里写着一份内置白名单（"kimi=k3、glm=5.3、deepseek=v4.1 flash"）。
 * 那是**本机的东西**，不该进仓库，也不该是别人的默认：
 *   · 别人 clone 下来根本没有那些线路，菜单全是 ✗
 *   · "我该用哪些模型"本来就该用户自己说了算 ——
 *     App 里配的模型组就是答案（用户原话："每个人用自己配置的，
 *     不然我们要模型组干什么，就是让用户自己配置自己的集合"）。
 *
 * 所以现在：菜单 = 所有**启用的模型组**里的模型（见 model-groups.js）。
 * 一个组都没配 = 空菜单，这里会明确告诉用户去哪儿配。
 */
import { modelGroups } from './model-groups.js';
import { log } from './util.js';

/** 一个模型组都没配时给 bot（也就是给用户）的提示 */
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
 * 把别名或 slug 解析成实际可用的 slug：同族里优先取探活通过的。
 * @returns {{entry:object, slug:string, alive:boolean}|null}
 */
export function resolveMenu(input, health, entries) {
  const entry = findMenuEntry(input, entries);
  if (!entry) return null;
  const alive = entry.slugs.filter((s) => health?.isKnownGood(s));
  const slug = alive[0] ?? entry.slugs[0];
  return { entry, slug, alive: alive.length > 0 || !health };
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
