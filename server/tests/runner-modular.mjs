import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const here = import.meta.dirname;
const srcRoot = path.resolve(here, '..', 'src');
const runnerDir = path.join(srcRoot, 'runner');

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}:`, err?.stack || err);
      throw err;
    });
}

const EXPECTED_SUBMODULES = {
  'runner-utils.js': [
    'MERGE_BURST_MS',
    'COMPACT_MAX_ATTEMPTS',
    'COMPACT_COOLDOWN_MS',
    'MAX_STEP_TEXT',
    'RETRY_DELAY_MS',
    'sleep',
    'sessionKey',
    'textOf',
    'hydrate',
    'summarizeArgs',
    'throttle',
    'emitContext',
  ],
  'task-bridge.js': [
    'startWatchdog',
    'stallCleanupEntry',
    'escalateFailure',
    'beginRequestScope',
    'endRequestScope',
    'currentRequestScope',
    'setRequestDecision',
    'requestDecisionOf',
    'queueAdmittedTask',
    'flushAdmitted',
    'assertRequestEnvelope',
    'withRequestEnvelope',
    'enqueueRequest',
    'drainRequestQueue',
    'abortManagedTask',
    'activateReportScope',
    'releaseReportScope',
    'candidateDepartmentIds',
    'currentTaskContext',
    'notePolicyBlocked',
    'collectReport',
    'verifyReportWait',
  ],
  'memory-compactor.js': [
    'MEMORY_WINDOW',
    'TARGET_RECENT_TOKENS',
    'TARGET_RECENT_TOKENS_LIGHT',
    'COMPACT_PROMPT',
    'planCompaction',
    'calibrateKeepRecent',
    'maybeAutoSummarize',
    'summarizeMemory',
    'compactIfNeeded',
  ],
  'duplex-lane.js': [
    'recordSideContext',
    'consumeSideContext',
    'restoreSideContext',
    'abortTalkFor',
    'abortTalkInRoom',
    'deliverMerged',
    'sendUserMessage',
  ],
  'group-orchestrator.js': [
    'roundEpoch',
    'interruptRoundForUser',
    'dispatchGroupRound',
    'executeGroupRound',
  ],
  'turn-executor.js': [
    'executeTurn',
  ],
};

console.log('PiRunner 模块化结构与兼容钩子测试：');

await check('1. pi-runner.js 外观层行数 <= 850 且 6 个子模块各 <= 1350 行', () => {
  const facadeLines = fs.readFileSync(path.join(srcRoot, 'pi-runner.js'), 'utf8').split(/\r?\n/).length;
  assert.ok(facadeLines <= 850, `pi-runner.js 行数应 <= 850，实际 ${facadeLines}`);

  for (const file of Object.keys(EXPECTED_SUBMODULES)) {
    const full = path.join(runnerDir, file);
    assert.ok(fs.existsSync(full), `缺少子模块: runner/${file}`);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 1350, `runner/${file} 行数应 <= 1350，实际 ${lines}`);
  }
});

await check('2. 单向依赖 DAG：runner/*.js 不得反向导入 pi-runner.js', () => {
  for (const file of fs.readdirSync(runnerDir)) {
    if (!file.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(runnerDir, file), 'utf8');
    const imports = [...text.matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(
      !imports.some((spec) => spec.includes('pi-runner')),
      `runner/${file} 不得反向导入 pi-runner.js（实际导入：${imports.join(', ')}）`,
    );
  }
});

await check('3. 6 个子模块动态导入无误且导出齐全', async () => {
  for (const [file, names] of Object.entries(EXPECTED_SUBMODULES)) {
    const mod = await import(`../src/runner/${file}`);
    for (const name of names) {
      assert.ok(name in mod, `runner/${file} 缺少导出符号 ${name}`);
    }
  }
});

await check('4. PiRunner 静态常量/planCompaction 与无实例 isRoomBusy 兼容钩子保持不变', async () => {
  const { PiRunner } = await import('../src/pi-runner.js');
  assert.equal(typeof PiRunner.MEMORY_WINDOW, 'number');
  assert.equal(typeof PiRunner.TARGET_RECENT_TOKENS, 'number');
  assert.equal(typeof PiRunner.TARGET_RECENT_TOKENS_LIGHT, 'number');
  assert.equal(PiRunner.COMPACT_PROMPT, null);
  assert.equal(typeof PiRunner.planCompaction, 'function');

  const compactRes = PiRunner.planCompaction({
    percent: 70,
    threshold: 60,
    retryAfter: 0,
    compacting: false,
    autoCompact: true,
  });
  assert.equal(compactRes.compact, true);

  const sessions = new Map([
    ['roomA:bot1', { busy: true, compactingOnly: false }],
    ['roomB:bot1', { busy: true, compactingOnly: true }],
  ]);
  assert.equal(PiRunner.prototype.isRoomBusy.call({ sessions }, 'roomA'), true);
  assert.equal(PiRunner.prototype.isRoomBusy.call({ sessions }, 'roomB'), false);
  assert.equal(PiRunner.prototype.isRoomBusy.call({ sessions }, 'roomC'), false);
});

await check('5. PiRunner.prototype.run 与 PiRunner.prototype.runRound 热补丁钩子继续生效', async () => {
  const [{ PiRunner }, { createStore }] = await Promise.all([
    import('../src/pi-runner.js'),
    import('../src/store.js'),
  ]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-runner-modular-'));
  const origRun = PiRunner.prototype.run;
  const origRunRound = PiRunner.prototype.runRound;
  const runCalls = [];
  const roundCalls = [];

  let runner = null;
  try {
    const store = createStore({ dataDir: tmpDir });
    const chief = store.mainBot();
    const member = store.createBot({ name: '研发', emoji: '🛠️', persona: '工程实现' });
    const dm = store.ensureDm(chief.id);
    const group = store.createGroup({ name: '工程组', botIds: [chief.id, member.id], leadBotId: chief.id });

    PiRunner.prototype.run = async function patchedRun(roomId, botId, prompt, options = {}) {
      runCalls.push({ roomId, botId, prompt, options });
      return { ok: true, text: 'patched-run', ms: 1, messageId: 'm_patched' };
    };
    PiRunner.prototype.runRound = async function patchedRunRound(roomId, opts = {}) {
      roundCalls.push({ roomId, opts });
      return { ok: true };
    };

    runner = new PiRunner({
      config: { dataDir: tmpDir, workspace: tmpDir, maxConcurrentRuns: 0, backgroundConcurrency: 0, runSlotWaitMs: 0, backgroundSlotWaitMs: 0 },
      store,
    });

    const dmRes = await runner.greetDm(dm.id, chief.id);
    assert.equal(dmRes.text, 'patched-run');
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].roomId, dm.id);

    const groupRes = await runner.dispatchToGroup({ roomId: group.id, text: '执行巡检' });
    assert.equal(groupRes.ok, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(roundCalls.length, 1);
    assert.equal(roundCalls[0].roomId, group.id);
  } finally {
    runner?.disposeAll?.();
    PiRunner.prototype.run = origRun;
    PiRunner.prototype.runRound = origRunRound;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nrunner-modular: ${passed}/${passed} 通过`);
