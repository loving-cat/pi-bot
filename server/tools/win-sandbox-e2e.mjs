/**
 * Windows 沙箱真机冒烟（spec §11 的 1–12 项在这里跑一半）。
 *   node tools/win-sandbox-e2e.mjs
 *
 * 只用于手工验收：需要 Windows + 编译好的 pibot-sandbox.exe
 * （scripts/build-sandbox-win.ps1）。CI 不跑它（Windows runner 上没有
 * 那台机器上的 Git / Node 布局，且要装 Rust）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createSandboxedOperations } from '../src/sandboxed-shell.js';
import { probeSandbox } from '../src/sandbox.js';

if (process.platform !== 'win32') {
  console.log('跳过：只在 Windows 上有意义');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-sbx-e2e-'));
const workDir = path.join(root, 'work');
const instanceDir = path.join(root, 'instances', 'a');
const otherInstance = path.join(root, 'instances', 'b');
for (const d of [workDir, instanceDir, otherInstance]) fs.mkdirSync(d, { recursive: true });
// 造一个仿真 dataDir：token + 别的实例目录
const tokenFile = path.join(root, 'local-token');
fs.writeFileSync(tokenFile, 'FAKE-TOKEN-12345');
fs.writeFileSync(path.join(otherInstance, 'marker.txt'), 'b');

const probe = probeSandbox({ instanceDir });
console.log('probe =', JSON.stringify(probe));
if (!probe.available) {
  console.log('沙箱不可用（' + probe.reason + '），跳过真机用例');
  process.exit(0);
}

const ops = createSandboxedOperations({ workDir, instanceDir, dataDir: root });

async function run(command) {
  let out = '';
  const res = await ops.exec(command, workDir, { onData: (d) => { out += d.toString(); } });
  return { code: res.exitCode, out };
}

const script = [
  '$o = @()',
  '$o += "pwd=" + (Get-Location).Path',
  '$o += "ident=" + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
  `try { $o += "token=" + (Get-Content -LiteralPath '${tokenFile}' -Raw -ErrorAction Stop).Trim() } catch { $o += "token=DENY" }`,
  `try { $o += "other=" + ((Get-ChildItem -LiteralPath '${otherInstance}' -Force -ErrorAction Stop | Measure-Object).Count) } catch { $o += "other=DENY" }`,
  'try { Set-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name p -Value x -ErrorAction Stop; $o += "reg=WROTE" } catch { $o += "reg=DENY" }',
  'try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", 8787); $o += "net=CONNECTED" } catch { $o += "net=DENY" }',
  'try { Set-Content -LiteralPath "ok.txt" -Value 1 -ErrorAction Stop; $o += "write=OK" } catch { $o += "write=DENY" }',
  'Write-Output ($o -join " | ")',
].join('\n');

const res = await run(script);
console.log('exit =', res.code);
console.log(res.out.split('\n').filter((l) => /pwd=|ident=|token=|other=|reg=|net=|write=/.test(l)).join('\n'));

const pass = [
  /ident=/.test(res.out),
  /token=DENY/.test(res.out),
  /other=DENY/.test(res.out),
  /reg=DENY/.test(res.out),
  /net=DENY/.test(res.out),
  /write=OK/.test(res.out),
];

// ────────────────── worktree 隔离（多 bot 改同一仓库） ──────────────────
//
// 这是"bot 之间不互相覆写文件"的推荐方案：Node 侧（沙箱外，git 正常）
// 给每个 bot 建一个 worktree，bot 只在沙箱里改自己的那份。
// git 在沙箱里坏掉不影响这条路 —— bot 根本不需要 git。
const repo = path.join(root, 'repo');
const wtA = path.join(root, 'bot-a');
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
fs.mkdirSync(repo, { recursive: true });
git(['init', '-q', '.'], repo);
fs.writeFileSync(path.join(repo, 'app.js'), 'const PORT = 8787;\n');
fs.writeFileSync(path.join(repo, 'config.js'), 'export const HOST = "0.0.0.0";\n');
git(['add', '-A'], repo);
git(['-c', 'user.email=a@b', '-c', 'user.name=host', 'commit', '-qm', 'init'], repo);

const wtB = path.join(root, 'bot-b');
const addA = git(['worktree', 'add', '-q', wtA, '-b', 'bot/a'], repo);
const addB = git(['worktree', 'add', '-q', wtB, '-b', 'bot/b'], repo);
if (addA.status === 0 && addB.status === 0) {
  const opsA = createSandboxedOperations({ workDir: wtA, instanceDir: path.join(root, 'i-a'), dataDir: root });
  const opsB = createSandboxedOperations({ workDir: wtB, instanceDir: path.join(root, 'i-b'), dataDir: root });
  const writeA = await opsA.exec("Set-Content -LiteralPath 'app.js' -Value 'const PORT = 9000;'", wtA, { onData: () => {} });
  const writeB = await opsB.exec("Set-Content -LiteralPath 'config.js' -Value 'export const HOST = \"127.0.0.1\";'", wtB, { onData: () => {} });

  const aApp = fs.readFileSync(path.join(wtA, 'app.js'), 'utf8').trim();
  const aCfg = fs.readFileSync(path.join(wtA, 'config.js'), 'utf8').trim();
  const bApp = fs.readFileSync(path.join(wtB, 'app.js'), 'utf8').trim();
  const bCfg = fs.readFileSync(path.join(wtB, 'config.js'), 'utf8').trim();

  const isolated = writeA.exitCode === 0 && writeB.exitCode === 0
    && aApp.includes('9000') && bApp.includes('8787')   // A 的改动不泄漏给 B
    && bCfg.includes('127.0.0.1') && aCfg.includes('0.0.0.0'); // B 的改动不泄漏给 A

  console.log('--- worktree 隔离 ---');
  console.log('A app.js   =', aApp, '| A config.js =', aCfg);
  console.log('B app.js   =', bApp, '| B config.js =', bCfg);
  console.log(isolated ? 'worktree 隔离 PASS' : 'worktree 隔离 FAIL');

  for (const wt of [wtA, wtB]) git(['worktree', 'remove', '--force', wt], repo);
  if (!isolated) process.exitCode = 1;
} else {
  console.log('worktree 用例跳过（机器上没有 git）');
}

console.log(pass.every(Boolean) ? 'PASS' : 'FAIL（见上面的行）');
fs.rmSync(root, { recursive: true, force: true });
process.exit(pass.every(Boolean) ? 0 : 1);
