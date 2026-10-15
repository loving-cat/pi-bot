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
