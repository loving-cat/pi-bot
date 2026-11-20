/**
 * 主控总汇总的领域服务（HTTP / SDK / 将来的界面共用这一份）。
 *
 * 状态机与就绪判定在纯模块 `server/src/chief-summary.js`，落盘在 `store`，
 * 真正的发送在 `server/src/runner/chief-summary-runner.js` —— 这里只做
 * 「校验动作 → 改状态 → 需要时触发一次发送」的粘合。
 */
import { SUMMARY_ACTIONS } from '../chief-summary.js';

export function createSummaryService({ store, runner = null } = {}) {
  return {
    /** 界面要展示的批次（ready_blocked / deferred / queued_send / sending） */
    list() {
      return store.pendingChiefSummaries();
    },

    get(id) {
      return store.chiefSummary(id);
    },

    /**
     * 三选一。
     *
     * `send` 之后如果主控空闲会立刻起一轮汇总（fire-and-forget）；
     * 主控忙则留在 `queued_send`，等这一轮结束时由 turn-executor 排空。
     */
    resolve(id, action, { mainBusy = null } = {}) {
      if (!SUMMARY_ACTIONS.includes(action)) {
        return { ok: false, status: 400, code: 'BAD_ACTION', error: '动作只能是 send / defer / ignore' };
      }
      const batch = store.chiefSummary(id);
      if (!batch) return { ok: false, status: 404, code: 'SUMMARY_NOT_FOUND', error: '汇总不存在' };

      const main = store.mainBot();
      const busy =
        mainBusy !== null && mainBusy !== undefined
          ? mainBusy === true
          : Boolean(main && runner?.isBusy?.(batch.originRoomId, main.id) === true);

      const r = store.resolveChiefSummary(id, action, { mainBusy: busy });
      if (r.error) return { ok: false, status: 404, code: 'SUMMARY_NOT_FOUND', error: r.error };
      // 用户点了「是」且主控现在空闲 → 立刻发（失败会自己退回 ready_blocked）
      if (action === 'send' && r.batch?.state === 'sending' && !r.unchanged) {
        void runner?.chiefSummaries?.summarize?.(id)?.catch?.(() => {});
      }
      return { ok: true, batch: r.batch };
    },
  };
}
