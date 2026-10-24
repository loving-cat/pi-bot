/**
 * 多段消息合并 —— 用户连发几条时，让模型**一次看到完整意图**。
 *
 * ## 问题
 *
 * 用户连发消息：想到一句发一句。
 *
 *   「帮我看下这个系统」
 *   「https://xxx.com」
 *   「账号 admin 密码 123」
 *
 * 如果这三条各自触发一次模型调用，agent 只能看到**半句话**：
 * 第一条时它不知道要接什么，可能已经开始瞎猜、"我这就去试试"；
 * 第二条补充地址时它已经在跑了，只能 steer 插队；
 * 第三条补账号时又要再插一次。三次插队 = 三份互相打架的理解。
 *
 * pi agent 在终端里没这个问题：用户打完一整段才按回车。
 * Web/桌面聊天把"一段话"拆成了三条消息，这是聊天形态带来的副作用。
 *
 * ## 解法
 *
 * 给"连发"加一个**很短**的静默窗口（默认 700ms）：
 *   · 第一条进来 → 起窗口，不立刻投递
 *   · 窗口内又来一条 → 追加，**重置窗口**
 *   · 窗口静默到期 → 把攒下的几条拼成一段，一次投递
 *
 * 这样"想到一句发一句"会自然合成一段；而真的只发一句时，
 * 最多多等 700ms（比一次错误的投递便宜太多）。
 *
 * ## 不该合并的情况
 *
 *   · **在跑的时候**：那是「中断/插队」，必须立刻送进去让它改计划 ——
 *     等 700ms 只会让它多跑错一段。所以只在"空闲"时合并。
 *   · **带附件**：每条附件的顺序和归属不能乱搅，逐条送。
 *   · **群里**：群里是多人对话，合并会把别人的话卷进来。
 *
 * ## 合并后长什么样
 *
 * 不是简单 `a + '\n' + b`。要标清楚"这是用户连着发的几条"，
 * 否则模型会把它们当成一个句子里并列的三段，读不出先后。
 */

/** 静默窗口：最后一条之后等这么久就认为"说完了" */
export const MERGE_QUIET_MS = 700;

/**
 * 一段话最多攒多久。防止用户一直在输入框里敲（每 500ms 一条）
 * 导致永远不投递 —— 到点强制发出已攒的内容。
 */
export const MERGE_MAX_WAIT_MS = 4000;

/**
 * 把多条消息拼成一段给模型的 prompt。
 *
 * @param {string[]} parts 按时间顺序
 * @returns {string}
 */
export function mergeUserMessages(parts = []) {
  const texts = parts
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);
  if (texts.length === 0) return '';
  if (texts.length === 1) return texts[0];

  // 多条时明确告诉模型这是"连着发的几条"，不是三个独立请求。
  // 这一步很关键：不说明的话，模型会当成并列的三个任务分别回应，
  // 而不是"合起来理解这个人的完整意图"。
  return (
    `（用户连着发了几条消息，合起来是一件事，请一并理解后再动手：）\n\n` +
    texts.map((t, i) => `${i + 1}. ${t}`).join('\n')
  );
}

/**
 * 合并队列：按房间缓存待投递的消息。
 *
 * 用房间而不是 bot 做 key：一个私聊房间就对应一个 bot
 * （`ensureDm` 保证一对一），用房间更直观，也不会因为 bot 重命名而错位。
 */
export class MergeQueue {
  /**
   * @param {object} opts
   * @param {number} [opts.quietMs]   静默窗口
   * @param {number} [opts.maxWaitMs] 最长攒多久
   * @param {(roomId:string, merged:string, parts:string[]) => Promise<any>} opts.flush 到期投递
   * @param {(msg:string) => void} [opts.log]
   */
  constructor({ quietMs = MERGE_QUIET_MS, maxWaitMs = MERGE_MAX_WAIT_MS, flush, log = () => {} }) {
    this.quietMs = quietMs;
    this.maxWaitMs = maxWaitMs;
    this.flush = flush;
    this.log = log;
    /** roomId -> { parts, timer, firstAt, flushing } */
    this.pending = new Map();
  }

  /**
   * 加一条待合并的消息。
   *
   * @param {string} roomId
   * @param {string} text
   * @returns {boolean} true = 已收下（稍后合并投递）；false = 没有可合并的（空文本）
   */
  push(roomId, text) {
    const clean = String(text ?? '').trim();
    if (!clean) return false;

    let slot = this.pending.get(roomId);
    if (!slot) {
      slot = { parts: [], timer: null, firstAt: Date.now(), flushing: false };
      this.pending.set(roomId, slot);
    }
    slot.parts.push(clean);

    // 攒太久了就立刻发，别让用户一直等（他可能还在慢慢补细节，
    // 但已经过去的 4 秒足够先把已知的送进去）
    const waited = Date.now() - slot.firstAt;
    if (waited >= this.maxWaitMs) {
      void this.#fire(roomId);
      return true;
    }

    if (slot.timer) clearTimeout(slot.timer);
    // ★ 定时器要在两个时间点里**取更早的**：
    //   · quietMs：静默窗口（用户说完了）
    //   · 距离 firstAt 满 maxWaitMs：用户一直在敲，但不能再拖了
    //   只设 quietMs 的话，用户每 500ms 敲一下就会把定时器一直往后推，
    //   永远不投递（用户一边想一边写时就会这样）。
    const remainToMax = Math.max(0, this.maxWaitMs - (Date.now() - slot.firstAt));
    const delay = Math.min(this.quietMs, remainToMax);
    slot.timer = setTimeout(() => {
      void this.#fire(roomId);
    }, delay);
    // 别让这个定时器把进程钉住（服务端要能正常退出）
    slot.timer.unref?.();
    return true;
  }

  /** 这个房间是不是有还没投递完的消息 */
  hasPending(roomId) {
    return this.pending.has(roomId);
  }

  /** 已经攒了几条（界面可以显示"正在合并 3 条"） */
  pendingCount(roomId) {
    return this.pending.get(roomId)?.parts.length ?? 0;
  }

  /** 立刻把所有房间攒着的都发出去（服务端关停 / 用户按发送时用） */
  async flushAll() {
    await Promise.all([...this.pending.keys()].map((roomId) => this.#fire(roomId)));
  }

  /** 丢掉某房间攒着的内容（用户终止这一轮时用） */
  drop(roomId) {
    const slot = this.pending.get(roomId);
    if (!slot) return;
    if (slot.timer) clearTimeout(slot.timer);
    this.pending.delete(roomId);
  }

  async #fire(roomId) {
    const slot = this.pending.get(roomId);
    if (!slot || slot.flushing) return;
    if (slot.timer) clearTimeout(slot.timer);

    // 先摘下来再投递：投递过程中新的消息会开一个新槽，
    // 不会被这次 flush 吸进去（否则会无限续期）。
    this.pending.delete(roomId);
    const parts = slot.parts;
    if (!parts.length) return;

    const merged = mergeUserMessages(parts);
    if (parts.length > 1) {
      this.log(`把 ${parts.length} 条连发消息合并后投递：「${merged.slice(0, 60)}…」`);
    }
    try {
      await this.flush(roomId, merged, parts);
    } catch (err) {
      this.log(`合并投递失败：${err?.message ?? err}`);
    }
  }
}
