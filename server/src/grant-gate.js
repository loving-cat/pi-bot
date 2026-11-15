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
import {
  ACTIONS, TOOLS, actionForTool as catalogActionForTool, riskOf, needsTarget,
  targetsForTool as catalogTargetsForTool,
} from './action-catalog.js';

/** 审计里保留的最近条数（超出后落盘裁剪）。 */
const MAX_AUDIT = 500;

/** 授权记录保留上限。 */
const MAX_GRANTS = 500;

/**
 * 工具 → 动作的覆盖面表（网关的可见范围本身）。
 *
 * 定义搬到了 `action-catalog.js` —— 那里还同时管着风险档、可撤销性、
 * 目标认法，三件相关的事放一处才不会各写各的。
 *
 * 这里只做**兼容转出**：老调用方和测试 `import { TOOL_ACTIONS }` 仍然能用。
 * 内容与 `TOOLS` 同源，改一处两边都变，不可能漂移。
 */
export const TOOL_ACTIONS = Object.freeze(
  Object.fromEntries(Object.entries(TOOLS).map(([tool, action]) => [tool, { action, risk: riskOf(action) }])),
);

/**
 * 建一个网关。
 *
 * @param {object} p
 * @param {object} p.store 应用 store（授权记录与审计写在这里）
 * @param {()=>string} p.currentPolicyRevision 当前策略版本
 * @param {()=>string|null} [p.currentGeneration] 当前实例世代（不传则不校验）
 * @param {(p:{botIds:string[]})=>{created:string[], existing:string[], revoked:string[]}} [p.syncGrants]
 *   把“现在该有迁移授权却没有”的 bot 补上（多退少补）。
 *
 *   为什么要这一步：`ensureLegacyGrant` 只在启动时跑一次，而 bot 是**运行期**
 *   造出来的 —— 用户在 App 里 `create_bot` / 建部门 / 用模板开部门，都会
 *   新增 bot。那些 bot 从来没经过启动那一步，于是它们在网关上就是
 *   “没有任何授权”：写文件、跑命令全被 no_grant 拦下，而界面上一片正常。
 *   迁就办法只能是重启服务端 —— 这不该是用户的日常操作。
 *
 *   所以网关挂上“新增/改动的 bot”事件，给还没登记的 bot 补一条。
 *   没有这一步，网关就是“重启之前新同事干不了活”。
 * @param {object} [p.bus] 事件总线（默认不订阅，测试里显式传）
 * @param {Function} [p.log]
 */
export function createGrantGate({
  store,
  currentPolicyRevision,
  currentGeneration = () => null,
  syncGrants = null,
  bus: busSource = null,
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
    // ★ 风险档按**动作**查。
    //
    //   原来这里拿动作名去查按工具名建的表（`TOOL_ACTIONS[action]`），
    //   键对不上，于是审计里的 risk 永远是 null —— 界面上看不出哪次动作危险。
    //   现在唯一来源是 action-catalog 的 ACTIONS，同一动作不再随工具各记一档。
    const risk = riskOf(action);
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

      // ★ 窄范围授权 + 认不出目标 = 拒绝（fail-closed）。
      //
      //   规格 §6.1：资源范围是**真边界**，不是装饰。授权写了"只许动 /proj/alpha"，
      //   而这次动作的目标推不出来（命令里的路径、脚本里的 URL），
      //   如果当成"没有目标"放行，那范围就等于没写 —— 实测就是这么漏的。
      //   不是窄范围授权（resources 为空）不受影响，它本来就没限范围。
      if (!cleanTargets.length && grant.resources.length && needsTarget(action)) {
        failures.push({
          ok: false,
          code: DENY.resourceNotCovered,
          text: `这条授权限定了范围，但「${action}」这次的目标认不出来（入参里没有可核对的资源），无法确认在范围内`,
        });
        continue;
      }

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

  /** 这条动作在网关上要不要判（工具名映射）。实现在 action-catalog。 */
  function actionForTool(toolName) {
    return catalogActionForTool(toolName);
  }

  /**
   * 从工具入参里推断目标资源。实现在 action-catalog 的规则表里。
   *
   * 保留这个方法名是为了不动 policy-hook 那条调用链；
   * 认法（读哪个字段）不再散在这里，加工具时改一处就够。
   */
  function targetsForTool(toolName, input = {}) {
    return catalogTargetsForTool(toolName, input);
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
    // ★ 调用方没写世代时，按**当前世代**落盘。
    //
    //   规格 §6.3：后台任务不得续接旧权限，重启后旧授权作废。
    //   但这条得两边都写才有意义：如果签发时不写、校验时又拿着世代去比，
    //   结果是“刚连出来的授权永远是空的”。这里不写就填现状，
    //   让每条新授权都带上“它属于哪个进程”。
    const stamp = typeof currentGeneration === 'function' ? currentGeneration() : currentGeneration;
    const built = normalizeGrant({
      ...spec,
      generation: spec?.generation === undefined ? stamp ?? null : spec.generation,
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

  let syncGrantsFn = syncGrants;
  function setSyncGrants(fn) {
    syncGrantsFn = typeof fn === 'function' ? fn : null;
  }
  /**
   * 把“应该有迁移授权但没有”的 bot 补上。
   *
   * 幂等：已经有当前规矩下合法授权的不动。重复调用不会长出一堆记录。
   * 失败不抛：补登记不应该把建 bot 的主流程搞红，但会记一行日志，
   * 而且下一次 check 仍然是 fail-closed（没授权就拒）——
   * “漏登记”不该静默变成“放行”。
   */
  function ensureForBots(botIds = []) {
    if (typeof syncGrantsFn !== 'function') return null;
    try {
      const out = syncGrantsFn({ botIds: (botIds ?? []).filter(Boolean) });
      if (out?.created?.length) {
        logFn(`🔑 给 ${out.created.length} 个新 bot 补上迁移授权（否则它们一上来就没有任何权限）`);
      }
      return out;
    } catch (err) {
      logFn('补登记迁移授权失败（网关仍 fail-closed）：', err?.message || err);
      return null;
    }
  }

  /**
   * 事件驱动：新建 bot 后立刻补登记。
   *
   * 只认 `bot.updated`：store.createBot 会发它，updateBot 也会 ——
   * 重复调用由 ensureForBots 自己幂等兑掉。不订 room/template 事件是因为
   * 它们最后都会落到 createBot 上，订一处就够。
   */
  function start() {
    if (!busSource || typeof busSource.on !== 'function' || !syncGrantsFn) return;
    busSource.on('event', (ev) => {
      if (ev?.t !== 'bot.updated') return;
      const id = ev?.bot?.id;
      if (id) ensureForBots([id]);
    });
  }

  // 直接把 check 包一层：切面太多，统一入口最不容易漏。
  function checkAndCatchUp(args) {
    const botId = args?.subject?.botId;
    if (!botId) return check(args);
    const hasAny = grants().some((g) => g && g.subject?.botId === botId && !g.revokedAt);
    if (!hasAny) ensureForBots([botId]);
    return check(args);
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

  return {
    check: checkAndCatchUp,
    consume, add, revoke, list, recentAudit, actionForTool, targetsForTool, lookup,
    ensureForBots, start, setSyncGrants,
  };
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
 *   · `dangerous: 'deny'`  → 只给读（含桌面观察），动手能力一个都不给
 *
 * ## 主 Bot 还要额外给的两项（只给主 Bot）
 *
 *   · `desktop.observe` —— 观察层（P0-3a）早在网关之前就上线了。
 *     不给它，升级到带网关的版本之后 `desktop_observe` 会直接 no_grant 报错：
 *     一个本来只是“只读看屏幕”的能力被静默关掉，用户看到的是“功能坏了”。
 *     规格 §5.3 也是这个口径：普通桌面输入/观察默认只给主 Bot。
 *   · `git.push` —— `git_push` 自己会要求手机确认票据（见 git-tools），
 *     这里放行的是“允许走这条路”；真正推之前还要过确认框架。
 *     不给它的话主 Bot 连**发起**一次 push 请求都做不到。
 *
 * 这两项都**只给主 Bot**：其他 Bot 是 project 模式，桌面和 push 都不该有。
 * 而且都在确认/观察层有各自的二次门（截图只截目标窗口、push 要手机批准）。
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
export function ensureLegacyGrant({ store, policy, policyRevision, botIds = [], chiefBotId = null, generation = null } = {}) {
  if (!store || !Array.isArray(botIds) || !botIds.length) return { created: [], existing: [], revoked: [] };
  if (!Array.isArray(store.state.grants)) store.state.grants = [];

  const readonly = policy?.dangerous === 'deny';
  const actions = readonly
    ? [ACTION.fileRead, ACTION.desktopObserve]
    : [
        ACTION.fileRead, ACTION.fileWrite, ACTION.fileDelete,
        ACTION.cmdExec, ACTION.cmdBackground,
        ACTION.gitRead, ACTION.gitCommit,
        ACTION.netFetch, ACTION.netSend,
        ACTION.desktopObserve, ACTION.gitPush,
      ];
  const revision = policyRevision ? String(policyRevision).slice(0, 8) : 'v0';

  const created = [];
  const existing = [];
  const revoked = [];
  for (const botId of botIds) {
    if (!botId) continue;
    const stale = store.state.grants.filter(
      (g) => g.source === SOURCE.legacyPolicy && g.subject?.botId === botId,
    );
    const fresh = stale.find((g) => !g.revokedAt && g.policyRevision === (policyRevision ? String(policyRevision) : null));
    if (fresh) { existing.push(fresh.id); continue; }

    // ★ 规矩变过 → 旧的迁移授权必须撤掉重发，不能留着。
    //
    //   留着会怎样（实测）：网关发现 policyRevision 对不上，一律 policy_changed，
    //   于是用户把危险动作改成「只读」之后，**连读文件都被拒** ——
    //   因为那条授权描述的是一套已经不存在了的规矩。
    //
    //   为什么可以重发成「更宽」：这条规矩变更是**已认证用户在 App 里改的**，
    //   符合规格 §6.1「授权根只能来自已认证用户交互」。重发只是把那次交互
    //   如实记成一条新授权，不是模型自己扩权。
    for (const old of stale) {
      if (old.revokedAt) continue;
      old.revokedAt = Date.now();
      old.revokedReason = `规矩已改为 ${revision}，这条按旧规矩重发`;
      revoked.push(old.id);
    }

    // 只给主 Bot 的那两项：桌面观察与 push。
    //
    // 桌面相关的两个工具在 role-tools 里本来就是 CHIEF_ONLY_TOOLS，
    // 这里再收一道是为了让授权记录**自己**说得清（不然审计里会看到
    // “某个 project 模式的 bot 有一条 desktop.observe 授权”——很吓人且没用）。
    const isChief = botId === chiefBotId;
    const ownActions = isChief
      ? actions
      : actions.filter((a) => a !== ACTION.desktopObserve && a !== ACTION.gitPush);

    const grant = {
      id: `gr_legacy_${String(botId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20)}_${revision}`,
      source: SOURCE.legacyPolicy,
      sourceRef: '升级前的全局 policy（迁移兼容，范围等于当时的允许口径）',
      subject: {
        botId,
        role: isChief ? 'main' : '',
        instanceId: '',
      },
      taskId: null,
      parentId: null,
      actions: ownActions,
      // 资源不设限：升级前的 policy 就是全局的。收紧要靠用户新建授权 + 撤销这条。
      resources: [],
      constraints: {},
      risk: RISK.medium,
      mode: isChief ? MODE.host : MODE.project,
      policyRevision: policyRevision ? String(policyRevision) : null,
      // 实例世代：记下“这条授权是哪个进程发的”。重启后网关拿新世代一比就作废
      // （规格 §6.3 后台任务不得续接旧权限）。签发时不写、校验时却比，
      // 会让重启后的旧授权被当成合法——两边都得有值。
      generation: generation ? String(generation) : null,
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
  if (created.length || revoked.length) {
    try { store.scheduleSave?.(); } catch { /* 见上 */ }
  }
  return { created, existing, revoked };
}
