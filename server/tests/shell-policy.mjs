/**
 * 命令级策略测试。
 *   node tests/shell-policy.mjs
 *
 * 覆盖归一化（引号/转义/不可见字符）、分段、规则校验、deny/allow 判定与"判不了就拒绝"。
 */
import assert from 'node:assert/strict';

const {
  normalizeCommand,
  unescapeShellQuotes,
  parseCommand,
  validateRule,
  matchRule,
  normalizeRules,
  decideCommand,
} = await import('../src/shell-policy.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const exec = (cmd) => ({ text: cmd, executable: cmd.split(' ')[0], args: cmd.split(' ').slice(1) });

await test('归一化：去不可见字符、合并空白', () => {
  assert.equal(normalizeCommand('  rm\u200B  -rf\uFEFF /  '), 'rm -rf /');
});

await test('★ 还原引号与转义：r\'\'m / \\rm / "rm" 都变回 rm', () => {
  assert.equal(unescapeShellQuotes(`r''m -rf /`), 'rm -rf /');
  assert.equal(unescapeShellQuotes('\\rm -rf /'), 'rm -rf /');
  assert.equal(unescapeShellQuotes('"rm" -rf /'), 'rm -rf /');
});

await test('★ 还原 ANSI-C 引用：$\'\\x72m\' → rm', () => {
  assert.equal(unescapeShellQuotes(`$'\\x72m' -rf /`), 'rm -rf /');
});

await test('解析：按 && / ; / | 切段并取可执行体', () => {
  const p = parseCommand('cd /tmp && rm -rf build ; echo ok | tee log');
  assert.equal(p.commands.length, 4);
  assert.deepEqual(
    p.commands.map((c) => c.executable),
    ['cd', 'rm', 'echo', 'tee'],
  );
  assert.deepEqual(p.commands[1].args, ['-rf', 'build']);
});

await test('解析：子命令 token（git reset --hard → reset）', () => {
  const p = parseCommand('git reset --hard HEAD~1');
  assert.equal(p.commands[0].executable, 'git');
  assert.deepEqual(p.commands[0].subcommands, ['reset', 'HEAD~1']);
});

await test('解析：命令替换 / heredoc 标记为无法静态判定', () => {
  assert.equal(parseCommand('echo $(rm -rf /)').opaque, true);
  assert.equal(parseCommand('cat <<EOF').opaque, true);
  assert.equal(parseCommand('echo `id`').opaque, true);
  assert.equal(parseCommand('ls -la').opaque, false);
});

await test('规则校验：拒绝"匹配所有命令"的规则', () => {
  assert.ok(validateRule('*'));
  assert.ok(validateRule('**'));
  assert.ok(validateRule(':rm'));
  assert.ok(validateRule('x'.repeat(600)));
  assert.equal(validateRule('rm -rf *'), null);
  assert.equal(validateRule('aws:*s3 rm*'), null);
});

await test('规则匹配：整条 / 可执行体 / 前缀 / 冒号写法', () => {
  assert.equal(matchRule('rm -rf *', exec('rm -rf build')), true);
  assert.equal(matchRule('rm', exec('rm -rf /')), true, '只写可执行体也算命中');
  assert.equal(matchRule('rm -rf', exec('rm -rf /')), true, '前缀命中');
  assert.equal(matchRule('rm -rf', exec('rm -rfx /')), false, '不能误伤同前缀');
  assert.equal(matchRule('git:*push*', exec('git push origin main')), true);
  assert.equal(matchRule('git:*push*', exec('git status')), false);
});

await test('normalizeRules：丢弃非法规则并去重', () => {
  assert.deepEqual(normalizeRules(['rm -rf *', '*', 'rm -rf *', '  ', 'git:*push*']), [
    'rm -rf *',
    'git:*push*',
  ]);
});

await test('★ deny：归一化后的变体一律命中', () => {
  const deny = ['rm -rf *'];
  for (const cmd of ['rm -rf /', `r''m -rf /`, '\\rm -rf /', '"rm" -rf /', `$'\\x72m' -rf /`]) {
    const v = decideCommand(cmd, { denyCommands: deny });
    assert.equal(v.allowed, false, `应拦下：${cmd}`);
    assert.equal(v.deniedBy, 'deny-rule');
  }
});

await test('★ deny：多段命令里任一段命中就拒绝', () => {
  const v = decideCommand('ls && rm -rf build', { denyCommands: ['rm -rf *'] });
  assert.equal(v.allowed, false);
});

await test('deny：不相关的命令放行', () => {
  assert.equal(decideCommand('git status', { denyCommands: ['rm -rf *'] }).allowed, true);
});

await test('★ 判不了就拒绝：命令无法静态判定且配了 deny → 拒绝', () => {
  const v = decideCommand('echo $(cat secret)', { denyCommands: ['rm -rf *'] });
  assert.equal(v.allowed, false);
  assert.equal(v.deniedBy, 'unparseable');
  assert.match(v.message, /不能在这里批准/);
});

await test('没配规则时不拦（默认行为不变）', () => {
  assert.equal(decideCommand('echo $(cat secret)').allowed, true);
});

await test('★ allowlist：清单外的命令被拒', () => {
  const allowCommands = ['git status', 'git diff *'];
  assert.equal(decideCommand('git status', { allowCommands }).allowed, true);
  assert.equal(decideCommand('git diff HEAD', { allowCommands }).allowed, true);
  const v = decideCommand('git push', { allowCommands });
  assert.equal(v.allowed, false);
  assert.equal(v.deniedBy, 'not-allowlisted');
});

await test('allowlist：多段命令必须每一段都在清单内', () => {
  const allowCommands = ['git status'];
  assert.equal(decideCommand('git status && rm -rf /', { allowCommands }).allowed, false);
});

await test('deny 优先于 allow', () => {
  const v = decideCommand('git status', {
    denyCommands: ['git *'],
    allowCommands: ['git status'],
  });
  assert.equal(v.allowed, false);
  assert.equal(v.deniedBy, 'deny-rule');
});

await test('空命令直接拒绝', () => {
  assert.equal(decideCommand('   ').deniedBy, 'empty');
});

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 命令策略测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
