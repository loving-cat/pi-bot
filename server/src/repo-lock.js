/**
 * 同一个仓库共享元数据的**写锁**（规格 §7.3）。
 *
 * > 同一公共目录的 Git 写入按公共目录标识协调。
 *
 * ## 为什么需要
 *
 * 一个仓库的"共享元数据"是 `commonDir`（`.git`，或 worktree 指向的主仓库 `.git`）：
 * index、refs、对象库、锁文件全在那里。两个任务同时往里写会怎样：
 *
 *   · `index.lock` 被抢 → 后一个直接失败（还算好的）；
 *   · 两个 commit 交错 → 引用更新到意料之外的分支；
 *   · `git gc` 和 `commit` 撞上 → 偶发的"对象损坏"。
 *
 * 前两种会报错，第三种**不报**，而且下次操作才炸。
 *
 * ## 为什么是同步锁、而且不排队
 *
 * `runGit()` 是同步的（`spawnSync`），中间没有 await 的机会 —— 所以这里只能是
 * "拿不到就拒绝"，不能"等一等"。
 *
 * 拒绝比等待更符合这个产品的语义：等 = 模型干等着，用户看到一个卡住的转圈；
 * 拒绝 = 模型知道"另一个任务在用这个仓库"，它可以先做别的、或者告诉用户。
 *
 * ## 边界（写清楚免得被当分布式锁）
 *
 *   · **只在单进程内有效**。同一个服务端进程里的多个任务会被串行化；
 *     两个服务端进程（或有人手动在终端里 git）不受它约束 —— 那种要靠
 *     git 自己的 `index.lock` 与用户介入。
 *   · 锁带 TTL：同步代码里理论上不会"忘记释放"（有 finally），
 *     但 TTL 能兜住进程被 kill -9 之后残留的内存状态（进程都没了，锁也一起没了，
 *     所以这条主要是防同进程内的异常路径）。
 */

/** 同一时刻最多记多少把锁（防止异常情况下无限增长）。 */
const MAX_LOCKS = 200;

/**
 * commonDir（小写归一化）→ `{ taskId, at }`
 *
 * 大小写归一化：Windows/macOS 上 `D:/repo/.git` 与 `d:/repo/.git` 是同一个目录，
 * 不归一化会让同一个仓库有两把锁 —— 等于没有锁。
 */
const held = new Map();

const keyOf = (commonDir) => String(commonDir ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

/** 现在谁拿着这个仓库的写锁。 */
export function lockHolder({ commonDir } = {}) {
  const entry = held.get(keyOf(commonDir));
  if (!entry) return null;
  return { ...entry };
}

/**
 * 试着拿锁。
 *
 * @param {object} p
 * @param {string} p.commonDir 共享元数据目录（`resolveRepoLayout().commonDir`）
 * @param {string} p.taskId 谁要写
 * @param {number} [p.now]
 * @param {number} [p.ttlMs] 超过这个时间视为残留
 * @returns {{ok:true} | {ok:false, code:string, text:string, holder?:object}}
 */
export function acquireRepoWrite({ commonDir, taskId, now = Date.now(), ttlMs = 10 * 60_000 } = {}) {
  const key = keyOf(commonDir);
  if (!key) return { ok: false, code: 'no_common_dir', text: '不知道这个仓库的共享目录，无法协调写入' };
  const who = String(taskId ?? '') || '(未知任务)';
  const entry = held.get(key);
  if (entry) {
    // 同一个任务重入：放行（比如一次任务里连着 add + commit）
    if (entry.taskId === who) return { ok: true, reentrant: true };
    if (now - entry.at < ttlMs) {
      return {
        ok: false,
        code: 'repo_busy',
        text: `另一个任务（${entry.taskId}）正在写这个仓库的共享元数据，先别插进去 —— `
          + '两个任务同时写 index/refs 会撞锁，严重的会让对象库出现"下次才炸"的损坏。'
          + '等它做完，或者让它先做完这一步。',
        holder: { ...entry },
      };
    }
    // 残留：超过 TTL 的锁由后来者接管（进程还在的话它自己也该超时了）
  }
  if (held.size > MAX_LOCKS) {
    // 清掉最老的一批，不让异常路径把内存撑爆
    const oldest = [...held.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, Math.floor(MAX_LOCKS / 4));
    for (const [k] of oldest) held.delete(k);
  }
  held.set(key, { taskId: who, at: now });
  return { ok: true };
}

/** 放锁。只有持有者能放（别人放不掉）。 */
export function releaseRepoWrite({ commonDir, taskId } = {}) {
  const key = keyOf(commonDir);
  const entry = held.get(key);
  if (!entry) return { ok: true, alreadyReleased: true };
  const who = String(taskId ?? '') || '(未知任务)';
  if (entry.taskId !== who) return { ok: false, code: 'not_holder', text: '这把锁不是你的' };
  held.delete(key);
  return { ok: true };
}

/**
 * 同步执行一段"要写仓库"的代码，自动拿锁/放锁。
 *
 * `fn` 抛异常也保证放锁 —— 否则一次失败会把整个仓库锁死到 TTL。
 *
 * @param {object} p
 * @param {Function} p.fn
 * @returns {object} `fn` 的返回值，或者拿锁失败的结果
 */
export function withRepoWriteLock({ commonDir, taskId, now = Date.now(), ttlMs, fn } = {}) {
  const got = acquireRepoWrite({ commonDir, taskId, now, ttlMs });
  if (!got.ok) return got;
  try {
    return fn();
  } finally {
    releaseRepoWrite({ commonDir, taskId });
  }
}

/** 测试用：清空。 */
export function resetRepoLocks() {
  held.clear();
}

/** 诊断用：现在有哪些锁。 */
export function listRepoLocks() {
  return [...held.entries()].map(([dir, entry]) => ({ dir, ...entry }));
}
