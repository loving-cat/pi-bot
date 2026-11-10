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
 * 从 releases.atom 里解出最新版本。
 *
 * ★ 为什么要有这条路：GitHub 的 **API**（api.github.com/repos/.../releases/latest）
 *   对未认证请求只有 **60 次/小时**，超了直接 403。用户反馈「检查更新经常报错」
 *   就是这个 —— 报错信息长这样：
 *     "检查更新失败：HTTP 403"
 *   实际是限流，不是网络不通，重试也没用（要等一小时）。
 *
 *   releases.atom 是普通网页资源，走 Varnish 缓存，**不占 API 额度**。
 *   它给不了 assets 列表（下载包要靠 API 或页面），但判断「有没有新版本」
 *   和给出 release 页面链接足够了 —— 用户点「去下载」本来也是打开网页。
 *
 * 返回 null 表示解析不了（格式变了），调用方回退到 API。
 *
 * @param {string} xml
 * @returns {{latest:string, notes:string, pageUrl:string, publishedAt:string, assets:Array}|null}
 */
export function fromAtomFeed(xml) {
  const text = String(xml ?? '');
  if (!text) return null;
  // ★ 逐条找，跳过预发布。
  //
  //   releases/latest 这个 API 本来就只返回正式版，但 atom 订阅源会把
  //   预发布（tag 里带 '-'）也列出来。不跳的话：发了一个 v1.4.0-beta.1，
  //   所有用户都会被提示升级到 beta。
  const entries = [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  for (const m of entries) {
    const entry = m[1];
    // tag 从 link 里取；id 里也有但格式是 tag:github.com,2008:Repository/123/v1.3.11
    const link = entry.match(/href="([^"]*\/releases\/tag\/([^"]+))"/);
    const tag = link?.[2] ?? '';
    if (!tag) continue;
    if (tag.includes('-')) continue; // 预发布跳过
    const updated = entry.match(/<updated>([^<]*)<\/updated>/)?.[1] ?? '';
    // 标题当摘要用（atom 里没有完整正文）。
    // atom 是 XML，标题里的 & < > " ' 都是实体，要解码后再给人看。
    const rawTitle = entry.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    return {
      latest: tag,
      notes: decodeEntities(rawTitle),
      pageUrl: link[1],
      publishedAt: updated,
      // atom 里没有下载包信息；真正的下载链接由 release 页面提供
      assets: [],
    };
  }
  return null;
}

/// 解码 XML 里最常见的几个实体。
///
/// atom 的 <title> 是 XML 文本：发版说明里写 "提速 & 修复" 或引号，
/// 拿到的是 &amp; &lt; &gt; &quot; &#39;。不解码用户在更新弹窗里看到的是原始实体。
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * atom feed 的地址（跟 API 地址同源，同样可被环境变量覆盖）。
 */
export function atomEndpoint(env = process.env) {
  const custom = String(env.PI_BOT_UPDATE_URL ?? '').trim();
  if (custom) return null; // 自定义地址按原样用，不派生 atom
  const repo = String(env.PI_BOT_UPDATE_REPO ?? '').trim() || DEFAULT_REPO;
  return `https://github.com/${repo}/releases.atom`;
}

/**
 * 只在「atom 说有新版本」时调：去 API 补下载包列表。
 *
 * 调用频率 = 有新版本的那几次，不是每次检查 —— 所以 60 次/小时的限流
 * 打不光。「已是最新」是绝大多数情况，那条路完全不碰 API。
 *
 * 失败返回 null（没有下载包也能让用户去 release 页面下）。
 */
async function fetchAssetsFromApi(apiUrl, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { res } = await publicFetch(
      apiUrl,
      {
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `pi-bot/${VERSION}`,
        },
      },
      { fetchImpl: typeof fetchImpl === 'function' ? fetchImpl : undefined, scope: 'user-config' },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return fromGithubRelease(json).assets;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉 releases.atom 并解出最新版本。
 *
 * 失败不抛错，返回 {ok:false} 让调用方回退 API ——
 * 检查更新这条链上任何一环都不该把异常抛给用户。
 *
 * @param {string} atomUrl
 * @param {Function|undefined} fetchImpl 测试注入
 * @returns {Promise<{ok:boolean, data?:object}>}
 */
async function fetchAtom(atomUrl, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { res } = await publicFetch(
      atomUrl,
      {
        signal: controller.signal,
        headers: {
          accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
          'user-agent': `pi-bot/${VERSION}`,
        },
      },
      { fetchImpl: typeof fetchImpl === 'function' ? fetchImpl : undefined, scope: 'user-config' },
    );
    if (!res.ok) return { ok: false };
    const xml = await res.text();
    const data = fromAtomFeed(xml);
    return data ? { ok: true, data } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
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

  // ★ 先用 releases.atom（不占 API 额度），失败再回退 GitHub API。
  //
  //   原因见 fromAtomFeed 上方：API 未认证只有 60 次/小时，超了就是
  //   "检查更新失败：HTTP 403" —— 用户看到的"经常报错"就是这个。
  //   atom 走网页缓存，不会被打光。
  //
  //   只有自定义了 PI_BOT_UPDATE_URL 才跳过 atom（那时用户指定了确切地址）。
  const atomUrl = atomEndpoint(env);
  if (atomUrl) {
    const atom = await fetchAtom(atomUrl, fetchImpl);
    if (atom.ok) {
      const info = {
        ok: true,
        ...buildUpdateInfo({ current: VERSION, ...atom.data }),
        source: `${source}:atom`,
        cached: false,
      };
      // ★ atom 里没有 assets。**只有确认有新版本时**才多打一次 API 拿下载包
      //   —— 这时用户马上要下载，值得这一次调用；而且「已是最新」是绝大多数
      //   情况，那种场景完全不碰 API，限流就打不光。
      if (info.update && info.assets.length === 0) {
        const extra = await fetchAssetsFromApi(url, fetchImpl);
        if (extra) {
          const merged = {
            ...info,
            ...buildUpdateInfo({ current: VERSION, ...atom.data, assets: extra }),
            source: info.source,
            cached: false,
          };
          cache = { at: now, info: merged, source: merged.source };
          return { ...merged, recommended: pickAssetFor(merged.assets, platform) };
        }
      }
      cache = { at: now, info, source: info.source };
      return { ...info, recommended: pickAssetFor(info.assets, platform) };
    }
    // atom 失败就往下走 API —— 两条路互相兜底
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
