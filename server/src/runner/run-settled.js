/**
 * `run.settled` 终态事件（路线图 §4 T2.4，对齐 pi 的 `agent_settled`）。
 *
 * ## 语义
 *
 * "这个房间**不会再自己继续**了"：没有 bot 在跑、没有排队的轮次。
 * 宿主据此可以收尾（写报告、关窗口、退出进程），不用轮询 `isBusy`。
 *
 * ## 为什么要去抖
 *
 * 一轮结束后 `turn-executor` 的 finally 还会 `setTimeout(0)` 去 drain 排队请求
 * 与主控汇总 —— 那一步随时能再把房间拉起来。同步发 settled 会在"下一轮马上开始"
 * 时误报"不会继续了"。所以排一个 150ms 的定时器，到点**重新判一次**安静；
 * 不安静就不发（真安静下来时，结束的那一轮会再排一次）。
 *
 * ## 为什么不把定时器挂在 PiRunner 上
 *
 * `pi-runner.js` 是外观层（有 850 行硬预算），而且定时器属于"宿主生命周期"，
 * 放在这个模块里、用 WeakMap 按 runner 归组，dispose 时由 SDK 层统一清 ——
 * 这样加一个终态事件不需要让外观层变胖，也不会给 runner 加一个只给这里用的字段。
 */

/** `run.settled` 的去抖窗口（毫秒） */
export const RUN_SETTLED_DEBOUNCE_MS = 150;

/** runner → (roomId → timer)。WeakMap：runner 没了条目自动回收 */
const timersByRunner = new WeakMap();

function timersOf(runner) {
  let map = timersByRunner.get(runner);
  if (!map) {
    map = new Map();
    timersByRunner.set(runner, map);
  }
  return map;
}

/**
 * 这个房间是不是真的安静了。
 *
 * 只看 `isBusy` 不够：`roundQueue` 里还有排队轮次时，房间马上会被拉起来。
 */
export function isRoomQuiet(runner, roomId) {
  if (runner?.roundQueue?.has?.(roomId)) return false;
  // 用户在合并窗里刚发了新消息：合并窗 > 150ms 时不能提前报"安静"
  if (runner?.mergeQueue?.hasPending?.(roomId)) return false;
  for (const bot of runner?.store?.listBots?.() ?? []) {
    if (runner.isBusy(roomId, bot.id)) return false;
  }
  // 主控私聊还有待排空的汇总：房间不算安静（下一秒就会再开一轮）
  for (const batch of runner?.store?.queuedChiefSummaries?.() ?? []) {
    if (batch?.originRoomId === roomId) return false;
  }
  return true;
}

/**
 * 排一个 `run.settled`（同一房间后一个覆盖前一个）。
 *
 * @param {object} runner PiRunner
 * @param {string} roomId
 * @param {{ botId?: string, ok?: boolean, reason?: string }} [opts]
 */
export function scheduleRunSettled(runner, roomId, { botId = '', ok = true, reason = 'turn_end' } = {}) {
  if (!runner || !roomId) return;
  const timers = timersOf(runner);
  const prev = timers.get(roomId);
  if (prev) clearTimeout(prev);
  const handle = setTimeout(() => {
    timers.delete(roomId);
    if (!isRoomQuiet(runner, roomId)) return;
    runner.bus.emit('event', {
      t: 'run.settled',
      roomId,
      botId,
      ok: Boolean(ok),
      reason: String(reason || 'turn_end'),
      at: Date.now(),
      generation: runner.grantGeneration?.() ?? '',
    });
  }, RUN_SETTLED_DEBOUNCE_MS);
  handle.unref?.();
  timers.set(roomId, handle);
}

/** 清掉待发的 `run.settled`（dispose / 测试隔离用） */
export function clearSettleTimers(runner) {
  const map = timersByRunner.get(runner);
  if (!map) return;
  for (const handle of map.values()) clearTimeout(handle);
  map.clear();
}

/** 待发的定时器条数（测试用：确认 dispose 真的清干净了） */
export function pendingSettleTimerCount(runner) {
  return timersByRunner.get(runner)?.size ?? 0;
}
