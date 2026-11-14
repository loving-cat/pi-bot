/**
 * 授权网关：把「这次动作允不允许」收敛到一个入口（有 IO、有状态）。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §6、§11 P0-1。
 *
 * ## 它替掉什么、不替掉什么
 *
 * 替掉的：**分散在各处的"该不该放行"判断**。原来 policy-hook 自己拼一套、
 * HTTP 路由压根没有、未来 Git/GUI 再各拼一套 —— 迟早漂移成
 * 「模型工具那条线严格、HTTP 那条线宽松」。
 *
 * 不替掉的：各能力自己的**技术约束**（沙箱能不能起、路径是否安全、
 * 命令是否命中黑名单）。那些是"这个动作本身能不能做"，
 * 网关回答的是"这个人有没有资格做"。两者都要过。
 *
 * ## 判定顺序（顺序有意义）
 *
 *   1. 找覆盖这次动作的候选授权（可以有多条，多条之间取"最近"的一条）
 *   2. 逐条核有效性（撤销/过期/次数/策略版本/世代）
 *   3. 核父链完整性（上游撤销 = 下游失效）
 *   4. 核动作与资源覆盖（含参数约束）
 *   5. 全部通过才放行，并记一条审计
 *
 * 任何一步失败都**不降级**、不尝试下一条更宽松的路径（规格 §8：
 * 隔离失败不得静默转成宿主执行）。
 */
import { randomUUID } from 'node:crypto';
import { log } from './util.js';
import {
  ACTION, DENY, MODE, RISK, SOURCE,
  checkChain, checkGrantValidity, grantCovers, normalizeGrant, normalizeResource, describeGrant,
} from './grants.js';

/** 审计里保留的最近条数（超出后落盘裁剪）。 */
const MAX_AUDIT = 500;

/** 授权记录保留上限。 */
const MAX_GRANTS = 500;

/**
 * 由哪些「动作」构成一次工具调用。工具名到动作的映射是**白名单**：
 * 不在表里的工具不经过网关判定（它要么纯读、要么走自己的专用校验）。
 *
 * ★ 这张表是网关的覆盖面本身。新增一个能产生副作用的工具就必须在这里登记，
 *   否则它就是一个"网关看不见的执行入口"。
 */
export const TOOL_ACTIONS = Object.freeze({
  bash: { action: ACTION.cmdExec, risk: RISK.medium },
  powershell: { action: ACTION.cmdExec, risk: RISK.medium },
  run_background: { action: ACTION.cmdBackground, risk: RISK.medium },
  write_stdin: { action: ACTION.cmdBackground, risk: RISK.medium },
  kill_shell: { action: ACTION.cmdBackground, risk: RISK.low },
  write: { action: ACTION.fileWrite, risk: RISK.low },
  edit: { action: ACTION.fileWrite, risk: RISK.low },
  ego_browser: { action: ACTION.netFetch, risk: RISK.medium },
  web_fetch: { action: ACTION.netFetch, risk: RISK.low },
  web_search: { action: ACTION.netFetch, risk: RISK.low },
  send_image: { action: ACTION.netSend, risk: RISK.high },
  message_bot: { action: ACTION.netSend, risk: RISK.medium },
  reply_bot: { action: ACTION.netSend, risk: RISK.medium },
  announce: { action: ACTION.netSend, risk: RISK.medium },
  dispatch_to_department: { action: ACTION.netSend, risk: RISK.medium },
  add_mcp_server: { action: ACTION.mcpAdd, risk: RISK.critical },
  stage_site: { action: ACTION.fileWrite, risk: RISK.medium },
  commit_site: { action: ACTION.netSend, risk: RISK.high },
  discard_site: { action: ACTION.fileDelete, risk: RISK.medium },
});

/**
 * 建一个网关。
 *
 * @param {object} p
 * @param {object} p.store 应用 store（授权记录与审计写在这里）
 * @param {()=>string} p.currentPolicyRevision 当前策略版本
 * @param {()=>string|null} [p.currentGeneration] 当前实例世代（不传则不校验）
 * @param {Function} [p.log]
 */
export function createGrantGate({
  store,
  currentPolicyRevision,
  currentGeneration = () => null,
  log: logFn = log,
} = {}) {
  if (!store) throw new Error('网关需要 store');

  const grants = () => {
    if (!Array.isArray(store.state.grants)) store.state.grants = [];
    return store.state.grants;
  };
  const audits = () => {
    if (!Array.isArray(store.state.grantAudit)) store.state.grantAudit = [];
    return store.state.grantAudit;
  };

  const lookup = (id) => {
    const n = lookupRaw(id);
    return n ? n : null;
  };
  /** 取原始授权并规范化（带上持久的使用次数）。 */
  const lookupRaw = (id) => {
    const raw = grants().find((g) => g.id === id) ?? null;
    if (!raw) return null;
    const n = normalizeGrant(raw);
    return n.ok ? Object.freeze({ ...n.grant, usedUses: Number(raw.usedUses) || 0 }) : null;
  };

  /**
   * 记一条审计。
   *
   * 规格 §5.5：记录授权引用、发起者、实际执行角色、目标摘要、结果。
   * 这里**只记摘要**，不记原始参数 —— 参数可能是密码或私钥。
   */
  function audit({ grantId = null, subject = null, action, targets = [], result, code = '', detail = '', risk = null }) {
    const list = audits();
    list.push({
      id: randomUUID(),
      at: Date.now(),
      grantId,
      botId: subject?.botId ?? null,
      role: subject?.role ?? '',
      action,
      risk,
      targets: (targets ?? []).map((t) => (t ? `${t.kind}:${t.ref}` : '')).filter(Boolean).slice(0, 20),
      result: result ? 'allow' : 'deny',
      code,
      detail: String(detail ?? '').slice(0, 300),
    });
    if (list.length > MAX_AUDIT) list.splice(0, list.length - MAX_AUDIT);
    try {
      store.scheduleSave?.();
    } catch { /* 审计写不进去不该挡住主流程，但下面会返回结果 */ }
    return list[list.length - 1];
  }

  /**
   * 判定一次动作。
   *
   * @param {object} p
   * @param {{botId:string, role?:string, instanceId?:string}} p.subject 谁在做
   * @param {string} p.action 见 grants.js 的 ACTION
   * @param {Array<{kind:string, ref:string}>} [p.targets] 目标资源
   * @param {object} [p.params] 动作参数（供约束判定；不落审计）
   * @param {string} [p.mode] 本次动作的执行模式
   * @param {string|null} [p.taskId] 属于哪个任务（受管执行时传）
   * @param {string|null} [p.grantId] 指定用哪条授权（不传则自动挑）
   * @returns {{ok:true, grant:object, audit:object}|{ok:false, code:string, text:string, audit?:object}}
   */
  function check({ subject, action, targets = [], params = {}, mode = null, taskId = null, grantId = null } = {}) {
    const now = Date.now();
    const risk = TOOL_ACTIONS[action]?.risk ?? null;
    const cleanTargets = (Array.isArray(targets) ? targets : []).map(normalizeResource).filter(Boolean);

    if (!subject?.botId) {
      const a = audit({ subject, action, targets: cleanTargets, result: false, code: DENY.invalid, detail: '缺少主体' });
      return { ok: false, code: DENY.invalid, text: '动作必须绑定到具体 Bot', audit: a };
    }

    const policyRevision = typeof currentPolicyRevision === 'function' ? currentPolicyRevision() : null;
    const generation = typeof currentGeneration === 'function' ? currentGeneration() : null;

    // ---- 1) 候选授权：指定了就只看那一条
    let candidates;
    if (grantId) {
      const one = lookupRaw(grantId);
      if (!one) {
        const a = audit({ grantId, subject, action, targets: cleanTargets, result: false, code: DENY.noGrant, detail: `找不到授权 ${grantId}` });
        return { ok: false, code: DENY.noGrant, text: `找不到授权 ${grantId}`, audit: a };
      }
      if (one.subject.botId !== subject.botId) {
        const a = audit({ grantId, subject, action, targets: cleanTargets, result: false, code: DENY.resourceNotCovered, detail: '授权不属于这个主体' });
        return { ok: false, code: DENY.resourceNotCovered, text: '这条授权不属于你', audit: a };
      }
      candidates = [one];
    } else {
      candidates = grants()
        .filter((g) => g && g.subject?.botId === subject.botId)
        .map((g) => {
          const n = normalizeGrant(g);
          // ★ 用次数是**状态**，不在纯逻辑的规范化里（那边只认记录本身）。
          //   这里把它挂回去，否则 maxUses 永远是 0 次，额度用完了还能继续用。
          return n.ok ? Object.freeze({ ...n.grant, usedUses: Number(g.usedUses) || 0 }) : null;
        })
        .filter(Boolean)
        .filter((g) => g.actions.includes(action))
        // 同一个任务优先用任务级授权；没指定任务时也接受全局授权
        .filter((g) => !taskId || !g.taskId || g.taskId === taskId)
        .filter((g) => !mode || g.mode === mode);
    }

    if (!candidates.length) {
      const a = audit({ subject, action, targets: cleanTargets, result: false, code: DENY.noGrant, risk });
      return { ok: false, code: DENY.noGrant, text: `没有覆盖「${action}」的有效授权`, audit: a };
    }

    // ---- 2) 逐条判：任何一条通过即放行（多条授权可以互补）
    const failures = [];
    for (const grant of candidates) {
      const valid = checkGrantValidity({ grant, now, policyRevision, generation, usedUses: grant.usedUses ?? 0 });
      if (!valid.ok) { failures.push(valid); continue; }

      const chain = checkChain({ grant, lookup, now, policyRevision, generation });
      if (!chain.ok) { failures.push(chain); continue; }

      const covers = grantCovers({ grant, action, targets: cleanTargets, params });
      if (!covers.ok) { failures.push(covers); continue; }

      const a = audit({ grantId: grant.id, subject, action, targets: cleanTargets, result: true, risk });
      return { ok: true, grant, audit: a };
    }

    // 全部失败：报第一条最具体的原因（先看"缺动作/缺资源"，再看有效性）
    const preferred = failures.find((f) => f.code === DENY.actionNotCovered || f.code === DENY.resourceNotCovered)
      ?? failures.find((f) => f.code === DENY.constraintFailed)
      ?? failures[0]
      ?? { ok: false, code: DENY.noGrant, text: '没有可用授权' };
    const a = audit({
      subject, action, targets: cleanTargets, result: false,
      code: preferred.code, detail: preferred.text, risk,
    });
    return { ok: false, code: preferred.code, text: preferred.text, audit: a };
  }

  /** 这条动作在网关上要不要判（工具名映射）。 */
  function actionForTool(toolName) {
    return TOOL_ACTIONS[String(toolName ?? '')] ?? null;
  }

  /** 从工具入参里推断目标资源（只认确定能推断的字段）。 */
  function targetsForTool(toolName, input = {}) {
    const pick = (k) => (typeof input?.[k] === 'string' ? input[k] : '');
    const path = pick('path') || pick('file_path') || pick('filePath');
    if (path) return [{ kind: 'path', ref: path }];
    if (toolName === 'web_fetch' || toolName === 'egp_browser') {
      const url = pick('url');
      if (url) {
        try {
          const host = new URL(url).hostname;
          if (host) return [{ kind: 'host', ref: host }];
        } catch { /* 不是合法 URL 就不给目标，交给适配器自己判 */ }
      }
    }
    return [];
  }

  /**
   * 消费一次授权（`maxUses` 计数）。
   *
   * 必须在**动作真的执行之后**调用，不能在执行前扣 ——
   * 执行前扣会让"执行失败"也吃掉一次额度，用户看到的额度会凭空少。
   */
  function consume(grantId) {
    const raw = grants().find((g) => g.id === grantId);
    if (!raw) return null;
    raw.usedUses = (Number(raw.usedUses) || 0) + 1;
    raw.lastUsedAt = Date.now();
    try { store.scheduleSave?.(); } catch { /* 见上 */ }
    return raw.usedUses;
  }

  /**
   * 新增一条授权。**只有用户交互 / 已保存规则 / 迁移兼容**能建根授权；
   * 模型与其他 Bot 只能通过 `derive()` 派生子集。
   */
  function add(spec) {
    const built = normalizeGrant({
      ...spec,
      id: spec?.id ?? `gr_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      createdAt: spec?.createdAt ?? Date.now(),
    });
    if (!built.ok) return built;
    const list = grants();
    if (list.some((g) => g.id === built.grant.id)) {
      return { ok: false, code: 'duplicate_id', text: `授权 ${built.grant.id} 已存在` };
    }
    list.push({ ...built.grant, usedUses: 0 });
    if (list.length > MAX_GRANTS) list.splice(0, list.length - MAX_GRANTS);
    try { store.scheduleSave?.(); } catch { /* 见上 */ }
    logFn(`🔑 新增授权 ${describeGrant(built.grant)}`);
    return { ok: true, grant: built.grant };
  }

  /** 撤销（级联：下游立刻失效，因为父链里有撤销记录）。 */
  function revoke(grantId, reason = '') {
    const raw = grants().find((g) => g.id === grantId);
    if (!raw) return { ok: false, code: DENY.noGrant, text: `找不到授权 ${grantId}` };
    if (raw.revokedAt) return { ok: true, alreadyRevoked: true };
    raw.revokedAt = Date.now();
    raw.revokedReason = String(reason).slice(0, 200);
    try { store.scheduleSave?.(); } catch { /* 见上 */ }
    // 级联：把下游标成"父链失效"，这样即使有人直接按 id 取用也过不去
    const downstream = [];
    for (const g of grants()) {
      if (g.parentId === grantId && !g.revokedAt) {
        g.revokedAt = raw.revokedAt;
        g.revokedReason = `父授权 ${grantId} 已撤销`;
        downstream.push(g.id);
      }
    }
    logFn(`🔒 撤销授权 ${grantId}${downstream.length ? `（连带 ${downstream.length} 条子授权）` : ''}`);
    return { ok: true, revoked: grantId, downstream };
  }

  /** 当前有效授权（界面/审计用）。 */
  function list({ botId = null, includeRevoked = false } = {}) {
    const now = Date.now();
    return grants()
      .filter((g) => (!botId || g.subject?.botId === botId))
      .filter((g) => includeRevoked || !g.revokedAt)
      .filter((g) => includeRevoked || g.expiresAt === null || g.expiresAt > now)
      .map((g) => {
        const n = normalizeGrant(g);
        return n.ok ? { ...n.grant, usedUses: g.usedUses ?? 0 } : null;
      })
      .filter(Boolean);
  }

  /** 最近审计（界面/排查用）。 */
  function recentAudit({ limit = 100, botId = null, onlyDenied = false } = {}) {
    return audits()
      .filter((a) => (!botId || a.botId === botId))
      .filter((a) => !onlyDenied || a.result === 'deny')
      .slice(-Math.max(1, Math.min(Number(limit) || 100, MAX_AUDIT)))
      .reverse();
  }

  return { check, consume, add, revoke, list, recentAudit, actionForTool, targetsForTool, lookup };
}

/**
 * 迁移兼容：把升级前那份全局 policy 记成一条根授权。
 *
 * 规格 §11：「隔离旧规则与新策略版本，切换时停止/核对旧后台进程，
 * 不让旧批准迁移成更宽的新批准」。
 *
 * 所以这条授权的范围**写死成 policy 现在已经允许的**，不多一分：
 *   · `dangerous: 'allow'` → 命令/文件写都给，但仍受 denyCommands 约束
 *   · `dangerous: 'ask'`   → 一样给（ask 的拦截在审批层，不在授权层）
 *   · `dangerous: 'deny'`  → 什么动手能力都不给
 *
 * 幂等：已经存在 `source: legacy-policy` 且属于该 bot 的授权就不再建第二条。
 *
 * 为什么要**每个 bot 一条**而不是一条共享：规格 §6.1 要求授权绑定到具体主体。
 * 造一条「谁都能用」的全局授权，就是把“角色名当授权用”换了个写法 ——
 * 以后要单独收回某个 bot 的权限时，根本没有可撤销的对象。
 *
 * @param {object} p
 * @param {object} p.store
 * @param {object} p.policy
 * @param {string} p.policyRevision
 * @param {string[]} p.botIds 要为他建迁移授权的 bot（通常是启动时的全部 bot）
 * @param {string} [p.chiefBotId] 主 Bot（给它标 role=main，模式是 host）
 * @returns {{created: string[], existing: string[]}}
 */
export function ensureLegacyGrant({ store, policy, policyRevision, botIds = [], chiefBotId = null } = {}) {
  if (!store || !Array.isArray(botIds) || !botIds.length) return { created: [], existing: [] };
  if (!Array.isArray(store.state.grants)) store.state.grants = [];

  const readonly = policy?.dangerous === 'deny';
  const actions = readonly
    ? [ACTION.fileRead]
    : [
        ACTION.fileRead, ACTION.fileWrite, ACTION.fileDelete,
        ACTION.cmdExec, ACTION.cmdBackground,
        ACTION.gitRead, ACTION.gitCommit,
        ACTION.netFetch, ACTION.netSend,
      ];
  const revision = policyRevision ? String(policyRevision).slice(0, 8) : 'v0';

  const created = [];
  const existing = [];
  for (const botId of botIds) {
    if (!botId) continue;
    const hit = store.state.grants.find((g) => g.source === SOURCE.legacyPolicy && g.subject?.botId === botId);
    if (hit) { existing.push(hit.id); continue; }
    const grant = {
      id: `gr_legacy_${String(botId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20)}_${revision}`,
      source: SOURCE.legacyPolicy,
      sourceRef: '升级前的全局 policy（迁移兼容，范围等于当时的允许口径）',
      subject: {
        botId,
        role: botId === chiefBotId ? 'main' : '',
        instanceId: '',
      },
      taskId: null,
      parentId: null,
      actions,
      // 资源不设限：升级前的 policy 就是全局的。收紧要靠用户新建授权 + 撤销这条。
      resources: [],
      constraints: {},
      risk: RISK.medium,
      mode: botId === chiefBotId ? MODE.host : MODE.project,
      policyRevision: policyRevision ? String(policyRevision) : null,
      generation: null,
      // ★ 不能再转授：迁移来的授权只是“保持升级前的行为”，不是新增的授权能力。
      canDelegate: false,
      maxUses: null,
      createdAt: Date.now(),
      expiresAt: null,
      revokedAt: null,
    };
    const built = normalizeGrant(grant);
    if (!built.ok) continue;
    store.state.grants.push({ ...built.grant, usedUses: 0 });
    created.push(grant.id);
  }
  if (created.length) {
    try { store.scheduleSave?.(); } catch { /* 见上 */ }
  }
  return { created, existing };
}
