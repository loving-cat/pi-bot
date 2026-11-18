/**
 * Orbis 品牌常量与统一环境变量读取助手。
 *
 * 将产品品牌名、默认主控标识、仓库归属与 `ORBIS_*`（向后兼容 `PI_BOT_*`）
 * 的环境变量读取收口到单一真源，方便开源分发与后续演进。
 */

export const BRAND_NAME = 'Orbis';
export const BRAND_SLUG = 'orbis';
export const LEGACY_SLUG = 'pi-bot';

export const DEFAULT_MAIN_BOT_NAME = 'Orbis';
export const DEFAULT_MAIN_BOT_EMOJI = '◉';
export const DEFAULT_UPDATE_REPO = 'loving-cat/orbis';

/**
 * 优先读取 `ORBIS_<SUFFIX>`，未设置或为空串时回退 `PI_BOT_<SUFFIX>`。
 * 这样老用户的 `.env` / 桌面端传参零破坏，新文档与 CLI 统一用 `ORBIS_*`。
 */
export function readBrandEnv(env = process.env, suffix) {
  const modern = env?.[`ORBIS_${suffix}`];
  if (modern !== undefined && modern !== '') return modern;
  const legacy = env?.[`PI_BOT_${suffix}`];
  if (legacy !== undefined && legacy !== '') return legacy;
  return undefined;
}
