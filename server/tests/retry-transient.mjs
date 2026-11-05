import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideRetry,
  transientBackoffMs,
  MAX_RETRIES,
  MAX_RETRIES_TRANSIENT,
} from '../src/retry-policy.js';

/// key 不稳定时的行为约束。
///
/// 用户的真实反馈：key 不稳的时候整条链路一直报错、跑不完。
/// 根因是 429/5xx 这类**临时故障**被当成普通失败，只给 1 次重试就放弃。
void main2();

function main2() {
  test('429 限流被识别为临时故障，可多次重试', () => {
    const d = decideRetry({ error: '模型请求被限流（HTTP 429），请稍后重试。', attempt: 1 });
    assert.equal(d.retry, true);
    assert.equal(d.kind, 'transient');
  });

  test('502/503/504 也算临时故障', () => {
    for (const code of [500, 502, 503, 504]) {
      const d = decideRetry({ error: `模型请求失败（HTTP ${code}）`, attempt: 1 });
      assert.equal(d.retry, true, `HTTP ${code} 应该可重试`);
      assert.equal(d.kind, 'transient');
    }
  });

  test('临时故障给的机会比普通失败多', () => {
    // 普通失败：第 2 次就不重试了
    const normal = decideRetry({ error: '工具报错', attempt: 2 });
    assert.equal(normal.retry, false);

    // 临时故障：还能继续
    const transient = decideRetry({ error: 'HTTP 429 限流', attempt: 2 });
    assert.equal(transient.retry, true);
  });

  test('临时故障也不能无限重试', () => {
    const d = decideRetry({
      error: 'HTTP 429',
      attempt: MAX_RETRIES_TRANSIENT + 1,
    });
    assert.equal(d.retry, false);
    assert.equal(d.kind, 'transient-exhausted');
    // 说明里要点出「key 额度或上游故障」，用户才知道该查什么
    assert.match(d.why, /key|上游/);
  });

  test('401 鉴权失败依然不重试（key 错就是错，重试没用）', () => {
    const d = decideRetry({ error: '模型请求认证失败（HTTP 401）', attempt: 1 });
    assert.equal(d.retry, false);
    assert.equal(d.kind, 'auth');
  });

  test('退避时间随重试次数增长，且有上限', () => {
    const first = transientBackoffMs(1);
    const second = transientBackoffMs(2);
    const third = transientBackoffMs(3);
    assert.ok(first >= 2000 && first < 3000, `第一次约 2s，实际 ${first}`);
    assert.ok(second >= 4000 && second < 5000, `第二次约 4s，实际 ${second}`);
    assert.ok(third >= 8000 && third < 9000, `第三次约 8s，实际 ${third}`);
    // 封顶 30s，别让用户干等
    const far = transientBackoffMs(20);
    assert.ok(far <= 30800, `封顶 30s，实际 ${far}`);
  });

  test('退避带抖动：同样次数不会产生完全相同的等待', () => {
    const vals = new Set();
    for (let i = 0; i < 20; i++) vals.add(transientBackoffMs(1));
    assert.ok(vals.size > 1, '应该有抖动，避免多个 bot 同时重试形成洪峰');
  });

  test('用户终止时永远不重试（哪怕接口是临时的）', () => {
    const d = decideRetry({ error: 'HTTP 429', attempt: 1, aborting: true });
    assert.equal(d.retry, false);
    assert.equal(d.kind, 'aborted');
  });

  test('普通失败的重试次数没被改动（避免顺手放大开销）', () => {
    assert.equal(MAX_RETRIES, 2);
    const d = decideRetry({ error: '某个工具报错', attempt: 2 });
    assert.equal(d.retry, false);
  });

  test('脱敏文案本身不含状态码，靠 status 字段识别（真实场景）', () => {
    // 用户看到的错误长这样 —— 里面没有 429 这个数字
    const redacted = '模型请求失败，接口详情已隐藏，请检查服务端或模型接口日志。';
    // 只给文案：只能当普通失败（老行为）
    assert.equal(decideRetry({ error: redacted, attempt: 1 }).kind, 'unknown');
    // 带上状态码：能正确认成临时故障
    for (const code of [429, 500, 502, 503, 504]) {
      const d = decideRetry({ error: redacted, attempt: 1, status: code });
      assert.equal(d.kind, 'transient', `status=${code} 应识别为临时故障`);
      assert.equal(d.retry, true);
    }
  });

  test('status 是数字或字符串都能认', () => {
    const redacted = '模型请求失败，接口详情已隐藏。';
    assert.equal(decideRetry({ error: redacted, status: '429' }).kind, 'transient');
    assert.equal(decideRetry({ error: redacted, status: 429 }).kind, 'transient');
  });

  test('status=401 走鉴权分支，不因为带了 status 就当成临时故障', () => {
    const d = decideRetry({ error: '模型请求认证失败', status: 401, attempt: 1 });
    assert.equal(d.retry, false);
    assert.equal(d.kind, 'auth');
  });

}
