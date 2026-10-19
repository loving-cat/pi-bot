/// POSIX 服务端启动脚本：独立进程组运行，日志直连文件后释放辅助进程。
const String posixServerSpawnScript = r'''
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [node, entry, cwd, logPath, pidFile, extraJson] = process.argv.slice(2);
const extra = JSON.parse(extraJson || '{}');
const fd = fs.openSync(logPath, 'a');
const header = `\n---- ${new Date().toISOString()} 启动: ${entry} (node ${process.version}) ----\n`;
fs.writeSync(fd, header);
const child = spawn(node, [entry], {
  cwd,
  stdio: ['ignore', fd, fd],
  detached: true,
  env: { ...process.env, ...extra },
});
if (pidFile) {
  try { fs.writeFileSync(pidFile, String(child.pid)); } catch {}
}
child.unref();
fs.closeSync(fd);
console.log(`server pid=${child.pid}`);
''';
