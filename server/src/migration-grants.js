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
import {
  ACTION, MODE, RISK, SOURCE, normalizeGrant,
} from './grants.js';
import { GATED_ACTIONS, actionsForTools } from './action-catalog.js';
// role-tools 是叶子模块（内部不 import 任何东西），引用它不会成环。
// 只读档“允许哪些工具”的唯一来源在它那里，迁移授权的动作清单从这里推导。
import { READONLY_ALLOW } from './role-tools.js';

/**
 * 迁移授权应该覆盖哪些动作 —— 「网关上线之前，政策已经允许的全部动作」。
 *
 * 这是本项目里唯一允许“推导而不是手写”的授权范围，因为它是**兼容层**：
 * 目的不是新增权限，而是让网关上线不改变现有行为（规格 §11「隔离旧规则与
 * 新策略版本」）。推导的好处是它不会比政策窄 —— 手写清单实测漏过三次：
 * `desktop.observe`、`git.push`、`mcp.add` 都是“工具在、网关却没发授权”，
 * 而且全静默：工具看着在那里，一调就报没有权限。
 *
 * 两个档位的区别就是 policy 本来的区别：
 *   · 只读（`dangerous: 'deny'`）→ 只发“只读放行名单里的工具”所对应的动作 + 读文件
 *   · 其他档位 → 所有有工具的动作（拿掉 `MIGRATION_WITHHELD`）
 *
 * 放宽方向靠什么拦：真正危险的动作仍然要过各自的二次门 ——
 * MCP 与改防线走 `SECURITY_CONFIG_TOOLS` 逐次审批，push 走手机确认。
 * 迁移授权只回答“有没有资格走这条路”，不回答“这一步要不要人点”。
 *
 * @param {object} p
 * @param {boolean} [p.readonly] 当前是不是只读模式
 * @param {boolean} [p.chief] 是不是主 Bot（桌面观察只给它）
 * @returns {string[]}
 */
export function migrationActions({ readonly = false, chief = false } = {}) {
  const base = readonly
    // 读工具（read/ls/grep/find）本身不过网关，所以 file.read 要单独加上；
    // 其余的按“只读放行名单里的工具”推导，不再手写第二份清单。
    ? [ACTION.fileRead, ...actionsForTools(READONLY_ALLOW)]
    : [ACTION.fileRead, ...GATED_ACTIONS];
  const withheld = chief ? MIGRATION_WITHHELD : [...MIGRATION_WITHHELD, ...CHIEF_ONLY_ACTIONS];
  return [...new Set(base.filter((a) => !withheld.includes(a)))];
}

/**
 * 只给主 Bot 的动作。
 *
 *   · `desktop.observe` —— 看得到用户整个屏幕。role-tools 的两个桌面工具
 *     本来就在 `CHIEF_ONLY_TOOLS` 里，这里再收一道是为了让**授权记录自己**
 *     说得清：审计里不该出现“某个 project 模式的 bot 有一条看屏幕授权”。
 *   · `git.push` —— 规格 §7.1 的 G2 是“集成动作”。负责人对自己的项目有
 *     本地提交权，但把东西推出本机是主 Bot 的活（而它自己还要过手机确认）。
 */
export const CHIEF_ONLY_ACTIONS = Object.freeze([ACTION.desktopObserve, ACTION.gitPush]);

/**
 * 拆权时必须默认“不给”的动作（不是“忘了要”，是**故意**扣着）。
 *
 *   · `desktop.input`：桌面输入层还没建（P0-3b），先把格子留出来 ——
 *     等接上时只能是用户新建授权，不能从迁移授权自动继承。
 *   · `git.destructive`：force push / reset --hard / 删分支那类，
 *     规格 §7.1 的 G3，本来就要逐次确认，不该被迁移授权一括。
 */
export const MIGRATION_WITHHELD = Object.freeze([ACTION.desktopInput, ACTION.gitDestructive]);

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
  return { created, existing, revoked };
}
