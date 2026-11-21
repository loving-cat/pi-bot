/**
 * 运行数据的**执行**层：真正删文件（路线图之外的运维需求）。
 *
 * 选择逻辑全在 `storage-retention.js`（纯函数）；这里只做三件事：
 *   1. 把磁盘上的清单读出来交给纯函数；
 *   2. 删除前**校验 realpath 严格落在目标子目录内**（防符号链接逃逸 / `..`）；
 *   3. 统计条数与回收字节，异常只记日志不影响其它 scope。
 *
 * ## 这里绝不碰的东西
 *
 * `workspace/`、`state.json`、`rooms/`、`sessions/`、非终态任务、在跑 bot 的实例目录、
 * 仍被引用的附件 —— 都不在任何一个 scope 的删除路径里。附件走
 * `attachments.js` 的 `deleteAttachments()`（留墓碑 + 版本号 + 广播），
 * **任何地方都不许对 `uploads/` 裸 `fs.unlink`**。
 */
import fs from 'node:fs';
import path from 'node:path';

import { log } from './util.js';
import { deleteAttachments, listAttachmentMeta, attachmentSize } from './attachments.js';
import { pruneScreenshots } from './desktop-observe.js';
import { defaultInstanceDir } from './child-env-typed.js';
import {
  STORAGE_RETENTION_DEFAULTS,
  isTerminalTaskRun,
  selectExpiredTaskRunTrees,
  selectExpiredRequestReceipts,
  selectExpiredTmpEntries,
  selectOrphanUploads,
} from './storage-retention.js';

/** 允许请求的 scope（白名单，未知 scope 一律忽略） */
export const STORAGE_SCOPES = Object.freeze([
  'instanceTmp', 'taskRequests', 'taskRuns', 'screenshots', 'orphanUploads',
]);

/** 定时自动清理只跑这三项：**不含截图、不含任何附件** */
export const STORAGE_AUTO_SCOPES = Object.freeze(['instanceTmp', 'taskRequests', 'taskRuns']);

/** 安全四项（工具里的 `scope: 'safe'`）：不含孤儿附件 */
export const STORAGE_SAFE_SCOPES = Object.freeze([
  'instanceTmp', 'taskRequests', 'taskRuns', 'screenshots',
]);

/** 上一次自动清理的时间（进程内节流；server-main 用它避免每分钟全量扫盘） */
export const STORAGE_AUTO_MIN_INTERVAL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- 安全工具

function realDirOf(dataDir, name) {
  try {
    return fs.realpathSync(path.join(dataDir, name));
  } catch {
    return null;
  }
}

/** target 是否**严格**在 root 里（root 自身不算） */
function isInside(rootReal, target) {
  const rel = path.relative(rootReal, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function statSafe(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // 链接不计大小，也不跟进去
    if (entry.isDirectory()) total += dirSize(full);
    else total += sizeOf(full);
  }
  return total;
}

/**
 * 删一个文件，但必须先证明它就在 `rootReal` 里、而且不是符号链接。
 * @returns {number} 回收的字节数（跳过/失败返回 0）
 */
function removeFileInside(rootReal, file) {
  if (!rootReal) return 0;
  const stat = statSafe(file);
  if (!stat || !stat.isFile()) return 0;
  let parentReal;
  try {
    parentReal = fs.realpathSync(path.dirname(file));
  } catch {
    return 0;
  }
  if (parentReal !== rootReal) return 0;
  const bytes = stat.size || 0;
  try {
    fs.unlinkSync(file);
    return bytes;
  } catch (err) {
    log('清理运行数据失败：' + (err?.message || err));
    return 0;
  }
}

/** 删一个子目录（实例目录）：realpath 必须在 root 下，且本身不是符号链接 */
function removeDirInside(rootReal, dir) {
  if (!rootReal) return 0;
  const stat = statSafe(dir);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return 0;
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return 0;
  }
  if (!isInside(rootReal, real)) return 0;
  const bytes = dirSize(real);
  try {
    fs.rmSync(real, { recursive: true, force: true });
    return bytes;
  } catch (err) {
    log('清理实例目录失败：' + (err?.message || err));
    return 0;
  }
}

/** 把任意结构里的字符串都收进集合（任务产物 / 汇总产物可能是 id，也可能是路径） */
function collectStrings(value, into) {
  if (typeof value === 'string') {
    if (value) into.add(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
  return into;
}

/**
 * 算出"仍被引用"的标识集合：全量房间消息的附件 + 现存 TaskRun 的附件/产物 +
 * 未终结主控汇总的产物。
 *
 * ★ 扫不全宁可不删：任何一步抛错就返回 `null`，调用方据此**跳过**孤儿附件清理。
 */
function collectReferencedIds({ store }, logFn) {
  try {
    const ids = new Set();
    for (const room of store.listRooms() ?? []) {
      for (const msg of store.listMessages(room.id, { limit: 100000 }) ?? []) {
        for (const att of msg?.attachments ?? []) {
          if (att?.id) ids.add(String(att.id));
        }
      }
    }
    const scan = typeof store.taskRuns?.listAll === 'function' ? store.taskRuns.listAll() : null;
    for (const run of scan?.taskRuns ?? []) {
      collectStrings(run?.attachments ?? [], ids);
      collectStrings(run?.artifacts ?? [], ids);
    }
    for (const batch of store.pendingChiefSummaries?.() ?? []) {
      collectStrings(batch?.artifacts ?? [], ids);
      collectStrings(batch?.targets ?? [], ids);
    }
    return ids;
  } catch (err) {
    logFn?.('收集附件引用失败，跳过孤儿附件清理：' + (err?.message || err));
    return null;
  }
}

/** 当前在跑的 bot（用实例目录名表示：`instances/<safeKey>`） */
function busyBotKeys({ store, runner }) {
  const keys = new Set();
  if (!runner?.isBusy) return keys;
  const rooms = store.listRooms?.() ?? [];
  for (const bot of store.listBots?.() ?? []) {
    for (const room of rooms) {
      try {
        if (runner.isBusy(room.id, bot.id)) {
          const dir = defaultInstanceDir('/instances', bot.id);
          keys.add(path.basename(dir));
          break;
        }
      } catch {
        // 判忙失败就当不忙（清理工具不该因此整个失败）
      }
    }
  }
  return keys;
}

// ---------------------------------------------------------------- 各 scope

function sweepInstanceTmp({ store, runner, dataDir, now, ttlMs, dryRun, summary }) {
  const root = realDirOf(dataDir, 'instances');
  if (!root) return;
  const busy = busyBotKeys({ store, runner });
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => {
        const full = path.join(root, e.name);
        const stat = statSafe(full);
        return { name: e.name, mtimeMs: stat?.mtimeMs ?? 0, full };
      });
  } catch {
    return;
  }
  summary.skippedBusyBots = busy.size;
  const expired = selectExpiredTmpEntries(entries, { busyBotKeys: busy, now, ttlMs });
  for (const entry of expired) {
    summary.removed.instanceTmp += 1;
    if (dryRun) {
      summary.reclaimedBytes += dirSize(entry.full);
      continue;
    }
    summary.reclaimedBytes += removeDirInside(root, entry.full);
  }
}

function sweepTaskRuns({ store, dataDir, now, opts, dryRun, summary }) {
  const root = realDirOf(dataDir, 'taskruns');
  if (!root) return;
  const scan = typeof store.taskRuns?.listAll === 'function' ? store.taskRuns.listAll() : null;
  const runs = scan?.taskRuns ?? [];
  // 读不完整时**不删**：`problems` 里的 id 可能正好是被引用/未终结的那棵树
  if (scan && scan.complete === false) {
    summary.problems.push(`taskruns 读取不完整（${scan.problems?.length ?? 0} 条），本次跳过`);
    return;
  }
  const picked = selectExpiredTaskRunTrees(runs, opts);
  for (const id of picked.taskRunIds) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue; // 文件名只允许安全字符
    summary.removed.taskRuns += 1;
    const file = path.join(root, `${id}.json`);
    if (dryRun) {
      summary.reclaimedBytes += sizeOf(file);
      continue;
    }
    summary.reclaimedBytes += removeFileInside(root, file);
  }
}

function sweepTaskRequests({ store, dataDir, now, ttlMs, dryRun, summary }) {
  const root = realDirOf(dataDir, 'task-requests');
  if (!root) return;
  const scan = typeof store.taskRuns?.listAll === 'function' ? store.taskRuns.listAll() : null;
  const runs = scan?.taskRuns ?? [];
  if (scan && scan.complete === false) {
    summary.problems.push('taskruns 读取不完整，无法判断回执是否仍指向活任务，本次跳过回执清理');
    return;
  }
  const activeTaskRunIds = new Set(
    runs.filter((run) => !isTerminalTaskRun(run)).map((run) => String(run.id)),
  );
  let names = [];
  try {
    names = fs.readdirSync(root).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  const receipts = [];
  for (const name of names) {
    const file = path.join(root, name);
    if (statSafe(file)?.isSymbolicLink?.()) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const receipt = parsed?.receipt;
      if (!receipt || typeof receipt !== 'object') continue;
      receipts.push({ ...receipt, file, name });
    } catch {
      // 坏文件不删（可能是崩溃现场，留给人工看）
    }
  }
  const expired = selectExpiredRequestReceipts(receipts, { activeTaskRunIds, now, ttlMs });
  for (const receipt of expired) {
    summary.removed.taskRequests += 1;
    if (dryRun) {
      summary.reclaimedBytes += sizeOf(receipt.file);
      continue;
    }
    summary.reclaimedBytes += removeFileInside(root, receipt.file);
  }
}

function sweepOrphanUploads({ store, dataDir, now, ttlMs, dryRun, summary, logFn }) {
  // 只在"uploads 目录属于本次 dataDir"时才跑：attachments.js 是进程级单例
  const root = realDirOf(dataDir, 'uploads');
  if (!root) return;
  const referenced = collectReferencedIds({ store }, logFn);
  if (!referenced) {
    summary.problems.push('无法完整收集附件引用，跳过孤儿附件清理');
    return;
  }
  const uploads = listAttachmentMeta().map((meta) => ({
    ...meta,
    size: attachmentSize(meta.id),
  }));
  const orphans = selectOrphanUploads(uploads, { referencedIds: referenced, now, ttlMs });
  if (!orphans.length) return;
  summary.removed.orphanUploads += orphans.length;
  summary.reclaimedBytes += orphans.reduce((n, item) => n + (Number(item.size) || 0), 0);
  if (dryRun) return;
  // ★ 只有这一条删除路径：留墓碑 + 版本号 + 广播，绝不裸 unlink
  const result = deleteAttachments(orphans.map((item) => item.id));
  summary.removed.orphanUploads = result.deleted.length;
  if (result.failed.length) summary.problems.push(`附件删除失败 ${result.failed.length} 个`);
}

/**
 * 跑一次清理。
 *
 * @param {object} p
 * @param {object} p.store
 * @param {object} [p.runner]
 * @param {string} p.dataDir
 * @param {string[]} [p.scopes] 默认安全四项；`orphanUploads` 必须显式给
 * @param {boolean} [p.dryRun] 只统计不删（工具默认 true）
 * @param {number} [p.now]
 * @param {object} [p.limits] 覆盖 `STORAGE_RETENTION_DEFAULTS`
 * @param {Function} [p.logFn]
 */
export function runStorageHousekeeping({
  store,
  runner = null,
  dataDir,
  scopes = STORAGE_SAFE_SCOPES,
  dryRun = false,
  now = Date.now(),
  limits = {},
  logFn = log,
} = {}) {
  const summary = {
    dryRun: Boolean(dryRun),
    scopes: [],
    removed: { instanceTmp: 0, taskRequests: 0, taskRuns: 0, screenshots: 0, orphanUploads: 0 },
    reclaimedBytes: 0,
    skippedBusyBots: 0,
    problems: [],
  };
  if (!store || !dataDir) {
    summary.problems.push('缺少 store 或 dataDir');
    return summary;
  }
  const wanted = new Set((Array.isArray(scopes) ? scopes : []).filter((s) => STORAGE_SCOPES.includes(s)));
  const cfg = { ...STORAGE_RETENTION_DEFAULTS, ...limits };
  const guard = (label, fn) => {
    summary.scopes.push(label);
    try {
      fn();
    } catch (err) {
      summary.problems.push(`${label}: ${err?.message || err}`);
      logFn?.('清理运行数据失败：' + (err?.message || err));
    }
  };

  if (wanted.has('instanceTmp')) {
    guard('instanceTmp', () =>
      sweepInstanceTmp({
        store, runner, dataDir, now, ttlMs: cfg.instanceTmpTtlMs, dryRun, summary,
      }));
  }
  if (wanted.has('taskRequests')) {
    guard('taskRequests', () =>
      sweepTaskRequests({
        store, dataDir, now, ttlMs: cfg.requestReceiptTtlMs, dryRun, summary,
      }));
  }
  if (wanted.has('taskRuns')) {
    guard('taskRuns', () =>
      sweepTaskRuns({
        store, dataDir, now, dryRun, summary,
        opts: { now, ttlMs: cfg.taskRunTtlMs, maxTerminal: cfg.taskRunMaxTerminal },
      }));
  }
  if (wanted.has('screenshots')) {
    guard('screenshots', () => {
      if (dryRun) {
        // `pruneScreenshots` 只能直接删（没有预演接口），dryRun 下**不调**它，
        // 并把这件事说清楚 —— 不能让用户以为"预演说 0 张就不用清"。
        summary.problems.push('截图清理没有预演实现，dryRun 下未统计');
        return;
      }
      const pruned = pruneScreenshots({ dataDir });
      summary.removed.screenshots = pruned?.removed ?? 0;
    });
  }
  if (wanted.has('orphanUploads')) {
    guard('orphanUploads', () =>
      sweepOrphanUploads({
        store, dataDir, now, ttlMs: cfg.orphanUploadTtlMs, dryRun, summary, logFn,
      }));
  }

  return summary;
}
