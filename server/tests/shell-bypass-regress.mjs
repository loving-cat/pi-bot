/**
 * 命令策略绕过回归。每条用例都对应修之前 decideCommand / write_stdin 会放行的写法。
 *   node tests/shell-bypass-regress.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { decideCommand } from '../src/shell-policy.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-shell-bypass-'));
process.env.PI_BOT_HOME = path.join(root, 'data');
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');
process.env.PI_BOT_MODEL = '';
process.env.PI_BOT_WATCH_CHANGES = '0';
process.env.PI_BOT_AUTO_ATTACH_IMAGES = '0';

const { resetStdin } = await import('../src/shell-policy.js');
const { store } = await import('../src/store.js');
const { createPolicyExtension } = await import('../src/policy-hook.js');
const { buildCommonTools } = await import('../src/tools.js');
const { shells } = await import('../src/shells.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.stack || err?.message || String(err) });
  }
}

const deny = { denyCommands: ['rm -rf *'] };
const rmEnc = Buffer.from('rm -rf /', 'utf16le').toString('base64');

function blocked(cmd, rules = deny) {
  const verdict = decideCommand(cmd, rules);
  assert.equal(verdict.allowed, false, `${JSON.stringify(cmd)} 应拒绝，实际 ${verdict.deniedBy}`);
  return verdict;
}

function passed(cmd, rules = deny) {
  const verdict = decideCommand(cmd, rules);
  assert.equal(verdict.allowed, true, `${JSON.stringify(cmd)} 应放行：${verdict.reason}`);
  return verdict;
}

await test('换行分隔：echo 后面的 rm 不能被压成参数', () => {
  blocked('echo ok\nrm -rf /');
});

await test('CRLF 分隔同样切开', () => {
  blocked('echo ok\r\nrm -rf /');
});

await test('反斜杠续行不是第二条命令', () => {
  passed('echo A\\\nrm -rf /');
});

await test('双引号里的 $(...) 仍会执行', () => {
  const verdict = blocked('echo "$(rm -rf /)"');
  assert.equal(verdict.deniedBy, 'unparseable');
});

await test('双引号里的反引号仍会执行', () => {
  assert.equal(blocked('echo "`rm -rf /`"').deniedBy, 'unparseable');
});

await test('单引号里的 $(...) 是字面量，不误伤', () => {
  passed("echo '$(rm -rf /)'");
});

await test('双引号里的普通文本不是命令', () => {
  passed('echo "rm -rf /"');
});

await test('参数里的变量展开不误伤', () => {
  passed('echo $HOME');
});

await test('未加引号的 $()：只配白名单时也不能放行', () => {
  const verdict = blocked('echo $(rm -rf /)', { allowCommands: ['echo', 'echo *'] });
  assert.equal(verdict.deniedBy, 'unparseable');
});

await test('没配规则时命令替换仍放行', () => {
  assert.equal(decideCommand('echo $(rm -rf /)').allowed, true);
});

await test('子 shell (rm) 不能把可执行体粘在括号上', () => {
  blocked('(rm -rf /)');
  blocked('( rm -rf / )');
});

await test('花括号分组里的命令要看到', () => {
  blocked('{ rm -rf /; }');
});

await test('函数体里的命令要看到', () => {
  blocked('f() { rm -rf /; }; f');
  blocked('function f { rm -rf /; }; f');
  blocked('f(){rm -rf /;}; f');
});

await test('绝对路径和相对路径按文件名匹配', () => {
  blocked('/bin/rm -rf /');
  blocked('/usr/bin/rm -rf /');
  blocked('./rm -rf /');
});

await test('赋值前缀后面才是真正的命令', () => {
  blocked('FOO=1 rm -rf /');
  passed('FOO=1');
});

await test('重定向前缀后面才是真正的命令', () => {
  blocked('</dev/null rm -rf /');
  blocked('2>/tmp/x rm -rf /');
  blocked('2> /tmp/x rm -rf /');
});

await test('! 前缀不能挡住后面的命令', () => {
  blocked('! rm -rf /');
});

await test('env 包装', () => {
  blocked('env rm -rf /');
  blocked('env -i rm -rf /');
  blocked('/usr/bin/env rm -rf /');
});

await test('xargs 会把标准输入拼进参数', () => {
  assert.equal(blocked('echo / | xargs rm -rf').deniedBy, 'unparseable');
  assert.equal(blocked('xargs -n1 rm -rf').deniedBy, 'unparseable');
  blocked('xargs rm -rf /');
});

await test('sh -c / bash -lc 里的脚本要再解析', () => {
  blocked("sh -c 'rm -rf /'");
  blocked('bash -lc "echo ok && rm -rf /"');
});

await test('管道把脚本喂给 shell，静态看不全', () => {
  assert.equal(blocked("echo 'rm -rf /' | sh").deniedBy, 'unparseable');
  assert.equal(blocked("printf 'rm -rf /' | bash").deniedBy, 'unparseable');
});

await test('eval / command / exec 包装', () => {
  blocked("eval 'rm -rf /'");
  blocked('command -p rm -rf /');
  blocked('builtin rm -rf /');
  blocked('exec rm -rf /');
});

await test('nice / nohup / time / timeout 包装', () => {
  blocked('nice -n 10 rm -rf /');
  blocked('nohup rm -rf /');
  blocked('time rm -rf /');
  blocked('timeout 1 rm -rf /');
});

await test('sudo 包装', () => {
  blocked('sudo rm -rf /');
  blocked('sudo -u root rm -rf /');
});

await test('find -exec 里的命令要看到', () => {
  blocked('find . -exec rm -rf {} +');
  passed('find . -name x');
});

await test('cmd /c 与大小写', () => {
  blocked('cmd /c "rm -rf /"');
  blocked('CMD /C rm -rf /');
  blocked('C:\\Windows\\System32\\cmd.exe /c rm -rf /');
});

await test('powershell -Command / -EncodedCommand', () => {
  blocked(`powershell -Command "rm -rf /"`);
  blocked(`PowerShell -Enc ${rmEnc}`);
  blocked('pwsh -c "rm -rf /"');
});

await test('大小写和 .exe：同一条规则能命中', () => {
  blocked('RM -rf /');
  blocked('rm.EXE -rf /');
  blocked('Remove-Item -Recurse x', { denyCommands: ['remove-item'] });
});

await test('变量当命令名，或用空展开拼出命令名', () => {
  assert.equal(blocked('x=rm; $x -rf /').deniedBy, 'unparseable');
  assert.equal(blocked('unset z; ${z}rm -rf /').deniedBy, 'unparseable');
});

await test('解释器 -c/-e 和脚本文件无法按 shell 规则看完', () => {
  assert.equal(blocked(`python3 -c "import os; os.system('rm -rf /')"`).deniedBy, 'unparseable');
  assert.equal(blocked(`node -e "require('child_process').execSync('rm -rf /')"`).deniedBy, 'unparseable');
  assert.equal(blocked('python3 evil.py').deniedBy, 'unparseable');
  passed('node --version');
});

await test('source 和 . 读入的脚本看不到', () => {
  assert.equal(blocked('source /tmp/x.sh').deniedBy, 'unparseable');
  assert.equal(blocked('. /tmp/x.sh').deniedBy, 'unparseable');
});

await test('白名单不会因为换行被第一条命令带过', () => {
  const verdict = blocked('echo ok\nrm -rf /', { allowCommands: ['echo', 'echo *'] });
  assert.equal(verdict.deniedBy, 'not-allowlisted');
});

await test('不相关的命令仍然放行', () => {
  passed('git status');
  passed('( git status )', { allowCommands: ['git status'] });
});

/** 没配 deny/allow 时必须与改动前一样放行，不能因为包装形式被拦。 */
const UNRULED_COMMANDS = [
  'npm test',
  'npm install',
  'npm ci',
  'npm run build',
  'git status',
  'git diff',
  'git log -5',
  'git add .',
  'git commit -m "save"',
  'node -v',
  'node --version',
  'node server.js',
  'node -e "console.log(1)"',
  "sh -c 'git status'",
  'bash -c "git status"',
];

await test('未配置任何命令规则时，npm/git/node 与 sh -c 均放行', () => {
  for (const cmd of UNRULED_COMMANDS) {
    const plain = decideCommand(cmd);
    assert.equal(plain.allowed, true, `${cmd} → ${plain.deniedBy || plain.reason}`);
    const empty = decideCommand(cmd, { denyCommands: [], allowCommands: [] });
    assert.equal(empty.allowed, true, cmd);
  }
});

function install(roomId = 'r_bypass') {
  let handler = null;
  createPolicyExtension({ roomId, bot: { id: 'b1', name: '测试员' } }).factory({
    on(event, fn) {
      if (event === 'tool_call') handler = fn;
    },
  });
  return handler;
}

const tool = buildCommonTools({
  runner: {},
  roomId: 'r_bypass',
  botId: 'b1',
  isMain: false,
}).find((item) => item.name === 'write_stdin');

const writes = [];
shells.write = (_id, chars) => {
  writes.push(String(chars));
  return { ok: true };
};

await test('未配置命令规则时，bash 入口不拦 npm/git/node 和 sh -c', () => {
  store.updatePolicy({ dangerous: 'allow', denyCommands: [], allowCommands: [] });
  const handler = install();
  for (const cmd of UNRULED_COMMANDS) {
    assert.equal(handler({ toolName: 'bash', input: { command: cmd } }), undefined, cmd);
    assert.equal(handler({ toolName: 'run_background', input: { command: cmd } }), undefined, `bg ${cmd}`);
  }
});

await test('write_stdin：整段被禁命令在入口被拒绝', () => {
  resetStdin();
  writes.length = 0;
  store.updatePolicy({ dangerous: 'allow', denyCommands: ['rm -rf *'], allowCommands: [] });
  const verdict = install()({
    toolName: 'write_stdin',
    input: { shell_id: 'sh_full', chars: 'rm -rf /\n' },
  });
  assert.equal(verdict?.block, true);
  assert.match(verdict.reason, /部门规矩/);
  const denials = store.listDenials({ limit: 5 });
  assert.equal(denials[0].command, 'rm -rf /\n');
});

await test('write_stdin：拆开写入，后半段补成被禁命令时拒绝且不写', async () => {
  resetStdin('sh_chunk');
  writes.length = 0;
  store.updatePolicy({ dangerous: 'allow', denyCommands: ['rm -rf *'], allowCommands: [] });
  const first = await tool.execute('c1', { shell_id: 'sh_chunk', chars: 'r' });
  assert.equal(first.isError, undefined);
  assert.deepEqual(writes, ['r']);
  const second = await tool.execute('c2', { shell_id: 'sh_chunk', chars: 'm -rf /\n' });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /部门规矩/);
  assert.deepEqual(writes, ['r']);
});

await test('write_stdin：确认用的换行不受黑名单影响', async () => {
  resetStdin('sh_yes');
  writes.length = 0;
  store.updatePolicy({ dangerous: 'allow', denyCommands: ['rm -rf *'], allowCommands: [] });
  const result = await tool.execute('c3', { shell_id: 'sh_yes', chars: 'y\n' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(writes, ['y\n']);
});

await test('批准窗口不能绕过命令黑名单', () => {
  store.updatePolicy({ dangerous: 'ask', denyCommands: ['rm -rf *'], allowCommands: [] });
  store.grantApproval({ roomId: 'r_bypass', botId: 'b1' });
  const denied = install()({ toolName: 'bash', input: { command: 'rm -rf /' } });
  assert.equal(denied?.block, true);
  assert.match(denied.reason, /部门规矩/);
  const allowed = install()({ toolName: 'bash', input: { command: 'echo ok' } });
  assert.equal(allowed, undefined);
});

await test('只读模式仍先于命令策略拒绝 write_stdin', async () => {
  writes.length = 0;
  store.updatePolicy({ dangerous: 'deny', denyCommands: ['rm -rf *'], allowCommands: [] });
  const verdict = install()({
    toolName: 'write_stdin',
    input: { shell_id: 'sh_ro', chars: 'rm -rf /\n' },
  });
  assert.equal(verdict?.block, true);
  assert.match(verdict.reason, /只读/);
  const result = await tool.execute('c4', { shell_id: 'sh_ro', chars: 'rm -rf /\n' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /只读/);
  assert.equal(writes.length, 0);
});

const passedN = results.filter((item) => item.ok).length;
console.log('\n================ 命令绕过回归 ================');
for (const item of results) {
  console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.ok ? '' : `\n     ${item.err}`}`);
}
console.log(`\n${passedN}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(passedN === results.length ? 0 : 1);
