/**
 * 危险动作的确认（规格 P0-4）。
 *
 * ## 它要解决的具体问题
 *
 * 规格 §9 那句是全篇最硬的一句：
 *
 *   「同机任意宿主执行可自动化用户界面，因此确认 UI 的真实性必须单独设计，
 *     不能假设同用户随机 nonce 足以防止恶意代码伪造确认。」
 *
 * 翻译成这个产品的语言：**主 Bot 拿到全机 shell 之后，它自己弹的
 * "要不要批准"卡片它可以自己点。** 审批卡片本身不再是安全边界。
 *
 * ## 所以这里做两件事
 *
 * 1. **通道分级**：确认来自哪条通道，决定它算不算数。
 *      · `local`  —— 本机桌面进程。主 Bot 能驱动它，所以只算"弱确认"，
 *        只能放行可恢复的动作（写文件、跑测试）。
 *      · `device` —— 已配对的独立设备（手机）。它跑在另一个进程、通常
 *        另一个 OS 上，主 Bot 摸不到，所以算"强确认"。
 *    强确认才放行不可恢复动作（push、删除、对外发送）。
 *
 * 2. **绑定实际目标**：确认记录里存目标的摘要（层次化哈希），
 *    执行时再算一次 —— 对不上就作废。规格 §9「目标变化则重新确认」。
 *
 * ## 不做的事
 *
 *   · 不做"点一次批准，接下来 10 分钟随便推"的窗口：那是把
 *     不可恢复动作降级成可恢复动作的风险，规格 §6.2 明确要逐次。
 *   · 不在确认里存凭据。它只有摘要和给人看的文字。
 */
import crypto from 'node:crypto';
import { isIrreversible } from './action-catalog.js';

/** 动作的风险档：这一档的"做错了能不能撤销"。 */
export const REVERSIBILITY = Object.freeze({
  /** 可以撤销/重来：写文件、跑命令、本地提交 */
  reversible: 'reversible',
  /** 不可撤销：push、永久删除、对外发送、付款 */
  irreversible: 'irreversible',
});

/**
 * 这条动作做错了能不能撤销。
 *
 * ★ 清单在 `action-catalog.js`（`ACTIONS[x].irreversible`），不在这里另存一份。
 *
 *   原来这里有个 `IRREVERSIBLE_ACTIONS` 集合，网关那边又有自己的风险档，
 *   两边各写各的：新增动作时得记得改两处，漏一处就是“确认层觉得可撤销、
 *   审计层标的是 high”。现在唯一来源是动作目录，本文件只负责把布尔值
 *   翻成给界面看的枚举。
 *
 *   目录里没登记的动作按**不可撤销**算（`isIrreversible` 的默认值就是 true）——
 *   拿不准就往严了算：漏判的代价是“该确认的没确认”，误判只是多点一次。
 */
export function reversibilityOf(action) {
  return isIrreversible(action)
    ? REVERSIBILITY.irreversible
    : REVERSIBILITY.reversible;
}

/** 确认通道。数值越小越"可被主 Bot 影响"。 */
export const CHANNEL = Object.freeze({
  /** 本机桌面进程 —— 主 Bot 能驱动它 */
  local: 'local',
  /** 已配对的独立设备（手机）—— 主 Bot 摸不到 */
  device: 'device',
});

/**
 * 这条通道够不够格确认这个动作。
 *
 * @param {string} channel
 * @param {string} action
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function channelSuffices(channel, action) {
  if (reversibilityOf(action) === REVERSIBILITY.reversible) return { ok: true };
  if (channel === CHANNEL.device) return { ok: true };
  return {
    ok: false,
    reason: '这个动作不可撤销，必须在**手机 App**（已配对的独立设备）上确认。'
      + '本机桌面上的批准不算数 —— 主 Bot 能操作桌面，它可以自己点。',
  };
}

/**
 * 按"这条确认要求的最低通道"判，而不是按动作名。
 *
 * ## 为什么要能单独指定
 *
 * 有的确认的严重程度取决于**它批的是什么**，而不是它叫什么。
 * 最典型的是「权限申请」（`grant.request`）：申请"看屏幕"和申请"动鼠标 + 跑命令"
 * 用同一个动作名，危险程度差一个数量级。
 *
 * 所以：
 *   · 只读类申请 → 桌面点一下就行（批错了也只是"能看"，授权面板一眼能收）；
 *   · 会动手的（动鼠标 / 跑命令 / 写文件 / 提交）→ 仍然手机；
 *   · **用户显式开了「允许在本机批准」**（默认关）→ 桌面也算数，
 *     代价写在设置页和卡片上：一个有跑命令能力的 bot 理论上能自己点批准。
 *
 * @param {object} p
 * @param {string} p.channel `CHANNEL.local` | `CHANNEL.device`
 * @param {string} p.action 动作名（没给 minChannel 时按它推）
 * @param {'local'|'device'} [p.minChannel] 这条确认要求的最低通道
 * @param {boolean} [p.allowLocal] 用户是否显式允许本机批准
 */
export function channelSufficesFor({ channel, action, minChannel = null, allowLocal = false } = {}) {
  const need = minChannel === 'local' || minChannel === 'device'
    ? minChannel
    : (reversibilityOf(action) === REVERSIBILITY.reversible ? 'local' : 'device');
  if (need === 'local') return { ok: true, need };
  if (channel === CHANNEL.device) return { ok: true, need };
  if (allowLocal === true) return { ok: true, need, weakened: true, reason: '按本机批准设置放行' };
  return {
    ok: false,
    need,
    reason: '这条要你**在手机上**点。'
      + (need === 'device'
        ? '本机桌面上的批准不算数 —— 能跑命令的 bot 理论上可以自己点。'
        : '')
      + '如果你不用手机端，可以在设置里打开「允许在本机批准」（会记审计，并且明确写着代价）。',
  };
}

/** 确认的有效期：不可恢复动作短，可恢复动作略长。 */
export function ttlFor(action) {
  return reversibilityOf(action) === REVERSIBILITY.irreversible ? 5 * 60_000 : 30 * 60_000;
}

/**
 * 稳定序列化（键排序），用来算目标摘要。
 *
 * 为什么不用 JSON.stringify：键顺序不同会得到不同摘要，
 * 同一个目标会反复"看起来变了"，用户被要求重复确认。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 目标的摘要。
 *
 * @param {object} target 实际目标（远端名、refspec、文件 id 列表、收件人…）
 * @returns {string}
 */
export function digestOf(target) {
  return crypto.createHash('sha256').update(stableStringify(target ?? {})).digest('hex');
}

/**
 * 造一条确认请求（不落盘，纯数据）。
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.action        网关动作名（grants.js 的 ACTION）
 * @param {object} p.target        绑定的实际目标
 * @param {string} [p.summary]     给人看的一句话（必须说清会有什么后果）
 * @param {object} [p.display]     展示用的结构化信息（提交范围、文件名列表…），不含凭据
 * @param {string} [p.requestedBy] 谁发起的（botId / 'user'）
 * @param {string} [p.roomId]
 * @param {string} [p.taskRunId]
 * @param {string} [p.policyRevision]
 * @param {number} [p.now]
 * @returns {object}
 */
export function buildConfirmation({
  id, action, target, summary = '', display = null,
  requestedBy = null, roomId = null, taskRunId = null, policyRevision = null, now = Date.now(),
  /** 这条确认要求的最低通道（不给就按动作推）。见 `channelSufficesFor`。 */
  minChannel = null,
} = {}) {
  const act = String(action ?? '');
  return Object.freeze({
    id: String(id ?? ''),
    action: act,
    reversibility: reversibilityOf(act),
    minChannel: minChannel === 'local' || minChannel === 'device' ? minChannel : null,
    targetDigest: digestOf(target),
    summary: String(summary ?? '').slice(0, 500),
    display: display && typeof display === 'object' ? display : null,
    requestedBy,
    roomId,
    taskRunId,
    policyRevision: policyRevision ? String(policyRevision) : null,
    createdAt: now,
    expiresAt: now + ttlFor(act),
    decidedAt: null,
    decision: null,
    decidedByDeviceId: null,
    decidedByDeviceName: '',
    channel: null,
    consumedAt: null,
  });
}

/**
 * 这条确认现在能不能用来执行。
 *
 * 每次执行前都要调 —— 规格 §6.1「在执行边界检查有效性」。
 *
 * @param {object} p
 * @param {object} p.confirmation
 * @param {object} p.target        这次要执行的实际目标
 * @param {number} [p.now]
 * @param {string|null} [p.policyRevision] 当前策略版本
 * @param {boolean} [p.allowLocal] 是否打开了「允许在本机批准」设置
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function checkConfirmation({ confirmation, target, now = Date.now(), policyRevision = null, allowLocal = false } = {}) {
  const c = confirmation;
  if (!c) return { ok: false, code: 'no_confirmation', text: '没有确认记录' };
  if (c.decision === 'denied') {
    return { ok: false, code: 'denied', text: '用户拒绝了这个动作。不要换渠道、换工具或让别的成员代做。' };
  }
  if (c.decision !== 'approved') {
    return { ok: false, code: 'not_approved', text: '这个动作还在等用户在手机上确认' };
  }
  if (c.consumedAt) {
    return { ok: false, code: 'consumed', text: '这次确认已经用过了（一次一用，不能重复执行）' };
  }
  if (now >= Number(c.expiresAt ?? 0)) {
    return { ok: false, code: 'expired', text: '确认已过期，请重新发起' };
  }
  if (c.policyRevision && policyRevision && c.policyRevision !== policyRevision) {
    return { ok: false, code: 'policy_changed', text: '规矩在这之后改过，这次确认作废，请重新发起' };
  }
  const digest = digestOf(target);
  if (digest !== c.targetDigest) {
    // 规格 §9：「确认绑定具体对象、内容/差异…目标变化则重新确认」
    return {
      ok: false,
      code: 'target_changed',
      text: '要执行的目标和用户确认的那个不一样了，必须重新确认',
    };
  }
  const suffices = channelSufficesFor({
    channel: c.channel,
    action: c.action,
    minChannel: c.minChannel ?? null,
    allowLocal: allowLocal === true && c.channelWeakened === true,
  });
  if (!suffices.ok) return { ok: false, code: 'weak_channel', text: suffices.reason };
  return { ok: true };
}

/**
 * 确认的一句话说明（日志/界面用，不含凭据）。
 */
export function describeConfirmation(c) {
  if (!c) return '(无确认)';
  const state = c.decision === 'approved'
    ? `已批准（${c.channel}${c.decidedByDeviceName ? '：' + c.decidedByDeviceName : ''}）`
    : c.decision === 'denied' ? '已拒绝' : '等待确认';
  const rev = c.reversibility === REVERSIBILITY.irreversible ? '不可撤销' : '可撤销';
  return `${c.id}｜${c.action}（${rev}）｜${state}｜${c.summary}`;
}
