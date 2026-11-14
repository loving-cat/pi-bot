/**
 * 授权记录与判定（纯逻辑，无 IO、无时钟）。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §6.1「授权记录的逻辑结构」与
 * §6.3「回收与失败」、§11「P0：先建立真实授权边界」。
 *
 * ## 为什么单独一个文件
 *
 * 规格 §11 的第一条是：**入口逐次强制核对当前有效授权及完整父链撤销状态，
 * 不允许以工具名/角色提示词代替执行检查**。
 *
 * 要做这件事，判定本身必须是纯函数 —— 否则每接一个入口就要重写一遍
 * "什么算有效"，迟早漂移成「模型工具那条线严格、HTTP 那条线宽松」。
 * 这个文件只回答一个问题：**这条授权能不能覆盖这次动作**。
 *
 * ## 三条不可放宽的规则（规格 §6.1 / §5.3）
 *
 *   1. 授权根只能来自已认证用户交互（或用户已明确保存的窄范围规则）。
 *      模型、群消息、网页、仓库配置**都不能**创建或充当授权。
 *   2. 子授权 = 父授权 ∩ 任务需求。动作、资源、有效期、次数**都不可放宽**。
 *   3. 执行 Bot 默认不能继续转授（`canDelegate` 默认 false）。
 *
 * ## 什么不算授权
 *
 * 工具名、角色提示词（"你是主 Bot"）、委派单里的 grantId 字符串、
 * 群消息、屏幕内容、测试通过 —— 全部只是**数据**。
 * 判定只认这里校验通过、且父链完好的记录。
 */

/** 动作种类。写成点号形式是为了能按前缀做粗粒度匹配（`file.*`）。 */
export const ACTION = Object.freeze({
  fileRead: 'file.read',
  fileWrite: 'file.write',
  fileDelete: 'file.delete',
  cmdExec: 'cmd.exec',
  /** 后台进程（run_background / write_stdin 续接） */
  cmdBackground: 'cmd.background',
  gitRead: 'git.read',
  gitCommit: 'git.commit',
  gitPush: 'git.push',
  gitDestructive: 'git.destructive',
  desktopObserve: 'desktop.observe',
  desktopInput: 'desktop.input',
  netFetch: 'net.fetch',
  /** 对外发送 / 发布 / 上传 —— 与 netFetch 分开，因为风险差一个数量级 */
  netSend: 'net.send',
  secretUse: 'secret.use',
  policyChange: 'policy.change',
  mcpAdd: 'mcp.add',
});

export const ALL_ACTIONS = Object.freeze(Object.values(ACTION));

/** 风险等级：决定"要不要真用户确认"（确认框架是 P0-4，这里只标记）。 */
export const RISK = Object.freeze({
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'critical',
});

/** 执行模式（规格 §8）。 */
export const MODE = Object.freeze({
  /** 主 Bot 可信宿主模式：当前登录身份，全机任务视野 */
  host: 'host',
  /** 项目受控模式：范围受限的文件/命令/Git 适配器 */
  project: 'project',
  /** 隔离执行模式：沙箱或 VM */
  isolated: 'isolated',
});

export const ALL_MODES = Object.freeze(Object.values(MODE));

/** 授权的来源。只有前两项能创建授权根。 */
export const SOURCE = Object.freeze({
  /** 已认证用户的真实交互 */
  user: 'user',
  /** 用户明确保存过的窄范围规则（长期规则） */
  savedRule: 'saved-rule',
  /**
   * 迁移兼容：升级前那份全局 policy 就是用户当时批准过的口径。
   *
   * 它**不是**新授权，只是把既有行为如实记成一条根授权，
   * 好让网关上线时不改变任何现有行为（规格 §11「隔离旧规则与新策略版本」）。
   * 它的范围写死成"当前 policy 已经允许的"，不可能比现在更宽。
   */
  legacyPolicy: 'legacy-policy',
});

const ROOT_SOURCES = new Set([SOURCE.user, SOURCE.savedRule, SOURCE.legacyPolicy]);

/** 拒绝原因码。调用方据此决定是提示、审计还是静默记录。 */
export const DENY = Object.freeze({
  noGrant: 'no_grant',
  expired: 'expired',
  revoked: 'revoked',
  exhausted: 'exhausted',
  actionNotCovered: 'action_not_covered',
  resourceNotCovered: 'resource_not_covered',
  constraintFailed: 'constraint_failed',
  modeMismatch: 'mode_mismatch',
  policyChanged: 'policy_changed',
  generationStale: 'generation_stale',
  parentInvalid: 'parent_invalid',
  badSource: 'bad_source',
  tooWide: 'delegation_too_wide',
  cannotDelegate: 'cannot_delegate',
  invalid: 'invalid_grant',
});

const DENY_TEXT = Object.freeze({
  [DENY.noGrant]: '没有任何有效授权覆盖这次动作',
  [DENY.expired]: '授权已过期',
  [DENY.revoked]: '授权已被撤销',
  [DENY.exhausted]: '授权可用次数已用尽',
  [DENY.actionNotCovered]: '这条授权不包含这个动作',
  [DENY.resourceNotCovered]: '目标不在授权范围内',
  [DENY.constraintFailed]: '动作参数不满足授权的约束',
  [DENY.modeMismatch]: '执行模式与授权不符',
  [DENY.policyChanged]: '部门规矩在此之后变过，这条授权需要重新核对',
  [DENY.generationStale]: '实例/资源世代已变化，旧授权作废',
  [DENY.parentInvalid]: '父授权无效或已撤销',
  [DENY.badSource]: '这个来源不能创建授权',
  [DENY.tooWide]: '子授权不能比父授权更宽（动作/资源/期限/次数）',
  [DENY.cannotDelegate]: '这条授权不允许继续转授',
  [DENY.invalid]: '授权记录本身不合法',
});

const deny = (code, detail = '') => ({
  ok: false,
  code,
  text: detail || DENY_TEXT[code] || code,
});

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isTime = (v) => Number.isFinite(v) && v > 0;

const MAX_PATH = 4000;
const MAX_RESOURCES = 200;
const MAX_ACTIONS = 32;
const MAX_USES = 100000;

/**
 * 资源范围的规范化。
 *
 * 规格 §6.1：**路径使用最终资源标识并处理链接/别名**。
 * 这一层做不了 realpath（纯逻辑，不碰文件系统），所以：
 *   · 调用方必须先 realpath 再把结果传进来（见 `grant-gate.js` 的 `finalPath`）；
 *   · 这里只做词法归一（反斜杠、结尾斜杠、大小写按平台）。
 *
 * 资源写成对象比字符串好：以后要按仓库/远端/主机分别判定时不用改结构。
 *
 * @typedef {object} Resource
 * @property {'path'|'repo'|'host'|'secret'|'desktop'} kind
 * @property {string} ref  规范化后的引用（路径/仓库标识/主机名/凭据键/会话名）
 */
export function normalizeResource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind ?? '');
  if (!['path', 'repo', 'host', 'secret', 'desktop'].includes(kind)) return null;
  let ref = String(raw.ref ?? '').trim();
  if (!ref || ref.length > MAX_PATH) return null;
  if (kind === 'path') {
    ref = ref.replace(/\\/g, '/').replace(/\/+$/, '');
    const absolute = ref.startsWith('/');
    const parts = [];
    for (const seg of ref.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    ref = (absolute ? '/' : '') + parts.join('/');
    if (!ref || ref === '/') return null;
    // Windows / macOS 默认大小写不敏感；Linux 不折叠（同 task-file-claims 的口径）
    if (process.platform === 'win32' || process.platform === 'darwin') ref = ref.toLowerCase();
  } else if (kind === 'host') {
    ref = ref.toLowerCase();
  }
  return Object.freeze({ kind, ref });
}

/** 资源 a 是否覆盖 b（同种类、且 a 是 b 本身或其祖先）。 */
export function resourceCovers(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.ref === b.ref) return true;
  // 只有路径有"祖先覆盖子项"的语义；主机/仓库/凭据要求精确相等
  if (a.kind !== 'path') return false;
  return b.ref.startsWith(a.ref + '/');
}

/**
 * 校验并规范化一条授权记录。
 *
 * @returns {{ok:true, grant:object}|{ok:false, code:string, text:string}}
 */
export function normalizeGrant(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return deny(DENY.invalid, '授权必须是对象');
  if (!isId(raw.id)) return deny(DENY.invalid, '授权缺少合法 id');
  const source = String(raw.source ?? '');
  if (!ROOT_SOURCES.has(source) && source !== 'delegated') {
    return deny(DENY.badSource, `来源不能是「${source}」——只有用户交互/已保存规则能创建授权`);
  }

  const subject = raw.subject ?? {};
  if (!isId(subject.botId)) return deny(DENY.invalid, '授权必须绑定到具体 Bot');

  const actions = Array.isArray(raw.actions) ? raw.actions : null;
  if (!actions || !actions.length) return deny(DENY.invalid, '授权必须至少包含一个动作');
  const cleanActions = [];
  for (const a of actions.slice(0, MAX_ACTIONS)) {
    const name = String(a ?? '');
    if (!ALL_ACTIONS.includes(name)) return deny(DENY.invalid, `未知动作：${name}`);
    if (!cleanActions.includes(name)) cleanActions.push(name);
  }

  const resources = [];
  for (const r of (Array.isArray(raw.resources) ? raw.resources : []).slice(0, MAX_RESOURCES)) {
    const n = normalizeResource(r);
    if (!n) return deny(DENY.invalid, '资源条目不合法');
    resources.push(n);
  }

  const mode = raw.mode === undefined ? MODE.project : String(raw.mode);
  if (!ALL_MODES.includes(mode)) return deny(DENY.invalid, `未知执行模式：${mode}`);

  const expiresAt = raw.expiresAt === undefined || raw.expiresAt === null ? null : Number(raw.expiresAt);
  if (expiresAt !== null && !isTime(expiresAt)) return deny(DENY.invalid, 'expiresAt 必须是毫秒时间戳或 null');

  const maxUses = raw.maxUses === undefined || raw.maxUses === null ? null : Number(raw.maxUses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES)) {
    return deny(DENY.invalid, `maxUses 必须是 1..${MAX_USES} 的整数或 null`);
  }

  return {
    ok: true,
    grant: Object.freeze({
      id: raw.id,
      source,
      /** 真实用户授权来源的描述（哪一次交互、哪条已保存规则） */
      sourceRef: String(raw.sourceRef ?? ''),
      subject: Object.freeze({
        botId: subject.botId,
        role: String(subject.role ?? ''),
        instanceId: String(subject.instanceId ?? ''),
      }),
      taskId: raw.taskId ? String(raw.taskId) : null,
      parentId: raw.parentId ? String(raw.parentId) : null,
      actions: Object.freeze(cleanActions),
      resources: Object.freeze(resources),
      /** 参数约束：键为动作名，值是纯数据（由各适配器自己解释） */
      constraints: Object.freeze(raw.constraints && typeof raw.constraints === 'object' ? raw.constraints : {}),
      risk: Object.values(RISK).includes(String(raw.risk)) ? String(raw.risk) : RISK.medium,
      mode,
      /** 规章版本：策略变了以后旧授权不能自动继续生效（规格 §6.1） */
      policyRevision: raw.policyRevision ? String(raw.policyRevision) : null,
      /** 实例/资源世代：重启或资源重建后旧授权作废（规格 §6.3） */
      generation: raw.generation ? String(raw.generation) : null,
      canDelegate: raw.canDelegate === true,
      maxUses,
      createdAt: isTime(Number(raw.createdAt)) ? Number(raw.createdAt) : null,
      expiresAt,
      revokedAt: isTime(Number(raw.revokedAt)) ? Number(raw.revokedAt) : null,
      revokedReason: String(raw.revokedReason ?? ''),
    }),
  };
}

/**
 * 这条授权现在有效吗（不含"动作/资源是否覆盖"，那一步单独判）。
 *
 * 规格 §6.1：**在执行边界检查有效性，不能只在工具注册或队列入队时检查**。
 * 所以这个函数必须由调用方在每次执行前调用，而不是缓存结果。
 *
 * @param {object} p
 * @param {object} p.grant
 * @param {number} p.now
 * @param {string|null} [p.policyRevision] 当前策略版本（给了就必须一致）
 * @param {string|null} [p.generation] 当前实例世代（给了就必须一致）
 * @param {number} [p.usedUses] 已用次数（用于 maxUses 判定）
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function checkGrantValidity({ grant, now, policyRevision = null, generation = null, usedUses = 0 } = {}) {
  if (!grant) return deny(DENY.noGrant);
  if (grant.revokedAt) return deny(DENY.revoked, `授权在 ${new Date(grant.revokedAt).toISOString()} 被撤销${grant.revokedReason ? `：${grant.revokedReason}` : ''}`);
  if (grant.expiresAt !== null && now >= grant.expiresAt) return deny(DENY.expired, `授权已于 ${new Date(grant.expiresAt).toISOString()} 到期`);
  if (grant.maxUses !== null && Number(usedUses) >= grant.maxUses) {
    return deny(DENY.exhausted, `授权只允许 ${grant.maxUses} 次，已用 ${usedUses} 次`);
  }
  // ★ 策略版本绑定：规矩变了以后旧授权不再自动生效。
  //
  //   这不是"保守"，是规格 §6.1 的明确要求：新策略必须让排队动作过期。
  //   否则用户收紧了规矩，一条几小时前批准的授权还在替他放行。
  if (grant.policyRevision && policyRevision && grant.policyRevision !== policyRevision) {
    return deny(DENY.policyChanged, `授权基于规矩 ${grant.policyRevision}，当前是 ${policyRevision}`);
  }
  // ★ 实例世代：重启/重建资源后旧授权作废（规格 §6.3 后台任务不得续接旧权限）
  if (grant.generation && generation && grant.generation !== generation) {
    return deny(DENY.generationStale, `授权属于实例世代 ${grant.generation}，当前是 ${generation}`);
  }
  return { ok: true };
}

/**
 * 这条授权覆盖某个动作 + 目标吗。
 *
 * @param {object} p
 * @param {object} p.grant
 * @param {string} p.action
 * @param {Resource[]} [p.targets] 本次动作涉及的目标资源
 * @param {object} [p.params] 动作参数（供 constraints 判定）
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function grantCovers({ grant, action, targets = [], params = {} } = {}) {
  if (!grant) return deny(DENY.noGrant);
  if (!grant.actions.includes(action)) {
    return deny(DENY.actionNotCovered, `授权只包含：${grant.actions.join('、') || '（空）'}`);
  }
  const wanted = (Array.isArray(targets) ? targets : []).map(normalizeResource).filter(Boolean);
  // 有目标就必须逐个被覆盖；没有目标时只要求这条授权在同一 mode 下非空
  for (const t of wanted) {
    const hit = grant.resources.some((r) => resourceCovers(r, t));
    if (!hit) return deny(DENY.resourceNotCovered, `${t.kind}:${t.ref}`);
  }
  const constraint = grant.constraints?.[action];
  if (constraint && typeof constraint === 'object') {
    const verdict = checkConstraints(constraint, params);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/**
 * 参数约束判定。
 *
 * 现在只支持三种最简单的形状（够用且可解释）：
 *   · `{ deny: [...] }`   参数里这些值不许出现（命令片段/主机名）
 *   · `{ allow: [...] }`  参数必须是其中之一
 *   · `{ maxBytes: n }`   数值上限
 *
 * 故意**不**做正则/表达式 —— 约束一旦能写成图灵完备的东西，
 * "这条授权到底允许什么"就没人能说清了，审计也失去意义。
 *
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function checkConstraints(constraint, params = {}) {
  const c = constraint && typeof constraint === 'object' ? constraint : null;
  if (!c) return { ok: true };
  const values = Object.values(params ?? {}).filter((v) => typeof v === 'string');
  if (Array.isArray(c.deny) && c.deny.length) {
    for (const bad of c.deny) {
      const needle = String(bad);
      if (!needle) continue;
      for (const v of values) {
        if (v.includes(needle)) return deny(DENY.constraintFailed, `参数里出现了被禁止的内容：${needle}`);
      }
    }
  }
  if (Array.isArray(c.allow) && c.allow.length) {
    const ok = values.length === 0 || values.every((v) => c.allow.map(String).includes(v));
    if (!ok) return deny(DENY.constraintFailed, `参数不在允许清单里：${c.allow.map(String).join('、')}`);
  }
  if (Number.isFinite(Number(c.maxBytes))) {
    for (const v of Object.values(params ?? {})) {
      if (typeof v === 'string' && Buffer.byteLength(v) > Number(c.maxBytes)) {
        return deny(DENY.constraintFailed, `参数超过 ${c.maxBytes} 字节`);
      }
    }
  }
  return { ok: true };
}

/**
 * 派生子授权：**只能收窄，不能放宽**（规格 §6.1 / §5.3 代办不得借权）。
 *
 * 判定四条：动作必须是父的子集、资源必须被父覆盖、有效期不能更长、
 * 次数不能更多。任何一条放宽都直接拒绝 —— 不"取交集后继续"。
 *
 * 为什么拒绝而不是自动取交集：自动取交集会把"申请人以为批了 A∪B"
 * 悄悄变成 A，双方对"到底批了什么"的理解从此不一致。
 * 授权是安全边界，宁可不批，不能批出一个双方理解不同的东西。
 *
 * @param {object} p
 * @param {object} p.parent 父授权（已规范化、已通过有效性检查）
 * @param {object} p.child  子授权规格（id/subject 等由调用方填）
 * @param {number} [p.now]
 * @returns {{ok:true, grant:object}|{ok:false, code:string, text:string}}
 */
export function deriveGrant({ parent, child, now = 0 } = {}) {
  if (!parent) return deny(DENY.parentInvalid, '缺少父授权');
  // 父授权自身的有效性由调用方在更外层核（它知道当前 policy 版本与实例世代）；
  // 这里只保证不去派生一个已经撤销的父的下游。
  if (parent.revokedAt) return deny(DENY.parentInvalid, '父授权已撤销');
  if (!parent.canDelegate) return deny(DENY.cannotDelegate);

  const built = normalizeGrant({
    ...child,
    source: 'delegated',
    parentId: child?.parentId ?? parent.id,
  });
  if (!built.ok) return built;
  const c = built.grant;

  // 1) 动作
  for (const a of c.actions) {
    if (!parent.actions.includes(a)) {
      return deny(DENY.tooWide, `子授权要求动作 ${a}，父授权没有`);
    }
  }
  // 2) 资源
  for (const r of c.resources) {
    if (!parent.resources.some((pr) => resourceCovers(pr, r))) {
      return deny(DENY.tooWide, `子授权要求资源 ${r.kind}:${r.ref}，父授权没覆盖`);
    }
  }
  // 3) 期限：子不能比父长；父无限期时子可以有限期
  if (parent.expiresAt !== null) {
    if (c.expiresAt === null) return deny(DENY.tooWide, '父授权有期限，子授权不能无限期');
    if (c.expiresAt > parent.expiresAt) return deny(DENY.tooWide, '子授权期限比父授权长');
  }
  // 4) 次数：子不能比父多
  if (parent.maxUses !== null) {
    if (c.maxUses === null) return deny(DENY.tooWide, '父授权有次数上限，子授权不能无限次');
    if (c.maxUses > parent.maxUses) return deny(DENY.tooWide, '子授权次数上限比父授权多');
  }
  // 5) 模式不能更宽：isolated < project < host
  const order = { [MODE.isolated]: 0, [MODE.project]: 1, [MODE.host]: 2 };
  if ((order[c.mode] ?? 1) > (order[parent.mode] ?? 1)) {
    return deny(DENY.tooWide, `子授权模式 ${c.mode} 比父授权 ${parent.mode} 更宽`);
  }
  // 6) 子授权默认不能再转授
  const grant = Object.freeze({ ...c, canDelegate: false, policyRevision: c.policyRevision ?? parent.policyRevision });
  return { ok: true, grant };
}

/**
 * 父链完整性：从这条授权往上走，任何一环撤销/过期/换代都算无效。
 *
 * 规格 §6.1「完整父链撤销状态」：撤销父授权必须立刻让所有下游失效，
 * 不能因为子授权本身还"没过期"就继续放行。
 *
 * @param {object} p
 * @param {object} p.grant
 * @param {(id:string)=>object|null} p.lookup 取授权
 * @param {number} p.now
 * @param {string|null} [p.policyRevision]
 * @param {string|null} [p.generation]
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function checkChain({ grant, lookup, now, policyRevision = null, generation = null } = {}) {
  const seen = new Set();
  let cursor = grant;
  while (cursor) {
    if (!cursor.id || seen.has(cursor.id)) return deny(DENY.parentInvalid, '授权父链出现环或缺少 id');
    seen.add(cursor.id);
    const v = checkGrantValidity({ grant: cursor, now, policyRevision, generation });
    if (!v.ok) {
      return cursor.id === grant.id ? v : deny(DENY.parentInvalid, `父授权 ${cursor.id}：${v.text}`);
    }
    if (!cursor.parentId) {
      // 根授权：来源必须合法
      if (!ROOT_SOURCES.has(cursor.source) && cursor.source !== 'delegated') {
        return deny(DENY.badSource, `根授权来源「${cursor.source}」不合法`);
      }
      return { ok: true };
    }
    const parent = lookup ? lookup(cursor.parentId) : null;
    if (!parent) return deny(DENY.parentInvalid, `找不到父授权 ${cursor.parentId}`);
    cursor = parent;
  }
  return deny(DENY.parentInvalid, '父链为空');
}

/** 一句话描述这条授权（日志/审计用，不含任何凭据）。 */
export function describeGrant(grant) {
  if (!grant) return '(无授权)';
  const who = grant.subject.role ? `${grant.subject.role}/${grant.subject.botId}` : grant.subject.botId;
  const acts = grant.actions.join(',');
  const res = grant.resources.length ? grant.resources.map((r) => `${r.kind}:${r.ref}`).join(',') : '(不限资源)';
  const until = grant.expiresAt ? `，有效至 ${new Date(grant.expiresAt).toISOString()}` : '';
  const uses = grant.maxUses ? `，可用 ${grant.maxUses} 次` : '';
  return `${grant.id}（${who}｜${acts}｜${res}｜${grant.mode}${until}${uses}｜来源 ${grant.source}）`;
}
