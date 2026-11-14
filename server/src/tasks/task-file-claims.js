/**
 * 派活时的文件占用声明：把「这次要动哪些文件」变成可比较的键（纯逻辑，无 IO、无时钟）。
 *
 * ## 为什么需要
 *
 * 同一波派出去的成员是**并行**跑的：调度器只按执行者去重（同一个 Bot 同时只跑一个），
 * 不看文件。两个人各自改同一个文件时，读-改-写之间没有任何锁，
 * 后写的会静默覆盖先写的；bash 工具更不经过任何队列。
 *
 * ## 判定规则
 *
 *   · 路径统一成 posix 形式比较（反斜杠 → `/`），去掉 `./` 与结尾 `/`；
 *   · `.` / `..` 只做**词法**解析，不碰文件系统 —— 调度层不该为了比较路径去 stat，
 *     而且工作目录可能在沙箱内、宿主这边读不到；
 *   · 声明的**目录覆盖其下所有文件**：`src/auth` 与 `src/auth/login.js` 冲突；
 *   · 结尾的 `/*`、`/**` 视作该目录本身；
 *   · Windows 与 macOS 默认大小写不敏感（APFS 默认卷也是），Linux 默认敏感。
 *
 * 冲突判定的方向是「宁可多串行」：漏判会让两个人真的同时写坏文件，
 * 误判只是少并行一次。
 */

/** 单个任务最多声明多少个路径。 */
export const MAX_FILES = 50;

/** 单条路径的字符上限（超过视为无效声明，不截断 —— 截断会造出假路径）。 */
const MAX_PATH_CHARS = 300;

/** 认作"文件"的扩展名（只用于从正文里挑路径，不做白名单校验）。 */
const FILE_EXT = /\.(dart|js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|markdown|txt|py|rs|go|java|kt|kts|swift|m|mm|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|ps1|psm1|bat|cmd|css|scss|sass|less|html|htm|xml|yml|yaml|toml|ini|cfg|conf|lock|sql|proto|graphql|gradle|properties|plist|entitlements)$/i;

/** 正文里可以构成路径的字符（路径分隔符包含正反斜杠）。 */
const PATH_TOKEN = /[A-Za-z0-9_.\-/\\]+/g;

const BACKSLASH = /\\/g;
const LEAD_SEP = /^[.\-/\\]+/;
const TRAIL_SEP = /[.\-/\\]+$/;
const DIR_GLOB = /\/\*{1,2}$/;
/** 正文里的 URL：整段剔掉再挑路径。 */
const URL_like = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S*/g;

/**
 * 该平台的文件系统默认是否大小写不敏感。
 *
 * 只影响比较，不影响真实读写。
 */
export function defaultCaseInsensitive(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * 规范一条声明路径。返回空串表示这条声明无效（空串 / 只剩分隔符 / 过长）。
 *
 * @param {unknown} raw
 * @param {{caseInsensitive?: boolean}} [opts]
 * @returns {string}
 */
export function normalizeClaimPath(raw, { caseInsensitive = defaultCaseInsensitive() } = {}) {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  text = text.replace(BACKSLASH, '/');
  // 目录通配写法归一到目录本身
  text = text.replace(DIR_GLOB, '');
  const absolute = text.startsWith('/');
  const parts = [];
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue;
    // 越过根就往回退一层：声明的是位置，不是"逃到工作目录外面"
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = (absolute ? '/' : '') + parts.join('/');
  if (!joined || joined === '/') return '';
  if (joined.length > MAX_PATH_CHARS) return '';
  return caseInsensitive ? joined.toLowerCase() : joined;
}

/**
 * 把一份声明列表规范化、去重、限量。
 *
 * @param {unknown} raws
 * @param {{caseInsensitive?: boolean}} [opts]
 * @returns {{files: string[], dropped: number}} dropped = 被丢弃的条数（无效或超量）
 */
export function fileClaimList(raws, opts = {}) {
  const list = Array.isArray(raws) ? raws : [];
  const seen = new Set();
  const files = [];
  let dropped = 0;
  for (const raw of list) {
    const key = normalizeClaimPath(raw, opts);
    if (!key) {
      dropped += 1;
      continue;
    }
    if (seen.has(key)) continue;
    if (files.length >= MAX_FILES) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    files.push(key);
  }
  return { files, dropped };
}

/**
 * a 是否覆盖 b：两者相等，或其中一个是另一个的祖先目录。
 *
 * 两个入参都应是 {@link normalizeClaimPath} 处理过的值。
 */
export function coversPath(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return b.startsWith(a + '/') || a.startsWith(b + '/');
}

/**
 * 两份声明是否有交叠。有就返回第一对冲突的路径（便于日志说明"撞在哪"）。
 *
 * @returns {{path: string, other: string}|null}
 */
export function claimsOverlap(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  for (const x of left) {
    for (const y of right) {
      if (coversPath(x, y)) return { path: x, other: y };
    }
  }
  return null;
}

/**
 * 在已占用的声明里找出与候选冲突的任务。
 *
 * @param {object} p
 * @param {{id?:string, files?:string[]}} p.candidate 候选任务（files 需已规范化）
 * @param {Array<{id:string, files:string[]}>} p.claimed 正在跑的任务及其占用
 * @param {string[]} [p.excludeIds] 要跳过的任务 id（自己、自己的子孙）
 * @returns {Array<{id:string, path:string, other:string}>}
 */
export function findClaimConflicts({ candidate, claimed = [], excludeIds = [] } = {}) {
  const mine = Array.isArray(candidate?.files) ? candidate.files : [];
  if (!mine.length) return [];
  const skip = new Set(excludeIds.filter(Boolean));
  const hits = [];
  for (const item of claimed) {
    if (!item || !item.id || skip.has(item.id)) continue;
    const other = Array.isArray(item.files) ? item.files : [];
    if (!other.length) continue;
    const overlap = claimsOverlap(mine, other);
    if (overlap) hits.push({ id: item.id, path: overlap.path, other: overlap.other });
  }
  return hits;
}

/** 冲突的一行说明（日志/诊断用）。 */
export function describeConflict(hit) {
  if (!hit) return '';
  return `${hit.path} ↔ ${hit.other}`;
}

/**
 * 从一段自然语言里挑出像"文件路径"的片段（给「@成员 改 a/b.dart」这种正文用）。
 *
 * 判定刻意保守 —— 只认两类：
 *   · 含路径分隔符的（`app/lib/foo.dart`、Windows 写法同样识别）；
 *   · 或者是带常见扩展名的单个文件名（`README.md`、`package.json`）。
 *
 * URL 先整段剔掉（`https://host/a/b.js` 里的 `a/b.js` 不是本地文件）。
 * 结尾带分隔符的（`out/`）当作目录声明。
 *
 * @param {unknown} text
 * @returns {string[]} 原文里的写法（未规范化），去重、保序
 */
export function filesInText(text) {
  const raw0 = String(text ?? '');
  if (!raw0.trim()) return [];
  const body = raw0.replace(URL_like, ' ');
  const out = [];
  const seen = new Set();
  for (const match of body.matchAll(PATH_TOKEN)) {
    const token = match[0];
    const isDir = /[\/]$/.test(token);
    const raw = token.replace(LEAD_SEP, '').replace(TRAIL_SEP, '');
    if (!raw) continue;
    const looksLikePath = raw.includes('/') || raw.includes('\\');
    const looksLikeFile = FILE_EXT.test(raw);
    if (!looksLikePath && !looksLikeFile && !isDir) continue;
    // 不带路径分隔符时要求长一点，挡掉 `a.b` 这种版本号碎屑
    if (!looksLikePath && !isDir && raw.length < 5) continue;
    const key = normalizeClaimPath(raw, { caseInsensitive: true });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * 从一堆任务里挑出"正在占着我要改的文件的"那几个。
 *
 * 纯逻辑：调用方把任务快照整理成 `{id, parentTaskId, state, files, botName}` 传进来，
 * 这里只回答"谁挡着我"。调度器用它决定排队，测试也直接测它 ——
 * 互斥判定一旦埋进调度器内部，就只能靠构造并发时序来验证，脆得没法维护。
 *
 * ## 谁不算
 *
 *   · **自己**；
 *   · **自己的祖先和子孙** —— 树上相邻的这两个关系天然是一先一后：
 *     祖先常年停在「等待子任务」，子孙是它派出去的活。把它们算成占用，
 *     父任务等子任务、子任务又等父任务，直接自锁。
 *     **兄弟不在排除之列**：同一棵树的两个成员并行改同一个文件，照样会写坏。
 *   · **不在持有状态里的** —— 排队中的任务还没动过文件，
 *     两个排队的互相看见对方就会互相等死。
 *
 * @param {object} p
 * @param {{id:string, files?:string[]}} p.self 当前任务
 * @param {Array<{id:string, parentTaskId?:string|null, state?:string, files?:string[], botName?:string}>} p.runs 其它任务（含自己的祖先/子孙）
 * @param {Set<string>|string[]} p.holdingStates 哪些状态算"持有占用"
 * @returns {{taskRunId:string, who:string, path:string, other:string, why:string}|null}
 */
export function pickBlockingClaim({ self, runs = [], holdingStates = [] } = {}) {
  if (!self?.id) return null;
  const mine = Array.isArray(self.files) ? self.files : [];
  if (!mine.length) return null;
  const holding = holdingStates instanceof Set ? holdingStates : new Set(holdingStates ?? []);
  const related = relatedIds(self.id, runs);
  const claimed = [];
  for (const run of runs) {
    if (!run || !run.id || run.id === self.id) continue;
    if (related.has(run.id)) continue;
    if (!holding.has(String(run.state ?? ''))) continue;
    const files = Array.isArray(run.files) ? run.files : [];
    if (!files.length) continue;
    claimed.push({ id: run.id, files, botName: run.botName ?? '' });
  }
  const hits = findClaimConflicts({ candidate: { id: self.id, files: mine }, claimed });
  if (!hits.length) return null;
  const first = hits[0];
  const who = claimed.find((c) => c.id === first.id)?.botName ?? '';
  return {
    taskRunId: first.id,
    who,
    path: first.path,
    other: first.other,
    why: `等的文件被别人占着：${describeConflict(first)}` + (who ? `（${who} 正在改）` : ''),
  };
}

/**
 * 自己的祖先 + 子孙（不含自己）。
 *
 * 祖先：顺着 parentTaskId 往上走；子孙：谁的父亲在自己这批里。
 */
function relatedIds(selfId, runs) {
  const byId = new Map();
  for (const run of runs) if (run?.id) byId.set(run.id, run);
  const out = new Set();
  // 祖先
  let cursor = byId.get(selfId)?.parentTaskId ?? null;
  const guard = new Set([selfId]);
  while (cursor && !guard.has(cursor)) {
    out.add(cursor);
    guard.add(cursor);
    cursor = byId.get(cursor)?.parentTaskId ?? null;
  }
  // 子孙（连带多层）
  const stack = [selfId];
  const seen = new Set([selfId]);
  while (stack.length) {
    const parent = stack.pop();
    for (const run of runs) {
      if (!run?.id || seen.has(run.id)) continue;
      if (run.parentTaskId !== parent) continue;
      seen.add(run.id);
      out.add(run.id);
      stack.push(run.id);
    }
  }
  return out;
}
