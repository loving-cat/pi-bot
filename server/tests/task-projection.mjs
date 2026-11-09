/** 任务投影：plan 字段必须和存储层一致，不能出现 [object Object]。 */
import assert from 'node:assert/strict';

const { projectTaskRun } = await import('../src/tasks/task-transport.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

/** 构造一个能通过 projectTaskRun 的最小 taskRun。 */
function taskRun(plan) {
  return {
    id: 'tr_probe',
    roomId: 'r_probe',
    rootTaskId: 'tr_probe',
    parentTaskId: null,
    revision: 1,
    sequence: 1,
    storeVersion: 1,
    state: 'running',
    stateText: '进行中',
    title: '探测任务',
    scope: '',
    deliverables: [],
    verificationCount: 0,
    unmet: [],
    waiting: null,
    blockedReason: null,
    phase: { kind: 'work' },
    plan,
    budget: { extraRuns: 0, maxRuns: null, remaining: null },
    result: null,
    admissionStatus: 'accepted',
    updatedAt: 1,
  };
}

test('★ plan 用 normalizePlan 存的字段名，标题和负责人要正确', () => {
  // normalizePlan 产出的是 { task, memberName, memberBotId, deliverable }。
  // 投影层原来读 title/text、owner/botName —— 一个都读不到，
  // 于是退回整个对象，String(对象) 就成了 "[object Object]"。
  const out = projectTaskRun(taskRun({
    steps: [
      { task: '盘点现有数据集', memberName: '数据核验员', memberBotId: 'b1', deliverable: '清单' },
      { task: '写出核算口径', memberName: '财务建模师', memberBotId: 'b2', deliverable: '文档' },
    ],
    at: 100,
    revision: 2,
  }));

  assert.equal(out.plan.steps.length, 2);
  assert.equal(out.plan.steps[0].title, '盘点现有数据集');
  assert.equal(out.plan.steps[0].owner, '数据核验员');
  assert.equal(out.plan.steps[1].title, '写出核算口径');
  assert.equal(out.plan.steps[1].owner, '财务建模师');
});

test('★ 任何字段组合都不得产生 [object Object]', () => {
  const out = projectTaskRun(taskRun({
    steps: [
      { task: '正常的' },
      { title: '老格式的' },
      { description: '未知格式' },
      {},
      '纯字符串步骤',
    ],
    at: 100,
  }));

  for (const step of out.plan.steps) {
    assert.equal(
      String(step.title).includes('[object Object]'),
      false,
      `步骤 ${step.index} 的标题变成了对象字符串：${step.title}`,
    );
    assert.equal(
      String(step.owner).includes('[object Object]'),
      false,
      `步骤 ${step.index} 的负责人变成了对象字符串`,
    );
  }
});

test('plan 缺失时不投影', () => {
  const out = projectTaskRun(taskRun(null));
  assert.equal(out.plan, null);
  const empty = projectTaskRun(taskRun({ steps: [] }));
  assert.equal(empty.plan, null);
});

console.log(`\n任务投影：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
