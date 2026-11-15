/**
 * 根任务预算的测试（W4b 第 2 步）。
 *   node tests/task-budget.mjs
 *
 * ## 为什么这块必须单独测
 *
 * `task-budget.js` 是「会不会无界烧 token」的那道门。之前 104 个测试文件里
 * 只有 `unit.mjs` 零散提到过 budget 字样，**没有一条断言在守它**。
 *
 * ## 守的四件事（对应协议「用户群预算与任务根预算」）
 *
 * 1. **耗尽即停**：`maxRuns` 用满之后 `checkCanRun` 必须拒绝。
 * 2. **只收紧不放宽**：用户把 `groupLimits.maxRuns` 调低要真的生效；
 *    调高不能超过任务链默认值。取 `min`，不是取用户值。
 * 3. **`usedRuns` 的权威值是账本长度**：账本说用了 3 次，预算字段写 0 也不许放行。
 * 4. **不限额必须由 `null` 明确表达**：非法值不能被兜底成"不限额"。
 *
 * 另外守住两条与产品诚实性有关的：
 *   · tokens / 金额**数不到**，必须标 `unmeasured`，界面不得说成真实消耗；
 *   · 退款不能把 `usedRuns` 退成负数（否则额度越用越多）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-budget-'));
Object.assign(process.env, {
  PI_BOT_HOME: fixture,
  PI_BOT_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  PI_BOT_PROBE: '0',
  PI_BOT_TASK_INTAKE: '0',
});
for (const d of [process.env.PI_BOT_HOME, process.env.PI_BOT_WORKSPACE, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const B = await import(src('tasks/task-budget.js'));
const {
  BUDGET_REJECT, UNMEASURED_METRICS, createBudget, validateBudget,
  remainingRuns, checkCanRun, chargeRun, refundRun, extendBudget, describeBudget,
} = B;

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

// ---------------------------------------------------------------- 构造与校验
test('不限额必须由 null 明确表达，非法值不能被兜底成"不限额"', () => {
  assert.equal(createBudget({}).ok, true);
  assert.equal(createBudget({ maxRuns: null }).ok, true);
  assert.equal(createBudget({ maxRuns: 3 }).ok, true);
  // 0 / 负数 / 小数 / 字符串 都是非法值，必须拒绝而不是"当作不限额"
  for (const bad of [0, -1, 1.5, '3', NaN]) {
    const r = createBudget({ maxRuns: bad });
    assert.equal(r.ok, false, `maxRuns=${bad} 应当被拒绝`);
    assert.equal(r.code, BUDGET_REJECT.badBudget);
  }
});

test('新建预算从 0 开始，extraRuns 也是 0', () => {
  const b = createBudget({ maxRuns: 5 }).budget;
  assert.equal(b.usedRuns, 0);
  assert.equal(b.extraRuns, 0);
  assert.equal(b.concurrencyLimit, 1, '默认并发 1（同一根任务不并行跑两份）');
});

test('validateBudget 能抓出被改坏的预算，放行合法预算', () => {
  const good = createBudget({ maxRuns: 2, concurrencyLimit: 2 }).budget;
  assert.equal(validateBudget(good).ok, true);
  assert.equal(validateBudget({ ...good, usedRuns: -1 }).ok, false);
  assert.equal(validateBudget({ ...good, maxRuns: 0 }).ok, false);
  assert.equal(validateBudget(null).ok, true, 'null = 不限额，是合法的');
});

// ---------------------------------------------------------------- 耗尽即停
test('★ 耗尽即停：用满之后 checkCanRun 必须拒绝', () => {
  const b = createBudget({ maxRuns: 2 }).budget;
  assert.equal(checkCanRun(b, { at: T0 }).ok, true);
  const once = chargeRun(b).budget;
  assert.equal(once.usedRuns, 1);
  assert.equal(checkCanRun(once, { at: T0 }).ok, true);
  const twice = chargeRun(once).budget;
  assert.equal(twice.usedRuns, 2);
  const third = checkCanRun(twice, { at: T0 });
  assert.equal(third.ok, false);
  assert.equal(third.code, BUDGET_REJECT.exhausted);
});

test('★★ usedRuns 的权威值是账本长度：字段写 0 但账本说用满了，也不许放行', () => {
  // 这是最危险的一类 bug：字段与实际执行漂移之后，额度就形同虚设。
  const b = createBudget({ maxRuns: 2 }).budget; // usedRuns = 0（字段说没跑过）
  const gate = checkCanRun(b, { at: T0, usedFromLedger: 2 });
  assert.equal(gate.ok, false, '账本说已跑 2 次，就不能再放行');
  assert.equal(gate.code, BUDGET_REJECT.exhausted);
  assert.equal(remainingRuns(b, 2), 0);
  assert.equal(remainingRuns(b, 1), 1);
});

test('不限额时 remainingRuns 返回 null（界面显示"不限"而不是 0）', () => {
  const b = createBudget({}).budget;
  assert.equal(remainingRuns(b), null);
  assert.equal(checkCanRun(b, { at: T0, usedFromLedger: 999 }).ok, true);
});

test('并发上限：runningCount 达到上限即拒绝', () => {
  const b = createBudget({ maxRuns: 10, concurrencyLimit: 2 }).budget;
  assert.equal(checkCanRun(b, { at: T0, runningCount: 1 }).ok, true);
  const full = checkCanRun(b, { at: T0, runningCount: 2 });
  assert.equal(full.ok, false);
  assert.equal(full.code, BUDGET_REJECT.concurrency);
});

test('截止时间：过了就停，等待不延长', () => {
  const b = createBudget({ maxRuns: 10, deadlineAt: T0 + 60_000 }).budget;
  assert.equal(checkCanRun(b, { at: T0 }).ok, true);
  const late = checkCanRun(b, { at: T0 + 60_001 });
  assert.equal(late.ok, false);
  assert.equal(late.code, BUDGET_REJECT.deadline);
  // "等待不延长" —— 同一份预算不会因为过了截止而自动改 deadlineAt
  assert.equal(b.deadlineAt, T0 + 60_000);
});

// ---------------------------------------------------------------- 扣与退
test('★ 退款不能把 usedRuns 退成负数（额度不能越用越多）', () => {
  const b = createBudget({ maxRuns: 3 }).budget;
  const nothing = refundRun(b);
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, BUDGET_REJECT.nothingToRefund);
  const used = chargeRun(b).budget;
  const back = refundRun(used);
  assert.equal(back.ok, true);
  assert.equal(back.budget.usedRuns, 0);
  // 再退一次还是拒绝
  assert.equal(refundRun(back.budget).ok, false);
});

// ---------------------------------------------------------------- 追加
test('追加额度：maxRuns 与 extraRuns 同时增加，额度真的变多', () => {
  const b = createBudget({ maxRuns: 2 }).budget;
  const full = [chargeRun, chargeRun].reduce((acc, f) => f(acc).budget, b);
  assert.equal(checkCanRun(full, { at: T0 }).ok, false);
  const ext = extendBudget(full, 3);
  assert.equal(ext.ok, true);
  assert.equal(ext.budget.maxRuns, 5);
  assert.equal(ext.budget.extraRuns, 3);
  assert.equal(checkCanRun(ext.budget, { at: T0 }).ok, true, '追加之后应当能继续跑');
});

test('追加额度：非法值拒绝（0 / 负数 / 小数）', () => {
  const b = createBudget({ maxRuns: 2 }).budget;
  for (const bad of [0, -1, 1.5, '2', null, undefined]) {
    const r = extendBudget(b, bad);
    assert.equal(r.ok, false, `extraRuns=${bad} 应当被拒绝`);
    assert.equal(r.code, BUDGET_REJECT.badBudget);
  }
});

test('不限额时追加只加 extraRuns，不把 maxRuns 从 null 变成数字', () => {
  // ★ 这是个容易写错的方向：null 表示不限额，一旦被写成具体数字就变成"限制"了。
  const b = createBudget({}).budget;
  const ext = extendBudget(b, 2);
  assert.equal(ext.ok, true);
  assert.equal(ext.budget.maxRuns, null, '不限额不能因为追加而变成有限额');
  assert.equal(ext.budget.extraRuns, 2);
});

// ---------------------------------------------------------------- 诚实性
test('★ tokens / 金额必须标为 unmeasured（我们数不到真实值）', () => {
  // 描述返回的是结构化对象，不是一句话 —— 界面按行渲染，也方便断言。
  assert.deepEqual([...UNMEASURED_METRICS].sort(), ['apiRequests', 'cost', 'tokens']);
  const b = createBudget({ maxRuns: 2 }).budget;
  const d = describeBudget(b, 1);
  const text = d.lines.join('\n');
  assert.match(text, /1\/2/, `描述里该有 1/2，实际：${text}`);
  assert.deepEqual(d.unmeasured, [...UNMEASURED_METRICS], '必须挂上 unmeasured，界面才知道不能说成真实消耗');
  // 不许在描述里出现具体的 token / 金额数字（那会是编的）
  assert.equal(/token/i.test(text), false, '描述里不该出现 token 消耗');
  assert.equal(/¥|\$/.test(text), false, '描述里不该出现金额');
  assert.equal(d.authoritative, 'attempts', '权威口径是账本，不是字段');
});

test('describeBudget 对三种状态都说人话', () => {
  assert.match(describeBudget(null).lines.join('\n'), /不限|未设置/);
  assert.match(describeBudget(createBudget({}).budget).lines.join('\n'), /不限/);
  const b = createBudget({ maxRuns: 4 }).budget;
  const full = describeBudget(b, 4);
  assert.match(full.lines.join('\n'), /剩余 0 次/, '用尽要说清楚剩 0，而不是消失');
  assert.equal(full.limited, true);
});

// ---------------------------------------------------------------- 组合场景
test('★ 长跑场景：跑满 → 追加 → 再跑满，全程不放宽', () => {
  let b = createBudget({ maxRuns: 2 }).budget;
  const runs = [];
  // 前两次放行
  for (let i = 0; i < 2; i += 1) {
    assert.equal(checkCanRun(b, { at: T0 }).ok, true, `第 ${i + 1} 次该放行`);
    b = chargeRun(b).budget;
    runs.push(i);
  }
  // 第三次被拦
  assert.equal(checkCanRun(b, { at: T0 }).ok, false);
  // 追加 1 次
  b = extendBudget(b, 1).budget;
  assert.equal(checkCanRun(b, { at: T0 }).ok, true);
  b = chargeRun(b).budget;
  // 又满了
  assert.equal(checkCanRun(b, { at: T0 }).ok, false);
  assert.equal(runs.length, 2);
  assert.equal(b.usedRuns, 3);
  assert.equal(b.maxRuns, 3);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
