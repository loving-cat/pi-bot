/**
 * 成员失败后的重试策略测试。
 *
 * 起因：用户观察"负责人发现成员卡住/失败时，不让人重干，而是自己上"。
 * 根因是成员失败只打日志、不告诉任何人，负责人回来只看到"弟弟没说话"。
 *
 * 这里验三件事：
 *   1. 哪些错误值得重试、哪些重试也没用；
 *   2. 重试时提示词怎么变（原样重发大概率得到同样结果）；
 *   3. 用完次数后给负责人的话里，不能留"自己上"的口子。
 */
import assert from 'node:assert/strict';
import {
  MAX_RETRIES,
  decideRetry,
  retryHint,
  giveUpNote,
  failureNote,
} from '../src/retry-policy.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

test('空回复最值得重试', () => {
  const d = decideRetry({ error: '没有给出内容（已自动重试两次）', attempt: 1 });
  assert.equal(d.retry, true);
  assert.equal(d.kind, 'empty');
});

test('超时给一次重试，连续超时就放弃', () => {
  assert.equal(decideRetry({ error: '请求超时（600s）', attempt: 1 }).retry, true);
  const twice = decideRetry({ error: '请求超时（600s）', attempt: 2 });
  assert.equal(twice.retry, false);
  assert.equal(twice.kind, 'timeout-twice');
});

test('「忙」不是失败，重试只会继续撞墙', () => {
  const d = decideRetry({ error: 'Agent is already processing', attempt: 1 });
  assert.equal(d.retry, false);
  assert.equal(d.kind, 'busy');
});

test('鉴权问题重试没用', () => {
  for (const err of ['401', 'invalid api key', '未授权', 'forbidden']) {
    assert.equal(decideRetry({ error: err, attempt: 1 }).retry, false, err);
  }
});

test('用户终止就不重试', () => {
  assert.equal(decideRetry({ error: '任意错误', attempt: 1, aborting: true }).retry, false);
  assert.equal(decideRetry({ error: '这一轮已被终止', attempt: 1 }).retry, false);
});

test('次数用完就停', () => {
  const d = decideRetry({ error: '未知', attempt: MAX_RETRIES + 1 });
  assert.equal(d.retry, false);
  assert.equal(d.kind, 'exhausted');
  assert.match(d.why, /已经试了/);
});

test('默认最多重试 2 次（不含第一次）', () => {
  assert.equal(MAX_RETRIES, 2);
  assert.equal(decideRetry({ error: '未知错误', attempt: 1 }).retry, true, '第 1 次可重试');
  assert.equal(decideRetry({ error: '未知错误', attempt: 2 }).retry, false, '第 2 次后停');
});

test('重试提示词要说清"上次没成"并给新办法', () => {
  const hint = retryHint({ attempt: 1, error: '超时了', kind: 'timeout' });
  assert.match(hint, /第 1 次重试/);
  assert.match(hint, /超时/);
  assert.match(hint, /别一次做太多|先做最关键/, '要给具体建议，不能只说重试');
});

test('空回复的重试提示要它直接给结论', () => {
  const hint = retryHint({ attempt: 1, error: '空回复', kind: 'empty' });
  assert.match(hint, /直接给结论|不要只调工具/);
});

test('重试提示词会截断超长错误（别把上下文撑爆）', () => {
  const hint = retryHint({ attempt: 1, error: 'x'.repeat(2000), kind: 'unknown' });
  assert.ok(hint.length < 600, `实际 ${hint.length}`);
});

test('收尾文案：给出"先重派 → 换人 → 自己上但要说明"的顺序', () => {
  const note = giveUpNote({
    botName: '小王',
    task: '整理上月数据',
    attempts: 3,
    reason: '连续超时',
  });
  assert.match(note, /小王/);
  assert.match(note, /3 次/);
  assert.match(note, /连续超时/);
  assert.match(note, /整理上月数据/);
  // 三步顺序必须都在
  assert.match(note, /再派一次|重新派/);
  assert.match(note, /另一个同事|换人/);
  assert.match(note, /必须在群里说明你接手了/);
});

test('收尾文案明确不许悄悄接手', () => {
  const note = giveUpNote({ botName: '小王', attempts: 3, reason: 'x' });
  assert.match(note, /不要悄悄把活接下/);
  assert.match(note, /掩盖/);
});

test('收尾文案不再出现"换个人或者再派一次"这种暗示可以自己上的说法', () => {
  const note = giveUpNote({ botName: '小王', attempts: 3, reason: 'x' });
  // 旧文案是"请你重新安排：换个人，或者再派一次"
  assert.ok(!/请你重新安排/.test(note), '旧文案给了自己上的口子，不该再出现');
});

test('群里的留痕：重试时和放弃时说的话不一样', () => {
  const retrying = failureNote({ botName: '小王', reason: '超时', attempt: 1, willRetry: true });
  assert.match(retrying, /正在重试第 1 次/);

  const gaveUp = failureNote({ botName: '小王', reason: '超时', willRetry: false });
  assert.match(gaveUp, /没能完成/);
  assert.ok(!/正在重试/.test(gaveUp));
});

test('留痕文案截断长错误', () => {
  const note = failureNote({ botName: 'x', reason: 'y'.repeat(500), willRetry: false });
  assert.ok(note.length < 250, `实际 ${note.length}`);
});

console.log(`\n重试策略测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
