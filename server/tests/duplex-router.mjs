/**
 * 忙时意图路由器单测（纯逻辑，零 IO）：
 *   node tests/duplex-router.mjs
 */
import assert from 'node:assert/strict';

import {
  DUPLEX_KIND,
  classifyBusyInputSync,
  fallbackBusyInput,
  routeBusyInput,
} from '../src/duplex-router.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

await test('显式 duplexMode 与 followUp 同步优先命中，无需询问 Jev', async () => {
  const r1 = await routeBusyInput(
    { text: '随便说一句', explicitMode: 'side_reply' },
    { askJev: () => assert.fail('显式模式不应调用 Jev') },
  );
  assert.equal(r1.kind, DUPLEX_KIND.sideReply);
  assert.equal(r1.decidedBy, 'explicit');

  const r2 = classifyBusyInputSync({ text: '补充一下', mode: 'followUp' });
  assert.equal(r2.kind, DUPLEX_KIND.amend);
  assert.equal(r2.decidedBy, 'explicit');
});

await test('否定词防误停：包含“别停/不要取消”等句式绝不触发 abort_replace', async () => {
  for (const text of ['千万别停，继续跑', '不要取消，我看一眼日志', '别停，顺便问下好了吗', '跑得停不下来了']) {
    const res = await routeBusyInput({ text });
    assert.notEqual(res.kind, DUPLEX_KIND.abortReplace, `误判了「${text}」`);
  }
});

await test('明确停止/重来短句同步判定为 abort_replace', async () => {
  for (const text of ['停', '停下', '停止', '算了', '取消', '全停重来', 'stop', 'cancel!']) {
    const res = classifyBusyInputSync({ text });
    assert.equal(res.kind, DUPLEX_KIND.abortReplace, `应判停：${text}`);
    assert.equal(res.decidedBy, 'rules');
  }
});

await test('进度询问与简短问题命中 side_reply；含修改动词不走 side_reply', () => {
  for (const text of ['在吗', '现在什么进度了？', '卡住了吗', '到哪一步了', '为什么这么慢？']) {
    const res = classifyBusyInputSync({ text });
    assert.equal(res.kind, DUPLEX_KIND.sideReply, `应走旁路问答：${text}`);
  }

  const withModify = classifyBusyInputSync({ text: '顺便把按钮改成蓝色好吗？' });
  assert.equal(withModify.kind, null, '含修改诉求不应同步直判为只读旁路');
});

await test('带新附件时 rules 不放行 side_reply，无 Jev 落回 amend', async () => {
  const sync = classifyBusyInputSync({ text: '帮我看下', hasAttachments: true });
  assert.equal(sync.kind, null);

  const routed = await routeBusyInput({ text: '帮我看下', hasAttachments: true });
  assert.equal(routed.kind, DUPLEX_KIND.amend);
  assert.equal(routed.decidedBy, 'fallback');
});

await test('Jev 达标置信度采用；低置信度/异常/超限保守落回 fallback，且 fallback 永不判停', async () => {
  const high = await routeBusyInput(
    { text: '你把输出字段再整理成表格' },
    { askJev: async () => ({ ok: true, kind: 'amend', confidence: 0.91 }) },
  );
  assert.equal(high.kind, DUPLEX_KIND.amend);
  assert.equal(high.decidedBy, 'jev');

  const low = await routeBusyInput(
    { text: '好像有点奇怪' },
    { askJev: async () => ({ ok: true, kind: 'abort_replace', confidence: 0.45 }) },
  );
  assert.equal(low.decidedBy, 'fallback');
  assert.notEqual(low.kind, DUPLEX_KIND.abortReplace);

  const crashed = await routeBusyInput(
    { text: '还能跑完吗' },
    { askJev: async () => { throw new Error('network'); } },
  );
  assert.equal(crashed.kind, DUPLEX_KIND.sideReply);
  assert.equal(crashed.decidedBy, 'fallback');

  const fb = fallbackBusyInput({ text: '补充两条边界条件' });
  assert.equal(fb.kind, DUPLEX_KIND.amend);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` —— ${r.err}`}`);
  if (!r.ok) failed++;
}
console.log(`\n路由器测试：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
