import { test } from 'node:test';
import assert from 'node:assert/strict';

// 压缩后必须让技能重新注入 —— 两条路径都要覆盖。
//
// 为什么这事必须测：技能只给一次之后，如果压缩了却不重给，
// 模型就真的"忘了"怎么做。它是这套优化唯一的正确性风险。
//
// 两条压缩路径：
//   · pi 自己的压缩 → compaction_end 事件（pi-runner.js ~2270）
//   · 我们主动压缩   → #compactIfNeeded 成功后（pi-runner.js ~2095）
// 第二条不走事件，所以必须单独清一次。漏了它，主动压缩之后技能就丢了。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerSrc = fs.readFileSync(path.resolve(here, '..', 'src', 'pi-runner.js'), 'utf8');

test('★ pi 自己的压缩结束后要清技能记录', () => {
  // compaction_end 的分支里必须有这两句
  const i = runnerSrc.indexOf("case 'compaction_end'");
  assert.ok(i > 0, '找不到 compaction_end 分支');
  const branch = runnerSrc.slice(i, i + 2500);
  assert.ok(
    branch.includes('compactedSinceInjection = true'),
    'pi 压缩后没标记需要重新注入技能',
  );
  assert.ok(branch.includes('skillsInjected = null'), 'pi 压缩后没清技能记录');
});

test('★ 主动压缩成功后也要清技能记录', () => {
  // #compactIfNeeded 走 session.compact()，不发事件 ——
  // 只靠事件那条会在主动压缩后漏掉
  const i = runnerSrc.indexOf('session.compact(PiRunner.COMPACT_PROMPT)');
  assert.ok(i > 0, '找不到主动压缩调用');
  const after = runnerSrc.slice(i, i + 2000);
  assert.ok(
    after.includes('compactedSinceInjection = true'),
    '主动压缩后没标记需要重新注入技能',
  );
  assert.ok(after.includes('skillsInjected = null'), '主动压缩后没清技能记录');
});

test('两条路径都要有，不能只做一条', () => {
  const count = (runnerSrc.match(/skillsInjected = null/g) || []).length;
  assert.ok(count >= 2, '技能记录清理点少于 2 个（实际 ' + count + ' 个）');
});