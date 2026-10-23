/**
 * 检查有没有新版本（唯一会发网络请求的一层）。
 *
 * 设计取舍：
 *   · 默认查 GitHub Releases（本项目的发布地），地址可用环境变量覆盖成自建镜像；
 *   · 结果缓存 30 分钟 —— 前端可以在启动、切页面时随便问，不会每次都打网络；
 *   · 任何失败都返回 `{ok:false, reason}` 而不是抛错：检查更新失败不该影响主功能；
 *   · 只读不写，不下载、不安装（下载由 App 侧按用户确认后自己去做）。
 *
 * 环境变量：
 *   PI_BOT_UPDATE_URL   完整 URL（默认 GitHub API 的 latest release）
 *   PI_BOT_UPDATE_REPO  仓库 `owner/name`（拼默认 API 地址用）
 */
import { VERSION } from './version.js';
import { buildUpdateInfo, pickAssetFor } from './update-check.js';
import { publicFetch } from './net-guard.js';

/** 结果缓存多久（毫秒）。检查更新不需要实时，30 分钟足够 */
const CACHE_MS = 30 * 60 * 1000;

/** 单次请求超时（毫秒） */
const TIMEOUT_MS = 8000;

const DEFAULT_REPO = 'loving-cat/pi-bot';

/** @type {{at:number, info:object, source:string}|null} */
let cache = null;

/**
 * 当前生效的检查地址。
 * @returns {{url:string, source:string}}
 */
export function updateEndpoint(env = process.env) {
  const custom = String(env.PI_BOT_UPDATE_URL ?? '').trim();
  if (custom) return { url: custom, source: 'env' };
  const repo = String(env.PI_BOT_UPDATE_REPO ?? '').trim() || DEFAULT_REPO;
  return {
    url: `https://api.github.com/repos/${repo}/releases/latest`,
    source: `github:${repo}`,
  };
}

/**
 * 把 GitHub release 响应转成统一结构。
 * @param {any} json
 * @returns {{latest:string, notes:string, pageUrl:string, publishedAt:string, assets:Array}}
 */
export function fromGithubRelease(json) {
  const tag = String(json?.tag_name ?? json?.name ?? '').trim();
  return {
    latest: tag,
    notes: String(json?.body ?? ''),
    pageUrl: String(json?.html_url ?? ''),
    publishedAt: String(json?.published_at ?? ''),
    assets: (Array.isArray(json?.assets) ? json.assets : []).map((a) => ({
      name: String(a?.name ?? ''),
      url: String(a?.browser_download_url ?? ''),
      size: Number(a?.size ?? 0),
    })),
  };
}

/**
 * 查询最新版本。
 *
 * @param {object} [opts]
 * @param {string} [opts.platform] 目标平台（决定推荐哪个下载包）
 * @param {boolean} [opts.force]   跳过缓存
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试用）
 * @param {object} [opts.env]
 * @param {number} [opts.now]
 * @returns {Promise<{ok:boolean, reason:string, update:boolean, current:string,
 *   latest:string, notes:string, pageUrl:string, publishedAt:string,
 *   assets:Array, recommended:object|null, source:string, cached:boolean}>}
 */
export async function checkForUpdate({
  platform = process.platform,
  force = false,
  fetchImpl = undefined,
  env = process.env,
  now = Date.now(),
} = {}) {
  const { url, source } = updateEndpoint(env);

  if (!force && cache && now - cache.at < CACHE_MS) {
    return { ...cache.info, recommended: pickAssetFor(cache.info.assets, platform), cached: true };
  }

  // null 表示调用方明确没有 fetch；undefined 走 publicFetch 的默认传输（含 SSRF 校验）
  if (fetchImpl === null || (fetchImpl !== undefined && typeof fetchImpl !== 'function')) {
    return {
      ok: false,
      reason: '当前运行环境没有 fetch，无法检查更新',
      update: false,
      current: VERSION,
      latest: '',
      notes: '',
      pageUrl: '',
      publishedAt: '',
      assets: [],
      recommended: null,
      source,
      cached: false,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let payload;
  try {
    const { res } = await publicFetch(
      url,
      {
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `pi-bot/${VERSION}`,
        },
      },
      { fetchImpl: typeof fetchImpl === 'function' ? fetchImpl : undefined, scope: 'user-config' },
    );
    if (!res.ok) {
      return {
        ok: false,
        reason: `检查更新失败：HTTP ${res.status}`,
        update: false,
        current: VERSION,
        latest: '',
        notes: '',
        pageUrl: '',
        publishedAt: '',
        assets: [],
        recommended: null,
        source,
        cached: false,
      };
    }
    payload = await res.json();
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? `检查更新超时（${TIMEOUT_MS / 1000} 秒）` : `检查更新失败：${err?.message ?? err}`,
      update: false,
      current: VERSION,
      latest: '',
      notes: '',
      pageUrl: '',
      publishedAt: '',
      assets: [],
      recommended: null,
      source,
      cached: false,
    };
  } finally {
    clearTimeout(timer);
  }

  const info = {
    ok: true,
    ...buildUpdateInfo({ current: VERSION, ...fromGithubRelease(payload) }),
    source,
    cached: false,
  };

  // 只在"查成功"时缓存：失败要能立刻重试
  cache = { at: now, info, source };
  return { ...info, recommended: pickAssetFor(info.assets, platform) };
}

/** 清掉缓存（改配置或用户点了"重新检查"时用） */
export function clearUpdateCache() {
  cache = null;
}
