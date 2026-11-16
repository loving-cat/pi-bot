/**
 * 授权对账（规格 §6.3 / §13.1）—— 把"手里这些授权"和"现在的事实"重新核一遍。
 *
 * ## 为什么要对账
 *
 * 授权是有寿命的事实，而现实会变：
 *
 *   · bot 的角色变了（主 Bot 被降成普通成员）；
 *   · bot 被删了（`deleteBot` 会撤，但历史脏数据/崩溃可能留下孤儿）；
 *   · 工作目录换了（项目搬到别的盘、换了一个项目）；
 *   · 授权到期了、次数用完了。
 *
 * 这几种情况下，授权记录本身**仍然是"有效"的样子** ——
 * `checkGrantValidity` 只看它自己的字段，不会去问"这个主体还是不是主 Bot"、
 * "这个路径还在不在我的项目里"。
 *
 * 结果就是那句最典型的现象：**面板上写着它有权动鼠标，但它已经不是主 Bot 了**。
 *
 * ## 三条规则（保守方向各不相同，逐条说明）
 *
 * | 情况 | 处理 | 为什么 |
 * |---|---|---|
 * | 非主 Bot 拿着 `host` 模式授权 | **撤** | 规格 §8.1：host 是"主 Bot 可信宿主"，别的主体拿它就是错配，没有任何正当用途 |
 * | 主体已不存在 | **撤** | 孤儿授权；同名重建的 bot 会继承它（`deleteBot` 已防，这里兜住脏数据） |
 * | 资源路径不在当前工作目录下 | **只报，不撤** | 可能合法：用户有多项目、外接盘、worktree 在别处。撤了就是替用户做决定 |
 *
 * ★ 第二列里"撤"的两条都是**错配**，不是"用户可能还想要"。这个区别很重要：
 *   对账不能变成"猜用户想留什么" —— 那只会在下次启动时把他的授权悄悄删掉。
 */

/** 一条授权是不是"主体不在了"。 */
function subjectMissing(grant, botIds) {
  const id = String(grant?.subject?.botId ?? '');
  if (!id) return true;
  return !botIds.has(id);
}

/** 一条授权要求的主体是不是主 Bot。 */
function subjectIsMain(grant, bots) {
  const id = String(grant?.subject?.botId ?? '');
  const bot = bots.get(id);
  if (bot) return bot.role === 'main';
  // bot 不在了的时候按 subject.role 兜底（迁移授权里写了这个字段）
  return String(grant?.subject?.role ?? '') === 'main';
}

/**
 * 核一遍。
 *
 * @param {object} p
 * @param {Array} p.grants 全部授权（含已撤销的，函数自己跳过）
 * @param {Array} p.bots 现在的 bot 列表
 * @param {string} [p.workspace] 当前工作目录（绝对路径）；没给就跳过路径检查
 * @param {number} [p.now]
 * @returns {{revoke:Array<{id:string,why:string}>, stale:Array<{id:string,why:string}>}}
 */
export function reconcileGrants({ grants = [], bots = [], workspace = '', now = Date.now() } = {}) {
  const botMap = new Map();
  for (const b of Array.isArray(bots) ? bots : []) {
    if (b?.id) botMap.set(String(b.id), b);
  }
  const botIds = new Set(botMap.keys());
  const ws = String(workspace ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  const revoke = [];
  const stale = [];

  for (const g of Array.isArray(grants) ? grants : []) {
    if (!g || g.revokedAt) continue;
    // 到期的不进"要处理"：它自己已经无效了，留着是审计材料
    if (g.expiresAt != null && Number(g.expiresAt) <= now) continue;

    if (subjectMissing(g, botIds)) {
      revoke.push({ id: String(g.id), why: '主体已经不存在（孤儿授权）' });
      continue;
    }
    if (g.mode === 'host' && !subjectIsMain(g, botMap)) {
      revoke.push({ id: String(g.id), why: 'host 模式只属于主 Bot，这个主体已经不该有了' });
      continue;
    }
    if (ws) {
      const outside = (Array.isArray(g.resources) ? g.resources : [])
        .filter((r) => r?.kind === 'path')
        .map((r) => String(r.ref ?? ''))
        .filter((ref) => {
          const p = ref.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          if (!p) return false;
          return p !== ws && !p.startsWith(`${ws}/`);
        });
      if (outside.length) {
        // ★ 只报不撤：用户可能真的在用别的项目/别的盘
        stale.push({ id: String(g.id), why: `资源不在当前工作目录下：${outside.slice(0, 3).join('、')}`, paths: outside });
      }
    }
  }
  return { revoke, stale };
}

/**
 * 把对账结果落到 store 上（只标撤销、不删记录）。
 *
 * @param {object} p
 * @param {object} p.store
 * @param {string} [p.workspace]
 * @param {Function} [p.log]
 * @returns {{revoked:string[], stale:number}}
 */
export function applyReconcile({ store, workspace = '', log = () => {} } = {}) {
  const grants = store?.state?.grants ?? [];
  const bots = store?.listBots?.() ?? [];
  const { revoke, stale } = reconcileGrants({ grants, bots, workspace });
  const now = Date.now();
  const revoked = [];
  for (const item of revoke) {
    const g = grants.find((x) => x && x.id === item.id && !x.revokedAt);
    if (!g) continue;
    g.revokedAt = now;
    // `by: 'system'`：这是对账自动收的，不是用户在界面上收回的，也不是规矩变了。
    // 三者在审计里要分得开 —— 否则用户会以为"我没点过，它怎么自己撤了"。
    g.revokedBy = 'system';
    g.revokedReason = `对账回收：${item.why}`;
    revoked.push(g.id);
  }
  if (revoked.length) {
    try {
      store.scheduleSave?.();
    } catch { /* 落盘失败不该让启动失败 */ }
    log(`🧹 授权对账：回收 ${revoked.length} 条错配授权`);
  }
  for (const s of stale) {
    log(`⚠ 对账提醒：授权 ${s.id} —— ${s.why}（没有自动撤，你自己决定）`);
  }
  return { revoked, stale: stale.length };
}
