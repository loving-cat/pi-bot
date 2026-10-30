/** 回收本次探测拥有的进程；Windows 进程树终止在工作线程内执行。 */
import { Worker } from 'node:worker_threads';
import { childEnvDirect } from './child-env.js';

const WINDOWS_CLEANUP = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const path = require('node:path');
const command = process.env.SystemRoot || process.env.windir;
const executable = command ? path.join(command, 'System32', 'taskkill.exe') : 'taskkill.exe';
let task;
let timer;
let finished = false;
function done() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  parentPort.postMessage('done');
}
try {
  task = spawn(executable, ['/PID', String(workerData.pid), '/T', '/F'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
  task.once('error', done);
  task.once('exit', done);
  timer = setTimeout(() => { try { task.kill(); } catch {} done(); }, workerData.timeoutMs);
} catch { done(); }
`;

/** 工作线程仅接收本次创建的 PID，不接收服务名、任意命令或凭据。 */
function killWindowsTree(pid, timeoutMs) {
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    const timer = setTimeout(done, timeoutMs + 150);
    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) {
        worker.unref();
        void worker.terminate().catch(() => {});
      }
      resolve();
    }
    try {
      worker = new Worker(WINDOWS_CLEANUP, {
        eval: true,
        env: childEnvDirect(),
        workerData: { pid, timeoutMs },
      });
      worker.once('message', done);
      worker.once('error', done);
      worker.once('exit', done);
    } catch { done(); }
  });
}

function waitForExit(child, delayMs, onTimeout) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
    const timer = setTimeout(() => { onTimeout(); done(); }, delayMs);
    child.once('exit', done);
  });
}

async function boundTreeCleanup(runTreeKill, pid, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => runTreeKill(pid, timeoutMs)),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs + 150); }),
    ]);
  } catch { /* 进程树回收失败后仍回收直接子进程。 */ }
  finally { clearTimeout(timer); }
}

function processGroupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function waitForGroup(pid, groupAlive, graceMs) {
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, remaining)));
  }
  return false;
}

/** platform 和 runTreeKill 供隔离测试替换，真实调用只传本次 spawn 返回的子进程。 */
export async function stopMcpProbeProcess(child, {
  platform = process.platform,
  runTreeKill = killWindowsTree,
  timeoutMs = 750,
  killGroup = (pid, signal) => process.kill(-pid, signal),
  groupAlive = processGroupAlive,
  graceMs = 250,
} = {}) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  const directKill = (signal) => { try { child.kill(signal); } catch { /* 进程已退出。 */ } };
  if (platform === 'win32' && child.exitCode == null && child.signalCode == null) {
    await boundTreeCleanup(runTreeKill, pid, timeoutMs);
  }
  try { child.stdin?.end(); } catch { /* 输入管道已关闭。 */ }
  const terminate = (signal) => {
    if (platform === 'win32') directKill(signal);
    else {
      try { killGroup(pid, signal); } catch { directKill(signal); }
    }
  };
  terminate('SIGTERM');
  if (platform === 'win32') {
    await waitForExit(child, 250, () => terminate('SIGKILL'));
  } else {
    if (await waitForGroup(pid, groupAlive, graceMs)) terminate('SIGKILL');
    await waitForExit(child, 100, () => directKill('SIGKILL'));
  }
}
