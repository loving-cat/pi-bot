/**
 * 任务请求回执：首次接单前的持久去重、并发预约与崩溃恢复。
 *
 * ## 读结果原则（沿用批次 02）
 *
 *   · 只有真正 ENOENT 才算「不存在」；
 *   · 有效 JSON 但缺 receipt、身份不符、版本未知、字段损坏 → 一律「不确定」，
 *     调用方必须如实失败，**不能当新请求继续，更不能重跑理解轮**。
 *
 * ## 阶段
 *
 *   received  —— 宿主已收到请求、尚未开始理解轮
 *   running   —— 理解轮进行中（并发第二个请求不得再起一轮）
 *   accepted  —— 已持久接单（带 taskRunId）
 *   answered  —— 普通回答/澄清，不进执行
 *   failed    —— 本次失败，允许用同一 requestId 重试（不新建任务）
 *
 * 重启规则：running 超过 leaseMs 且没有对应 TaskRun → 允许同一请求重试；
 * 若 TaskRunStore 按 requester+requestId 能找到任务 → 重建 accepted，绝不重跑理解。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, newId } from '../util.js';

/** 回执文件格式版本；未知版本不按新请求处理。 */
export const RECEIPT_VERSION = 1;
const STAGES = new Set(['received', 'running', 'accepted', 'answered', 'failed']);

/** 稳定的回执键：同一认证身份 + 同一请求 ID。 */
export function receiptKey(requesterId, requestId) {
  return Buffer.from(requesterId + '::' + requestId).toString('base64url');
}

/**
 * @param {object} p
 * @param {string} p.dir 回执目录
 * @param {()=>number} [p.clock]
 * @param {number} [p.leaseMs] running 超时后可被同一请求重试
 */
export function createRequestReceipts({ dir, clock = () => Date.now(), leaseMs = 15 * 60 * 1000 } = {}) {
  if (!dir) throw new Error('回执需要目录');
  const fileOf = (key) => path.join(dir, key + '.json');

  function readRaw(requesterId, requestId) {
    if (!requesterId || !requestId) {
      return { status: 'corrupt', code: 'bad_identity', text: '回执身份不合法' };
    }
    let raw;
    try {
      raw = fs.readFileSync(fileOf(receiptKey(requesterId, requestId)), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { status: 'absent' };
      return { status: 'corrupt', code: 'receipt_read_failed', text: '回执读取失败：' + (err?.message || err) };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'corrupt', code: 'receipt_bad_json', text: '回执不是有效 JSON' };
    }
    if (!parsed || parsed.version !== RECEIPT_VERSION) {
      return { status: 'corrupt', code: 'receipt_bad_version', text: '回执版本不认识，拒绝继续' };
    }
    const receipt = parsed.receipt;
    if (!receipt || typeof receipt !== 'object') {
      return { status: 'corrupt', code: 'receipt_missing', text: '回执缺少内容' };
    }
    if (receipt.requesterId !== requesterId || receipt.requestId !== requestId) {
      return { status: 'corrupt', code: 'receipt_identity_mismatch', text: '回执身份与请求不一致' };
    }
    if (typeof receipt.fingerprint !== 'string' || !receipt.fingerprint) {
      return { status: 'corrupt', code: 'receipt_bad_fingerprint', text: '回执缺少内容指纹' };
    }
    if (!STAGES.has(receipt.stage)) {
      return { status: 'corrupt', code: 'receipt_bad_stage', text: '回执阶段不认识' };
    }
    // 按阶段校验必要字段：坏记录不能被当成可重新理解的空预约
    if (receipt.stage === 'accepted' && (typeof receipt.taskRunId !== 'string' || receipt.taskRunId.length === 0)) {
      return { status: 'corrupt', code: 'receipt_accepted_missing_task', text: 'accepted 回执缺少 taskRunId' };
    }
    if (receipt.stage === 'running' || receipt.stage === 'received') {
      const started = receipt.stage === 'running' ? receipt.startedAt : (receipt.startedAt ?? receipt.at);
      if (!Number.isFinite(started) || started <= 0) {
        return { status: 'corrupt', code: 'receipt_bad_time', text: '进行中回执缺少有效时间' };
      }
    }
    if (receipt.stage === 'failed' && (typeof receipt.error !== 'string' || receipt.error.length === 0)) {
      return { status: 'corrupt', code: 'receipt_failed_missing_error', text: 'failed 回执缺少原因' };
    }
    return { status: 'ok', receipt };
  }

  return {
    /**
     * 读回执。
     * @returns {{status:'absent'}|{status:'ok',receipt:object}|{status:'corrupt',code:string,text:string}}
     */
    read(requesterId, requestId) {
      return readRaw(requesterId, requestId);
    },

    /**
     * 预约一次请求（理解轮开始前）。
     *
     * @returns {{status:'reserved'|'inflight'|'done'|'conflict'|'corrupt', receipt?:object, code?:string, text?:string}}
     */
    reserve({ requesterId, requestId, fingerprint }) {
      if (!fingerprint) return { status: 'corrupt', code: 'bad_fingerprint', text: '缺少内容指纹' };
      const current = readRaw(requesterId, requestId);
      if (current.status === 'corrupt') return current;
      const at = clock();
      if (current.status === 'ok') {
        const r = current.receipt;
        if (r.fingerprint !== fingerprint) {
          return { status: 'conflict', code: 'request_conflict', text: '同一请求 ID 的内容与已受理记录不一致' };
        }
        if (r.stage === 'accepted' || r.stage === 'answered') return { status: 'done', receipt: r };
        if (r.stage === 'running' || r.stage === 'received') {
          const started = Number(r.startedAt ?? r.at ?? 0);
          if (at - started < leaseMs) return { status: 'inflight', receipt: r };
          // 租约过期：没有任务事实才允许同一请求重试
          const takeover = { ...r, stage: 'running', startedAt: at, at, leaseId: newId('lease_') };
          writeJsonAtomic(fileOf(receiptKey(requesterId, requestId)), { version: RECEIPT_VERSION, receipt: takeover });
          return { status: 'reserved', receipt: takeover, leaseId: takeover.leaseId, reclaimed: true };
        }
        if (r.stage === 'failed') {
          const retry = { ...r, stage: 'running', startedAt: at, at, leaseId: newId('lease_'), retries: Number(r.retries ?? 0) + 1 };
          writeJsonAtomic(fileOf(receiptKey(requesterId, requestId)), { version: RECEIPT_VERSION, receipt: retry });
          return { status: 'reserved', receipt: retry, leaseId: retry.leaseId, retried: true };
        }
      }
      const fresh = {
        requesterId, requestId, fingerprint, stage: 'running', startedAt: at, at,
        leaseId: newId('lease_'),
      };
      try {
        writeJsonAtomic(fileOf(receiptKey(requesterId, requestId)), { version: RECEIPT_VERSION, receipt: fresh });
      } catch (err) {
        return { status: 'corrupt', code: 'receipt_write_failed', text: '回执写入失败：' + (err?.message || err) };
      }
      return { status: 'reserved', receipt: fresh, leaseId: fresh.leaseId };
    },

    /** 写终态（accepted/answered/failed）；同键不同指纹拒绝覆盖。 */
    finish({ requesterId, requestId, fingerprint, stage, taskRunId = null, kind = null, error = null }) {
      if (!STAGES.has(stage) || stage === 'running' || stage === 'received') {
        return { ok: false, code: 'bad_stage', text: '终态阶段不合法' };
      }
      const current = readRaw(requesterId, requestId);
      if (current.status === 'corrupt') return { ok: false, ...current };
      const base = current.status === 'ok' ? current.receipt : { requesterId, requestId, fingerprint, at: clock() };
      if (base.fingerprint !== fingerprint) {
        return { ok: false, code: 'request_conflict', text: '同一请求 ID 的内容与已受理记录不一致' };
      }
      const receipt = {
        ...base, stage, kind: kind ?? base.kind ?? null, taskRunId: taskRunId ?? base.taskRunId ?? null,
        error: error ? String(error).slice(0, 300) : null, finishedAt: clock(),
      };
      try {
        writeJsonAtomic(fileOf(receiptKey(requesterId, requestId)), { version: RECEIPT_VERSION, receipt });
      } catch (err) {
        return { ok: false, code: 'receipt_write_failed', text: '回执写入失败：' + (err?.message || err) };
      }
      return { ok: true, receipt };
    },

    /** 恢复：running 且已有对应 TaskRun → 重建 accepted；返回状态供宿主决定。 */
    recover({ requesterId, requestId, fingerprint, taskRuns }) {
      const current = readRaw(requesterId, requestId);
      if (current.status === 'corrupt') return current;
      const lookupFirst = taskRuns?.findByRequest?.(requesterId, requestId);
      if (lookupFirst?.status === 'indeterminate') {
        return { status: 'corrupt', code: 'lookup_indeterminate', text: '无法确认请求是否已受理，拒绝继续' };
      }
      if (lookupFirst?.status === 'found') {
        const run = lookupFirst.taskRun;
        if (run.request?.fingerprint !== fingerprint) {
          return { status: 'conflict', code: 'request_conflict', text: '任务记录的内容指纹与请求不一致' };
        }
        const base = current.status === 'ok' ? current.receipt : {
          requesterId, requestId, fingerprint, at: clock(),
        };
        const fixed = { ...base, stage: 'accepted', taskRunId: run.id, recovered: true, finishedAt: clock() };
        writeJsonAtomic(fileOf(receiptKey(requesterId, requestId)), { version: RECEIPT_VERSION, receipt: fixed });
        return { status: 'recovered', receipt: fixed, taskRunId: run.id };
      }
      if (current.status === 'absent') return { status: 'absent' };
      const r = current.receipt;
      if (r.fingerprint !== fingerprint) {
        return { status: 'conflict', code: 'request_conflict', text: '同一请求 ID 的内容不一致' };
      }
      if (r.stage === 'accepted' || r.stage === 'answered') return { status: 'done', receipt: r };
      if (r.stage === 'running' || r.stage === 'received') {
        const expired = clock() - Number(r.startedAt ?? r.at ?? 0) >= leaseMs;
        return { status: expired ? 'retryable' : 'inflight', receipt: r };
      }
      return { status: r.stage === 'failed' ? 'retryable' : 'done', receipt: r };
    },
  };
}
