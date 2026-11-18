/**
 * 模型失败文案补链路测试。
 *   node tests/model-failure-hint.mjs
 *
 * ## 守什么
 *
 * 群聊里多个 bot 各走各的模型：一个换好了、另两个还在被限流的组上，
 * 用户只看得到几条一模一样的「模型请求失败」，不知道是哪条链路。
 * 这里保证失败文案一定带上当前模型，且不会重复追加、不会空加。
 */
import assert from 'node:assert/strict';

const { modelFailure, withModelHint } = await import('../src/model-reply.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

test('★ 失败文案带上当前模型', () => {
  const out = withModelHint('模型请求失败，接口详情已隐藏。', 'mg_1/clinepass/x');
  assert.equal(out, '模型请求失败，接口详情已隐藏。（当前模型：mg_1/clinepass/x）');
});

test('已经包含模型时不重复追加', () => {
  const text = '模型请求失败（mg_1/clinepass/x）';
  assert.equal(withModelHint(text, 'mg_1/clinepass/x'), text);
});

test('没有模型或没有文案时原样返回', () => {
  assert.equal(withModelHint('出错了', ''), '出错了');
  assert.equal(withModelHint('', 'mg/x'), '');
  assert.equal(withModelHint(null, 'mg/x'), '');
});

test('限流/鉴权/超时都有可执行的说法', () => {
  assert.match(modelFailure({ status: 429 }).error, /429/);
  assert.match(modelFailure({ status: 401 }).error, /凭据|认证/);
  assert.match(modelFailure(new Error('timeout')).error, /超时/);
});

console.log(`\n模型失败文案：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
