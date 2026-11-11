/**
 * 记忆摘要提示词：递归更新（在旧摘要上增量并入新信息）。
 *
 * 背景：旧实现每次都把整个窗口重新 digest、让模型从零重写摘要。
 * 窗口一滑走，早先的结论就没材料了，重写时自然丢掉 ——
 * 用户看到的症状是"上周的结论这周不见了"。
 *
 * 这里只测**纯函数**（buildSummarizePrompt），不碰网络和存储。
 */
import assert from 'node:assert/strict';
import { buildMemoryDigest, buildSummarizePrompt } from '../src/memory-digest.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const msg = (text, authorType = 'user', id = Math.random().toString(36)) => ({
  id,
  authorType,
  authorName: authorType === 'user' ? '用户' : '分析员',
  text,
});

test('有旧摘要：提示词含【已有记忆】和【新增对话】', () => {
  const digest = buildMemoryDigest([msg('还要看持仓明细')]);
  const prompt = buildSummarizePrompt({
    botName: '分析员',
    previousText: '1) 用户关注固收产品',
    digest,
  });
  assert.ok(prompt.includes('【已有记忆】'), '缺少【已有记忆】分段');
  assert.ok(prompt.includes('【新增对话】'), '缺少【新增对话】分段');
  assert.ok(prompt.includes('用户关注固收产品'), '旧摘要没带进去');
  assert.ok(prompt.includes('持仓明细'), '新增材料没带进去');
});

test('有旧摘要：开头要求增量更新，不要整份重写', () => {
  const prompt = buildSummarizePrompt({
    botName: '分析员',
    previousText: '旧摘要',
    digest: '新材料',
  });
  assert.ok(prompt.includes('在已有记忆上更新'), '开头没要求增量更新');
  assert.ok(prompt.includes('不要整份重写'), '开头没说明不要重写');
});

test('旧摘要的数字 + 新对话的待办，必须同时出现', () => {
  const previousText = '1) 用户关注固收产品\n2) 上期收益 12.5%\n3) 待办：补齐 C05';
  const digest = buildMemoryDigest([msg('再看一下持仓明细')]);
  const prompt = buildSummarizePrompt({ botName: '分析员', previousText, digest });
  assert.ok(prompt.includes('12.5%'), '旧摘要里的确定数字丢了');
  assert.ok(prompt.includes('持仓明细'), '新对话里的待办丢了');
});

test('矛盾处理：以用户更正为准，只保留现行结论', () => {
  const prompt = buildSummarizePrompt({
    botName: '分析员',
    previousText: '旧结论',
    digest: '用户更正',
  });
  assert.ok(
    prompt.includes('以用户更正为准，只保留现行结论'),
    '缺少矛盾处理的规则',
  );
  assert.ok(prompt.includes('不要并列两份相反事实'), '缺少"不要并列相反事实"');
  assert.ok(prompt.includes('仍成立的结论和数字必须保留'), '缺少"必须保留成立结论"');
});

test('没有旧摘要：不含【已有记忆】分段，用原开头', () => {
  const digest = buildMemoryDigest([msg('第一次对话')]);
  const prompt = buildSummarizePrompt({ botName: '分析员', previousText: '', digest });
  assert.ok(!prompt.includes('【已有记忆】'), '首次不该出现【已有记忆】');
  assert.ok(
    prompt.startsWith('下面是「分析员」与用户最近的对话记录'),
    '首次应保留原开头',
  );
});

test('要点 1-4 与字数限制保持原文', () => {
  const prompt = buildSummarizePrompt({
    botName: '分析员',
    previousText: '旧',
    digest: '新',
  });
  assert.ok(prompt.includes('1) 用户长期关注什么、有什么偏好与要求；'));
  assert.ok(prompt.includes('2) 已经确定的结论/数据/口径（保留关键数字）；'));
  assert.ok(prompt.includes('3) 还没做完的事与下一步；'));
  // ★ 第 4 条还没拍板，不能改
  assert.ok(prompt.includes('4) 重要的文件路径或系统状态。'), '第 4 条被改了');
  assert.ok(prompt.includes('总长不超过 500 字'), '字数限制被改了');
});

test('开关关闭时：材料回到整窗口 digest，且不含【已有记忆】', () => {
  // 模拟 pipeline：recursive=false 时 previousText 传空
  const all = [msg('早先的结论 A'), msg('后来的补充 B')];
  const digest = buildMemoryDigest(all);
  const prompt = buildSummarizePrompt({ botName: '分析员', previousText: '', digest });
  assert.ok(!prompt.includes('【已有记忆】'), '关闭开关后不该有【已有记忆】');
  assert.ok(prompt.includes('早先的结论 A'), '整窗口材料应包含更早的内容');
  assert.ok(prompt.includes('后来的补充 B'));
});

console.log(`\n记忆摘要提示词：${passed}/${passed} 通过`);
