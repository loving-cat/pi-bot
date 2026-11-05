import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideRetry,
  transientBackoffMs,
  isRecoverableFailure,
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

  test('临时故障给到 10 次机会', () => {
    assert.equal(MAX_RETRIES_TRANSIENT, 10);
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

  test('分流：前半程等接口恢复，后半程提示换模型', () => {
    // 前几次：老实等
    for (const attempt of [1, 2, 3, 4, 5]) {
      const d = decideRetry({ error: 'HTTP 429', attempt });
      assert.equal(d.kind, 'transient');
      assert.notEqual(d.switchModel, true, `第 ${attempt} 次不该换模型`);
    }
    // 后半程：同一个通路抖这么多次，该换思路了
    for (const attempt of [6, 7, 8, 9, 10]) {
      const d = decideRetry({ error: 'HTTP 429', attempt });
      assert.equal(d.kind, 'transient');
      assert.equal(d.switchModel, true, `第 ${attempt} 次应该提示换模型`);
    }
  });

  test('普通失败不会触发换模型提示（那是临时故障专用）', () => {
    const d = decideRetry({ error: '某个工具报错', attempt: 1 });
    assert.notEqual(d.switchModel, true);
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
    assert.ok(first >= 1500 && first < 2200, `第一次约 1.5s，实际 ${first}`);
    assert.ok(second >= 3000 && second < 3800, `第二次约 3s，实际 ${second}`);
    assert.ok(third >= 6000 && third < 7000, `第三次约 6s，实际 ${third}`);
    // 封顶 12s：10 次重试总等待控制在 1 分半左右，再长用户会觉得卡死
    const far = transientBackoffMs(20);
    assert.ok(far <= 12700, `封顶 12.7s，实际 ${far}`);
    // 总时长也要兜住 —— 单次封顶只保证单项，累积起来才是用户真实感受
    let total = 0;
    for (let a = 1; a <= 10; a++) total += transientBackoffMs(a);
    assert.ok(total <= 120000, `10 次重试总等待应 ≤ 2 分钟，实际 ${Math.round(total / 1000)}s`);
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

  test('可恢复的失败不标红：这些类型还有希望', () => {
    const cases = [
      { error: '模型请求失败，接口详情已隐藏', status: 429 },
      { error: '模型请求失败，接口详情已隐藏', status: 503 },
      { error: '模型请求被限流（HTTP 429）' },
      { error: '模型请求超时' },
      { error: '它没有给出内容' },
      { error: '某个未知错误' }, // 未知也给一次机会
    ];
    for (const c of cases) {
      assert.equal(
        isRecoverableFailure(c),
        true,
        `应该判为可恢复：${JSON.stringify(c)}`,
      );
    }
  });

  test('没希望的失败才标红：这些立刻收手', () => {
    const cases = [
      { error: '模型请求认证失败（HTTP 401）', status: 401 },
      { error: '模型请求被拒绝（HTTP 403）', status: 403 },
      { error: 'invalid api key' },
      { error: '已终止' },
      { error: 'aborted' },
      { error: 'already processing' },
    ];
    for (const c of cases) {
      assert.equal(
        isRecoverableFailure(c),
        false,
        `不该判为可恢复：${JSON.stringify(c)}`,
      );
    }
  });

  test('status=401 走鉴权分支，不因为带了 status 就当成临时故障', () => {
    const d = decideRetry({ error: '模型请求认证失败', status: 401, attempt: 1 });
    assert.equal(d.retry, false);
    assert.equal(d.kind, 'auth');
  });

}
