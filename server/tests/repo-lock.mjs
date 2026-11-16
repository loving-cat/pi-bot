/**
 * 仓库共享元数据的写锁（规格 §7.3）。
 *   node tests/repo-lock.mjs
 *
 * ## 守什么
 *
 * 两个任务同时往同一个 `commonDir` 里写（index / refs / 对象库）会撞锁，
 * 严重的那种**不报错**、下次操作才炸。所以这里的错误方向是：
 *
 *   · 锁太松（同一个仓库两把锁）→ 等于没有锁；
 *   · 锁不放（异常路径）→ 整个仓库卡到 TTL；
 *   · 锁被别人放掉 → 后一个任务以为自己在独占，其实两个都在写。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  acquireRepoWrite, releaseRepoWrite, withRepoWriteLock, lockHolder, listRepoLocks, resetRepoLocks,
} = await import(src('repo-lock.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const NOW = 1_700_000_000_000;
const DIR = path.sep === '\\' ? 'D:\\repo\\.git' : '/repo/.git';

test('拿到锁 → 别的任务被拒，并说清是谁占着', () => {
  resetRepoLocks();
  assert.equal(acquireRepoWrite({ commonDir: DIR, taskId: 'tr_1', now: NOW }).ok, true);
  const second = acquireRepoWrite({ commonDir: DIR, taskId: 'tr_2', now: NOW + 10 });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'repo_busy');
  assert.match(second.text, /tr_1/);
  assert.equal(second.holder.taskId, 'tr_1');
});

test('同一个任务重入放行（一次任务里连着 add + commit）', () => {
  resetRepoLocks();
  acquireRepoWrite({ commonDir: DIR, taskId: 'tr_1', now: NOW });
  const again = acquireRepoWrite({ commonDir: DIR, taskId: 'tr_1', now: NOW + 5 });
  assert.equal(again.ok, true);
  assert.equal(again.reentrant, true);
});

test('★ 大小写与斜杠归一化：同一个仓库不能有两把锁', () => {
  resetRepoLocks();
  acquireRepoWrite({ commonDir: 'D:/Repo/.git', taskId: 'tr_1', now: NOW });
  const second = acquireRepoWrite({ commonDir: 'd:\\repo\\.git', taskId: 'tr_2', now: NOW });
  assert.equal(second.ok, false, 'Windows 上这两条是同一个目录');
});

test('★ 只有持有者能放（别人放不掉）', () => {
  resetRepoLocks();
  acquireRepoWrite({ commonDir: DIR, taskId: 'tr_1', now: NOW });
  const wrong = releaseRepoWrite({ commonDir: DIR, taskId: 'tr_2' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'not_holder');
  assert.ok(lockHolder({ commonDir: DIR }), '放不掉就还得在');
  assert.equal(releaseRepoWrite({ commonDir: DIR, taskId: 'tr_1' }).ok, true);
  assert.equal(lockHolder({ commonDir: DIR }), null);
});

test('★ 残留锁超过 TTL 会被后来者接管（进程异常退出不该锁死整个仓库）', () => {
  resetRepoLocks();
  acquireRepoWrite({ commonDir: DIR, taskId: 'tr_dead', now: NOW, ttlMs: 1000 });
  const later = acquireRepoWrite({ commonDir: DIR, taskId: 'tr_new', now: NOW + 5000, ttlMs: 1000 });
  assert.equal(later.ok, true);
  assert.equal(lockHolder({ commonDir: DIR }).taskId, 'tr_new');
});

test('★ fn 抛异常也保证放锁（否则一次失败锁死到 TTL）', () => {
  resetRepoLocks();
  assert.throws(() => withRepoWriteLock({
    commonDir: DIR, taskId: 'tr_1', now: NOW,
    fn: () => { throw new Error('boom'); },
  }));
  assert.equal(lockHolder({ commonDir: DIR }), null, '异常路径必须放锁');
});

test('withRepoWriteLock 正常路径：返回值透传 + 放锁', () => {
  resetRepoLocks();
  const r = withRepoWriteLock({ commonDir: DIR, taskId: 'tr_1', now: NOW, fn: () => 42 });
  assert.equal(r, 42);
  assert.equal(lockHolder({ commonDir: DIR }), null);
});

test('拿不到锁时 fn 根本不执行', () => {
  resetRepoLocks();
  acquireRepoWrite({ commonDir: DIR, taskId: 'tr_1', now: NOW });
  let ran = false;
  const r = withRepoWriteLock({ commonDir: DIR, taskId: 'tr_2', now: NOW, fn: () => { ran = true; } });
  assert.equal(r.ok, false);
  assert.equal(ran, false);
});

test('没有 commonDir 就拒（不知道锁哪儿等于没锁）', () => {
  resetRepoLocks();
  const r = acquireRepoWrite({ commonDir: '', taskId: 'tr_1', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_common_dir');
});

test('不同仓库互不影响', () => {
  resetRepoLocks();
  acquireRepoWrite({ commonDir: '/a/.git', taskId: 'tr_1', now: NOW });
  assert.equal(acquireRepoWrite({ commonDir: '/b/.git', taskId: 'tr_2', now: NOW }).ok, true);
  assert.equal(listRepoLocks().length, 2);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
