/**
 * 规矩版本与变更通知判定。
 *
 * 要守住的性质：同一套规矩版本号必须稳定（否则"什么都没改"也会通知），
 * 改动影响授权的字段必须换号，不影响授权的字段不该换号。
 */
import assert from 'node:assert/strict';
import {
  POLICY_REVISION, policyBearing, policyChange, policyVersion, planPolicyChangeNotices,
  describePolicyChange,
} from '../src/policy-version.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const base = () => ({
  dangerous: 'allow',
  requireProof: false,
  denyCommands: ['rm -rf *'],
  allowCommands: [],
});

test('版本号带修订号前缀，便于"算法换了"时区分', () => {
  assert.ok(policyVersion(base()).startsWith(`${POLICY_REVISION}:`));
});

test('★ 同一套规矩：版本号必须稳定（改动键顺序也不该变）', () => {
  const a = policyVersion({ dangerous: 'allow', denyCommands: ['x'], allowCommands: [] });
  const b = policyVersion({ allowCommands: [], denyCommands: ['x'], dangerous: 'allow' });
  assert.equal(a, b);
});

test('★ 缺省字段按默认值补齐，不因"没写"就换个版本', () => {
  assert.equal(policyVersion({}), policyVersion({ dangerous: 'allow', denyCommands: [], allowCommands: [] }));
});

test('影响授权的字段变了 → 换版本号', () => {
  const prev = base();
  const next = { ...prev, dangerous: 'deny' };
  assert.notEqual(policyVersion(prev), policyVersion(next));
});

test('命令规则增删 → 换版本号', () => {
  const prev = base();
  assert.notEqual(policyVersion(prev), policyVersion({ ...prev, denyCommands: ['rm -rf *', 'aws:*'] }));
  assert.notEqual(policyVersion(prev), policyVersion({ ...prev, allowCommands: ['git status'] }));
});

test('★ 不影响授权的字段变了 → 版本号不变（否则改一句提示就全量通知）', () => {
  const prev = base();
  const next = { ...prev, requireProof: true, someDisplayOption: 'x' };
  assert.equal(policyVersion(prev), policyVersion(next));
});

test('policyBearing 只挑授权相关字段', () => {
  const bearing = policyBearing(base());
  assert.deepEqual(Object.keys(bearing).sort(), ['allowCommands', 'dangerous', 'denyCommands']);
  assert.equal(bearing.requireProof, undefined);
});

test('policyBearing 对残缺输入给出安全默认值', () => {
  const bearing = policyBearing({ dangerous: 123, denyCommands: 'not-array' });
  assert.equal(bearing.dangerous, 'allow');
  assert.deepEqual(bearing.denyCommands, []);
});

test('policyBearing 返回副本，改它不会污染原对象', () => {
  const prev = base();
  const bearing = policyBearing(prev);
  bearing.denyCommands.push('注入');
  assert.deepEqual(prev.denyCommands, ['rm -rf *']);
});

test('policyChange 说清楚改了哪些字段', () => {
  const prev = base();
  const next = { ...prev, dangerous: 'deny', requireProof: true };
  const change = policyChange(prev, next);
  assert.equal(change.isChange, true);
  assert.deepEqual(change.changed, ['dangerous']);
  assert.notEqual(change.from, change.to);
});

test('★ 变更字段能说成人话（不把人话拼在调用方）', () => {
  assert.equal(describePolicyChange(['dangerous']), '危险动作');
  assert.equal(describePolicyChange(['dangerous', 'denyCommands']), '危险动作、禁止命令');
  assert.equal(describePolicyChange([]), '授权相关设置');
  // 未知字段不丢信息，原文返回
  assert.equal(describePolicyChange(['futureField']), 'futureField');
});

test('policyChange 没变时 isChange=false 且 changed 为空', () => {
  const change = policyChange(base(), base());
  assert.equal(change.isChange, false);
  assert.deepEqual(change.changed, []);
});

test('policyChange 同时改多列时逐项列出', () => {
  const prev = base();
  const next = { ...prev, dangerous: 'ask', allowCommands: ['git status'] };
  assert.deepEqual(policyChange(prev, next).changed, ['dangerous', 'allowCommands']);
});

test('★ 只有版本不同的活要通知，同版本与无版本的不打扰', () => {
  const current = policyVersion(base());
  const assignments = [
    { id: 'a1', policyVersion: current },
    { id: 'a2', policyVersion: 'policy-v1:旧版本' },
    { id: 'a3', policyVersion: null },
    { id: 'a4' },
  ];
  const { notify, silent } = planPolicyChangeNotices(assignments, current);
  assert.deepEqual(notify.map((x) => x.id), ['a2']);
  assert.deepEqual(silent.map((x) => x.id), ['a1', 'a3', 'a4']);
});

test('★ 没记版本的活不去猜：宁可不通知，也不对着老活编"规矩变了"', () => {
  const { notify } = planPolicyChangeNotices([{ id: 'old' }], 'policy-v1:anything');
  assert.equal(notify.length, 0);
});

test('planPolicyChangeNotices 容忍脏数据', () => {
  const { notify, silent } = planPolicyChangeNotices([null, undefined, { id: 'x', policyVersion: 'v' }], 'cur');
  assert.equal(notify.length, 1);
  assert.equal(silent.length, 0);
});

test('两个版本号里含逗号的规则不会串味（稳定序列化的边界）', () => {
  const a = policyVersion({ denyCommands: ['a,b'] });
  const b = policyVersion({ denyCommands: ['a', 'b'] });
  assert.notEqual(a, b);
});

console.log(`\n${passed} 项通过`);
