import 'dart:convert';
import 'dart:io';

import 'spawn_posix.dart';

/// 启动本机服务端，并让它独立于 App 运行。
///
/// 实现方式：由一个短命的 node 辅助脚本 spawn 真正的服务端，
/// 并把它的 stdio 直接接到日志文件的 fd 上。
///
/// 不使用 Dart 管道传 stdout/stderr：管道随父进程退出而断开，
/// 子进程再写日志会收到 EPIPE 而退出。
/// `ProcessStartMode.detached` 在 Windows 上没有 stdio 句柄，node 无法启动；
/// 通过 `cmd /c` 重定向则会与 Dart 的引号转义规则冲突。
///
/// 启动链上**必须保住那个隐藏控制台**：服务端派生的每个子进程（rg / fd / git /
/// node）默认继承父进程的控制台；父进程没有控制台时，Windows 会给每个子进程
/// 新建一个控制台窗口，于是工具一跑屏幕上就闪黑框。
/// 给服务端加 `windowsHide` 或 `detached` 都会把控制台剥掉（
/// `GetConsoleWindow() == 0`），随后每次派生都会新建窗口。
class ServerSupervisor {
  ServerSupervisor(this.stateDir);

  /// 用户状态目录，存放 pid、日志与启动辅助脚本。
  final Directory stateDir;

  File get _script =>
      File('${stateDir.path}${Platform.pathSeparator}spawn-server.mjs');
  File get pidFile =>
      File('${stateDir.path}${Platform.pathSeparator}server.pid');

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
    _script.writeAsStringSync(
      Platform.isWindows ? _scriptSource : posixServerSpawnScript,
      flush: true,
    );
    final extraJson = extraEnv.isEmpty ? '{}' : jsonEncode(extraEnv);
    final runtimeEnvironment = {
      'PATH':
          '${File(nodePath).parent.path}'
          '${Platform.isWindows ? ';' : ':'}${Platform.environment['PATH'] ?? ''}',
    };

    if (Platform.isWindows) {
      // Dart 的 Process.start 不带 CREATE_NO_WINDOW：GUI 程序拉起控制台子进程时，
      // Windows 会给它开一个新控制台窗口。用 WScript.Shell.Run(..., 0) 以**隐藏窗口**启动，
      // 参数与工作目录照传。
      final vbs = File(
        '${stateDir.path}${Platform.pathSeparator}spawn-server.vbs',
      );
      String q(String v) => '"${v.replaceAll('"', '""')}"';
      final cmdline = [
        q(nodePath),
        q(_script.path),
        q(nodePath),
        q(entryPath),
        q(serverDir),
        q(logPath),
        q(pidFile.path),
        q(extraJson),
      ].join(' ');
      vbs.writeAsStringSync(
        'Set sh = CreateObject("WScript.Shell")\r\n'
        'sh.CurrentDirectory = "${serverDir.replaceAll('"', '""')}"\r\n'
        'sh.Run ${q(cmdline)}, 0, False\r\n',
        flush: true,
      );
      return Process.start('wscript.exe', [
        vbs.path,
      ], environment: runtimeEnvironment);
    }

    return Process.start(
      nodePath,
      [
        _script.path,
        nodePath,
        entryPath,
        serverDir,
        logPath,
        pidFile.path,
        extraJson,
      ],
      workingDirectory: serverDir,
      environment: runtimeEnvironment,
    );
  }

  /// Windows 结束服务端及子进程；其它平台等待 SIGTERM 退出，超时保留 pid 并报错。
  Future<void> stop({Duration timeout = const Duration(seconds: 5)}) async {
    final pid = readPid();
    if (pid == null) return;
    if (Platform.isWindows) {
      await Process.run('taskkill', ['/PID', '$pid', '/T', '/F']);
    } else if (await _isRunning(pid)) {
      if (!Process.killPid(pid, ProcessSignal.sigterm) &&
          await _isRunning(pid)) {
        throw StateError('无法向服务端进程 $pid 发送退出信号');
      }
      final deadline = DateTime.now().add(timeout);
      while (await _isRunning(pid)) {
        if (DateTime.now().isAfter(deadline)) {
          throw StateError('服务端进程 $pid 未在 ${timeout.inMilliseconds}ms 内退出');
        }
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    }
    if (readPid() == pid) {
      pidFile.deleteSync();
    }
  }

  /// 仅查询 pid 是否仍存在，不读取进程参数或用户数据。
  Future<bool> _isRunning(int pid) async {
    final result = await Process.run('/bin/ps', ['-p', '$pid', '-o', 'pid=']);
    if (result.exitCode == 1) return false;
    if (result.exitCode != 0) throw StateError('无法查询服务端进程 $pid');
    return '${result.stdout}'.trim() == '$pid';
  }
}

/// 短命辅助脚本：以日志文件作为 stdio 启动服务端后立即退出。
const String _scriptSource = r'''
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [node, entry, cwd, logPath, pidFile, extraJson] = process.argv.slice(2);
const extra = JSON.parse(extraJson || '{}');
const fd = fs.openSync(logPath, 'a');
const header = `\n---- ${new Date().toISOString()} 启动: ${entry} (node ${process.version}) ----\n`;
fs.writeSync(fd, header);
// 这里不能加 windowsHide / detached：
// - 两者都会把继承来的隐藏控制台剥掉（子进程 GetConsoleWindow()==0），
//   服务端之后派生的每个控制台子进程（rg / fd / git / node）都会被系统
//   分配一个新控制台窗口，表现为工具一跑就闪黑框；
// - detached 还会让服务端起不来。
// 本脚本由 WScript.Shell.Run(...,0) 以隐藏窗口启动，自带隐藏控制台，
// 服务端直接继承即可；父进程退出后子进程继续存活，不依赖 detached。
const child = spawn(node, [entry], {
  cwd,
  stdio: ['ignore', fd, fd],
  env: { ...process.env, ...extra },
});
if (pidFile) {
  try { fs.writeFileSync(pidFile, String(child.pid)); } catch {}
}
// 不关 fd、也不 unref：服务端继承了这份日志句柄，helper 退出时若关掉 fd，
// 服务端后续写日志会失败并静默退出。这里让 helper 在打印 pid 后自然结束，
// 句柄由子进程继续持有。
console.log(`server pid=${child.pid}`);
''';
