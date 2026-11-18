/**
 * 策略与桌面设置领域服务（SDK / HTTP / Jarvis 工具三端共用）。
 *
 * 集中收敛「改 policy → 重签迁移授权 → 通知受影响任务 → 作废空闲会话」的唯一主干，
 * 并修掉原来路由里先更新 store 再拿 `store.policy()` 当旧值比对的 bug。
 */
import { ensureLegacyGrant } from '../migration-grants.js';
import { policyChange } from '../policy-version.js';

export function createPolicyService({ store, runner = null }) {
  function refreshLegacyGrants() {
    return ensureLegacyGrant({
      store,
      policy: store.policy(),
      policyRevision: store.policyVersion(),
      botIds: store.listBots().map((b) => b.id),
      chiefBotId: store.mainBot()?.id ?? null,
      generation: typeof runner?.grantGeneration === 'function' ? runner.grantGeneration() : null,
    });
  }

  return {
    get() {
      return {
        policy: store.policy(),
        policyVersion: store.policyVersion(),
        desktop: store.desktopSettings(),
      };
    },

    updatePolicy(patch = {}) {
      const prev = store.policy();
      const policy = store.updatePolicy(patch);
      const change = policyChange(prev, policy);
      let refreshed = null;
      let refreshError = null;
      try {
        refreshed = refreshLegacyGrants();
      } catch (err) {
        refreshError = err?.message || String(err);
      }
      const notified = change.isChange
        ? store.notifyPolicyChanged({ version: change.to, changed: change.changed })
        : 0;
      runner?.applyPolicyChange?.();
      return {
        ok: true,
        policy,
        policyVersion: store.policyVersion(),
        policyChange: change,
        notified,
        refreshed,
        refreshError,
      };
    },

    getDesktopSettings() {
      return store.desktopSettings();
    },

    updateDesktopSettings(patch = {}) {
      const settings = store.setDesktopSettings(patch ?? {});
      return { ok: true, settings };
    },
  };
}
