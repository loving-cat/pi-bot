/**
 * 启动链控制台继承测试。
 *
 * 判据（Windows 实测）：
 * - 父进程持有隐藏控制台时，子进程继承它 -> 不新建控制台窗口 -> 不闪黑框；
 * - 父进程没有控制台时，系统的默认行为是给每个控制台子进程新建一个窗口。
 *   而 `windowsHide: true` 与 `detached: true` 都会把子进程的控制台剥掉
 *   （GetConsoleWindow() == 0），于是每次工具调用都会闪一下黑框。
 *
 * 桌面端用 WScript.Shell.Run(..., 0) 以隐藏窗口启动辅助脚本，所以辅助脚本自带
 * 隐藏控制台；它拉起服务端、服务端再拉起工具子进程时，这个链条不能被这两个选项打断。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const supervisorPath = join(here, '..', '..', 'app', 'lib', 'server', 'supervisor.dart');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    fail++;
  }
}

let source = '';
try {
  source = readFileSync(supervisorPath, 'utf8');
} catch {
  console.log('  跳过：找不到 app/lib/server/supervisor.dart');
  process.exit(0);
}

// 启动脚本内嵌在 Dart 的 r'''...''' 字符串里，先切出来
const scriptStart = source.indexOf('const String _scriptSource = r');
const scriptEnd = source.indexOf("'''", scriptStart + 40);
const spawnScript =
  scriptStart >= 0 && scriptEnd > scriptStart ? source.slice(scriptStart, scriptEnd) : '';

/** 取服务端 spawn 调用的选项块（到第一个 `});` 为止） */
function spawnOptionsBlock() {
  const at = spawnScript.indexOf('const child = spawn(');
  assert.ok(at >= 0, '启动脚本里没找到 spawn 调用');
  const rest = spawnScript.slice(at);
  return rest.slice(0, rest.indexOf('});') + 3);
}

check('能定位到启动脚本', () => {
  assert.ok(spawnScript.includes('spawn('), '未找到 spawn 调用');
});

check('启动服务端时不传 detached', () => {
  assert.ok(
    !/detached\s*:/.test(spawnOptionsBlock()),
    'detached 会剥掉继承的控制台，工具子进程会各自新建窗口',
  );
});

check('启动服务端时不传 windowsHide', () => {
  assert.ok(
    !/windowsHide\s*:/.test(spawnOptionsBlock()),
    'windowsHide 会剥掉继承的控制台，工具子进程会各自新建窗口',
  );
});

check('用 WScript.Shell.Run(...,0) 隐藏启动（控制台的来源）', () => {
  assert.ok(/sh\.Run .*,\s*0,\s*False/.test(source), 'Windows 分支应以隐藏窗口启动辅助脚本');
});

check('注释写明两个选项为什么不能加', () => {
  assert.ok(
    /windowsHide/.test(spawnScript) && /detached/.test(spawnScript) && /控制台/.test(spawnScript),
    '启动脚本注释应说明控制台继承与这两个选项的关系',
  );
});

console.log(`\n控制台继承测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
