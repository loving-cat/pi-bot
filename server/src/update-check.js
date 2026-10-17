/**
 * 版本比较与"有没有新版本"的判定（纯函数，无网络、无 IO）。
 *
 * 为什么单独一层：
 *   · 比较规则要能单测（`1.2.0` vs `1.2.0-beta.1`、`v1.10.0` vs `1.9.0` 这类）；
 *   · 判断"算不算更新"要能被上层随意调用，不许在网上请求里掺业务判断。
 *
 * 支持的版本形态：`1.2.3`、`v1.2.3`、`1.2.3+5`（构建号）、`1.2.3-beta.2`。
 * 语义遵循 semver：有预发布标记的**小于**同版本正式版。
 */

/**
 * 把版本串解析成可比较的结构。
 * @param {string} raw
 * @returns {{core:number[], pre:string[], build:string}|null} 解析失败返回 null
 */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^v/i, '');
  if (!text) return null;

  // 主版本 + 可选预发布 + 可选构建号
  const m = text.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) return null;

  const core = m[1].split('.').map((n) => Number.parseInt(n, 10));
  if (core.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const pre = m[2] ? m[2].split('.') : [];
  return { core, pre, build: m[3] ?? '' };
}

/**
 * 比较两个版本。
 * @returns {number} a<b → -1，相等 → 0，a>b → 1；任一侧无法解析时返回 0
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;

  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  // 预发布：没有标记的更大（1.0.0 > 1.0.0-beta）
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;

  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    // 数字段小于字母段（semver 第 11 条）
    if (nx && !ny) return -1;
    if (!nx && ny) return 1;
    // 两边都是数字时按**数值**比：字符串比会把 beta.10 判成小于 beta.9
    if (nx && ny) {
      const dx = Number.parseInt(x, 10);
      const dy = Number.parseInt(y, 10);
      if (dx !== dy) return dx < dy ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 远端发布信息里挑出我们要的那几条，判断是否更新。
 *
 * @param {object} p
 * @param {string} p.current    当前版本
 * @param {string} p.latest     远端最新版本（tag 或 version 字段）
 * @param {string} [p.notes]    更新说明
 * @param {string} [p.pageUrl]  发布页
 * @param {Array<{name?:string,url?:string,size?:number}>} [p.assets] 可下载文件
 * @param {string} [p.publishedAt]
 * @returns {{update:boolean, current:string, latest:string, reason:string, notes:string,
 *            pageUrl:string, publishedAt:string, assets:Array}}
 */
export function buildUpdateInfo({
  current = '',
  latest = '',
  notes = '',
  pageUrl = '',
  assets = [],
  publishedAt = '',
} = {}) {
  const base = {
    current,
    latest,
    notes: '',
    pageUrl: '',
    publishedAt: '',
    assets: [],
  };

  if (!parseVersion(current)) {
    return { ...base, update: false, reason: `当前版本无法识别：${current || '(空)'}` };
  }
  if (!parseVersion(latest)) {
    return { ...base, update: false, reason: `远端版本无法识别：${latest || '(空)'}` };
  }

  const cmp = compareVersions(latest, current);
  if (cmp <= 0) {
    return { ...base, update: false, reason: cmp === 0 ? '已经是最新版本' : '远端版本比当前旧' };
  }

  return {
    update: true,
    reason: `发现新版本 ${latest}（当前 ${current}）`,
    current,
    latest,
    // 说明文本限长：更新日志偶尔几千字，没必要整段塞进界面
    notes: String(notes ?? '').slice(0, 4000),
    pageUrl: String(pageUrl ?? ''),
    publishedAt: String(publishedAt ?? ''),
    assets: (assets ?? [])
      .filter((a) => a && typeof a.url === 'string' && a.url)
      .map((a) => ({
        name: String(a.name ?? ''),
        url: a.url,
        size: Number.isFinite(a.size) ? a.size : 0,
      })),
  };
}

/** 更新元数据 / 签名文件：不是安装包，绝不能当成下载目标 */
const NOT_INSTALLER = /\.(blockmap|ya?ml|txt|sha256|sha512|sig|asc|json)$/i;

/**
 * 各平台认哪些文件名。
 *
 * 平台词必须带分隔符边界（`-win-` / `_win_` / ` win `），
 * 无锚点的 /win/ 会命中 "darwin"，把 Mac 包推给 Windows 用户。
 * 不用 .zip 兜底：zip 判不出平台，宁可不给直链让用户去发布页。
 */
const PLATFORM_RULES = {
  win32: [/\.exe$/i, /\.msi$/i, /[-_. ]win(?:32|64|dows)?[-_. ]/i],
  darwin: [/\.dmg$/i, /\.pkg$/i, /[-_. ](?:mac|osx|darwin)[-_. ]/i],
  android: [/\.apk$/i, /[-_. ]android[-_. ]/i],
  linux: [/\.appimage$/i, /\.deb$/i, /[-_. ]linux[-_. ]/i],
};

/**
 * 从一组下载文件里挑出最适合当前平台的那个。
 *
 * 约定：文件名里带平台关键字（win/mac/dmg/exe/apk）就认。
 * 挑不到就返回 null —— 上层退回"打开发布页让用户自己下"，不猜。
 *
 * @param {Array<{name?:string,url?:string,size?:number}>} assets
 * @param {NodeJS.Platform|string} platform
 * @returns {{name:string,url:string,size:number}|null}
 */
export function pickAssetFor(assets = [], platform = process.platform) {
  const rules = PLATFORM_RULES[platform];
  if (!rules || !Array.isArray(assets)) return null;

  // 只认 https 直链；排除更新元数据（latest.yml / *.blockmap / 校验文件），
  // 否则它们会因为文件名里带平台词而抢在真正的安装包前面。
  const candidates = assets.filter(
    (a) =>
      a &&
      typeof a.name === 'string' &&
      typeof a.url === 'string' &&
      /^https:\/\//i.test(a.url) &&
      !NOT_INSTALLER.test(a.name),
  );
  // 只按文件名判平台：URL 里可能带 "darwin" 之类的字样，按 URL 匹配会串平台
  const hit = candidates.find((a) => rules.some((re) => re.test(a.name)));
  return hit ? { name: hit.name, url: hit.url, size: Number(hit.size) || 0 } : null;
}

