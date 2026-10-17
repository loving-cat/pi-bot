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
///
/// 启动链上**必须保住那个隐藏控制台**：服务端派生的每个子进程（rg / fd / git /
/// node）默认继承父进程的控制台；父进程没有控制台时，Windows 会给每个子进程
/// 新建一个控制台窗口，于是工具一跑屏幕上就闪黑框。
/// 实测：给服务端加 `windowsHide` 或 `detached` 都会把控制台剥掉（
/// `GetConsoleWindow() == 0`），随后每次派生都会新建窗口。
class ServerSupervisor {
  ServerSupervisor(this.stateDir);

  /// 放 pid / 日志 / 辅助脚本的目录（`%LOCALAPPDATA%\pi-bot`）
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
    _script.writeAsStringSync(_scriptSource, flush: true);
    final extraJson = extraEnv.isEmpty ? '{}' : jsonEncode(extraEnv);

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
      return Process.start('wscript.exe', [vbs.path]);
    }

    return Process.start(nodePath, [
      _script.path,
      nodePath,
      entryPath,
      serverDir,
      logPath,
      pidFile.path,
      extraJson,
    ], workingDirectory: serverDir);
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

const [node, entry, cwd, logPath, pidFile, extraJson] = process.argv.slice(2);
const extra = JSON.parse(extraJson || '{}');
const fd = fs.openSync(logPath, 'a');
const header = `\n---- ${new Date().toISOString()} 启动: ${entry} (node ${process.version}) ----\n`;
fs.writeSync(fd, header);
// 这里两个选项都不能加，否则工具一跑就闪黑框：
// - 本脚本由 WScript.Shell.Run(...,0) 以隐藏窗口启动，自带一个**隐藏控制台**；
//   服务端继承它，之后每个工具子进程（rg / fd / git / node）也继承它，
//   系统就不会再为它们新建控制台窗口。
// - windowsHide 会把子进程的控制台剥掉（GetConsoleWindow()==0）；
// - detached 会给子进程 DETACHED_PROCESS，同样没有控制台。
// 两者都会让服务端的派生链从"共享隐藏控制台"变成"每个子进程新建窗口"。
const child = spawn(node, [entry], {
  cwd,
  stdio: ['ignore', fd, fd],
  env: { ...process.env, ...extra },
});
if (pidFile) {
  try { fs.writeFileSync(pidFile, String(child.pid)); } catch {}
}
child.unref();
fs.closeSync(fd);
console.log(`server pid=${child.pid}`);
''';
