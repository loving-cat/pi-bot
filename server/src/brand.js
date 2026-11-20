/**
 * Orbis 品牌常量与统一环境变量读取助手。
 *
 * 将产品品牌名、默认主控标识、仓库归属与 `ORBIS_*`（向后兼容 `PI_BOT_*`）
 * 的环境变量读取收口到单一真源，方便开源分发与后续演进。
 */

export const BRAND_NAME = 'Orbis';
export const BRAND_SLUG = 'orbis';
export const LEGACY_SLUG = 'pi-bot';

/** 环境变量前缀：新名 / 旧名（旧名 2.0 移除） */
export const BRAND_ENV_PREFIX = 'ORBIS';
export const LEGACY_ENV_PREFIX = 'PI_BOT';

export const DEFAULT_MAIN_BOT_NAME = 'Orbis';
export const DEFAULT_MAIN_BOT_EMOJI = '◉';
export const DEFAULT_UPDATE_REPO = 'loving-cat/orbis';

/**
 * 弃用提醒的单一通道（1.7.1 过渡版用）。
 *
 * ## 为什么不能直接 console.warn
 *
 * `readBrandEnv` 在请求与执行热路径上被反复调用（每个请求、每轮任务都可能走一遍），
 * 直接打日志会刷爆用户日志与 CI 输出。所以这里有两层：
 *   1. **进程内按 `kind:from` 去重** —— 同一个旧变量/旧头整个进程只提醒一次；
 *   2. **可订阅、可重置** —— 单测能断言“提醒了、且只提醒一次”，不用去抓 stderr。
 *
 * 2.0 删兼容层时，这个文件里与 `legacy` 相关的分支一并删。
 */
const deprecations = new Set();
const listeners = new Set();

/** 订阅弃用事件（返回取消函数）。测试用；诊断工具也可用。 */
export function onBrandDeprecation(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 已记录的弃用项（`kind:from`），按发现顺序。 */
export function brandDeprecations() {
  return [...deprecations];
}

/** 清空“已提醒”与订阅者（测试用；正常进程生命周期内不需要调）。 */
export function resetBrandDeprecations() {
  deprecations.clear();
  listeners.clear();
}

/**
 * 记一条弃用提醒（同一 `kind:from` 整个进程只生效一次）。
 *
 * @param {{ kind: string, from: string, to: string, hint?: string }} info
 * @returns {boolean} 本次是否真的记录了（重复返回 false）
 */
export function noticeBrandDeprecation({ kind, from, to, hint = '' }) {
  const key = `${kind}:${from}`;
  if (deprecations.has(key)) return false;
  deprecations.add(key);
  for (const fn of listeners) {
    try {
      fn({ kind, from, to, hint });
    } catch { /* 订阅者自己的错误不影响调用方 */ }
  }
  console.warn(`[Orbis] 弃用提醒：${from} 将在 2.0 移除，请改用 ${to}${hint ? `（${hint}）` : ''}`);
  return true;
}

/**
 * 优先读取 `ORBIS_<SUFFIX>`，未设置或为空串时回退 `PI_BOT_<SUFFIX>`。
 * 这样老用户的 `.env` / 桌面端传参零破坏，新文档与 CLI 统一用 `ORBIS_*`。
 *
 * 回退命中时经 `noticeBrandDeprecation` 提醒一次（去重，热路径安全）。
 */
export function readBrandEnv(env = process.env, suffix) {
  const modern = env?.[`${BRAND_ENV_PREFIX}_${suffix}`];
  if (modern !== undefined && modern !== '') return modern;
  // @remove-2.0 2.0 起只认 ORBIS_*；现在兼容是为了不打断老配置
  const legacy = env?.[`${LEGACY_ENV_PREFIX}_${suffix}`];
  if (legacy !== undefined && legacy !== '') {
    noticeBrandDeprecation({
      kind: 'env',
      from: `${LEGACY_ENV_PREFIX}_${suffix}`,
      to: `${BRAND_ENV_PREFIX}_${suffix}`,
    });
    return legacy;
  }
  return undefined;
}
