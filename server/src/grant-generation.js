/**
 * 实例世代的**续期**（规格 §6.3）。
 *
 * ## 世代号本来想干什么
 *
 * > 后台任务不得续接旧权限。
 *
 * 进程重启后，**跑在那次进程里的临时批准**（任务级授权、后台进程的许可）
 * 不该自动续命 —— 那条活已经不存在了。
 *
 * ## 它实际干了什么（真 bug）
 *
 * `SERVER_GENERATION` 每次启动换一个值，而 `checkGrantValidity` 的规则是
 * **只要授权上有 generation、和当前不一致就拒绝**。
 *
 * 于是：
 *
 * | 授权 | 重启后会怎样 |
 * |---|---|
 * | 迁移授权（`source: legacy-policy`） | `ensureLegacyGrant` 看到同名同规矩的那条已存在 → 走 `existing` 分支 → **不重发、也不刷新世代** → 死 |
 * | 用户给的长期授权（首启页 / 权限申请批准） | `gate.add` 时盖的是当时的世代 → 重启后对不上 → 死 |
 *
 * 结果就是用户看到的那句话："我的联网授权属于旧世代，当前是新世代" ——
 * 用户明明批过、也没有收回，重启一次就全没了。
 *
 * ## 所以这里做两件事
 *
 *   1. **历史数据清理**：把长期授权上残留的世代号**抹掉**（清成 null）——
 *      `checkGrantValidity` 只在不为空时才比较，抹掉之后它就不再受重启影响；
 *   2. 新签发的长期授权由 `grant-gate.add` 直接不写世代（见那里的注释）。
 *
 *   为什么是"抹掉"而不是"刷成新世代"：世代号本身就是**任务**的概念。
 *   长期授权挂着任何一个世代号，都是在给下一次重启埋同一个坑。
 *
 * 判据是"这次批准是不是还在描述同一个事实"：
 *
 * | 保留并续期 | 让它过期 |
 * |---|---|
 * | 来源是 `user` / `saved-rule`（人给的）且 **`taskId` 为空** | 任何带 `taskId` 的（任务级，活没了就该没） |
 * | 来源是 `legacy-policy`（旧规矩的记账，且 `ensureLegacyGrant` 已经确认过它仍对口） | 已撤销 / 已过期 |
 *
 * ★ 为什么任务级的必须死：那正是规格 §6.3 要防的东西 ——
 *   "上个进程批准的后台动作，重启后继续跑"。人和规矩立的长期授权不在此列。
 *
 * 这个文件是纯逻辑 + 一个薄的落盘函数，不 import store 之外的东西。
 */

/**
 * 算出哪些授权要续期到新世代。
 *
 * @param {object} p
 * @param {Array} p.grants
 * @param {string} p.generation 本次进程的世代号
 * @param {number} [p.now]
 * @returns {{restamp:Array<{id:string,from:string}>, keep:Array<{id:string,why:string}>}}
 */
export function restampPlan({ grants = [], generation = '', now = Date.now() } = {}) {
  const gen = String(generation ?? '');
  const restamp = [];
  const keep = [];
  if (!gen) return { restamp, keep };

  for (const g of Array.isArray(grants) ? grants : []) {
    if (!g || g.revokedAt) continue;
    if (g.expiresAt != null && Number(g.expiresAt) <= now) continue;
    if (String(g.generation ?? '') === gen) continue; // 已经是这一代了

    const source = String(g.source ?? '');
    const taskScoped = Boolean(g.taskId);

    if (taskScoped) {
      keep.push({ id: String(g.id), why: '任务级授权：活已经没了，按规格不该续命' });
      continue;
    }
    if (source === 'user' || source === 'saved-rule' || source === 'legacy-policy') {
      restamp.push({ id: String(g.id), from: String(g.generation ?? '(无)') });
      continue;
    }
    // delegated 之类：它的父授权会管它，这里不擅自续期
    keep.push({ id: String(g.id), why: `来源 ${source || '(空)'} 不在这里续期` });
  }
  return { restamp, keep };
}

/**
 * 把续期结果落到 store 上。
 *
 * @param {object} p
 * @param {object} p.store
 * @param {string} p.generation
 * @param {number} [p.now]
 * @param {Function} [p.log]
 * @returns {{restamped:number, kept:number}}
 */
export function applyRestamp({ store, generation, now = Date.now(), log = () => {} } = {}) {
  const grants = store?.state?.grants ?? [];
  const plan = restampPlan({ grants, generation, now });
  let restamped = 0;
  for (const item of plan.restamp) {
    const g = grants.find((x) => x && x.id === item.id && !x.revokedAt);
    if (!g) continue;
    // ★ 抹掉，不是刷新：长期授权不该绑世代（否则下次重启又是同一个坑）
    g.generation = null;
    g.generationClearedAt = now;
    restamped += 1;
  }
  if (restamped) {
    try {
      store.scheduleSave?.();
    } catch { /* 落盘失败不该挡住启动 */ }
    log(`🔁 授权世代清理：${restamped} 条长期授权不再绑世代（任务级的不动）`);
  }
  return { restamped, kept: plan.keep.length };
}
