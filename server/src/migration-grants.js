/**
 * 迁移兼容授权：把升级前那份全局 policy 如实记成每个 bot 一条根授权。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §11：「隔离旧规则与新策略版本，
 * 切换时停止/核对旧后台进程，不让旧批准迁移成更宽的新批准」。
 *
 * ## 为什么单独一个文件
 *
 * 网关（`grant-gate.js`）回答"这次动作允不允许"，这里回答的是一件完全不同的事：
 * **网关上线的那一刻，怎么才算"和上线前一模一样"**。
 *
 * 两者放在一起会互相污染：网关的判定要保持极简（纯查表 + 几条规则），
 * 而这一层要处理幂等、规矩变更重发、新 bot 补登记，还要按政策档位推导范围。
 * 混在一个文件里，读网关的人会被迁移逻辑打断，改迁移的人又怕碰坏判定。
 *
 * ## 三件事，都必须是幂等的
 *
 *   1. `migrationActions()`  —— 某个档位该覆盖哪些动作（推导，不手写）
 *   2. `ensureLegacyGrant()` —— 给一批 bot 补齐迁移授权
 *   3. `CHIEF_ONLY_ACTIONS` / `MIGRATION_WITHHELD` —— 故意不继承的
 *
 * 幂等很重要：`ensureLegacyGrant` 会被反复调用（启动、新建 bot 后、
 * 规矩变更后、网关判前兜底），必须已经存在就不重复建。
 */
import { createHash } from 'node:crypto';
import {
  ACTION, MODE, RISK, SOURCE, normalizeGrant,
} from './grants.js';
import {
  CHIEF_ONLY_ACTIONS, MIGRATION_WITHHELD, deriveMigrationActions,
} from './capabilities.js';

/**
 * 迁移授权该覆盖哪些动作 —— **实现在 `capabilities.js`**。
 *
 * 这里只转发：动作清单从能力清单推导，不再手写第二份。
 * 加能力请改 `capabilities.js` 里 `ACTIONS[action].migration`。
 */
export function migrationActions({ readonly = false, chief = false } = {}) {
  return deriveMigrationActions({ readonly, chief });
}

/** 派生转发：故意不继承的动作 / 只给主 Bot 的动作。 */
export { MIGRATION_WITHHELD, CHIEF_ONLY_ACTIONS };

/**
 * 迁移兼容：把升级前那份全局 policy 记成一条根授权。
 *
 * 规格 §11：「隔离旧规则与新策略版本，切换时停止/核对旧后台进程，
 * 不让旧批准迁移成更宽的新批准」。
 *
 * 所以这条授权的范围**写死成 policy 现在已经允许的**，不多一分。
 *
 * 具体清单不在这里手写，而是 `migrationActions()` 从动作目录 + 只读放行名单
 * 推导出来的 —— 手写清单实测漏过三次（`desktop.observe`、`git.push`、
 * `mcp.add`），每次都是“工具在、网关却没发授权”这种静默故障。
 *
 * **不继承的**：`MIGRATION_WITHHELD` 里那两项（桌面输入、破坏性 Git）。
 * 它们要么还没建（P0-3b），要么本来就要求逐次确认，都不该被兼容层一括带上。
 *
 * 幂等：已经存在 `source: legacy-policy` 且属于该 bot 的授权就不再建第二条。
 *
 * ★ id 里那段 `revision` 必须**真的随规矩变**。
 *
 *   原来写成 `String(policyRevision).slice(0, 8)`，而 policyVersion() 的形状是
 *   `policy-v1:{"dangerous":...}` —— 前 8 个字符永远是 `policy-v`。
 *   于是「允许」改成「只读」后，新旧授权的 id 一模一样：库里同时存在
 *   `gr_legacy_x_policy-v` 的已撤销版本和有效版本，`lookup(id)` 只能返回
 *   先找到的那条（已撤销），按 id 取用时永远失败。
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
  // 取摘要而不是前缀：policyVersion() 是 `policy-v1:{...}`，前 8 位恒定不变。
  const revision = policyRevision
    ? createHash('sha1').update(String(policyRevision)).digest('hex').slice(0, 8)
    : 'v0';

  const created = [];
  const existing = [];
  const revoked = [];
  /** 用户亲手收回过的 bot：这次不补。 */
  const keptBack = [];
  for (const botId of botIds) {
    if (!botId) continue;
    const stale = store.state.grants.filter(
      (g) => g.source === SOURCE.legacyPolicy && g.subject?.botId === botId,
    );
    const fresh = stale.find((g) => !g.revokedAt && g.policyRevision === (policyRevision ? String(policyRevision) : null));
    if (fresh) { existing.push(fresh.id); continue; }

    // ★ 用户亲手收回过的，**不能再自动发回来**。
    //
    //   规格 §11 的第一条用户权利就是「始终可以取消、收回授权」。而这条
    //   授权在网关上还有一层“兜底补登记”（没授权就补一条，免得新 bot 干不了活）——
    //   两者冲突时，用户的意志优先。实测踩到：用户在界面点了「收回」，
    //   接口返回成功、列表也空了，但模型下一次动作又把同一条发回来，
    //   而且用的是同一个 id，于是表里出现两条同 id 记录。
    //
    //   ★ 只压“同一套规矩下”的自动补发。
    //
    //   用户收回 → 又改了规矩，那是**另一次用户交互**：新规矩下重发是正常的
    //   （规格 §6.1 允许授权根来自已认证用户交互）。不这么区分的话，
    //   用户改一次规矩就把自己的重发也锁死了，只能把手改授权表。
    //
    //   代价：用户在 p1 下收回，之后又切回 p1，这条会继续被压住。
    //   这是有意的保守方向 —— 收回是“不要再自动给我”，宁可让人再点一次。
    const currentRev = policyRevision ? String(policyRevision) : null;
    const revokedByUser = stale.some(
      (g) => g.revokedAt && g.revokedBy === 'user' && (g.policyRevision ?? null) === currentRev,
    );
    if (revokedByUser) { keptBack.push(botId); continue; }

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
      old.revokedBy = 'policy';
      revoked.push(old.id);
    }

    // 桌面观察只给主 Bot（role-tools 里那俩工具本来也是 CHIEF_ONLY_TOOLS）。
    // 这里再收一道是为了让授权记录**自己**说得清：审计里不该出现
    // “某个 project 模式的 bot 有一条 desktop.observe 授权”——看着吓人又没用。
    const isChief = botId === chiefBotId;
    const ownActions = migrationActions({ readonly, chief: isChief });

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
  return { created, existing, revoked, keptBack };
}
