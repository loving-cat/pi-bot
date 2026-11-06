/** 运行统计：已报告用量、请求恢复次数及有界日汇总；不存提示词与凭据。 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './util.js';

export const MAX_EVENTS = 2000;
export const MAX_DAYS = 90;
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'inputTotal'];
const count = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const sumKnown = (a, b) => a == null ? b : (b == null ? a : a + b);
const positiveInt = (value, fallback = 1) => Math.max(1, Math.floor(count(value) ?? fallback));
const nonnegativeInt = (value) => Math.floor(count(value) ?? 0);

/** SDK 的 input 不含缓存；原始 prompt_tokens 为总输入，未知字段保持 null。 */
export function normalizeUsage(source = {}) {
  const usage = source ?? {};
  const cacheRead = count(usage.cacheRead ?? usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
  const cacheWrite = count(usage.cacheWrite ?? usage.cache_creation_input_tokens
    ?? usage.prompt_tokens_details?.cache_write_tokens);
  const output = count(usage.output ?? usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens);
  let input = count(usage.input ?? usage.inputTokens ?? usage.input_tokens ?? usage.prompt_cache_miss_tokens);
  let inputTotal = count(usage.inputTotal ?? usage.prompt_tokens);
  const partial = nonnegativeInt(usage.missingUsage) > 0 || nonnegativeInt(usage.unknownUsageRecords) > 0;
  if (!partial && inputTotal == null && input != null && cacheRead != null && cacheWrite != null) {
    inputTotal = input + cacheRead + cacheWrite;
  }
  if (!partial && input == null && inputTotal != null && cacheRead != null && cacheWrite != null) {
    input = Math.max(0, inputTotal - cacheRead - cacheWrite);
  }
  return { input, output, cacheRead, cacheWrite, inputTotal };
}

/** 已知总输入中缓存读取的占比；缺失缓存字段时不将未知显示为零命中。 */
export function cacheHitRate(usage = {}) {
  if (nonnegativeInt(usage?.missingCacheUsage) || nonnegativeInt(usage?.unknownCacheRecords)) return null;
  const normalized = normalizeUsage(usage);
  if (normalized.inputTotal == null || normalized.cacheRead == null || normalized.inputTotal <= 0) return null;
  return Math.min(1, normalized.cacheRead / normalized.inputTotal);
}

/** 累加一次 run 内所有 assistant 响应；模型多步调用不算重试。 */
export class RunUsage {
  constructor() {
    this.calls = 0;
    this.retries = 0;
    this.missingUsage = 0;
    this.missingCacheUsage = 0;
    this.totals = Object.fromEntries(USAGE_FIELDS.map((field) => [field, null]));
  }

  add(usage) {
    const normalized = normalizeUsage(usage);
    this.calls++;
    if (USAGE_FIELDS.some((field) => normalized[field] == null)) this.missingUsage++;
    if (normalized.inputTotal == null || normalized.cacheRead == null) this.missingCacheUsage++;
    for (const field of USAGE_FIELDS) {
      this.totals[field] = sumKnown(this.totals[field], normalized[field]);
    }
  }

  retry() { this.retries++; }

  snapshot() {
    return {
      ...Object.fromEntries(USAGE_FIELDS.map((field) => [field, this.calls ? this.totals[field] : null])),
      calls: this.calls,
      missingUsage: this.calls ? this.missingUsage : 1,
      missingCacheUsage: this.calls ? this.missingCacheUsage : 1,
    };
  }
}

/** 每条记录对应一次 run；attemptIndex 标记外层尝试，sdkRetries 只计本次内部恢复。 */
export function makeRecord({
  at = Date.now(), roomId = '', botId = '', model = '', provider = '', ms = 0,
  usage = null, attempts = 1, taskRunId = '', attemptIndex = 1, sdkRetries = null,
  ok = true, kind = '',
} = {}) {
  const normalized = normalizeUsage(usage);
  const innerRetries = sdkRetries == null ? positiveInt(attempts) - 1 : nonnegativeInt(sdkRetries);
  const index = positiveInt(attemptIndex);
  return {
    at, roomId, botId, model, provider,
    ms: Math.round(count(ms) ?? 0),
    ...normalized,
    missingUsage: Math.max(nonnegativeInt(usage?.missingUsage),
      USAGE_FIELDS.some((field) => normalized[field] == null) ? 1 : 0),
    missingCacheUsage: Math.max(nonnegativeInt(usage?.missingCacheUsage),
      normalized.inputTotal == null || normalized.cacheRead == null ? 1 : 0),
    calls: nonnegativeInt(usage?.calls),
    taskRunId: String(taskRunId ?? '').slice(0, 160),
    attemptIndex: index,
    attempts: 1 + innerRetries,
    retries: innerRetries + (index > 1 ? 1 : 0),
    ok: ok !== false,
    kind,
  };
}

/** 运行记录汇总；总量是已知部分，完整性和未知记录数单独返回。 */
export function summarize(records = []) {
  const out = {
    runs: 0, succeeded: 0, failed: 0,
    ...Object.fromEntries(USAGE_FIELDS.map((field) => [field, null])),
    totalMs: 0, attempts: 0, retries: 0, retried: 0,
    unknownUsageRecords: 0, unknownCacheRecords: 0,
  };
  const durations = [];
  for (const record of records) {
    if (!record) continue;
    out.runs++;
    if (record.ok) out.succeeded++; else out.failed++;
    const usage = normalizeUsage(record);
    for (const field of USAGE_FIELDS) out[field] = sumKnown(out[field], usage[field]);
    if (nonnegativeInt(record.missingUsage) || USAGE_FIELDS.some((field) => usage[field] == null)) {
      out.unknownUsageRecords++;
    }
    if (nonnegativeInt(record.missingCacheUsage) || usage.inputTotal == null || usage.cacheRead == null) {
      out.unknownCacheRecords++;
    }
    const attempts = positiveInt(record.attempts);
    const retries = record.retries == null ? attempts - 1 : nonnegativeInt(record.retries);
    out.attempts += attempts;
    out.retries += retries;
    if (retries > 0) out.retried++;
    const ms = count(record.ms) ?? 0;
    out.totalMs += ms;
    if (ms > 0) durations.push(ms);
  }
  out.usageComplete = out.runs > 0 && out.unknownUsageRecords === 0;
  out.cacheHitRate = out.unknownCacheRecords ? null : cacheHitRate(out);
  out.avgMs = out.runs ? Math.round(out.totalMs / out.runs) : 0;
  durations.sort((a, b) => a - b);
  const percentile = (q) => durations.length
    ? durations[Math.min(durations.length - 1, Math.floor(durations.length * q))] : null;
  out.p50Ms = percentile(0.5);
  out.p90Ms = percentile(0.9);
  return out;
}

/** 按 UTC 日期汇总运行记录。 */
export function aggregateByDay(records = []) {
  const days = new Map();
  for (const record of records) {
    if (!Number.isFinite(Number(record?.at))) continue;
    const date = new Date(Number(record.at));
    if (Number.isNaN(date.getTime())) continue;
    const day = date.toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(record);
  }
  return Object.fromEntries([...days].map(([day, list]) => [day, summarize(list)]));
}

/** 聚合总量可相加；没有原始样本时不伪造合并后的分位数。 */
function mergeStats(a, b) {
  const merged = {};
  for (const field of ['runs', 'succeeded', 'failed', 'totalMs', 'attempts', 'retries', 'retried',
    'unknownUsageRecords', 'unknownCacheRecords']) {
    merged[field] = (count(a[field]) ?? 0) + (count(b[field]) ?? 0);
  }
  for (const field of USAGE_FIELDS) merged[field] = sumKnown(count(a[field]), count(b[field]));
  if (a.unknownUsageRecords == null) merged.unknownUsageRecords += count(a.runs) ?? 0;
  if (a.unknownCacheRecords == null) merged.unknownCacheRecords += count(a.runs) ?? 0;
  merged.usageComplete = merged.runs > 0 && merged.unknownUsageRecords === 0;
  merged.cacheHitRate = merged.unknownCacheRecords ? null : cacheHitRate(merged);
  merged.avgMs = merged.runs ? Math.round(merged.totalMs / merged.runs) : 0;
  merged.p50Ms = null;
  merged.p90Ms = null;
  return merged;
}

export class RunStats {
  constructor({ file = '', maxEvents = MAX_EVENTS, maxDays = MAX_DAYS } = {}) {
    this.file = file;
    this.maxEvents = positiveInt(maxEvents, MAX_EVENTS);
    this.maxDays = positiveInt(maxDays, MAX_DAYS);
    this.records = [];
    this.days = {};
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) this.days = raw.days;
      if (Array.isArray(raw?.records)) {
        this.records = raw.records.filter((record) => record && typeof record === 'object').map((record) =>
          record.missingUsage == null
            ? { ...record, missingUsage: 1, missingCacheUsage: 1 } : record);
      }
      for (const [day, stat] of Object.entries(this.days)) {
        if (!stat || typeof stat !== 'object') { delete this.days[day]; continue; }
        if (stat.unknownUsageRecords == null) {
          this.days[day] = { ...stat, unknownUsageRecords: count(stat.runs) ?? 0,
            unknownCacheRecords: count(stat.runs) ?? 0, usageComplete: false, cacheHitRate: null };
        }
      }
      this.#trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') log('读取运行统计失败：', error?.message || error);
    }
  }

  record(entry) {
    const row = makeRecord(entry);
    this.records.push(row);
    this.#trim();
    this.#scheduleSave();
    return row;
  }

  #trim() {
    const overflow = this.records.length - this.maxEvents;
    if (overflow > 0) {
      for (const [day, stat] of Object.entries(aggregateByDay(this.records.splice(0, overflow)))) {
        this.days[day] = this.days[day] ? mergeStats(this.days[day], stat) : stat;
      }
    }
    const keys = Object.keys(this.days).sort();
    while (keys.length > this.maxDays) delete this.days[keys.shift()];
  }

  #scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ records: this.records, days: this.days }));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      log('写入运行统计失败：', error?.message || error);
    }
  }

  recent(limit = 100) {
    return summarize(this.records.slice(-Math.min(this.maxEvents, positiveInt(limit, 100))));
  }

  day(day) {
    const records = this.records.filter((record) => {
      const date = new Date(record.at);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
    });
    const archived = this.days[day];
    if (archived && records.length) return mergeStats(archived, summarize(records));
    return records.length ? summarize(records) : archived ?? null;
  }
}
