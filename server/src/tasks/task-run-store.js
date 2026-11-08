/**
 * TaskRun **独立持久存储**。
 *
 * ## 为什么独立于 `store.js` 的任务板
 *
 * 任务板是手工待办，超过 500 条就裁剪且不区分状态。
 * 持续任务混进去会被挤掉。所以独自一份文件：`data/taskruns/<id>.json`。
 *
 * ## 三条来自批次 02 首轮审查的硬约束
 *
 * ### 1. 写排队 ≠ 事务（B01）
 *
 * 原来只有文件写排队，读-改-写仍在锁外：两次并发各读到旧余额，各写回，额度被用两次。
 * 现在所有修改都走 `mutate()`：**读最新 → 校验 → 归约 → 写回**在同一临界区完成。
 *
 * ```js
 * await store.mutate(id, { expectSequence, mutate: (current) => {...} })
 * ```
 *
 * ### 2. 去重事实必须随任务一起持久化（B02）
 *
 * 原来幂等靠一个独立的 `_request-index.json`。索引写失败或裁剪后，
 * 同一个请求会被重新接单，磁盘留下两条任务。
 * 现在**请求身份直接写在任务记录里**（`request: { requesterId, requestId, fingerprint }`）。
 * 索引只是可重建的加速视图；它丢了、坏了、裁了，都不影响去重。
 *
 * ### 3. 加载/保存不能绕过任务契约（B03）
 *
 * 原来 `load` 读什么给什么，`save` 什么状态都收。于是：
 *   · 文件名 `tr_a` 里可以放 `tr_b` 的记录；
 *   · 旧快照能覆盖已取消的任务（cancelled → queued）；
 *   · 读取失败被当成「不存在」，触发重建。
 *
 * 现在：读区分「不存在 / 读失败 / 损坏 / 版本不支持」四种情况；
 * 保存前核对文件名与记录 ID、核对请求身份、跑批次 01 的契约校验；
 * 更新必须带期望序号，旧快照写不进去。
 *
 * ### 4. 占位单向迁移（B04）
 *
 * `reserved → started → settled` 只能往前。重复预留同一 ID 只复用或拒绝，
 * 绝不把 `started` 打回 `reserved`。
 */
import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic, readJson, now } from '../util.js';
import { validateTaskRun } from './task-reduce.js';
import {
  PHASE as ATTEMPT_PHASE,
  planReserve,
  planStart,
  planSettle,
  planRefund,
  classify,
  occupiesQuota,
} from './task-attempt-lifecycle.js';

/** 记录格式版本。 */
export const TASKRUN_STORE_VERSION = 2;



/**
 * 执行占位的阶段。
 *
 * ★ 审查第三轮：阶段定义与迁移规则**只在一处**（`task-attempt-lifecycle.js`）。
 *   原来存储层自己定义一套 SLOT_RANK，协调器又定义一套，
 *   两边对 `refunded` 的理解必然分叉。现在统一转发。
 */
export const ATTEMPT_SLOT = ATTEMPT_PHASE;

/** 读取结果类型。★ 不能把「读失败」和「不存在」混为一谈（B03）。 */
export const LOAD_RESULT = Object.freeze({
  found: 'found',
  missing: 'missing',
  readFailed: 'read_failed',
  corrupt: 'corrupt',
  unsupportedVersion: 'unsupported_version',
  identityMismatch: 'identity_mismatch',
});

/**
 * 合法任务 ID。
 *
 * ★ B03：与批次 01 工厂的 `isId` 用**同一个正则**。
 *   原来本模块额外禁止 `_` 开头，而工厂允许，于是 `_request-index` 这类 ID
 *   在工厂那边合法、在这里被静默丢弃 —— 两处规则不同就是缺陷。
 *   现在内部索引文件已取消（去重事实落在任务记录里），不存在与内部文件抢名字的问题。
 */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 存储并发版本字段名。
 *
 * ★ B03（第二轮）：`sequence` 是**事件序号**，不是存储并发版本。
 *   预算扣减和占位登记**都不改变 sequence**，所以「序号没变小」证明不了「这不是旧快照」。
 *   实测：reserveRootBudget 之后 sequence 仍是 0，用预留前那个 sequence=0 的快照 save
 *   依然成功，把 usedRuns=1 和占位一起抹掉。
 *
 *   三者的区别必须分清：
 *
 *     revision   目标版本（用户改了目标才 +1）
 *     sequence   事件序号（每接受一个事件 +1）
 *     storeVersion 存储并发版本（**任何**持久变更都 +1，包括仅改预算/占位）
 *
 *   `storeVersion` 由存储层自己维护，业务代码不碰。
 */
export const STORE_VERSION_FIELD = 'storeVersion';

/**
 * 占位表的键：任务 + 尝试。
 *
 * ★ 审查第三轮 B05：同一份预留必须能被**同一身份**找到。
 *   协调器用 `${taskRunId}::${attemptId}`，存储层也必须用同一个键，
 *   否则两边各记一份、互相对不上（实测：started 后根退款仍成功）。
 */
export function slotKey(taskRunId, attemptId) {
  return `${taskRunId}::${attemptId}`;
}

function isTaskId(v) {
  return typeof v === 'string' && TASK_ID_RE.test(v);
}

function isAnyId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
}

/**
 * 事务冲突：调用方拿的是旧快照。
 *
 * ★ 这是**正常的乐观并发控制**，不是错误 —— 调用方应重新读取后再试。
 */
export class StaleWriteError extends Error {
  constructor(message, { expected, actual } = {}) {
    super(message);
    this.name = 'StaleWriteError';
    this.code = 'stale_write';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * TaskRun 存储。
 */
export class TaskRunStore {
  constructor({ dir }) {
    if (!dir) throw new Error('TaskRunStore 需要 dir');
    this.dir = dir;
    /** 事务队列：**整个读-改-写** 排在这里，不是只排文件写 */
    this.txChain = Promise.resolve();
    this.txDepth = 0;
    this.maxTxDepth = 0;
    /** 内存缓存：避免同一事务里重复读盘 */
    this.cache = new Map();
  }

  // -------------------------------------------------------------------------
  // 路径
  // -------------------------------------------------------------------------

  #fileOf(taskRunId) {
    return path.join(this.dir, `${taskRunId}.json`);
  }

  // -------------------------------------------------------------------------
  // 事务串行化
  // -------------------------------------------------------------------------

  /**
   * 把一个完整事务排进队列。
   *
   * ★ 与原来的 `#serialize` 区别：那个只排「写文件」这一步，
   *   读发生在排队之前；两个并发调用都先读到旧值，再各自写回，后者覆盖前者。
   *   这里**整段**在队列内，后一个开始前一定读得到前一个的结果。
   */
  #enqueue(fn) {
    const run = this.txChain.then(async () => {
      this.txDepth += 1;
      this.maxTxDepth = Math.max(this.maxTxDepth, this.txDepth);
      try {
        return await fn();
      } finally {
        this.txDepth -= 1;
      }
    });
    // 链条不能因为某次失败断掉
    this.txChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // -------------------------------------------------------------------------
  // 读（区分四种失败）
  // -------------------------------------------------------------------------

  /**
   * 读一条记录，返回**带原因**的结果。
   *
   * ★ B03：调用方必须区分「不存在」和「读失败/损坏」。
   *   把读失败当不存在，会导致「已经取消的任务被当成新任务重建」。
   *
   * @returns {{status:string, taskRun?:object, detail?:string}}
   */
  read(taskRunId) {
    if (!isTaskId(taskRunId)) {
      return { status: LOAD_RESULT.missing, detail: 'ID 不合法' };
    }
    const file = this.#fileOf(taskRunId);

    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { status: LOAD_RESULT.missing };
      // ★ 其他错误（EACCES / EIO / EISDIR …）都是「读失败」，不是不存在
      return { status: LOAD_RESULT.readFailed, detail: err?.message || String(err) };
    }

    let record;
    try {
      record = JSON.parse(raw);
    } catch (err) {
      return { status: LOAD_RESULT.corrupt, detail: err?.message || String(err) };
    }

    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { status: LOAD_RESULT.corrupt, detail: '记录不是对象' };
    }
    if (record.version !== TASKRUN_STORE_VERSION) {
      return {
        status: LOAD_RESULT.unsupportedVersion,
        detail: `记录版本 ${record.version}，本程序支持 ${TASKRUN_STORE_VERSION}`,
      };
    }
    if (!record.taskRun || typeof record.taskRun !== 'object') {
      return { status: LOAD_RESULT.corrupt, detail: '缺少 taskRun 字段' };
    }

    // ★ B03：文件身份核对 —— 文件名必须与记录 ID 一致
    if (record.taskRun.id !== taskRunId) {
      return {
        status: LOAD_RESULT.identityMismatch,
        detail: `文件 ${taskRunId}.json 里装的是任务 ${record.taskRun.id}`,
      };
    }

    // ★ B02/B03（第二轮）：**加载也要跑完整契约与请求身份校验**。
    //   写前有校验不能替代加载校验 —— 磁盘上可能已经存在坏数据
    //   （旧版本程序写的、手工改的、断电截断后又被修好的）。
    //   原来这里只查文件名和 ID，非法 state 的记录照样被当成 found。
    const requestCheck = this.#assertRequestIdentity(record.taskRun);
    if (!requestCheck.ok) {
      return { status: LOAD_RESULT.corrupt, detail: requestCheck.text };
    }
    const contract = validateTaskRun(record.taskRun);
    if (!contract.ok) {
      return {
        status: LOAD_RESULT.corrupt,
        detail: `记录违反任务契约：${contract.text}`,
      };
    }

    return { status: LOAD_RESULT.found, taskRun: record.taskRun };
  }

  /** 只校验请求身份（提取成方法，读/写共用）。 */
  #assertRequestIdentity(taskRun) {
    const req = taskRun?.request;
    if (!req || !isAnyId(req.requesterId) || !isAnyId(req.requestId)) {
      return { ok: false, text: '记录缺少请求身份（requesterId/requestId）' };
    }
    if (typeof req.fingerprint !== 'string' || !req.fingerprint) {
      return { ok: false, text: '记录缺少请求内容指纹' };
    }
    return { ok: true };
  }

  /**
   * 读一条记录。**只有「确实不存在」才返回 null**；其他失败一律返回 null 但会抛错给日志。
   *
   * 这是给「我要用它」的调用方用的便捷方法；要做「存在性判断」请用 `read()`。
   */
  load(taskRunId) {
    const result = this.read(taskRunId);
    return result.status === LOAD_RESULT.found ? result.taskRun : null;
  }

  /** 这条存在吗（不区分读失败）。 */
  has(taskRunId) {
    return this.read(taskRunId).status === LOAD_RESULT.found;
  }

  // -------------------------------------------------------------------------
  // 写（带契约校验与身份核对）
  // -------------------------------------------------------------------------

  /**
   * 校验一条记录能不能落盘。
   *
   * ★ B03：复用批次 01 的契约校验，不在持久层另立一套规则。
   *   同时核对文件名/记录身份、请求身份。
   */
  #assertWritable(taskRun, { expectedId = null, previous = null } = {}) {
    if (!taskRun || typeof taskRun !== 'object') {
      return { ok: false, code: 'bad_record', text: '记录不是对象' };
    }
    if (!isTaskId(taskRun.id)) {
      return { ok: false, code: 'bad_record', text: `任务 ID 不合法：${taskRun.id}` };
    }
    if (expectedId && taskRun.id !== expectedId) {
      return {
        ok: false,
        code: 'identity_mismatch',
        text: `要写的是 ${expectedId}，但记录是 ${taskRun.id}`,
      };
    }

    // 请求身份必须自洽
    const req = taskRun.request;
    if (!req || !isAnyId(req.requesterId) || !isAnyId(req.requestId)) {
      return { ok: false, code: 'bad_record', text: '记录缺少请求身份（requesterId/requestId）' };
    }
    if (typeof req.fingerprint !== 'string' || !req.fingerprint) {
      return { ok: false, code: 'bad_record', text: '记录缺少请求内容指纹' };
    }

    // ★ 复用批次 01 契约
    const contract = validateTaskRun(taskRun);
    if (!contract.ok) {
      return { ok: false, code: 'contract_violation', text: `违反任务契约：${contract.text}` };
    }

    // ★ B05（第三轮）：子任务的可执行状态必须有**根授权**支撑。
    //
    //   审查实测：根额度已耗尽后，子任务没有对应根预留仍能保存 running。
    //   原来只取消了子任务自扣检查，等于「不检查任何授权」。
    //
    //   规则：子任务若带着在途占位或账本里的 registered 执行，
    //   必须在根记录里找到同一 `taskRunId::attemptId` 的授权，且状态一致。
    //   这项检查由 `#assertRootGranted` 完成（需要读根记录，见 save 的跨记录核对）。

    // ★ B05：预算已用次数与账本的关系。
    //
    //   ★ 第二轮修正：**子任务不持有自己的额度**，它的执行向根任务扣。
    //     原来对子任务也要求 `usedRuns >= attempts.length`，于是合法共享根预算的子任务
    //     被误拒（它的 usedRuns 本来就是 0，额度记在根上）。
    //
    //   正确规则：
    //     · 根任务：usedRuns 不得小于**属于它的**账本登记数（有执行必须扣过额）
    //     · 子任务：不做这个检查，改为核对它确实属于某个根
    const isRoot = (taskRun.rootTaskId ?? taskRun.id) === taskRun.id;
    const hasSharedBudget = taskRun.budget?.sharedWithRoot === true;

    if (!isRoot || hasSharedBudget) {
      // 子任务 / 共享根预算：必须能指明根，且不能自带独立额度
      const root = taskRun.rootTaskId ?? taskRun.id;
      if (root === taskRun.id) {
        return {
          ok: false,
          code: 'budget_inconsistent',
          text: '标了共享根预算，但 rootTaskId 指向自己 —— 无法确定该向谁扣额',
        };
      }
      if (Number.isInteger(taskRun.budget?.maxRuns) && taskRun.budget.maxRuns !== null) {
        return {
          ok: false,
          code: 'budget_inconsistent',
          text: '共享根预算的任务不能自带 maxRuns（额度只记在根上）',
        };
      }
    } else if (taskRun.budget && Array.isArray(taskRun.attempts)) {
      // 根任务：账本里的执行必须都扣过额
      const charged = taskRun.budget.usedRuns ?? 0;
      const logged = taskRun.attempts.length;
      if (Number.isInteger(charged) && charged < logged) {
        return {
          ok: false,
          code: 'budget_inconsistent',
          text: `预算已用 ${charged} 次，但账本登记了 ${logged} 次执行 —— 有执行没扣额，拒绝落盘`,
        };
      }
    }

    // ★ 取消/完成是终态，不能被普通写改回去
    if (previous) {
      const wasTerminal = previous.state === 'cancelled' || previous.state === 'completed';
      const isTerminalNow = taskRun.state === 'cancelled' || taskRun.state === 'completed';
      if (wasTerminal && !isTerminalNow) {
        return {
          ok: false,
          code: 'terminal_regression',
          text: `任务已是「${previous.state}」，不能被写回「${taskRun.state}」`,
        };
      }
      if (wasTerminal && isTerminalNow && previous.state !== taskRun.state) {
        return {
          ok: false,
          code: 'terminal_regression',
          text: `终态不能从「${previous.state}」改成「${taskRun.state}」`,
        };
      }
      // 序号不能倒退（能挡住“事件回退”，但挡不住“预算/占位被旧快照抹掉”）
      if (Number.isInteger(previous.sequence) && Number.isInteger(taskRun.sequence)) {
        if (taskRun.sequence < previous.sequence) {
          return {
            ok: false,
            code: 'stale_write',
            text: `序号不能倒退（${previous.sequence} → ${taskRun.sequence}）`,
          };
        }
      }

      // ★ B03（第二轮）：存储并发版本必须匹配。
      //
      //   预算扣减与占位登记**不改变 sequence**，所以只比序号会让旧快照过关：
      //   实测 reserveRootBudget 之后 sequence 仍是 0，用预留前的快照 save 成功，
      //   把 usedRuns=1 和占位一起抹掉。
      //
      //   `storeVersion` 每次写都 +1，因此能覆盖**所有**持久变更。
      //   调用方拿旧版本写 → 拒绝。
      const prevVersion = previous.storeVersion ?? 0;
      const claimedVersion = taskRun.storeVersion ?? 0;
      if (claimedVersion !== prevVersion) {
        return {
          ok: false,
          code: 'stale_write',
          text:
            `这份快照是存储版本 ${claimedVersion}，当前已是 ${prevVersion} ——` +
            '中间有别的变更（可能是预算扣减或执行占位），请重新读取后再改',
        };
      }
      // 请求身份不可变
      if (req.requesterId !== previous.request?.requesterId || req.requestId !== previous.request?.requestId) {
        return { ok: false, code: 'identity_mismatch', text: '请求身份不可变' };
      }
    }

    return { ok: true };
  }

  /**
   * 直接写一条记录（内部用）。
   *
   * ★ 每次写都把 `storeVersion` 加一 —— 这是**任何**持久变更的并发标识，
   *   包括只改预算或只改占位的变更（它们不动 `sequence`）。
   */
  async #write(taskRun, { previousVersion = null } = {}) {
    const nextVersion =
      Number.isInteger(previousVersion) ? previousVersion + 1 : (taskRun.storeVersion ?? 0) + 1;
    const record = { ...taskRun, storeVersion: nextVersion };
    try {
      writeJsonAtomic(this.#fileOf(record.id), {
        version: TASKRUN_STORE_VERSION,
        taskRun: record,
      });
      this.cache.set(record.id, record);
      return { ok: true, taskRun: record };
    } catch (err) {
      return { ok: false, code: 'write_failed', text: `写盘失败：${err?.message || err}` };
    }
  }

  /**
   * 无条件保存（新建或覆盖）。仍然做契约与身份校验。
   *
   * ★ 覆盖已存在的记录时也读一次做「终态/序号不回退」检查 ——
   *   否则旧快照能覆盖取消状态（B03 实测）。
   */
  async save(taskRun) {
    return this.#enqueue(async () => {
      const previous = this.read(taskRun?.id ?? '');
      const prevRun = previous.status === LOAD_RESULT.found ? previous.taskRun : null;

      // 读失败/损坏时**不能**当成不存在去覆盖（B03）
      if (previous.status !== LOAD_RESULT.found && previous.status !== LOAD_RESULT.missing) {
        return {
          ok: false,
          code: previous.status,
          text: `无法确认已有记录状态（${previous.detail ?? previous.status}），拒绝覆盖`,
        };
      }

      const check = this.#assertWritable(taskRun, { expectedId: taskRun?.id, previous: prevRun });
      if (!check.ok) return check;

      // ★ B05：子任务的执行必须有根授权支撑（跨记录核对）
      const grant = this.#assertRootGranted(taskRun, this.#loadRootFor(taskRun));
      if (!grant.ok) return grant;

      return this.#write(taskRun, { previousVersion: prevRun?.storeVersion ?? null });
    });
  }

  /**
   * **受保护的事务入口**（B01 的核心）。
   *
   * 读最新 → 校验 → 调用方归约 → 写回，整段在队列内完成。
   *
   * @param {string} taskRunId
   * @param {object} opts
   * @param {number} [opts.expectSequence] 期望的当前序号；不匹配则拒绝（乐观并发）
   * @param {(current:object|null, ctx:object) => Promise<object>|object} opts.mutate
   *   返回新的 TaskRun；返回 `null` 表示「不需要改」（作幂等成功处理）
   * @returns {Promise<{ok:true, taskRun:object, changed:boolean}|{ok:false, code, text}>}
   */
  async mutate(taskRunId, { expectSequence = null, mutate }) {
    return this.#enqueue(async () => {
      const readResult = this.read(taskRunId);

      // 读失败/损坏：不能当不存在（B03）
      if (readResult.status !== LOAD_RESULT.found && readResult.status !== LOAD_RESULT.missing) {
        return {
          ok: false,
          code: readResult.status,
          text: `读取任务 ${taskRunId} 失败：${readResult.detail ?? readResult.status}`,
        };
      }

      const current = readResult.status === LOAD_RESULT.found ? readResult.taskRun : null;

      // 乐观并发：调用方拿的必须是当前版本
      if (expectSequence !== null) {
        const actual = current?.sequence ?? null;
        if (actual !== expectSequence) {
          return {
            ok: false,
            code: 'stale_write',
            text: `任务已被改动（期望序号 ${expectSequence}，实际 ${actual}），请重新读取`,
          };
        }
      }

      const next = await mutate(current, { read: readResult });

      // undefined/null 表示「不用改」——幂等成功
      if (next === null || next === undefined) {
        return { ok: true, taskRun: current, changed: false };
      }

      // 调用方在事务内主动拒绝（例如前置条件不满足）
      if (next && typeof next === 'object' && next.__reject) {
        return next.__reject;
      }

      const check = this.#assertWritable(next, { expectedId: taskRunId, previous: current });
      if (!check.ok) return check;

      // ★ B05：子任务写回同样核对根授权
      const grant = this.#assertRootGranted(next, this.#loadRootFor(next));
      if (!grant.ok) return grant;

      const written = await this.#write(next, { previousVersion: current?.storeVersion ?? null });
      if (!written.ok) return written;
      return { ok: true, taskRun: written.taskRun, changed: true };
    });
  }

  /**
   * 读一个 TaskRun 的根记录（它自己是根就返回自己）。
   *
   * 读失败返回 null —— 调用方会因此拒绝写入（不确定就不写）。
   */
  #loadRootFor(taskRun) {
    const rootId = taskRun?.rootTaskId ?? taskRun?.id;
    if (!rootId) return null;
    if (rootId === taskRun.id) return taskRun;
    const result = this.read(rootId);
    return result.status === LOAD_RESULT.found ? result.taskRun : null;
  }

  // -------------------------------------------------------------------------
  // 子任务 ↔ 根授权核对（B05）
  // -------------------------------------------------------------------------

  /**
   * 核对一个**子任务**的执行是否有根授权支撑。
   *
   * 审查第三轮实测的三种情形：
   *
   *   1. 根预留 a_child（taskRunId=子），子任务 started —— 必须能找到同一授权；
   *   2. 子任务 running 而根预留停在 reserved —— 说明根不知道子已开始；
   *   3. 根额度耗尽后子任务还想 running —— 没有新授权，必须拒。
   *
   * 规则：
   *
   *   · 子任务的每个在途占位 / registered 执行，都必须在根记录的 attemptSlots 里
   *     找到 `taskRunId + attemptId` 相同的授权；
   *   · 授权必须处于 `reserved` 或 `started`（已结束的授权不能支撑执行）；
   *   · 子任务 `started` 时，根授权也必须至少 `started`（根要知道子已经跑起来）。
   *
   * @returns {{ok:true}|{ok:false, code, text}}
   */
  #assertRootGranted(taskRun, root) {
    const isRoot = (taskRun.rootTaskId ?? taskRun.id) === taskRun.id;
    if (isRoot) return { ok: true };

    // 把根上的授权整理成索引
    const grants = new Map();
    for (const slot of Object.values(root?.attemptSlots ?? {})) {
      if (!slot || !slot.attemptId) continue;
      grants.set(`${slot.taskRunId ?? root.id}::${slot.attemptId}`, slot);
    }

    // ★ 审查第四轮：子占位与子账本**走同一个校验函数**。
    //   原来两个循环各判一套：占位循环查阶段、账本循环只查存在，
    //   于是「只有账本、没有本地占位」时，已退款授权也能支撑 running。
    const checks = [];

    for (const slot of Object.values(taskRun.attemptSlots ?? {})) {
      if (!slot || !slot.attemptId) continue;
      if (slot.phase !== ATTEMPT_PHASE.reserved && slot.phase !== ATTEMPT_PHASE.started) continue;
      checks.push({
        source: 'slot',
        attemptId: slot.attemptId,
        botId: slot.botId,
        revision: slot.revision,
        childPhase: slot.phase,
      });
    }

    for (const attempt of taskRun.attempts ?? []) {
      if (attempt.state !== 'registered') continue;
      checks.push({
        source: 'ledger',
        attemptId: attempt.attemptId,
        botId: attempt.botId,
        revision: attempt.revision,
        // 账本里的 registered 表示「已派发」，等价于子侧已开始
        childPhase: ATTEMPT_PHASE.started,
      });
    }

    for (const check of checks) {
      const verdict = this.#verifyGrant(taskRun, grants, check);
      if (!verdict.ok) return verdict;
    }

    return { ok: true };
  }

  /**
   * 核对**一份**子执行是否有有效根授权。
   *
   * 占位与账本两条入口都调它 —— 规则只有一份。
   *
   * 四项必须同时成立：
   *
   *   1. 根上存在同 `taskRunId::attemptId` 的授权；
   *   2. **执行者相符**（授权给谁就是谁）；
   *   3. **目标版本相符**；
   *   4. 授权未结束，且能支撑当前阶段（已 started 要求根也 started）。
   *
   * 必要身份缺失**不能**当作匹配 —— 说不清是谁的授权，就是没有授权。
   */
  #verifyGrant(taskRun, grants, { source, attemptId, botId, revision, childPhase }) {
    const where = source === 'slot' ? '本地占位' : '账本';
    const key = `${taskRun.id}::${attemptId}`;
    const grant = grants.get(key);

    const missing = [];
    if (!isAnyId(botId)) missing.push('botId');
    if (!Number.isInteger(revision)) missing.push('revision');
    if (missing.length) {
      return {
        ok: false,
        code: 'grant_identity_missing',
        text:
          `子任务${where}里的执行 ${attemptId} 缺少必要身份（${missing.join('、')}），` +
          '无法核对根授权，不能进入可执行状态',
      };
    }

    if (!grant) {
      return {
        ok: false,
        code: 'no_root_grant',
        text:
          `子任务${where}里的执行 ${attemptId} 在根 ${taskRun.rootTaskId} 上没有对应授权 ——` +
          '不能进入可执行状态（额度必须先在根上预留）',
      };
    }

    // ---- 执行者必须相符
    if (!isAnyId(grant.botId) || grant.botId !== botId) {
      return {
        ok: false,
        code: 'grant_bot_mismatch',
        text:
          `子任务${where}里的执行 ${attemptId} 用执行者 ${botId}，` +
          `但根授权的执行者是 ${grant.botId ?? '(未记录)'} —— 不能使用别次的授权`,
      };
    }

    // ---- 目标版本必须相符
    if (!Number.isInteger(grant.revision) || grant.revision !== revision) {
      return {
        ok: false,
        code: 'grant_revision_mismatch',
        text:
          `子任务${where}里的执行 ${attemptId} 属于第 ${revision} 版目标，` +
          `但根授权属于第 ${grant.revision ?? '(未记录)'} 版`,
      };
    }

    // ---- 授权必须还活着
    if (!occupiesQuota(grant.phase)) {
      return {
        ok: false,
        code: 'grant_ended',
        text:
          `根授权 ${attemptId} 已结束（${grant.phase}），不能支撑新的在途执行`,
      };
    }

    // ---- 子已开始，根必须记录了开始
    if (childPhase === ATTEMPT_PHASE.started && grant.phase !== ATTEMPT_PHASE.started) {
      return {
        ok: false,
        code: 'grant_not_started',
        text:
          `子任务${where}里的执行 ${attemptId} 已开始，但根授权仍是 ${grant.phase} ——` +
          '根必须知道子已经开始（否则额度可能被误退）',
      };
    }

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 读全部
  // -------------------------------------------------------------------------

  /**
   * 列出全部 TaskRun（重启恢复用）。
   *
   * ★ B02/B03（第二轮）：返回结果**必须带完整性问题**。
   *   `complete === false` 表示「目录里有些记录读不出来」，
   *   此时**不能**据此宣称「没有重复任务」—— 去重必须保守失败。
   */
  listAll() {
    let names = [];
    let listError = null;
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      // 目录读不出来：不是「空」，是「不确定」
      if (err?.code === 'ENOENT') {
        return { taskRuns: [], skipped: 0, problems: [], complete: true };
      }
      listError = err?.message || String(err);
      return {
        taskRuns: [],
        skipped: 0,
        problems: [{ id: null, status: 'dir_read_failed', detail: listError }],
        complete: false,
      };
    }

    const taskRuns = [];
    const problems = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const result = this.read(id);
      if (result.status === LOAD_RESULT.found) {
        taskRuns.push(result.taskRun);
      } else if (result.status !== LOAD_RESULT.missing) {
        problems.push({ id, status: result.status, detail: result.detail });
      }
    }
    return {
      taskRuns,
      skipped: problems.length,
      problems,
      complete: problems.length === 0,
    };
  }

  /**
   * 按请求身份查找已有任务。
   *
   * ★ B02（第二轮）：**扫描不完整时必须报告，不能静默返回「没找到」**。
   *   原来只取 `taskRuns`、丢掉 `problems`，于是 acceptRequest 把
   *   「无法判断是否存在」当成「确认不存在」，直接新建记录覆盖旧的已取消任务。
   *
   * @returns {{status:'found'|'absent'|'indeterminate', taskRun?:object, problems?:object[]}}
   */
  findByRequest(requesterId, requestId) {
    if (!isAnyId(requesterId) || !isAnyId(requestId)) {
      return { status: 'indeterminate', problems: [{ id: null, status: 'bad_request', detail: '请求身份不合法' }] };
    }
    const scan = this.listAll();
    const hit = scan.taskRuns.find(
      (r) => r.request?.requesterId === requesterId && r.request?.requestId === requestId,
    );
    if (hit) return { status: 'found', taskRun: hit };
    // ★ 扫描不完整：无法断言「没有重复任务」
    if (!scan.complete) {
      return { status: 'indeterminate', problems: scan.problems };
    }
    return { status: 'absent' };
  }

  // -------------------------------------------------------------------------
  // 幂等接单
  // -------------------------------------------------------------------------

  /**
   * 幂等接单。
   *
   * ★ 三轮修复的要点：
   *   1. 去重事实写在任务记录里（无独立索引可丢）；
   *   2. 整个「查重 → 建记录 → 落盘」在同一个事务里，并发同请求只成功一次；
   *   3. **查重不确定时必须失败**（B02 第二轮）：目录扫描不完整、
   *      旧记录读不出来时，不能宣称没重复、不能新建或覆盖旧记录。
   *   4. 落盘失败就完全不算接单。
   */
  async acceptRequest({ requesterId, requestId, fingerprint, build, at = now() }) {
    if (!isAnyId(requesterId)) {
      return { ok: false, code: 'bad_requester', text: '发起人不合法' };
    }
    if (!isAnyId(requestId)) {
      return { ok: false, code: 'bad_request_id', text: 'requestId 必须是稳定标识' };
    }
    if (typeof fingerprint !== 'string' || !fingerprint) {
      return { ok: false, code: 'bad_fingerprint', text: '缺少请求内容指纹' };
    }

    return this.#enqueue(async () => {
      const lookup = this.findByRequest(requesterId, requestId);

      // ★ 查重不确定：明确失败，绝不新建
      if (lookup.status === 'indeterminate') {
        return {
          ok: false,
          code: 'lookup_indeterminate',
          text:
            '无法确认这个请求是否已经受理过（有记录读不出来），' +
            '为避免重复接单，本次不建新任务；请先修复可读性再重试',
          problems: lookup.problems ?? [],
        };
      }

      if (lookup.status === 'found') {
        const existing = lookup.taskRun;
        if (existing.request.fingerprint !== fingerprint) {
          return {
            ok: false,
            code: 'request_conflict',
            text: `请求 ${requestId} 已受理过，但这次内容不同 —— 同一请求 ID 不能配不同内容`,
          };
        }
        return { ok: true, taskRun: existing, created: false, existing: true };
      }

      // ---- 确认不存在，可以新建
      const built = build(at, null);
      if (!built || typeof built !== 'object') {
        return { ok: false, code: 'bad_record', text: '构造出的 TaskRun 不合法' };
      }

      const record = {
        ...built,
        request: { requesterId, requestId, fingerprint, acceptedAt: at },
      };

      const check = this.#assertWritable(record, { expectedId: record.id });
      if (!check.ok) return check;

      const written = await this.#write(record, { previousVersion: 0 });
      if (!written.ok) {
        return { ok: false, code: 'write_failed', text: `接单失败（未能落盘）：${written.text}` };
      }

      return { ok: true, taskRun: written.taskRun, created: true, existing: false };
    });
  }

  // -------------------------------------------------------------------------
  // 执行占位（B04：单向迁移）
  // -------------------------------------------------------------------------

  /**
   * 预留一次执行（任务自身视角）。
   *
   * ★ 所有阶段判断走 `task-attempt-lifecycle.js` 的统一规则：
   *   `refunded` / `settled` 不能被复用，`reserved` / `started` 才复用。
   */
  async reserveAttempt(taskRunId, { attemptId, botId = null, revision = null, at = now() }) {
    if (!isAnyId(attemptId)) {
      return { ok: false, code: 'bad_attempt', text: 'attemptId 不合法' };
    }
    return this.mutate(taskRunId, {
      mutate: (current) => {
        if (!current) {
          return { __reject: { ok: false, code: 'not_found', text: `任务 ${taskRunId} 不存在` } };
        }
        const slots = { ...(current.attemptSlots ?? {}) };
        const key = slotKey(current.id, attemptId);
        const existing = slots[key];

        const plan = planReserve(existing, { attemptId });
        if (!plan.ok) return { __reject: plan };
        if (plan.action === 'reuse') return null;

        slots[key] = {
          attemptId,
          taskRunId: current.id,
          botId,
          revision,
          phase: ATTEMPT_PHASE.reserved,
          reservedAt: at,
          startedAt: null,
          settledAt: null,
        };
        return { ...current, attemptSlots: slots, updatedAt: at };
      },
    }).then((out) => {
      if (out.ok) return { ok: true, taskRun: out.taskRun, reused: !out.changed };
      return out;
    });
  }

  /** 标记执行已开始（统一规则判能否推进）。 */
  async markAttemptStarted(taskRunId, { attemptId, botId = null, revision = null, at = now() }) {
    return this.mutate(taskRunId, {
      mutate: (current) => {
        if (!current) {
          return { __reject: { ok: false, code: 'not_found', text: `任务 ${taskRunId} 不存在` } };
        }
        const slots = { ...(current.attemptSlots ?? {}) };
        const key = slotKey(current.id, attemptId);
        const existing = slots[key];

        const plan = planStart(existing, { taskRunId: current.id, botId, revision });
        if (!plan.ok) return { __reject: plan };
        if (plan.action === 'reuse') return null;

        slots[key] = { ...existing, phase: ATTEMPT_PHASE.started, startedAt: at };
        return { ...current, attemptSlots: slots, updatedAt: at };
      },
    });
  }

  /** 标记执行已结算（统一规则判能否推进）。 */
  async markAttemptSettled(taskRunId, { attemptId, botId = null, revision = null, at = now() }) {
    return this.mutate(taskRunId, {
      mutate: (current) => {
        if (!current) {
          return { __reject: { ok: false, code: 'not_found', text: `任务 ${taskRunId} 不存在` } };
        }
        const slots = { ...(current.attemptSlots ?? {}) };
        const key = slotKey(current.id, attemptId);
        const existing = slots[key];
        if (!existing) return null; // 没走预留入口的执行，不强行创建占位

        const plan = planSettle(existing, { taskRunId: current.id, botId, revision });
        if (!plan.ok) return { __reject: plan };
        if (plan.action === 'reuse') return null;

        slots[key] = {
          ...existing,
          phase: ATTEMPT_PHASE.settled,
          startedAt: existing.startedAt ?? at,
          settledAt: at,
        };
        return { ...current, attemptSlots: slots, updatedAt: at };
      },
    });
  }

  /** 退还一次预留（统一规则判能否退）。 */
  async markAttemptRefunded(taskRunId, { attemptId, botId = null, revision = null, at = now() }) {
    return this.mutate(taskRunId, {
      mutate: (current) => {
        if (!current) {
          return { __reject: { ok: false, code: 'not_found', text: `任务 ${taskRunId} 不存在` } };
        }
        const slots = { ...(current.attemptSlots ?? {}) };
        const key = slotKey(current.id, attemptId);
        const existing = slots[key];

        const plan = planRefund(existing, { taskRunId: current.id, botId, revision });
        if (!plan.ok) return { __reject: plan };
        if (plan.action === 'reuse') return null;

        slots[key] = { ...existing, phase: ATTEMPT_PHASE.refunded, refundedAt: at };
        return { ...current, attemptSlots: slots, updatedAt: at };
      },
    });
  }

  // -------------------------------------------------------------------------
  // 重启恢复
  // -------------------------------------------------------------------------

  /**
   * 重启时给每个占位分类。
   *
   * | 阶段 | 含义 | 重启后 |
   * |---|---|---|
   * | reserved 且从未 started | 未开始 | 释放占位 |
   * | started 未 settled | **结果未知** | 保留 |
   * | settled | 已确认完成 | 无需处理 |
   */
  static classifyOnRestart(taskRun) {
    const slots = Object.values(taskRun?.attemptSlots ?? {});
    const notStarted = [];
    const unknown = [];
    const settled = [];
    for (const slot of slots) {
      if (slot.phase === ATTEMPT_SLOT.settled) settled.push(slot);
      else if (slot.phase === ATTEMPT_SLOT.reserved && !slot.startedAt) notStarted.push(slot);
      else unknown.push(slot);
    }
    return { notStarted, unknown, settled };
  }

  /**
   * 重启恢复：只释放「未开始」的占位。
   *
   * ★ 「结果未知」的保留原样 —— 真跑了却没记，重复执行会写出重复文件。
   */
  static releaseNotStarted(taskRun, { at = now() } = {}) {
    const { notStarted, unknown } = TaskRunStore.classifyOnRestart(taskRun);
    if (!notStarted.length) {
      return {
        ok: true,
        taskRun,
        released: [],
        unknown: unknown.map((s) => s.attemptId),
        changed: false,
      };
    }
    const slots = { ...(taskRun.attemptSlots ?? {}) };
    for (const slot of notStarted) delete slots[slotKey(slot.taskRunId, slot.attemptId)];
    return {
      ok: true,
      taskRun: { ...taskRun, attemptSlots: slots, updatedAt: at },
      released: notStarted.map((s) => s.attemptId),
      unknown: unknown.map((s) => s.attemptId),
      changed: true,
    };
  }
}

/**
 * 请求内容指纹。
 *
 * 只用来判「同一个 requestId 的两次请求内容是否一致」，
 * **不**用来去重（去重靠 requesterId + requestId）。
 *
 * 字段顺序不影响结果。
 */
export function requestFingerprint(payload) {
  return stableStringify(payload);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}