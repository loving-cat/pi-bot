/**
 * 站点接入草稿：主控抓完页面后**先把结论摊给用户看**，确认了才真入库。
 *
 * ## 为什么不直接建
 *
 * 自动探测会猜错（登录路径、字段名、哪些接口算"模块"）。猜错了直接建出一个
 * 连不上的系统，用户还得去设置里删，比先确认一遍更烦。
 * 所以流程是：
 *   1. 主控用 MCP / web_fetch 去抓，把发现的东西写进一张草稿
 *   2. 草稿里带上"将要建什么"的完整清单
 *   3. 用户确认 → 才 addSite + 建团队
 *
 * ## 草稿存哪儿
 *
 * 存在内存里（不落盘）：它是**待确认的中间态**，进程重启就没了才是对的 ——
 * 留着一堆半成品草稿比丢了更麻烦（用户会不知道哪个是有效的）。
 */
import { now, newId } from './util.js';

/** 一份草稿最多挂多久（毫秒）。超时自动清掉，避免内存里堆一堆僵尸草稿 */
const DRAFT_TTL_MS = 60 * 60 * 1000;

/** 一份草稿最多列多少个模块 */
const MAX_MODULES = 40;

/** 模块名/路径的长度上限 */
const MAX_NAME = 60;
const MAX_PATH = 200;
const MAX_NOTE = 300;

/**
 * 站点接入草稿箱。
 *
 * 一把钥匙对应一份草稿（roomId + botId）：同一个会话里重复提交是**更新**
 * 而不是新建 —— 主控补抓了几个模块，应当补齐而不是产生两套互相打架的清单。
 */
export class SiteDraftStore {
  /** @type {Map<string, object>} */
  #drafts = new Map();

  #key(roomId, botId) {
    return `${roomId}::${botId}`;
  }

  /** 清掉过期草稿 */
  #sweep() {
    const cutoff = now() - DRAFT_TTL_MS;
    for (const [key, draft] of this.#drafts) {
      if (draft.updatedAt < cutoff) this.#drafts.delete(key);
    }
  }

  /**
   * 提交/更新一份草稿。
   *
   * @param {object} p
   * @param {string} p.roomId
   * @param {string} p.botId
   * @param {object} p.data
   * @returns {{draft:object}|{error:string}}
   */
  upsert({ roomId, botId, data = {} }) {
    this.#sweep();
    const key = this.#key(roomId, botId);
    const existing = this.#drafts.get(key) ?? null;

    const name = String(data.name ?? existing?.name ?? '').trim().slice(0, MAX_NAME);
    if (!name) return { error: '需要给这个系统起个名字' };

    const baseUrl = String(data.baseUrl ?? existing?.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { error: '站点地址要以 http:// 或 https:// 开头' };
    }

    // ★ 换了系统就把旧模块清掉。
    //   否则用户说"改成另一个站点"时，上一家的模块会残在清单里 ——
    //   建出来的团队会拿着 A 系统的接口路径去查 B 系统，一直 404。
    const switched = Boolean(existing) &&
      (existing.baseUrl !== baseUrl || existing.name !== name);
    const derived = switched ? [] : (existing?.modules ?? []);

    // 模块清单：允许分批提交（主控抓完一页先记一笔，再继续抓）
    const incoming = Array.isArray(data.modules) ? data.modules : [];
    const merged = new Map();
    for (const m of [...derived, ...incoming]) {
      const path = String(m?.path ?? '').trim().slice(0, MAX_PATH);
      if (!path) continue;
      const label = String(m?.name ?? m?.label ?? path).trim().slice(0, MAX_NAME) || path;
      merged.set(path, {
        name: label,
        path,
        note: String(m?.note ?? m?.description ?? '').trim().slice(0, MAX_NOTE),
        // 哪些方法验证过（GET/POST…），界面上能看出"这个只读过、没写过"
        verified: Boolean(m?.verified),
      });
    }
    const modules = [...merged.values()].slice(0, MAX_MODULES);
    if (!modules.length) {
      return {
        error:
          '至少要抓到一个模块（接口路径）。先抓首页/接口列表，把发现的 /api/... 路径填进来。',
      };
    }

    const draft = {
      id: existing?.id ?? newId('sd_'),
      roomId,
      botId,
      name,
      baseUrl,
      account: String(data.account ?? existing?.account ?? '').trim().slice(0, 200),
      // 口令单独存：确认时才会被用到，回显给用户时要打码
      password: String(data.password ?? existing?.password ?? '').slice(0, 200),
      loginPath: String(data.loginPath ?? existing?.loginPath ?? '').trim().slice(0, MAX_PATH),
      modules,
      // 主控自己补的说明（比如"这个系统有三块：资产/交易/报表"）
      summary: String(data.summary ?? existing?.summary ?? '').trim().slice(0, 1000),
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      confirmed: false,
    };
    this.#drafts.set(key, draft);
    return { draft };
  }

  get(roomId, botId) {
    this.#sweep();
    return this.#drafts.get(this.#key(roomId, botId)) ?? null;
  }

  /**
   * 标记为已确认（真正入库后调），并移除草稿。
   * @returns {object|null} 被移除的草稿
   */
  consume(roomId, botId) {
    const key = this.#key(roomId, botId);
    const draft = this.#drafts.get(key) ?? null;
    if (draft) this.#drafts.delete(key);
    return draft;
  }

  /** 丢弃草稿（用户说"算了不接了"） */
  discard(roomId, botId) {
    return this.#drafts.delete(this.#key(roomId, botId));
  }
}

export const siteDrafts = new SiteDraftStore();

/**
 * 把草稿变成给用户确认的文本。
 *
 * 要一眼能看出"接了会发生什么"：建几个模块、用哪个账号、地址对不对。
 * 口令**绝不出现在文本里** —— 它是要发到聊天里的，会进模型上下文和聊天记录。
 *
 * @param {object} draft
 * @returns {string}
 */
export function describeDraftForConfirm(draft = {}) {
  const lines = [
    `我摸清了「${draft.name}」的结构，确认一下再接进来：`,
    '',
    `地址：${draft.baseUrl}`,
    `账号：${draft.account || '（没填）'}${draft.password ? '（口令已收到）' : '（还没给口令）'}`,
    ...(draft.loginPath ? [`登录接口：${draft.loginPath}`] : []),
    '',
    `摸到 ${draft.modules.length} 个模块：`,
    ...draft.modules.map((m, i) => `  ${i + 1}. ${m.name}  ${m.path}${m.note ? ` —— ${m.note}` : ''}`),
  ];
  if (draft.summary) lines.push('', draft.summary);
  lines.push(
    '',
    '确认后我会：把它加进「系统接入」，并自动建一个专门管这个系统的团队。',
    '要改哪里直接说（名字、模块、账号都能改）；不想接就说「算了」。',
  );
  return lines.join('\n');
}

/**
 * 给确认卡片用的选项。
 *
 * 只有两个选项而不是一堆：这一步只需要回答"接不接"。
 * 要改就直接打字说 —— 卡片写不下所有可能的修改方式。
 */
export function draftConfirmOptions(draft = {}) {
  return [
    { label: '确认，接进来', detail: `建 ${draft.modules.length} 个模块 + 一个管理团队` },
    { label: '算了，不接', detail: '丢弃这次抓到的内容' },
  ];
}
