import 'dart:convert';
import 'dart:io';

/// 启动本机服务端，并让它独立于 App 运行。
///
/// 实现方式：由一个短命的 node 辅助脚本 spawn 真正的服务端，
/// 并把它的 stdio 直接接到日志文件的 fd 上。
///
/// 不使用 Dart 管道传 stdout/stderr：管道随父进程退出而断开，
/// 子进程再写日志会收到 EPIPE 而退出。
/// `ProcessStartMode.detached` 在 Windows 上没有 stdio 句柄，node 无法启动；
/// 通过 `cmd /c` 重定向则会与 Dart 的引号转义规则冲突。
class ServerSupervisor {
  ServerSupervisor(this.stateDir);

  /// 放 pid / 日志 / 辅助脚本的目录（`%LOCALAPPDATA%\pi-bot`）
  final Directory stateDir;

  File get _script => File('${stateDir.path}${Platform.pathSeparator}spawn-server.mjs');
  File get pidFile => File('${stateDir.path}${Platform.pathSeparator}server.pid');

  /// 服务端进程的 pid（不是辅助脚本的 pid，后者会立即退出）
  int? readPid() {
    try {
      if (!pidFile.existsSync()) return null;
      final pid = int.tryParse(pidFile.readAsStringSync().trim());
      return (pid != null && pid > 0) ? pid : null;
    } catch (_) {
      return null;
    }
  }

  Future<Process> spawn({
    required String nodePath,
    required String entryPath,
    required String serverDir,
    required String logPath,
    required Map<String, String> extraEnv,
  }) async {
    _script.writeAsStringSync(_scriptSource, flush: true);
    return Process.start(
      nodePath,
      [_script.path, nodePath, entryPath, serverDir, logPath, pidFile.path],
      workingDirectory: serverDir,
      // 用户配置的 PI_BOT_HOME / PI_BOT_PORT 由辅助脚本转发给服务端
      environment: {
        if (extraEnv.isNotEmpty) 'PI_BOT_SPAWN_ENV': jsonEncode(extraEnv),
      },
    );
  }

  /// 停止服务端（修改配置或重启时使用）
  Future<void> stop() async {
    final pid = readPid();
    if (pid == null) return;
    try {
      if (Platform.isWindows) {
        await Process.run('taskkill', ['/PID', '$pid', '/F']);
      } else {
        Process.killPid(pid, ProcessSignal.sigterm);
      }
    } catch (_) {}
    try {
      pidFile.deleteSync();
    } catch (_) {}
  }
}

/// 短命辅助脚本：以日志文件作为 stdio 启动服务端后立即退出。
const String _scriptSource = r'''
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [node, entry, cwd, logPath, pidFile] = process.argv.slice(2);
const extra = JSON.parse(process.env.PI_BOT_SPAWN_ENV || '{}');
const fd = fs.openSync(logPath, 'a');
const header = `\n---- ${new Date().toISOString()} 启动: ${entry} (node ${process.version}) ----\n`;
fs.writeSync(fd, header);
const child = spawn(node, [entry], {
  cwd,
  stdio: ['ignore', fd, fd],
  detached: true,
  windowsHide: true,
  env: { ...process.env, ...extra },
});
if (pidFile) {
  try { fs.writeFileSync(pidFile, String(child.pid)); } catch {}
}
child.unref();
fs.closeSync(fd);
console.log(`server pid=${child.pid}`);
''';
