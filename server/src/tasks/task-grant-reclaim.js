/**
 * 任务结束时回收**临时授权**（规格 §13.2 第⑤步 / §6.3）。
 *
 * > 完成后展示产物、实际测试边界及副作用，级联回收临时权限；
 * > 用户可保留明确项目授权，但不能从"保留项目"推导长期对外发送或付款权限。
 *
 * ## 什么算"临时的"
 *
 * 一条授权只要带了下面任意一项，它就是**为某一次任务发的**，任务结束就该收：
 *
 *   · `taskId` —— 派活时发的那张（最常见）
 *   · `expiresAt` —— 带期限的
 *   · `maxUses` —— 带次数的
 *
 * 反过来，**没有这三样**的是项目级/长期授权（例如首次授权页建的那几条），
 * 它们**不能**被任务收尾顺手收掉 —— 那会把用户自己配的东西删了。
 *
 * ## 为什么单独一个文件
 *
 * 判定是纯的（给一批授权 + 一个 taskId → 该收哪些），可以穷举测试；
 * 而"收"这个动作本身要落在 `store` 上。分开之后，这条规则就不会因为
 * 某个调用点偷懒而漂移成"顺手多收一条"。
 */

/**
 * 这批授权里，哪些是该随这个任务一起回收的。
 *
 * @param {object} p
 * @param {Array} p.grants 全部授权记录（`store.state.grants`）
 * @param {string} p.taskId
 * @param {number} [p.now]
 * @returns {{reclaim:Array<{id:string, why:string}>, keep:Array<{id:string, why:string}>}}
 */
export function planTaskGrantReclaim({ grants = [], taskId = '', now = Date.now() } = {}) {
  const id = String(taskId ?? '');
  const reclaim = [];
  const keep = [];
  for (const g of Array.isArray(grants) ? grants : []) {
    if (!g || g.revokedAt) continue;
    const mine = String(g.taskId ?? '') === id && id !== '';
    const expired = g.expiresAt != null && Number(g.expiresAt) <= now;
    const hasLimit = g.expiresAt != null || g.maxUses != null;
    if (mine) {
      reclaim.push({ id: String(g.id), why: '这次任务的临时授权' });
    } else if (hasLimit && (expired || Number(g.usedUses ?? 0) >= Number(g.maxUses ?? Infinity))) {
      // 不是这次任务发的，但已经到期/用完 —— 顺手登记，让上层决定要不要清
      reclaim.push({ id: String(g.id), why: expired ? '授权已过期' : '授权次数已用完' });
    } else {
      // 项目级/长期授权：**不在任务收尾里动**
      keep.push({ id: String(g.id), why: hasLimit ? '还有效、且不是这次任务发的' : '项目级授权，收尾不动它' });
    }
  }
  return { reclaim, keep };
}

/**
 * 把回收计划落到 store 上（只标撤销，不删记录 —— 审计要留痕）。
 *
 * @param {object} p
 * @param {object} p.store
 * @param {string} p.taskId
 * @param {number} [p.now]
 * @param {Function} [p.log]
 * @returns {{revoked:string[], kept:number}}
 */
export function reclaimTaskGrants({ store, taskId, now = Date.now(), log = () => {} } = {}) {
  const grants = store?.state?.grants ?? [];
  const plan = planTaskGrantReclaim({ grants, taskId, now });
  const revoked = [];
  for (const item of plan.reclaim) {
    const g = grants.find((x) => x && x.id === item.id && !x.revokedAt);
    if (!g) continue;
    g.revokedAt = now;
    // `by: 'task'` 不是 'user'：这条是任务收尾自动收的，不是用户在界面上收回的。
    // 两者要分得开 —— 否则用户会以为"我没点过，它怎么自己撤了"。
    g.revokedBy = 'task';
    g.revokedReason = `任务结束回收：${item.why}`;
    revoked.push(g.id);
  }
  if (revoked.length) {
    try {
      store.scheduleSave?.();
    } catch { /* 落盘失败不该让收尾失败 */ }
    log(`♻ 回收临时授权 ${revoked.length} 条（任务 ${taskId}）`);
  }
  return { revoked, kept: plan.keep.length };
}
