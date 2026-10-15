/**
 * 模型菜单（白名单）。
 *
 * 本机 models.json 挂了一百多个模型，但绝大多数是过期/挂掉的，
 * 而且主控自己挑很容易挑到老版本（kimi-k2.5 这种）。
 * 所以这里硬性收口成一份小菜单：kimi = k3、glm = 5.3、deepseek = v4.1 flash，
 * 其他一律不许用。同族多个线路时按探活结果自动挑活的。
 */
import { log } from './util.js';

export const MODEL_MENU = [
  {
    alias: 'kimi-k3',
    label: 'Kimi K3',
    use: '长文档、写作、复杂推理、方案',
    tier: 'strong',
    slugs: ['ctyun/kimi-k3-oc', 'kimi-coding/k3'],
  },
  {
    alias: 'glm-5.3',
    label: 'GLM 5.3',
    use: '通用主力，中文表达好，性价比高',
    tier: 'strong',
    slugs: ['ctyun/glm-5.3-oc', 'glm/glm-5.3-flash'],
  },
  {
    alias: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    use: '便宜快，适合批量/简单活',
    tier: 'fast',
    slugs: ['selfhost/wb-glm-5.3-flash'],
  },
  {
    alias: 'ds-4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    use: '写代码、改文件、跑命令的主力',
    tier: 'code',
    slugs: [
      'cline/cline-pass/deepseek-v4.1-flash',
      'selfhost/wbi-deepseek-v4.1-flash',
      'selfhost/wb-deepseek-v4.1-flash',
    ],
  },
];

/** 菜单里所有合法 slug（去重） */
export function menuSlugs() {
  return [...new Set(MODEL_MENU.flatMap((m) => m.slugs))];
}

export function findMenuEntry(input) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  return (
    MODEL_MENU.find((m) => m.alias.toLowerCase() === key) ??
    MODEL_MENU.find((m) => m.slugs.some((s) => s.toLowerCase() === key)) ??
    null
  );
}

/**
 * 把别名或 slug 解析成实际可用的 slug：同族里优先取探活通过的。
 * @returns {{entry:object, slug:string, alive:boolean}|null}
 */
export function resolveMenu(input, health) {
  const entry = findMenuEntry(input);
  if (!entry) return null;
  const alive = entry.slugs.filter((s) => health?.isKnownGood(s));
  const slug = alive[0] ?? entry.slugs[0];
  return { entry, slug, alive: alive.length > 0 || !health };
}

/** 菜单渲染成给主控看的文本 */
export function menuText(health) {
  const lines = [];
  for (const entry of MODEL_MENU) {
    const resolved = resolveMenu(entry.alias, health);
    const mark = resolved.alive ? '★' : '✗';
    lines.push(
      `${mark} ${entry.alias.padEnd(14)} → ${resolved.slug.padEnd(44)} ${entry.use}`,
    );
  }
  return lines.join('\n');
}

/** 默认模型：优先 deepseek v4.1 flash（写代码），没有就取第一个活的 */
export function defaultMenuSlug(health) {
  const preferred = ['ds-4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'kimi-k3'];
  for (const alias of preferred) {
    const r = resolveMenu(alias, health);
    if (r?.alive) return r.slug;
  }
  for (const entry of MODEL_MENU) {
    const r = resolveMenu(entry.alias, health);
    if (r) return r.slug;
  }
  return null;
}

export function logMenu(health) {
  log('模型菜单（白名单）：');
  for (const line of menuText(health).split('\n')) log('   ' + line);
}
