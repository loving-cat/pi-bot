import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_KINDS,
  capabilityKindsOf,
  recommendMcpForTask,
  capabilityGuideForPrompt,
} from '../src/mcp-capability.js';

const servers = [
  { name: 'rea', type: 'stdio', command: '/usr/local/bin/rea', args: ['mcp'], enabled: true },
  { name: 'playwright', type: 'stdio', command: 'npx', args: ['@playwright/mcp'], enabled: true },
  { name: 'chrome-devtools', type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp'], enabled: true },
  { name: 'postgres', type: 'stdio', command: 'npx', args: ['postgres-mcp'], enabled: true },
  { name: 'disabled-one', type: 'stdio', command: 'rea', enabled: false },
  { name: 'mystery', type: 'http', url: 'https://example.com/mcp', enabled: true },
];

test('能按名字/命令识别能力类别', () => {
  assert.deepEqual(capabilityKindsOf(servers[0]), ['reverse']);
  assert.ok(capabilityKindsOf(servers[1]).includes('browser'));
  assert.ok(capabilityKindsOf(servers[3]).includes('database'));
});

test('认不出来的服务返回空数组，不乱猜', () => {
  assert.deepEqual(capabilityKindsOf(servers[5]), []);
  assert.deepEqual(capabilityKindsOf({}), []);
});

test('逆向任务推荐 rea', () => {
  const out = recommendMcpForTask('帮我逆向这个 dylib，看看它怎么校验授权', servers);
  assert.ok(out.includes('rea'), '应推荐 rea，实际：' + JSON.stringify(out));
});

test('网页任务推荐浏览器类', () => {
  const out = recommendMcpForTask('打开这个网页，登录后点一下导出按钮', servers);
  assert.ok(out.includes('playwright') || out.includes('chrome-devtools'));
});

test('数据库任务推荐数据库服务', () => {
  const out = recommendMcpForTask('查一下这张表的结构和索引', servers);
  assert.ok(out.includes('postgres'));
});

test('没启用的服务不推荐（挂上也连不上）', () => {
  const out = recommendMcpForTask('逆向分析', servers);
  assert.ok(!out.includes('disabled-one'));
});

test('无关任务不推荐任何东西，避免白白起进程', () => {
  assert.deepEqual(recommendMcpForTask('今天天气怎么样', servers), []);
  assert.deepEqual(recommendMcpForTask('', servers), []);
});

test('多个服务命中时按相关度排序', () => {
  const out = recommendMcpForTask(
    '逆向这个二进制，反编译看看崩溃原因',
    servers,
  );
  assert.equal(out[0], 'rea', '命中更多触发词的服务排前面');
});

test('提示词按类别分组，并给出触发词', () => {
  const text = capabilityGuideForPrompt(servers);
  assert.ok(text.includes('逆向'), '应包含逆向类别');
  assert.ok(text.includes('rea'));
  assert.ok(text.includes('触发词'));
  assert.ok(!text.includes('disabled-one'), '未启用的不该出现在清单里');
});

test('没有启用服务时提示词为空，不占上下文', () => {
  assert.equal(capabilityGuideForPrompt([]), '');
  assert.equal(capabilityGuideForPrompt([{ name: 'x', enabled: false }]), '');
});

test('每个类别都有 key/label/hints/triggers，结构完整', () => {
  for (const kind of CAPABILITY_KINDS) {
    assert.ok(kind.key && kind.label);
    assert.ok(Array.isArray(kind.hints) && kind.hints.length);
    assert.ok(Array.isArray(kind.triggers) && kind.triggers.length);
  }
});

test('类别 key 不重复', () => {
  const keys = CAPABILITY_KINDS.map((k) => k.key);
  assert.equal(new Set(keys).size, keys.length);
});
