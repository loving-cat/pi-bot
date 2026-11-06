/**
 * 熔断器：一条通路（= 一个模型组 = 一份 baseUrl + key）坏掉时，
 * 别让每个 bot 各自硬撞 N 次。
 *
 * ## 为什么需要它
 *
 * 实测：6 个成员的群，key 彻底不可用时，现在会打 66 次请求、
 * 累积等 584 秒、用户看到 6 条"在等接口恢复"。
 * 而第 1 个 bot 撞 3 次就足以确定这个 key 不通了。
 *
 * 这是典型的**重试风暴**：上游已经挂了，我们还在加压。
 * 熔断器的作用就一句：**一条路确定不通，就别再往上撞**。
 *
 * ## 状态机
 *
 *   closed   正常工作
 *             连续失败 N 次 → open
 *   open     快速失败（不发请求，立刻返回"这条路不通"）
 *             冷却一段时间 → halfOpen
 *   halfOpen 放一个请求探路
 *             成功 → closed（恢复）
 *             失败 → open（重新等）
 *
 * ## 为什么 auth 错单独给更长的冷却
 *
 * 429/5xx 是"这一刻没排上"，60 秒后大概率就好了。
 * 401/403 是"这把钥匙不对" —— 60 秒后它还是不对，
 * 靠短冷却反复重试只会一直撞。所以 auth 类给 10 分钟。
 *
 * ## 纯函数
 *
 * 不碰定时器、不碰网络、不碰 store —— 状态进、状态出。
 * 这样"什么算失败、几次算坏、多久恢复"能被单测钉死，
 * 不用起服务端也不用等 60 秒。
 */

/** 连续失败多少次判定这条路不通。 */
export const OPEN_AFTER_FAILS = 3;

/** 临时故障（429/5xx/网络）的冷却：够上游缓过来，又不让用户等太久。 */
export const COOLDOWN_TRANSIENT_MS = 60_000;

/** 凭证类问题的冷却：钥匙不对不会自己变对，等久一点少撞几次。 */
export const COOLDOWN_AUTH_MS = 10 * 60_000;

export const BREAKER_STATE = Object.freeze({
  closed: 'closed',
  open: 'open',
  halfOpen: 'halfOpen',
});

/**
 * 这个失败算不算"通路故障"。
 *
 * 不计入的几类必须排掉，否则会把"任务本身做不成"误判成"路坏了"：
 *   · 用户终止 —— 不是故障
 *   · 模型说这活干不了 —— 不是通路问题
 *   · 参数错误（400/422）—— 是我们的 bug，重试和熔断都救不了
 */
export function isCircuitFailure({ kind = '', status = null } = {}) {
  if (kind === 'aborted' || kind === 'busy') return false;
  if (kind === 'auth') return true;
  const code = Number(status) || 0;
  if (code === 400 || code === 422) return false;
  if (code === 401 || code === 403) return true;
  if (code === 429 || code >= 500) return true;
  return kind === 'transient' || kind === 'timeout';
}

/** 这个失败对应的冷却时长。 */
export function cooldownFor({ kind = '', status = null } = {}) {
  const code = Number(status) || 0;
  if (code === 401 || code === 403 || kind === 'auth') return COOLDOWN_AUTH_MS;
  return COOLDOWN_TRANSIENT_MS;
}

/** 造一个全新的熔断器（closed）。 */
export function createBreaker() {
  return {
    state: BREAKER_STATE.closed,
    fails: 0,
    openedAt: 0,
    /** open 之后多久可以放一个探路请求 */
    cooldownMs: COOLDOWN_TRANSIENT_MS,
    /** halfOpen 时是否已有探路请求在飞 —— 防止并发探路把上游再打一遍 */
    probing: false,
  };
}

/**
 * 现在能不能发请求。
 *
 * 返回 { allow, reason }：allow=false 时调用方**必须**直接快速失败，
 * 不要再发网络请求 —— 这就是"更快"的来源。
 */
export function canRequest(breaker, now = Date.now()) {
  if (!breaker || breaker.state === BREAKER_STATE.closed) {
    return { allow: true, reason: '' };
  }
  if (breaker.state === BREAKER_STATE.open) {
    const left = breaker.openedAt + breaker.cooldownMs - now;
    if (left > 0) {
      return {
        allow: false,
        reason: '这条路刚失败过，冷却中（还剩 ' + Math.ceil(left / 1000) + 's）',
        retryAfterMs: left,
      };
    }
    // 冷却结束 → 按 halfOpen 处理（见下）
  }
  // halfOpen：只放一个探路请求
  if (breaker.probing) {
    return { allow: false, reason: '正在探路，等结果' };
  }
  return { allow: true, reason: '', probing: true };
}

/** 成功了：无论之前什么状态，一律回到正常。 */
export function recordSuccess(breaker) {
  return {
    ...createBreaker(),
    cooldownMs: breaker?.cooldownMs ?? COOLDOWN_TRANSIENT_MS,
  };
}

/**
 * 失败了：累计连续失败数，到阈值就打开。
 */
export function recordFailure(breaker, { kind = '', status = null, now = Date.now() } = {}) {
  const base = breaker ?? createBreaker();
  // 这次的失败跟通路无关（任务做不成、用户终止）→ 不动熔断器
  if (!isCircuitFailure({ kind, status })) {
    return { ...base, probing: false };
  }
  const fails = (base.fails ?? 0) + 1;
  const cooldownMs = cooldownFor({ kind, status });
  // halfOpen 的探路失败 → 立刻重新打开（不用再等攒够 3 次）
  if (base.state === BREAKER_STATE.halfOpen || fails >= OPEN_AFTER_FAILS) {
    return {
      state: BREAKER_STATE.open,
      fails,
      openedAt: now,
      cooldownMs,
      probing: false,
    };
  }
  return { ...base, fails, cooldownMs, probing: false };
}

/** 半开状态：冷却结束后调用方该做的转换（纯函数，便于测试）。 */
export function settleAfterCooldown(breaker, now = Date.now()) {
  if (!breaker || breaker.state !== BREAKER_STATE.open) return breaker;
  if (now < breaker.openedAt + breaker.cooldownMs) return breaker;
  return { ...breaker, state: BREAKER_STATE.halfOpen, probing: false };
}

/**
 * 给用户看的一句话。
 *
 * 「无感」的关键在这里：通路坏了不是用户的错，也不该让他读一堆技术细节。
 * 只说三件事：哪条路、多久后自己恢复、他现在能做什么（什么都不用做）。
 */
export function breakerNote(breaker, { groupName = '', now = Date.now() } = {}) {
  const until = (breaker?.openedAt ?? now) + (breaker?.cooldownMs ?? 0);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  const who = groupName ? '模型组「' + groupName + '」' : '当前模型';
  return who + '的接口暂时连不上，先停 ' + left + ' 秒再自动重试。这期间不用做什么。';
}