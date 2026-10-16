import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const newId = (prefix = '') => prefix + crypto.randomBytes(8).toString('hex');
export const now = () => Date.now();

export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 生成 6 位数字配对码（去掉易混的 0/O/1/I 不影响，纯数字够用） */
export function pairingCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

/** 目标正忙 —— 这不是"不通"，是"排一下队" */export function isBusyError(msg) {  return /正在忙/.test(String(msg ?? ''));
}

/**
 * 派活失败后要不要再试一次？
 *
 * 用户原话："发现不通，就立马反馈给 mainbot，main bot 再去把任务交接给 bot
 * 一次，要重试 3 次至少。"
 *
 * 为什么必须有这个（真事）：三个成员同时在群里干活时，第二个私信直接被打回
 * ——因为 runBotOnce 碰到"目标正忙"是**立刻失败**。于是主控看到的就是
 * "私聊派活这条路不通"，然后就自己上手了。其实对方只是还在忙。
 *
 * 抽成纯函数是为了能单测：重试策略（几次、等多久、什么错该等）是这条链上
 * 最容易写错、也最容易被以后改动弄坏的部分。
 *
 * @param {number} attempt   已经试过几次（从 1 开始）
 * @param {string} error     上一次的失败原因
 * @param {number} waitedMs  已经为它等了多久
 * @param {number} maxAttempts 最多试几次
 * @param {number} waitBudgetMs 总共最多等多久
 * @returns {{retry: boolean, waitMs: number, why: string}}
 */
export function planDispatchRetry({
  attempt,
  error,
  waitedMs = 0,
  maxAttempts = 3,
  waitBudgetMs = 180_000,
} = {}) {
  if (attempt >= maxAttempts) {
    return { retry: false, waitMs: 0, why: `已经试了 ${attempt} 次` };
  }
  // 只有"正忙"值得等。其他错（找不到 bot、起不来）再等也不会变。
  if (!isBusyError(error)) {
    return { retry: false, waitMs: 0, why: '不是排队问题，重试没用' };
  }
  if (waitedMs >= waitBudgetMs) {
    return { retry: false, waitMs: 0, why: '等太久了' };
  }
  // 越等越久，但不超过剩下的预算
  const step = Math.min(5_000 * 2 ** (attempt - 1), waitBudgetMs - waitedMs);
  return { retry: true, waitMs: step, why: '对方还在忙，排一下队' };
}

/**
 * **插队**的落点：插在"正在写的那条回复"之前。
 *
 * 用户插话时，bot 手上那条回复还没写完。如果按普通追加放到最后，
 * 读起来就是"它先答了、我才插话"，因果是反的。插在它前面，
 * 用户读到的就是「我插的话 → 它的回应」。
 *
 * 已经说完（done/error）的消息一律不动 —— 用户已经看过它们了，
 * 再挪位置会让人以为消息在跳。
 *
 * @param {Array<{status?: string}>} list 房间里的消息（按显示顺序）
 * @returns {number} 插入下标
 */
export function insertionPoint(list) {
  const i = list.findIndex((m) => m && m.status === 'streaming');
  return i >= 0 ? i : list.length;
}

/**
 * 出事了该**谁**知晓？—— "组长 / 部长级别"这条规则。
 *
 * 用户原话："做个心跳机制可以给工程师 bot 们，这样如果任务中断了，
 * 组长 / 部长级别的知晓。"
 *
 * 规则（按优先级）：
 *   · 部门里的活 → 先找**组长**（在群里说，用户也看得见"这单断了"）
 *   · 没有组长 / 私聊 / prefer='chief' → 找**主控**
 *   · 出事的 bot 自己就是那个人 → 没必要自己报自己
 *
 * 抽成纯函数是为了单测：这条"该谁知晓"的逻辑一旦写反（比如私聊里去叫组长），
 * 表现是"没人知道断了"，而这件事本身很难从日志里看出来。
 */
export function pickEscalationHost({
  roomKind = 'dm',
  leadBotId = null,
  fromBotId = null,
  chiefId = null,
  prefer = 'lead',
} = {}) {
  if (prefer === 'lead' && roomKind === 'group' && leadBotId && leadBotId !== fromBotId) {
    return { role: 'lead', hostId: leadBotId };
  }
  if (chiefId && chiefId !== fromBotId) return { role: 'chief', hostId: chiefId };
  // 主控就是出事的那个 → 退回组长（如果有）
  if (leadBotId && leadBotId !== fromBotId && roomKind === 'group') {
    return { role: 'lead', hostId: leadBotId };
  }
  return { role: null, hostId: null };
}

/**
 * 叫它的这个人是它的**上级**吗？
 *
 * 用户原话："无论多忙 当组长 部长 自己上级@的时候 必须先停下来听最新的要求，
 * 同时上报目前自己的进度。"
 *
 * 所以这里要回答的是：这次 @ 值不值得**打断**它手上的活。
 *   · 用户  → 最高权威，必须停
 *   · 组长/部长（这个部门的 lead）→ 它的直接上级，必须停
 *   · 主控（总经理）→ 全队的上级，必须停
 *   · 同级的同事 → 不用停，排队等它忙完就行（不然群里会互相打断成一锅粥）
 *
 * 抽成纯函数是因为这条规则一旦写反（比如同事也能打断），表现是群里互相掐断，
 * 排查起来很费劲。
 */
export function isSuperiorCall({
  fromId = null,
  fromRole = null,
  leadId = null,
  chiefId = null,
  selfId = null,
} = {}) {
  if (fromRole === 'user') return true;
  if (!fromId || fromId === selfId) return false;
  if (leadId && fromId === leadId) return true;
  if (chiefId && fromId === chiefId) return true;
  return false;
}
