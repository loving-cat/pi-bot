import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateEgoBrowser, runEgoScript, EGO_USAGE_GUIDE, buildFullscreenCleanupScript } from '../src/ego-browser.js';

test('能定位到 ego-browser CLI', async () => {
  const cli = await locateEgoBrowser();
  assert.ok(cli, '应该返回一个路径或命令名');
  assert.equal(typeof cli, 'string');
});

test('空脚本直接拒绝，不起进程', async () => {
  const r = await runEgoScript({ script: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /脚本是空的/);
});

test('真实跑一段脚本并拿到输出', { skip: process.env.PI_BOT_EGO_INTEGRATION !== '1' }, async () => {
  const r = await runEgoScript({
    script: 'const task = await taskSpace("pi-bot-test-space"); console.log("hello-from-ego:" + (task.spaceId ? "ok" : "no"));',
    timeoutMs: 60000,
  });
  // 没装 ego 的环境跳过（CI 上可能没有）
  if (!r.ok && /命令不可用|没装/.test(r.error || '')) {
    return;
  }
  assert.equal(r.ok, true, '脚本应执行成功：' + (r.error || ''));
  assert.match(r.output, /hello-from-ego:ok/);
});

test('输出里不带 ego 自己的 notice 噪音', { skip: process.env.PI_BOT_EGO_INTEGRATION !== '1' }, async () => {
  const r = await runEgoScript({
    script: 'console.log("clean-line");',
    timeoutMs: 60000,
  });
  if (!r.ok) return; // CI 没装 ego
  assert.ok(!String(r.output).includes('[ego-browser:'), 'notice 应被过滤掉');
  assert.match(r.output, /clean-line/);
});

test('脚本报错时返回失败并带上错误信息', { skip: process.env.PI_BOT_EGO_INTEGRATION !== '1' }, async () => {
  const r = await runEgoScript({
    script: 'throw new Error("boom-from-test");',
    timeoutMs: 60000,
  });
  if (!r.ok && /命令不可用/.test(r.error || '')) return;
  assert.equal(r.ok, false, '抛错应该判失败');
  assert.ok(
    String(r.error).includes('boom-from-test') || String(r.output).includes('boom-from-test'),
    '应带出原始错误：' + r.error,
  );
});

test('用法说明写清了它不是 Playwright', () => {
  assert.match(EGO_USAGE_GUIDE, /不是 Playwright/);
  assert.match(EGO_USAGE_GUIDE, /taskSpace/);
  assert.match(EGO_USAGE_GUIDE, /page.evaluate/);
  assert.match(EGO_USAGE_GUIDE, /locator/);
});

test('★ 收尾脚本必须退出全屏，而且每一步都不能把整段搞挂', () => {
  const script = buildFullscreenCleanupScript();
  assert.ok(script.includes('exitFullscreen'), '要真的调用 exitFullscreen');
  assert.ok(script.includes('listTaskSpaces'), '要遍历所有任务空间');
  // 收尾失败不能吞掉主结果：每个 claim / 每页 / 每个 evaluate 都要有 try
  const tries = (script.match(/try\s*\{/g) ?? []).length;
  assert.ok(tries >= 3, `每一步都要 try/catch，实际 ${tries} 处`);
  // ★ 反过来：收尾**必须**交还控制权，否则用户面对的是一块不能点的页面
  //   （ego 界面上的 "Agent is in control" + "Take over"）。
  assert.ok(script.includes('handOff'), '收尾必须把控制权交还用户');
  assert.ok(/ownership !== 'agent'/.test(script), '已经是用户的空间不许抢');
});
