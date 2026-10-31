/**
 * 全局**运行槽位**（纯逻辑，无副作用）：限制同时开跑的 agent 轮次数量。
 *
 * 为什么需要它：
 *   一个部门里被叫到的人会**同时**开跑（这是对的，不该改成排队）。
 *   但"同时"没有上限 —— 20 个 bot 的部门里 @all，就是 20 路模型并发：
 *   宿主机被吃满、内存往上顶、所有请求互相拖慢，最后每一个都变慢。
 *
 * 两条设计取舍：
 *
 *   1. **给人留保底位。** 用户可以多占用一个槽位（`reserve`）。
 *      扩容永远优先于新开的活，所以"人在等"不能被"机器在忙"挡住。
 *      这和 pi-bot 已有的插话打断是两件事：打断管"停下旧活"，
 *      槽位管"有没有资源开新活"。
 *
 *   2. **等待有上限，且不静默。** 拿不到槽位不能无限等 ——
 *      一等下去用户看到的是"没反应"。超时就返回 'timeout'，
 *      由调用方留痕（群里可见），这比悄悄排队到天荒地老诚实。
 *
 * 这一层不认识 pi、不认识房间，只认"要几个槽"和"谁是扩容"。
 */

/** 优先级：扩容（人）优先于普通（机器）。数字小的先拿。 */
export const PRIORITY = { human: 0, normal: 1 };

export class RunSlots {
  #capacity;
  #reserve;
  #holders = new Set();
  #queue = [];
  #seq = 0;

  /**
   * @param {number} capacity 同时可跑的上限（不含保底位）
   * @param {number} reserve  给"人"额外保留的槽位数
   */
  constructor({ capacity = 0, reserve = 1 } = {}) {
    this.#capacity = normalizeCount(capacity, 0);
    this.#reserve = normalizeCount(reserve, 0);
  }

  /** 普通活能用的槽位数（上限）；0 表示不限 */
  get capacity() {
    return this.#capacity;
  }

  /** 给"人"额外留的槽位数 */
  get reserve() {
    return this.#reserve;
  }

  get active() {
    return this.#holders.size;
  }

  get waiting() {
    return this.#queue.length;
  }

  /** 不限并发（capacity<=0）：永远拿得到 */
  get unlimited() {
    return this.#capacity <= 0;
  }

  /** 还剩几个普通位（不限并发时返回 Infinity） */
  get free() {
    if (this.unlimited) return Infinity;
    return Math.max(0, this.#capacity - this.#holders.size);
  }

  /**
   * 现在能拿到槽的等待者（按优先级、再按先来后到），最多到 limit 个。
   * 纯查询，不改变任何状态 —— 便于调用方先看清楚再决定。
   *
   * 判据：占用数 < 上限，或占用数 < 上限+保底位（多出来的那些只能给扩容）。
   */
  #admissible(priority) {
    if (this.unlimited) return true;
    const used = this.#holders.size;
    if (used < this.#capacity) return true;
    return priority === PRIORITY.human && used < this.#capacity + this.#reserve;
  }

  /**
   * 申请一个槽位。
   *
   * @param {{priority?: number, name?: string, timeoutMs?: number, signal?: AbortSignal}} opts
   * @returns {Promise<
   *   { ok: true, release: Function }
   *   | { ok: false, reason: 'timeout'|'aborted', waitedMs: number }
   * >} release 可以重复调（幂等，不会多还）。
   */
  acquire({ priority = PRIORITY.normal, name = '', timeoutMs = 0, signal = null } = {}) {
    if (this.unlimited) {
      const token = Symbol('slot');
      this.#holders.add(token);
      return Promise.resolve(this.#grant(token));
    }
    // 有空位且队列是空的 → 直接进（队列非空时要守先来后到，不能插队）
    if (!this.#queue.length && this.#admissible(priority)) {
      const token = Symbol('slot');
      this.#holders.add(token);
      return Promise.resolve(this.#grant(token));
    }
    return this.#enqueue({ priority, name, timeoutMs: normalizeCount(timeoutMs, 0), signal });
  }

  #grant(token) {
    let released = false;
    return {
      ok: true,
      release: () => {
        // ★ 幂等：调用方可能在 finally 里调、又在异常分支调。
        //   重复 release 会让占用数偏小，等于偷偷放大并发上限。
        if (released) return;
        released = true;
        this.#holders.delete(token);
        this.#drain();
      },
    };
  }

  #enqueue({ priority, name, timeoutMs, signal }) {
    return new Promise((resolve) => {
      const waiter = {
        priority, name, seq: ++this.#seq, resolve,
        startedAt: Date.now(), timer: null, onAbort: null, signal: null,
      };
      if (timeoutMs > 0) {
        // ★ 不要 unref：调用方正等着这个槽位的结果。
        //   定时器一旦 unref，在"只剩它在等"时进程会直接静默退出，
        //   调用方永远等不到那个 timeout 结论（测试里当场就挂住）。
        //   定时器在 settle/drain 时都会清掉，不会泄漏。
        waiter.timer = setTimeout(() => this.#settle(waiter, 'timeout'), timeoutMs);
      }
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => this.#settle(waiter, 'aborted');
        if (signal.aborted) {
          // ★ 不能走 #settle：它要求"在队列里"才能摘。
          //   这里还没入队，走它就会静默返回 —— 调用方那个 Promise 永远等不到结果。
          //   直接给结论。
          waiter.resolve({ ok: false, reason: 'aborted', waitedMs: 0 });
          return;
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
      // 入队后立刻尝试一次：可能是刚有人释放
      this.#drain();
    });
  }

  /** 结束一个等待者（超时 / 取消），并把它从队列里摘掉 */
  #settle(waiter, reason) {
    const at = this.#queue.indexOf(waiter);
    if (at < 0) return; // 已经拿到槽了
    this.#queue.splice(at, 1);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve({ ok: false, reason, waitedMs: Date.now() - waiter.startedAt });
  }

  /** 按优先级 + 先来后到，把能拿到的槽放出去 */
  #drain() {
    if (this.unlimited || !this.#queue.length) return;
    // 稳定排序：优先级相同按入队序号
    this.#queue.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
    while (this.#queue.length) {
      const head = this.#queue[0];
      if (!this.#admissible(head.priority)) break;
      this.#queue.shift();
      clearTimeout(head.timer);
      if (head.signal && head.onAbort) head.signal.removeEventListener('abort', head.onAbort);
      const token = Symbol('slot');
      this.#holders.add(token);
      head.resolve(this.#grant(token));
    }
  }
}

/** 非负整数；非法值回落到 fallback */
function normalizeCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
