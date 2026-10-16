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
