/**
 * 用户接管检测（纯逻辑 + 探针接口）。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §5.2：
 *
 *   > 用户显式接管立即吊销租约、丢弃尚未执行输入；检测到用户真实输入时暂停
 *   > （检测可靠性与平台机制待核实）。
 *
 * ## 这个文件解决什么问题
 *
 * 主 Bot 在动鼠标的时候，用户如果突然自己拿起鼠标，会发生什么？
 *
 *   · 最坏：两边一起动 —— 用户点保存，Bot 点取消。**串打**。
 *   · 次坏：Bot 停了但不知道，用户以为自己接管了，结果 Bot 下一轮又开始动。
 *
 * 所以需要一件事：**判断"刚才那点输入到底是谁干的"**。
 *
 * 平台给的原始信息很朴素 —— 只有"最后一次输入发生在什么时候"：
 *
 *   · Windows：`GetLastInputInfo` → 全局最后一次输入的时刻（毫秒 tick）
 *   · macOS：`CGEventSourceSecondsSinceLastEventType` → 距离最后一次输入的秒数
 *
 * 关键难点：**我们自己发的输入也算"用户输入"**。如果我们刚点完鼠标，
 * 那个平台接口同样会更新 —— 光看"最近有输入"会把我们自己的动作误判成用户接管。
 *
 * 解法是记下**我们每次注入的时刻**，然后比对：
 *
 *   · 平台最后输入时间 > 我们最后注入时间 + 容差 → 用户真动过，接管
 *   · 两者接近（在我们注入的容差内）→ 是我们自己，放行
 *
 * ## 「探针不可用」必须保守
 *
 * 取不到平台信息时（权限没开、接口报错、非 Windows/macOS）**不能猜"没人动"**。
 * 那等于把"检测失败"变成"检测通过"。所以默认判为 `unknown`，
 * 上层拿到 `unknown` 应当**拒绝注入**（fail-closed），并把控制权交还用户。
 *
 * 这个文件不碰平台调用 —— 探针由调用方传进来（`probe`）。
 * 这样测试不需要真机，而且 Windows / macOS 两个实现共用同一套判定。
 */

/** 探针返回值的判定结果。 */
export const TAKEOVER = Object.freeze({
  /** 用户在动，必须让开 */
  userActive: 'user_active',
  /** 是我们自己刚动的，可以继续 */
  selfRecent: 'self_recent',
  /** 一段时间内谁都没动，可以继续 */
  quiet: 'quiet',
  /** 探针不可用 / 返回垃圾 —— **保守当成"可能有用户"** */
  unknown: 'unknown',
});

/** 你（调用方）该怎么做。 */
export const ACTION = Object.freeze({
  /** 继续注入 */
  proceed: 'proceed',
  /** 立刻停下并吊销租约，把控制权交还用户 */
  yieldToUser: 'yield',
  /** 停下但不必吊销：等下一次检查（探针抖动时用） */
  wait: 'wait',
});

/** 默认阈值（毫秒）。 */
export const DEFAULT_TOLERANCE_MS = 1_500;
/** 多久之内算"用户刚刚在动"（比它更久就算安静了）。 */
export const DEFAULT_ACTIVE_WINDOW_MS = 2_000;

/**
 * 建一个检测器状态。
 *
 * @param {object} [o]
 * @param {string} [o.desktopId]
 * @returns {object}
 */
export function createWatchState({ desktopId = 'default' } = {}) {
  return {
    desktopId,
    /** 我们最后一次注入输入的时刻（本机时钟） */
    lastInjectionAt: 0,
    /** 上次检查的结论，用于抖动抑制 */
    lastVerdict: null,
    /** 连续几次判成"用户在动"——抖动时不至于一次就放弃 */
    consecutiveUserActive: 0,
    /** 上次真实接管发生的时间（审计用） */
    lastTakeoverAt: 0,
  };
}

/**
 * 记一笔"我们刚注入了输入"。
 *
 * 每次真正发完 SendInput / CGEvent 之后必须调它 —— 否则下一次检查会把
 * 我们自己的动作误判成用户接管（然后就永远干不下去了）。
 *
 * @returns {object} state（原地改）
 */
export function noteInjection(state, { now = Date.now() } = {}) {
  state.lastInjectionAt = now;
  state.lastVerdict = null;
  state.consecutiveUserActive = 0;
  return state;
}

/**
 * 判定"刚才那点输入是谁的"。
 *
 * @param {object} state
 * @param {object} p
 * @param {number|null} p.lastInputAt 平台报的"最后一次输入时刻"（本机时钟毫秒）；
 *   **null = 探针不可用**（不是"没有输入"）
 * @param {number} [p.now]
 * @param {number} [p.toleranceMs] 时间对齐容差（我们的注入和平台的记录之间的延迟）
 * @param {number} [p.activeWindowMs] 多久之内算"还在动"
 * @returns {{verdict:string, action:string, reason:string}}
 */
export function classify({ state, lastInputAt, now = Date.now(), toleranceMs = DEFAULT_TOLERANCE_MS, activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS } = {}) {
  const verdict = (v, action, reason) => ({ verdict: v, action, reason });

  // ---- 探针不可用：**保守**当成"可能有人在"，绝不假设"没人动"
  if (lastInputAt === null || lastInputAt === undefined || !Number.isFinite(Number(lastInputAt))) {
    return verdict(
      TAKEOVER.unknown,
      ACTION.yieldToUser,
      '取不到系统的输入时间（探针不可用），无法判断用户是否在场，先把控制权交还用户',
    );
  }

  const last = Number(lastInputAt);
  if (last < 0) {
    // 负的时间戳不可能是真的输入时刻 —— 当成探针坏了，不要猜
    return verdict(TAKEOVER.unknown, ACTION.yieldToUser, `探针报了无效的输入时间（${last}），先交还用户`);
  }
  const mine = Number(state?.lastInjectionAt) || 0;

  // ---- 我们从来没注入过（mine = 0）：没有"自己"可比，只能看"最近有没有人动"
  //
  //   这一支必须放在最前面。否则 `last > 0 + tolerance` 会命中下面那条，
  //   把"很久以前的一次输入"误判成用户现在正在动。
  if (mine === 0) {
    const idleFor = last > 0 ? now - last : Number.POSITIVE_INFINITY;
    if (idleFor >= Math.max(0, activeWindowMs)) {
      return verdict(TAKEOVER.quiet, ACTION.proceed, `已经 ${Math.round(idleFor / 1000)}s 没人动输入`);
    }
    return verdict(
      TAKEOVER.userActive,
      ACTION.yieldToUser,
      `我们还没注入过，而 ${Math.max(0, Math.round((now - last) / 1000))}s 前有人动过输入 —— 保守让开`,
    );
  }

  // ---- 平台报的输入比我们最后一次注入还新：用户动过
  //
  //   为什么要留容差：注入本身有延迟（SendInput 返回 → 系统记账），
  //   容差内的差值视为同一次动作。
  if (last > mine + Math.max(0, toleranceMs)) {
    return verdict(
      TAKEOVER.userActive,
      ACTION.yieldToUser,
      `用户在 ${Math.max(0, Math.round((now - last) / 1000))}s 前动过输入，让开`,
    );
  }

  // ---- 我们刚动过（且平台报的时间不早于我们）
  //
  //   ★ 只允许 `last >= mine`：平台报的比我们注入还早，说明那不是我们这次
  //     动作的记录（时钟漂移 / 探针错乱）。用 Math.abs 会把这种情况也放过，
  //     等于对可疑时间戳视而不见。
  if (last >= mine && last - mine <= Math.max(0, toleranceMs)) {
    return verdict(TAKEOVER.selfRecent, ACTION.proceed, '刚才那次输入是我们自己注入的');
  }

  // ---- 最近一次输入已经很旧了：安静
  const idleFor = last > 0 ? now - last : Number.POSITIVE_INFINITY;
  if (idleFor >= Math.max(0, activeWindowMs)) {
    return verdict(TAKEOVER.quiet, ACTION.proceed, `已经 ${Math.round(idleFor / 1000)}s 没人动输入`);
  }

  // ---- 平台报的输入发生在我们最后一次注入**之前**（且不够旧）：
  //      时间戳可疑（时钟漂移 / 探针错乱）→ 不冒险
  return verdict(
    TAKEOVER.unknown,
    ACTION.wait,
    '输入时间戳与本地记录对不上（可能是时钟漂移或探针抖动），先别继续注入',
  );
}

/**
 * 带抖动抑制的判定：连续两次都说"用户在动"才真的让开。
 *
 * 为什么需要：系统偶尔会在我们注入的同时被别的进程（输入法、驱动、
 * 远程桌面心跳）碰到一下 —— 一次就放弃会让长动作永远跑不完。
 *
 * 但**探针不可用**不做抑制：那是确定性失败，不是抖动。
 *
 * @returns {{verdict:string, action:string, reason:string, strikes:number}}
 */
export function watch({ state, lastInputAt, now = Date.now(), toleranceMs = DEFAULT_TOLERANCE_MS, activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS, strikesToYield = 2 } = {}) {
  const raw = classify({ state, lastInputAt, now, toleranceMs, activeWindowMs });

  if (raw.verdict === TAKEOVER.userActive) {
    state.consecutiveUserActive = (Number(state.consecutiveUserActive) || 0) + 1;
    const enough = state.consecutiveUserActive >= Math.max(1, Number(strikesToYield) || 1);
    state.lastVerdict = raw.verdict;
    if (enough) {
      state.lastTakeoverAt = now;
      return { ...raw, strikes: state.consecutiveUserActive };
    }
    return {
      verdict: raw.verdict,
      action: ACTION.wait,
      reason: `${raw.reason}（第 ${state.consecutiveUserActive} 次，再命中一次就让开）`,
      strikes: state.consecutiveUserActive,
    };
  }

  // 不是 userActive 就把计数清零 —— 抖动不该累积成"接管"
  state.consecutiveUserActive = 0;
  state.lastVerdict = raw.verdict;
  return { ...raw, strikes: 0 };
}

/**
 * 把平台探针包成统一形状。
 *
 * 平台差异:
 *   · Windows `GetLastInputInfo` 给的是 tick（开机毫秒）→ 需要换算成 epoch
 *   · macOS `CGEventSourceSecondsSinceLastEventType` 给的是"多少秒前"→ 反推
 *
 * 这个函数只做换算，不做判定 —— 判定在 `classify` / `watch`。
 *
 * @param {object} p
 * @param {number|null} p.value 平台原始值
 * @param {'tick'|'agoSeconds'} p.unit
 * @param {number} [p.now] 本机时钟
 * @param {number} [p.bootTime] Windows tick 的基准（`Date.now() - tick` 反推）
 * @returns {number|null} 统一成"最后一次输入的 epoch 毫秒"；null = 不可用
 */
export function normalizeProbe({ value, unit, now = Date.now(), bootTime = null } = {}) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (unit === 'agoSeconds') return now - n * 1000;
  if (unit === 'tick') {
    // tick 是"开机以来毫秒"（Windows `GetLastInputInfo`）。
    // 调用方必须给 bootTime —— 没有它这个值毫无意义：
    //   · 拿 now 去凑（`now - tick`）得到的是"开机时刻"，不是输入时刻
    //   · 直接返回 now 等于谎报"刚刚有输入"，会让上层误判成"用户在场"
    // 所以没有基准就返回 null，让上层走"探针不可用 → 保守让开"那条路。
    // ★ 注意 `Number(null) === 0`（有限值）—— 直接 Number.isFinite 会
    //   把"没给 bootTime"当成"bootTime = 0"，于是一个 tick 值就被当成了 epoch。
    //   必须先挡掉 null/undefined。
    if (bootTime === null || bootTime === undefined) return null;
    if (!Number.isFinite(Number(bootTime))) return null;
    const at = Number(bootTime) + n;
    // 明显晚于"现在"的时间戳是坏的（时钟漂移 / tick 溢出），别当成未来事件
    if (at > now + 1000) return null;
    return at;
  }
  return null;
}

/** 一眼看清状态（界面/审计用）。 */
export function describeWatch(state, { now = Date.now() } = {}) {
  if (!state) return '接管检测未启用';
  if (state.lastTakeoverAt) {
    return `上次用户接管：${Math.round((now - state.lastTakeoverAt) / 1000)}s 前`;
  }
  if (state.lastVerdict === TAKEOVER.unknown) return '接管检测：探针不可用（会保守让开）';
  if (state.lastVerdict === TAKEOVER.userActive) return '接管检测：用户在动';
  if (state.lastInjectionAt) return `接管检测：正常（上次注入 ${Math.round((now - state.lastInjectionAt) / 1000)}s 前）`;
  return '接管检测：待命';
}
