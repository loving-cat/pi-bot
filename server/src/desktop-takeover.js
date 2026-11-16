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
  /**
   * 用户**还在**这台电脑前（停手但没走）。
   *
   * 和 `userActive`（他正在动）分开：那个要立刻让开并吊销租约；
   * 这个只是"现在别动鼠标"——**不吊销、不计数**，稍后再试就行。
   */
  stillHere: 'still_here',
  /**
   * 有"刚动过"的信号，但**光标没动** —— 几乎肯定是别的程序在合成输入。
   *
   * 实测来源：远程控制软件（GameViewer / UU 之类）靠不断重置
   * `GetLastInputInfo` 保活，从不移动光标。只判"有没有新输入"会得出
   * "用户一直在动"，于是这个 bot 永远动不了鼠标。
   */
  phantom: 'phantom_input',
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
 * "只在用户离开时才动鼠标"这个模式的门槛（**默认关闭**）。
 *
 * ## 全双工不是"等你走开"
 *
 * 产品的目标形态是：**用户在同一台机器上正常干活，bot 同时在干活**。
 * 那靠的是"两张桌面并行"（规格 §5.6 的 T1 独立桌面）—— 两边各有自己的
 * 光标和焦点，物理上就不打架。
 *
 * 而同桌面（T2）**只有一个指针**，那是物理限制，不是政策选择：
 * 两个东西抢一个光标，必然串行。所以 T2 的定位是"退路"，不是主路。
 *
 * ## 那这个门槛还要不要
 *
 * 要，但只作为**可选模式**：有些用户会希望"我不在的时候它才动我这台桌面"，
 * 那就把这个值配成 90 秒之类的。默认 `0` = 关掉这个等待，回到
 * "安静 2 秒就动手、你一碰鼠标就立刻让开"。
 *
 * ★ 为什么默认必须是 0：把"等你离开"设成默认，等于把全双工这条路堵死 ——
 *   用户明明在机器上，bot 却一步都不能动，那这个产品就没法用。
 */
export const DEFAULT_AWAY_AFTER_MS = 0;

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
 * "安静"分两种：**他停手了**（还在看）和**他走了**（可以动手）。
 *
 * 只有后者才 proceed；前者给 `wait` —— 不吊销租约、不报错，
 * 只是"现在别动"，上层该做的是稍后再试。
 *
 * ★ 这个区分就是"用户无感"的全部秘密：用户没走，我们就不该碰他的鼠标。
 */
function awayOrQuiet({ idleFor, awayAfterMs, verdict, TAKEOVER, ACTION, phantomish = false }) {
  // ★ 合成输入源优先：有信号但光标不动 = 不是用户在用，**不需要等它"离开"**。
  //   （远程控制软件常驻时，"等用户离开"这个门槛永远不会满足。）
  if (phantomish) {
    return verdict(
      TAKEOVER.phantom,
      ACTION.proceed,
      '有程序在持续合成输入（光标没动过），不是用户在用 —— 不用等"离开"',
    );
  }
  const away = Number(awayAfterMs);
  if (!Number.isFinite(away) || away <= 0) {
    // 关掉门槛：回到"安静就动手"
    return verdict(TAKEOVER.quiet, ACTION.proceed, `已经 ${Math.round(idleFor / 1000)}s 没人动输入`);
  }
  if (idleFor >= away) {
    return verdict(
      TAKEOVER.quiet,
      ACTION.proceed,
      `用户已经 ${Math.round(idleFor / 1000)}s 没碰过这台电脑（超过离开门槛 ${Math.round(away / 1000)}s）`,
    );
  }
  // ★ 用 stillHere 而不是 userActive：后者在 watch() 里会累计 strike，
  //   两次就把租约吊销了 —— 而"用户在看书"不该算被接管。
  return verdict(
    TAKEOVER.stillHere,
    ACTION.wait,
    `用户 ${Math.round(idleFor / 1000)}s 前还在用这台电脑（离开门槛 ${Math.round(away / 1000)}s）—— `
      + '现在动鼠标会被看见，等会儿再来',
  );
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
export function classify({
  state,
  lastInputAt,
  now = Date.now(),
  toleranceMs = DEFAULT_TOLERANCE_MS,
  activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS,
  /**
   * 光标在这段时间里动过没有。
   * `null` = 不知道（没采过样）—— 那就**照旧保守让开**，不能假设是合成输入。
   */
  cursorStill = null,
  /**
   * 这台桌面是否已被判定为"有程序在持续合成输入"（租约申请时采一次）。
   * 只有它为真，`cursorStill` 才有资格把 `userActive` 降级成 `phantom`。
   */
  syntheticSource = false,
  /**
   * 多久没输入才算"用户离开了"（同桌面输入只在离开时动手）。
   * `0` = 关掉这个门槛（回到"安静 2 秒就动手"的老行为，只给测试/特殊场景用）。
   */
  awayAfterMs = DEFAULT_AWAY_AFTER_MS,
} = {}) {
  const phantomish = syntheticSource === true && cursorStill === true;
  const phantomVerdict = (reason) => verdict(TAKEOVER.phantom, ACTION.proceed, reason);
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
      return awayOrQuiet({ idleFor, awayAfterMs, verdict, TAKEOVER, ACTION, phantomish });
    }
    if (phantomish) {
      return phantomVerdict(
        '这台桌面上有程序在持续合成输入（光标没动过），不是用户在操作 —— 按"有合成输入源"处理',
      );
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
    if (phantomish) {
      return phantomVerdict(
        '输入时间一直在刷新，但光标从没动过 —— 判定为合成输入源（远程控制软件心跳之类），不是用户接管',
      );
    }
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
    return awayOrQuiet({ idleFor, awayAfterMs, verdict, TAKEOVER, ACTION, phantomish });
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
export function watch({
  state,
  lastInputAt,
  now = Date.now(),
  toleranceMs = DEFAULT_TOLERANCE_MS,
  activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS,
  strikesToYield = 2,
  cursorStill = null,
  syntheticSource = false,
  awayAfterMs = DEFAULT_AWAY_AFTER_MS,
} = {}) {
  const raw = classify({ state, lastInputAt, now, toleranceMs, activeWindowMs, cursorStill, syntheticSource, awayAfterMs });

  // ★ 只对 `userActive` 做抖动抑制，但 `unknown` 也不清零计数。
  //
  //   `unknown` 有两种来源，上层动作不同：
  //     · 探针拿不到值 / 时间戳非法 → `yieldToUser`（确定性失败，立刻让开）
  //     · 时间戳与本地记录对不上 → `wait`（可疑但不致命，先别继续）
  //   两者都不该把"连续第几次"清零：不然 `userActive → unknown → userActive`
  //   就被探针抖动偷走一次，"连续两次才让开"永远攒不满。
  //   真正安静下来（quiet / selfRecent）才清零。
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

  if (raw.verdict === TAKEOVER.unknown) {
    // 探针不可用 / 时间戳对不上：**不动计数**，也不假装它是清白的。
    // 已有 strike 保留 —— 连续三次里夹一次 unknown 仍然是连续的。
    // 动作照抄 classify 给的（拿不到值 → 让开；时间戳可疑 → 先停）。
    state.lastVerdict = raw.verdict;
    return { ...raw, strikes: Number(state.consecutiveUserActive) || 0 };
  }

  // 真的安静下来（quiet / selfRecent）才清零 —— 那才叫"抖动没累积成接管"
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
