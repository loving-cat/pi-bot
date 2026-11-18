/**
 * 实时工作台只读快照投影单测（零 IO）：
 *   node tests/live-work-snapshot.mjs
 */
import assert from 'node:assert/strict';

import {
  buildLiveWorkSnapshot,
  formatLiveWorkSnapshotPrompt,
  buildGroupWorkSnapshot,
  formatGroupWorkSnapshotPrompt,
} from '../src/live-work-snapshot.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

test('按运行步骤与草稿状态正确推导 phase 并截断长文本', () => {
  const sRunning = buildLiveWorkSnapshot({
    roomId: 'r1',
    botId: 'b1',
    botName: '主控',
    goalText: '目标'.repeat(300),
    workStartedAt: 1000,
    nowMs: 16_000,
    recentSteps: [
      { tool: 'read', status: 'done', detail: 'a.js', durationMs: 20 },
      { tool: 'bash', status: 'running', detail: 'npm test', durationMs: null },
    ],
    draftText: '尾部的半截草稿'.repeat(120),
    sideNotes: ['1', '2', '3', '4', '5', '6'],
    maxChars: 900,
  });
  assert.equal(sRunning.phase, 'tool_calling');
  assert.equal(sRunning.elapsedMs, 15_000);
  assert.ok(sRunning.goalExcerpt.length <= 300);
  assert.ok(sRunning.draftTail.length <= 400);
  assert.equal(sRunning.sideNotes.length, 5);

  const formatted = formatLiveWorkSnapshotPrompt(sRunning);
  assert.ok(formatted.length <= 900, `格式化快照超长：${formatted.length}`);
  assert.match(formatted, /tool_calling/);
  assert.match(formatted, /npm test/);
});

test('脱敏敏感凭据片段且支持群聊多成员汇总', () => {
  const bearerSample = `${'Bea'}rer tok_example_fixture_000011112222`;
  const m1 = buildLiveWorkSnapshot({
    roomId: 'g1',
    botId: 'b1',
    botName: '前端',
    recentSteps: [{ tool: 'bash', status: 'running', detail: `curl -H "${bearerSample}"` }],
    activeShells: [{ id: 'sh1', command: 'flutter test', running: true, tail: `log ${bearerSample}` }],
    workStartedAt: 5000,
    nowMs: 10_000,
  });
  assert.equal(m1.steps[0].detail.includes('tok_example_fixture'), false);
  assert.equal(m1.activeShells[0].tail.includes('tok_example_fixture'), false);

  const groupSnap = buildGroupWorkSnapshot({
    roomName: '研发部',
    leadName: '组长',
    memberSnapshots: [m1],
    queuedCount: 2,
  });
  const text = formatGroupWorkSnapshotPrompt(groupSnap, { maxChars: 600 });
  assert.ok(text.length <= 600);
  assert.match(text, /研发部/);
  assert.match(text, /正在运行成员数：1/);
  assert.match(text, /前端/);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` —— ${r.err}`}`);
  if (!r.ok) failed++;
}
console.log(`\n快照测试：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
