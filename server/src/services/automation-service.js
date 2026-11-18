/**
 * 定时任务领域服务（SDK / HTTP / Jarvis 工具共用）。
 *
 * 统一房间校验、互斥排期校验、`computeNextRun` 计算与 CRUD 行为。
 */
import { computeNextRun, validateSchedule } from '../automations.js';

export function createAutomationService({ store, runner = null }) {
  return {
    list({ roomId = null } = {}) {
      return store.listAutomations({ roomId });
    },

    get(id) {
      return store.getAutomation(id);
    },

    create({
      roomId,
      title = '',
      prompt = '',
      botId = null,
      everyMinutes = null,
      dailyAt = null,
      enabled = true,
      createdBy = null,
    } = {}) {
      const problem = validateSchedule({ everyMinutes, dailyAt });
      if (problem) {
        return { ok: false, status: 400, code: 'SCHEDULE_INVALID', error: problem };
      }
      if (!store.getRoom(roomId)) {
        return { ok: false, status: 400, code: 'ROOM_NOT_FOUND', error: '会话不存在' };
      }
      const nextRunAt = computeNextRun({ everyMinutes, dailyAt }) ?? 0;
      const automation = store.createAutomation({
        roomId,
        title,
        prompt,
        botId,
        everyMinutes,
        dailyAt,
        enabled: enabled !== false,
        createdBy,
        nextRunAt,
      });
      if (!automation) {
        return { ok: false, status: 400, code: 'AUTOMATION_INVALID', error: '任务要有标题和内容' };
      }
      return { ok: true, automation };
    },

    update(id, patch = {}) {
      const current = store.getAutomation(id);
      if (!current) {
        return { ok: false, status: 404, code: 'AUTOMATION_NOT_FOUND', error: '定时任务不存在' };
      }
      const nextPatch = { ...patch };
      if (patch.everyMinutes !== undefined || patch.dailyAt !== undefined) {
        // 两种排期互斥：切换类型时不要混进旧字段把自己校验挂掉
        const schedule = patch.dailyAt !== undefined && patch.everyMinutes === undefined
          ? { dailyAt: patch.dailyAt }
          : patch.everyMinutes !== undefined && patch.dailyAt === undefined
            ? { everyMinutes: patch.everyMinutes }
            : {
                everyMinutes: patch.everyMinutes ?? current.everyMinutes,
                dailyAt: patch.dailyAt ?? current.dailyAt,
              };
        const problem = validateSchedule(schedule);
        if (problem) {
          return { ok: false, status: 400, code: 'SCHEDULE_INVALID', error: problem };
        }
        nextPatch.nextRunAt = computeNextRun(schedule) ?? 0;
      }
      const automation = store.updateAutomation(id, nextPatch);
      if (!automation) {
        return { ok: false, status: 404, code: 'AUTOMATION_NOT_FOUND', error: '定时任务不存在' };
      }
      return { ok: true, automation };
    },

    remove(id) {
      return { ok: true, deleted: store.deleteAutomation(id) };
    },

    runNow(id) {
      const cur = store.getAutomation(id);
      if (!cur) {
        return { ok: false, status: 404, code: 'AUTOMATION_NOT_FOUND', error: '定时任务不存在' };
      }
      if (typeof runner?.runAutomation === 'function') {
        void runner.runAutomation(cur).catch(() => {});
      }
      return { ok: true, started: true, automation: cur };
    },
  };
}
