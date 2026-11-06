import { releaseEntry } from './session-pool.js';

/** 实体模型按组保护；动态路由或未知模型仍需全局保护。 */
export function providerLeaseScope(...models) {
  const selected = models.filter(Boolean);
  if (!selected.length || selected.some((model) => model.api === 'pi-virtual'
      || typeof model.provider !== 'string' || !model.provider)) return null;
  return [...new Set(selected.map((model) => model.provider))];
}

/** 等待依赖目标模型组的请求结束，再同步地址、凭据与会话。 */
export class ProviderUpdates {
  constructor({ sessions, providerForBot, otherBusy = () => false, onError = () => {} }) {
    this.sessions = sessions;
    this.providerForBot = providerForBot;
    this.otherBusy = otherBusy;
    this.onError = onError;
    this.pending = new Map();
    this.readers = 0;
    this.leases = new Set();
  }

  has(id) { return this.pending.has(id); }

  /** 未确定模型时保护全局；确定后登记所有可能使用的组，重复登记只扩展范围。 */
  acquire(providers = null) {
    const scope = (ids) => {
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id)) return null;
      return new Set(ids);
    };
    const lease = { providers: scope(providers) };
    this.leases.add(lease);
    this.readers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.leases.delete(lease);
      this.readers--;
    };
    release.restrictTo = (ids) => {
      if (released) return;
      const next = scope(ids);
      if (lease.providers == null || next == null) lease.providers = next;
      else for (const id of next) lease.providers.add(id);
    };
    return release;
  }

  async withLease(operation, providers = null) {
    const release = this.acquire(providers);
    try { return await operation(release); } finally { release(); }
  }

  matches(key, entry, id) {
    if (entry.session?.model?.provider === id) return true;
    const botId = entry.bot?.id ?? key.slice(key.lastIndexOf(':') + 1);
    return this.providerForBot(botId) === id;
  }

  request(id, apply) {
    this.pending.set(id, apply);
    return this.flush(id).includes(id);
  }

  /** 这一条会话现在能不能安全地丢掉并重建。 */
  #busy(entry) {
    return Boolean(entry.pending || entry.busy
      || entry.session?.isIdle === false || entry.session?.isStreaming
      || entry.session?.isCompacting);
  }

  flush(onlyId = null) {
    const applied = [];
    if (this.otherBusy() || [...this.leases].some((lease) => lease.providers == null)) return applied;
    // 正在构造的会话尚未暴露完整模型依赖。
    if ([...this.sessions.values()].some((entry) => entry.pending)) return applied;
    for (const [id, apply] of this.pending) {
      if (onlyId != null && id !== onlyId) continue;
      if ([...this.leases].some((lease) => lease.providers.has(id))) continue;
      const entries = [...this.sessions].filter(([key, entry]) => this.matches(key, entry, id));
      if (entries.some(([, entry]) => this.#busy(entry))) continue;
      for (const [key, entry] of entries) {
        this.sessions.delete(key);
        releaseEntry(entry);
      }
      try { apply(); } catch (error) {
        this.onError(id, error);
        continue;
      }
      this.pending.delete(id);
      applied.push(id);
    }
    return applied;
  }
}
