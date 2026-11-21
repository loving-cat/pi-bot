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
import {
  deleteAttachments, listAttachmentMeta, attachmentSize, attachmentsRoot,
  attachmentDeletionRevision,
} from './attachments.js';
import { shells as defaultShells } from './shells.js';
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

/**
 * 目录树里**最新的** mtime（跳过符号链接）。
 *
 * ★ 不能只看 `instances/<key>` 顶层目录自身的 mtime：`home/`、`tmp/` 里写文件
 *   不会更新父目录的 mtime —— 一个正在干活的实例，顶层目录可能"老"了 20 天。
 *   判断"这个实例还有人用"必须看树里最新的活动。
 */
function latestMtimeMs(dir) {
  let latest = 0;
  const walk = (target) => {
    const stat = statSafe(target);
    if (!stat) return;
    if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    let entries = [];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) walk(path.join(target, entry.name));
  };
  walk(dir);
  return latest;
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
 *
 * @returns {{ ok: boolean, bytes: number, reason?: string }}
 *   `ok` 只在**真的删掉**时为 true —— 调用方据此决定要不要递增计数
 *   （以前返回 0 分不清"文件本来就没有"和"删失败了"）。
 */
function removeFileInside(rootReal, file) {
  if (!rootReal) return { ok: false, bytes: 0, reason: '目录不可用' };
  const stat = statSafe(file);
  if (!stat || !stat.isFile()) return { ok: false, bytes: 0, reason: '不是普通文件' };
  let parentReal;
  try {
    parentReal = fs.realpathSync(path.dirname(file));
  } catch {
    return { ok: false, bytes: 0, reason: '父目录解析失败' };
  }
  if (parentReal !== rootReal) return { ok: false, bytes: 0, reason: '不在目标目录内' };
  const bytes = stat.size || 0;
  try {
    fs.unlinkSync(file);
    return { ok: true, bytes };
  } catch (err) {
    log('清理运行数据失败：' + (err?.message || err));
    return { ok: false, bytes: 0, reason: String(err?.message || err) };
  }
}

/** 删一个子目录（实例目录）：realpath 必须在 root 下，且本身不是符号链接 */
function removeDirInside(rootReal, dir) {
  if (!rootReal) return { ok: false, bytes: 0, reason: '目录不可用' };
  const stat = statSafe(dir);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, bytes: 0, reason: '不是普通目录' };
  }
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return { ok: false, bytes: 0, reason: 'realpath 失败' };
  }
  if (!isInside(rootReal, real)) return { ok: false, bytes: 0, reason: '不在目标目录内' };
  const bytes = dirSize(real);
  try {
    fs.rmSync(real, { recursive: true, force: true });
    return { ok: true, bytes };
  } catch (err) {
    log('清理实例目录失败：' + (err?.message || err));
    return { ok: false, bytes: 0, reason: String(err?.message || err) };
  }
}

/**
 * 把任意结构里的字符串收进集合，并顺手把**路径形式**的引用拆成附件 id。
 *
 * 为什么需要拆：任务产物 / 汇总产物里常见的是 `uploads/<id>.png` 或
 * `.../<id>.pdf`，而 `selectOrphanUploads` 比的是纯 `id`。不拆的话，
 * 一个被任务产物引用着的附件会被当成孤儿删掉。
 *
 * 拆法（任一命中都算引用）：原串、basename、去扩展名的 basename、
 * 以及串里出现的 18 位十六进制片段（附件 id 是 `randomBytes(9).toString('hex')`）。
 */
function collectRefStrings(value, into) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return into;
    into.add(text);
    const base = path.basename(text);
    if (base && base !== text) into.add(base);
    const noExt = base.replace(/.[A-Za-z0-9]{1,8}$/, '');
    if (noExt && noExt !== base) into.add(noExt);
    for (const match of text.matchAll(/[0-9a-f]{18}/gi)) into.add(match[0].toLowerCase());
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefStrings(item, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectRefStrings(item, into);
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
    // 读不全就可能漏掉"正被引用"的附件 —— 宁可整项不删
    if (scan && scan.complete === false) {
      logFn?.('taskruns 读取不完整，无法完整计算附件引用，跳过孤儿附件清理');
      return null;
    }
    for (const run of scan?.taskRuns ?? []) {
      collectRefStrings(run?.attachments ?? [], ids);
      collectRefStrings(run?.artifacts ?? [], ids);
      // 真实产物位置：每次尝试的结果、交付产物、进度证据
      for (const attempt of run?.attempts ?? []) {
        collectRefStrings(attempt?.result?.artifacts ?? [], ids);
      }
      collectRefStrings(run?.delivery?.artifacts ?? [], ids);
      collectRefStrings(run?.progress?.evidence ?? [], ids);
    }
    // ★ 扫**全量**汇总（含 collecting / sent）：只扫 pending 会漏掉正在收集与已发出的产物
    for (const batch of store.chiefSummaries?.() ?? []) {
      collectRefStrings(batch?.artifacts ?? [], ids);
      collectRefStrings(batch?.targets ?? [], ids);
    }
    return ids;
  } catch (err) {
    logFn?.('收集附件引用失败，跳过孤儿附件清理：' + (err?.message || err));
    return null;
  }
}

/**
 * 当前在跑的实例目录名（`instances/<safeKey>`）。
 *
 * 两种 key 都要收：
 *   · `bot.id` —— 按 bot 分的实例目录；
 *   · `${room.id}-${bot.id}` —— `shells.js` 给后台命令建的目录（它的 home/tmp 就在这里）。
 *
 * 后台 shell 还在跑（`running === true`）也一并保护：进程活着的目录绝对不能删。
 */
function busyBotKeys({ store, runner, shellRegistry = null }) {
  const keys = new Set();
  const add = (rawKey) => {
    const dir = defaultInstanceDir('/instances', rawKey);
    const name = path.basename(dir);
    if (name) keys.add(name);
  };
  const rooms = store?.listRooms?.() ?? [];
  for (const bot of store?.listBots?.() ?? []) {
    if (!runner?.isBusy) continue;
    let busyAnywhere = false;
    for (const room of rooms) {
      try {
        // 不能 break：同一个 bot 可能在多个房间同时有活，
        // 每个房间的 `${roomId}-${botId}` 目录都要单独保护
        if (runner.isBusy(room.id, bot.id)) {
          add(`${room.id}-${bot.id}`);
          busyAnywhere = true;
        }
      } catch {
        // 判忙失败就当不忙（清理工具不该因此整个失败）
      }
    }
    // 按 bot 分的目录只在它真的忙时才保护
    if (busyAnywhere) add(bot.id);
  }
  for (const key of shellRegistry?.runningKeys?.() ?? []) add(key);
  return keys;
}

// ---------------------------------------------------------------- 各 scope

function sweepInstanceTmp({ store, runner, shellRegistry, dataDir, now, ttlMs, dryRun, summary }) {
  const root = realDirOf(dataDir, 'instances');
  if (!root) return;
  const busy = busyBotKeys({ store, runner, shellRegistry });
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => {
        const full = path.join(root, e.name);
        // ★ 用整棵树里最新的 mtime：只看顶层目录会被 home/ tmp/ 的写入骗过去
        return { name: e.name, mtimeMs: latestMtimeMs(full), full };
      });
  } catch {
    return;
  }
  summary.skippedBusyBots = busy.size;
  const expired = selectExpiredTmpEntries(entries, { busyBotKeys: busy, now, ttlMs });
  for (const entry of expired) {
    if (dryRun) {
      summary.removed.instanceTmp += 1;
      summary.reclaimedBytes += dirSize(entry.full);
      continue;
    }
    const result = removeDirInside(root, entry.full);
    if (result.ok) {
      summary.removed.instanceTmp += 1;
      summary.reclaimedBytes += result.bytes;
    } else {
      summary.problems.push(`instanceTmp/${entry.name}: ${result.reason ?? '删除失败'}`);
    }
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
    const file = path.join(root, `${id}.json`);
    if (dryRun) {
      summary.removed.taskRuns += 1;
      summary.reclaimedBytes += sizeOf(file);
      continue;
    }
    const result = removeFileInside(root, file);
    if (result.ok) {
      summary.removed.taskRuns += 1;
      summary.reclaimedBytes += result.bytes;
    } else {
      summary.problems.push(`taskRuns/${id}.json: ${result.reason ?? '删除失败'}`);
    }
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
    if (dryRun) {
      summary.removed.taskRequests += 1;
      summary.reclaimedBytes += sizeOf(receipt.file);
      continue;
    }
    const result = removeFileInside(root, receipt.file);
    if (result.ok) {
      summary.removed.taskRequests += 1;
      summary.reclaimedBytes += result.bytes;
    } else {
      summary.problems.push(`taskRequests/${receipt.name ?? receipt.file}: ${result.reason ?? '删除失败'}`);
    }
  }
}

function sweepOrphanUploads({ store, dataDir, now, ttlMs, dryRun, summary, logFn }) {
  // ★ attachments.js 是**进程级单例**（绑定 config.dataDir）：只有在要清的 dataDir
  //   就是本进程正在用的那个时才敢动，否则会删到别的实例的附件索引里去。
  const root = realDirOf(dataDir, 'uploads');
  if (!root) return;
  let singletonRoot = null;
  try {
    singletonRoot = fs.realpathSync(attachmentsRoot());
  } catch {
    singletonRoot = null;
  }
  if (!singletonRoot || singletonRoot !== root) {
    summary.problems.push('上传目录与附件索引不在同一个数据目录，跳过孤儿附件清理');
    return;
  }
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
  if (result.deleted.length) {
    // 与 http.js 的 DELETE /api/attachments 保持同一形状：客户端靠 revision 刷新
    const revision = attachmentDeletionRevision();
    try {
      store.bus?.emit?.('event', { t: 'attachments.deleted', ids: result.deleted, revision });
    } catch (err) {
      summary.problems.push(`广播附件删除事件失败: ${err?.message || err}`);
    }
  }
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
  shellRegistry = defaultShells,
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
        store, runner, shellRegistry, dataDir, now, ttlMs: cfg.instanceTmpTtlMs, dryRun, summary,
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
