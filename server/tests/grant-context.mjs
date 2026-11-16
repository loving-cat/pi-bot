/**
 * "这次是凭哪条授权放行的" —— 传递层测试（规格 §5.5 的「授权引用」）。
 *   node tests/grant-context.mjs
 *
 * ## 为什么这一层也要测
 *
 * 它**不是**授权，只是判定的回音。但审计要是拿错了回音，后果比没有更坏：
 * 日志里写着"凭 gr_xxx 干的"，而 gr_xxx 其实是另一件事的授权 ——
 * 出事回溯时会被带到完全错误的方向。
 *
 * 所以这里守三件事：动作必须对得上、5 分钟就过期、换个 bot 就查不到。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { noteGrant, currentGrantOf, resetGrantContext } = await import(src('grant-context.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const T0 = 1_700_000_000_000;

test('记了就能读回来（同一个 bot、同一个动作）', () => {
  resetGrantContext();
  noteGrant({ botId: 'b1', grantId: 'gr_1', action: 'desktop.input', now: T0 });
  const got = currentGrantOf({ botId: 'b1', action: 'desktop.input', now: T0 + 1000 });
  assert.equal(got.grantId, 'gr_1');
});

test('★ 动作对不上就不认 —— 不能把点屏幕记成"凭 push 的授权干的"', () => {
  resetGrantContext();
  noteGrant({ botId: 'b1', grantId: 'gr_push', action: 'git.push', now: T0 });
  assert.equal(currentGrantOf({ botId: 'b1', action: 'desktop.input', now: T0 + 1000 }), null);
  // 不指定动作时仍然给（调用方明确知道自己在问什么的时候）
  assert.equal(currentGrantOf({ botId: 'b1', now: T0 + 1000 }).grantId, 'gr_push');
});

test('★ 5 分钟就过期', () => {
  resetGrantContext();
  noteGrant({ botId: 'b1', grantId: 'gr_1', action: 'desktop.input', now: T0 });
  assert.ok(currentGrantOf({ botId: 'b1', action: 'desktop.input', now: T0 + 4 * 60_000 }));
  assert.equal(currentGrantOf({ botId: 'b1', action: 'desktop.input', now: T0 + 6 * 60_000 }), null);
});

test('别的 bot 查不到别人的授权引用', () => {
  resetGrantContext();
  noteGrant({ botId: 'b1', grantId: 'gr_1', action: 'desktop.input', now: T0 });
  assert.equal(currentGrantOf({ botId: 'b2', action: 'desktop.input', now: T0 }), null);
});

test('没有 grantId 时不返回半条记录（宁缺勿错）', () => {
  resetGrantContext();
  noteGrant({ botId: 'b1', grantId: null, action: 'desktop.input', now: T0 });
  assert.equal(currentGrantOf({ botId: 'b1', action: 'desktop.input', now: T0 }), null);
});

test('空 botId 不记录（不能记一条"谁的都不知道"的引用）', () => {
  resetGrantContext();
  assert.equal(noteGrant({ botId: '', grantId: 'gr_x', action: 'a', now: T0 }), null);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
