/**
 * 桌面输入租约（纯逻辑，无 IO、无时钟）。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §5.2「同一桌面调度」：
 *
 *   > 同一 OS 桌面会话只有一个能注入输入的租约；租约属于任务，不属于进程全局的
 *   > "当前 Bot"。鼠标、键盘、焦点、剪贴板写入和影响窗口状态的动作纳入互斥区。
 *   > 租约有到期、心跳和世代号；旧持有者恢复后不能用旧租约继续输入。
 *   > 每次输入前检查取消状态、会话、目标窗口及观察是否过期。
 *   > 用户显式接管立即吊销租约、丢弃尚未执行输入。
 *
 * ## 为什么先把这一层写成纯逻辑
 *
 * 输入层（P0-3b）真正的风险不在"怎么发 SendInput"，在**谁有权发**。
 * 那件事是状态机，和平台无关：抢租约、心跳续期、过期、吊销、世代推进、
 * 队列排队。把它写成纯函数有三个好处：
 *
 *   · 不需要真机就能测全所有边界（旧世代、过期、取消、接管）；
 *   · 以后接 Windows `SendInput` 和 macOS `CGEvent` 时，两边共用同一套判定，
 *     不会出现"Windows 严格、macOS 宽松"这种漂移；
 *   · 平台实现失败（锁屏、UAC、TCC 拒绝）时能整块回退，租约逻辑不受影响。
 *
 * ## 三件必须分开的事
 *
 * | 概念 | 含义 | 错了会怎样 |
 * |---|---|---|
 * | `epoch` | 租约的世代号，每次转让 +1 | 旧持有者复活后继续输入（串打） |
 * | `heartbeatAt` | 持有者上次报活的时间 | 持有者进程死了，租约永远不释放 |
 * | `expiresAt` | 硬到期时刻 | 长期霸占桌面 |
 *
 * `epoch` 是这里最关键的东西：光有"当前持有者是谁"不够 —— 一个被抢占的
 * 旧任务如果不知道自己已经被抢，它下一次输入照样能发出去。所以**每次输入
 * 都必须带 epoch**，服务端拿它和当前值比，不等就拒。
 *
 * ## 与授权的关系（两层都要过）
 *
 * 租约回答"现在轮到谁动鼠标"；授权回答"这个 bot 有没有资格操作桌面"。
 * 两者独立：有租约但没授权 → 拒；有授权但租约在别人手里 → 排队，不拒。
 * 所以这个文件**不做授权判定**，也不碰 `grants.js`。
 */

/** 租约状态。 */
export const LEASE = Object.freeze({
  /** 空闲：可以立刻申请 */
  idle: 'idle',
  /** 有人在用 */
  held: 'held',
  /** 已被吊销，但要等持有者确认放弃 */
  revoking: 'revoking',
});

/** 拒绝原因码。调用方据此决定是排队、提示还是上报。 */
export const DENY = Object.freeze({
  /** 桌面被别的任务占着 */
  busy: 'desktop_busy',
  /** 没有租约（从没申请过，或已经释放） */
  noLease: 'no_lease',
  /** 带着旧世代号来的（被抢占过） */
  staleEpoch: 'stale_epoch',
  /** 租约过期了 */
  expired: 'expired',
  /** 已经被吊销（用户接管 / 任务取消） */
  revoked: 'revoked',
  /** 调用者不是持有者 */
  notHolder: 'not_holder',
  /** 参数不合法 */
  invalid: 'invalid',
});

/** 默认的租约时长与心跳要求（毫秒）。 */
export const DEFAULT_TTL_MS = 60_000;
/** 心跳超时：超过这个时间没报活，即使没到期也算失效。 */
export const DEFAULT_HEARTBEAT_MS = 20_000;
/** 一次转让最多排几个等待者（防止无界队列）。 */
export const MAX_QUEUE = 8;

/**
 * 建一个空的租约表。
 *
 * 一个"桌面"一份租约。现在只有一块桌面（`DEFAULT_DESKTOP`），
 * 但键设计成字符串，以后多显示器 / 多会话时不用改结构。
 *
 * @param {object} [o]
 * @param {string} [o.desktopId]
 * @returns {object} 租约状态（可变对象，由下面的函数原地改）
 */
export function createLeaseState({ desktopId = 'default' } = {}) {
  return {
    desktopId,
    status: LEASE.idle,
    /** 当前世代号：每次成功申请/转让都 +1 */
    epoch: 0,
    /** 持有者的任务 id（`null` = 没人持有） */
    taskId: null,
    /** 持有者的 bot id */
    botId: null,
    /** 申请时的实例世代（重启后旧租约作废） */
    generation: null,
    /** 申请/续期的时刻 */
    acquiredAt: 0,
    /** 最后一次心跳 */
    heartbeatAt: 0,
    /** 硬到期时刻 */
    expiresAt: 0,
    /** 吊销原因（非空 = 由外部吊销，持有者不能再续） */
    revokedReason: '',
    /** 等待队列（先进先出） */
    queue: [],
  };
}

const isId = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 租约现在有效吗。
 *
 * 检查四件事：状态、硬到期、心跳超时、实例世代。
 * **不做"是不是你"的判定** —— 那在 `assertHolder` 里。
 *
 * @param {object} state
 * @param {object} [o]
 * @param {number} [o.now]
 * @param {number} [o.ttlMs] 会话时长（用于判过期）
 * @param {number} [o.heartbeatMs]
 * @param {string|null} [o.generation] 当前实例世代
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function checkLease(state, {
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  generation = null,
} = {}) {
  if (!state || state.status === LEASE.idle) {
    return { ok: false, code: DENY.noLease, text: '桌面当前没有租约（先申请）' };
  }
  if (state.status === LEASE.revoking) {
    return {
      ok: false,
      code: DENY.revoked,
      text: `桌面租约已被吊销${state.revokedReason ? `：${state.revokedReason}` : ''}`,
    };
  }
  // 实例世代：进程重启后旧租约整体作废（规格 §6.3 / §5.2「世代号」）
  if (generation !== null && state.generation !== null && state.generation !== generation) {
    return {
      ok: false,
      code: DENY.expired,
      text: `租约属于上一个实例（${state.generation}），当前是 ${generation}`,
    };
  }
  if (Number(state.expiresAt) > 0 && now >= Number(state.expiresAt)) {
    return { ok: false, code: DENY.expired, text: '租约已到期' };
  }
  // 心跳超时：持有者可能已经死了，但还没到期 —— 也不该继续信它
  const beat = Number(state.heartbeatAt) || Number(state.acquiredAt) || 0;
  if (beat > 0 && now - beat > Math.max(heartbeatMs, 0)) {
    return { ok: false, code: DENY.expired, text: `租约心跳超时（${Math.round((now - beat) / 1000)}s 没报活）` };
  }
  return { ok: true };
}

/**
 * 申请租约。
 *
 * 三种结果：
 *   · 空闲 → 立刻给你，epoch +1
 *   · 你已经是持有者 → 续期（epoch 不变，避免自己把自己标成旧世代）
 *   · 别人持有 → **排队**，不报错。输入层不该因为别人在动鼠标就失败，
 *     那是正常的"等一下"。
 *
 * @param {object} state
 * @param {object} p
 * @param {string} p.taskId 任务 id（租约属于任务，不属于 bot）
 * @param {string} p.botId
 * @param {string|null} [p.generation]
 * @param {number} [p.now]
 * @param {number} [p.ttlMs]
 * @param {number} [p.heartbeatMs]
 * @returns {{ok:true, state:object, epoch:number, queued:boolean}|{ok:false, code:string, text:string}}
 */
export function acquire(state, {
  taskId, botId, generation = null,
  now = Date.now(), ttlMs = DEFAULT_TTL_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  if (!isId(taskId)) return { ok: false, code: DENY.invalid, text: '租约必须绑定到具体任务' };
  if (!isId(botId)) return { ok: false, code: DENY.invalid, text: '租约必须绑定到具体 bot' };

  // 自己已经是持有者：续期，不动 epoch
  if (state.status === LEASE.held && state.taskId === taskId && state.botId === botId) {
    if (checkLease(state, { now, ttlMs, heartbeatMs, generation }).ok) {
      state.heartbeatAt = now;
      state.expiresAt = now + ttlMs;
      return { ok: true, state, epoch: state.epoch, queued: false, renewed: true };
    }
  }

  // 空闲 / 过期 / 心跳超时 / 已被吊销 → 可以直接拿走
  const live = checkLease(state, { now, ttlMs, heartbeatMs, generation });
  const canTake = state.status === LEASE.idle
    || state.status === LEASE.revoking
    || !live.ok;

  if (canTake) {
    const previous = state.taskId;
    state.status = LEASE.held;
    state.epoch = (Number(state.epoch) || 0) + 1;
    state.taskId = taskId;
    state.botId = botId;
    state.generation = generation;
    state.acquiredAt = now;
    state.heartbeatAt = now;
    state.expiresAt = now + ttlMs;
    state.revokedReason = '';
    // 抢占到的租约：把原来那个持有者从等待队列里剔掉（它已经过时了）
    state.queue = (state.queue ?? []).filter((q) => q.taskId !== taskId);
    return { ok: true, state, epoch: state.epoch, queued: false, tookOverFrom: previous || null };
  }

  // 别人正在用 → 排队（同任务重复申请不重复入队）
  if (!state.queue) state.queue = [];
  const at = state.queue.findIndex((q) => q.taskId === taskId && q.botId === botId);
  if (at < 0) {
    if (state.queue.length >= MAX_QUEUE) {
      return {
        ok: false,
        code: DENY.busy,
        text: `桌面被「${state.botId}」的任务占着，排队也是满的（${MAX_QUEUE} 个），稍后再试`,
      };
    }
    state.queue.push({ taskId, botId, since: now });
  }
  return {
    ok: false,
    code: DENY.busy,
    text: `桌面正被另一个任务占用（${state.botId}），已排队，等它释放`,
    queued: true,
    position: state.queue.findIndex((q) => q.taskId === taskId) + 1,
  };
}

/**
 * 心跳：持有者报活并延长租约。
 *
 * 必须带 epoch —— 被抢占过的旧持有者拿旧 epoch 来续，一律拒绝。
 * 这是"旧持有者恢复后不能用旧租约继续输入"（规格 §5.2）的落点。
 *
 * @returns {{ok:true, expiresAt:number}|{ok:false, code:string, text:string}}
 */
export function renew(state, {
  taskId, botId, epoch, generation = null,
  now = Date.now(), ttlMs = DEFAULT_TTL_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  const holder = assertHolder(state, { taskId, botId, epoch, generation, now, ttlMs, heartbeatMs });
  if (!holder.ok) return holder;
  state.heartbeatAt = now;
  state.expiresAt = now + ttlMs;
  return { ok: true, expiresAt: state.expiresAt };
}

/**
 * 每次输入前都必须调它。
 *
 * 规格 §5.2 原话：「每次输入前检查取消状态、会话、目标窗口及观察是否过期」。
 * 这里能查的是前三样（取消 = 吊销 / 会话 = 任务与 bot / 目标窗口 = 调用方另查）。
 *
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function assertHolder(state, {
  taskId, botId, epoch, generation = null,
  now = Date.now(), ttlMs = DEFAULT_TTL_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  const live = checkLease(state, { now, ttlMs, heartbeatMs, generation });
  if (!live.ok) return live;
  if (state.taskId !== taskId || state.botId !== botId) {
    return {
      ok: false,
      code: DENY.notHolder,
      text: `桌面租约属于任务「${state.taskId}」（${state.botId}），不是你这个任务`,
    };
  }
  if (Number(epoch) !== Number(state.epoch)) {
    return {
      ok: false,
      code: DENY.staleEpoch,
      text: `这次输入的世代号是 ${epoch}，当前是 ${state.epoch} —— 租约被转让过，旧输入作废`,
    };
  }
  return { ok: true };
}

/**
 * 释放租约（任务正常结束）。
 *
 * 释放后立刻把租约交给队列里第一个等待者 —— 但要**明确告诉调用方
 * "该唤醒谁"**，让上层去驱动那次唤醒。这个文件不 import 任何执行器。
 *
 * @returns {{ok:true, next:object|null, epoch:number}}
 */
export function release(state, { taskId, reason = '', now = Date.now() } = {}) {
  if (state.status !== LEASE.held && state.status !== LEASE.revoking) {
    return { ok: true, next: null, epoch: state.epoch, noop: true };
  }
  // 不是持有者来释放：忽略（不能让 A 释放 B 的租约）
  if (taskId && state.taskId && taskId !== state.taskId) {
    return { ok: true, next: null, epoch: state.epoch, ignored: true };
  }
  const next = shiftQueue(state);
  state.status = LEASE.idle;
  state.taskId = null;
  state.botId = null;
  state.expiresAt = 0;
  state.heartbeatAt = 0;
  state.revokedReason = '';
  state.releasedAt = now;
  state.releasedReason = String(reason ?? '').slice(0, 200);
  // epoch 不重置：重置会让"上一个持有者"的旧 epoch 意外变成新值（撞车）
  return { ok: true, next, epoch: state.epoch };
}

/**
 * 吊销（用户接管 / 任务取消 / 权限被收回）。
 *
 * 规格 §5.2：「用户显式接管立即吊销租约、丢弃尚未执行输入」。
 *
 * 吊销不立刻清空持有者 —— 先标成 `revoking`，等持有者下一次输入被拒，
 * 它自己就会停下来。这样"用户接管"不会把正在写的东西截成半个字符。
 *
 * @returns {{ok:true, epoch:number, dropped:number}}
 */
export function revoke(state, { reason = '', by = 'user', now = Date.now() } = {}) {
  const dropped = (state.queue ?? []).length;
  // 排队者一并清掉：用户接管后，那些等着的任务不该继续排队等桌面
  if (state.status === LEASE.idle) {
    state.queue = [];
    return { ok: true, epoch: state.epoch, dropped };
  }
  state.status = LEASE.revoking;
  state.revokedReason = String(reason || '用户接管了这台电脑').slice(0, 200);
  state.revokedBy = ['user', 'task', 'policy', 'system'].includes(by) ? by : 'user';
  state.revokedAt = now;
  // epoch +1：让持有者手上的旧 epoch 立刻失效（即使它不调 assertHolder 直接发输入，
  // 上层也会拿新 epoch 去比）
  state.epoch = (Number(state.epoch) || 0) + 1;
  state.queue = [];
  return { ok: true, epoch: state.epoch, dropped };
}

/**
 * 租约到期 / 心跳超时后的回收：清掉僵住的租约，把桌面交给下一个等待者。
 *
 * 定时器调它（上层负责起定时器）。返回被清掉的持有者，让上层记审计。
 *
 * @returns {{released: object|null, next: object|null, epoch: number}}
 */
export function sweep(state, {
  now = Date.now(), ttlMs = DEFAULT_TTL_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  if (state.status !== LEASE.held) return { released: null, next: null, epoch: state.epoch };
  const live = checkLease(state, { now, ttlMs, heartbeatMs, generation: null });
  if (live.ok) return { released: null, next: null, epoch: state.epoch };
  const holder = { taskId: state.taskId, botId: state.botId, epoch: state.epoch, why: live.text };
  const next = shiftQueue(state);
  state.status = LEASE.idle;
  state.taskId = null;
  state.botId = null;
  state.expiresAt = 0;
  state.heartbeatAt = 0;
  state.revokedReason = '';
  return { released: holder, next, epoch: state.epoch };
}

/**
 * 队列里下一个可以拿的人（出队，但**不**替它申请 —— 由上层驱动它自己来 acquire）。
 *
 * 为什么不在这里直接给它：租约的所有权转移必须由持有者主动发起，
 * 这样它才知道自己拿到了、epoch 是多少。后台替人拿租约，等于替人决定
 * "现在开始动鼠标"，那是授权问题不是调度问题。
 */
function shiftQueue(state) {
  const q = state.queue ?? [];
  while (q.length) {
    const head = q.shift();
    if (head?.taskId) return head;
  }
  return null;
}

/** 排在第几位（1 = 下一个）。不在队列里返回 0。 */
export function queuePosition(state, { taskId } = {}) {
  const q = state.queue ?? [];
  const i = q.findIndex((x) => x.taskId === taskId);
  return i < 0 ? 0 : i + 1;
}

/** 一眼看清当前状态（界面/审计用，不含任何凭据）。 */
export function describeLease(state, { now = Date.now() } = {}) {
  if (!state || state.status === LEASE.idle) return '桌面空闲';
  const who = `${state.botId ?? '?'}（任务 ${state.taskId ?? '?'}）`;
  if (state.status === LEASE.revoking) {
    return `桌面租约已吊销${state.revokedReason ? `：${state.revokedReason}` : ''}，持有者 ${who} 待确认放弃`;
  }
  const left = Math.max(0, Math.round((Number(state.expiresAt) - now) / 1000));
  const queued = (state.queue ?? []).length;
  return `桌面由 ${who} 持有，epoch ${state.epoch}，${left}s 后到期${queued ? `，${queued} 个任务在排队` : ''}`;
}
