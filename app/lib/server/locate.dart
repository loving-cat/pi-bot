/// 路径与运行时查找：服务端入口、node、npm、端口探活。
///
/// 全部无状态，只依赖传入目录，便于单独测试各种安装形态。
library;

import 'dart:io';

/// 从 `exeDir` 起向父目录查找 `server/src/index.js` 的所有候选路径。
///
/// 顺序：`PI_BOT_SERVER` → exe 同级 → exe 上级 → 逐层向上（最多 8 层）→ 当前目录。
/// 开发时 exe 位于 `app/build/windows/x64/runner/Release/`；
/// 发行包则把 `server/` 与 exe 放在同一目录。
List<String> serverEntryCandidates(String exeDir) {
  final sep = Platform.pathSeparator;
  String at(String base, List<String> parts) => [base, ...parts].join(sep);
  const entry = ['server', 'src', 'index.js'];
  final out = <String>[];

  final env = Platform.environment['PI_BOT_SERVER']?.trim();
  if (env != null && env.isNotEmpty) out.add(env);

  out.add(at(exeDir, entry));
  out.add(at(at(exeDir, const ['..']), entry));

  var dir = Directory(exeDir);
  for (var i = 0; i < 8; i++) {
    out.add(at(dir.path, entry));
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  out.add(at(Directory.current.path, entry));
  return out;
}

String? findServerEntry(String exeDir) {
  for (final path in serverEntryCandidates(exeDir)) {
    if (File(path).existsSync()) return File(path).absolute.path;
  }
  return null;
}

/// 定位 node：`PI_BOT_NODE` → exe 同级目录 → Program Files → PATH。
Future<String?> findNode(String exeDir) async {
  final sep = Platform.pathSeparator;
  final explicit = Platform.environment['PI_BOT_NODE']?.trim();
  if (explicit != null && explicit.isNotEmpty && File(explicit).existsSync()) {
    return explicit;
  }

  for (final name in ['node.exe', 'node']) {
    final beside = File('$exeDir$sep$name');
    if (beside.existsSync()) return beside.path;
    final inDir = File('$exeDir${sep}node$sep$name');
    if (inDir.existsSync()) return inDir.path;
  }

  if (Platform.isWindows) {
    final programFiles = Platform.environment['ProgramFiles'] ?? r'C:\Program Files';
    final guess = '$programFiles\\nodejs\\node.exe';
    if (File(guess).existsSync()) return guess;
  }

  try {
    final probe = Platform.isWindows
        ? await Process.run('where', ['node'])
        : await Process.run('which', ['node']);
    if (probe.exitCode == 0) {
      for (final line in '${probe.stdout}'.split(RegExp(r'\r?\n'))) {
        final path = line.trim();
        if (path.isEmpty) continue;
        if (File(path).existsSync()) return path;
      }
    }
  } catch (_) {}
  return null;
}

/// npm 的调用参数（空列表 = 未找到）。
///
/// 支持的安装形态：
///   · 标准安装：`<node 目录>/npm.cmd`；
///   · 仅含 node.exe 的发行包：以 `node npm-cli.js` 方式调用；
///   · node 不在标准位置时：使用 PATH 上的 npm。
List<String> npmCommand(String nodePath) {
  final sep = Platform.pathSeparator;
  final dir = File(nodePath).parent.path;

  for (final name in ['npm.cmd', 'npm']) {
    final p = '$dir$sep$name';
    if (File(p).existsSync()) return [p];
  }

  final cli = [
    [dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep),
    [dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep),
  ].firstWhere((p) => File(p).existsSync(), orElse: () => '');
  if (cli.isNotEmpty) return [nodePath, File(cli).absolute.path];

  // PATH 上的 npm（node 不是标准安装时常见）
  if (Platform.isWindows) {
    final pathSep = Platform.environment['PATH'] ?? '';
    for (final dirEntry in pathSep.split(';')) {
      if (dirEntry.trim().isEmpty) continue;
      final p = '${dirEntry.trim()}$sep' 'npm.cmd';
      if (File(p).existsSync()) return [p];
    }
  }
  return const [];
}

/// 读取 node 版本号（去掉前缀 v）；无法执行时返回 null。
Future<String?> nodeVersion(String nodePath) async {
  try {
    final r = await Process.run(nodePath, ['-v']);
    if (r.exitCode != 0) return null;
    return '${r.stdout}'.trim().replaceAll(RegExp(r'^v'), '');
  } catch (_) {
    return null;
  }
}

bool versionAtLeast(String version, int major) {
  final parts = version.split('.');
  final first = int.tryParse(parts.isNotEmpty ? parts.first : '') ?? 0;
  return first >= major;
}

/// 检查端口是否可建立 TCP 连接（用于区分"服务未启动"与"端口被占用"）。
Future<bool> portOpen(
  String host,
  int port, {
  Duration timeout = const Duration(milliseconds: 600),
}) async {
  try {
    final socket = await Socket.connect(host, port, timeout: timeout);
    socket.destroy();
    return true;
  } catch (_) {
    return false;
  }
}
