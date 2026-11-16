/**
 * 「Bot 申请一次权限，用户在手机上点一下」—— 规格 §6.1 的唯一合法姿势。
 *
 * ## 为什么不是"主 Bot 直接给授权"
 *
 * §6.1 第一条：**授权根只能来自已认证的用户交互**。模型、群消息、网页内容
 * 都不是授权来源。如果让主 Bot 自己发一条 grant：
 *
 *   · 一句提示注入就能让它"批准"自己动鼠标、读凭据；
 *   · 之后所有闸都不算数 —— 因为它们都在问"这条 grant 覆盖这次动作吗"，
 *     而 grant 本身是模型写的。
 *
 * 所以拆成两半：
 *
 * | 谁 | 能做什么 |
 * |---|---|
 * | Bot（主 Bot / 部门负责人） | **起草申请**：要什么动作、给哪些 bot、多久、为什么 |
 * | 用户（只在手机上） | **批准/拒绝** —— 批准那一刻系统以**用户**的名义建 grant |
 *
 * 中间那张卡就是 `confirm.js` 的确认票据（`action: 'grant.request'`）：
 * 这个动作名不在动作目录里，于是 `isIrreversible` 默认按不可撤销算 ——
 * **必须走手机通道**，本机桌面上点批准不算数（主 Bot 能操作桌面，它可以自己点）。
 *
 * ## 这个文件只算"批准之后该建哪几条授权"
 *
 * 纯逻辑：给一个申请 + 批准人，算出 grants。不碰 store、不碰网关。
 */

import { ACTION, MODE, RISK, SOURCE } from './grants.js';

/**
 * 通过这条路**能申请**的动作。
 *
 * ★ 这是一张白名单，不是"除了几个以外都能申请"。理由是这张卡要用户
 *   在手机上快速读完 —— 能塞进来的东西越多，用户越只会闭眼点同意。
 *   真正危险的（改规矩、用凭据、对外发送、破坏性 Git、文件删除）走各自
 *   的专门流程，不从这里过。
 */
export const REQUESTABLE_ACTIONS = Object.freeze([
  ACTION.desktopObserve,  // 看屏幕（岛的、用户桌面的）
  ACTION.desktopInput,    // 动鼠标键盘
  ACTION.cmdExec,         // 跑命令（岛上的启动也算这条）
  ACTION.fileRead,
  ACTION.fileWrite,
  ACTION.gitRead,
  ACTION.gitCommit,
]);

const REQUESTABLE = new Set(REQUESTABLE_ACTIONS);

/**
 * 哪些动作"批错了真的会出事" —— 决定这条申请能不能在**本机桌面**上批准。
 *
 * 判据不是"动作危不危险"，而是"给了它之后，它能不能自己把下一张卡点掉"：
 *   · `desktop.input`：能点桌面上的任何东西（包括这张卡）；
 *   · `cmd.exec`：能读本机 token、自己调批准接口；
 *   · `file.write` / `git.commit`：能把东西写坏，且不容易一眼看出来。
 *
 * 只读的那几个（看屏幕、读文件、读仓库）批错了也只是"能看"，
 * 授权面板一眼能收掉 —— 那些允许在桌面上点。
 */
export const NEEDS_DEVICE_CHANNEL = Object.freeze([
  ACTION.desktopInput,
  ACTION.cmdExec,
  ACTION.fileWrite,
  ACTION.gitCommit,
]);

/**
 * 这条申请要求的最低通道。
 *
 * @param {string[]} actions
 * @returns {'local'|'device'}
 */
export function minChannelForRequest({ actions = [] } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  return list.some((a) => NEEDS_DEVICE_CHANNEL.includes(a)) ? 'device' : 'local';
}

/** 一张申请最多覆盖几个 bot（卡上要能数清）。 */
export const MAX_BOTS_PER_REQUEST = 12;
/** 期限上下限：太短没意义，太长就是"永久授权"的别名。 */
export const MIN_TTL_MS = 5 * 60_000;
export const MAX_TTL_MS = 24 * 3600_000;
export const DEFAULT_TTL_MS = 2 * 3600_000;

/**
 * 把 Bot 的申请整理成一张可批准的请求。
 *
 * @param {object} p
 * @param {string[]} p.actions 想申请的动作
 * @param {Array<{id:string, name?:string, role?:string}>} p.bots 想给谁
 * @param {number} [p.ttlMs]
 * @param {string} [p.reason] 为什么要（给人看的）
 * @returns {{ok:true, request:object} | {ok:false, code:string, text:string}}
 */
export function planGrantRequest({ actions = [], bots = [], ttlMs = DEFAULT_TTL_MS, reason = '' } = {}) {
  const wanted = [...new Set((Array.isArray(actions) ? actions : []).map((a) => String(a ?? '')))];
  if (!wanted.length) return { ok: false, code: 'no_actions', text: '没说清要申请什么动作' };
  const bad = wanted.filter((a) => !REQUESTABLE.has(a));
  if (bad.length) {
    return {
      ok: false,
      code: 'action_not_requestable',
      text: `这几个动作不能这样申请：${bad.join('、')}。`
        + `能申请的是：${REQUESTABLE_ACTIONS.join('、')}。其余的去各自的设置里改。`,
    };
  }
  const list = (Array.isArray(bots) ? bots : []).filter((b) => b && b.id);
  if (!list.length) return { ok: false, code: 'no_bots', text: '没说清给哪个 bot' };
  if (list.length > MAX_BOTS_PER_REQUEST) {
    return { ok: false, code: 'too_many_bots', text: `一次最多给 ${MAX_BOTS_PER_REQUEST} 个 bot 申请，太多了卡片上看不清` };
  }
  const ttl = Number(ttlMs);
  const clamped = Number.isFinite(ttl) ? Math.min(Math.max(ttl, MIN_TTL_MS), MAX_TTL_MS) : DEFAULT_TTL_MS;

  return {
    ok: true,
    request: {
      actions: wanted,
      bots: list.map((b) => ({ id: String(b.id), name: String(b.name ?? ''), role: String(b.role ?? '') })),
      ttlMs: clamped,
      reason: String(reason ?? '').trim().slice(0, 300),
    },
  };
}

/**
 * 批准之后该建哪几条授权。
 *
 * ★ 一条 bot 一条（不合并）：
 *   · 撤销是**逐主体**的（删掉一个 bot 要能连带撤它的），合并就撤不干净；
 *   · 审计要能回答"哪个 bot 什么时候拿到的"；
 *   · 期限到期时逐条自然失效，不会因为一条大授权拖住所有人。
 *
 * ★ 模式（mode）必须和那个 bot 的**实际执行模式**一致，否则这条授权在网关
 *   里永远匹配不上（那是张废纸）：
 *     · 主 Bot → `host`（`executionModeOf` 就是这么判的）
 *     · 其余 → `project`
 *   （沙箱化与否要按会话算，这里不猜；`isolated` 的授权由派活侧单独发。）
 *
 * @param {object} p
 * @param {object} p.request `planGrantRequest` 的产物
 * @param {object} p.approvedBy 批准人/设备（写进 sourceRef，审计用）
 * @param {number} [p.now]
 * @param {string|null} [p.policyRevision]
 * @returns {Array<object>} 待 `gate.add()` 的 grant 规格（不含 id，由网关生成）
 */
export function planGrantsFromRequest({ request, approvedBy = {}, now = Date.now(), policyRevision = null } = {}) {
  const actions = Array.isArray(request?.actions) ? request.actions : [];
  const bots = Array.isArray(request?.bots) ? request.bots : [];
  const ttl = Number(request?.ttlMs) || DEFAULT_TTL_MS;
  const who = String(approvedBy?.deviceName ?? '').trim();
  const sourceRef = `用户在批准卡片上同意${who ? `（${who}）` : ''}`
    + `${request?.reason ? `：${request.reason}` : ''}`;
  return bots.map((bot) => ({
    source: SOURCE.user,
    sourceRef: sourceRef.slice(0, 300),
    subject: {
      botId: String(bot.id),
      role: bot.role === 'main' ? 'main' : '',
      instanceId: '',
    },
    taskId: null,
    parentId: null,
    actions: [...actions],
    // 不进资源限制：这批动作的目标是"整台机器/整张桌面"，写个路径反而是假的
    resources: [],
    constraints: {},
    risk: actions.includes(ACTION.desktopInput) ? RISK.high : RISK.medium,
    mode: bot.role === 'main' ? MODE.host : MODE.project,
    canDelegate: false,
    maxUses: null,
    createdAt: now,
    expiresAt: now + ttl,
    // 绑当前规矩版本：规矩变了以后这张授权该重新核对（规格 §6.1）
    policyRevision: policyRevision ? String(policyRevision) : null,
  }));
}

/** 给卡片用的一句话（用户要在手机上一眼读懂）。 */
export function describeGrantRequest({ request, botNames = [] } = {}) {
  const acts = (request?.actions ?? []).map((a) => ACTION_LABELS[a] ?? a);
  const who = botNames.length ? botNames.join('、') : (request?.bots ?? []).map((b) => b.name || b.id).join('、');
  const mins = Math.round((Number(request?.ttlMs) || DEFAULT_TTL_MS) / 60_000);
  const hours = mins >= 60 ? `${Math.round(mins / 6) / 10} 小时` : `${mins} 分钟`;
  return `给 ${who} 开「${acts.join('、')}」，有效 ${hours}`;
}

const ACTION_LABELS = Object.freeze({
  [ACTION.desktopObserve]: '看屏幕',
  [ACTION.desktopInput]: '操作鼠标键盘',
  [ACTION.cmdExec]: '跑命令',
  [ACTION.fileRead]: '读文件',
  [ACTION.fileWrite]: '写文件',
  [ACTION.gitRead]: '读仓库',
  [ACTION.gitCommit]: '本地提交',
});
