/**
 * 运行数据的保留策略（**纯逻辑**，零 IO；路线图之外的运维需求）。
 *
 * ## 这里回答的唯一问题
 *
 * "给定现在的清单、现在的时间和阈值，**哪些**可以删？" —— 不读盘、不删东西、
 * 不看 store。执行层是 `storage-housekeeping.js`，它负责 realpath 校验、真实删除
 * 与统计；两边分开是为了让"删哪些"能被逐个边界单测，而不用造一堆临时目录。
 *
 * ## 四条红线（写在这里，改代码前先读）
 *
 * 1. **绝不碰用户产出**：`workspace/`、`state.json`、`rooms/`、`sessions/` 不在任何
 *    选择函数的输入里 —— 能删的只有本文件里列的那几类运行产物。
 * 2. **TaskRun 按整棵根任务树裁剪**：`rootTaskId ?? id` 分组，树里只要有**一个**
 *    非终态节点，整棵树一个文件都不选（否则 `shouldSealTaskRunBatch`、预算结算、
 *    `rootOf` 全会被拆散）。
 * 3. **活跃回执与在跑 bot 的临时目录永远免疫**：`running` / `received` 阶段的回执、
 *    以及仍在干活的 bot 的实例目录，等多久都不选。
 * 4. **孤儿附件默认不自动删**：`orphanUploads` 只在显式清理时用，而且必须先算出
 *    `referencedIds`（全量消息 + 现存任务产物 + 未终结汇总）。扫不全宁可不删。
 *
 * 时间一律由调用方注入 `now`，阈值一律来自 `STORAGE_RETENTION_DEFAULTS`
 * （别在别处写 `30 * 24 * 3600 * 1000` 这种魔法数字）。
 */

/** 单一默认阈值（改这里 = 改保留策略） */
export const STORAGE_RETENTION_DEFAULTS = Object.freeze({
  /** 每个 bot 的实例临时目录（`instances/<botId>`）：一天没用就没价值了 */
  instanceTmpTtlMs: 24 * 60 * 60 * 1000,
  /** 接单回执（`task-requests/*.json`）：两周后重放没有意义（幂等窗口早过了） */
  requestReceiptTtlMs: 14 * 24 * 60 * 60 * 1000,
  /** 已终结的 TaskRun 树：默认留 30 天，够回溯一次季度复盘 */
  taskRunTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** 已终结的 TaskRun 树最多留这么多棵（按最老的一批裁） */
  taskRunMaxTerminal: 500,
  /** 孤儿附件：仅在**显式**清理时使用，同样给 30 天宽限 */
  orphanUploadTtlMs: 30 * 24 * 60 * 60 * 1000,
});

/**
 * TaskRun 的终态。
 *
 * ★ 这里写死而没有 import `tasks/task-contract.js`：纯模块不依赖运行层，
 *   而且"终态只有两个"这件事必须显式钉住 —— 任何人都不能靠"没见过的状态"
 *   当成可删（默认非终态 = 免疫，fail-closed）。
 */
export const TERMINAL_TASK_STATES = Object.freeze(['completed', 'cancelled']);

/** 这个 TaskRun 状态算不算终态（不认识的、缺字段的 → 一律不算，宁可不删） */
export function isTerminalTaskRun(run) {
  return TERMINAL_TASK_STATES.includes(String(run?.state ?? ''));
}

/** 根任务 id：没写 `rootTaskId` 的（老数据 / 根自己）就是自己 */
export function taskRunRootId(run) {
  const id = String(run?.id ?? '');
  const root = String(run?.rootTaskId ?? '');
  return root || id;
}

/** 取一个能代表"这棵树有多老"的时间戳：完工时间优先，其次更新/创建 */
export function taskRunStamp(run) {
  for (const key of ['finishedAt', 'updatedAt', 'createdAt', 'startedAt']) {
    const value = Number(run?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/**
 * 选出可以删的 TaskRun —— **以整棵根任务树为单位**。
 *
 * 规则：
 *   1. 按 `rootTaskId ?? id` 分组；
 *   2. 树里只要有一个节点不是终态（queued / running / waiting_xxx / paused_xxx /
 *      blocked / 未知）→ 整棵树免疫；
 *   3. 终态树：**整棵树最新的时间戳**都超过 `ttlMs` 才算过期（不是"最老"—— 根任务
 *      刚交卷、子任务可能是一个月前的，用 min 会把刚完成的任务当场删掉）；
 *   4. 剩下的终态树若超过 `maxTerminal` 棵 → 再按整树最新时间从旧到新裁。
 *
 * @param {Array<object>} runs
 * @param {{ now?: number, ttlMs?: number, maxTerminal?: number }} [opts]
 * @returns {{ rootIds: string[], taskRunIds: string[], expiredRoots: number, overflowRoots: number }}
 */
export function selectExpiredTaskRunTrees(
  runs = [],
  {
    now = Date.now(),
    ttlMs = STORAGE_RETENTION_DEFAULTS.taskRunTtlMs,
    maxTerminal = STORAGE_RETENTION_DEFAULTS.taskRunMaxTerminal,
  } = {},
) {
  const trees = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const id = String(run?.id ?? '');
    if (!id) continue;
    const rootId = taskRunRootId(run);
    let tree = trees.get(rootId);
    if (!tree) {
      tree = { rootId, ids: [], live: 0, latest: 0 };
      trees.set(rootId, tree);
    }
    tree.ids.push(id);
    if (!isTerminalTaskRun(run)) tree.live += 1;
    // ★ 取**最新**而不是最老：整棵树都静默超过 TTL 才算过期。
    //   用 min 的后果是"老子任务 + 刚交卷的根任务"一提交就被当成 30 天前的垃圾删掉。
    const stamp = taskRunStamp(run);
    if (stamp > 0) tree.latest = Math.max(tree.latest, stamp);
  }

  const terminal = [];
  for (const tree of trees.values()) {
    if (tree.live > 0) continue; // 红线 2：整棵免疫
    if (!tree.ids.length) continue;
    terminal.push(tree);
  }
  // 时间戳缺失（0）的排最前 —— 它们最没有保留价值，但仍受 maxTerminal 保护
  terminal.sort((a, b) => a.latest - b.latest || a.rootId.localeCompare(b.rootId));

  const expired = terminal.filter((tree) => now - tree.latest > ttlMs);
  const rest = terminal.filter((tree) => !expired.includes(tree));
  const limit = Math.max(0, Math.floor(Number(maxTerminal) || 0));
  const overflow = rest.length > limit ? rest.slice(0, rest.length - limit) : [];

  const selected = [...expired, ...overflow];
  return {
    rootIds: selected.map((tree) => tree.rootId),
    taskRunIds: selected.flatMap((tree) => tree.ids),
    expiredRoots: expired.length,
    overflowRoots: overflow.length,
  };
}

/** 回执的时间戳：完工优先，其次 `at` / `startedAt` */
export function requestReceiptStamp(receipt) {
  for (const key of ['finishedAt', 'at', 'startedAt', 'createdAt']) {
    const value = Number(receipt?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/**
 * 选出可以删的接单回执。
 *
 * 免疫：
 *   · 阶段是 `received` / `running`（还在处理中，删了就等于让同一个请求重跑）；
 *   · 带 `taskRunId` 且那个 TaskRun 还活着（非终态）—— 回执是宿主找得回任务的唯一线索；
 *   · 时间戳缺失或没到 TTL。
 *
 * @param {Array<{stage?:string, taskRunId?:string, at?:number, startedAt?:number, finishedAt?:number}>} receipts
 * @param {{ activeTaskRunIds?: Set<string>|Array<string>, now?: number, ttlMs?: number }} [opts]
 * @returns {Array<object>} 选中的回执（原样返回，方便执行层拿文件名）
 */
export function selectExpiredRequestReceipts(
  receipts = [],
  {
    activeTaskRunIds = new Set(),
    now = Date.now(),
    ttlMs = STORAGE_RETENTION_DEFAULTS.requestReceiptTtlMs,
  } = {},
) {
  const active =
    activeTaskRunIds instanceof Set ? activeTaskRunIds : new Set(activeTaskRunIds ?? []);
  const out = [];
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    const stage = String(receipt?.stage ?? '');
    if (stage === 'received' || stage === 'running') continue;
    const taskRunId = String(receipt?.taskRunId ?? '');
    if (taskRunId && active.has(taskRunId)) continue;
    const stamp = requestReceiptStamp(receipt);
    if (!stamp || now - stamp <= ttlMs) continue;
    out.push(receipt);
  }
  return out;
}

/**
 * 选出可以删的实例临时目录（`instances/<botKey>`）。
 *
 * 在跑 bot 的目录永远跳过：那里可能是沙箱的 cwd、临时下载、正在写的截图。
 *
 * @param {Array<{name:string, mtimeMs?:number}>} entries
 * @param {{ busyBotKeys?: Set<string>|Array<string>, now?: number, ttlMs?: number }} [opts]
 */
export function selectExpiredTmpEntries(
  entries = [],
  {
    busyBotKeys = new Set(),
    now = Date.now(),
    ttlMs = STORAGE_RETENTION_DEFAULTS.instanceTmpTtlMs,
  } = {},
) {
  const busy = busyBotKeys instanceof Set ? busyBotKeys : new Set(busyBotKeys ?? []);
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name ?? '');
    if (!name) continue;
    if (busy.has(name)) continue;
    const mtime = Number(entry?.mtimeMs);
    if (!Number.isFinite(mtime) || mtime <= 0) continue;
    if (now - mtime <= ttlMs) continue;
    out.push(entry);
  }
  return out;
}

/**
 * 选出可以删的孤儿附件。
 *
 * 免疫：
 *   · 已有墓碑（`deletedAt`）—— 台账里已经删过，不该再算一次；
 *   · 仍被任何消息 / 任务产物 / 未终结汇总引用（`referencedIds`）；
 *   · 没到 TTL。
 *
 * @param {Array<{id:string, createdAt?:number, deletedAt?:number, size?:number}>} uploads
 * @param {{ referencedIds?: Set<string>|Array<string>, now?: number, ttlMs?: number }} [opts]
 */
export function selectOrphanUploads(
  uploads = [],
  {
    referencedIds = new Set(),
    now = Date.now(),
    ttlMs = STORAGE_RETENTION_DEFAULTS.orphanUploadTtlMs,
  } = {},
) {
  const referenced = referencedIds instanceof Set ? referencedIds : new Set(referencedIds ?? []);
  const out = [];
  for (const upload of Array.isArray(uploads) ? uploads : []) {
    const id = String(upload?.id ?? '');
    if (!id) continue;
    if (upload?.deletedAt) continue;
    if (referenced.has(id)) continue;
    const createdAt = Number(upload?.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) continue;
    if (now - createdAt <= ttlMs) continue;
    out.push(upload);
  }
  return out;
}
