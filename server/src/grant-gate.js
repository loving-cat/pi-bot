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
  DENY,
  checkChain, checkGrantValidity, grantCovers, normalizeGrant, normalizeResource, describeGrant,
} from './grants.js';
import {
  TOOLS, actionForTool as catalogActionForTool, riskOf, needsTarget,
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

  /**
   * 按 id 取一条授权。
   *
   * ★ 同 id 有多条时，**优先返回活着的那条**。
   *
   *   历史数据里真出现过同 id 两条（旧版 id 不随规矩变 + 兜底补登记重复插入）。
   *   原来的 `find` 只拿第一条，而第一条往往是那条已撤销的 —— 于是
   *   “按 id 取用”永远失败，用户看到的是“我明明有这条授权”。
   *   写入侧已经改成不再产生重复（id 带规矩摘要、用户收回的不再补登记），
   *   但读的一侧也必须对老数据成立。
   */
  const lookupRaw = (id) => {
    const same = grants().filter((g) => g && g.id === id);
    if (!same.length) return null;
    const raw = same.find((g) => !g.revokedAt) ?? same[0];
    const n = normalizeGrant(raw);
    return n.ok ? Object.freeze({ ...n.grant, usedUses: Number(raw.usedUses) || 0 }) : null;
  };
  const lookup = (id) => lookupRaw(id);

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
   * 挑出「可能有资格覆盖这次动作」的候选授权。
   *
   * 只做筛选，不做最终判定 —— 有效性/父链/覆盖那一串在 `verdictFor` 里。
   * 分两步是为了让 `check` 读起来是"拿候选 → 逐条判 → 汇总失败原因"。
   *
   * @returns {{ok:true, list:object[]}|{ok:false, code:string, text:string}}
   */
  function candidatesFor({ subject, action, taskId, mode, grantId }) {
    if (grantId) {
      const one = lookupRaw(grantId);
      if (!one) return { ok: false, code: DENY.noGrant, text: `找不到授权 ${grantId}` };
      if (one.subject.botId !== subject.botId) {
        return { ok: false, code: DENY.resourceNotCovered, text: '这条授权不属于你' };
      }
      return { ok: true, list: [one] };
    }
    const list = grants()
      .filter((g) => g && g.subject?.botId === subject.botId)
      .map((g) => {
        const n = normalizeGrant(g);
        // ★ 用次数是**状态**，不在纯逻辑的规范化里（那边只认记录本身）。
        //   这里把它挂回去，否则 maxUses 永远是 0 次，额度用完了还能继续用。
        return n.ok ? Object.freeze({ ...n.grant, usedUses: Number(g.usedUses) || 0 }) : null;
      })
      .filter(Boolean)
      // ★ 这里**不**按动作预筛。
      //
      //   预筛会让“为什么不行”变得说不清：规矩变更会撤旧发新，同一个 bot
      //   手上常同时有一条「已撤销的宽授权」和一条「有效的窄授权」。
      //   按动作预筛会先扔掉窄的那条（它不含这个动作），只剩已撤销的那条，
      //   于是用户看到的是「授权已被撤销」——听上去像权限全没了，
      //   实际只是新的那条不含这个动作。判断“覆不覆盖”只该有一个地方
      //   （`grantCovers`），预筛等于把判定拆成两处。
      // 同一个任务优先用任务级授权；没指定任务时也接受全局授权
      .filter((g) => !taskId || !g.taskId || g.taskId === taskId)
      .filter((g) => !mode || g.mode === mode);
    return { ok: true, list };
  }

  /**
   * 判一条授权能不能覆盖这次动作（有效性 → 父链 → 覆盖 → 目标可核）。
   *
   * 顺序有意义：先排除失效的（省钱、错误信息也更准），再看范围。
   */
  function verdictFor(grant, { action, targets, params, now, policyRevision, generation }) {
    const valid = checkGrantValidity({ grant, now, policyRevision, generation, usedUses: grant.usedUses ?? 0 });
    if (!valid.ok) return valid;

    const chain = checkChain({ grant, lookup, now, policyRevision, generation });
    if (!chain.ok) return chain;

    const covers = grantCovers({ grant, action, targets, params });
    if (!covers.ok) return covers;

    // ★ 窄范围授权 + 认不出目标 = 拒绝（fail-closed）。
    //
    //   规格 §6.1：资源范围是**真边界**，不是装饰。授权写了"只许动 /proj/alpha"，
    //   而这次动作的目标推不出来（命令里的路径、脚本里的 URL），
    //   如果当成"没有目标"放行，那范围就等于没写 —— 实测就是这么漏的。
    //   不是窄范围授权（resources 为空）不受影响，它本来就没限范围。
    if (!targets.length && grant.resources.length && needsTarget(action)) {
      return {
        ok: false,
        code: DENY.resourceNotCovered,
        text: `这条授权限定了范围，但「${action}」这次的目标认不出来（入参里没有可核对的资源），无法确认在范围内`,
      };
    }
    return { ok: true };
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

    const picked = candidatesFor({ subject, action, taskId, mode, grantId });
    if (!picked.ok) {
      const a = audit({
        grantId, subject, action, targets: cleanTargets,
        result: false, code: picked.code, detail: picked.text, risk,
      });
      return { ok: false, code: picked.code, text: picked.text, audit: a };
    }
    if (!picked.list.length) {
      const a = audit({ subject, action, targets: cleanTargets, result: false, code: DENY.noGrant, risk });
      return { ok: false, code: DENY.noGrant, text: `没有覆盖「${action}」的有效授权`, audit: a };
    }

    // 多条授权可以互补：任何一条通过就放行
    /** @type {Array<{grant:object, verdict:object}>} */
    const failures = [];
    for (const grant of picked.list) {
      const verdict = verdictFor(grant, { action, targets: cleanTargets, params, now, policyRevision, generation });
      if (!verdict.ok) { failures.push({ grant, verdict }); continue; }
      const a = audit({ grantId: grant.id, subject, action, targets: cleanTargets, result: true, risk });
      return { ok: true, grant, audit: a };
    }

    // 全部失败：挑一条最说得清的原因。
    //
    // 顺序：缺动作/缺资源 → 参数约束 → **活着的授权**给出的原因 → 最早那条。
    //
    // ★ 中间那一档是实测出来的必要：规矩变更会撤旧发新，于是同一个 bot
    //   手上常常同时有一条「已撤销的宽授权」和一条「有效的窄授权」。
    //   用户问"为什么不能写文件"，报「授权已被撤销」会让人以为权限全丢了，
    //   实际只是新的那条不含写。所以优先报活着的那条的结论。
    const live = failures.filter((f) => !f.grant.revokedAt);
    const preferred = failures.find((f) => f.verdict.code === DENY.actionNotCovered || f.verdict.code === DENY.resourceNotCovered)
      ?? failures.find((f) => f.verdict.code === DENY.constraintFailed)
      ?? live[0]
      ?? failures[0];
    const preferredVerdict = preferred?.verdict ?? { ok: false, code: DENY.noGrant, text: '没有可用授权' };
    const a = audit({
      subject, action, targets: cleanTargets, result: false,
      code: preferredVerdict.code, detail: preferredVerdict.text, risk,
    });
    return { ok: false, code: preferredVerdict.code, text: preferredVerdict.text, audit: a };
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
  /** 当前实例世代（只读，给界面对账用：任务级授权跨重启就失效）。 */
  function currentGenerationId() {
    return typeof currentGeneration === 'function' ? (currentGeneration() ?? null) : (currentGeneration ?? null);
  }

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
    const raw = grants().filter((g) => g && g.id === grantId).find((g) => !g.revokedAt)
      ?? grants().find((g) => g && g.id === grantId);
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
    // ★ **只有任务级授权才盖世代**（2026-11-16 修正）。
    //
    //   规格 §6.3 要防的是"上个进程批准的后台任务，重启后继续跑"——
    //   那说的是**任务级**授权（带 `taskId`）。
    //
    //   以前这里给**所有**新授权都盖上当前世代，后果是：用户批过的长期授权
    //   （项目授权、首启页那条、迁移授权）每重启一次就全部 `generation_stale`。
    //   用户看到的原话是"授权属于旧世代" —— 而他明明批过、也没收回。
    //
    //   现在的规则：
    //   · 带 `taskId` 的（这次任务临时给的）→ 盖世代，重启即失效（符合 §6.3）；
    //   · 其余（用户/规矩立的长期授权）→ **不盖**，活到你撤销或到期为止。
    const stamp = typeof currentGeneration === 'function' ? currentGeneration() : currentGeneration;
    const taskScoped = Boolean(spec?.taskId);
    const built = normalizeGrant({
      ...spec,
      generation: spec?.generation === undefined ? (taskScoped ? stamp ?? null : null) : spec.generation,
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

  /**
   * 撤销（级联：下游立刻失效，因为父链里有撤销记录）。
   *
   * ★ `by` 决定这条撤销**会不会被自动补登记覆盖**：
   *   · `user`   —— 用户在界面上收回。**不能再自动发回来**，否则"收回"是假的。
   *   · `policy` —— 规矩变了所以作废，会按新规矩重发（这是正常的规重发）。
   *   · `parent` —— 父授权撤销连带。
   */
  function revoke(grantId, reason = '', { by = 'user' } = {}) {
    // 同 id 多条时挑活着的那条（见 lookupRaw 的说明）
    const raw = grants().filter((g) => g && g.id === grantId).find((g) => !g.revokedAt)
      ?? grants().find((g) => g && g.id === grantId);
    if (!raw) return { ok: false, code: DENY.noGrant, text: `找不到授权 ${grantId}` };
    if (raw.revokedAt) return { ok: true, alreadyRevoked: true };
    raw.revokedAt = Date.now();
    raw.revokedReason = String(reason).slice(0, 200);
    raw.revokedBy = ['user', 'policy', 'parent'].includes(by) ? by : 'user';
    try { store.scheduleSave?.(); } catch { /* 见上 */ }
    // 级联：把下游标成"父链失效"，这样即使有人直接按 id 取用也过不去
    const downstream = [];
    for (const g of grants()) {
      if (g.parentId === grantId && !g.revokedAt) {
        g.revokedAt = raw.revokedAt;
        g.revokedReason = `父授权 ${grantId} 已撤销`;
        g.revokedBy = 'parent';
        downstream.push(g.id);
      }
    }
    logFn(`🔒 撤销授权 ${grantId}${downstream.length ? `（连带 ${downstream.length} 条子授权）` : ''}`);
    return { ok: true, revoked: grantId, downstream };
  }

  /**
   * 补登记的实现可以后装（`setSyncGrants`）。
   *
   * 为什么需要后装：生产里 `server-main` 建网关时就能把
   * `ensureLegacyGrant` 传进来；但测试和各种装配顺序下，网关可能先建、
   * 补登记的实现后到位。留一个 setter 比强迫所有调用方按特定顺序装配简单。
   */
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
  let startedListener = null;

  function start() {
    if (startedListener || !busSource || typeof busSource.on !== 'function' || !syncGrantsFn) return;
    startedListener = (ev) => {
      if (ev?.t !== 'bot.updated') return;
      const id = ev?.bot?.id;
      if (id) ensureForBots([id]);
    };
    busSource.on('event', startedListener);
  }

  function stop() {
    if (!startedListener || !busSource?.off) return;
    busSource.off('event', startedListener);
    startedListener = null;
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
    currentGeneration: currentGenerationId,
    ensureForBots, start, stop, setSyncGrants,
  };
}
