/**
 * 定时任务：到点把一句话交给它，让它在那个会话里跑一轮。
 *
 * 两种排法，够覆盖常见用途：
 *   · `everyMinutes: N` —— 每 N 分钟一次（最小 5 分钟）
 *   · `dailyAt: 'HH:MM'` —— 每天本地时间几点几分
 *
 * 判断与排期是纯函数（computeNextRun / shouldRun），调度器只负责"到点就调 run"，
 * 这样时间逻辑能单测，不用等真实时钟。
 */

/** 最小间隔：太短的定时任务会把模型额度烧光 */
export const MIN_EVERY_MINUTES = 5;

/** 解析 HH:MM；非法返回 null */
export function parseDailyAt(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

/**
 * 下一次该跑的时间。
 *
 * @param {{everyMinutes?:number, dailyAt?:string}} schedule
 * @param {number} from 起始时间戳（默认现在）
 * @returns {number|null} 时间戳；排法非法返回 null
 */
export function computeNextRun(schedule = {}, from = Date.now()) {
  const every = Number(schedule.everyMinutes);
  if (Number.isFinite(every) && every > 0) {
    const minutes = Math.max(MIN_EVERY_MINUTES, Math.round(every));
    return from + minutes * 60_000;
  }
  const at = parseDailyAt(schedule.dailyAt);
  if (at) {
    const d = new Date(from);
    const next = new Date(d);
    next.setHours(at.hh, at.mm, 0, 0);
    // 今天这个点已经过了（或正好是现在）→ 明天
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  return null;
}

/** 校验一条定时任务的定义 */
export function validateSchedule(schedule = {}) {
  const every = Number(schedule.everyMinutes);
  if (Number.isFinite(every) && every > 0) {
    if (every < MIN_EVERY_MINUTES) return `间隔不能小于 ${MIN_EVERY_MINUTES} 分钟`;
    return null;
  }
  if (schedule.dailyAt !== undefined && schedule.dailyAt !== null && schedule.dailyAt !== '') {
    return parseDailyAt(schedule.dailyAt) ? null : '时间格式要写成 HH:MM（例如 09:30）';
  }
  return '要么给 everyMinutes，要么给 dailyAt';
}

/** 到点了吗（没有 nextRunAt 的按"立即排下一次"处理，由调用方写回） */
export function shouldRun(automation, now = Date.now()) {
  if (!automation || automation.enabled === false) return false;
  if (!automation.nextRunAt) return false;
  return automation.nextRunAt <= now;
}

/**
 * 调度器：每 tickMs 扫一次，把到点的任务交给 run()。
 *
 * run(automation) 由外面注入（要 store / runner），这里只做时间判断与防重入。
 */
export function createAutomationScheduler({ store, run, log = () => {}, tickMs = 30_000 } = {}) {
  let timer = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const due = store.listAutomations().filter((a) => shouldRun(a, now));
      for (const automation of due) {
        // 先排下一次再跑：跑挂了也不会每分钟重试一次
        const next = computeNextRun(automation, now) ?? 0;
        store.markAutomationRan(automation.id, next);
        try {
          await run(automation);
        } catch (err) {
          log(`定时任务「${automation.title}」执行失败：${err?.message || err}`);
        }
      }
    } finally {
      busy = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch(() => {});
      }, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 测试用：手动跑一拍 */
    tickOnce: tick,
  };
}
